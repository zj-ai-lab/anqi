import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-global-internal-'));
process.env.DB_PATH = path.join(scratch, 'global.db');
process.env.ANJIAN_INTERNAL_KEY = 'global-internal-key';
const { db } = await import('../src/db.js');
const router = (await import('../src/routes/internal.js')).default;
const { internalAuth } = await import('../src/middleware/auth.js');
const registry = await import('../src/agent/session-registry.js');
registry._resetSessionRegistryForTest();
const app = express(); app.use(express.json()); app.use('/internal', internalAuth, router);
const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const headers = { 'X-Anjian-Key': process.env.ANJIAN_INTERNAL_KEY, 'Content-Type': 'application/json' };
async function req(pathname, options = {}) { const r = await fetch(base + pathname, { headers, ...options }); return { status: r.status, data: await r.json() }; }
const one = db.prepare("INSERT INTO cases (name,client,case_no,court,status) VALUES ('张三案','张三','(2099)测0000民初1号','测试人民法院','active')").run().lastInsertRowid;
const two = db.prepare("INSERT INTO cases (name,client,case_no,court,status) VALUES ('李四案','李四','(2099)测0000民初2号','测试人民法院','active')").run().lastInsertRowid;
const sessionId = 'global-http-session'; registry.bindGlobalSession(sessionId);
try {
  let out = await req('/internal/agent-case-view?session_id=' + sessionId); assert.equal(out.status, 403);
  out = await req('/internal/agent-case-resolve', { method: 'POST', body: JSON.stringify({ session_id: sessionId, parties: ['张三'] }) });
  if (out.status !== 200) console.error('resolve', out); assert.equal(out.status, 200); assert.equal(out.data.match, 'unique'); assert.equal(out.data.granted_case_id, one);
  out = await req(`/internal/agent-case-view?session_id=${sessionId}&case_id=${one}`); assert.equal(out.status, 200); assert.equal(out.data.case.id, one);
  out = await req('/internal/agent-proposals', { method: 'POST', body: JSON.stringify({ mode: 'direct', kind: 'event', session_id: sessionId, payload: { type: 'hearing', occurred_on: '2099-02-01' } }) }); assert.equal(out.status, 400);
  out = await req('/internal/agent-proposals', { method: 'POST', body: JSON.stringify({ mode: 'direct', kind: 'worklog', session_id: sessionId, payload: { content: '会见张三', worked_on: '2099-01-01', case_id: one } }) });
  assert.equal(out.status, 201); assert.equal(out.data.item.created_by, 'ai'); assert.equal(out.data.case_id, one);
  out = await req('/internal/agent-proposals', { method: 'POST', body: JSON.stringify({ mode: 'direct', kind: 'task', session_id: sessionId, payload: { title: '所务待办' } }) }); assert.equal(out.status, 201); assert.equal(out.data.case_id, null);
  out = await req('/internal/agent-case-resolve', { method: 'POST', body: JSON.stringify({ session_id: sessionId, parties: ['张'] }) }); assert.equal(out.status, 200); assert.equal(out.data.match, 'none');
  out = await req('/internal/agent-case-select', { method: 'POST', body: JSON.stringify({ session_id: sessionId, case_id: two }) }); assert.equal(out.status, 403); assert.equal(out.data.code, 'case_not_offered');
  registry.unbindSession(sessionId); out = await req('/internal/agent-case-resolve', { method: 'POST', body: JSON.stringify({ session_id: sessionId, parties: ['张三'] }) }); assert.equal(out.status, 403);
  console.log('global internal HTTP: resolve/select/grant, scoped reads, direct worklog/task and fail-closed trust boundary passed');
} finally { await new Promise((resolve) => server.close(resolve)); db.close(); fs.rmSync(scratch, { recursive: true, force: true }); registry._resetSessionRegistryForTest(); }
