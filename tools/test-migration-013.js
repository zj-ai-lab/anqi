// migration 013 升级测试：v12 → v13，去个人化 actor 清洗。
//
// 为什么这个测试必须存在（2026-07-31 补）：
// 初版 013 里有一条 `UPDATE fee_share_formula_revisions SET created_by='system'`，
// 而 007 给这张表挂了不可变触发器 trg_share_formula_revision_only_seal_update
// （只放行「未封存→封存」，且逐列要求含 created_by 在内的其它字段全部不变）。
// 任何**带存量数据**的库跑 013 都会被 ABORT，后端在 runMigrations 阶段直接崩。
// 当时没被发现，正是因为 013 是唯一没有配套 fixture 测试的 migration —— check.sh 的
// migration 干跑在**空库**上做，三条 UPDATE 匹配 0 行，触发器自然不响。
//
// 所以本测试的 fixture 必须带存量 'fang' 数据，三张表齐全，且 revisions 必须有**已封存**的行。
//
// 实测下来三张表在 007 里都有写守卫，013 只能洗 assignments 一张：
//   revisions      —— 只放行一次性封存，逐列比对 → 不可洗
//   settlement_runs —— trg_share_run_no_update 无条件禁止 UPDATE → 不可洗
//   assignments     —— 乐观锁契约（version+1、刷 updated_at）→ 满足契约即可洗
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDir = path.join(root, 'src', 'migrations');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-013-'));

const files12 = fs.readdirSync(migrationsDir).filter((n) => /^(00[1-9]|01[0-2])_.*\.sql$/.test(n)).sort();
const files13 = fs.readdirSync(migrationsDir).filter((n) => /^(00[1-9]|01[0-3])_.*\.sql$/.test(n)).sort();

function copy(files, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(migrationsDir, file), path.join(target, file));
}

const dir12 = path.join(scratch, 'v12');
const dir13 = path.join(scratch, 'v13');
copy(files12, dir12);
copy(files13, dir13);

// ── fixture：真实 001–012，再塞进三张表的存量 'fang' 数据 ──────────────────
const db = new Database(path.join(scratch, 'fixture.db'));
db.pragma('foreign_keys = ON');
runMigrations(db, dir12);
assert.equal(db.pragma('user_version', { simple: true }), 12, 'fixture 必须停在真实 012');

const caseId = Number(db.prepare(
  "INSERT INTO cases (name, procedure, stage) VALUES ('示例分成案（张三）','一审','待裁判')"
).run().lastInsertRowid);
const feeId = Number(db.prepare(
  "INSERT INTO fee_items (case_id,label,amount,status,paid_on) VALUES (?,'已收示例款',1000,'paid','2026-07-15')"
).run(caseId).lastInsertRowid);
const agreementId = Number(db.prepare(
  `INSERT INTO fee_share_agreements (case_id,direction,counterpart,rate,created_at)
   VALUES (?,'payable','李四',30,'2026-07-01 09:00:00')`
).run(caseId).lastInsertRowid);

// revision 必须先 unsealed 插入再一次性封存（007 的规矩）。created_by 走 schema DEFAULT 'fang'。
const revisionId = Number(db.prepare(
  `INSERT INTO fee_share_formula_revisions
     (agreement_id,case_id,revision_no,effective_on,label,change_note,result_kind,result_basis,result_rate_bps)
   VALUES (?,?,1,'2026-07-01','三成','初始约定','rate','gross',3000)`
).run(agreementId, caseId).lastInsertRowid);
db.prepare(
  "UPDATE fee_share_formula_revisions SET sealed=1, sealed_at='2026-07-01', sealed_by='fang' WHERE id=?"
).run(revisionId);
assert.equal(
  db.prepare('SELECT sealed FROM fee_share_formula_revisions WHERE id=?').get(revisionId).sealed,
  1,
  'fixture 里的 revision 必须是已封存的——不可变触发器只有对封存行才最严'
);

