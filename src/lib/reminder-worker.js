import { EventEmitter } from 'node:events';
import { db as defaultDb } from '../db.js';
import { todayCN } from './dates.js';
import { planAutoReminders, reconcile, resolveReminderSettings, utcIsoToBeijing } from './reminder-plan.js';
import { configuredChannels } from './reminder-channels/index.js';

const TERMINAL = new Set(['fired', 'missed', 'cancelled', 'unknown']);
const isoNow = (now) => now().toISOString();
function tx(database, fn) {
  if (database.inTransaction) return fn();
  database.exec('BEGIN IMMEDIATE');
  try { const value = fn(); database.exec('COMMIT'); return value; } catch (error) { try { database.exec('ROLLBACK'); } catch {} throw error; }
}
function settingRows(database) { return database.prepare('SELECT key,value FROM settings').all(); }
function sourceRows(database, today) {
  const hearings = database.prepare(`SELECT e.*, c.name AS case_name, c.status AS case_status
    FROM events e JOIN cases c ON c.id=e.case_id
    WHERE e.type='hearing' AND c.status='active' AND e.occurred_on>=?`).all(today);
  const deadlines = database.prepare(`SELECT d.*, c.name AS case_name, c.status AS case_status
    FROM deadlines d JOIN cases c ON c.id=d.case_id
    WHERE d.status='pending' AND d.review_status='confirmed' AND d.advisory=0 AND c.status='active' AND d.due_on>=?`).all(today);
  const tasks = database.prepare(`SELECT t.*, c.name AS case_name, COALESCE(c.status,'active') AS case_status
    FROM tasks t LEFT JOIN cases c ON c.id=t.case_id
    WHERE t.status='open' AND t.due_on!='' AND t.due_time!=''`).all();
  return { hearings, deadlines, tasks };
}
function viewDelivery(database, deliveryId) {
  return database.prepare(`SELECT d.*, r.title, r.body, r.case_id, r.fire_at, r.status AS reminder_status,
    c.name AS case_name FROM reminder_deliveries d JOIN reminders r ON r.id=d.reminder_id
    LEFT JOIN cases c ON c.id=r.case_id WHERE d.id=?`).get(deliveryId);
}

