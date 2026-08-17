// migration 015 升级测试：v14 → v15，tasks 增加 due_time（截止时刻）。
// 覆盖：存量任务默认空串、合法时刻可存、幂等、数据不变，以及 DDL + user_version 原子回滚。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDir = path.join(root, 'src', 'migrations');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-015-'));

const files14 = fs.readdirSync(migrationsDir).filter((n) => /^(00[1-9]|01[0-4])_.*\.sql$/.test(n)).sort();
const files15 = fs.readdirSync(migrationsDir).filter((n) => /^(00[1-9]|01[0-5])_.*\.sql$/.test(n)).sort();

function copy(files, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(migrationsDir, file), path.join(target, file));
}

const dir14 = path.join(scratch, 'v14');
const dir15 = path.join(scratch, 'v15');
copy(files14, dir14);
copy(files15, dir15);

// ── fixture：真实 001–014 + 存量案件/待办 ─────────────────────────────────────
const db = new Database(path.join(scratch, 'fixture.db'));
db.pragma('foreign_keys = ON');
runMigrations(db, dir14);
assert.equal(db.pragma('user_version', { simple: true }), 14, 'fixture 必须停在真实 014');

const caseId = Number(db.prepare(
  "INSERT INTO cases (name, procedure, stage) VALUES ('跨天示例案（张三）','一审','举证')"
).run().lastInsertRowid);
const taskId = Number(db.prepare(
  "INSERT INTO tasks (case_id, title, plan_date, due_on, priority, note) VALUES (?, '存量待办（李四）', '2026-08-04', '2026-08-05', 'high', '升级前备注')"
).run(caseId).lastInsertRowid);
const before = db.prepare('SELECT title, plan_date, due_on, priority, note FROM tasks WHERE id = ?').get(taskId);
assert.equal(
  db.prepare("SELECT COUNT(*) c FROM pragma_table_info('tasks') WHERE name = 'due_time'").get().c,
  0,
  '014 世界里不该已经有 due_time'
);

// ── 断言 1：升级成功，旧任务得到空串默认值 ──────────────────────────────────
runMigrations(db, dir15);
assert.equal(db.pragma('user_version', { simple: true }), 15);
const column = db.prepare("SELECT name, type, \"notnull\" AS required, dflt_value FROM pragma_table_info('tasks') WHERE name = 'due_time'").get();
assert.deepEqual(column, { name: 'due_time', type: 'TEXT', required: 1, dflt_value: "''" });
assert.equal(db.prepare('SELECT due_time FROM tasks WHERE id = ?').get(taskId).due_time, '');
assert.deepEqual(db.prepare('SELECT title, plan_date, due_on, priority, note FROM tasks WHERE id = ?').get(taskId), before);

// ── 断言 2：截止时刻按字符串原样存储，空串仍代表全天 ─────────────────────────
db.prepare('UPDATE tasks SET due_time = ? WHERE id = ?').run('08:05', taskId);
assert.equal(db.prepare('SELECT due_time FROM tasks WHERE id = ?').get(taskId).due_time, '08:05');
db.prepare('UPDATE tasks SET due_time = ? WHERE id = ?').run('', taskId);
assert.equal(db.prepare('SELECT due_time FROM tasks WHERE id = ?').get(taskId).due_time, '');

// ── 幂等与完整性 ────────────────────────────────────────────────────────────
runMigrations(db, dir15);
assert.equal(db.pragma('user_version', { simple: true }), 15);
assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
assert.deepEqual(db.pragma('foreign_key_check'), []);
db.close();

// ── 原子回滚：015 后追加坏 SQL，整体回滚到 14、due_time 不出现 ───────────────
const failingDir = path.join(scratch, 'failure');
copy(files14, failingDir);
fs.writeFileSync(
  path.join(failingDir, '015_task_due_time.sql'),
  `${fs.readFileSync(path.join(migrationsDir, '015_task_due_time.sql'), 'utf8')}\nTHIS IS INVALID SQL;\n`
);
const failing = new Database(path.join(scratch, 'failing.db'));
failing.pragma('foreign_keys = ON');
runMigrations(failing, dir14);
const rollbackTask = Number(failing.prepare(
  "INSERT INTO tasks (title, plan_date, due_on) VALUES ('回滚示例待办（王五）', '2026-08-04', '2026-08-06')"
).run().lastInsertRowid);
assert.throws(() => runMigrations(failing, failingDir), /near "THIS"|syntax error/i);
assert.equal(failing.pragma('user_version', { simple: true }), 14, '失败必须整体回滚到 14');
assert.equal(
  failing.prepare("SELECT COUNT(*) c FROM pragma_table_info('tasks') WHERE name = 'due_time'").get().c,
  0,
  '回滚后不得留下 due_time 列'
);
assert.deepEqual(
  failing.prepare('SELECT title, plan_date, due_on FROM tasks WHERE id = ?').get(rollbackTask),
  { title: '回滚示例待办（王五）', plan_date: '2026-08-04', due_on: '2026-08-06' },
  '回滚后存量待办必须原封不动'
);
failing.close();

fs.rmSync(scratch, { recursive: true, force: true });
console.log('migration 015 tests: due_time default/HH:MM storage + existing data untouched + idempotent + atomic rollback passed');
