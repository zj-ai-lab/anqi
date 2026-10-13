// 全系统日期 = 北京时间 'YYYY-MM-DD' 字符串。容器 TZ 可能是 UTC，
// 所以「今天」必须显式按 Asia/Shanghai 求值，不信任宿主时区。
const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

/** YYYY-MM-DD → 「星期X」。取该日 UTC 正午，避免服务器时区把日期推到前后一天。 */
export function weekdayCN(date) {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : `星期${WEEKDAY_CN[d.getUTCDay()]}`;
}

export function todayCN() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

export function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// b - a 的天数（b 晚于 a 为正）
export function diffDays(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
