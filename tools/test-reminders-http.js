import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { beijingToUtcIso, utcIsoToBeijing } from '../src/lib/reminder-plan.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-reminders-http-'));
const dbPath = path.join(dir, 'http.db'); const port = 4210 + Math.floor(Math.random() * 200);
const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, PATH: `${process.env.HOME}/.local/opt/node22/bin:${process.env.PATH}`, DB_PATH: dbPath, PORT: String(port), ANJIAN_UNSAFE_NO_AUTH: '1', ANJIAN_REMIND_POLL_SECONDS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
async function request(url, options) { const res = await fetch(base + url, { ...options, headers: { 'content-type': 'application/json', ...(options?.headers || {}) } }); const body = await res.json(); assert.ok(res.ok, `${res.status}: ${JSON.stringify(body)} ${stderr}`); return body; }
const c = await request('/api/cases', { method: 'POST', body: JSON.stringify({ name: '张三提醒案', procedure: '一审' }) });
await request(`/api/cases/${c.id}/events`, { method: 'POST', body: JSON.stringify({ type: 'hearing', occurred_on: '2099-11-03', occurred_time: '09:30', location: '第五法庭' }) });
const autos = await request(`/api/reminders?case_id=${c.id}`); assert.equal(autos.length, 2); assert.equal(autos[0].fire_at, beijingToUtcIso('2099-11-02', '18:00'));
const local = utcIsoToBeijing(new Date(Date.now() + 2000).toISOString());
const manual = await request('/api/reminders', { method: 'POST', body: JSON.stringify({ case_id: c.id, title: '人工提醒', fire_at_local: `${local.date} ${local.time}` }) });
const conflict = await fetch(`${base}/api/reminders/${manual.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '改', expected_version: 99 }) }); assert.equal(conflict.status, 409);
let streamText = ''; const controller = new AbortController();
const streamPromise = fetch(`${base}/api/notifications/stream`, { signal: controller.signal }).then(async (res) => { const reader = res.body.getReader(); const decoder = new TextDecoder(); while (true) { const { value, done } = await reader.read(); if (done) break; streamText += decoder.decode(value); if (streamText.includes('event: reminder')) { controller.abort(); break; } } }).catch(() => {});
for (let i = 0; i < 70; i++) { const rows = await request('/api/notifications?limit=5'); if (rows.some((row) => row.reminder_id === manual.id)) break; await new Promise((r) => setTimeout(r, 100)); }
await streamPromise; assert.match(streamText, /event: reminder/);
const notifications = await request('/api/notifications?limit=5'); const delivery = notifications.find((row) => row.reminder_id === manual.id); assert.ok(delivery); assert.equal((await request(`/api/notifications/${delivery.id}/ack`, { method: 'POST', body: '{}' })).status, 'shown');
child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve));
console.log('reminders HTTP: auto planning, manual version conflict, real tick, SSE, and ack passed');
fs.rmSync(dir, { recursive: true, force: true });
