// migration 022：变更记录（change_log）+ 事务内身份上下文（change_context）。
//
// 本文件只验「迁移本身」：表/索引/触发器就位、五张业务表的增删改是否留痕、
// 上下文是否传递、底账是否真的不可改、以及失败时是否整体回滚。
// 应用层如何包事务（withChangeContext 的调用点）由 test-changes-http.js 走真 HTTP 验。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDir = path.join(root, 'src', 'migrations');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-022-'));
const files21 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|01[0-9]|02[01])_.*\.sql$/.test(name)).sort();
const files22 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|01[0-9]|02[0-2])_.*\.sql$/.test(name)).sort();

function copy(files, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(migrationsDir, file), path.join(target, file));
}

const dir21 = path.join(scratch, 'v21');
const dir22 = path.join(scratch, 'v22');
copy(files21, dir21);
copy(files22, dir22);

// db.js 顶层会打开 DB_PATH（默认 data/anjian.db）并跑迁移。check.sh 每次调用都带
// DB_PATH；这里再兜一层，手跑本文件时也不会碰到真实库。
if (!process.env.DB_PATH) process.env.DB_PATH = path.join(scratch, 'guard.db');
const { runMigrations } = await import('../src/db.js');

// ---- 先造 021 形态的库 + 存量数据（升级前的库不能是空的）----
const db = new Database(path.join(scratch, 'fixture.db'));
db.pragma('foreign_keys = ON');
runMigrations(db, dir21);
assert.equal(db.pragma('user_version', { simple: true }), 21);

const caseId = db.prepare("INSERT INTO cases (name, stage) VALUES ('张三诉李四合同纠纷（migration 022）','审理中')").run().lastInsertRowid;
const otherCaseId = db.prepare("INSERT INTO cases (name, stage) VALUES ('另案（migration 022）','审理中')").run().lastInsertRowid;
const eventId = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?,'served','2026-09-01')").run(caseId).lastInsertRowid;
const deadlineId = db.prepare("INSERT INTO deadlines (case_id,trigger_event_id,name,due_on) VALUES (?,?,'答辩期','2026-09-16')").run(caseId, eventId).lastInsertRowid;
const taskId = db.prepare("INSERT INTO tasks (case_id,title) VALUES (?,'提交委托材料')").run(caseId).lastInsertRowid;
const logId = db.prepare("INSERT INTO worklog (case_id,worked_on,content) VALUES (?,'2026-09-02','阅卷')").run(caseId).lastInsertRowid;

// ---- 升级到 022 ----
runMigrations(db, dir22);
assert.equal(db.pragma('user_version', { simple: true }), 22);
assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');

// 存量数据不受影响，且升级本身不补记历史（底账从装上的那一刻开始记，不追溯）
assert.equal(db.prepare('SELECT COUNT(*) c FROM change_log').get().c, 0);
assert.equal(db.prepare('SELECT COUNT(*) c FROM deadlines WHERE id=?').get(deadlineId).c, 1);

// ---- 结构：列 / 索引 / 触发器 ----
const columns = db.prepare("PRAGMA table_info('change_log')").all().map((column) => column.name);
assert.deepEqual(columns, [
  'id', 'entity', 'entity_id', 'case_id', 'action', 'field',
  'old_value', 'new_value', 'changed_at', 'origin', 'actor', 'rule_id', 'synced_at',
]);
const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='change_log'").all().map((row) => row.name);
for (const name of ['idx_change_log_case', 'idx_change_log_entity', 'idx_change_log_unsynced']) {
  assert.ok(indexes.includes(name), `缺索引 ${name}`);
}
const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_log_%'").all().map((row) => row.name);
assert.equal(triggers.length, 15, `应有 15 个业务触发器，实得 ${triggers.length}`);
for (const table of ['cases', 'events', 'deadlines', 'tasks', 'worklog']) {
  for (const op of ['insert', 'update', 'delete']) {
    assert.ok(triggers.includes(`trg_log_${table}_${op}`), `缺触发器 trg_log_${table}_${op}`);
  }
}

// ---- UPDATE 差异列清单必须与真实表结构对齐 ----
// 这是本项目最容易悄悄错的地方：给业务表 ALTER ADD COLUMN 之后忘了补 022 的比对列，
// 新列就会「改了也不留痕」而没有任何报错。这里用真实表结构反查触发器里的列清单。
const triggerSql = Object.fromEntries(
  db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'").all().map((row) => [row.name, row.sql]),
);
for (const table of ['cases', 'events', 'deadlines', 'tasks', 'worklog']) {
  const real = db.prepare(`PRAGMA table_info('${table}')`).all().map((column) => column.name);
  const expected = real.filter((name) => name !== 'id' && name !== 'updated_at');
  const listed = [...triggerSql[`trg_log_${table}_update`].matchAll(/SELECT\s+'([A-Za-z_]+)'\s+AS field/g)].map((m) => m[1]);
  assert.deepEqual(listed.slice().sort(), expected.slice().sort(), `${table} 的 UPDATE 比对列与表结构不一致`);
}

