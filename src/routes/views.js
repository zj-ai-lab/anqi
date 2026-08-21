import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, audit, withImmediateTransaction } from '../db.js';
import { todayCN, isDate } from '../lib/dates.js';
import { buildDigest } from '../lib/digest.js';
import { eventTypes, stageTemplates, procedures } from '../lib/vocab.js';
import { deriveForEvent, rulesSummary } from '../lib/engine.js';
import { llmReady } from '../lib/llm.js';
import { releaseDueSnoozes } from '../lib/recommendations.js';
import { agentReady } from '../agent/config.js';

const r = Router();

function isTaskTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

// 版本单一事实源 = package.json。页面/镜像标签一律引它，别再手抄
// （历史教训：profile 卡先后写过 v1.0.0 / v0.2.0，都与实际不符）。
const VERSION = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8')
).version;

r.get('/meta', (req, res) => {
  res.json({
    version: VERSION,
    event_types: eventTypes,
    stage_templates: stageTemplates,
    procedures,
    severities: ['critical', 'high', 'normal'],
    deadline_rules: rulesSummary(),
  });
});

r.get('/counts', (req, res) => {
  releaseDueSnoozes();
  res.json({
    version: VERSION,
    inbox_pending: db.prepare("SELECT COUNT(*) c FROM inbox WHERE status = 'pending'").get().c,
    active_cases: db.prepare("SELECT COUNT(*) c FROM cases WHERE status = 'active'").get().c,
    // 快录条搭这趟顺风车做特性探测：没配 key 就不渲染「整理」按钮，
    // 免得页面上摆一个点了必失败的控件（零额外请求——nav.js 本来就要拉 counts）
    llm: llmReady(),
    // AI 助理 sidecar 同一种特性探测模式：agent_enabled 且 apiKeyEnv 指向的
    // 环境变量确实有值才算"可用"，前端下阶段据此决定是否渲染案件 assistant
    // drawer 入口；这里只回答布尔值，不返回 provider/model/apiKeyEnv 等任何
    // 配置细节（那些细节走 GET /api/agent/status，且同样不含 key 值）。
    agent: agentReady(),
  });
});

r.get('/digest', (req, res) => res.json(buildDigest()));

