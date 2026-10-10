import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, audit, withChangeContext } from '../db.js';
import { todayCN, isDate } from '../lib/dates.js';
import { isEventType } from '../lib/vocab.js';
import { deriveForEvent, recalcPreview, applyRecalc, recomputeForDeadline, hasManualParams, enrichDeadlineRow } from '../lib/engine.js';
import { suggestPrecondition, PRECONDITION_SUGGESTION_REASON } from '../lib/precondition-suggest.js';
import { parseQuick, llmReady } from '../lib/llm.js';
import {
  MAX_STAGING_BYTES, STAGING_DIR, cleanupStaging, detectMime, extractDocument, readStaged, stageBuffer,
} from '../lib/doc-intake.js';
import { legalRagBridgeConfigured, queueCaseFile } from '../lib/legalrag-bridge.js';
import { resolveCaseDirectoryForCase, writeUniqueSecureFile } from '../lib/secure-files.js';

const r = Router();


function isTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function normalizedTaskDate(value) {
  return value ?? '';
}

function recordError(message, status = 400, code = 'record_invalid') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function caseForWrite(caseId) {
  const c = db.prepare('SELECT id, name FROM cases WHERE id = ?').get(caseId);
  if (!c) throw recordError('案件不存在', 404, 'case_not_found');
  return c;
}

function responseError(res, error) {
  return res.status(error.status || 400).json({ error: error.message, code: error.code || 'record_invalid' });
}

function taskView(id) {
  return db.prepare('SELECT *, origin AS created_by FROM tasks WHERE id = ?').get(id);
}

const FILES_ROOT = process.env.ANJIAN_FILES_ROOT || '';

