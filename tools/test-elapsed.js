import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-elapsed-')), 't.db');
const { db } = await import('../src/db.js');
const { computeElapsed } = await import('../src/lib/elapsed.js');
const { deriveForEvent } = await import('../src/lib/engine.js');

const adminId = db.prepare("INSERT INTO cases (name,procedure,case_type) VALUES ('经过时间行政案','行政一审','行政')").run().lastInsertRowid;
const civilId = db.prepare("INSERT INTO cases (name,procedure,case_type) VALUES ('经过时间民案','一审','民事')").run().lastInsertRowid;
const eventId = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?, 'admin_duty_applied', '2026-01-31')").run(adminId).lastInsertRowid;
const event = db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
const admin = db.prepare('SELECT * FROM cases WHERE id=?').get(adminId);
const elapsed = computeElapsed(admin, '2026-07-31');
assert.equal(elapsed.length, 1);
assert.equal(elapsed[0].elapsed_days, 181);
assert.equal(elapsed[0].elapsed_text, '已过 6 个月 0 天');
assert.equal(elapsed[0].reminders[0].due_on, '2026-07-31', '01-31 + 6 months clamps to 07-31'); // R4: month = corresponding day (民法典§202)
assert.equal(elapsed[0].reminders[0].reached, true);
assert.equal(elapsed[0].reminders[1].reached, false);
assert.match(elapsed[0].event_label, /履行法定职责/);

const civilEventId = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?, 'admin_duty_applied', '2026-01-31')").run(civilId).lastInsertRowid;
assert.deepEqual(computeElapsed(civilId, '2026-07-31'), [], 'civil case must not receive admin reminder');
const derived = deriveForEvent(event, admin, 'test');
assert.equal(db.prepare("SELECT COUNT(*) c FROM deadlines WHERE trigger_event_id=? AND rule_id='ad_duty_inaction_elapsed_reminder'").get(eventId).c, 0);
assert.equal(db.prepare('SELECT COUNT(*) c FROM deadlines WHERE trigger_event_id=?').get(civilEventId).c, 0);
assert.equal(derived.deadlines.some((d) => d.rule_id === 'ad_duty_inaction_elapsed_reminder'), false);
db.close();
console.log('PASS: elapsed reminder text/boundary/reached/gating/no-deadline');
