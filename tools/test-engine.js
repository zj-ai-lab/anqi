// 期限引擎单元测试（期限=执业事故防线，必须有断言）。
// 用法：DB_PATH=$(mktemp -d)/t.db node tools/test-engine.js
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { computeDue, deriveForEvent, recalcPreview } from '../src/lib/engine.js';

// computeDue 断言（规则对象内联，字段与 rules/deadline_rules.json 对齐）；
// 真实规则表的存在性与派生由第 8 组端到端断言覆盖。
const R_APPEAL = {
  id: 'appeal_judgment', name: '上诉期（判决）', days: 15, unit: 'natural_days',
  count_from: 'next_day', roll: 'forward', basis: '民诉法 §171',
};
const R_RULING = {
  id: 'appeal_ruling', name: '上诉期（裁定）', days: 10, unit: 'natural_days',
  count_from: 'next_day', roll: 'forward', basis: '民诉法 §171',
};
const R_RETRIAL = {
  id: 'retrial', name: '申请再审期', days: 6, unit: 'months',
  count_from: 'same_day', roll: 'forward', basis: '民诉法 §216',
};
const R_EXEC = {
  id: 'exec', name: '申请执行期', days: 2, unit: 'years',
  count_from: 'next_day', roll: 'forward', basis: '民诉法',
};
const R_DEFENSE_PUBLIC = {
  id: 'defense', name: '答辩期', days: 15, unit: 'natural_days',
  count_from: 'next_day', roll: 'forward', basis: '民诉法 §128',
  service_modifiers: { 公告送达: { prepend_days: 30, note: '公告 30 日视为送达' } },
};

// 1) 常规：2026-07-10 送达 → 次日起算 15 日 = 07-25（周六）→ 顺延至 07-27（周一）
let r = computeDue(R_APPEAL, { occurred_on: '2026-07-10', service_method: '' });
assert.equal(r.due_on, '2026-07-27', `周末顺延: ${r.due_on}`);

// 2) 届满落在春节假期内：2026-02-05 + 15 = 02-20（假）→ 顺延至 02-24（周二）
r = computeDue(R_APPEAL, { occurred_on: '2026-02-05', service_method: '' });
assert.equal(r.due_on, '2026-02-24', `春节顺延: ${r.due_on}`);

// 3) 调休补班日不顺延：2026-02-18 + 10 = 02-28（周六但补班）→ 就是 02-28
r = computeDue(R_RULING, { occurred_on: '2026-02-18', service_method: '' });
assert.equal(r.due_on, '2026-02-28', `补班日应视为工作日: ${r.due_on}`);

// 4) 工作日不顺延：2026-02-10 + 15 = 02-25（周三）
r = computeDue(R_APPEAL, { occurred_on: '2026-02-10', service_method: '' });
assert.equal(r.due_on, '2026-02-25', `工作日: ${r.due_on}`);

// 5) 月单位 + 月末钳制：2026-03-31 + 6 个月 → 2026-09-30（工作日）
r = computeDue(R_RETRIAL, { occurred_on: '2026-03-31', service_method: '' });
assert.equal(r.due_on, '2026-09-30', `月加法: ${r.due_on}`);

// 6) 年单位 + 未覆盖年份告警：2026-06-30 + 2 年 → 2028-06-30，coverage_warning=true
r = computeDue(R_EXEC, { occurred_on: '2026-06-30', service_method: '' });
assert.equal(r.due_on.slice(0, 4), '2028');
assert.equal(r.coverage_warning, true, '2028 未覆盖应告警');
assert.ok(r.calc_note.includes('未覆盖'), 'calc_note 应含未覆盖提示');

// 7) 公告送达修饰：2026-01-05 公告 → 基准推至 02-04，+15 = 02-19（春节假）→ 顺延 02-24
r = computeDue(R_DEFENSE_PUBLIC, { occurred_on: '2026-01-05', service_method: '公告送达' });
assert.equal(r.due_on, '2026-02-24', `公告送达: ${r.due_on}`);
assert.ok(r.calc_note.includes('公告'), 'calc_note 应含公告说明');

// 8) 端到端：真实规则表 deriveForEvent + 幂等 + court_specified 任务 + 级联预览保护
const caseId = db.prepare("INSERT INTO cases (name, procedure, stage) VALUES ('引擎测试案', '一审', '待裁判')").run().lastInsertRowid;
const evId = db.prepare("INSERT INTO events (case_id, type, occurred_on) VALUES (?, 'judgment_served', '2026-07-10')").run(caseId).lastInsertRowid;
const caseRow = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(evId);

let derived = deriveForEvent(ev, caseRow, 'test');
assert.equal(derived.deadlines.length, 1, '判决送达应派生 1 条上诉期');
assert.equal(derived.deadlines[0].due_on, '2026-07-27');
derived = deriveForEvent(ev, caseRow, 'test');
assert.equal(derived.deadlines.length, 0, '幂等：重复派生应为 0');

const evNotice = db.prepare("INSERT INTO events (case_id, type, occurred_on) VALUES (?, 'evidence_notice', '2026-07-01')").run(caseId).lastInsertRowid;
const en = db.prepare('SELECT * FROM events WHERE id = ?').get(evNotice);
derived = deriveForEvent(en, caseRow, 'test');
assert.equal(derived.tasks.length, 1, '举证通知应铺 1 条录入任务');
assert.equal(derived.deadlines.length, 0, 'court_specified 不直接生成期限');

// 级联预览：人工覆盖的排除
const dlId = db.prepare('SELECT id FROM deadlines WHERE trigger_event_id = ?').get(evId).id;
let pv = recalcPreview(ev, '2026-07-15');
assert.equal(pv.recalc.length, 1);
assert.equal(pv.recalc[0].new_due, '2026-07-30', `重算: ${pv.recalc[0].new_due}`);
db.prepare('UPDATE deadlines SET is_manual_override = 1 WHERE id = ?').run(dlId);
pv = recalcPreview(ev, '2026-07-15');
assert.equal(pv.recalc.length, 0, '人工覆盖后应被排除');
assert.equal(pv.excluded.length, 1);

console.log('engine tests: 8 组断言全过 ✅');
