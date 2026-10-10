// 中文日期、时刻的边界规范化：纯函数，不读库、不写库。

function clean(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function validDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return '';
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return '';
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function normalizeDate(value) {
  const text = clean(value);
  if (!text) return '';
  let match = text.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/);
  if (!match) match = text.match(/^(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})$/);
  if (!match) return '';
  return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

function clock(hour, minute, meridiem) {
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return '';
  if (meridiem && hour > 12) return '';
  let value = hour;
  if (['下午', '晚上', '中午'].includes(meridiem) && hour < 12) value += 12;
  if (value < 0 || value > 23) return '';
  return `${String(value).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function normalizeTime(value) {
  const text = clean(value);
  if (!text) return '';
  let match = text.match(/^(上午|下午|中午|晚上)?\s*(\d{1,2})\s*:\s*(\d{1,2})$/);
  if (match) return clock(Number(match[2]), Number(match[3]), match[1] || '');

  match = text.match(/^(上午|下午|中午|晚上)?\s*(\d{1,2})\s*(?:时|点)\s*(?:(\d{1,2})\s*分?|半)?$/);
  if (!match) return '';
  const minute = match[3] === undefined ? (text.endsWith('半') ? 30 : 0) : Number(match[3]);
  return clock(Number(match[2]), minute, match[1] || '');
}

export const normalizeCnDate = normalizeDate;
export const normalizeCnTime = normalizeTime;
