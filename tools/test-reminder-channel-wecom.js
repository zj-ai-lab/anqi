import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
import inapp from '../src/lib/reminder-channels/inapp.js';
import { configuredChannels, registerChannel } from '../src/lib/reminder-channels/index.js';
import { createWecomChannel } from '../src/lib/reminder-channels/wecom.js';
import { createReminderWorker } from '../src/lib/reminder-worker.js';
import { createRemindersRouter } from '../src/routes/reminders.js';

const NOW = new Date('2099-11-03T00:00:00.000Z');
function database() { const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); runMigrations(db); db.prepare("INSERT INTO settings(key,value) VALUES ('remind_enabled','true')").run(); return db; }
function reminder(db, title = '事项') {
  const stamp = NOW.toISOString();
  return db.prepare(`INSERT INTO reminders(origin,tier,case_id,title,body,fire_at,version,status,created_at,updated_at) VALUES ('manual','manual',?,?,?,?,1,'scheduled',?,?)`).run(null, title, '提醒正文', stamp, stamp, stamp).lastInsertRowid;
}
function fakeHub({ mode = 'preview', credentials = true, bound = true, result = { status: 'sent', detail: 'ok' } } = {}) {
  const calls = [];
  return { calls, reminderMode: () => mode, hasCredentials: () => credentials, isBound: () => bound, ownerUserid: () => 'zhangsan_test', sendToOwner: (text) => { calls.push(text); return typeof result === 'function' ? result(text) : Promise.resolve(result); } };
}
let registered;
const configState = { mode: 'preview', credentials: true, bound: true };
const baseHub = { reminderMode: () => configState.mode, hasCredentials: () => configState.credentials, isBound: () => configState.bound, ownerUserid: () => 'zhangsan_test', sendToOwner: async () => ({ status: 'sent' }) };
registered = createWecomChannel({ hub: baseHub, timeoutMs: 10 });
registerChannel(registered);
assert.ok(configuredChannels({}).some((item) => item.id === 'wecom'));
for (const change of [{ mode: 'off' }, { mode: 'preview', bound: false }, { mode: 'preview', bound: true, credentials: false }]) {
  Object.assign(configState, change);
  assert.equal(configuredChannels({}).some((item) => item.id === 'wecom'), false);
  assert.equal(registered.configured({}), false);
}
Object.assign(configState, { mode: 'preview', credentials: true, bound: true });
assert.equal(registered.configured({}), true);

// preview records a terminal preview delivery without invoking transport; inapp remains queued
{
  const db = database(); const hub = fakeHub({ mode: 'preview' }); const channel = createWecomChannel({ hub }); const id = reminder(db, '模拟提醒');
  const worker = createReminderWorker({ db, now: () => NOW, channels: [inapp, channel] });
  await worker.tick();
  const deliveries = db.prepare('SELECT * FROM reminder_deliveries WHERE reminder_id=? ORDER BY channel').all(id);
  assert.equal(deliveries.find((row) => row.channel === 'wecom').status, 'preview');
  assert.equal(deliveries.find((row) => row.channel === 'inapp').status, 'queued');
  assert.equal(hub.calls.length, 0);
  assert.equal(db.prepare('SELECT status FROM reminders WHERE id=?').get(id).status, 'fired');
  db.close();
}

for (const [label, result, expected] of [
  ['sent', { status: 'sent', detail: 'ok' }, 'sent'],
  ['failed', { status: 'failed', detail: 'errcode:40001' }, 'failed'],
  ['unknown', { status: 'unknown', detail: 'ack_timeout' }, 'unknown'],
]) {
  const db = database(); const hub = fakeHub({ mode: 'live', result }); const channel = createWecomChannel({ hub, timeoutMs: 10 }); const id = reminder(db, `${label}提醒`);
  const worker = createReminderWorker({ db, now: () => NOW, channels: [channel] });
  await worker.tick();
  assert.equal(db.prepare('SELECT status FROM reminder_deliveries WHERE reminder_id=?').get(id).status, expected);
  assert.equal(db.prepare('SELECT status FROM reminders WHERE id=?').get(id).status, 'fired');
  const calls = hub.calls.length; await worker.tick(); assert.equal(hub.calls.length, calls, 'terminal unknown is not resent');
  db.close();
}

// unconnected result is recorded as failed, and body only contains reminder fields + Beijing time
{
  const db = database(); const hub = fakeHub({ mode: 'live', result: { status: 'failed', detail: 'not_connected' } }); const channel = createWecomChannel({ hub }); const id = reminder(db, '开庭事项');
  const caseId = db.prepare("INSERT INTO cases(name) VALUES ('张三案')").run().lastInsertRowid;
  db.prepare("INSERT INTO contacts(case_id,role,name,phone) VALUES (?,?,?,?)").run(caseId, '当事人', '李四', '13900000000');
  db.prepare('UPDATE reminders SET case_id=? WHERE id=?').run(caseId, id);
  const worker = createReminderWorker({ db, now: () => NOW, channels: [channel] }); await worker.tick();
  assert.equal(db.prepare('SELECT status FROM reminder_deliveries WHERE reminder_id=?').get(id).status, 'failed');
  assert.match(hub.calls[0], /⏰ 案齐提醒/); assert.match(hub.calls[0], /提醒正文/); assert.match(hub.calls[0], /北京时间|08:00|16:00|当天/);
  assert.ok(!hub.calls[0].includes('13900000000'));
  db.close();
}

// total timeout is parameterized instead of waiting 15 seconds
{
  const db = database(); const hub = fakeHub({ mode: 'live', result: () => new Promise(() => {}) }); const channel = createWecomChannel({ hub, timeoutMs: 5 }); const id = reminder(db, '超时提醒');
  const worker = createReminderWorker({ db, now: () => NOW, channels: [channel] }); await worker.tick();
  assert.equal(db.prepare('SELECT status FROM reminder_deliveries WHERE reminder_id=?').get(id).status, 'unknown');
  db.close();
}

// notifications channel query excludes WeCom rows when the UI asks for inapp only
{
  const db = database(); const id = reminder(db, '通知过滤');
  db.prepare("INSERT INTO reminder_deliveries(reminder_id,reminder_version,channel,delivery_key,status,attempted_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, 1, 'inapp', `${id}:1:inapp`, 'queued', NOW.toISOString(), NOW.toISOString());
  db.prepare("INSERT INTO reminder_deliveries(reminder_id,reminder_version,channel,delivery_key,status,attempted_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, 1, 'wecom', `${id}:1:wecom`, 'sent', NOW.toISOString(), NOW.toISOString());
  const worker = createReminderWorker({ db, now: () => NOW, channels: [inapp] }); const app = express(); app.use('/api', createRemindersRouter(worker, db));
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const rows = await fetch(`http://127.0.0.1:${server.address().port}/api/notifications?channel=inapp`).then((response) => response.json());
  assert.ok(rows.length > 0 && rows.every((row) => row.channel === 'inapp'));
  await new Promise((resolve) => server.close(resolve)); db.close();
}
console.log('WeCom reminder channel configured/preview/live/timeout/privacy/filter matrix passed');