// 数据统计（1.0.1）。全部现算，不建汇总表——库是 MB 级，全表扫比维护缓存便宜也不会算错。
// 口径写在字段名旁边，页面直接引用，免得图表和数字各说各话。
r.get('/stats', (req, res) => {
  const today = todayCN();
  const year = today.slice(0, 4);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);

  // ── 期限履约：只看「本年度已到期」的期限，未到期的不参与分母（否则完成率被稀释成没意义的数） ──
  // ⚠ done_at 是 datetime（'2026-07-13 09:00:00'），due_on 是 date（'2026-07-13'）。
  // 直接字符串比大小的话，「当天完成」会因为串更长而被判成逾期——踩着死线做完是最常见的情形，
  // 那样会系统性低报合规率。所以一律取 done_at 的前 10 位（日期部分）再比。
  const dl = one(`
    SELECT
      COUNT(*) AS due_total,
      SUM(CASE WHEN status='done' AND done_at IS NOT NULL AND substr(done_at,1,10) <= due_on THEN 1 ELSE 0 END) AS on_time,
      SUM(CASE WHEN status='done' AND (done_at IS NULL OR substr(done_at,1,10) >  due_on) THEN 1 ELSE 0 END) AS late_done,
      SUM(CASE WHEN status='missed' OR (status='pending' AND due_on < ?)     THEN 1 ELSE 0 END) AS missed,
      SUM(CASE WHEN status='waived' THEN 1 ELSE 0 END) AS waived
    FROM deadlines WHERE due_on <= ? AND substr(due_on,1,4) = ?`, today, today, year);
  const dueTotal = dl.due_total || 0;
  const compliance = dueTotal ? Math.round(((dl.on_time || 0) / dueTotal) * 100) : null; // 无已到期期限时为 null，页面显示「—」而不是假的 100%

  // ── 案件 ──
  const byStatus = all("SELECT status, COUNT(*) c FROM cases GROUP BY status");
  const byCause = all("SELECT COALESCE(NULLIF(cause,''),'未填') AS k, COUNT(*) c FROM cases GROUP BY k ORDER BY c DESC, k");
  const byStage = all("SELECT stage AS k, COUNT(*) c FROM cases WHERE status='active' GROUP BY k ORDER BY c DESC, k");
  const closedThisYear = one(
    "SELECT COUNT(*) c FROM cases WHERE status='closed' AND substr(COALESCE(updated_at,created_at),1,4) = ?", year).c;

  // ── 近 6 个月收结案趋势（含本月）。月份在 JS 里生成，SQL 只做归并 ──
  const months = [];
  const [y0, m0] = [Number(year), Number(today.slice(5, 7))];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(y0, m0 - 1 - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const monthMap = (rows) => months.map((m) => (rows.find((r) => r.k === m) || {}).c || 0);
  const opened = monthMap(all(
    "SELECT substr(COALESCE(NULLIF(accepted_at,''),created_at),1,7) AS k, COUNT(*) c FROM cases GROUP BY k"));
  const closed = monthMap(all(
    "SELECT substr(COALESCE(updated_at,created_at),1,7) AS k, COUNT(*) c FROM cases WHERE status='closed' GROUP BY k"));
  const paidByMonth = monthMap(all(
    "SELECT substr(paid_on,1,7) AS k, SUM(amount) c FROM fee_items WHERE status='paid' AND paid_on IS NOT NULL AND paid_on != '' GROUP BY k"));

  // ── 律师费。amount 为 null = 金额待定，不计入任何求和（fees.js 同口径） ──
  const fee = one(`
    SELECT
      SUM(CASE WHEN status='paid'   AND amount IS NOT NULL THEN amount ELSE 0 END) AS paid_total,
      SUM(CASE WHEN status='paid'   AND amount IS NOT NULL AND substr(paid_on,1,4)=? THEN amount ELSE 0 END) AS paid_year,
      SUM(CASE WHEN status='unpaid' AND amount IS NOT NULL THEN amount ELSE 0 END) AS unpaid_total,
      SUM(CASE WHEN status='unpaid' AND amount IS NULL THEN 1 ELSE 0 END) AS tbd_count
    FROM fee_items`, year);
  // 分成口径（权责发生制）：按 due_month 归属年份，pending+settled 都算、waived 不算。
  const share = one(`
    SELECT
      SUM(CASE WHEN direction='payable'    AND substr(due_month,1,4)=? THEN amount ELSE 0 END) AS payable_year,
      SUM(CASE WHEN direction='receivable' AND substr(due_month,1,4)=? THEN amount ELSE 0 END) AS receivable_year
    FROM fee_shares
    WHERE is_void = 0 AND cancelled_at = '' AND status IN ('pending','settled')`, year, year);
  const sharePayableYear = share.payable_year || 0;
  const shareReceivableYear = share.receivable_year || 0;
  // 应收账龄（只看 unpaid 且有金额；无 due_on 的归「未到期」——没约定到期日就谈不上逾期）
  const aging = one(`
    SELECT
      SUM(CASE WHEN due_on IS NULL OR due_on='' OR due_on >= ? THEN amount ELSE 0 END) AS not_due,
      SUM(CASE WHEN due_on <  ? AND julianday(?)-julianday(due_on) <= 30 THEN amount ELSE 0 END) AS d30,
      SUM(CASE WHEN julianday(?)-julianday(due_on) > 30 AND julianday(?)-julianday(due_on) <= 90 THEN amount ELSE 0 END) AS d90,
      SUM(CASE WHEN julianday(?)-julianday(due_on) > 90 THEN amount ELSE 0 END) AS d90p
    FROM fee_items WHERE status='unpaid' AND amount IS NOT NULL`,
  today, today, today, today, today, today);

  res.json({
    as_of: today,
    year,
    deadlines: {
      due_total: dueTotal,               // 本年度已到期期限数（分母）
      on_time: dl.on_time || 0,          // 按期完成
      late_done: dl.late_done || 0,      // 逾期后补做
      missed: dl.missed || 0,            // 已错过·未完成（含 pending 但已过期）
      waived: dl.waived || 0,
      compliance,                        // 按期完成率 %，无已到期期限时为 null
    },
    cases: {
      total: byStatus.reduce((a, r) => a + r.c, 0),
      active: (byStatus.find((r) => r.status === 'active') || {}).c || 0,
      shelved: (byStatus.find((r) => r.status === 'shelved') || {}).c || 0,
      closed: (byStatus.find((r) => r.status === 'closed') || {}).c || 0,
      closed_this_year: closedThisYear,
      by_cause: byCause.map((r) => ({ label: r.k, count: r.c })),
      by_stage: byStage.map((r) => ({ label: r.k, count: r.c })),
    },
    trend: { months, opened, closed, paid: paidByMonth },
    fees: {
      paid_total: fee.paid_total || 0,
      paid_year: fee.paid_year || 0,
      unpaid_total: fee.unpaid_total || 0,
      tbd_count: fee.tbd_count || 0,
      share_payable_year: sharePayableYear,
      share_receivable_year: shareReceivableYear,
      net_year: (fee.paid_year || 0) - sharePayableYear + shareReceivableYear,
      aging: {
        not_due: aging.not_due || 0,
        overdue_30: aging.d30 || 0,
        overdue_90: aging.d90 || 0,
        overdue_90p: aging.d90p || 0,
      },
    },
  });
});

