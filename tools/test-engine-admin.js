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

// 期间开始之日不计入（行诉法解释 §48）：统一次日起算；届满日遇休息日顺延
assert.equal(due('ad_sue_6m', '2026-03-01'), '2026-09-02'); // 起算日 03-02 + 6 个月
assert.equal(due('ad_sue_after_reconsideration_15d', '2026-03-01'), '2026-03-16');
assert.equal(due('ad_reconsideration_apply_60d', '2026-01-01'), '2026-03-02');
assert.equal(due('ad_defense_15d', '2026-06-01'), '2026-06-16');
assert.equal(due('ad_appeal_judgment_15d', '2026-06-01'), '2026-06-16');
assert.equal(due('ad_appeal_ruling_10d', '2026-06-01'), '2026-06-11');
assert.equal(due('ad_trial1_6m', '2026-01-15'), '2026-07-16');
assert.equal(due('ad_trial2_3m', '2026-01-15'), '2026-04-16');
assert.equal(due('ad_execution_2y', '2026-01-01'), '2028-01-03'); // 2028-01-02 周日 → 顺延周一
assert.equal(due('ad_sue_cap_other_5y', '2020-01-01'), '2025-01-02');
assert.equal(due('ad_agency_exec_apply_3m', '2026-03-01'), '2026-06-02');
// 复议「十日」为工作日（行政复议法 §88②）；引擎按自然日+顺延，结果只会更早（保守），此处锁定该近似
assert.equal(due('ad_reconsideration_reply_10d', '2026-09-28'), '2026-10-08');
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
assert.ok(derivedNames.includes('起诉期限（直接起诉）'), derivedNames);
const ruleIds = db.prepare('SELECT rule_id FROM deadlines WHERE case_id=?').all(caseId).map((r) => r.rule_id);
assert.ok(ruleIds.includes('ad_sue_6m'), ruleIds);
assert.ok(!ruleIds.includes('ad_sue_uninformed_1y'), 'manual_only 不得自动派生');
assert.ok(!ruleIds.includes('defense_period'), '民诉答辩期不得落入行政案');

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
