import crypto from 'node:crypto';
import { addDays, diffDays, isDate } from './dates.js';

const DEFAULTS = Object.freeze({
  remind_enabled: 'true',
  remind_hearing_eve_time: '18:00',
  remind_hearing_day_time: '07:30',
  remind_deadline_days_before: '3',
  remind_deadline_time: '07:30',
  remind_task_minutes_before: '30',
});
const TERMINAL = new Set(['fired', 'missed', 'unknown']);
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export function resolveReminderSettings(rows = []) {
  const source = Array.isArray(rows)
    ? Object.fromEntries(rows.map((row) => [row.key, String(row.value ?? '')]))
    : { ...rows };
  const value = (key) => Object.hasOwn(source, key) ? source[key] : DEFAULTS[key];
  const time = (key) => {
    const raw = value(key);
    return raw === '' || TIME_RE.test(raw) ? raw : DEFAULTS[key];
  };
  const integer = (key, min, max) => {
    const raw = value(key);
    if (raw === '') return '';
    const n = Number(raw);
    return Number.isInteger(n) && n >= min && n <= max ? String(n) : DEFAULTS[key];
  };
  return {
    remind_enabled: value('remind_enabled') === 'false' ? 'false' : 'true',
    remind_hearing_eve_time: time('remind_hearing_eve_time'),
    remind_hearing_day_time: time('remind_hearing_day_time'),
    remind_deadline_days_before: integer('remind_deadline_days_before', 0, 30),
    remind_deadline_time: time('remind_deadline_time'),
    remind_task_minutes_before: integer('remind_task_minutes_before', 0, 1440),
  };
}

function assertDate(value) {
  if (!isDate(value)) throw new Error(`invalid Beijing date: ${value}`);
}
function assertTime(value) {
  if (typeof value !== 'string' || !TIME_RE.test(value)) throw new Error(`invalid Beijing time: ${value}`);
}

export function beijingToUtcIso(date, time) {
  assertDate(date); assertTime(time);
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - 8, mm, 0)).toISOString();
}