r.get('/calendar', (req, res) => {
  const month = req.query.month || todayCN().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month 须为 YYYY-MM' });
  const like = month + '-%';
  const [year, monthNumber] = month.split('-').map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  const holidays = {};
  for (const h of db.prepare('SELECT date, kind FROM holidays WHERE date LIKE ?').all(like)) {
    holidays[h.date] = h.kind;
  }
  res.json({
    month,
    holidays, // {date: 'holiday'|'workday'} 供月历底色

    deadlines: db.prepare(
      `SELECT d.id, d.name, d.due_on, d.severity, d.status, d.case_id, c.name AS case_name
       FROM deadlines d JOIN cases c ON c.id = d.case_id WHERE d.due_on LIKE ? ORDER BY d.due_on`
    ).all(like),
    hearings: db.prepare(
      `SELECT e.id, e.occurred_on, e.note, e.case_id, c.name AS case_name
       FROM events e JOIN cases c ON c.id = e.case_id WHERE e.type = 'hearing' AND e.occurred_on LIKE ? ORDER BY e.occurred_on`
    ).all(like),
    // status 不过滤 —— 全状态返回（open/done/dropped），前端按筛选器决定画不画、
    // done/dropped 叠 .cal-chip.done 灰显划线（与 deadlines 同一套 chipClass 模式）。
    tasks: db.prepare(
      `SELECT t.id, t.title, t.plan_date, t.due_on, t.due_time, t.status, t.case_id, c.name AS case_name
       FROM tasks t LEFT JOIN cases c ON c.id = t.case_id
       WHERE t.due_on LIKE ?
          OR (t.plan_date <> '' AND t.due_on <> '' AND t.plan_date <= ? AND t.due_on >= ?)
       ORDER BY t.due_on, CASE WHEN t.due_time = '' THEN 1 ELSE 0 END, t.due_time, t.id`
    ).all(like, monthEnd, monthStart),
  });
});

// ---------- 收件箱（P1 triage：accept 才落正式表）----------
r.get('/inbox', (req, res) => {
  releaseDueSnoozes();
  const status = req.query.status || 'pending';
  res.json(
    db.prepare(
      `SELECT i.*, c.name AS case_name FROM inbox i LEFT JOIN cases c ON c.id = i.case_id
       WHERE i.status = ? ORDER BY i.created_at DESC`
    ).all(status)
  );
});

