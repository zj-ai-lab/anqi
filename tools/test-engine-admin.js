// 行政诉讼 / 行政复议期限规则：隔离、派生与日历算法抽检。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-admin-engine-')), 't.db');
process.env.ANJIAN_FILES_ROOT = '';

const { db } = await import('../src/db.js');
const { deriveForEvent, computeDue, ruleMatches } = await import('../src/lib/engine.js');
const { ADMIN_PROCEDURES, isAdminProcedure } = await import('../src/lib/deadline-core.js');
const rules = JSON.parse(fs.readFileSync(new URL('../rules/deadline_rules_admin.json', import.meta.url), 'utf8')).rules;
const byId = Object.fromEntries(rules.map((r) => [r.id, r]));

assert.ok(ADMIN_PROCEDURES.has('行政一审'));
assert.equal(isAdminProcedure('行政一审'), true);
assert.equal(isAdminProcedure('一审'), false);
assert.equal(ruleMatches(byId.ad_sue_6m, { procedure: '行政一审' }), true);
assert.equal(ruleMatches(byId.ad_sue_6m, { procedure: '一审' }), false);
assert.equal(ruleMatches({ id: 'x', scope: 'civil', trigger: 'served' }, { procedure: '行政一审' }), false);
// 无 applies_procedure 的民诉兜底不得进行政
assert.equal(ruleMatches({ id: 'fee', trigger: 'fee_notice', kind: 'court_specified' }, { procedure: '行政一审' }), false);

function due(ruleId, occurred_on, extra = {}) {
  const { due_on } = computeDue(byId[ruleId], { occurred_on, service_method: '', ...extra });
  return due_on;
}

