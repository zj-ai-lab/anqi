import { Router } from 'express';
import { db as defaultDb, audit } from '../db.js';
import { beijingToUtcIso, resolveReminderSettings, utcIsoToBeijing } from '../lib/reminder-plan.js';
import { listChannels, configuredChannels } from '../lib/reminder-channels/index.js';

const LOCAL_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u;
function nowIso() { return new Date().toISOString(); }
function parseLocal(value) {
  if (typeof value !== 'string' || !LOCAL_RE.test(value)) return null;
  const [date, time] = value.split(' ');
  try { return beijingToUtcIso(date, time); } catch { return null; }
}
function local(iso) { return utcIsoToBeijing(iso); }
function decorate(row) {
  if (!row) return row;
  const source_summary = row.source_type
    ? { type: row.source_type, id: row.source_id ?? null }
    : null;
  return { ...row, fire_at_local: `${local(row.fire_at).date} ${local(row.fire_at).time}`, source_summary };
}
function deliveryView(database, row) {
  const delivery = database.prepare(`SELECT d.*, r.title, r.body, r.case_id, r.fire_at, c.name AS case_name
    FROM reminder_deliveries d JOIN reminders r ON r.id=d.reminder_id LEFT JOIN cases c ON c.id=r.case_id WHERE d.id=?`).get(row.id);
  if (!delivery) return null;
  return decorate(delivery);
}
function error(res, status, code, message) { return res.status(status).json({ code, error: message }); }

