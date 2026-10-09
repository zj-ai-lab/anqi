import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseNotice, compareWithData } from '../src/lib/holiday-notice.js';
import { checkAllYears, mirrorDays, officialSections } from './update-holidays.js';
import { HOLIDAY_YEARS } from '../src/db.js';

const years = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
const fixture2025 = `
<header>一、页面导航：2024年11月12日</header>
<aside>侧栏：一、不要解析这里的日期 2024年11月12日</aside>
<div id="UCAP-CONTENT">
  <p><strong>一、元旦：</strong>1月1日（周三）放假1天，不调休。</p>
  <p><strong>二、春节：</strong>1月28日（农历除夕、周二）至2月4日（农历正月初七、周二）放假调休，共8天。1月26日（周日）、2月8日（周六）上班。</p>
  <p><strong>三、清明节：</strong>4月4日（周五）至6日（周日）放假，共3天。</p>
  <p><strong>四、劳动节：</strong>5月1日（周四）至5日（周一）放假调休，共5天。4月27日（周日）上班。</p>
  <p><strong>五、端午节：</strong>5月31日（周六）至6月2日（周一）放假，共3天。</p>
  <p><strong>六、国庆节、中秋节：</strong>10月1日（周三）至8日（周三）放假调休，共8天。9月28日（周日）、10月11日（周六）上班。</p>
</div>
<footer><p><strong>一、元旦：</strong>2024年11月12日放假。</p></footer>`;
const fixture2025Doc = JSON.parse(fs.readFileSync('rules/holidays-2025.json', 'utf8'));
assert.equal(compareWithData(parseNotice(officialSections(fixture2025), 2025), fixture2025Doc).ok, true, 'official HTML extraction 2025');

const mirrorFixture2025 = [
  { name: '元旦', date: '2025-01-01', isOffDay: true },
  { name: '春节', date: '2025-01-26', isOffDay: false },
  { name: '春节', date: '2025-01-28', isOffDay: true },
  { name: '春节', date: '2025-02-08', isOffDay: false },
];
assert.deepEqual(mirrorDays(mirrorFixture2025).map(({ date, kind }) => ({ date, kind })), [
  { date: '2025-01-01', kind: 'holiday' },
  { date: '2025-01-26', kind: 'workday' },
  { date: '2025-01-28', kind: 'holiday' },
  { date: '2025-02-08', kind: 'workday' },
], 'mirror isOffDay mapping');
const mirrorDoc2025 = {
  days: fixture2025Doc.days.map(({ date, kind, name }) => ({ date, name, isOffDay: kind === 'holiday' })),
};
const notice2025 = parseNotice(fs.readFileSync('rules/holiday-notices/2025.txt', 'utf8'), 2025);
assert.equal(compareWithData(notice2025, { days: mirrorDays(mirrorDoc2025) }).ok, true, 'mirror-shaped 2025 comparison');

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
