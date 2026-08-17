// 期限引擎（P1）——确定性纯函数层，吸收 D1-D5：
//   D1 触发事件驱动批量派生   D2 送达方式一等参数   D3 顺延方向 per-rule
//   D4 级联重算保护人工覆盖   D5 规则=数据（rules/deadline_rules.json）
// 铁律 1：本引擎是期限日期的唯一计算者，LLM 永不参与计算。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, audit } from '../db.js';
import { addDays, diffDays } from './dates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'rules', 'deadline_rules.json'), 'utf8')
).rules;

const WD = ['日', '一', '二', '三', '四', '五', '六'];
const weekdayOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay();

const holidayKind = db.prepare('SELECT kind FROM holidays WHERE date = ?');
const yearCovered = db.prepare("SELECT 1 AS c FROM holidays WHERE date LIKE ? LIMIT 1");

function isCovered(dateStr) {
  return !!yearCovered.get(dateStr.slice(0, 4) + '-%');
}

// 非工作日 =（周末且非调休补班）或 法定节假日
function isNonWorking(dateStr) {
  const h = holidayKind.get(dateStr);
  if (h) return h.kind === 'holiday';
  const w = weekdayOf(dateStr);
  return w === 0 || w === 6;
}

function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last)); // 月末钳制（01-31 +1月 → 02-28/29）
  return t.toISOString().slice(0, 10);
}

// 单条规则计算：返回 { due_on, calc_note, coverage_warning }
export function computeDue(rule, event) {
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

  let raw;
  if (rule.unit === 'months') {
    raw = addMonths(base, rule.days);
    notes.push(`${base} 起 ${rule.days} 个月 → ${raw}`);
  } else if (rule.unit === 'years') {
    raw = addMonths(base, rule.days * 12);
    notes.push(`${base} 起 ${rule.days} 年 → ${raw}`);
  } else {
    // natural_days：期间开始之日不计入（民诉法 §85），次日起算第 N 日即 base+N
    raw = rule.count_from === 'next_day' ? addDays(base, rule.days) : addDays(base, rule.days - 1);
    notes.push(`${base} 次日起算 ${rule.days} 日 → ${raw}`);
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

const existsForEvent = db.prepare(
  'SELECT id FROM deadlines WHERE trigger_event_id = ? AND rule_id = ?'
);
const openTaskTitled = db.prepare(
  "SELECT id FROM tasks WHERE case_id = ? AND title = ? AND status = 'open'"
);

// 事件入库后调用：statutory 规则派生 deadlines；court_specified 规则铺「录入期限」任务
export function deriveForEvent(event, caseRow, actor) {
  const created = { deadlines: [], tasks: [] };
  for (const rule of RULES) {
    if (rule.trigger !== event.type) continue;
    if (rule.applies_procedure && !rule.applies_procedure.includes(caseRow.procedure)) continue;

    if (rule.kind === 'court_specified') {
      const title = rule.task_title || `录入「${rule.name}」截止日（文书载明）`;
      if (!openTaskTitled.get(caseRow.id, title)) {
        const info = db.prepare(
          `INSERT INTO tasks (case_id, title, priority, origin, note) VALUES (?, ?, 'high', 'template', ?)`
        ).run(caseRow.id, title, `${rule.basis}；录入后请在本案「记法定死线」填入实际日期`);
        audit(actor, 'derive-task', 'task', info.lastInsertRowid, `rule=${rule.id} event=${event.id}`);
        created.tasks.push({ id: info.lastInsertRowid, title });
      }
      continue;
    }

    if (existsForEvent.get(event.id, rule.id)) continue; // 幂等：同事件同规则不重复派生
    const { due_on, calc_note } = computeDue(rule, event);
    const info = db.prepare(
      `INSERT INTO deadlines (case_id, name, due_on, trigger_event_id, rule_id, basis, calc_note, is_manual_override, severity)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(caseRow.id, rule.name, due_on, event.id, rule.id, rule.basis, calc_note, rule.severity);
    audit(actor, 'derive-deadline', 'deadline', info.lastInsertRowid, `rule=${rule.id} event=${event.id} due=${due_on}`);
    created.deadlines.push({ id: info.lastInsertRowid, name: rule.name, due_on, severity: rule.severity });
  }
  return created;
}

// 改触发日期前的级联重算预览（D4：人工覆盖/已结案的默认排除）
export function recalcPreview(event, newDate) {
  const derived = db.prepare(
    "SELECT * FROM deadlines WHERE trigger_event_id = ? AND rule_id != ''"
  ).all(event.id);
  const recalc = [];
  const excluded = [];
  for (const d of derived) {
    const rule = RULES.find((r) => r.id === d.rule_id);
    if (!rule) { excluded.push({ id: d.id, name: d.name, due_on: d.due_on, reason: '规则已下线' }); continue; }
    if (d.is_manual_override) { excluded.push({ id: d.id, name: d.name, due_on: d.due_on, reason: '人工设定/修正过（D4 保护）' }); continue; }
    if (d.status !== 'pending') { excluded.push({ id: d.id, name: d.name, due_on: d.due_on, reason: `状态=${d.status}` }); continue; }
    const next = computeDue(rule, { ...event, occurred_on: newDate });
    recalc.push({ id: d.id, name: d.name, old_due: d.due_on, new_due: next.due_on, calc_note: next.calc_note });
  }
  return { recalc, excluded };
}

export function applyRecalc(preview, actor) {
  const upd = db.prepare('UPDATE deadlines SET due_on = ?, calc_note = ? WHERE id = ?');
  for (const r of preview.recalc) {
    upd.run(r.new_due, r.calc_note, r.id);
    audit(actor, 'recalc-deadline', 'deadline', r.id, `${r.old_due} → ${r.new_due}`);
  }
}

export function rulesSummary() {
  return RULES.map((r) => ({ id: r.id, name: r.name, trigger: r.trigger, kind: r.kind, basis: r.basis, severity: r.severity }));
}