// 日/工作日单位期间开始之日不计入（行诉法解释 §48）；月/年单位按民法典§202取对应日。
assert.equal(due('ad_sue_6m', '2026-03-01'), '2026-09-01'); // R4: month = corresponding day (民法典§202)
assert.equal(due('ad_sue_after_reconsideration_15d', '2026-03-01'), '2026-03-16');
assert.equal(due('ad_reconsideration_apply_60d', '2026-01-01'), '2026-03-02');
assert.equal(due('ad_defense_15d', '2026-06-01'), '2026-06-16');
assert.equal(due('ad_appeal_judgment_15d', '2026-06-01'), '2026-06-16');
assert.equal(due('ad_appeal_ruling_10d', '2026-06-01'), '2026-06-11');
assert.equal(due('ad_trial1_6m', '2026-01-15'), '2026-07-15'); // R4: month = corresponding day (民法典§202)
assert.equal(due('ad_trial2_3m', '2026-01-15'), '2026-04-15'); // R4: month = corresponding day (民法典§202)
// 申请执行期限三种起算点（行诉法解释 §153②）：各自独立事件触发
assert.equal(byId.ad_execution_2y, undefined, '旧的「生效即起算」执行规则已拆分');
assert.equal(byId.ad_execution_2y_term_end.trigger, 'performance_period_ended');
assert.equal(byId.ad_execution_2y_installment.trigger, 'installment_period_ended');
assert.equal(byId.ad_execution_2y_no_term.trigger, 'no_term_document_served');
assert.equal(due('ad_execution_2y_term_end', '2026-01-01'), '2028-01-03'); // 2028-01-02 周日 → 顺延周一（2028 无数据，告警见下）
assert.equal(due('ad_execution_2y_installment', '2026-03-31'), '2028-03-31'); // R4: year = corresponding day (民法典§202)
assert.equal(due('ad_execution_2y_no_term', '2026-06-10'), '2028-06-12'); // 06-11 周日 → 06-12
assert.equal(computeDue(byId.ad_execution_2y_term_end, { occurred_on: '2026-01-01', service_method: '' }).coverage_warning, true, '2028 年无节假日数据须告警');
// 不履行法定职责：两个月等待 + 履职期限届满后六个月（行诉法§47①、解释§66、法释〔2026〕3号§7）
assert.equal(byId.ad_sue_after_duty_6m.trigger, 'admin_duty_period_expired');
assert.equal(byId.ad_sue_after_duty_6m.days, 6);
assert.equal(byId.ad_sue_after_duty_6m.unit, 'months');
assert.equal(due('ad_duty_wait_2m', '2026-08-01'), '2026-10-08'); // R4: month = corresponding day (民法典§202)：08-01 + 2 个月 = 10-01，国庆 → 顺延 10-08
assert.equal(due('ad_sue_after_duty_6m', '2026-03-02'), '2026-09-02'); // R4: month = corresponding day (民法典§202)
assert.equal(due('ad_reconsideration_duty_wait_60d', '2026-08-01'), '2026-09-30');
assert.equal(due('ad_reconsideration_after_duty_60d', '2026-03-02'), '2026-05-06'); // 05-01 劳动节 → 05-06
assert.equal(due('ad_sue_after_reconsideration_timeout_15d', '2026-09-20'), '2026-10-08'); // 10-05 国庆 → 10-08
assert.equal(due('ad_sue_cap_other_5y', '2020-01-01'), '2025-01-02'); // R4: year = corresponding day (民法典§202)，对应日元旦后按 roll 顺延
assert.equal(due('ad_agency_exec_apply_3m', '2026-03-01'), '2026-06-01'); // R4: month = corresponding day (民法典§202)
// 复议「三日、五日、七日、十日」为工作日（行政复议法 §88②）：逐个工作日计数，跳过国庆、计入 10-10 调休周六
const wdRules = rules.filter((r) => r.unit === 'workdays').map((r) => r.id).sort();
assert.deepEqual(wdRules, ['ad_reconsideration_accept_review_5wd', 'ad_reconsideration_copy_7wd', 'ad_reconsideration_copy_simple_3wd',
  'ad_reconsideration_reply_10d', 'ad_reconsideration_reply_simple_5wd', 'ad_reconsideration_supplement_10wd',
  'ad_sg_escalation_transfer_5wd', 'ad_sg_hearing_notice_5wd', 'ad_sg_norm_review_notice_3wd',
  'ad_sg_norm_review_transfer_7wd', 'ad_sg_self_correction_5wd', 'ad_sg_supplement_notice_5wd',
  'ad_sg_transfer_via_agency_5wd']);
assert.ok(rules.every((r) => !r._engine_approx), '不得再有工作日近似');
assert.equal(due('ad_reconsideration_reply_10d', '2026-09-28'), '2026-10-16');
assert.equal(due('ad_reconsideration_reply_simple_5wd', '2026-09-28'), '2026-10-10'); // 09-29,09-30,10-08,10-09,10-10(调休六)
assert.equal(due('ad_reconsideration_accept_review_5wd', '2026-09-30'), '2026-10-13'); // 10-08,10-09,10-10(调休六),10-12,10-13
assert.equal(due('ad_reconsideration_copy_7wd', '2026-02-12'), '2026-02-28'); // 02-13,02-14(调休六),02-24,25,26,27,02-28(调休六)
assert.equal(due('ad_reconsideration_supplement_10wd', '2026-04-30'), '2026-05-18'); // 05-01..05 假；05-06,07,08,09(调休六),11,12,13,14,15,18
assert.equal(due('ad_reconsideration_copy_simple_3wd', '2026-06-18'), '2026-06-24'); // 06-19 端午，06-22,23,24
// 复议期间涉及 2027：须告警
assert.ok(/节假日数据缺 2027/.test(computeDue(byId.ad_reconsideration_reply_10d, { occurred_on: '2026-12-28', service_method: '' }).calc_note));
assert.equal(due('ad_reconsideration_decide_60d', '2026-08-01'), '2026-09-30');
// 规则表自检：id 唯一、scope=admin、manual_only 规则不在可自动派生集合
assert.equal(new Set(rules.map((r) => r.id)).size, rules.length, 'id 必须唯一');
assert.ok(rules.every((r) => r.scope === 'admin'), '全部规则须 scope=admin');
assert.ok(rules.every((r) => (r.applies_procedure || []).every((p) => ADMIN_PROCEDURES.has(p))), 'applies_procedure 只能是行政程序');
assert.ok(rules.every((r) => /§\d+/.test(r.basis)), '每条 basis 须带条号');

