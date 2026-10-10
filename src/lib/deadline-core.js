// 本地与云端页面共享同一确定性算法；无数据库、文件系统或模型调用。
import { addDays } from './dates.js';
const PRECOMMIT_PROCEDURE = '刑事控告立案前';

const CRIMINAL_PROCEDURES = new Set([
  // 「刑事控告立案前」为控告线独有（报案→受案→立案审查→复议复核/立案监督），
  // 与辩护线共用 scope=criminal 隔离，但不与侦查及以后的 40 条规则互相触发
  // （靠 trigger + 上面的程序段闸门分开，见 ruleMatches）。
  PRECOMMIT_PROCEDURE,
  '刑事侦查', '刑事审查起诉', '刑事一审', '刑事二审', '刑事死刑复核', '刑事再审', '刑事执行',
]);

// 行政程序段：与民诉/刑事严格隔离。scope=admin 的规则只在这些程序下匹配；
// 进入行政程序后，无 scope=admin 的民诉兜底规则（如无 applies_procedure 的缴费/举证录入）一律不触发。
export const ADMIN_PROCEDURES = new Set([
  '行政复议', '行政一审', '行政二审', '行政再审', '行政执行',
]);
export function isAdminProcedure(procedure) {
  return ADMIN_PROCEDURES.has(procedure);
}

// applies 的中文维度名 → cases 表列名
export const APPLIES_FIELD = {
  作案类型: 'crime_type',
  审理程序: 'trial_mode',
  案件性质: 'case_nature',
  羁押状态: 'custody_status',
};

export function ruleMatches(rule, caseRow) {
  const isCriminal = CRIMINAL_PROCEDURES.has(caseRow.procedure);
  const isAdmin = ADMIN_PROCEDURES.has(caseRow.procedure);
  // 行政闸门：行政案件只匹配 scope=admin 规则；admin 规则也不落到民诉/刑事案件。
  if (rule.scope === 'admin' && !isAdmin) return false;
  if (isAdmin && rule.scope !== 'admin') return false;
  if (rule.scope === 'criminal' && !isCriminal) return false;
  if (rule.scope === 'civil' && isCriminal) return false;
  // 程序段闸门：「刑事控告立案前」是控告线独占的独立程序段，与侦查及以后是前后衔接关系
  // （控告案立案后把 procedure 换成「刑事侦查」），不是叠加关系。
  // 若不设此闸门，一个立案前案件只要记了「逮捕」事件，就会误派生侦查线羁押期限。
  // 判据：立案前之下只放行显式声明 applies_procedure 的规则（即控告线规则）。
  if (caseRow.procedure === PRECOMMIT_PROCEDURE && !rule.applies_procedure) return false;
  // 旧字段（单维程序名），向后兼容民诉规则
  if (rule.applies_procedure && !rule.applies_procedure.includes(caseRow.procedure)) return false;
  // 新字段（多维键值），全部命中才适用
  if (rule.applies) {
    for (const [key, allowed] of Object.entries(rule.applies)) {
      const col = APPLIES_FIELD[key];
      if (!col) return false; // 未知维度：保守拒绝，宁可不派生也不误派生
      const actual = caseRow[col] ?? '';
      if (!allowed.includes(actual)) return false;
    }
  }
  return true;
}

const WD = ['日', '一', '二', '三', '四', '五', '六'];
const weekdayOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay();

function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last)); // 月末钳制（01-31 +1月 → 02-28/29）
  return t.toISOString().slice(0, 10);
}

function rollDate(dateStr, direction, isNonWorking) {
  let due = dateStr;
  let hops = 0;
  while (isNonWorking(due) && hops < 15) {
    due = addDays(due, direction === 'backward' ? -1 : 1);
    hops++;
  }
  return { due, hops };
}

function spanDates(start, end) {
  if (!start || !end || start > end) return [];
  const out = [];
  let cursor = start;
  let guard = 0;
  while (cursor <= end) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
    if (++guard > 10000) break;
  }
  return out;
}

function criminalHolidayOption(rule, { base, start, raw, back }, calendar) {
  if (rule.scope !== 'criminal' || !raw) return null;
  const kindOf = calendar.kindOf || (() => null);
  // 自然日/工作日按实际计数跨度；倒推期限的期间是 raw 到锚点前一日。
  const periodStart = back ? raw : start;
  const periodEnd = back ? (base === raw ? raw : addDays(base, -1)) : raw;
  const period = spanDates(periodStart, periodEnd);
  const contains_holidays = period.filter((date) => kindOf(date) === 'holiday');
  const rawKind = kindOf(raw);
  const endWeekend = [0, 6].includes(weekdayOf(raw)) && rawKind !== 'workday';
  if (!contains_holidays.length && rawKind !== 'holiday' && !endWeekend) return null;
  return {
    applies: true,
    contains_holidays,
    default_due: raw,
    rolled_due: rollDate(raw, 'forward', calendar.isNonWorking).due,
  };
}

