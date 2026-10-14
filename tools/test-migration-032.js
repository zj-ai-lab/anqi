import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';

const root = path.resolve('src/migrations');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-m032-'));
const before032 = path.join(dir, 'before032');
fs.mkdirSync(before032);
for (const file of fs.readdirSync(root).filter((name) => Number(name.slice(0, 3)) <= 31)) fs.copyFileSync(path.join(root, file), path.join(before032, file));

function assertSchema(db, label) {
  assert.equal(db.pragma('user_version', { simple: true }), 32, `${label}: migration 032 applied`);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='im_bindings'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='im_inbound'").get());
  assert.throws(() => db.prepare("INSERT INTO im_bindings(provider,userid,bot_id,bound_at) VALUES ('bad','x','y','z')").run(), /CHECK/);
  db.prepare("INSERT INTO im_bindings(provider,userid,bot_id,bound_at) VALUES ('wecom','zhangsan_test','bot_test_0001','2099-01-01T00:00:00Z')").run();
  assert.throws(() => db.prepare("INSERT INTO im_bindings(provider,userid,bot_id,bound_at) VALUES ('wecom','lisi_test','bot_test_0001','2099-01-01T00:00:00Z')").run(), /UNIQUE/);
  db.prepare("INSERT INTO im_inbound(provider,msgid,received_at,outcome) VALUES ('wecom','m1','2099-01-01T00:00:00Z','ignored')").run();
  assert.throws(() => db.prepare("INSERT INTO im_inbound(provider,msgid,received_at,outcome) VALUES ('wecom','m1','2099-01-01T00:00:00Z','ignored')").run(), /UNIQUE/);
  assert.throws(() => db.prepare("INSERT INTO im_inbound(provider,msgid,received_at,outcome) VALUES ('wecom','m2','2099-01-01T00:00:00Z','not-valid')").run(), /CHECK/);
}

try {
  const empty = new Database(':memory:');
  empty.pragma('foreign_keys = ON');
  runMigrations(empty);
  assertSchema(empty, 'empty database');
  empty.close();

  const file = path.join(dir, 'v31.db');
  const existing = new Database(file);
  existing.pragma('foreign_keys = ON');
  runMigrations(existing, before032);
  assert.equal(existing.pragma('user_version', { simple: true }), 31);
  const caseId = existing.prepare("INSERT INTO cases (name) VALUES ('张三案')").run().lastInsertRowid;
  existing.prepare("INSERT INTO worklog (case_id,worked_on,content) VALUES (?,?,'存量日志')").run(caseId, '2099-01-01');
  runMigrations(existing, root);
  assertSchema(existing, 'v31 database');
  assert.equal(existing.prepare('SELECT COUNT(*) AS n FROM cases').get().n, 1, 'v31 data preserved');
  assert.equal(existing.prepare('SELECT content FROM worklog').get().content, '存量日志');
  assert.equal(existing.pragma('user_version', { simple: true }), 32);
  existing.close();
  console.log('migration 032: empty/v31 upgrade, binding policy, inbound dedup and outcome checks passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