// ---- 上下文：actor / origin / rule_id 传递 ----
const setContext = (actor, ruleId = null, origin = 'local') => db.prepare(
  `INSERT INTO change_context (id, actor, origin, rule_id) VALUES (1, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET actor=excluded.actor, origin=excluded.origin, rule_id=excluded.rule_id`
).run(actor, origin, ruleId);
const clearContext = () => db.prepare("UPDATE change_context SET actor=NULL, origin='local', rule_id=NULL WHERE id=1").run();
const trace = (id) => db.prepare('SELECT * FROM change_log WHERE id=?').get(id);
const last = () => db.prepare('SELECT * FROM change_log ORDER BY id DESC LIMIT 1').get();
const count = () => db.prepare('SELECT COUNT(*) c FROM change_log').get().c;

clearContext();

// insert：case_id 归属 + 行标签 + 上下文
setContext('web', 'answer_15d');
const newDeadlineId = db.prepare("INSERT INTO deadlines (case_id,trigger_event_id,name,due_on) VALUES (?,?,'举证期限','2026-10-01')").run(caseId, eventId).lastInsertRowid;
let row = last();
assert.equal(row.entity, 'deadline');
assert.equal(row.entity_id, newDeadlineId);
assert.equal(row.case_id, caseId, '子表行必须带上所属案件（案件页按 case_id 取变更）');
assert.equal(row.action, 'insert');
assert.equal(row.field, null);
assert.equal(row.old_value, null);
assert.equal(row.new_value, '举证期限', 'insert 要落人类可读标签，否则底账不知新增的是哪一条');
assert.equal(row.actor, 'web');
assert.equal(row.origin, 'local');
assert.equal(row.rule_id, 'answer_15d');
assert.equal(row.synced_at, null);

// cases 表取自身主键当 case_id
const thirdCaseId = db.prepare("INSERT INTO cases (name,stage) VALUES ('第三个案件','审理中')").run().lastInsertRowid;
assert.equal(last().case_id, thirdCaseId);
assert.equal(last().entity_id, thirdCaseId);

// update：逐列差异，未变的列不留痕
clearContext();
db.prepare("UPDATE deadlines SET status='done' WHERE id=?").run(newDeadlineId);
row = last();
assert.equal(row.action, 'update');
assert.equal(row.field, 'status');
assert.equal(row.old_value, 'pending');
assert.equal(row.new_value, 'done');
assert.equal(row.case_id, caseId);
assert.equal(row.actor, 'system', '未包上下文时应如实记 system，不冒充某个人');

// 空写不留痕：值没变的 UPDATE 不该产生一条「其实什么都没改」的变更
const beforeEmptyWrite = count();
db.prepare("UPDATE deadlines SET status='done' WHERE id=?").run(newDeadlineId);
assert.equal(count(), beforeEmptyWrite);

// 一次改多列 → 多条记录，各记各的字段
db.prepare("UPDATE deadlines SET severity='critical', calc_note='人工核对后调整' WHERE id=?").run(newDeadlineId);
const multi = db.prepare("SELECT field FROM change_log WHERE entity='deadline' AND entity_id=? AND action='update' ORDER BY id").all(newDeadlineId).map((r) => r.field);
assert.deepEqual(multi.slice(-2).sort(), ['calc_note', 'severity']);

// id / updated_at 不进差异：主键不会变，updated_at 是纯记账列
db.prepare("UPDATE tasks SET title='提交委托材料（补正）' WHERE id=?").run(taskId);
const fields = db.prepare("SELECT DISTINCT field FROM change_log WHERE action='update'").all().map((r) => r.field);
assert.equal(fields.includes('id'), false);
assert.equal(fields.includes('updated_at'), false);
assert.equal(fields.includes('synced_at'), false, 'synced_at 属于 change_log 自己的列，不该出现在业务表比对里');

// delete：源行没了，标签与归属仍留在底账里
const removedDeadlineId = newDeadlineId;
db.prepare('DELETE FROM deadlines WHERE id=?').run(removedDeadlineId);
row = last();
assert.equal(row.action, 'delete');
assert.equal(row.entity, 'deadline');
assert.equal(row.entity_id, removedDeadlineId);
assert.equal(row.case_id, caseId, '删除后仍须能归属案件——这正是加 case_id 的动机');
assert.equal(row.new_value, null);
assert.equal(row.old_value, '举证期限');
assert.equal(db.prepare('SELECT COUNT(*) c FROM deadlines WHERE id=?').get(removedDeadlineId).c, 0);