const assignmentId = Number(db.prepare(
  `INSERT INTO fee_share_assignments
     (case_id,fee_item_id,agreement_id,status,formula_revision_id,revision_choice,decision_note)
   VALUES (?,?,?,'assigned',?,'initial','')`
).run(caseId, feeId, agreementId, revisionId).lastInsertRowid);
const runId = Number(db.prepare(
  `INSERT INTO fee_share_settlement_runs
     (case_id,fee_item_id,run_kind,request_id,preview_hash,preview_inputs_json,
      base_amount_fen,fee_version,target_status,paid_on,reason)
   VALUES (?,?,'receipt','','hash-fixture','{}',100000,1,'paid','2026-07-15','')`
).run(caseId, feeId).lastInsertRowid);

const asgBefore = db.prepare(
  'SELECT created_at, updated_at, version FROM fee_share_assignments WHERE id=?'
).get(assignmentId);
const assignmentCreatedAt = asgBefore.created_at;
const assignmentUpdatedAt = asgBefore.updated_at;
assert.equal(asgBefore.version, 1, 'fixture 的 assignment 从 version 1 起步');

// 三张表都得是存量 'fang'（走的都是 schema DEFAULT），否则这个测试就没在测东西。
const actorOf = (table, column, id) =>
  db.prepare(`SELECT ${column} AS a FROM ${table} WHERE id=?`).get(id).a;
assert.equal(actorOf('fee_share_formula_revisions', 'created_by', revisionId), 'fang');
assert.equal(actorOf('fee_share_assignments', 'decided_by', assignmentId), 'fang');
assert.equal(actorOf('fee_share_settlement_runs', 'confirmed_by', runId), 'fang');

// ── 断言 1：migration 成功（初版 013 会在这里抛 SQLITE_CONSTRAINT_TRIGGER）────
runMigrations(db, dir13);
assert.equal(db.pragma('user_version', { simple: true }), 13);

// ── 断言 2：两张不可变表的 actor 保持 'fang'（按 007 设计不清洗）──────────
assert.equal(
  actorOf('fee_share_formula_revisions', 'created_by', revisionId),
  'fang',
  '封存的 revision 是历史证据，013 不得改写它的 created_by'
);
assert.equal(
  db.prepare("SELECT COUNT(*) c FROM fee_share_formula_revisions WHERE created_by='system'").get().c,
  0,
  '013 不应把任何 revision 的 created_by 改成 system'
);
assert.equal(
  actorOf('fee_share_settlement_runs', 'confirmed_by', runId),
  'fang',
  '人工确认的 run 不可变（trg_share_run_no_update 无条件），013 不得改写 confirmed_by'
);
assert.equal(
  db.prepare("SELECT COUNT(*) c FROM fee_share_settlement_runs WHERE confirmed_by='system'").get().c,
  0,
  '013 不应把任何 run 的 confirmed_by 改成 system'
);

// ── 断言 3：assignments 全部变 'system'，且按乐观锁契约递增了版本 ─────────
assert.equal(actorOf('fee_share_assignments', 'decided_by', assignmentId), 'system');
assert.equal(
  db.prepare("SELECT COUNT(*) c FROM fee_share_assignments WHERE decided_by='fang'").get().c,
  0,
  'assignments 不该再有 fang'
);
const asg = db.prepare('SELECT version, created_at, updated_at FROM fee_share_assignments WHERE id=?').get(assignmentId);
assert.equal(asg.version, 2, '清洗必须按 trg_share_assignment_versioned_update 的契约把 version +1');
assert.equal(asg.created_at, assignmentCreatedAt, 'created_at 不得被改');
assert.ok(asg.updated_at > assignmentUpdatedAt, 'updated_at 必须严格晚于原值');

// ── 断言 4（反向）：007 的三个写守卫一个都没被拆 ──────────────────────────
// 013 是尊重而不是拆掉这些触发器——非法写入必须仍被 ABORT。
assert.throws(
  () => db.prepare("UPDATE fee_share_formula_revisions SET created_by='system' WHERE id=?").run(revisionId),
  /except one-way sealing/,
  '不可变触发器必须仍然拦得住改 created_by'
);
assert.throws(
  () => db.prepare("UPDATE fee_share_formula_revisions SET label='改名' WHERE id=?").run(revisionId),
  /except one-way sealing/,
  '不可变触发器必须仍然拦得住改 label'
);
assert.throws(
  () => db.prepare("UPDATE fee_share_settlement_runs SET confirmed_by='system' WHERE id=?").run(runId),
  /settlement runs are immutable/,
  'run 的不可变守卫必须仍然拦得住'
);
for (const trigger of [
  'trg_share_formula_revision_only_seal_update',
  'trg_share_run_no_update',
  'trg_share_assignment_versioned_update',
]) {
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger).c,
    1,
    `触发器 ${trigger} 必须还在（013 不得 DROP 任何守卫）`
  );
}

