// migration 029：开庭时刻/地点与顺延原日期，含 024 触发器逐列审计闸门。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'src', 'migrations');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-029-'));
const db = new Database(path.join(scratch, 'fixture.db'));
db.pragma('foreign_keys=ON');
const files = fs.readdirSync(dir).filter((f) => /^(00[1-9]|01[0-9]|02[0-8])_.*\.sql$/.test(f)).sort();
const fixtureDir = path.join(scratch, 'migrations');
fs.mkdirSync(fixtureDir);
for (const file of files) fs.copyFileSync(path.join(dir, file), path.join(fixtureDir, file));
process.env.DB_PATH = process.env.DB_PATH || path.join(scratch, 'guard.db');
const { runMigrations } = await import('../src/db.js');
runMigrations(db, fixtureDir);
const caseId = db.prepare("INSERT INTO cases (name,stage) VALUES ('张三案（029 fixture）','审理中')").run().lastInsertRowid;
const eventId = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?,'hearing','2099-11-03')").run(caseId).lastInsertRowid;
const rolled = db.prepare("INSERT INTO deadlines (case_id,name,due_on,calc_note) VALUES (?,'测试期限','2099-11-05','届满日 2099-11-05，顺延至 2099-11-07')").run(caseId).lastInsertRowid;
const ordinary = db.prepare("INSERT INTO deadlines (case_id,name,due_on,calc_note) VALUES (?,'普通期限','2099-11-06','届满日 2099-11-06')").run(caseId).lastInsertRowid;
const migDir = path.join(scratch, 'v29'); fs.cpSync(fixtureDir, migDir, { recursive: true }); fs.copyFileSync(path.join(dir, '029_event_time_location.sql'), path.join(migDir, '029_event_time_location.sql'));
runMigrations(db, migDir);
assert.equal(db.pragma('user_version', { simple: true }), 29);
assert.deepEqual(db.prepare('SELECT occurred_time,location FROM events WHERE id=?').get(eventId), { occurred_time: '', location: '' });
assert.equal(db.prepare('SELECT rolled_from FROM deadlines WHERE id=?').get(rolled).rolled_from, '2099-11-05');
assert.equal(db.prepare('SELECT rolled_from FROM deadlines WHERE id=?').get(ordinary).rolled_from, '');
const triggers = Object.fromEntries(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('trg_log_events_update','trg_log_deadlines_update')").all().map((r) => [r.name, r.sql]));
for (const [name, table] of [['trg_log_events_update','events'], ['trg_log_deadlines_update','deadlines']]) {
  const real = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name).filter((x) => x !== 'id' && x !== 'updated_at').sort();
  const listed = [...triggers[name].matchAll(/SELECT\s+'([A-Za-z_]+)'\s+AS field/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, real, `${table} trigger fields`);
}
db.prepare("UPDATE events SET occurred_time='09:30',location='第五法庭' WHERE id=?").run(eventId);
assert.deepEqual(db.prepare("SELECT field,new_value FROM change_log WHERE entity='event' AND entity_id=? ORDER BY id DESC LIMIT 2").all(eventId).map((r) => [r.field,r.new_value]).sort(), [['location','第五法庭'],['occurred_time','09:30']]);
db.prepare("UPDATE deadlines SET rolled_from='2099-11-04' WHERE id=?").run(ordinary);
assert.equal(db.prepare("SELECT field,new_value FROM change_log WHERE entity='deadline' AND entity_id=? ORDER BY id DESC LIMIT 1").get(ordinary).field, 'rolled_from');
db.close();
console.log('migration 029 ok');