// 五张表都能按 case_id 归集（含已删除的行）。
// 删除顺序受外键约束：tasks.deadline_id → deadlines、deadlines.trigger_event_id → events
// 都是无 ON DELETE 的 REFERENCES，必须先删下游。
for (const [table, id] of [['tasks', taskId], ['deadlines', deadlineId], ['events', eventId], ['worklog', logId]]) {
  db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
}
assert.deepEqual(db.pragma('foreign_key_check'), []);
// cases 自身也要能归集。注意 caseId 那一行建于 022 之前，底账不追溯历史，
// 所以先改一笔，让它以「修改案件」的形态出现在自己的案件页上。
db.prepare("UPDATE cases SET note='归集检查' WHERE id=?").run(caseId);
const byCase = db.prepare('SELECT DISTINCT entity FROM change_log WHERE case_id=?').all(caseId).map((r) => r.entity);
for (const entity of ['case', 'event', 'deadline', 'task', 'worklog']) {
  assert.ok(byCase.includes(entity), `case_id=${caseId} 下应能看到 ${entity} 的变更`);
}
// 另一案件的行不会串进来
assert.equal(db.prepare('SELECT COUNT(*) c FROM change_log WHERE case_id=?').get(thirdCaseId).c, 1);
assert.equal(db.prepare('SELECT COUNT(*) c FROM change_log WHERE case_id=? AND entity=?').get(thirdCaseId, 'case').c, 1);
// 022 安装前就存在的行不补记历史：底账从装上那一刻开始记，不做回溯填充
assert.equal(
  db.prepare('SELECT COUNT(*) c FROM change_log WHERE case_id=?').get(otherCaseId).c, 0,
  '安装前已存在的案件不该有插入留痕',
);

// ---- 底账不可改：应用层写错也删不掉历史 ----
assert.throws(() => db.prepare("UPDATE change_log SET actor='x' WHERE id=1").run(), /append-only/);
assert.throws(() => db.prepare('DELETE FROM change_log WHERE id=1').run(), /append-only/);
assert.throws(() => db.prepare('DELETE FROM change_log').run(), /append-only/);

// ---- CHECK 约束：动作与来源只能取约定值 ----
assert.throws(
  () => db.prepare("INSERT INTO change_log (entity,action) VALUES ('case','upsert')").run(),
  /CHECK constraint failed/i,
);
assert.throws(
  () => db.prepare("INSERT INTO change_log (entity,action,origin) VALUES ('case','insert','edge')").run(),
  /CHECK constraint failed/i,
);
// change_context 是单行表
assert.throws(
  () => db.prepare("INSERT INTO change_context (id,actor) VALUES (2,'x')").run(),
  /CHECK constraint failed/i,
);

// ---- 幂等：重复跑不报错、不重复建对象 ----
runMigrations(db, dir22);
runMigrations(db, dir22);
assert.equal(db.pragma('user_version', { simple: true }), 22);
assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_log_%'").get().c, 15);
const afterIdempotent = count();
db.prepare("UPDATE cases SET note='幂等复跑后的一笔' WHERE id=?").run(caseId);
assert.equal(count(), afterIdempotent + 1, '幂等复跑不应把触发器叠加成重复记录');
db.close();

// ---- 原子性：022 出错时整体回滚，不留半截对象、user_version 不回退 ----
const failingDir = path.join(scratch, 'failure');
copy(files21, failingDir);
fs.writeFileSync(
  path.join(failingDir, '022_change_log.sql'),
  `${fs.readFileSync(path.join(migrationsDir, '022_change_log.sql'), 'utf8')}\nTHIS IS INVALID SQL;\n`,
);
const failing = new Database(path.join(scratch, 'failing.db'));
runMigrations(failing, dir21);
assert.throws(() => runMigrations(failing, failingDir), /near "THIS"|syntax error/i);
assert.equal(failing.pragma('user_version', { simple: true }), 21);
assert.equal(failing.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='change_log'").get().c, 0);
assert.equal(failing.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='change_context'").get().c, 0);
assert.equal(failing.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_log_%'").get().c, 0);
failing.close();

fs.rmSync(scratch, { recursive: true, force: true });
console.log('migration 022 tests: change_log schema + case_id attribution + row labels + context passthrough + empty-write suppression + append-only + idempotent + atomic rollback passed');
