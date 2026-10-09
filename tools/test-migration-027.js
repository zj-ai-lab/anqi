import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const migrationsDir = path.join(root, 'src', 'migrations');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-027-'));
const dir26 = path.join(scratch, 'v26');
const dir27 = path.join(scratch, 'v27');
fs.mkdirSync(dir26); fs.mkdirSync(dir27);
for (const file of fs.readdirSync(migrationsDir).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort()) {
  const n = Number(file.slice(0, 3));
  if (n <= 26) fs.copyFileSync(path.join(migrationsDir, file), path.join(dir26, file));
  if (n <= 27) fs.copyFileSync(path.join(migrationsDir, file), path.join(dir27, file));
}
if (!process.env.DB_PATH) process.env.DB_PATH = path.join(scratch, 'guard.db');
const { runMigrations, withChangeContext } = await import('../src/db.js');
const db = new Database(path.join(scratch, 'fixture.db'));
db.pragma('foreign_keys = ON');
runMigrations(db, dir26);
assert.equal(db.pragma('user_version', { simple: true }), 26);
const id = db.prepare("INSERT INTO cases (name,procedure,case_type) VALUES ('迁移027测试','行政一审','行政')").run().lastInsertRowid;
runMigrations(db, dir27);
assert.equal(db.pragma('user_version', { simple: true }), 27);
const c = db.prepare('SELECT reconsideration_precondition FROM cases WHERE id=?').get(id);
assert.equal(c.reconsideration_precondition, 'unknown');
const cols = db.prepare('PRAGMA table_info(deadlines)').all().map((row) => row.name);
assert.ok(cols.includes('advisory') && cols.includes('suppressed_reason'));
assert.throws(() => db.prepare("UPDATE cases SET reconsideration_precondition='bad' WHERE id=?").run(id), /CHECK constraint/);
withChangeContext({ actor: 'test' }, () => db.prepare("UPDATE cases SET reconsideration_precondition='yes' WHERE id=?").run(id));
assert.ok(db.prepare("SELECT 1 FROM change_log WHERE case_id=? AND field='reconsideration_precondition' AND new_value='yes'").get(id));
db.close();
console.log('PASS: migration 027 precondition/advisory columns, defaults, CHECK, audit trigger');
