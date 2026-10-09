import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-precondition-')), 't.db');
const { db, withChangeContext } = await import('../src/db.js');
const { deriveForEvent } = await import('../src/lib/engine.js');
const { createEventRecord } = await import('../src/routes/records.js');
const { reconcilePrecondition, validatePrecondition } = await import('../src/routes/cases.js');
const { suggestPrecondition } = await import('../src/lib/precondition-suggest.js');

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

const pureYes = suggestPrecondition('admin_penalty_on_spot', { procedure: '行政一审', case_type: '行政', reconsideration_precondition: 'unknown' });
assert.equal(pureYes.suggest, 'yes');
assert.match(pureYes.reason, /§23①\(一\)/);
const pureNat = suggestPrecondition('admin_natural_resource_decision', { procedure: '行政一审', case_type: '行政', reconsideration_precondition: 'unknown' });
assert.equal(pureNat.suggest, 'yes');
const pureGov = suggestPrecondition('admin_gov_info_not_disclosed', { procedure: '行政一审', case_type: '行政', reconsideration_precondition: 'unknown' });
assert.equal(pureGov.suggest, 'yes');
assert.match(pureGov.reason, /§23①\(四\)|实施条例§31/);
assert.equal(suggestPrecondition('admin_penalty_on_spot', { procedure: '行政一审', reconsideration_precondition: 'yes' }), null, 'already yes → no suggest');
assert.equal(suggestPrecondition('admin_penalty_on_spot', { procedure: '一审', case_type: '民事', reconsideration_precondition: 'unknown' }), null);

const flip = suggestPrecondition('admin_duty_expressly_refused', { procedure: '行政一审', reconsideration_precondition: 'yes' });
assert.equal(flip.suggest, 'no');
assert.match(flip.reason, /实施条例§30②/);
const flip2 = suggestPrecondition('admin_duty_partially_performed', { procedure: '行政一审', reconsideration_precondition: 'unknown' });
assert.equal(flip2.suggest, 'no');
assert.equal(suggestPrecondition('admin_duty_expressly_refused', { procedure: '行政一审', reconsideration_precondition: 'no' }), null);

const spotId = db.prepare("INSERT INTO cases (name,procedure,stage,case_type) VALUES ('当场处罚案','行政一审','已立案','行政')").run().lastInsertRowid;
const spot = createEventRecord({ caseId: spotId, payload: { type: 'admin_penalty_on_spot', occurred_on: '2026-06-01' }, actor: 'test' });
assert.equal(spot.precondition_suggestion.suggest, 'yes');
assert.match(spot.precondition_suggestion.reason, /当场/);

const refuseId = db.prepare("INSERT INTO cases (name,procedure,stage,case_type,reconsideration_precondition) VALUES ('明示拒绝案','行政一审','已立案','行政','yes')").run().lastInsertRowid;
const refuse = createEventRecord({ caseId: refuseId, payload: { type: 'admin_duty_expressly_refused', occurred_on: '2026-07-01' }, actor: 'test' });
assert.equal(refuse.precondition_suggestion.suggest, 'no');

db.close();
console.log('PASS: reconsideration precondition + expanded §23 suggestions + §30② flip-to-no');