export function createRemindersRouter(worker, database = defaultDb) {
  const r = Router();
  r.get('/reminders', (req, res) => {
    const caseId = req.query.case_id === undefined ? null : Number(req.query.case_id);
    if (req.query.case_id !== undefined && !Number.isInteger(caseId)) return error(res, 400, 'invalid_case_id', 'case_id 非法');
    worker.syncCase(caseId);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
    const cond = []; const args = [];
    if (caseId != null) { cond.push('r.case_id=?'); args.push(caseId); }
    if (req.query.status) { cond.push('r.status=?'); args.push(String(req.query.status)); }
    const rows = database.prepare(`SELECT r.*, c.name AS case_name,
      (SELECT d.status FROM reminder_deliveries d WHERE d.reminder_id=r.id ORDER BY d.id DESC LIMIT 1) AS delivery_status
      FROM reminders r LEFT JOIN cases c ON c.id=r.case_id ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
      ORDER BY r.fire_at,r.id LIMIT ?`).all(...args, limit);
    res.json(rows.map(decorate));
  });

  r.post('/reminders', (req, res) => {
    const b = req.body || {}; const fireAt = parseLocal(b.fire_at_local);
    if (!b.title || typeof b.title !== 'string' || !fireAt) return error(res, 400, 'invalid_reminder', 'title 与 fire_at_local 必填且格式正确');
    // 输入精度是分钟；允许当前分钟的值，让客户端用 now+几秒换算本地时刻时
    // 仍能排进当前 tick 的 catch-up 窗口。
    if (new Date(fireAt).getTime() < Date.now() - 60_000) return error(res, 400, 'past_fire_at', '提醒时间必须在未来');
    const caseId = b.case_id === undefined || b.case_id === null || b.case_id === '' ? null : Number(b.case_id);
    if (caseId != null && !database.prepare('SELECT id FROM cases WHERE id=?').get(caseId)) return error(res, 404, 'case_not_found', '案件不存在');
    const sourceType = b.source_type ? String(b.source_type) : ''; const sourceId = b.source_id == null ? null : Number(b.source_id);
    const stamp = nowIso(); const info = database.prepare(`INSERT INTO reminders
      (origin,source_type,source_id,tier,case_id,title,body,fire_at,version,status,confirmed_at,created_at,updated_at)
      VALUES ('manual',?,?, 'manual',?,?,?,? ,1,'scheduled',?,?,?)`)
      .run(sourceType, sourceId, caseId, String(b.title).trim(), String(b.body || '').trim(), fireAt, stamp, stamp, stamp);
    audit(req.actor, 'create', 'reminder', info.lastInsertRowid, String(b.title).trim());
    res.status(201).json(decorate(database.prepare('SELECT * FROM reminders WHERE id=?').get(info.lastInsertRowid)));
  });

  r.patch('/reminders/:id', (req, res) => {
    const row = database.prepare('SELECT * FROM reminders WHERE id=?').get(req.params.id);
    if (!row) return error(res, 404, 'not_found', '提醒不存在');
    if (row.origin !== 'manual') return error(res, 409, 'auto_reminder', '自动提醒随来源变化，请改来源或在设置里关闭该档');
    if (row.status === 'sending') return error(res, 409, 'in_flight', '提醒正在发送');
    if (row.status !== 'scheduled') return error(res, 409, 'reminder_immutable', '该提醒已进入终态，请另建');
    if (!Number.isInteger(Number(req.body?.expected_version)) || Number(req.body.expected_version) !== row.version) return error(res, 409, 'version_conflict', '提醒版本已变化');
    const sets = []; const args = [];
    if (req.body.title !== undefined) { if (!String(req.body.title).trim()) return error(res, 400, 'invalid_title', '标题不能为空'); sets.push('title=?'); args.push(String(req.body.title).trim()); }
    if (req.body.fire_at_local !== undefined) { const fire = parseLocal(req.body.fire_at_local); if (!fire || new Date(fire).getTime() < Date.now() - 60_000) return error(res, 400, 'past_fire_at', '提醒时间必须在未来'); sets.push('fire_at=?'); args.push(fire); }
    if (!sets.length) return error(res, 400, 'invalid_reminder', '没有可更新字段');
    const stamp = nowIso(); sets.push('version=?','updated_at=?'); args.push(row.version + 1, stamp, row.id, row.version);
    const changed = database.prepare(`UPDATE reminders SET ${sets.join(',')} WHERE id=? AND version=? AND status='scheduled'`).run(...args);
    if (!changed.changes) return error(res, 409, 'version_conflict', '提醒版本已变化');
    audit(req.actor, 'update', 'reminder', row.id, Object.keys(req.body).join(','));
    res.json(decorate(database.prepare('SELECT * FROM reminders WHERE id=?').get(row.id)));
  });

  r.post('/reminders/:id/cancel', (req, res) => {
    const row = database.prepare('SELECT * FROM reminders WHERE id=?').get(req.params.id);
    if (!row) return error(res, 404, 'not_found', '提醒不存在');
    if (!Number.isInteger(Number(req.body?.expected_version)) || Number(req.body.expected_version) !== row.version) return error(res, 409, 'version_conflict', '提醒版本已变化');
    if (row.status === 'sending') return error(res, 409, 'in_flight', '提醒正在发送');
    if (['fired', 'missed', 'unknown', 'cancelled'].includes(row.status)) return res.json(decorate(row));
    const stamp = nowIso(); database.prepare("UPDATE reminders SET status='cancelled',status_reason='user_cancelled',version=version+1,updated_at=? WHERE id=? AND version=?").run(stamp, row.id, row.version);
    audit(req.actor, 'cancel', 'reminder', row.id, row.origin);
    res.json(decorate(database.prepare('SELECT * FROM reminders WHERE id=?').get(row.id)));
  });

  r.get('/notifications/status', (req, res) => {
    const rows = database.prepare('SELECT key,value FROM settings').all();
    res.json({ enabled: resolveReminderSettings(rows).remind_enabled === 'true', worker: worker.status(), channels: listChannels().map((c) => ({ id: c.id, label: c.label, configured: c.configured(resolveReminderSettings(rows)) })), tiers: resolveReminderSettings(rows) });
  });

  r.get('/notifications', (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const rows = database.prepare(`SELECT d.*, r.title, r.body, r.case_id, r.fire_at, c.name AS case_name
      FROM reminder_deliveries d JOIN reminders r ON r.id=d.reminder_id LEFT JOIN cases c ON c.id=r.case_id
      ORDER BY d.id DESC LIMIT ?`).all(limit);
    res.json(rows.map(decorate));
  });

  r.get('/notifications/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (row) => res.write(`event: reminder\ndata: ${JSON.stringify(decorate(row))}\n\n`);
    const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
    database.prepare("SELECT d.*, r.title, r.body, r.case_id, r.fire_at, c.name AS case_name FROM reminder_deliveries d JOIN reminders r ON r.id=d.reminder_id LEFT JOIN cases c ON c.id=r.case_id WHERE d.channel='inapp' AND d.status='queued' AND d.attempted_at>=? ORDER BY d.id").all(cutoff).forEach(send);
    const listener = (row) => send(row);
    worker.events.on('queued', listener);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000); heartbeat.unref?.();
    req.on('close', () => { clearInterval(heartbeat); worker.events.off('queued', listener); res.end(); });
  });

  r.post('/notifications/:deliveryId/ack', (req, res) => {
    const id = Number(req.params.deliveryId); const row = database.prepare('SELECT * FROM reminder_deliveries WHERE id=?').get(id);
    if (!row) return error(res, 404, 'not_found', '通知不存在');
    if (row.status === 'queued') database.prepare("UPDATE reminder_deliveries SET status='shown',acked_at=?,updated_at=? WHERE id=? AND status='queued'").run(nowIso(), nowIso(), id);
    res.json(decorate(deliveryView(database, { id })));
  });
  return r;
}

export default createRemindersRouter;