const caseId = db.prepare(
  "INSERT INTO cases (name, procedure, stage, case_type, status) VALUES ('虚构行政案','行政一审','已立案','行政','active')"
).run().lastInsertRowid;
const caseRow = db.prepare('SELECT * FROM cases WHERE id=?').get(caseId);
const ev = db.prepare(
  "INSERT INTO events (case_id, type, occurred_on) VALUES (?, 'admin_act_known', '2026-03-01')"
).run(caseId);
const event = db.prepare('SELECT * FROM events WHERE id=?').get(ev.lastInsertRowid);
const out = deriveForEvent(event, caseRow, 'test');
const derivedNames = out.deadlines.map((d) => d.name);
assert.ok(derivedNames.includes('起诉期限（直接起诉，6 个月）'), derivedNames);
const ruleIds = db.prepare('SELECT rule_id FROM deadlines WHERE case_id=?').all(caseId).map((r) => r.rule_id);
assert.ok(ruleIds.includes('ad_sue_6m'), ruleIds);
assert.ok(!ruleIds.includes('ad_sue_uninformed_1y'), 'manual_only 不得自动派生');
assert.ok(!ruleIds.includes('defense_period'), '民诉答辩期不得落入行政案');
// 履职申请：铺 2 月等待 + 「核对履职期限届满日」任务；6 个月起诉期限不再由申请日直接派生
const ev3 = db.prepare("INSERT INTO events (case_id, type, occurred_on) VALUES (?, 'admin_duty_applied', '2026-08-01')").run(caseId);
const out3 = deriveForEvent(db.prepare('SELECT * FROM events WHERE id=?').get(ev3.lastInsertRowid), caseRow, 'test');
assert.ok(out3.deadlines.some((d) => d.rule_id === 'ad_duty_wait_2m' && d.due_on === '2026-10-08'), JSON.stringify(out3.deadlines));
assert.ok(!out3.deadlines.some((d) => d.rule_id === 'ad_sue_after_duty_6m'));
assert.ok((out3.tasks || []).length >= 1, '应铺履职期限核对任务');
const ev4 = db.prepare("INSERT INTO events (case_id, type, occurred_on) VALUES (?, 'admin_duty_period_expired', '2026-10-08')").run(caseId);
const out4 = deriveForEvent(db.prepare('SELECT * FROM events WHERE id=?').get(ev4.lastInsertRowid), caseRow, 'test');
assert.ok(out4.deadlines.some((d) => d.rule_id === 'ad_sue_after_duty_6m' && d.due_on === '2027-04-08' && d.coverage_warning), JSON.stringify(out4.deadlines)); // R4: month = corresponding day (民法典§202)

const civilId = db.prepare(
  "INSERT INTO cases (name, procedure, stage, case_type, status) VALUES ('虚构民案','一审','已立案','民事','active')"
).run().lastInsertRowid;
const civil = db.prepare('SELECT * FROM cases WHERE id=?').get(civilId);
const ev2 = db.prepare(
  "INSERT INTO events (case_id, type, occurred_on) VALUES (?, 'admin_act_known', '2026-03-01')"
).run(civilId);
const out2 = deriveForEvent(db.prepare('SELECT * FROM events WHERE id=?').get(ev2.lastInsertRowid), civil, 'test');
assert.equal(out2.deadlines.length, 0, '行政触发在民案上不应派生');

db.close();
console.log(`PASS: admin engine isolation + ${rules.length} rules calendar spot-checks`);