// 幂等：再跑一次 013 不应改变任何东西（version 也不能再涨——WHERE 已匹配不到行）
runMigrations(db, dir13);
assert.equal(db.pragma('user_version', { simple: true }), 13);
assert.equal(actorOf('fee_share_formula_revisions', 'created_by', revisionId), 'fang');
assert.equal(actorOf('fee_share_settlement_runs', 'confirmed_by', runId), 'fang');
assert.equal(actorOf('fee_share_assignments', 'decided_by', assignmentId), 'system');
assert.equal(
  db.prepare('SELECT version FROM fee_share_assignments WHERE id=?').get(assignmentId).version,
  2,
  '幂等：重复迁移不得再次递增 version'
);

assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
assert.deepEqual(db.pragma('foreign_key_check'), []);
db.close();

// ── 原子回滚：013 之后追加坏 SQL，整体回滚到 12 且数据不动 ────────────────
const failingDir = path.join(scratch, 'failure');
copy(files12, failingDir);
fs.writeFileSync(
  path.join(failingDir, '013_depersonalize_actors.sql'),
  `${fs.readFileSync(path.join(migrationsDir, '013_depersonalize_actors.sql'), 'utf8')}\nTHIS IS INVALID SQL;\n`
);
const failing = new Database(path.join(scratch, 'failing.db'));
failing.pragma('foreign_keys = ON');
runMigrations(failing, dir12);
const fCase = Number(failing.prepare(
  "INSERT INTO cases (name, procedure, stage) VALUES ('回滚示例案（李四）','一审','待裁判')"
).run().lastInsertRowid);
const fFee = Number(failing.prepare(
  "INSERT INTO fee_items (case_id,label,amount,status,paid_on) VALUES (?,'示例款',500,'paid','2026-07-16')"
).run(fCase).lastInsertRowid);
const fAgreement = Number(failing.prepare(
  `INSERT INTO fee_share_agreements (case_id,direction,counterpart,rate,created_at)
   VALUES (?,'payable','李四',30,'2026-07-01 09:00:00')`
).run(fCase).lastInsertRowid);
const fRevision = Number(failing.prepare(
  `INSERT INTO fee_share_formula_revisions
     (agreement_id,case_id,revision_no,effective_on,label,change_note,result_kind,result_basis,result_rate_bps)
   VALUES (?,?,1,'2026-07-01','三成','初始约定','rate','gross',3000)`
).run(fAgreement, fCase).lastInsertRowid);
failing.prepare(
  "UPDATE fee_share_formula_revisions SET sealed=1, sealed_at='2026-07-01', sealed_by='fang' WHERE id=?"
).run(fRevision);
const fAssignment = Number(failing.prepare(
  `INSERT INTO fee_share_assignments
     (case_id,fee_item_id,agreement_id,status,formula_revision_id,revision_choice,decision_note)
   VALUES (?,?,?,'assigned',?,'initial','')`
).run(fCase, fFee, fAgreement, fRevision).lastInsertRowid);
assert.throws(() => runMigrations(failing, failingDir), /near "THIS"|syntax error/i);
assert.equal(failing.pragma('user_version', { simple: true }), 12, '失败必须整体回滚到 12');
assert.equal(
  failing.prepare("SELECT COUNT(*) c FROM fee_share_assignments WHERE decided_by='fang'").get().c,
  1,
  '回滚后存量 fang 必须原封不动'
);
assert.equal(
  failing.prepare('SELECT version FROM fee_share_assignments WHERE id=?').get(fAssignment).version,
  1,
  '回滚后 version 必须回到 1'
);
failing.close();

fs.rmSync(scratch, { recursive: true, force: true });
console.log('migration 013 tests: two immutable tables preserved + assignments depersonalized under version contract + all three guards intact + atomic rollback passed');
