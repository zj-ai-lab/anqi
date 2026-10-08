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

// applies 的中文维度名 → cases 表列名
export const APPLIES_FIELD = {
  作案类型: 'crime_type',
  审理程序: 'trial_mode',
  案件性质: 'case_nature',
  羁押状态: 'custody_status',
};

export function ruleMatches(rule, caseRow) {
  const isCriminal = CRIMINAL_PROCEDURES.has(caseRow.procedure);
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

// 单条规则计算：返回 { due_on, calc_note, coverage_warning }
export function computeDue(rule, event, calendar) {
  const { isCovered, isNonWorking } = calendar;
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
  // 起算方式（count_from）：期间开始之日不计入 → 次日起算
  // （刑诉法 §105：期间以时、日、月计算，期间开始的时和日不算在期间以内；
  //   以月计算的期间自本月某日至下月同日为一个月 —— 刑诉法解释 §202①）。
  //
  // 2026-09-12 裁定「丙」：月/年单位此前忽略 count_from，一律按"含当日"直接加月，
  // 结果比法定算法早 1 天（3-1 逮捕 + 2 月 → 算出 5-1，法定应 5-2）。现改为法定算法，
  // 并在 UI 法条浮层注明"实务文书常按含当日写，早 1 天"的差异。
  //
  // 实现要点：先定起算日（次日起算＝锚点 +1 日），再加月/年；月末钳制以起算日为准，
  // 例：锚点 01-30 + 1 月 → 起算日 01-31 → 02-28（不能被钳成 03-01）。
  const shift = !back && rule.count_from === 'next_day' ? 1 : 0;
  const start = shift ? addDays(base, shift) : base;
  const seg = back ? '前推' : shift ? `次日起算（起算日 ${start}）` : '当日起算';
  let raw;
  if (rule.unit === 'months') {
    raw = addMonths(start, back ? -rule.days : rule.days);
    notes.push(`${base} ${seg} ${rule.days} 个月 → ${raw}`);
  } else if (rule.unit === 'years') {
    raw = addMonths(start, (back ? -1 : 1) * rule.days * 12);
    notes.push(`${base} ${seg} ${rule.days} 年 → ${raw}`);
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

  let due = raw;
  let coverageWarning = false;
  if (!isCovered(due)) coverageWarning = true;
  if (rule.roll && rule.roll !== 'none') {
    const step = rule.roll === 'backward' ? -1 : 1;
    let hops = 0;
    while (isNonWorking(due) && hops < 15) {
      due = addDays(due, step);
      hops++;
    }
    if (hops > 0) {
      notes.push(`届满日 ${raw}（周${WD[weekdayOf(raw)]}）为节假日/休息日 → ${rule.roll === 'backward' ? '前移' : '顺延'}至 ${due}（周${WD[weekdayOf(due)]}）`);
    } else {
      notes.push(`届满日 ${due}（周${WD[weekdayOf(due)]}）为工作日，不顺延`);
    }
  }
  if (coverageWarning) notes.push(`⚠️ 节假日表未覆盖 ${due.slice(0, 4)} 年，仅按周末顺延，法定节假日请人工复核`);

  const calc_note = `【引擎】${notes.join('；')}。依据：${rule.basis}`;
  return { due_on: due, calc_note, coverage_warning: coverageWarning };
}