export function createEventRecord({ caseId, payload, actor = 'web', createdBy = 'manual' }) {
  const c = caseForWrite(caseId);
  const b = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  if (!isEventType(b.type)) throw recordError('type 非法（见 /api/meta 词表）');
  if (!isDate(b.occurred_on)) throw recordError('occurred_on 须为 YYYY-MM-DD');
  const occurredTime = b.occurred_time === undefined || b.occurred_time === null ? '' : String(b.occurred_time);
  if (occurredTime && !isTime(occurredTime)) throw recordError('occurred_time 须为 HH:MM');
  const location = String(b.location || '').trim().slice(0, 120);
  const normalizedCreatedBy = ['manual', 'llm', 'import'].includes(createdBy) ? createdBy : 'manual';
  // 身份上下文与业务写同事务（024）：事件、引擎派生出的期限/待办一起记到同一个 actor 名下。
  // 本函数被 HTTP 路由与 agent 直写共用，包在这里两边都覆盖，不必各自记得包一次。
  return withChangeContext({ actor }, () => {
    const info = db.prepare(
      `INSERT INTO events (case_id, type, occurred_on, occurred_time, location, service_method, instrument, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      c.id, b.type, b.occurred_on, occurredTime, location, String(b.service_method || ''), String(b.instrument || ''),
      String(b.note || ''), normalizedCreatedBy
    );
    audit(actor, 'create', 'event', info.lastInsertRowid, `${c.name} ${b.type} ${b.occurred_on}`);
    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(info.lastInsertRowid);
    const caseRow = db.prepare('SELECT * FROM cases WHERE id = ?').get(c.id);
    const derived = deriveForEvent(row, caseRow, actor);
    const precondition_suggestion = suggestPrecondition(b.type, caseRow);
    return { row, derived, precondition_suggestion };
  });
}

export function createDeadlineRecord({
  caseId,
  payload,
  actor = 'web',
  createdBy = 'manual',
  reviewStatus = 'confirmed',
}) {
  const c = caseForWrite(caseId);
  const b = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  if (!b.name || !String(b.name).trim()) throw recordError('name 必填');
  if (!isDate(b.due_on)) throw recordError('due_on 须为 YYYY-MM-DD');
  const severity = ['critical', 'high', 'normal'].includes(b.severity) ? b.severity : 'normal';
  const triggerEventId = b.trigger_event_id || null;
  if (triggerEventId) {
    const event = db.prepare('SELECT id,case_id FROM events WHERE id=?').get(triggerEventId);
    if (!event) throw recordError('触发事件不存在', 404, 'event_not_found');
    if (event.case_id !== c.id) throw recordError('触发事件不属于该案件', 400, 'event_case_mismatch');
  }
  const normalizedCreatedBy = ['manual', 'ai', 'engine', 'import'].includes(createdBy) ? createdBy : 'manual';
  const normalizedReview = reviewStatus === 'pending_review' ? 'pending_review' : 'confirmed';
  return withChangeContext({ actor }, () => {
    const info = db.prepare(
      `INSERT INTO deadlines
        (case_id, name, due_on, trigger_event_id, basis, calc_note, is_manual_override, severity, review_status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).run(
      c.id, String(b.name).trim(), b.due_on, triggerEventId,
      String(b.basis || ''), String(b.calc_note || ''), severity, normalizedReview, normalizedCreatedBy
    );
    audit(actor, 'create', 'deadline', info.lastInsertRowid, `${c.name} ${String(b.name).trim()} ${b.due_on}`);
    return enrichDeadlineRow(db.prepare('SELECT * FROM deadlines WHERE id = ?').get(info.lastInsertRowid));
  });
}

export function createTaskRecord({ caseId = null, payload, actor = 'web', origin = 'manual' }) {
  const b = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  if (!b.title || !String(b.title).trim()) throw recordError('title 必填');
  const normalizedCaseId = caseId === null || caseId === undefined || caseId === '' ? null : Number(caseId);
  if (normalizedCaseId !== null) caseForWrite(normalizedCaseId);
  const planDate = normalizedTaskDate(b.plan_date);
  const dueOn = normalizedTaskDate(b.due_on);
  const dueTime = normalizedTaskDate(b.due_time);
  for (const [field, value] of [['plan_date', planDate], ['due_on', dueOn]]) {
    if (value !== '' && !isDate(value)) throw recordError(`${field} 须为 YYYY-MM-DD`);
  }
  if (planDate && dueOn && planDate > dueOn) throw recordError('plan_date 不得晚于 due_on');
  if (dueTime !== '' && !isTime(dueTime)) throw recordError('due_time 须为 HH:MM');
  if (dueTime && !dueOn) throw recordError('due_time 需要先填写 due_on');
  const deadlineId = b.deadline_id || null;
  if (deadlineId) {
    const deadline = db.prepare('SELECT id,case_id FROM deadlines WHERE id=?').get(deadlineId);
    if (!deadline) throw recordError('关联期限不存在', 404, 'deadline_not_found');
    if (deadline.case_id !== normalizedCaseId) throw recordError('关联期限不属于该案件', 400, 'deadline_case_mismatch');
  }
  const normalizedOrigin = ['manual', 'template', 'llm'].includes(origin) ? origin : 'manual';
  return withChangeContext({ actor }, () => {
    const info = db.prepare(
      `INSERT INTO tasks (case_id, title, plan_date, due_on, due_time, deadline_id, stage, priority, origin, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      normalizedCaseId, String(b.title).trim(), planDate, dueOn, dueTime, deadlineId,
      String(b.stage || ''), ['high', 'normal', 'low'].includes(b.priority) ? b.priority : 'normal',
      normalizedOrigin, String(b.note || '')
    );
    audit(actor, 'create', 'task', info.lastInsertRowid, String(b.title).trim());
    return taskView(info.lastInsertRowid);
  });
}

// ---------- events ----------
r.post('/cases/:id/events', (req, res) => {
  try {
    const { row, derived, precondition_suggestion } = createEventRecord({
      caseId: Number(req.params.id),
      payload: req.body,
      actor: req.actor,
      createdBy: ['manual', 'llm', 'import'].includes(req.body?.created_by) ? req.body.created_by : 'manual',
    });
    const coverage_warnings = (derived.deadlines || [])
      .filter((deadline) => deadline.coverage_warning)
      .map((deadline) => ({
        name: deadline.name,
        due_on: deadline.due_on,
        missing_years: deadline.coverage_missing_years || [],
      }));
    res.json({ ...row, derived, ...(coverage_warnings.length ? { coverage_warnings } : {}), ...(precondition_suggestion ? { precondition_suggestion } : {}) });
  } catch (error) {
    responseError(res, error);
  }
});

r.patch('/events/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '事件不存在' });
  const b = req.body || {};

  // 改触发日期 → 级联重算，先出预览、confirm 才落库（D4：人工覆盖默认排除）
  const dateChanging = 'occurred_on' in b && b.occurred_on !== row.occurred_on;
  let recalc = null;
  if (dateChanging) {
    if (!isDate(b.occurred_on)) return res.status(400).json({ error: '日期非法' });
    const preview = recalcPreview(row, b.occurred_on);
    if ((preview.recalc.length || preview.excluded.length) && b.confirm !== true) {
      return res.json({
        needs_confirm: true,
        event: { id: row.id, old_date: row.occurred_on, new_date: b.occurred_on },
        ...preview,
      });
    }
    if (b.confirm === true) recalc = preview;
  }

  const sets = [];
  const args = [];
  for (const f of ['type', 'occurred_on', 'occurred_time', 'location', 'service_method', 'instrument', 'note']) {
    if (!(f in b)) continue;
    if (f === 'type' && !isEventType(b.type)) return res.status(400).json({ error: 'type 非法' });
    if (f === 'occurred_on' && !isDate(b.occurred_on)) return res.status(400).json({ error: '日期非法' });
    if (f === 'occurred_time' && b.occurred_time !== '' && !isTime(b.occurred_time)) return res.status(400).json({ error: '时刻须为 HH:MM' });
    sets.push(`${f} = ?`);
    args.push(f === 'location' ? String(b[f] || '').trim().slice(0, 120) : (b[f] ?? ''));
  }
  if (!sets.length) return res.status(400).json({ error: '无可更新字段' });
  withChangeContext({ actor: req.actor }, () => {
    if (recalc) applyRecalc(recalc, req.actor);
    db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...args, row.id);
    audit(req.actor, 'update', 'event', row.id, Object.keys(b).join(','));
  });
  res.json(db.prepare('SELECT * FROM events WHERE id = ?').get(row.id));
});

r.delete('/events/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '事件不存在' });
  const linked = db.prepare('SELECT COUNT(*) c FROM deadlines WHERE trigger_event_id = ?').get(row.id).c;
  if (linked) return res.status(409).json({ error: `有 ${linked} 条期限挂在该事件上，先处理期限` });
  withChangeContext({ actor: req.actor }, () => {
    db.prepare('DELETE FROM events WHERE id = ?').run(row.id);
    audit(req.actor, 'delete', 'event', row.id, `${row.type} ${row.occurred_on}`);
  });
  res.json({ ok: true });
});

// ---------- deadlines（P0 全手动：is_manual_override=1，P1 引擎生成的才为 0）----------
r.post('/cases/:id/deadlines', (req, res) => {
  try {
    res.json(createDeadlineRecord({ caseId: Number(req.params.id), payload: req.body, actor: req.actor }));
  } catch (error) {
    responseError(res, error);
  }
});

r.post('/deadlines/:id/confirm-review', (req, res) => {
  const row = db.prepare('SELECT * FROM deadlines WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '期限不存在' });
  if (row.review_status === 'pending_review') {
    withChangeContext({ actor: req.actor }, () => {
      db.prepare("UPDATE deadlines SET review_status='confirmed' WHERE id=? AND review_status='pending_review'").run(row.id);
      audit(req.actor, 'confirm-review', 'deadline', row.id, `${row.name} ${row.due_on}`);
    });
  }
  res.json(enrichDeadlineRow(db.prepare('SELECT * FROM deadlines WHERE id = ?').get(row.id)));
});

// 手动调参（第一层）合法取值。允许空串＝清除该覆盖项，回归规则默认值。
const MANUAL_UNITS = ['natural_days', 'workdays', 'months', 'years'];
const MANUAL_COUNT_FROM = ['next_day', 'same_day'];
const MANUAL_ROLL = ['none', 'backward', 'forward'];
const MANUAL_FIELDS = ['manual_days', 'manual_unit', 'manual_count_from', 'manual_roll'];

r.patch('/deadlines/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM deadlines WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '期限不存在' });
  const b = req.body || {};
  const sets = [];
  const args = [];
  if (Object.hasOwn(b, 'criminal_roll_choice')) {
    if (Object.keys(b).length !== 1) return res.status(400).json({ error: '刑事节假日顺延选择请单独提交' });
    const value = b.criminal_roll_choice;
    if (value !== null && !['default', 'rolled'].includes(value)) {
      return res.status(400).json({ error: 'criminal_roll_choice 须为 default / rolled，或 null 清除' });
    }
    // 选择 §105 就回到参数计算；既有数量/单位和人工参数仍保留。
    const nextRow = { ...row, criminal_roll_choice: value };
    const next = recomputeForDeadline(nextRow);
    const option = next?.holiday_roll_option;
    if (!option?.applies) {
      return res.status(400).json({ error: '该期限不是当前适用的刑事节假日顺延期限' });
    }
    if (option.default_due === option.rolled_due) {
      return res.status(400).json({ error: '该期限顺延与否结果相同，无需选择' });
    }
    withChangeContext({ actor: req.actor, rule_id: row.rule_id }, () => {
      db.prepare(`UPDATE deadlines SET criminal_roll_choice=?, due_on=?, rolled_from=?, calc_note=? WHERE id=?`)
        .run(value, next.due_on, next.rolled_from || '', next.calc_note, row.id);
      audit(req.actor, 'criminal-roll-choice', 'deadline', row.id, `${value ?? 'undecided'} → ${next.due_on}`);
    });
    return res.json(enrichDeadlineRow(db.prepare('SELECT * FROM deadlines WHERE id=?').get(row.id)));
  }
  for (const f of ['name', 'due_on', 'basis', 'calc_note', 'severity', 'status', 'override_reason']) {
    if (!(f in b)) continue;
    if (f === 'due_on' && !isDate(b.due_on)) return res.status(400).json({ error: '日期非法' });
    if (f === 'severity' && !['critical', 'high', 'normal'].includes(b.severity)) return res.status(400).json({ error: 'severity 非法' });
    if (f === 'status' && !['pending', 'done', 'missed', 'waived'].includes(b.status)) return res.status(400).json({ error: 'status 非法' });
    sets.push(`${f} = ?`);
    args.push(b[f] ?? '');
  }
  // ---- 手动调参四字段（2026-09-12 用户裁定「四项全开」）----
  // 改参数而不是改日期：届满日随后由引擎按新参数重算，"为什么是这个日期"始终可溯。
  const touchedManual = [];
  for (const f of MANUAL_FIELDS) {
    if (!(f in b)) continue;
    const v = b[f] === null || b[f] === undefined ? '' : b[f];
    if (f === 'manual_days') {
      if (v !== '' && (!Number.isInteger(Number(v)) || Number(v) < 0 || Number(v) > 3650)) {
        return res.status(400).json({ error: 'manual_days 须为 0–3650 的整数，或空串表示不覆盖' });
      }
      sets.push('manual_days = ?');
      args.push(v === '' ? null : Number(v));
    } else {
      const allowed = f === 'manual_unit' ? MANUAL_UNITS : f === 'manual_count_from' ? MANUAL_COUNT_FROM : MANUAL_ROLL;
      if (v !== '' && !allowed.includes(v)) {
        return res.status(400).json({ error: `${f} 取值非法（可选：${allowed.join(' / ')}，或空串清除）` });
      }
      sets.push(`${f} = ?`);
      args.push(v === '' ? '' : v);
    }
    touchedManual.push(f);
  }
  if (!sets.length) return res.status(400).json({ error: '无可更新字段' });
  // 人工改动到期日 → 标记 override（D4：级联重算默认排除）
  if ('due_on' in b && b.due_on !== row.due_on) {
    sets.push('is_manual_override = 1');
    sets.push("rolled_from = ''");
    sets.push('criminal_roll_choice = NULL');
    if (!touchedManual.length) {
      // 从参数计算转为直接指定日期：清掉参数，避免下次重算误当作参数型覆盖。
      sets.push('manual_days = NULL', "manual_unit = ''", "manual_count_from = ''", "manual_roll = ''");
    }
  }
  if (touchedManual.includes('manual_roll')) sets.push('criminal_roll_choice = NULL');
  if ('status' in b && b.status === 'done' && row.status !== 'done') {
    sets.push("done_at = datetime('now','+8 hours')");
  }
  let updated;
  // 身份上下文与业务写同事务：一次 PATCH 可能连改两轮（先落手动参数，再由引擎按参数
  // 重算届满日），两轮变更同属一个 actor，必须记在同一上下文里，故整段包起来。
  withChangeContext({ actor: req.actor }, () => {
    db.prepare(`UPDATE deadlines SET ${sets.join(', ')} WHERE id = ?`).run(...args, row.id);

    updated = db.prepare('SELECT * FROM deadlines WHERE id = ?').get(row.id);
    if (touchedManual.length) {
      // 先落参数，再用引擎按参数重算届满日；与 due_on 同时提交时以参数重算为准
      // （避免"改了参数又贴一个日期"的歧义：参数是唯一事实源）。
      const next = recomputeForDeadline(updated);
      if (next) {
        const stillManual = hasManualParams(updated) ? 1 : 0; // 清空全部参数＝回归引擎纯算状态
        db.prepare('UPDATE deadlines SET due_on = ?, rolled_from = ?, calc_note = ?, is_manual_override = ? WHERE id = ?')
          .run(next.due_on, next.rolled_from || '', next.calc_note, stillManual, row.id);
        updated = db.prepare('SELECT * FROM deadlines WHERE id = ?').get(row.id);
      }
      audit(req.actor, 'manual-params', 'deadline', row.id,
        `${touchedManual.join(',')} → ${updated.due_on}${updated.override_reason ? '｜理由：' + updated.override_reason : ''}`);
    }
    audit(req.actor, 'update', 'deadline', row.id, Object.keys(b).join(','));
  });
  res.json(enrichDeadlineRow(updated));
});

r.delete('/deadlines/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM deadlines WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '期限不存在' });
  withChangeContext({ actor: req.actor }, () => {
    // 解除挂靠与删除期限必须同事务：分开写会让中途失败的待办永远指着一个不存在的期限。
    db.prepare('UPDATE tasks SET deadline_id = NULL WHERE deadline_id = ?').run(row.id);
    db.prepare('DELETE FROM deadlines WHERE id = ?').run(row.id);
    audit(req.actor, 'delete', 'deadline', row.id, `${row.name} ${row.due_on}`);
  });
  res.json({ ok: true });
});

// ---------- tasks ----------
r.get('/tasks', (req, res) => {
  const { status = 'open', case_id } = req.query;
  const cond = [];
  const args = [];
  if (status !== 'all') { cond.push('t.status = ?'); args.push(status); }
  if (case_id) { cond.push('t.case_id = ?'); args.push(case_id); }
  const sql = `SELECT t.*, t.origin AS created_by, c.name AS case_name FROM tasks t LEFT JOIN cases c ON c.id = t.case_id
    ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
    ORDER BY COALESCE(NULLIF(t.due_on,''), NULLIF(t.plan_date,''), '9999'),
      CASE WHEN t.due_time = '' THEN 1 ELSE 0 END, t.due_time,
      t.priority = 'high' DESC, t.id DESC`;
  res.json(db.prepare(sql).all(...args));
});

r.post('/tasks', (req, res) => {
  try {
    const origin = ['manual', 'template', 'llm'].includes(req.body?.origin) ? req.body.origin : 'manual';
    res.json(createTaskRecord({ caseId: req.body?.case_id || null, payload: req.body, actor: req.actor, origin }));
  } catch (error) {
    responseError(res, error);
  }
});

r.patch('/tasks/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '待办不存在' });
  const b = req.body || {};
  const sets = [];
  const args = [];
  const hasPlanDate = Object.hasOwn(b, 'plan_date');
  const hasDueOn = Object.hasOwn(b, 'due_on');
  const hasDueTime = Object.hasOwn(b, 'due_time');
  let planDate = hasPlanDate ? normalizedTaskDate(b.plan_date) : row.plan_date;
  let dueOn = hasDueOn ? normalizedTaskDate(b.due_on) : row.due_on;
  let dueTime = hasDueTime ? normalizedTaskDate(b.due_time) : row.due_time;
  let clampedPlanDate = false;
  let clampedDueOn = false;
  for (const [field, value] of [['plan_date', planDate], ['due_on', dueOn]]) {
    if (value !== '' && !isDate(value)) return res.status(400).json({ error: `${field} 须为 YYYY-MM-DD` });
  }
  if (hasPlanDate && hasDueOn && planDate && dueOn && planDate > dueOn) {
    return res.status(400).json({ error: 'plan_date 不得晚于 due_on' });
  }
  if (hasPlanDate && !hasDueOn && planDate && dueOn && planDate > dueOn) {
    dueOn = planDate;
    clampedDueOn = true;
  }
  if (!hasPlanDate && hasDueOn && planDate && dueOn && planDate > dueOn) {
    planDate = dueOn;
    clampedPlanDate = true;
  }
  if (dueTime !== '' && !isTime(dueTime)) return res.status(400).json({ error: 'due_time 须为 HH:MM' });
  if (dueTime && !dueOn && hasDueTime) return res.status(400).json({ error: 'due_time 需要先填写 due_on' });
  if (!dueOn) dueTime = '';
  if (hasPlanDate) { sets.push('plan_date = ?'); args.push(planDate); }
  if (hasDueOn || clampedDueOn) { sets.push('due_on = ?'); args.push(dueOn); }
  if (clampedPlanDate && !hasPlanDate) { sets.push('plan_date = ?'); args.push(planDate); }
  if (hasDueTime || (!dueOn && row.due_time)) { sets.push('due_time = ?'); args.push(dueTime); }
  for (const f of ['title', 'priority', 'status', 'note', 'stage']) {
    if (!(f in b)) continue;
    if (f === 'status' && !['open', 'done', 'dropped'].includes(b.status)) return res.status(400).json({ error: 'status 非法' });
    if (f === 'priority' && !['high', 'normal', 'low'].includes(b.priority)) return res.status(400).json({ error: 'priority 非法' });
    sets.push(`${f} = ?`);
    args.push(b[f] ?? '');
  }
  if (!sets.length) return res.status(400).json({ error: '无可更新字段' });
  const wantsDone = b.status === 'done';
  let updated;
  let completionWorklog = null;
  withChangeContext({ actor: req.actor }, () => {
    const current = db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
    const txSets = [...sets];
    const txArgs = [...args];
    const isCompleting = wantsDone && current.status !== 'done';
    if (isCompleting) txSets.push("done_at = datetime('now','+8 hours')");
    db.prepare(`UPDATE tasks SET ${txSets.join(', ')} WHERE id = ?`).run(...txArgs, row.id);
    updated = taskView(row.id);
    audit(req.actor, 'update', 'task', row.id, Object.keys(b).join(','));
    if (isCompleting) {
      const content = `完成待办：${updated.title}`;
      const info = db.prepare(
        'INSERT INTO worklog (case_id, worked_on, content) VALUES (?, ?, ?)'
      ).run(updated.case_id, todayCN(), content);
      completionWorklog = db.prepare('SELECT * FROM worklog WHERE id = ?').get(info.lastInsertRowid);
      audit(req.actor, 'create', 'worklog', info.lastInsertRowid, `待办完成 #${row.id} ${updated.title}`);
    }
  });
  res.json({ ...updated, completion_worklog: completionWorklog });
});

