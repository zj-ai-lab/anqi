import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { beijingToUtcIso, utcIsoToBeijing, planAutoReminders, reconcile, resolveReminderSettings } from '../src/lib/reminder-plan.js';

assert.equal(beijingToUtcIso('2099-11-02', '18:00'), '2099-11-02T10:00:00.000Z');
assert.deepEqual(utcIsoToBeijing('2099-11-03T23:30:00Z'), { date: '2099-11-04', time: '07:30' });
const settings = resolveReminderSettings([]);
const common = { case_id: 1, case_name: '张三案', case_status: 'active' };
const rows = planAutoReminders({
  hearings: [{ ...common, id: 1, type: 'hearing', occurred_on: '2099-11-03', occurred_time: '09:30', location: '第五法庭' }],
  deadlines: [{ ...common, id: 2, due_on: '2099-11-06', name: '上诉期（判决）', status: 'pending', review_status: 'confirmed', advisory: 0 }],
  tasks: [{ ...common, id: 3, due_on: '2099-11-03', due_time: '10:00', title: '提交证据', status: 'open' }],
  settings, nowIso: '2099-11-01T00:00:00.000Z', catchupMinutes: 60,
});
assert.equal(rows.find((r) => r.tier === 'hearing_eve').fire_at, '2099-11-02T10:00:00.000Z');
assert.equal(rows.find((r) => r.tier === 'hearing_day').fire_at, '2099-11-02T23:30:00.000Z');
assert.equal(rows.filter((r) => r.source_type === 'deadline').length, 2);
assert.equal(rows.filter((r) => r.source_type === 'task').length, 1);
const zeroDay = planAutoReminders({
  deadlines: [{ ...common, id: 6, due_on: '2099-11-06', name: '当天期限', status: 'pending', review_status: 'confirmed', advisory: 0 }],
  settings: { ...settings, remind_deadline_days_before: '0' },
  nowIso: '2099-11-01T00:00:00Z',
});
assert.deepEqual(zeroDay.filter((r) => r.source_type === 'deadline').map((r) => r.tier), ['deadline_day']);
assert.equal(planAutoReminders({ deadlines: [{ ...common, id: 4, due_on: '2099-11-06', name: '待核', status: 'pending', review_status: 'pending_review', advisory: 0 }], settings, nowIso: '2099-11-01T00:00:00Z' }).length, 0);
assert.equal(planAutoReminders({ tasks: [{ ...common, id: 5, due_on: '2099-11-03', due_time: '', title: '无时刻', status: 'open' }], settings, nowIso: '2099-11-01T00:00:00Z' }).length, 0);
const old = { id: 9, source_type: 'event', source_id: 1, tier: 'hearing_day', status: 'scheduled', version: 1, fire_at: rows.find((r) => r.tier === 'hearing_day').fire_at, title: '旧', body: '旧', source_fingerprint: 'old' };
assert.equal(reconcile([{ ...rows.find((r) => r.tier === 'hearing_day'), title: '新' }], [old]).update.length, 1);
assert.equal(reconcile([], [old]).cancel.length, 1);
assert.equal(reconcile([{ ...rows.find((r) => r.tier === 'hearing_day') }], [{ ...old, status: 'cancelled', source_fingerprint: rows.find((r) => r.tier === 'hearing_day').source_fingerprint }]).insert.length, 0);
assert.equal(reconcile([{ ...rows.find((r) => r.tier === 'hearing_day') }], [{ ...old, status: 'cancelled', status_reason: 'tier_disabled', source_fingerprint: rows.find((r) => r.tier === 'hearing_day').source_fingerprint }]).insert.length, 1);

const plannerUrl = pathToFileURL(path.resolve('src/lib/reminder-plan.js')).href;
const timezoneScript = `import { beijingToUtcIso, utcIsoToBeijing, planAutoReminders } from ${JSON.stringify(plannerUrl)};
const settings = { remind_enabled: 'true', remind_hearing_eve_time: '18:00', remind_hearing_day_time: '07:30', remind_deadline_days_before: '3', remind_deadline_time: '07:30', remind_task_minutes_before: '30' };
const hearings = [{ id: 1, case_id: 1, case_name: '张三案', case_status: 'active', occurred_on: '2099-11-03', occurred_time: '09:30', location: '第五法庭' }];
console.log(JSON.stringify({ eve: beijingToUtcIso('2099-11-02', '18:00'), local: utcIsoToBeijing('2099-11-03T23:30:00Z'), plan: planAutoReminders({ hearings, settings, nowIso: '2099-11-01T00:00:00.000Z' }).map((row) => row.fire_at) }));`;
function timezoneRun(tz) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', timezoneScript], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  assert.equal(result.status, 0, `${tz}: ${result.stderr}`);
  return result.stdout.trim();
}
const expectedTimezone = JSON.stringify({
  eve: beijingToUtcIso('2099-11-02', '18:00'),
  local: utcIsoToBeijing('2099-11-03T23:30:00Z'),
  plan: rows.filter((r) => r.source_type === 'event').map((r) => r.fire_at),
});
assert.equal(timezoneRun('UTC'), expectedTimezone);
assert.equal(timezoneRun('America/New_York'), expectedTimezone);
console.log('reminder plan: timezone, filters, tiers, catch-up, and reconciliation passed');
