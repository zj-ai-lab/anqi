// 数据源纪律：gov.cn 的国务院办公厅通知是权威来源；GitHub/jsDelivr 镜像只作抓取机制，
// 任何镜像数据都必须与官方通知逐日比对后才可标记 verified。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNotice, compareWithData } from '../src/lib/holiday-notice.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULES_DIR = path.join(ROOT, 'rules');
const NOTICE_DIR = path.join(RULES_DIR, 'holiday-notices');
const MIRROR_TEMPLATES = [
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/Y.json',
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/Y.json',
];

function govUrl(value) {
  try { return /^https?:\/\/(?:[^/]+\.)?gov\.cn(?:\/|$)/i.test(new URL(value).href); } catch { return false; }
}

export function mirrorDays(doc) {
  const rows = Array.isArray(doc) ? doc : doc?.days || doc?.data || [];
  return rows.flatMap((item) => {
    const date = String(item?.date || item?.day || item?.holidayDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    const kind = item.kind || (item.holiday === true || item.isOffDay === true || item.type === 'holiday' ? 'holiday' : item.workday === true || item.isOffDay === false || item.type === 'workday' ? 'workday' : '');
    if (!['holiday', 'workday'].includes(kind)) return [];
    return [{ date, kind, name: item.name || item.title || '' }];
  });
}

function sourceUrls(doc) {
  const papers = doc?.papers || doc?.paper || [];
  const values = Array.isArray(papers) ? papers : Object.values(papers || {});
  return values.map((item) => typeof item === 'string' ? item : item?.url || item?.href || '').filter(govUrl);
}

function ucapContent(html) {
  const source = String(html);
  const open = /<div\b[^>]*\bid\s*=\s*(?:"UCAP-CONTENT"|'UCAP-CONTENT'|UCAP-CONTENT)[^>]*>/i.exec(source);
  if (!open) return source;
  const start = open.index + open[0].length;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 1;
  let match;
  while ((match = tags.exec(source))) {
    if (/^<\//.test(match[0])) {
      depth -= 1;
      if (depth === 0) return source.slice(start, match.index);
    } else if (!/\/\s*>$/.test(match[0])) {
      depth += 1;
    }
  }
  return source.slice(start);
}

function decodeEntities(text) {
  return text.replace(/&(?:nbsp|amp|lt|gt|quot|#39|#x[0-9a-f]+|#[0-9]+);/gi, (entity) => {
    const name = entity.slice(1, -1).toLowerCase();
    if (name === 'nbsp') return ' ';
    if (name === 'amp') return '&';
    if (name === 'lt') return '<';
    if (name === 'gt') return '>';
    if (name === 'quot') return '"';
    if (name === '#39') return "'";
    const code = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    try { return Number.isInteger(code) ? String.fromCodePoint(code) : entity; } catch { return entity; }
  });
}

export function stripHtml(html) {
  return decodeEntities(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(?:p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  ).replaceAll('\r', '').trim();
}

export function officialSections(text) {
  const value = stripHtml(ucapContent(text));
  const heading = /[一二三四五六七八九十]+、[^：:\n]{1,12}[：:]/;
  const first = heading.exec(value);
  if (!first) return '';
  const second = value.indexOf(first[0], first.index + first[0].length);
  const sectionText = value.slice(first.index, second < 0 ? value.length : second);
  return sectionText.trim();
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function diffText(diff) {
  const fields = [
    ['missingHolidays', '缺少放假日'], ['extraHolidays', '多出放假日'],
    ['missingWorkdays', '缺少调休上班日'], ['extraWorkdays', '多出调休上班日'],
  ];
  return fields.filter(([key]) => diff[key]?.length).map(([key, label]) => `${label}：${diff[key].join('、')}`).join('；');
}

function validateDocument(doc, year) {
  const errors = [];
  if (doc?.schema_version !== 2) errors.push('schema_version != 2');
  if (doc?.year !== year) errors.push('year 不匹配');
  if (!Array.isArray(doc?.source_urls) || !doc.source_urls.length) errors.push('source_urls 为空');
  else if (doc.source_urls.some((url) => !govUrl(url))) errors.push('source_urls 含非 gov.cn URL');
  if (!doc?.verified || !['verified', 'pending'].includes(doc.verified.status)) errors.push('verified.status 缺失或非法');
  if (!Array.isArray(doc?.days)) errors.push('days 不是数组');
  for (const day of doc?.days || []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !['holiday', 'workday'].includes(day.kind)) errors.push(`days 条目非法：${JSON.stringify(day)}`);
  }
  return errors;
}

export function checkYear(year, { rulesDir = RULES_DIR, noticeDir = NOTICE_DIR } = {}) {
  const filename = `holidays-${year}.json`;
  const file = path.join(rulesDir, filename);
  if (!fs.existsSync(file)) return { year, ok: false, status: 'missing', errors: ['文件不存在'] };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    return { year, ok: false, status: 'invalid', errors: [`JSON 无法解析：${error.message}`] };
  }
  const errors = validateDocument(doc, year);
  const notice = path.join(noticeDir, `${year}.txt`);
  if (!fs.existsSync(notice)) errors.push('通知原文不存在');
  else {
    const parsed = parseNotice(fs.readFileSync(notice, 'utf8'), year);
    const diff = compareWithData(parsed, doc);
    if (!diff.ok) errors.push(diffText(diff));
  }
  return { year, ok: errors.length === 0, status: doc?.verified?.status || 'invalid', errors };
}

export function checkAllYears({ rulesDir = RULES_DIR, noticeDir = NOTICE_DIR } = {}) {
  const years = fs.readdirSync(rulesDir).map((name) => /^holidays-(\d{4})\.json$/.exec(name)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  return years.map((year) => checkYear(year, { rulesDir, noticeDir }));
}

function printCheckTable(rows) {
  console.log('年份 | 状态 | 结果');
  console.log('---|---|---');
  for (const row of rows) console.log(`${row.year} | ${row.status} | ${row.ok ? 'OK' : row.errors.join('；')}`);
}

function parseArgs(argv) {
  const years = [];
  let check = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') check = true;
    else if (argv[i] === '--force') force = true;
    else if (argv[i] === '--year') {
      const year = Number(argv[++i]);
      if (!Number.isInteger(year) || year < 1900 || year > 9999) throw new Error('--year 须为四位年份');
      years.push(year);
    } else throw new Error(`未知参数：${argv[i]}`);
  }
  return { years, check, force };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function updateYear(year, force) {
  const file = path.join(RULES_DIR, `holidays-${year}.json`);
  if (fs.existsSync(file) && !force) return { year, status: 'skip', ok: true, message: '已有文件' };
  let mirror;
  let mirrorUrl = '';
  for (const template of MIRROR_TEMPLATES) {
    mirrorUrl = template.replace('/Y.', `/${year}.`);
    try { mirror = JSON.parse(await fetchText(mirrorUrl)); break; } catch { /* fallback mirror */ }
  }
  const days = mirrorDays(mirror);
  if (!days.length) {
    console.log(`${year} 年通知尚未发布`);
    return { year, status: 'unpublished', ok: true };
  }
  const urls = sourceUrls(mirror);
  let officialText = '';
  let officialUrl = '';
  for (const url of urls) {
    try {
      const extracted = officialSections(await fetchText(url));
      if (extracted) { officialText = extracted; officialUrl = url; break; }
    } catch { /* try next paper */ }
  }
  const localNotice = path.join(NOTICE_DIR, `${year}.txt`);
  if (!officialText && fs.existsSync(localNotice)) officialText = fs.readFileSync(localNotice, 'utf8');
  const mirrorDoc = { days: days.filter((day) => day.kind !== 'workday' || [0, 6].includes(new Date(`${day.date}T00:00:00Z`).getUTCDay())) };
  if (!officialText) {
    const pending = {
      schema_version: 2, year, source: '', source_urls: urls, mirror: mirrorUrl,
      verified: { status: 'pending', method: '等待 gov.cn 通知原文核对', at: new Date().toISOString().slice(0, 10), by: 'tools/update-holidays.js' },
      days,
    };
    writeJson(file, pending);
    console.error(`${year} 年官方通知原文不可用：请将 gov.cn 文本粘贴到 rules/holiday-notices/${year}.txt 后重新运行`);
    return { year, status: 'pending', ok: false, code: 2 };
  }
  const parsed = parseNotice(officialText, year);
  const diff = compareWithData(parsed, mirrorDoc);
  if (!diff.ok) {
    console.error(`${year} 年镜像与官方通知不一致：${diffText(diff)}`);
    return { year, status: 'mismatch', ok: false, code: 1 };
  }
  const sourceLine = officialText.split('\n').find((line) => line.trim()) || `国务院办公厅 ${year} 年部分节假日安排通知`;
  const doc = {
    schema_version: 2,
    year,
    source: sourceLine.replace(/^来源[:：].*$/, '').trim(),
    source_urls: urls,
    mirror: mirrorUrl,
    verified: { status: 'verified', method: 'gov.cn 通知原文与镜像逐日比对', at: new Date().toISOString().slice(0, 10), by: 'tools/update-holidays.js' },
    days,
  };
  writeJson(file, doc);
  fs.mkdirSync(NOTICE_DIR, { recursive: true });
  const header = `文号：${sourceLine}\n来源 URL：${officialUrl || urls[0] || ''}\n`;
  fs.writeFileSync(localNotice, `${header}${officialText.trim()}\n`);
  return { year, status: 'verified', ok: true };
}

export async function main(argv = process.argv.slice(2)) {
  const { years, check, force } = parseArgs(argv);
  if (check) {
    const rows = checkAllYears();
    printCheckTable(rows);
    return rows.every((row) => row.ok) ? 0 : 1;
  }
  const current = new Date().getFullYear();
  const targets = years.length ? [...new Set(years)] : Array.from({ length: current - 2019 + 1 }, (_, i) => 2020 + i).filter((year) => force || !fs.existsSync(path.join(RULES_DIR, `holidays-${year}.json`)));
  let code = 0;
  for (const year of targets) {
    const result = await updateYear(year, force);
    if (result.code && result.code > code) code = result.code;
  }
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => { if (code) process.exitCode = code; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