r.delete('/tasks/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '待办不存在' });
  withChangeContext({ actor: req.actor }, () => {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(row.id);
    audit(req.actor, 'delete', 'task', row.id, row.title);
  });
  res.json({ ok: true });
});

// ---------- worklog ----------
r.post('/worklog', (req, res) => {
  const b = req.body || {};
  if (!b.content || !b.content.trim()) return res.status(400).json({ error: 'content 必填' });
  const workedOn = b.worked_on || todayCN();
  if (!isDate(workedOn)) return res.status(400).json({ error: 'worked_on 须为 YYYY-MM-DD' });
  if (b.case_id && !db.prepare('SELECT id FROM cases WHERE id = ?').get(b.case_id)) {
    return res.status(404).json({ error: '案件不存在' });
  }
  const created = withChangeContext({ actor: req.actor }, () => {
    const info = db.prepare(
      'INSERT INTO worklog (case_id, worked_on, content, minutes, artifacts) VALUES (?, ?, ?, ?, ?)'
    ).run(b.case_id || null, workedOn, b.content.trim(), Number.isInteger(b.minutes) ? b.minutes : null, b.artifacts || '');
    audit(req.actor, 'create', 'worklog', info.lastInsertRowid, b.content.slice(0, 50));
    return db.prepare('SELECT * FROM worklog WHERE id = ?').get(info.lastInsertRowid);
  });
  res.json(created);
});

