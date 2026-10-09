import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseNotice, compareWithData } from '../src/lib/holiday-notice.js';
import { checkAllYears } from './update-holidays.js';
import { HOLIDAY_YEARS } from '../src/db.js';

const years = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
for (const year of years) {
  const doc = JSON.parse(fs.readFileSync(`rules/holidays-${year}.json`, 'utf8'));
  assert.equal(doc.schema_version, 2, `${year} schema_version`);
  assert.equal(doc.year, year, `${year} year`);
  assert.ok(Array.isArray(doc.source_urls) && doc.source_urls.length, `${year} source_urls`);
  assert.ok(doc.source_urls.every((url) => new URL(url).hostname.endsWith('gov.cn')), `${year} source_urls gov.cn`);
  assert.equal(doc.verified?.status, 'verified', `${year} verified`);
  assert.ok(doc.days.every((day) => ['holiday', 'workday'].includes(day.kind)), `${year} day kind`);
  assert.ok(doc.days.filter((day) => day.kind === 'workday').every((day) => [0, 6].includes(new Date(`${day.date}T00:00:00Z`).getUTCDay())), `${year} workdays must be weekend`);
  const parsed = parseNotice(fs.readFileSync(`rules/holiday-notices/${year}.txt`, 'utf8'), year);
  assert.deepEqual(compareWithData(parsed, doc), { ok: true, missingHolidays: [], extraHolidays: [], missingWorkdays: [], extraWorkdays: [] }, `${year} notice comparison`);
}

const all = checkAllYears();
assert.ok(all.every((row) => row.ok), 'update-holidays --check logic');
const d2026 = JSON.parse(fs.readFileSync('rules/holidays-2026.json', 'utf8'));
const d2020 = JSON.parse(fs.readFileSync('rules/holidays-2020.json', 'utf8'));
assert.deepEqual(d2026.days.filter((d) => d.date >= '2026-10-01' && d.date <= '2026-10-07').map((d) => d.kind), Array(7).fill('holiday'));
assert.equal(d2026.days.find((d) => d.date === '2026-10-10')?.kind, 'workday');
assert.equal(d2026.days.find((d) => d.date === '2026-09-20')?.kind, 'workday');
for (const date of ['2020-01-31', '2020-02-01', '2020-02-02']) assert.equal(d2020.days.find((d) => d.date === date)?.kind, 'holiday', `${date} extension`);
assert.equal(d2020.days.find((d) => d.date === '2020-02-01')?.kind, 'holiday');
assert.deepEqual([...HOLIDAY_YEARS].sort((a, b) => a - b), years);
assert.equal(JSON.parse(fs.readFileSync('rules/holidays-2023.json')).days.find((d) => d.date === '2022-12-31')?.kind, 'holiday');

console.log('holiday tests: 2020–2026 schema/parser/coverage 全过 ✅');