// 单条规则计算：返回 { due_on, rolled_from, calc_note, coverage_warning, holiday_roll_option }
export function computeDue(rule, event, calendar) {
  const { isCovered, isNonWorking, kindOf = () => null } = calendar;
  const notes = [];
  let base = event.occurred_on;

  const svc = rule.service_modifiers?.[event.service_method || ''];
  if (svc) {
    if (svc.prepend_days) {
      base = addDays(base, svc.prepend_days);
      notes.push(`${event.occurred_on}（${event.service_method}）${svc.note || ''}，起算基准推至 ${base}`);
    } else if (svc.note) {
      notes.push(svc.note);
    }
  }

  // 期限方向：after=自锚点向后（常规）；before=自锚点向前（刑诉法 §187 开庭前送达/公布）
  const back = rule.direction === 'before';
  // 起算方式（count_from）：自然日/工作日的期间开始之日不计入 → 次日起算。
  // 月/年单位按民法典§202：到期月的对应日为最后一日，直接从事件锚点计算，
  // 不适用 next_day；月末没有对应日时由 addMonths 钳到月末。
  // （刑诉法 §105：期间以时、日、月计算，期间开始的时和日不算在期间以内；
  //   以月计算的期间自本月某日至下月同日为一个月 —— 刑诉法解释 §202①）。
  //
  // R4：月/年单位不再读取 count_from，直接从事件日按对应日计算。
  // 自然日/工作日仍按 count_from 决定是否次日起算；月末无对应日时钳到月末。
  const monthYear = rule.unit === 'months' || rule.unit === 'years';
  const shift = !monthYear && !back && rule.count_from === 'next_day' ? 1 : 0;
  const start = shift ? addDays(base, shift) : base;
  const seg = monthYear
    ? (rule.unit === 'months' ? '起按月计算' : '起按年计算')
    : back ? '前推' : shift ? `次日起算（起算日 ${start}）` : '当日起算';
  let raw;
  let workdaySpan = null;
  if (rule.unit === 'workdays') {
    const count = Number(rule.days);
    if (!Number.isInteger(count) || count < 0) throw new Error('workdays 的 days 必须是非负整数');
    const counted = [];
    const skippedHolidays = [];
    const skippedWeekends = [];
    const missingYears = new Set();
    let cursor;
    let n = 0;
    let iterations = 0;
    if (back) {
      cursor = addDays(base, -1);
      while (n < count) {
        iterations++;
        if (iterations > 1000) throw new Error('workdays 计算超过 1000 次迭代');
        if (!isCovered(cursor)) missingYears.add(Number(cursor.slice(0, 4)));
        const kind = kindOf(cursor);
        if (!isNonWorking(cursor)) {
          n++;
          counted.push(cursor);
        } else if (kind === 'holiday') {
          skippedHolidays.push(cursor);
        } else if (weekdayOf(cursor) === 0 || weekdayOf(cursor) === 6) {
          skippedWeekends.push(cursor);
        }
        if (n === count) break;
        cursor = addDays(cursor, -1);
      }
      raw = count === 0 ? base : counted.at(-1);
      workdaySpan = { missingYears, counted, skippedHolidays, skippedWeekends };
      notes.push(`${base} 前推 ${count} 个工作日（不含起算日） → ${raw}；结果按工作日构造，不再顺延`);
    } else {
      cursor = rule.count_from === 'same_day' ? base : addDays(base, 1);
      while (n < count) {
        iterations++;
        if (iterations > 1000) throw new Error('workdays 计算超过 1000 次迭代');
        if (!isCovered(cursor) && cursor !== base) missingYears.add(Number(cursor.slice(0, 4)));
        const kind = kindOf(cursor);
        if (!isNonWorking(cursor)) {
          n++;
          counted.push(cursor);
        } else if (kind === 'holiday') {
          skippedHolidays.push(cursor);
        } else if (weekdayOf(cursor) === 0 || weekdayOf(cursor) === 6) {
          skippedWeekends.push(cursor);
        }
        if (n === count) break;
        cursor = addDays(cursor, 1);
      }
      raw = count === 0 ? base : counted.at(-1);
      workdaySpan = { missingYears, counted, skippedHolidays, skippedWeekends };
      notes.push(`${base} ${rule.count_from === 'same_day' ? '当日起算' : '次日起算'} ${count} 个工作日 → ${raw}；结果按工作日构造，不再顺延`);
    }
    if (skippedHolidays.length) notes.push(`期间内跳过法定节假日 ${skippedHolidays.length} 天（${skippedHolidays.join('、')}）`);
    if (skippedWeekends.length) notes.push(`期间内跳过周末 ${skippedWeekends.length} 天`);
    const countedWorkdays = counted.filter((d) => kindOf(d) === 'workday');
    if (countedWorkdays.length) notes.push(`调休上班日 ${countedWorkdays.join('、')} 计入`);
  } else if (rule.unit === 'months') {
    raw = addMonths(start, back ? -rule.days : rule.days);
    notes.push(`${base} ${seg} ${rule.days} 个月 → 到期月对应日 ${raw}（民法典§202；无对应日取月末）`);
    if (rule._manual_count_from || rule.manual_count_from) notes.push(`手动起算方式「${rule._manual_count_from || rule.manual_count_from}」对月单位不作次日平移`);
  } else if (rule.unit === 'years') {
    raw = addMonths(start, (back ? -1 : 1) * rule.days * 12);
    notes.push(`${base} ${seg} ${rule.days} 年 → 到期月对应日 ${raw}（民法典§202；无对应日取月末）`);
    if (rule._manual_count_from || rule.manual_count_from) notes.push(`手动起算方式「${rule._manual_count_from || rule.manual_count_from}」对年单位不作次日平移`);
  } else if (back) {
    // 向前推：「至迟在开庭 N 日以前」＝锚点日减 N（开庭日不计入）。
    // 此类规则是"从开庭日往前倒推"，不存在期间起算问题
    // （rules 内 count_from 记 not_applicable，见 deadline_rules_criminal.json）。
    raw = addDays(base, -rule.days);
    notes.push(`${base} 前推 ${rule.days} 日 → ${raw}`);
  } else {
    // natural_days：期间开始之日不计入（刑诉法 §105 / 民诉法 §85），次日起算第 N 日即 base+N
    raw = rule.count_from === 'next_day' ? addDays(base, rule.days) : addDays(base, rule.days - 1);
    notes.push(rule.count_from === 'next_day'
      ? `${base} 次日起算 ${rule.days} 日 → ${raw}`
      : `${base} 含当日起算 ${rule.days} 日 → ${raw}`);
  }

  const holiday_roll_option = criminalHolidayOption(rule, { base, start, raw, back }, calendar);
  let due = raw;
  if (rule.roll && rule.roll !== 'none') {
    const rolled = rollDate(raw, rule.roll, isNonWorking);
    due = rolled.due;
    const hops = rolled.hops;
    if (hops > 0) {
      notes.push(`届满日 ${raw}（周${WD[weekdayOf(raw)]}）为节假日/休息日 → ${rule.roll === 'backward' ? '前移' : '顺延'}至 ${due}（周${WD[weekdayOf(due)]}）`);
    } else {
      notes.push(`届满日 ${due}（周${WD[weekdayOf(due)]}）为工作日，不顺延`);
    }
  }
  const missingYears = new Set(workdaySpan?.missingYears || []);
  if (rule.unit === 'workdays') {
    // 工作日需要覆盖整个计数跨度（包含被跳过的日期）；base 本身不属于跨度。
    for (const d of [...(workdaySpan?.counted || []), ...(workdaySpan?.skippedHolidays || []), ...(workdaySpan?.skippedWeekends || [])]) {
      if (d === base) continue; // same_day 的 base 是起算锚点，不属于 base exclusive…due inclusive 跨度
      if (!isCovered(d)) missingYears.add(Number(d.slice(0, 4)));
    }
  } else {
    // 自然日/月/年只要求原始届满日与最终顺延日所在年份有年度数据。
    if (!isCovered(raw)) missingYears.add(Number(raw.slice(0, 4)));
    if (!isCovered(due)) missingYears.add(Number(due.slice(0, 4)));
  }
  const coverage_missing_years = [...missingYears].sort((a, b) => a - b);
  const coverageWarning = coverage_missing_years.length > 0;
  if (coverageWarning) {
    const years = coverage_missing_years.map((year) => `${year} 年`).join('、');
    notes.push(`⚠️ 节假日数据缺 ${years}（国务院办公厅当年《部分节假日安排的通知》未入库）：本期限仅按周末推算，可能不准，须人工核对；更新：node tools/update-holidays.js --year ${coverage_missing_years[0]}`);
    notes.push('未覆盖年份已列入 coverage_missing_years');
  }

  const calc_note = `【引擎】${notes.join('；')}。依据：${rule.basis}`;
  return { due_on: due, rolled_from: due !== raw ? raw : '', calc_note, coverage_warning: coverageWarning, coverage_missing_years, holiday_roll_option };
}