r.post('/inbox/:id/accept', (req, res) => {
  const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '收件不存在' });
  if (row.status !== 'pending') return res.status(409).json({ error: '该收件已裁决' });
  let payload;
  try {
    const stored = JSON.parse(row.payload);
    const override = req.body?.payload || {};
    if (!override || typeof override !== 'object' || Array.isArray(override)) {
      return res.status(400).json({ error: 'payload 修改须为对象' });
    }
    if (override && typeof override === 'object' && Object.hasOwn(override, 'case_id')
      && row.case_id && Number(override.case_id) !== Number(row.case_id)) {
      return res.status(400).json({ error: '不能把收件改投到其他案件' });
    }
    payload = { ...stored, ...override };
  } catch {
    return res.status(400).json({ error: 'payload 不是合法 JSON' });
  }
  if (payload.case_id && row.case_id && Number(payload.case_id) !== Number(row.case_id)) {
    return res.status(400).json({ error: '收件 payload.case_id 与所属案件不一致' });
  }
  const caseId = row.case_id || payload.case_id || null;
  try {
    const created = withImmediateTransaction(() => {
      const fresh = db.prepare('SELECT status FROM inbox WHERE id=?').get(row.id);
      if (fresh?.status !== 'pending') {
        const error = new Error('该收件已裁决');
        error.code = 'inbox_decided';
        throw error;
      }
      let result;
      if (row.kind === 'event') {
        if (!caseId) throw new Error('event 收件缺 case_id');
        if (!isDate(payload.occurred_on)) throw new Error('occurred_on 非法');
        const type = payload.type || 'other';
        const existing = db.prepare(
          'SELECT id FROM events WHERE case_id=? AND type=? AND occurred_on=? ORDER BY id LIMIT 1'
        ).get(caseId, type, payload.occurred_on);
        if (existing) {
          result = { entity: 'event', id: existing.id, linked_existing: true, derived: { deadlines: [], tasks: [] } };
        } else {
          const info = db.prepare(
            `INSERT INTO events (case_id, type, occurred_on, service_method, instrument, note, created_by)
             VALUES (?, ?, ?, ?, ?, ?, 'llm')`
          ).run(caseId, type, payload.occurred_on, payload.service_method || '', payload.instrument || '', payload.note || '');
          const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(info.lastInsertRowid);
          const cs = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
          result = { entity: 'event', id: info.lastInsertRowid, linked_existing: false, derived: deriveForEvent(ev, cs, req.actor) };
        }
      } else if (row.kind === 'deadline') {
        // 仅兼容 migration 011 前已经存在的历史收件；/internal 已禁止新建 deadline。
        if (!caseId) throw new Error('deadline 收件缺 case_id');
        if (!payload.name || !isDate(payload.due_on)) throw new Error('name/due_on 非法');
        const existing = db.prepare(
          'SELECT id FROM deadlines WHERE case_id=? AND TRIM(name)=? AND due_on=? ORDER BY id LIMIT 1'
        ).get(caseId, String(payload.name).trim(), payload.due_on);
        if (existing) {
          result = { entity: 'deadline', id: existing.id, linked_existing: true };
        } else {
          const info = db.prepare(
            `INSERT INTO deadlines (case_id, name, due_on, basis, calc_note, is_manual_override, severity)
             VALUES (?, ?, ?, ?, ?, 1, ?)`
          ).run(caseId, payload.name, payload.due_on, payload.basis || '', payload.calc_note || `采纳自收件 #${row.id}（${row.source}）`,
            ['critical', 'high', 'normal'].includes(payload.severity) ? payload.severity : 'normal');
          result = { entity: 'deadline', id: info.lastInsertRowid, linked_existing: false };
        }
      } else if (row.kind === 'task') {
        const title = String(payload.title || '').trim();
        if (!title) throw new Error('title 非法');
        const planDate = payload.plan_date || '';
        const dueOn = payload.due_on || '';
        const dueTime = payload.due_time || '';
        for (const [field, value] of [['plan_date', planDate], ['due_on', dueOn]]) {
          if (value && !isDate(value)) throw new Error(`${field} 非法`);
        }
        if (planDate && dueOn && planDate > dueOn) throw new Error('plan_date 不得晚于 due_on');
        if (dueTime && (!isTaskTime(dueTime) || !dueOn)) throw new Error('due_time 非法或缺少 due_on');
        const existing = db.prepare(
          "SELECT id FROM tasks WHERE case_id IS ? AND TRIM(title)=? AND status='open' ORDER BY id LIMIT 1"
        ).get(caseId || null, title);
        if (existing) {
          result = { entity: 'task', id: existing.id, linked_existing: true };
        } else {
          const info = db.prepare(
            `INSERT INTO tasks (case_id, title, plan_date, due_on, due_time, priority, origin, note)
             VALUES (?, ?, ?, ?, ?, ?, 'llm', ?)`
          ).run(caseId || null, title, planDate, dueOn, dueTime,
            ['high', 'normal', 'low'].includes(payload.priority) ? payload.priority : 'normal', payload.note || '');
          result = { entity: 'task', id: info.lastInsertRowid, linked_existing: false };
        }
      } else {
        const info = db.prepare('INSERT INTO worklog (case_id, worked_on, content) VALUES (?, ?, ?)')
          .run(caseId || null, todayCN(), payload.content || payload.text || row.payload);
        result = { entity: 'worklog', id: info.lastInsertRowid, linked_existing: false };
      }

      const decided = db.prepare(
        `UPDATE inbox SET status='accepted',accepted_entity=?,accepted_entity_id=?,
           snooze_until='',decision_reason='',decided_at=datetime('now','+8 hours')
         WHERE id=? AND status='pending'`
      ).run(result.entity, result.id, row.id);
      if (decided.changes !== 1) {
        const error = new Error('该收件已裁决');
        error.code = 'inbox_decided';
        throw error;
      }
      audit(req.actor, 'inbox-accept', result.entity, result.id, `inbox #${row.id} (${row.source})`);
      return result;
    });
    res.json({ ok: true, created });
  } catch (error) {
    res.status(error.code === 'inbox_decided' ? 409 : 400).json({ error: error.message, code: error.code || 'inbox_invalid' });
  }
});

