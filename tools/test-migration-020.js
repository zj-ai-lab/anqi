// migration 020 升级测试：v19 → v20，通讯录 + 案件参与人 + 分成关联。
// 覆盖：存量联系人回填、默认空关联、外键、幂等与原子回滚。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDir = path.join(root, 'src', 'migrations');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-020-'));
const files19 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|01[0-9])_.*\.sql$/.test(name)).sort();
const files20 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|01[0-9]|020)_.*\.sql$/.test(name)).sort();

function copy(files, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(migrationsDir, file), path.join(target, file));
}

const dir19 = path.join(scratch, 'v19');
const dir20 = path.join(scratch, 'v20');
copy(files19, dir19);
copy(files20, dir20);

const db = new Database(path.join(scratch, 'fixture.db'));
db.pragma('foreign_keys = ON');
runMigrations(db, dir19);
assert.equal(db.pragma('user_version', { simple: true }), 19);

const caseId = Number(db.prepare(
  "INSERT INTO cases (name, procedure, status) VALUES ('迁移参与人示例案', '一审', 'active')"
).run().lastInsertRowid);
const otherCaseId = Number(db.prepare(
  "INSERT INTO cases (name, procedure, status) VALUES ('不回填示例案', '一审', 'active')"
).run().lastInsertRowid);
db.prepare(
  `INSERT INTO contacts (case_id, role, name, phone, org, note)
   VALUES (?, '合作律师', '存量合作律师', '', '示例律师事务所', '从联系人回填')`
).run(caseId);
db.prepare(
  `INSERT INTO contacts (case_id, role, name, phone)
   VALUES (?, '对方律师', '存量对方律师', '13800138000')`
).run(caseId);
db.prepare(
  `INSERT INTO contacts (case_id, role, name, phone)
   VALUES (?, '法官助理', '不应回填对象', '')`
).run(otherCaseId);
const agreementId = Number(db.prepare(
  `INSERT INTO fee_share_agreements (case_id, direction, counterpart, rate)
   VALUES (?, 'payable', '存量合作律师', 50)`
).run(caseId).lastInsertRowid);
const shareId = Number(db.prepare(
  `INSERT INTO fee_shares (case_id, direction, counterpart, amount, due_month, status)
   VALUES (?, 'payable', '存量合作律师', 100, '2026-09', 'pending')`
).run(caseId).lastInsertRowid);

runMigrations(db, dir20);
assert.equal(db.pragma('user_version', { simple: true }), 20);
assert.deepEqual(
  db.prepare('SELECT name, phone FROM people ORDER BY name').all(),
  [
    { name: '存量合作律师', phone: '' },
    { name: '存量对方律师', phone: '13800138000' },
  ],
);
const participantRows = db.prepare(
  `SELECT cp.case_id, p.name, cp.role
     FROM case_participants cp JOIN people p ON p.id = cp.person_id`
).all();
assert.deepEqual(Object.fromEntries(participantRows.map((row) => [row.name, row])), {
  '存量合作律师': { case_id: caseId, name: '存量合作律师', role: '合作律师' },
  '存量对方律师': { case_id: caseId, name: '存量对方律师', role: '对方律师' },
});
assert.deepEqual(
  db.prepare('SELECT person_id FROM fee_share_agreements WHERE id=?').get(agreementId),
  { person_id: null },
);
assert.deepEqual(
  db.prepare('SELECT person_id FROM fee_shares WHERE id=?').get(shareId),
  { person_id: null },
);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM people WHERE name='不应回填对象'").get().count, 0);

const linkedPersonId = Number(db.prepare("SELECT id FROM people WHERE name='存量合作律师'").get().id);
db.prepare('UPDATE fee_share_agreements SET person_id=? WHERE id=?').run(linkedPersonId, agreementId);
db.prepare('UPDATE fee_shares SET person_id=? WHERE id=?').run(linkedPersonId, shareId);
assert.deepEqual(db.pragma('foreign_key_check'), []);
runMigrations(db, dir20);
assert.equal(db.pragma('user_version', { simple: true }), 20);
assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
db.close();

const failingDir = path.join(scratch, 'failure');
copy(files19, failingDir);
fs.writeFileSync(
  path.join(failingDir, '020_people_participants.sql'),
  `${fs.readFileSync(path.join(migrationsDir, '020_people_participants.sql'), 'utf8')}\nTHIS IS INVALID SQL;\n`,
);
const failing = new Database(path.join(scratch, 'failing.db'));
failing.pragma('foreign_keys = ON');
runMigrations(failing, dir19);
const rollbackCaseId = Number(failing.prepare(
  "INSERT INTO cases (name, procedure, status) VALUES ('迁移回滚示例案', '一审', 'active')"
).run().lastInsertRowid);
failing.prepare("INSERT INTO contacts (case_id, role, name) VALUES (?, '合作律师', '回滚对象')").run(rollbackCaseId);
assert.throws(() => runMigrations(failing, failingDir), /near "THIS"|syntax error/i);
assert.equal(failing.pragma('user_version', { simple: true }), 19);
assert.equal(failing.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='people'").get().count, 0);
assert.equal(failing.prepare('SELECT COUNT(*) AS count FROM contacts WHERE name=?').get('回滚对象').count, 1);
assert.equal(failing.pragma('integrity_check', { simple: true }), 'ok');
failing.close();

fs.rmSync(scratch, { recursive: true, force: true });
console.log('migration 020 tests: people/case participants backfill + share linkage + idempotent + atomic rollback passed');
