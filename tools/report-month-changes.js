// 生成 R4 月/年单位变更清单。只读规则文件和真实 deadline engine；旧值按
// 「事件日次日 + 月/年」旧逻辑独立模拟，供复核历史期限影响。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDays } from '../src/lib/dates.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = process.env.ROUND4_MONTH_REPORT || '/workspace/integration-notes/round4-month-changes.md';
if (!process.env.DB_PATH) process.env.DB_PATH = path.join(fs.mkdtempSync(path.join('/tmp', 'anqi-r4-report-')), 'report.db');
const { db } = await import('../src/db.js');
const { computeDue } = await import('../src/lib/engine.js');
const files = ['deadline_rules.json', 'deadline_rules_criminal.json', 'deadline_rules_complaint.json', 'deadline_rules_admin.json'];
const holiday = db.prepare('SELECT kind FROM holidays WHERE date=?');
const weekday = (value) => new Date(value + 'T00:00:00Z').getUTCDay();
const nonWorking = (value) => {
  const kind = holiday.get(value)?.kind;
  return kind ? kind === 'holiday' : [0, 6].includes(weekday(value));
};

function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

function oldDue(rule, eventDate) {
  const start = addDays(eventDate, 1);
  const amount = (rule.unit === 'years' ? rule.days * 12 : rule.days) * (rule.direction === 'before' ? -1 : 1);
  const raw = addMonths(start, amount);
  if (!rule.roll || rule.roll === 'none') return raw;
  const step = rule.roll === 'backward' ? -1 : 1;
  let due = raw;
  for (let i = 0; i < 15 && nonWorking(due); i++) due = addDays(due, step);
  return due;
}

const rows = [];
for (const file of files) {
  const rules = JSON.parse(fs.readFileSync(path.join(root, 'rules', file), 'utf8')).rules || [];
  for (const rule of rules.filter((r) => ['months', 'years'].includes(r.unit))) {
    const examples = ['2026-03-01', '2026-01-31'].map((occurred_on) => {
      const next = computeDue(rule, { occurred_on, service_method: '' }).due_on;
      return `${occurred_on}: ${oldDue(rule, occurred_on)} → ${next}`;
    });
    rows.push({ id: rule.id, file, unit: rule.unit, criminal: file === 'deadline_rules_criminal.json', examples });
  }
}

rows.sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id));
const lines = [
  '# Round 4 月/年期限变更清单',
  '',
  '旧值按「事件日次日起算后加月/年」模拟；新值由真实 `src/lib/engine.js` 计算。新值按民法典§202取到期月对应日，无对应日取月末，之后照常执行 rule.roll。',
  '',
  '| rule id | file | unit | 2026-03-01（old → new） | 2026-01-31（old → new） |',
  '|---|---|---|---|---|',
  ...rows.map((row) => `| ${row.id}${row.criminal ? ' ⚠️ 刑事' : ''} | ${row.file}${row.criminal ? ' ⚠️ 刑事' : ''} | ${row.unit} | ${row.examples[0]} | ${row.examples[1]} |`),
  '',
  `共 ${rows.length} 条；刑事规则以「⚠️ 刑事」标记。`,
];
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, lines.join('\n') + '\n');
console.log(`wrote ${output} (${rows.length} rules)`);