r.patch('/worklog/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM worklog WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '日志不存在' });
  const b = req.body || {};
  const sets = [];
  const args = [];
  for (const f of ['worked_on', 'content', 'minutes', 'artifacts']) {
    if (!(f in b)) continue;
    if (f === 'worked_on' && !isDate(b[f])) return res.status(400).json({ error: '日期非法' });
    sets.push(`${f} = ?`);
    args.push(b[f] ?? '');
  }
  if (!sets.length) return res.status(400).json({ error: '无可更新字段' });
  withChangeContext({ actor: req.actor }, () => {
    db.prepare(`UPDATE worklog SET ${sets.join(', ')} WHERE id = ?`).run(...args, row.id);
    audit(req.actor, 'update', 'worklog', row.id, '');
  });
  res.json(db.prepare('SELECT * FROM worklog WHERE id = ?').get(row.id));
});

r.delete('/worklog/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM worklog WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '日志不存在' });
  withChangeContext({ actor: req.actor }, () => {
    db.prepare('DELETE FROM worklog WHERE id = ?').run(row.id);
    audit(req.actor, 'delete', 'worklog', row.id, row.content.slice(0, 50));
  });
  res.json({ ok: true });
});

// ---------- 传票识别：只暂存并回填表单，不写业务表 ----------
r.post('/quick/extract', express.raw({ type: '*/*', limit: MAX_STAGING_BYTES }), async (req, res) => {
  cleanupStaging();
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (buffer.length > MAX_STAGING_BYTES) return res.status(413).json({ error: '文件超过 20MB' });
  const mime = detectMime(buffer);
  if (!mime) return res.status(415).json({ error: '仅支持 PDF/JPG/PNG/WebP（iPhone 照片请选 JPG）' });
  let staged;
  try {
    staged = stageBuffer(buffer, req.query?.name);
    const result = await extractDocument({ buffer, filename: req.query?.name, staged });
    const hints = [result.case_no, ...(result.parties || []), result.court].filter(Boolean);
    const matches = matchExtractedCase({ case_no: result.case_no, parties: result.parties, case_hint: hints.join(' ') });
    const caseRow = matches;
    const caseHint = result.case_no || (result.parties || []).join('、') || result.court || '';
    return res.json({
      kind: result.kind || (result.date ? 'hearing' : 'task'),
      title: result.summary || (result.date ? '开庭' : '传票待核'),
      date: result.date || '', time: result.time || '', location: result.location || '',
      court: result.court || '', case_no: result.case_no || '', parties: result.parties || [],
      case_id: caseRow?.id || null, case_name: caseRow?.name || '', case_hint: caseHint,
      staged: result.staged, source: result.source, ...(result.needs_manual ? { needs_manual: true, reason: result.reason } : {}),
    });
  } catch (error) {
    if (staged) { try { fs.unlinkSync(staged.filePath); fs.unlinkSync(staged.metaPath); } catch {} }
    return res.status(error.status || 502).json({ error: error.message, code: error.code || 'doc_extract_failed' });
  }
});