r.post('/inbox/:id/decline', (req, res) => {
  const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '收件不存在' });
  if (row.status !== 'pending') return res.status(409).json({ error: '该收件已裁决' });
  const reason = String(req.body?.reason || '用户选择不再建议').trim().slice(0, 200);
  try {
    withImmediateTransaction(() => {
      const info = db.prepare(
        `UPDATE inbox SET status='declined',snooze_until='',decision_reason=?,decided_at=datetime('now','+8 hours')
          WHERE id=? AND status='pending'`
      ).run(reason, row.id);
      if (info.changes !== 1) {
        const error = new Error('该收件已裁决');
        error.code = 'inbox_decided';
        throw error;
      }
      audit(req.actor, 'inbox-decline', 'inbox', row.id, row.source);
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(error.code === 'inbox_decided' ? 409 : 400).json({ error: error.message });
  }
});

r.post('/inbox/:id/snooze', (req, res) => {
  const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '收件不存在' });
  if (row.status !== 'pending') return res.status(409).json({ error: '该收件已裁决' });
  const until = req.body?.until;
  if (!isDate(until)) return res.status(400).json({ error: 'until 须为 YYYY-MM-DD' });
  if (until <= todayCN()) return res.status(400).json({ error: '延后日期必须晚于今天' });
  const reason = String(req.body?.reason || `延后至 ${until}`).trim().slice(0, 200);
  try {
    withImmediateTransaction(() => {
      const info = db.prepare(
        `UPDATE inbox SET status='snoozed',snooze_until=?,decision_reason=?
          WHERE id=? AND status='pending'`
      ).run(until, reason, row.id);
      if (info.changes !== 1) {
        const error = new Error('该收件已裁决');
        error.code = 'inbox_decided';
        throw error;
      }
      audit(req.actor, 'inbox-snooze', 'inbox', row.id, until);
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(error.code === 'inbox_decided' ? 409 : 400).json({ error: error.message });
  }
});

export default r;
