import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { computeDue, recomputeForDeadline } from '../src/lib/engine.js';

const workdayRule = (days, extra = {}) => ({ unit: 'workdays', days, count_from: 'next_day', roll: 'none', basis: '测试工作日', ...extra });

// 2026-09-28 次日起算：09-29/30(1/2)，10-01…07 法定假日跳过，10-08/09(3/4)，
// 10-10 周六调休上班计入(5)，10-11 周日跳过，10-12…16(6…10) → 10-16。
let result = computeDue(workdayRule(10), { occurred_on: '2026-09-28' });
assert.equal(result.due_on, '2026-10-16');
assert.match(result.calc_note, /10-10/);
assert.match(result.calc_note, /法定节假日/);

// 2026-02-12 后：02-13(1)、02-14 周六调休(2)、02-15…23 假期、02-24(3)、
// 02-25(4)、02-26(5) → 02-26。
result = computeDue(workdayRule(5), { occurred_on: '2026-02-12' });
assert.equal(result.due_on, '2026-02-26');

result = computeDue({ unit: 'natural_days', days: 15, count_from: 'next_day', roll: 'forward', basis: '测试' }, { occurred_on: '2026-09-16' });
assert.equal(result.due_on, '2026-10-08');
result = computeDue({ unit: 'natural_days', days: 10, count_from: 'next_day', roll: 'forward', basis: '测试' }, { occurred_on: '2026-09-30' });
assert.equal(result.due_on, '2026-10-10');
result = computeDue({ unit: 'natural_days', days: 15, count_from: 'next_day', roll: 'forward', basis: '测试' }, { occurred_on: '2026-09-05' });
assert.equal(result.due_on, '2026-09-20');
result = computeDue({ unit: 'natural_days', days: 10, count_from: 'next_day', roll: 'forward', basis: '测试' }, { occurred_on: '2020-01-21' });
assert.equal(result.due_on, '2020-02-03');

result = computeDue(workdayRule(10), { occurred_on: '2026-12-28' });
assert.equal(result.coverage_warning, true);
assert.deepEqual(result.coverage_missing_years, [2027]);
assert.match(result.calc_note, /节假日数据缺 2027 年/);
result = computeDue({ unit: 'natural_days', days: 30, count_from: 'next_day', roll: 'forward', basis: '测试' }, { occurred_on: '2027-03-01' });
assert.equal(result.coverage_warning, true);
result = computeDue({ unit: 'natural_days', days: 5, count_from: 'next_day', roll: 'none', basis: '测试' }, { occurred_on: '2026-12-20' });
assert.equal(result.coverage_warning, false);

// 2026-10-12 前推：10-11 跳过，10-10(1)、10-09(2)、10-08(3)，10-07…01 假期，
// 09-30(4)、09-29(5) → 2026-09-29。
result = computeDue({ ...workdayRule(5), direction: 'before' }, { occurred_on: '2026-10-12' });
assert.equal(result.due_on, '2026-09-29');

const caseId = db.prepare("INSERT INTO cases (name, procedure, stage) VALUES ('工作日手调测试', '刑事侦查', '')").run().lastInsertRowid;
const eventId = db.prepare("INSERT INTO events (case_id, type, occurred_on) VALUES (?, 'detained', '2026-09-28')").run(caseId).lastInsertRowid;
result = recomputeForDeadline({ rule_id: 'cr_detention_cap_37', trigger_event_id: eventId, manual_days: 5, manual_unit: 'workdays', manual_count_from: 'next_day', manual_roll: 'none' });
assert.equal(result.due_on, '2026-10-10');
assert.equal(result.coverage_warning, false);

console.log('engine workdays tests: 工作日/顺延/覆盖告警/手调重算全过 ✅');
