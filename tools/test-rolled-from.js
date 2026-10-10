import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-rolled-from-'));
const port = 39894;
const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, DB_PATH: path.join(scratch, 'db.sqlite'), PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', ANJIAN_UNSAFE_NO_AUTH: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
const request = async (url, options = {}) => { const response = await fetch(`http://127.0.0.1:${port}${url}`, options); return { response, json: await response.json() }; };
for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
try {
  const c = await request('/api/cases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '顺延测试案（虚构）', procedure: '一审' }) });
  const e = await request(`/api/cases/${c.json.id}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'served', occurred_on: '2025-12-17' }) });
  const deadline = e.json.derived.deadlines.find((d) => d.rule_id === 'defense_period');
  assert.ok(deadline); assert.equal(deadline.rolled_from, '2026-01-01'); assert.equal(deadline.due_on, '2026-01-04');
  const bundle = await request(`/api/cases/${c.json.id}`); const row = bundle.json.deadlines.find((d) => d.id === deadline.id); assert.equal(row.rolled_from, '2026-01-01');
  const changed = await request(`/api/deadlines/${deadline.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ due_on: '2026-01-06' }) });
  assert.equal(changed.json.rolled_from, ''); assert.equal(changed.json.due_on, '2026-01-06');
  console.log('rolled_from http ok');
} finally { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); }
