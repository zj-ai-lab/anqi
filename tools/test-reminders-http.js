import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { beijingToUtcIso, utcIsoToBeijing } from '../src/lib/reminder-plan.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-reminders-http-'));
const dbPath = path.join(dir, 'http.db');
const port = 39895;
const child = spawn(process.execPath, ['server.js'], {
  cwd: path.resolve('.'),
  env: { ...process.env, DB_PATH: dbPath, PORT: String(port), ANJIAN_UNSAFE_NO_AUTH: '1', ANJIAN_REMIND_POLL_SECONDS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (data) => { stderr += data; });
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function raw(url, options = {}) {
  const response = await fetch(base + url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}
async function request(url, options = {}) {
  const result = await raw(url, options);
  assert.ok(result.response.ok, `${result.response.status}: ${JSON.stringify(result.body)} ${stderr}`);
  return result.body;
}
async function waitForHealth() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch { /* server is still starting */ }
    await sleep(100);
  }
  throw new Error(`server did not start: ${stderr}`);
}
function tableCounts() {
  const database = new Database(dbPath, { readonly: true });
  try {
    return Object.fromEntries(['events', 'deadlines', 'tasks'].map((table) => [table, database.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c]));
  } finally { database.close(); }
}
function assertNoSourceWrites(before, label) {
  assert.deepEqual(tableCounts(), before, `${label}: reminder subsystem changed source tables`);
}
function previousDay(date) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}
async function getCaseReminders(caseId, before, label) {
  const rows = await request(`/api/reminders?case_id=${caseId}&limit=100`);
  assertNoSourceWrites(before, label);
  return rows;
}
async function patchEventDate(eventId, date) {
  let result = await request(`/api/events/${eventId}`, { method: 'PATCH', body: JSON.stringify({ occurred_on: date }) });
  if (result.needs_confirm) result = await request(`/api/events/${eventId}`, { method: 'PATCH', body: JSON.stringify({ occurred_on: date, confirm: true }) });
  return result;
}
async function stopServer() {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(5000),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  await waitForHealth();
  let sourceCounts = tableCounts();

  const caseOne = await request('/api/cases', { method: 'POST', body: JSON.stringify({ name: '张三提醒案', procedure: '一审' }) });
  const event = await request(`/api/cases/${caseOne.id}/events`, { method: 'POST', body: JSON.stringify({ type: 'hearing', occurred_on: '2099-11-03', occurred_time: '09:30', location: '第五法庭' }) });
  sourceCounts = tableCounts();
  let rows = await getCaseReminders(caseOne.id, sourceCounts, 'initial hearing reconciliation');
  let hearingRows = rows.filter((row) => row.source_type === 'event' && row.source_id === event.id);
  assert.equal(hearingRows.length, 2);
  assert.equal(hearingRows.find((row) => row.tier === 'hearing_eve').fire_at, beijingToUtcIso('2099-11-02', '18:00'));
  assert.equal(hearingRows.find((row) => row.tier === 'hearing_day').fire_at, beijingToUtcIso('2099-11-03', '07:30'));

  await patchEventDate(event.id, '2099-11-05');
  sourceCounts = tableCounts();
  rows = await getCaseReminders(caseOne.id, sourceCounts, 'hearing date update reconciliation');
  hearingRows = rows.filter((row) => row.source_type === 'event' && row.source_id === event.id);
  assert.equal(hearingRows.filter((row) => row.status === 'cancelled').length, 0);
  assert.equal(hearingRows.filter((row) => row.status === 'scheduled').length, 2);
  assert.deepEqual(hearingRows.filter((row) => row.status === 'scheduled').map((row) => row.version).sort(), [2, 2]);
  assert.equal(hearingRows.find((row) => row.tier === 'hearing_eve' && row.status === 'scheduled').fire_at, beijingToUtcIso('2099-11-04', '18:00'));

  const deadline = await request(`/api/cases/${caseOne.id}/deadlines`, { method: 'POST', body: JSON.stringify({ name: '上诉期（判决）', due_on: '2099-11-08' }) });
  sourceCounts = tableCounts();
  rows = await getCaseReminders(caseOne.id, sourceCounts, 'confirmed deadline reconciliation');
  assert.equal(rows.filter((row) => row.source_type === 'deadline' && row.source_id === deadline.id && row.status === 'scheduled').length, 2);
  const directDb = new Database(dbPath);
  directDb.prepare("UPDATE deadlines SET review_status='pending_review' WHERE id=?").run(deadline.id);
  directDb.close();
  sourceCounts = tableCounts();
  rows = await getCaseReminders(caseOne.id, sourceCounts, 'pending-review deadline reconciliation');
  assert.equal(rows.filter((row) => row.source_type === 'deadline' && row.source_id === deadline.id && row.status === 'scheduled').length, 0);

  const timedTask = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ case_id: caseOne.id, title: '提交证据', due_on: '2099-11-09', due_time: '10:00' }) });
  const untimedTask = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ case_id: caseOne.id, title: '无时刻待办', due_on: '2099-11-09' }) });
  sourceCounts = tableCounts();
  rows = await getCaseReminders(caseOne.id, sourceCounts, 'task reconciliation');
  assert.equal(rows.filter((row) => row.source_type === 'task' && row.source_id === timedTask.id && row.status === 'scheduled').length, 1);
  assert.equal(rows.filter((row) => row.source_type === 'task' && row.source_id === untimedTask.id).length, 0);
  await request(`/api/tasks/${timedTask.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  sourceCounts = tableCounts();
  rows = await getCaseReminders(caseOne.id, sourceCounts, 'done task reconciliation');
  const doneRows = rows.filter((row) => row.source_type === 'task' && row.source_id === timedTask.id);
  assert.equal(doneRows.length, 1); assert.equal(doneRows[0].status, 'cancelled'); assert.equal(doneRows[0].status_reason, 'source_done');

  const caseTwo = await request('/api/cases', { method: 'POST', body: JSON.stringify({ name: '李四提醒案', procedure: '一审' }) });
  const eventTwo = await request(`/api/cases/${caseTwo.id}/events`, { method: 'POST', body: JSON.stringify({ type: 'hearing', occurred_on: '2099-12-03', occurred_time: '09:30', location: '第五法庭' }) });
  sourceCounts = tableCounts();
  rows = await getCaseReminders(caseTwo.id, sourceCounts, 'second case reconciliation');
  assert.equal(rows.filter((row) => row.source_type === 'event' && row.source_id === eventTwo.id && row.status === 'scheduled').length, 2);
  await request(`/api/cases/${caseTwo.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'closed' }) });
  sourceCounts = tableCounts();
  rows = await getCaseReminders(caseTwo.id, sourceCounts, 'closed case reconciliation');
  const closedRows = rows.filter((row) => row.origin === 'auto');
  assert.ok(closedRows.length >= 2); assert.ok(closedRows.every((row) => row.status === 'cancelled' && row.status_reason === 'case_inactive'));

  sourceCounts = tableCounts();
  rows = await getCaseReminders(caseOne.id, sourceCounts, 'pre-cancel reconciliation');
  const cancelTarget = rows.find((row) => row.source_type === 'event' && row.source_id === event.id && row.tier === 'hearing_day' && row.status === 'scheduled');
  assert.ok(cancelTarget);
  const cancelled = await request(`/api/reminders/${cancelTarget.id}/cancel`, { method: 'POST', body: JSON.stringify({ expected_version: cancelTarget.version }) });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.status_reason, 'user_cancelled');
  sourceCounts = tableCounts();
  rows = await getCaseReminders(caseOne.id, sourceCounts, 'user-cancelled reconciliation 1');
  rows = await getCaseReminders(caseOne.id, sourceCounts, 'user-cancelled reconciliation 2');
  const cancelledRows = rows.filter((row) => row.source_type === 'event' && row.source_id === event.id && row.tier === 'hearing_day');
  assert.equal(cancelledRows.filter((row) => row.status === 'scheduled').length, 0); assert.equal(cancelledRows.filter((row) => row.status === 'cancelled' && row.status_reason === 'user_cancelled').length, 1);
  await patchEventDate(event.id, '2099-11-06');
  sourceCounts = tableCounts();
  rows = await getCaseReminders(caseOne.id, sourceCounts, 'changed-source resurrection');
  assert.ok(rows.some((row) => row.source_type === 'event' && row.source_id === event.id && row.tier === 'hearing_day' && row.status === 'scheduled'));

  const futureManual = await request('/api/reminders', { method: 'POST', body: JSON.stringify({ case_id: caseOne.id, title: '人工提醒', fire_at_local: '2099-12-31 08:00' }) });
  const editedManual = await request(`/api/reminders/${futureManual.id}`, { method: 'PATCH', body: JSON.stringify({ title: '人工提醒已改期', expected_version: futureManual.version }) });
  assert.equal(editedManual.version, 2);
  const past = await raw(`/api/reminders/${futureManual.id}`, { method: 'PATCH', body: JSON.stringify({ fire_at_local: '2000-01-01 08:00', expected_version: editedManual.version }) });
  assert.equal(past.response.status, 400);

  await request('/api/settings', { method: 'PUT', body: JSON.stringify({ remind_enabled: false }) });
  await sleep(2200);
  sourceCounts = tableCounts();
  rows = await getCaseReminders(caseOne.id, sourceCounts, 'reminders disabled');
  const autoRows = rows.filter((row) => row.origin === 'auto');
  assert.equal(autoRows.filter((row) => row.status === 'scheduled').length, 0);
  assert.ok(autoRows.some((row) => row.status === 'cancelled' && row.status_reason === 'tier_disabled'));
  await request('/api/settings', { method: 'PUT', body: JSON.stringify({ remind_enabled: true }) });
  sourceCounts = tableCounts();
  rows = await getCaseReminders(caseOne.id, sourceCounts, 'reminders re-enabled');
  assert.ok(rows.some((row) => row.origin === 'auto' && row.status === 'scheduled'));
  await request('/api/settings', { method: 'PUT', body: JSON.stringify({ remind_hearing_eve_time: '20:00' }) });
  sourceCounts = tableCounts();
  rows = await getCaseReminders(caseOne.id, sourceCounts, 'hearing eve setting update');
  assert.equal(rows.find((row) => row.source_type === 'event' && row.source_id === event.id && row.tier === 'hearing_eve' && row.status === 'scheduled').fire_at, beijingToUtcIso(previousDay('2099-11-06'), '20:00'));
  const invalidTime = await raw('/api/settings', { method: 'PUT', body: JSON.stringify({ remind_hearing_eve_time: '25:99' }) });
  assert.equal(invalidTime.response.status, 400);
  const invalidDays = await raw('/api/settings', { method: 'PUT', body: JSON.stringify({ remind_deadline_days_before: '-1' }) });
  assert.equal(invalidDays.response.status, 400);

  const status = await request('/api/notifications/status');
  assert.ok(status.channels.some((channel) => channel.id === 'inapp'));
  assert.ok(Object.hasOwn(status.tiers, 'remind_hearing_eve_time')); assert.ok(status.worker.last_tick_at);

  const nearNow = utcIsoToBeijing(new Date(Date.now() + 4000).toISOString());
  const realManual = await request('/api/reminders', { method: 'POST', body: JSON.stringify({ case_id: caseOne.id, title: '到点人工提醒', fire_at_local: `${nearNow.date} ${nearNow.time}` }) });
  let streamText = '';
  const controller = new AbortController();
  const streamPromise = fetch(`${base}/api/notifications/stream`, { signal: controller.signal }).then(async (response) => {
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      streamText += decoder.decode(value);
      if (streamText.includes('event: reminder')) { controller.abort(); break; }
    }
  }).catch(() => {});
  sourceCounts = tableCounts();
  let delivery;
  for (let i = 0; i < 70; i++) {
    const notifications = await request('/api/notifications?limit=20');
    delivery = notifications.find((row) => row.reminder_id === realManual.id);
    if (delivery) break;
    await sleep(100);
  }
  await streamPromise;
  assert.match(streamText, /event: reminder/); assert.ok(delivery); assert.equal(delivery.status, 'queued');
  assertNoSourceWrites(sourceCounts, 'real-time delivery');
  const shown = await request(`/api/notifications/${delivery.id}/ack`, { method: 'POST', body: '{}' });
  assert.equal(shown.status, 'shown');
  const shownAgain = await request(`/api/notifications/${delivery.id}/ack`, { method: 'POST', body: '{}' });
  assert.equal(shownAgain.status, 'shown');

  console.log('reminders HTTP: auto replan, deadline/task filters, cancellation, settings, source-table isolation, real tick, SSE, and ack passed');
} finally {
  await stopServer();
  fs.rmSync(dir, { recursive: true, force: true });
}