export function utcIsoToBeijing(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid UTC ISO: ${iso}`);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

function localIsoAt(date, time) { return beijingToUtcIso(date, time); }
function caseStatus(row) { return row.case_status ?? row.status_case ?? ''; }
function fingerprintParts(type, row) {
  if (type === 'event') return [row.occurred_on, row.occurred_time, row.location, caseStatus(row)];
  if (type === 'deadline') return [row.due_on, row.name, row.status, row.review_status, caseStatus(row)];
  return [row.due_on, row.due_time, row.title, row.status, caseStatus(row)];
}
export function sourceFingerprint(sourceType, row) {
  return crypto.createHash('sha256').update(fingerprintParts(sourceType, row).map((v) => String(v ?? '')).join('\u001f')).digest('hex').slice(0, 16);
}

function caseName(row) { return row.case_name || row.name || '案件'; }
function hearingTitle(row, dayLabel) {
  const when = row.occurred_time ? `${dayLabel} ${row.occurred_time}` : `${dayLabel} 时间未记`;
  const place = row.location ? ` · ${row.location}` : '';
  return `${when} 开庭 · ${caseName(row)}${place}`;
}
function deadlineTitle(row, days) {
  const when = days === 0 ? '今天到期' : `${days} 天后到期`;
  return `${when} · ${caseName(row)} · ${row.name}（${row.due_on}）`;
}
function taskTitle(row, minutes) { return `${minutes} 分钟后截止 · ${caseName(row)} · ${row.title}`; }

export function planAutoReminders({ hearings = [], deadlines = [], tasks = [], settings, nowIso = new Date().toISOString(), catchupMinutes = 60 }) {
  const s = resolveReminderSettings(settings);
  if (s.remind_enabled === 'false') return [];
  const now = new Date(nowIso).getTime();
  const cutoff = now - Number(catchupMinutes) * 60_000;
  const out = [];
  const add = (row, sourceType, tier, fireAt, title) => {
    const t = new Date(fireAt).getTime();
    if (!Number.isFinite(t) || t < cutoff) return;
    out.push({ source_type: sourceType, source_id: row.id, tier, case_id: row.case_id, title, body: title, fire_at: fireAt, source_fingerprint: sourceFingerprint(sourceType, row) });
  };
  for (const row of hearings) {
    if (row.case_status && row.case_status !== 'active') continue;
    const day = row.occurred_on;
    if (!isDate(day) || day < utcIsoToBeijing(nowIso).date) continue;
    const eve = s.remind_hearing_eve_time && addDays(day, -1);
    if (eve) add(row, 'event', 'hearing_eve', localIsoAt(eve, s.remind_hearing_eve_time), hearingTitle(row, '明天'));
    if (s.remind_hearing_day_time) add(row, 'event', 'hearing_day', localIsoAt(day, s.remind_hearing_day_time), hearingTitle(row, '今天'));
  }
  const today = utcIsoToBeijing(nowIso).date;
  for (const row of deadlines) {
    if ((row.case_status && row.case_status !== 'active') || row.status !== 'pending' || row.review_status !== 'confirmed' || Number(row.advisory || 0) !== 0) continue;
    if (!isDate(row.due_on) || row.due_on < today) continue;
    const days = Number(s.remind_deadline_days_before);
    if (s.remind_deadline_time !== '' && s.remind_deadline_days_before !== '') {
      if (days === 0) {
        add(row, 'deadline', 'deadline_day', localIsoAt(row.due_on, s.remind_deadline_time), deadlineTitle(row, 0));
      } else {
        add(row, 'deadline', 'deadline_before', localIsoAt(addDays(row.due_on, -days), s.remind_deadline_time), deadlineTitle(row, days));
        add(row, 'deadline', 'deadline_day', localIsoAt(row.due_on, s.remind_deadline_time), deadlineTitle(row, 0));
      }
    }
  }
  const minutes = Number(s.remind_task_minutes_before);
  for (const row of tasks) {
    if (row.status !== 'open' || !row.due_on || !row.due_time || !isDate(row.due_on) || !TIME_RE.test(row.due_time) || (row.case_status && row.case_status !== 'active')) continue;
    if (s.remind_task_minutes_before === '') continue;
    const dueAt = new Date(localIsoAt(row.due_on, row.due_time)).getTime();
    add(row, 'task', 'task_before', new Date(dueAt - minutes * 60_000).toISOString(), taskTitle(row, minutes));
  }
  return out;
}

export function reconcile(desired, existingAutoRows) {
  const insert = [], update = [], cancel = [];
  const byKey = new Map(existingAutoRows.map((r) => [`${r.source_type}:${r.source_id}:${r.tier}`, r]));
  const desiredKeys = new Set();
  for (const item of desired) {
    const key = `${item.source_type}:${item.source_id}:${item.tier}`; desiredKeys.add(key);
    const row = byKey.get(key);
    if (!row || (row.status === 'cancelled' && row.source_fingerprint !== item.source_fingerprint)
      || (TERMINAL.has(row.status) && row.source_fingerprint !== item.source_fingerprint)) { insert.push(item); continue; }
    if (row.status === 'cancelled' || TERMINAL.has(row.status)) continue;
    if (row.fire_at !== item.fire_at || row.title !== item.title || row.body !== item.body || row.source_fingerprint !== item.source_fingerprint) update.push({ id: row.id, patch: { ...item, version: Number(row.version || 1) + 1 } });
  }
  for (const row of existingAutoRows) {
    const key = `${row.source_type}:${row.source_id}:${row.tier}`;
    if (desiredKeys.has(key) || row.status === 'cancelled' || row.status === 'fired' || row.status === 'missed' || row.status === 'unknown') continue;
    const reason = row.source_status === 'done' || row.status_source === 'done' ? 'source_done' : (row.case_status && row.case_status !== 'active') ? 'case_inactive' : row.tier_disabled ? 'tier_disabled' : 'source_changed';
    cancel.push({ id: row.id, reason });
  }
  return { insert, update, cancel };
}
