// 国务院办公厅节假日通知解析。这里只读通知原文，不访问数据库或网络。
const SECTION_RE = /(?:^|\n)\s*([一二三四五六七八九十]+)、\s*([\s\S]*?)(?=\n\s*[一二三四五六七八九十]+、|$)/g;
const DATE_RE = /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/g;
const RANGE_RE = /((?:(?:\d{4})年)?\d{1,2}月\d{1,2}日)(?:（[^）]*）)?\s*至\s*((?:(?:\d{4})年)?(?:(?:\d{1,2})月)?\d{1,2}日)(?:（[^）]*）)?/g;

function isoDate(year, month, day) {
  const value = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (value.getUTCFullYear() !== Number(year) || value.getUTCMonth() !== Number(month) - 1 || value.getUTCDate() !== Number(day)) return null;
  return value.toISOString().slice(0, 10);
}

function weekday(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function parseDateToken(token, year, fallback = {}) {
  const match = /(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})日/.exec(token);
  if (!match) return null;
  const y = Number(match[1] || year || fallback.year);
  const m = Number(match[2] || fallback.month);
  const d = Number(match[3]);
  return y && m && d ? isoDate(y, m, d) : null;
}

function addRange(out, startToken, endToken, year) {
  const start = parseDateToken(startToken, year);
  if (!start) return;
  const startParts = start.split('-').map(Number);
  const end = parseDateToken(endToken, year, { year: startParts[0], month: startParts[1] });
  if (!end || end < start) return;
  for (let date = start; date <= end; date = new Date(`${date}T00:00:00Z`), date.setUTCDate(date.getUTCDate() + 1), date = date.toISOString().slice(0, 10)) out.add(date);
}

function datesInText(text, year) {
  const out = new Set();
  let range;
  const covered = [];
  RANGE_RE.lastIndex = 0;
  while ((range = RANGE_RE.exec(text))) {
    addRange(out, range[1], range[2], year);
    covered.push([range.index, RANGE_RE.lastIndex]);
  }
  let singlesText = text;
  for (const [start, end] of covered) singlesText = `${singlesText.slice(0, start)}${' '.repeat(end - start)}${singlesText.slice(end)}`;
  DATE_RE.lastIndex = 0;
  let single;
  while ((single = DATE_RE.exec(singlesText))) {
    const date = parseDateToken(single[0], year);
    if (date) out.add(date);
  }
  return out;
}

function sectionBodies(text) {
  const sections = [];
  const normalized = text.replace(/([。；;])\s*([一二三四五六七八九十]+)、/g, '$1\n$2、');
  SECTION_RE.lastIndex = 0;
  let match;
  while ((match = SECTION_RE.exec(normalized))) sections.push(match[2]);
  return sections;
}

function addExtension(holidays, text, year) {
  const match = /延长(?:\d{4}年)?春节假期至\s*((?:(?:\d{4})年)?(?:(?:\d{1,2})月)?\d{1,2}日)/.exec(text);
  if (!match) return;
  const end = parseDateToken(match[1], year, { year: Number(year), month: 2 });
  if (!end) return;
  const prefix = `${year}-`;
  const prior = [...holidays].filter((date) => date.startsWith(prefix) && date <= end && Number(date.slice(5, 7)) <= 2).sort();
  // 2020 的正式通知把原春节假期（1 月 24 日至 30 日）延长到 2 月 2 日。
  // 以已解析出的春节末日为起点，若原文缺少该段才退回该年度惯例起点。
  let start = prior.at(-1);
  if (start) start = new Date(`${start}T00:00:00Z`);
  else start = new Date(`${year === 2020 ? '2020-01-30' : end}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() + 1);
  for (let date = start.toISOString().slice(0, 10); date <= end; date = new Date(`${date}T00:00:00Z`), date.setUTCDate(date.getUTCDate() + 1), date = date.toISOString().slice(0, 10)) holidays.add(date);
}

export function parseNotice(text, year) {
  const source = String(text || '').replaceAll('\r', '');
  const holidays = new Set();
  const workdays = new Set();
  for (const body of sectionBodies(source)) {
    const chineseColon = body.indexOf('：');
    const asciiColon = body.indexOf(':');
    const colon = chineseColon < 0 ? asciiColon : asciiColon < 0 ? chineseColon : Math.min(chineseColon, asciiColon);
    // 编号段中只有“标题：安排”描述假期；其余编号段是说明文字。
    if (colon < 0) continue;
    const arrangement = body.slice(colon + 1);
    for (const sentence of arrangement.split(/[。；;]/)) {
      if (/放假|连休|休息/.test(sentence) && !/上班|鼓励|带薪年休假|安排职工/.test(sentence)) {
        for (const date of datesInText(sentence, year)) holidays.add(date);
      }
      if (/上班/.test(sentence)) {
        const before = sentence.slice(0, sentence.lastIndexOf('上班'));
        const breakAt = Math.max(before.lastIndexOf('，'), before.lastIndexOf(','), before.lastIndexOf('：'), before.lastIndexOf(':'));
        for (const date of datesInText(before.slice(breakAt + 1), year)) {
          if (weekday(date) === 0 || weekday(date) === 6) workdays.add(date);
        }
      }
    }
  }
  // 2020-01-26 的延长通知没有“标题：安排”冒号，但它是正式的补充假期安排。
  addExtension(holidays, source, year);
  for (const date of [...workdays]) if (holidays.has(date)) workdays.delete(date);
  return {
    holidays: [...holidays].sort(),
    workdays: [...workdays].sort(),
  };
}

export function compareWithData(parsed, doc) {
  const expectedHolidays = new Set(parsed?.holidays || []);
  const expectedWorkdays = new Set(parsed?.workdays || []);
  const actualHolidays = new Set((doc?.days || []).filter((day) => day.kind === 'holiday').map((day) => day.date));
  const actualWorkdays = new Set((doc?.days || []).filter((day) => day.kind === 'workday').map((day) => day.date));
  const diff = (left, right) => [...left].filter((date) => !right.has(date)).sort();
  const missingHolidays = diff(expectedHolidays, actualHolidays);
  const extraHolidays = diff(actualHolidays, expectedHolidays);
  const missingWorkdays = diff(expectedWorkdays, actualWorkdays);
  const extraWorkdays = diff(actualWorkdays, expectedWorkdays);
  return {
    ok: !missingHolidays.length && !extraHolidays.length && !missingWorkdays.length && !extraWorkdays.length,
    missingHolidays,
    extraHolidays,
    missingWorkdays,
    extraWorkdays,
  };
}
