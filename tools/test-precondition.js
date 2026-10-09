import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-precondition-')), 't.db');
const { db, withChangeContext } = await import('../src/db.js');
const { deriveForEvent } = await import('../src/lib/engine.js');
const { createEventRecord } = await import('../src/routes/records.js');
const { reconcilePrecondition, validatePrecondition } = await import('../src/routes/cases.js');

const id = db.prepare("INSERT INTO cases (name,procedure,stage,case_type) VALUES ('复议前置测试案','行政一审','已立案','行政')").run().lastInsertRowid;
let c = db.prepare('SELECT * FROM cases WHERE id=?').get(id);
const eventId = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?, 'admin_act_known', '2026-03-01')").run(id).lastInsertRowid;
const event = db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
let out = deriveForEvent(event, c, 'test');
assert.ok(out.deadlines.some((d) => d.rule_id === 'ad_sue_6m'));

withChangeContext({ actor: 'test' }, () => {
  db.prepare("UPDATE cases SET reconsideration_precondition='yes' WHERE id=?").run(id);
  reconcilePrecondition(id, 'yes', 'test');
});
assert.equal(db.prepare("SELECT COUNT(*) c FROM deadlines WHERE case_id=? AND rule_id='ad_sue_6m' AND status='pending'").get(id).c, 0);
assert.equal(db.prepare("SELECT suppressed_reason FROM deadlines WHERE case_id=? AND rule_id='ad_sue_6m'").get(id).suppressed_reason, '复议前置：须先复议，直接起诉期限不适用');

withChangeContext({ actor: 'test' }, () => {
  db.prepare("UPDATE cases SET reconsideration_precondition='no' WHERE id=?").run(id);
  reconcilePrecondition(id, 'no', 'test');
});
assert.equal(db.prepare("SELECT status FROM deadlines WHERE case_id=? AND rule_id='ad_sue_6m'").get(id).status, 'pending');
assert.ok(db.prepare("SELECT 1 FROM change_log WHERE case_id=? AND field='reconsideration_precondition' AND new_value='yes'").get(id));

const unknownId = db.prepare("INSERT INTO cases (name,procedure,stage,case_type) VALUES ('建议测试案','行政一审','已立案','行政')").run().lastInsertRowid;
const suggestion = createEventRecord({ caseId: unknownId, payload: { type: 'admin_duty_applied', occurred_on: '2026-08-01' }, actor: 'test' });
assert.equal(suggestion.precondition_suggestion.suggest, 'yes');
db.prepare("UPDATE cases SET reconsideration_precondition='no' WHERE id=?").run(unknownId);
const noSuggestion = createEventRecord({ caseId: unknownId, payload: { type: 'admin_duty_applied', occurred_on: '2026-08-02' }, actor: 'test' });
assert.equal(noSuggestion.precondition_suggestion, null);
assert.equal(validatePrecondition('yes'), true);
assert.equal(validatePrecondition('bad'), false);
assert.throws(() => db.prepare("UPDATE cases SET reconsideration_precondition='bad' WHERE id=?").run(id), /CHECK constraint/);
db.close();
console.log('PASS: reconsideration precondition suppression/restoration/audit/suggestion/validation');
