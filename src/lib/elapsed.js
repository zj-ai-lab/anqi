// 经过时间提醒：只读计算，不创建 deadlines/tasks，也不调用 deadline-core.computeDue。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import { addDays, diffDays, todayCN } from './dates.js';
import { eventLabel } from './vocab.js';
import { ruleMatches } from './deadline-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_DIR = path.join(__dirname, '..', '..', 'rules');
const RULE_FILES = [
  'deadline_rules.json',
  'deadline_rules_criminal.json',
  'deadline_rules_complaint.json',
  'deadline_rules_admin.json',
];

function loadRules() {
  return RULE_FILES.flatMap((file) => {
    const full = path.join(RULES_DIR, file);
    if (!fs.existsSync(full)) return [];
    return JSON.parse(fs.readFileSync(full, 'utf8')).rules || [];
  });
}

function addMonths(dateStr, n) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

function intervalDue(occurredOn, interval) {
  if (Number.isInteger(interval.days)) return addDays(occurredOn, interval.days);
  if (Number.isInteger(interval.months)) return addMonths(occurredOn, interval.months);
  if (Number.isInteger(interval.years)) return addMonths(occurredOn, interval.years * 12);
  throw new Error('elapsed_reminder interval 必须包含 days/months/years 之一');
}

function elapsedCalendar(occurredOn, today) {
  const elapsedDays = diffDays(occurredOn, today);
  if (elapsedDays <= 0) return { years: 0, months: 0, days: elapsedDays };
  let years = 0;
  while (addMonths(occurredOn, (years + 1) * 12) <= today) years++;
  let months = 0;
  while (addMonths(occurredOn, years * 12 + months + 1) <= today) months++;
  const anchor = addMonths(occurredOn, years * 12 + months);
  return { years, months, days: diffDays(anchor, today) };
}

function elapsedText(occurredOn, today) {
  const span = elapsedCalendar(occurredOn, today);
  if (span.years > 0) return `已过 ${span.years} 年 ${span.months} 个月`;
  if (span.months > 0) return `已过 ${span.months} 个月 ${span.days} 天`;
  return `已过 ${Math.max(0, span.days)} 天`;
}

export function computeElapsed(caseIdOrRow, today = todayCN()) {
  const caseRow = typeof caseIdOrRow === 'object'
    ? caseIdOrRow
    : db.prepare('SELECT * FROM cases WHERE id=?').get(caseIdOrRow);
  if (!caseRow) return [];
  const events = db.prepare('SELECT * FROM events WHERE case_id=? ORDER BY occurred_on,id').all(caseRow.id);
  const rules = loadRules().filter((rule) => rule.kind === 'elapsed_reminder');
  const output = [];
  for (const event of events) {
    for (const rule of rules) {
      if (rule.trigger !== event.type || !ruleMatches(rule, caseRow)) continue;
      const reminders = (rule.intervals || []).map((interval) => {
        const dueOn = intervalDue(event.occurred_on, interval);
        const parts = [];
        if (interval.years != null) parts.push(`${interval.years} 年`);
        if (interval.months != null) parts.push(`${interval.months} 个月`);
        if (interval.days != null) parts.push(`${interval.days} 天`);
        return {
          label: interval.label || parts.join(''),
          due_on: dueOn,
          reached: today >= dueOn,
        };
      });
      output.push({
        event_id: event.id,
        event_type: event.type,
        event_label: eventLabel[event.type] || event.type,
        occurred_on: event.occurred_on,
        rule_id: rule.id,
        rule_name: rule.name,
        elapsed_days: diffDays(event.occurred_on, today),
        elapsed_text: elapsedText(event.occurred_on, today),
        reminders,
        basis: rule.basis,
      });
    }
  }
  return output;
}

export { addMonths as addElapsedMonths, elapsedText };
