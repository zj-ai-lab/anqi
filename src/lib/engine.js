// 期限引擎（P1）——确定性纯函数层，吸收 D1-D5：
//   D1 触发事件驱动批量派生   D2 送达方式一等参数   D3 顺延方向 per-rule
//   D4 级联重算保护人工覆盖   D5 规则=数据（rules/deadline_rules.json）
// 铁律 1：本引擎是期限日期的唯一计算者，LLM 永不参与计算。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, audit, setChangeRuleId, withChangeContext } from '../db.js';
import { ruleMatches, APPLIES_FIELD, computeDue as computeCalendarDue } from './deadline-core.js';
export { ruleMatches };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_DIR = path.join(__dirname, '..', '..', 'rules');

// 规则分文件维护：民诉（deadline_rules.json）+ 刑事（deadline_rules_criminal.json）
// + 控告线立案前（deadline_rules_complaint.json）。
// 合并加载；文件缺失不报错（便于单测与增量部署）。
function loadRules(name) {
  const file = path.join(RULES_DIR, name);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8')).rules || [];
}
const RULES = [
  ...loadRules('deadline_rules.json'),
  ...loadRules('deadline_rules_criminal.json'),
  ...loadRules('deadline_rules_complaint.json'),
];

// ── 规则适用判定（多维）────────────────────────────────────────────
// 一级隔离：scope=criminal 的规则只对刑事程序生效，反之亦然。
// 刑事与民诉共用部分 trigger（judgment_served 上诉期、court_accepted 受理），
// 无此隔离会双触发（同一事件派生两条上诉期）。
// 控告线独占的立案前程序段。与侦查及以后是"前后衔接"而非"叠加"：
// 控告案立案后 procedure 换成「刑事侦查」，此后完全复用辩护线规则。
// 只报告当前事件会用到的条件，避免把尚未进入的程序误报为计算失败。
export function missingConditions(caseRow, events) {
  const missing = new Map();
  for (const rule of RULES) {
    if (rule.manual_only || !events.some(e => e.type === rule.trigger)) continue;
    if (!ruleMatches({ ...rule, applies: undefined }, caseRow)) continue;
    for (const [label] of Object.entries(rule.applies || {})) {
      const field = APPLIES_FIELD[label];
      if (!field || caseRow[field]) continue;
      if (!missing.has(field)) missing.set(field, { field, label, rules: [] });
      missing.get(field).rules.push(rule.name);
    }
  }
  return [...missing.values()];
}

// 条件变更先预览；已人工处理和已完成期限保留，自动待办期限经确认后作废并留痕。
export function conditionChangePreview(caseRow) {
  const retire = [], protectedItems = [];
  for (const d of db.prepare("SELECT * FROM deadlines WHERE case_id=? AND rule_id!='' AND status='pending'").all(caseRow.id)) {
    const rule = RULES.find(r => r.id === d.rule_id);
    if (!rule || ruleMatches(rule, caseRow)) continue;
    (d.is_manual_override ? protectedItems : retire).push({ id: d.id, name: d.name, due_on: d.due_on, rule_id: d.rule_id });
  }
  return { retire, protected: protectedItems };
}

export function reconcileConditions(caseRow, actor, preview) {
  return withChangeContext({ actor }, () => {
  for (const d of preview.retire) {
    setChangeRuleId(d.rule_id);
    db.prepare("UPDATE deadlines SET status='waived' WHERE id=?").run(d.id);
    audit(actor, 'condition-waive', 'deadline', d.id, '案件条件变更，原规则不再适用');
  }
  const created = { deadlines: [], tasks: [] };
  for (const event of db.prepare('SELECT * FROM events WHERE case_id=?').all(caseRow.id)) {
    const next = deriveForEvent(event, caseRow, actor);
    created.deadlines.push(...next.deadlines);
    created.tasks.push(...next.tasks);
  }
  setChangeRuleId(null);
  return { ...created, ...preview };

  });
}

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

export function computeDue(rule, event) {
  return computeCalendarDue(rule, event, { isCovered, isNonWorking });
}

// ── 手动参数（第一层：调参数 → 届满日自动重算）────────────────────────
// 2026-09-12 用户裁定「四项全开」：天数数值 / 单位 / 起算方式 / 顺延规则。
// 优先级：manual_* ＞ 规则默认值；改一个参数，日期自己跟着变，与法条依据的关联不丢。
const blank = (v) => v === null || v === undefined || v === '';

export function hasManualParams(dlRow) {
  return ['manual_days', 'manual_unit', 'manual_count_from', 'manual_roll'].some((k) => !blank(dlRow?.[k]));
}

export function applyManualParams(rule, dlRow) {
  const merged = { ...rule };
  if (!blank(dlRow?.manual_days)) merged.days = Number(dlRow.manual_days);
  if (!blank(dlRow?.manual_unit)) merged.unit = dlRow.manual_unit;
  if (!blank(dlRow?.manual_count_from)) merged.count_from = dlRow.manual_count_from;
  if (!blank(dlRow?.manual_roll)) merged.roll = dlRow.manual_roll;
  return merged;
}

// 手动调参后立即重算某条已存在期限；返回 null 表示该条不是引擎派生（无规则/无事件），
// 由调用方决定保持原状（不臆造日期）。
export function recomputeForDeadline(dlRow) {
  if (!dlRow || !dlRow.rule_id) return null;
  const rule = RULES.find((r) => r.id === dlRow.rule_id);
  if (!rule || !dlRow.trigger_event_id) return null;
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(dlRow.trigger_event_id);
  if (!event) return null;
  const { due_on, calc_note } = computeDue(applyManualParams(rule, dlRow), event);
  return {
    due_on,
    calc_note: hasManualParams(dlRow)
      ? calc_note.replace('【引擎】', '【引擎 · 手动参数】')
      : calc_note,
  };
}

