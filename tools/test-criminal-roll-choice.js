// 刑事期限节假日顺延选择：引擎、HTTP、重算、审计和民行隔离回归。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-criminal-roll-'));
process.env.DB_PATH = path.join(scratch, 'test.db');
process.env.ANJIAN_FILES_ROOT = '';
const { db } = await import('../src/db.js');
const { computeDue } = await import('../src/lib/engine.js');
const { deriveForEvent, recomputeForDeadline, recalcPreview, applyRecalc, enrichDeadlineRow } = await import('../src/lib/engine.js');
const records = (await import('../src/routes/records.js')).default;

function invoke(method, route, body) {
  return new Promise((resolve, reject) => {
    const req = { method, url: route, originalUrl: route, body, actor: 'test', params: {} };
    const res = {
      statusCode: 200,
      headersSent: false,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.headersSent = true; resolve({ status: this.statusCode, body: value }); return this; },
      end() { this.headersSent = true; resolve({ status: this.statusCode, body: null }); },
    };
    records.handle(req, res, (error) => error ? reject(error) : reject(new Error(`route not found: ${method} ${route}`)));
  });
}

try {
  const rule = { scope: 'criminal', unit: 'natural_days', days: 10, count_from: 'next_day', roll: 'none', basis: '测试' };
  const pure = computeDue(rule, { occurred_on: '2026-09-25' });
  assert.deepEqual(pure.holiday_roll_option, {
    applies: true,
    contains_holidays: ['2026-09-26', '2026-09-27', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'],
    default_due: '2026-10-05',
    rolled_due: '2026-10-08',
  });

  const caseId = db.prepare("INSERT INTO cases (name,procedure,stage) VALUES ('刑事顺延选择测试','刑事侦查','侦查中')").run().lastInsertRowid;
  const eventId = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?, 'lien_transferred', '2026-09-25')").run(caseId).lastInsertRowid;
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
  const derived = deriveForEvent(event, db.prepare('SELECT * FROM cases WHERE id=?').get(caseId), 'test').deadlines.find((d) => d.rule_id === 'cr_lien_conversion_10d');
  assert.ok(derived?.holiday_roll_option);
  assert.equal(derived.due_on, '2026-10-05');

  let deadline = enrichDeadlineRow(db.prepare('SELECT * FROM deadlines WHERE id=?').get(derived.id));
  assert.equal(deadline.criminal_roll_choice, null);
  assert.equal(deadline.holiday_roll_option.rolled_due, '2026-10-08');

  let response = await invoke('PATCH', `/deadlines/${deadline.id}`, { criminal_roll_choice: 'rolled' });
  assert.equal(response.status, 200);
  deadline = response.body;
  assert.equal(deadline.due_on, '2026-10-08');
  assert.match(deadline.calc_note, /按刑诉法§105顺延（用户选择）/);
  assert.equal(deadline.criminal_roll_choice, 'rolled');
  assert.ok(db.prepare("SELECT 1 FROM change_log WHERE entity='deadline' AND entity_id=? AND field='criminal_roll_choice' AND new_value='rolled'").get(deadline.id));

  response = await invoke('PATCH', `/deadlines/${deadline.id}`, { criminal_roll_choice: 'default' });
  assert.equal(response.status, 200);
  deadline = response.body;
  assert.equal(deadline.due_on, '2026-10-05');
  assert.doesNotMatch(deadline.calc_note, /按刑诉法§105顺延（用户选择）/);
  assert.equal(deadline.criminal_roll_choice, 'default');

  response = await invoke('PATCH', `/deadlines/${deadline.id}`, { criminal_roll_choice: null });
  assert.equal(response.status, 200);
  deadline = response.body;
  assert.equal(deadline.due_on, '2026-10-05');
  assert.equal(deadline.criminal_roll_choice, null);

  response = await invoke('PATCH', `/deadlines/${deadline.id}`, { criminal_roll_choice: 'rolled' });
  assert.equal(response.status, 200);
  deadline = response.body;
  const preview = recalcPreview(event, '2026-09-26');
  assert.equal(preview.recalc.find((item) => item.id === deadline.id).new_due, '2026-10-08');
  applyRecalc(preview, 'test');
  db.prepare("UPDATE events SET occurred_on='2026-09-26' WHERE id=?").run(event.id);
  deadline = enrichDeadlineRow(db.prepare('SELECT * FROM deadlines WHERE id=?').get(deadline.id));
  assert.equal(deadline.due_on, '2026-10-08');
  assert.equal(deadline.criminal_roll_choice, 'rolled');

  const infoCaseId = db.prepare("INSERT INTO cases (name,procedure,stage) VALUES ('刑事节假日信息测试','刑事侦查','侦查中')").run().lastInsertRowid;
  const infoEventId = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?, 'lien_transferred', '2026-09-20')").run(infoCaseId).lastInsertRowid;
  const infoEvent = db.prepare('SELECT * FROM events WHERE id=?').get(infoEventId);
  const infoDeadline = deriveForEvent(infoEvent, db.prepare('SELECT * FROM cases WHERE id=?').get(infoCaseId), 'test').deadlines.find((d) => d.rule_id === 'cr_lien_conversion_10d');
  assert.equal(infoDeadline.holiday_roll_option.default_due, '2026-09-30');
  assert.equal(infoDeadline.holiday_roll_option.rolled_due, '2026-09-30');
  response = await invoke('PATCH', `/deadlines/${infoDeadline.id}`, { criminal_roll_choice: 'rolled' });
  assert.equal(response.status, 400);

  const civilId = db.prepare("INSERT INTO cases (name,procedure,stage) VALUES ('民事无顺延选择测试','一审','一审')").run().lastInsertRowid;
  const civilEventId = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?, 'judgment_served', '2026-09-25')").run(civilId).lastInsertRowid;
  const civilEvent = db.prepare('SELECT * FROM events WHERE id=?').get(civilEventId);
  deriveForEvent(civilEvent, db.prepare('SELECT * FROM cases WHERE id=?').get(civilId), 'test');
  const civilDeadline = db.prepare('SELECT * FROM deadlines WHERE case_id=? ORDER BY id LIMIT 1').get(civilId);
  assert.equal(enrichDeadlineRow(civilDeadline).holiday_roll_option, null);
  response = await invoke('PATCH', `/deadlines/${civilDeadline.id}`, { criminal_roll_choice: 'rolled' });
  assert.equal(response.status, 400);

  console.log('PASS: criminal holiday roll option/default/rolled/revert/recompute/info-only/civil-isolation/audit');
} finally {
  db.close();
}
