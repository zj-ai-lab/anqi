// migration 018：agent 直写来源戳、期限待核闸与独立案件事实表。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDir = path.join(root, 'src', 'migrations');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-018-'));
const files17 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|01[0-7])_.*\.sql$/.test(name)).sort();
const files18 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|01[0-8])_.*\.sql$/.test(name)).sort();

function copy(files, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(migrationsDir, file), path.join(target, file));
}

const dir17 = path.join(scratch, 'v17');
const dir18 = path.join(scratch, 'v18');
copy(files17, dir17);
copy(files18, dir18);

const db = new Database(path.join(scratch, 'fixture.db'));
db.pragma('foreign_keys = ON');
runMigrations(db, dir17);
const caseId = db.prepare("INSERT INTO cases (name) VALUES ('张三诉李四合同纠纷（migration 018）')").run().lastInsertRowid;
const contactId = db.prepare("INSERT INTO contacts (case_id,role,name) VALUES (?,'法官助理','王助理')").run(caseId).lastInsertRowid;
const deadlineId = db.prepare("INSERT INTO deadlines (case_id,name,due_on) VALUES (?,'举证期限','2030-01-02')").run(caseId).lastInsertRowid;

runMigrations(db, dir18);
assert.equal(db.pragma('user_version', { simple: true }), 18);
assert.equal(db.prepare('SELECT created_by FROM contacts WHERE id=?').get(contactId).created_by, 'manual');
assert.deepEqual(db.prepare('SELECT created_by,review_status FROM deadlines WHERE id=?').get(deadlineId), {
  created_by: 'manual',
  review_status: 'confirmed',
});

const contactCreatedBy = db.prepare("PRAGMA table_info('contacts')").all().find((column) => column.name === 'created_by');
assert.deepEqual(
  { type: contactCreatedBy?.type, required: contactCreatedBy?.notnull, default: contactCreatedBy?.dflt_value },
  { type: 'TEXT', required: 1, default: "'manual'" },
);
const deadlineColumns = db.prepare("PRAGMA table_info('deadlines')").all();
assert.ok(deadlineColumns.some((column) => column.name === 'created_by' && column.dflt_value === "'manual'"));
assert.ok(deadlineColumns.some((column) => column.name === 'review_status' && column.dflt_value === "'confirmed'"));

assert.throws(
  () => db.prepare("INSERT INTO contacts (case_id,role,name,created_by) VALUES (?,'其他','越界来源','model')").run(caseId),
  /CHECK constraint failed/i,
);
assert.throws(
  () => db.prepare("INSERT INTO deadlines (case_id,name,due_on,review_status) VALUES (?,'非法待核','2030-01-03','unknown')").run(caseId),
  /CHECK constraint failed/i,
);
assert.throws(
  () => db.prepare("INSERT INTO deadlines (case_id,name,due_on,created_by) VALUES (?,'非法来源','2030-01-03','model')").run(caseId),
  /CHECK constraint failed/i,
);

const factId = db.prepare(
  "INSERT INTO facts (case_id,content,occurred_on,source,note) VALUES (?,'法院已通知补充证据','2030-01-01','电话记录','人工核对')"
).run(caseId).lastInsertRowid;
assert.deepEqual(
  db.prepare('SELECT case_id,content,occurred_on,source,note,created_by FROM facts WHERE id=?').get(factId),
  { case_id: caseId, content: '法院已通知补充证据', occurred_on: '2030-01-01', source: '电话记录', note: '人工核对', created_by: 'manual' },
);
assert.throws(
  () => db.prepare("INSERT INTO facts (case_id,content,created_by) VALUES (?,'非法来源事实','model')").run(caseId),
  /CHECK constraint failed/i,
);

runMigrations(db, dir18);
assert.equal(db.pragma('user_version', { simple: true }), 18);
assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
db.close();

const failingDir = path.join(scratch, 'failure');
copy(files17, failingDir);
fs.writeFileSync(
  path.join(failingDir, '018_agent_direct_write.sql'),
  `${fs.readFileSync(path.join(migrationsDir, '018_agent_direct_write.sql'), 'utf8')}\nTHIS IS INVALID SQL;\n`,
);
const failing = new Database(path.join(scratch, 'failing.db'));
runMigrations(failing, dir17);
assert.throws(() => runMigrations(failing, failingDir), /near "THIS"|syntax error/i);
assert.equal(failing.pragma('user_version', { simple: true }), 17);
assert.equal(failing.prepare("SELECT COUNT(*) c FROM pragma_table_info('contacts') WHERE name='created_by'").get().c, 0);
assert.equal(failing.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='facts'").get().c, 0);
failing.close();

fs.rmSync(scratch, { recursive: true, force: true });
console.log('migration 018 tests: legacy defaults + source/review constraints + facts table + idempotent + atomic rollback passed');