const existsForEvent = db.prepare(
  'SELECT id FROM deadlines WHERE trigger_event_id = ? AND rule_id = ?'
);
const openTaskTitled = db.prepare(
  "SELECT id FROM tasks WHERE case_id = ? AND title = ? AND status = 'open'"
);

// 事件入库后调用：statutory 规则派生 deadlines；court_specified 规则铺「录入期限」任务
//
// 变更记录（024）：本函数一次可能按多条规则派生，每条规则产出的期限/待办在 change_log
// 里要能回溯到「是哪条规则算出来的」——所以每写一条前用 setChangeRuleId() 把当前规则 id
// 挂进事务上下文，写下一轮再覆盖。actor 不在这里设：它属于调用方的事务边界（见 db.js
// withChangeContext），本函数只补 rule_id；未被包过的调用照旧落 system。
export function deriveForEvent(event, caseRow, actor) {
  return withChangeContext({ actor }, () => {
  const created = { deadlines: [], tasks: [] };
  for (const rule of RULES) {
    if (rule.trigger !== event.type) continue;
    // manual_only：只作「可切换口径」的元数据，永不自动派生。
    // 例：拘留最长期限默认走 37 日（cr_detention_cap_37），10 日/14 日两条仅在
    // 人工于界面上切换口径时被引用（此时改的是 37 日那条的 manual_days，
    // 届满日仍由引擎按参数重算）——所以它们不能自己冒出来，否则一拘留就三条。
    if (rule.manual_only) continue;
    if (!ruleMatches(rule, caseRow)) continue;

    if (rule.kind === 'court_specified') {
      const title = rule.task_title || `录入「${rule.name}」截止日（文书载明）`;
      if (!openTaskTitled.get(caseRow.id, title)) {
        setChangeRuleId(rule.id);
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
    setChangeRuleId(rule.id);
    const info = db.prepare(
      `INSERT INTO deadlines (case_id, name, due_on, trigger_event_id, rule_id, basis, calc_note, is_manual_override, severity)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(caseRow.id, rule.name, due_on, event.id, rule.id, rule.basis, calc_note, rule.severity);
    audit(actor, 'derive-deadline', 'deadline', info.lastInsertRowid, `rule=${rule.id} event=${event.id} due=${due_on}`);
    created.deadlines.push({ id: info.lastInsertRowid, name: rule.name, due_on, severity: rule.severity });
  }
  return created;

  });
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
    if (d.is_manual_override && !hasManualParams(d)) { excluded.push({ id: d.id, name: d.name, due_on: d.due_on, reason: '人工设定/修正过（D4 保护）' }); continue; }
    if (d.status !== 'pending') { excluded.push({ id: d.id, name: d.name, due_on: d.due_on, reason: `状态=${d.status}` }); continue; }
    // 只调过参数（第一层）的仍按参数重算：否则改了锚点事件日期后，参数型期限会停在旧日期
    const next = computeDue(applyManualParams(rule, d), { ...event, occurred_on: newDate });
    recalc.push({ id: d.id, name: d.name, old_due: d.due_on, new_due: next.due_on, calc_note: next.calc_note });
  }
  return { recalc, excluded };
}

export function applyRecalc(preview, actor) {
  return withChangeContext({ actor }, () => {
  const upd = db.prepare('UPDATE deadlines SET due_on = ?, calc_note = ? WHERE id = ?');
  // 逐条取回它自己的 rule_id 再写：变更记录里「这条期限为什么改了日期」要落到具体规则上，
  // 而 preview.recalc 的形状被测试盯着，不为了这个字段去动它的返回结构。
  const ruleIdOf = db.prepare('SELECT rule_id FROM deadlines WHERE id = ?');
  for (const r of preview.recalc) {
    setChangeRuleId(ruleIdOf.get(r.id)?.rule_id ?? null);
    upd.run(r.new_due, r.calc_note, r.id);
    audit(actor, 'recalc-deadline', 'deadline', r.id, `${r.old_due} → ${r.new_due}`);
  }

  });
}

// 规则清单（/api/meta 交给前端）。除展示用的 id/name/basis 外，多带三样：
//   days / unit  —— 前端算「当前是第几档口径」用
//   manual_only  —— 标明这条只供手动切换、不会自动派生（前端不渲染为可选规则）
//   variants     —— 可选口径已就地解析成 {rule_id,days,name,basis,severity,label}，
//                   前端拿到即可直接渲染下拉，不必再回表查兄弟规则。
// 口径的天数/名称/依据始终只在规则文件里定义一处，本函数只做引用解析。
export function rulesSummary() {
  const byId = new Map(RULES.map((r) => [r.id, r]));
  return RULES.map((r) => ({
    id: r.id,
    name: r.name,
    trigger: r.trigger,
    kind: r.kind,
    basis: r.basis,
    severity: r.severity,
    days: r.days ?? null,
    unit: r.unit ?? null,
    manual_only: !!r.manual_only,
    variants: (r.variants || [])
      .map((v) => {
        const s = byId.get(v.rule_id);
        return s
          ? { rule_id: s.id, label: v.label || s.name, days: s.days, name: s.name, basis: s.basis, severity: s.severity }
          : null; // 引用了不存在的规则 id：静默丢弃，宁可不给选项也不给错选项
      })
      .filter(Boolean),
  }));
}