// ---------- 快录（P3/P5：方律本人直录不过收件箱）----------
r.post('/quick', (req, res) => {
  const b = req.body || {};
  const kind = ['task', 'log', 'hearing'].includes(b.kind) ? b.kind : 'task';
  if (!b.text || !b.text.trim()) return res.status(400).json({ error: 'text 必填' });
  if (b.date && !isDate(b.date)) return res.status(400).json({ error: 'date 须为 YYYY-MM-DD' });
  if (b.case_id && !db.prepare('SELECT id FROM cases WHERE id = ?').get(b.case_id)) {
    return res.status(404).json({ error: '案件不存在' });
  }
  let stagedPack = null;
  try { stagedPack = stagedForQuick(b, kind); }
  catch (error) { if (b.staged_token) return responseError(res, error); }
  if (stagedPack) {
    let result;
    try {
      result = withChangeContext({ actor: req.actor }, () => {
        let row; let derived = null; let entityId;
        if (kind === 'hearing') {
          const created = createEventRecord({ caseId: stagedPack.c.id, actor: req.actor, payload: {
            type: 'hearing', occurred_on: b.date, occurred_time: b.time ?? b.occurred_time ?? '', location: b.location ?? '', note: b.text.trim(),
          } });
          row = created.row; derived = created.derived; entityId = row.id;
        } else if (kind === 'log') {
          const info = db.prepare('INSERT INTO worklog (case_id, worked_on, content) VALUES (?, ?, ?)').run(stagedPack.c.id, b.date || todayCN(), b.text.trim());
          row = db.prepare('SELECT * FROM worklog WHERE id=?').get(info.lastInsertRowid); entityId = row.id;
          audit(req.actor, 'create', 'worklog', row.id, 'quick');
        } else {
          const info = db.prepare('INSERT INTO tasks (case_id, title, plan_date) VALUES (?, ?, ?)').run(stagedPack.c.id, b.text.trim(), b.date || '');
          row = taskView(info.lastInsertRowid); entityId = row.id;
          audit(req.actor, 'create', 'task', row.id, 'quick');
        }
        const info = db.prepare(
          'INSERT INTO attachments (case_id, entity, entity_id, rel_path, filename, size, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(stagedPack.c.id, stagedPack.entity, entityId, stagedPack.written.relativePath, stagedPack.written.filename, stagedPack.staged.size, 'upload');
        const attachment = db.prepare('SELECT * FROM attachments WHERE id=?').get(info.lastInsertRowid);
        return { row, derived, attachment };
      });
    } catch (error) {
      try { fs.unlinkSync(stagedPack.written.absolutePath || stagedPack.written.absolute); } catch {}
      discardStagedFile(stagedPack.staged);
      return responseError(res, error);
    }
    discardStagedFile(stagedPack.staged);
    const legalrag = queueStagedFile(stagedPack.c.id, stagedPack.written.relativePath, req.actor);
    return res.json({ kind, row: result.row, ...(result.derived ? { derived: result.derived } : {}), attachment: result.attachment, ...(legalrag ? { legalrag } : {}) });
  }
  if (kind === 'log') {
    const row = withChangeContext({ actor: req.actor }, () => {
      const info = db.prepare('INSERT INTO worklog (case_id, worked_on, content) VALUES (?, ?, ?)')
        .run(b.case_id || null, b.date || todayCN(), b.text.trim());
      audit(req.actor, 'create', 'worklog', info.lastInsertRowid, 'quick');
      return db.prepare('SELECT * FROM worklog WHERE id = ?').get(info.lastInsertRowid);
    });
    return res.json({ kind: 'log', row });
  }
  if (kind === 'hearing') {
    if (!b.case_id) return res.status(400).json({ error: '开庭必须挂案件' });
    if (!b.date || !isDate(b.date)) return res.status(400).json({ error: '开庭必须有合法日期' });
    try {
      const result = createEventRecord({
        caseId: Number(b.case_id),
        actor: req.actor,
        payload: {
          type: 'hearing',
          occurred_on: b.date,
          occurred_time: b.time ?? b.occurred_time ?? '',
          location: b.location ?? '',
          note: b.text.trim(),
        },
      });
      return res.json({ kind: 'hearing', row: result.row, derived: result.derived });
    } catch (error) {
      return responseError(res, error);
    }
  }
  const row = withChangeContext({ actor: req.actor }, () => {
    const info = db.prepare('INSERT INTO tasks (case_id, title, plan_date) VALUES (?, ?, ?)')
      .run(b.case_id || null, b.text.trim(), b.date || '');
    audit(req.actor, 'create', 'task', info.lastInsertRowid, 'quick');
    return taskView(info.lastInsertRowid);
  });
  res.json({ kind: 'task', row });
});

// ---- 快录整理（1.1.0）：LLM 把一句话整理成建议，**只回给前端填表，绝不写库** ----
// 人按「记」才走上面的 /quick 入表 —— 那一按就是铁律要的「人工确认」。
// 收件箱是**异步** LLM 产物（后台提取时人不在场）的裁决通道；这里是**同步**辅助，
// 两条路的共同不变量：LLM 的产物永不自己落库。见 DESIGN.md §8.6。

/** 本地匹配案件：LLM 只给「线索字符串」，真正认案件的是这里——案件名单绝不出机 */
function matchCase(hint) {
  const h = String(hint || '').trim();
  if (h.length < 2) return null;                    // 一个字的线索必然歧义，直接放弃
  const rows = db.prepare(
    "SELECT id, name, client, opponent, case_no FROM cases WHERE status = 'active'"
  ).all();
  const hit = (c) => [c.name, c.client, c.opponent, c.case_no]
    .filter(Boolean)
    .some((f) => f.includes(h) || h.includes(f));
  const found = rows.filter(hit);
  // 只认唯一命中。多个案件都沾边时宁可留空让人选，也不替人做二选一——挂错案件比没挂更糟。
  return found.length === 1 ? found[0] : null;
}

function normalizeCaseNo(value) {
  return String(value || '').normalize('NFKC').replace(/[\s　]/g, '');
}

function matchExtractedCase({ case_no = '', parties = [], case_hint = '' } = {}) {
  const rows = db.prepare(
    "SELECT id, name, client, opponent, case_no FROM cases WHERE status = 'active'"
  ).all();
  const no = normalizeCaseNo(case_no);
  if (no) {
    const exact = rows.filter((row) => normalizeCaseNo(row.case_no) === no && no !== '');
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
  }
  const hints = [...parties, case_hint].map((x) => String(x || '').trim()).filter((x) => x.length >= 2);
  const candidates = new Set();
  for (const hint of hints) {
    for (const row of rows) {
      if ([row.name, row.client, row.opponent, row.case_no].filter(Boolean).some((field) => field.includes(hint) || hint.includes(field))) {
        candidates.add(row.id);
      }
    }
  }
  const found = rows.filter((row) => candidates.has(row.id));
  return found.length === 1 ? found[0] : null;
}

function stagedForQuick(payload, kind) {
  if (!payload.staged_token) return null;
  const staged = readStaged(payload.staged_token);
  if (!staged) throw recordError('暂存文件无效或已过期', 400, 'staged_token_invalid');
  if (!payload.case_id) throw recordError('带附件的快录必须选择案件', 400, 'case_required');
  const c = db.prepare('SELECT * FROM cases WHERE id=?').get(payload.case_id);
  if (!c) throw recordError('案件不存在', 404, 'case_not_found');
  let context;
  try { context = resolveCaseDirectoryForCase(FILES_ROOT, c); }
  catch (error) { throw recordError(`案件夹不存在：${c.name}（先建案件夹，或去掉附件再记）`, 409, 'case_folder_missing'); }
  if (!context.exists) throw recordError(`案件夹不存在：${c.name}（先建案件夹，或去掉附件再记）`, 409, 'case_folder_missing');
  let written;
  try { written = writeUniqueSecureFile(context, '法院文书', staged.filename, staged.buffer); }
  catch (error) { throw recordError(error.message, 400, error.code || 'file_write_failed'); }
  return { staged, c, written, entity: kind === 'hearing' ? 'event' : kind === 'log' ? 'worklog' : '' };
}

function discardStagedFile(staged) {
  if (!staged) return;
  for (const file of [staged.filePath, staged.metaPath]) { try { fs.unlinkSync(file); } catch {} }
}

function queueStagedFile(caseId, relativePath, actor) {
  if (!legalRagBridgeConfigured()) return null;
  try { return queueCaseFile(caseId, relativePath, { priority: 90, actor }); }
  catch (error) { return { status: 'failed', error: error.message }; }
}

r.post('/quick/parse', async (req, res) => {
  if (!llmReady()) return res.status(503).json({ error: '未配置 DEEPSEEK_API_KEY（快录整理不可用，手动录入不受影响）' });
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'text 必填' });

  let out;
  try {
    out = await parseQuick(text, todayCN());
  } catch (e) {
    return res.status(502).json({ error: e.message });   // 上游挂了 = 前端退回手填，不阻塞录入
  }

  // ── 一个字都不信 LLM：逐字段白名单校验，越界一律降级为空，绝不透传 ──
  const parsedKind = ['task', 'log', 'hearing'].includes(out.kind) ? out.kind : 'task';
  const hasDate = isDate(out.date);
  const downgraded = parsedKind === 'hearing' && !hasDate;
  const kind = downgraded ? 'task' : parsedKind;       // 白名单闭合：结构上不可能产出 deadline（铁律①）
  let title = String(out.title || '').trim().slice(0, 200);
  if (!title) title = text;                               // LLM 没给标题就退回原文，不能把人的输入弄丢
  const date = hasDate ? out.date : '';          // 非法/瞎猜的日期直接丢掉，让人自己填
  const time = isTime(String(out.time || '')) ? String(out.time) : '';
  const location = String(out.location || '').trim().slice(0, 120);
  const c = matchCase(out.case_hint);

  // 解析只回填建议，绝不写任何业务或审计表；人按「记」才进入正式写入路径。
  res.json({
    kind,
    title,
    date,
    time,
    location,
    case_id: c ? c.id : null,
    case_name: c ? c.name : '',
    case_hint: String(out.case_hint || '').slice(0, 60),  // 没匹配上时回显线索，让人知道它「以为」是哪个案子
    source_text: text,
    ...(downgraded ? { downgraded: '开庭没有明确日期，已按待办整理' } : {}),
  });
});

export default r;
