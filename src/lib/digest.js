import { db } from '../db.js';
import { todayCN, addDays, diffDays } from './dates.js';
import { releaseDueSnoozes } from './recommendations.js';

// 看板/digest 单一构建器：/api/digest 与 /internal/digest 共用，
// 分桶口径与 litigation-brief 一致：🔴≤3日(含逾期) / 🟠4–7日 / 🟡8–30日+无在追期限 / 📅7日内开庭。
export function buildDigest() {
  const today = todayCN();
  const d3 = addDays(today, 3);
  const d7 = addDays(today, 7);
  const d30 = addDays(today, 30);

  // snooze 到期只唤回原行，不生成第二条推荐。
  releaseDueSnoozes();

  const dl = (from, to) =>
    db
      .prepare(
        `SELECT d.*, c.name AS case_name FROM deadlines d JOIN cases c ON c.id = d.case_id
         WHERE d.status = 'pending' AND c.status = 'active' AND d.due_on > ? AND d.due_on <= ?
         ORDER BY d.due_on, d.severity = 'critical' DESC`
      )
      .all(from, to)
      .map((r) => ({ ...r, days_left: diffDays(today, r.due_on) }));

  const overdueAndRed = db
    .prepare(
      `SELECT d.*, c.name AS case_name FROM deadlines d JOIN cases c ON c.id = d.case_id
       WHERE d.status = 'pending' AND c.status = 'active' AND d.due_on <= ?
       ORDER BY d.due_on, d.severity = 'critical' DESC`
    )
    .all(d3)
    .map((r) => ({ ...r, days_left: diffDays(today, r.due_on) }));

  const noDeadlineCases = db
    .prepare(
      `SELECT c.id, c.name, c.procedure, c.stage FROM cases c
       WHERE c.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM deadlines d WHERE d.case_id = c.id AND d.status = 'pending')
         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.case_id = c.id AND e.type = 'hearing' AND e.occurred_on >= ?)
       ORDER BY c.updated_at`
    )
    .all(today);

  const hearings = db
    .prepare(
      `SELECT e.*, c.name AS case_name FROM events e JOIN cases c ON c.id = e.case_id
       WHERE e.type = 'hearing' AND c.status = 'active' AND e.occurred_on >= ? AND e.occurred_on <= ?
       ORDER BY e.occurred_on`
    )
    .all(today, d7)
    .map((r) => ({ ...r, is_today: r.occurred_on === today }));

  const todayTasks = db
    .prepare(
      `SELECT t.*, c.name AS case_name FROM tasks t LEFT JOIN cases c ON c.id = t.case_id
       WHERE t.status = 'open' AND (
         (t.plan_date != '' AND t.plan_date <= ?) OR (t.due_on != '' AND t.due_on <= ?)
       )
       ORDER BY t.priority = 'high' DESC, COALESCE(NULLIF(t.due_on, ''), t.plan_date)`
    )
    .all(today, d3);

  // 三层待办的分层口径（确定性，不碰 LLM）：effective date = due_on 优先，否则 plan_date。
  // 今日（todayTasks，上）：plan_date 到期或 due 在 3 日内（1.8 前「今日+临期」既有口径，不改）；
  // 本周：今日之外、effective ≤ today+7——故须排除 due_on≤d3（那些已被今日层「due 临近」吃走），
  //       才能与今日严格互斥；
  // 全部（allOpenTasks）：所有 open，effective 为空者沉底（标「未排期」）。
  // 今日/本周互斥，二者都是全部的子集；三层均不过滤 case.status（无挂案件的全所待办也照显）。
  const weekTasks = db
    .prepare(
      `SELECT t.*, c.name AS case_name FROM tasks t LEFT JOIN cases c ON c.id = t.case_id
       WHERE t.status = 'open'
         AND COALESCE(NULLIF(t.due_on, ''), NULLIF(t.plan_date, '')) > ?
         AND COALESCE(NULLIF(t.due_on, ''), NULLIF(t.plan_date, '')) <= ?
         AND (t.due_on = '' OR t.due_on > ?)
       ORDER BY COALESCE(NULLIF(t.due_on, ''), t.plan_date), t.priority = 'high' DESC, t.id`
    )
    .all(today, d7, d3);

  const allOpenTasks = db
    .prepare(
      `SELECT t.*, c.name AS case_name FROM tasks t LEFT JOIN cases c ON c.id = t.case_id
       WHERE t.status = 'open'
       ORDER BY COALESCE(NULLIF(t.due_on, ''), NULLIF(t.plan_date, ''), '9999-12-31'),
                t.priority = 'high' DESC, t.id`
    )
    .all();

  // 💰 待收款：有到期日且 30 日内（或已逾期）的未收款项
  const feesDue = db
    .prepare(
      `SELECT f.*, c.name AS case_name FROM fee_items f JOIN cases c ON c.id = f.case_id
       WHERE f.status = 'unpaid' AND f.due_on != '' AND f.due_on <= ?
       ORDER BY f.due_on`
    )
    .all(d30)
    .map((r) => ({ ...r, days_left: diffDays(today, r.due_on) }));

  // 🤝 待分成：应于本月（含更早）完成而未完成的分成——每天出现直到 settled/waived。
  // 口径写死：status='pending' AND due_month <= 本月；due_month < 本月 ⇒ overdue 标记。
  // 不设时间下限：跨月逾期常驻，不会月初「断崖消失」（与 digest 心跳纪律一致）。
  // 投影收窄：digest 会透到 /internal（LLM 读取面），只出方向+姓名+金额+月份+案件名——
  // note 等自由文本不出此面，也不 JOIN contacts 颗粒字段。
  const monthKey = today.slice(0, 7);
  const sharesPending = db.prepare(
    `SELECT s.id, s.direction, s.counterpart, s.amount, s.due_month, s.external_case,
            c.name AS case_name
     FROM fee_shares s LEFT JOIN cases c ON c.id = s.case_id
     WHERE s.is_void = 0 AND s.cancelled_at = ''
       AND s.status = 'pending' AND s.due_month <= ?
     ORDER BY s.due_month, s.id`
  ).all(monthKey).map((r) => ({ ...r, overdue: r.due_month < monthKey }));

  const counts = {
    active_cases: db.prepare("SELECT COUNT(*) c FROM cases WHERE status = 'active'").get().c,
    inbox_pending: db.prepare("SELECT COUNT(*) c FROM inbox WHERE status = 'pending'").get().c,
    open_tasks: db.prepare("SELECT COUNT(*) c FROM tasks WHERE status = 'open'").get().c,
    unpaid_fees: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM fee_items WHERE status = 'unpaid' AND amount IS NOT NULL").get().s,
  };

  return {
    date: today,
    counts,
    red: overdueAndRed,          // 🔴 逾期 + ≤3 日
    week: dl(d3, d7),            // 🟠 4–7 日
    watch: dl(d7, d30),          // 🟡 8–30 日
    no_deadline_cases: noDeadlineCases, // 🟡 ❓无在追期限（检查是否漏录）
    hearings,                    // 📅 7 日内开庭
    today_tasks: todayTasks,     // ✅ 今日计划（plan_date 到期或 due 临近的待办）
    week_tasks: weekTasks,       // ✅ 本周待办（今日 < effective ≤ today+7，与今日互斥）
    all_tasks: allOpenTasks,     // ✅ 全部未结待办（兜底，含无日期「未排期」项）
    fees_due: feesDue,           // 💰 待收款（有到期日、30 日内或逾期）
    shares_pending: sharesPending, // 🤝 待分成（本月+逾期）
  };
}
