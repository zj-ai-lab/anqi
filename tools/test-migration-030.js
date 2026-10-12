import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-m030-'));
const file = path.join(dir, 'test.db');
const db = new Database(file);
db.pragma('foreign_keys = ON');
runMigrations(db);
assert.equal(db.pragma('user_version', { simple: true }), 30);
for (const table of ['reminders', 'reminder_deliveries']) {
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}
for (const index of ['idx_reminders_auto_key', 'idx_reminders_due', 'idx_reminders_case', 'idx_deliveries_queue']) {
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(index));
}
const now = new Date().toISOString();
const caseId = db.prepare("INSERT INTO cases (name) VALUES ('张三案')").run().lastInsertRowid;
const ins = db.prepare(`INSERT INTO reminders (origin,source_type,source_id,tier,case_id,title,fire_at,created_at,updated_at) VALUES ('auto','event',1,'hearing_day',?,'x','2099-01-01T00:00:00Z',?,?)`);
ins.run(caseId, now, now);
assert.throws(() => ins.run(caseId, now, now), /UNIQUE/);
db.prepare("UPDATE reminders SET status='cancelled' WHERE id=1").run();
ins.run(caseId, now, now);
const delivery = db.prepare(`INSERT INTO reminder_deliveries (reminder_id,reminder_version,channel,delivery_key,status,attempted_at,updated_at) VALUES (2,1,'inapp','2:1:inapp','queued',?,?)`);
delivery.run(now, now);
assert.throws(() => delivery.run(now, now), /UNIQUE/);
console.log('migration 030: tables, indexes, partial unique identity, and delivery key uniqueness passed');
db.close();
fs.rmSync(dir, { recursive: true, force: true });