export function createReminderWorker({ db = defaultDb, pollSeconds = 30, catchupMinutes = 60, now = () => new Date(), channels: channelOverride = null } = {}) {
  const events = new EventEmitter();
  let timer = null; let running = false; let runningTick = false;
  const state = { running: false, last_tick_at: '', last_error: '' };

  function recoverSending() {
    tx(db, () => {
      db.prepare("UPDATE reminders SET status='unknown', status_reason='crash_recovery', updated_at=? WHERE status='sending'").run(isoNow(now));
    });
  }

  function syncCase(caseId = null) {
    const settings = resolveReminderSettings(settingRows(db));
    const nowIso = isoNow(now); const today = utcIsoToBeijing(nowIso).date;
    const sources = sourceRows(db, today);
    const filtered = caseId == null ? sources : Object.fromEntries(Object.entries(sources).map(([k, rows]) => [k, rows.filter((r) => r.case_id === Number(caseId))]));
    const desired = planAutoReminders({ ...filtered, settings, nowIso, catchupMinutes });
    const rows = db.prepare("SELECT * FROM reminders WHERE origin='auto'").all()
      .filter((r) => caseId == null || r.case_id === Number(caseId))
      .sort((a, b) => b.id - a.id);
    const latest = new Map();
    for (const row of rows) {
      const key = `${row.source_type}:${row.source_id}:${row.tier}`;
      if (!latest.has(key)) latest.set(key, row);
    }
    const sourceMap = new Map();
    for (const [type, list] of Object.entries(filtered)) for (const row of list) sourceMap.set(`${type === 'hearings' ? 'event' : type === 'deadlines' ? 'deadline' : 'task'}:${row.id}`, row);
    const tierDisabled = (tier) => {
      if (settings.remind_enabled === 'false') return true;
      if (tier === 'hearing_eve') return settings.remind_hearing_eve_time === '';
      if (tier === 'hearing_day') return settings.remind_hearing_day_time === '';
      if (tier === 'deadline_before') return settings.remind_deadline_days_before === '';
      if (tier === 'deadline_day') return settings.remind_deadline_time === '';
      if (tier === 'task_before') return settings.remind_task_minutes_before === '';
      return false;
    };
    const existing = [...latest.values()].map((row) => {
      let source = sourceMap.get(`${row.source_type}:${row.source_id}`);
      if (!source && row.source_id != null) {
        const table = row.source_type === 'event' ? 'events' : row.source_type === 'deadline' ? 'deadlines' : 'tasks';
        source = db.prepare(`SELECT x.*, c.status AS case_status FROM ${table} x LEFT JOIN cases c ON c.id=x.case_id WHERE x.id=?`).get(row.source_id);
      }
      return { ...row, source_status: source?.status || '', case_status: source?.case_status || (source ? 'active' : ''), tier_disabled: tierDisabled(row.tier) };
    });
    const plan = reconcile(desired, existing);
    tx(db, () => {
      const stamp = isoNow(now);
      const insert = db.prepare(`INSERT INTO reminders (origin,source_type,source_id,tier,case_id,title,body,fire_at,source_fingerprint,version,status,created_at,updated_at) VALUES ('auto',?,?,?,?,?,?,?, ?,1,'scheduled',?,?)`);
      for (const item of plan.insert) insert.run(item.source_type, item.source_id, item.tier, item.case_id, item.title, item.body, item.fire_at, item.source_fingerprint, stamp, stamp);
      const update = db.prepare(`UPDATE reminders SET case_id=?,title=?,body=?,fire_at=?,source_fingerprint=?,version=?,status='scheduled',status_reason='',updated_at=? WHERE id=? AND status IN ('scheduled','sending')`);
      for (const item of plan.update) update.run(item.patch.case_id, item.patch.title, item.patch.body, item.patch.fire_at, item.patch.source_fingerprint, item.patch.version, stamp, item.id);
      const cancel = db.prepare("UPDATE reminders SET status='cancelled',status_reason=?,updated_at=? WHERE id=? AND status='scheduled'");
      for (const item of plan.cancel) cancel.run(item.reason, stamp, item.id);
    });
    return { desired, plan };
  }

  async function tick() {
    if (runningTick) return;
    runningTick = true;
    try {
      try {
        const settings = resolveReminderSettings(settingRows(db));
        if (settings.remind_enabled === 'false') {
          tx(db, () => db.prepare("UPDATE reminders SET status='cancelled',status_reason='tier_disabled',updated_at=? WHERE origin='auto' AND status='scheduled'").run(isoNow(now)));
        } else syncCase();
        const nowIso = isoNow(now); const cutoffIso = new Date(new Date(nowIso).getTime() - Number(catchupMinutes) * 60_000).toISOString();
        const due = tx(db, () => {
          const rows = db.prepare("SELECT * FROM reminders WHERE status='scheduled' AND fire_at<=? AND fire_at>=? ORDER BY fire_at,id LIMIT 50").all(nowIso, cutoffIso);
          const stamp = nowIso; const channels = channelOverride ?? configuredChannels(settings); const deliveries = [];
          for (const row of rows) {
            db.prepare("UPDATE reminders SET status='sending',updated_at=? WHERE id=? AND version=? AND status='scheduled'").run(stamp, row.id, row.version);
            for (const channel of channels) {
              const key = `${row.id}:${row.version}:${channel.id}`;
              try {
                const info = db.prepare(`INSERT INTO reminder_deliveries (reminder_id,reminder_version,channel,delivery_key,status,attempted_at,updated_at) VALUES (?,?,?,?,?,?,?)`).run(row.id, row.version, channel.id, key, 'queued', stamp, stamp);
                deliveries.push({ row, channel, deliveryId: info.lastInsertRowid });
              } catch (error) {
                if (!/UNIQUE/.test(String(error.message))) throw error;
              }
            }
          }
          db.prepare("UPDATE reminders SET status='missed',status_reason='window_expired',updated_at=? WHERE status='scheduled' AND fire_at<?").run(stamp, cutoffIso);
          return deliveries;
        });
        for (const item of due) {
          let result;
          try { result = await item.channel.deliver(item.row, { id: item.deliveryId, channel: item.channel.id }, { db }); }
          catch (error) { result = { status: 'failed', detail: String(error?.message || error) }; }
          tx(db, () => {
            const stamp = isoNow(now);
            db.prepare('UPDATE reminder_deliveries SET status=?,detail=?,updated_at=? WHERE id=? AND reminder_id=? AND reminder_version=?')
              .run(result.status, String(result.detail || ''), stamp, item.deliveryId, item.row.id, item.row.version);
            // The reminder is finalized after the whole batch below, once every
            // configured channel has returned.  Keeping it sending during this
            // loop prevents a multi-channel plugin from exposing a partial fired
            // state to the next tick.
            if (result.status === 'queued') events.emit('queued', viewDelivery(db, item.deliveryId));
          });
        }
        tx(db, () => {
          const stamp = isoNow(now);
          const ids = [...new Set(due.map((item) => item.row.id))];
          for (const id of ids) {
            const row = db.prepare("SELECT id,version FROM reminders WHERE id=? AND status='sending'").get(id);
            if (row) db.prepare("UPDATE reminders SET status='fired',fired_at=?,updated_at=? WHERE id=? AND version=? AND status='sending'").run(stamp, stamp, row.id, row.version);
          }
        });
        tx(db, () => {
          const expiry = new Date(new Date(nowIso).getTime() - 24 * 3600_000).toISOString();
          db.prepare("UPDATE reminder_deliveries SET status='expired',updated_at=? WHERE status='queued' AND attempted_at<?").run(nowIso, expiry);
        });
        state.last_tick_at = nowIso; state.last_error = '';
      } catch (error) { state.last_error = String(error?.message || error); console.error('reminder worker tick:', state.last_error); }
    } finally { runningTick = false; }
  }
  function start() {
    if (running) return;
    recoverSending(); running = true; state.running = true;
    tick(); timer = setInterval(() => tick(), Math.max(1, Number(pollSeconds)) * 1000); timer.unref?.();
  }
  async function stop() { if (timer) clearInterval(timer); timer = null; running = false; state.running = false; while (runningTick) await new Promise((resolve) => setTimeout(resolve, 5)); }
  function status() {
    const counts = db.prepare("SELECT status,COUNT(*) AS c FROM reminders GROUP BY status").all();
    const deliveryCounts = db.prepare("SELECT status,COUNT(*) AS c FROM reminder_deliveries GROUP BY status").all();
    const next = db.prepare("SELECT fire_at FROM reminders WHERE status='scheduled' ORDER BY fire_at LIMIT 1").get();
    return { ...state, next_fire_at: next?.fire_at || '', scheduled: counts.find((x) => x.status === 'scheduled')?.c || 0, queued: deliveryCounts.find((x) => x.status === 'queued')?.c || 0, failed: deliveryCounts.find((x) => x.status === 'failed')?.c || 0, missed: counts.find((x) => x.status === 'missed')?.c || 0, unknown: counts.find((x) => x.status === 'unknown')?.c || 0 };
  }
  return { start, stop, tick, status, syncCase, events, viewDelivery };
}
