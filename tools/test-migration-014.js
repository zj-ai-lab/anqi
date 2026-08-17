// migration 014 升级测试：v13 → v14，新增 settings 键值表（用户中心 · 个人设置）。
//
// 014 只有一条 CREATE TABLE，看似零风险——但 RELEASING §5 的规矩是每个 migration
// 都要有带**存量数据**的 fixture 测试（013 的教训：check.sh 的干跑在空库上做，
// 存量库才会踩响的守卫一个都不响）。所以这里照样：真实 001–013 起底、塞存量数据、
// 验升级 / 幂等 / 原子回滚，并确认既有数据一字不动。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDir = path.join(root, 'src', 'migrations');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-014-'));

const files13 = fs.readdirSync(migrationsDir).filter((n) => /^(00[1-9]|01[0-3])_.*\.sql$/.test(n)).sort();
const files14 = fs.readdirSync(migrationsDir).filter((n) => /^(00[1-9]|01[0-4])_.*\.sql$/.test(n)).sort();

function copy(files, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(migrationsDir, file), path.join(target, file));
}

const dir13 = path.join(scratch, 'v13');
const dir14 = path.join(scratch, 'v14');
copy(files13, dir13);
copy(files14, dir14);

// ── fixture：真实 001–013 + 存量数据 ────────────────────────────────────────
const db = new Database(path.join(scratch, 'fixture.db'));
db.pragma('foreign_keys = ON');
runMigrations(db, dir13);
assert.equal(db.pragma('user_version', { simple: true }), 13, 'fixture 必须停在真实 013');

const caseId = Number(db.prepare(
  "INSERT INTO cases (name, procedure, stage) VALUES ('示例升级案（张三）','一审','待裁判')"
).run().lastInsertRowid);
const feeId = Number(db.prepare(
  "INSERT INTO fee_items (case_id,label,amount,status,paid_on) VALUES (?,'已收示例款',1000,'paid','2026-07-15')"
).run(caseId).lastInsertRowid);
const rowsBefore = {
  cases: db.prepare('SELECT COUNT(*) c FROM cases').get().c,
  fee_items: db.prepare('SELECT COUNT(*) c FROM fee_items').get().c,
};
assert.equal(
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='settings'").get().c,
  0,
  '013 世界里不该已经有 settings 表'
);

// ── 断言 1：升级成功，settings 表存在且为空 ────────────────────────────────
runMigrations(db, dir14);
assert.equal(db.pragma('user_version', { simple: true }), 14);
assert.equal(
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='settings'").get().c,
  1,
  '014 之后必须有 settings 表'
);
assert.equal(db.prepare('SELECT COUNT(*) c FROM settings').get().c, 0, '新表必须是空的');

// ── 断言 2：schema 契约——key 主键去重（upsert 语义的地基）、value NOT NULL ──
db.prepare("INSERT INTO settings (key, value) VALUES ('name','张三')").run();
db.prepare("INSERT INTO settings (key, value) VALUES ('name','李四') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
assert.equal(db.prepare("SELECT value FROM settings WHERE key='name'").get().value, '李四');
assert.equal(db.prepare('SELECT COUNT(*) c FROM settings').get().c, 1, '同 key 必须只有一行');
assert.throws(
  () => db.prepare("INSERT INTO settings (key, value) VALUES ('phone', NULL)").run(),
  /NOT NULL/,
  'value 不许 NULL'
);
db.prepare('DELETE FROM settings').run();

// ── 断言 3：既有数据一字不动 ──────────────────────────────────────────────
assert.equal(db.prepare('SELECT COUNT(*) c FROM cases').get().c, rowsBefore.cases);
assert.equal(db.prepare('SELECT COUNT(*) c FROM fee_items').get().c, rowsBefore.fee_items);
assert.equal(db.prepare('SELECT name FROM cases WHERE id=?').get(caseId).name, '示例升级案（张三）');
assert.equal(db.prepare('SELECT amount FROM fee_items WHERE id=?').get(feeId).amount, 1000);

// ── 幂等：再跑一次 014 不炸、版本不动 ─────────────────────────────────────
runMigrations(db, dir14);
assert.equal(db.pragma('user_version', { simple: true }), 14);

assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
assert.deepEqual(db.pragma('foreign_key_check'), []);
db.close();

// ── 原子回滚：014 后追加坏 SQL，整体回滚到 13、settings 不出现、数据不动 ───
const failingDir = path.join(scratch, 'failure');
copy(files13, failingDir);
fs.writeFileSync(
  path.join(failingDir, '014_settings.sql'),
  `${fs.readFileSync(path.join(migrationsDir, '014_settings.sql'), 'utf8')}\nTHIS IS INVALID SQL;\n`
);
const failing = new Database(path.join(scratch, 'failing.db'));
failing.pragma('foreign_keys = ON');
runMigrations(failing, dir13);
failing.prepare(
  "INSERT INTO cases (name, procedure, stage) VALUES ('回滚示例案（李四）','一审','待裁判')"
).run();
assert.throws(() => runMigrations(failing, failingDir), /near "THIS"|syntax error/i);
assert.equal(failing.pragma('user_version', { simple: true }), 13, '失败必须整体回滚到 13');
assert.equal(
  failing.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='settings'").get().c,
  0,
  '回滚后不得留下半张 settings 表'
);
assert.equal(failing.prepare('SELECT COUNT(*) c FROM cases').get().c, 1, '回滚后存量数据必须原封不动');
failing.close();

fs.rmSync(scratch, { recursive: true, force: true });
console.log('migration 014 tests: settings table created empty + upsert/NOT NULL contract + existing data untouched + idempotent + atomic rollback passed');
