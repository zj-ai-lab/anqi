import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-global-http-'));
process.env.DB_PATH = path.join(scratch, 'agent.db');
process.env.ANJIAN_UNSAFE_NO_AUTH = '1';
const { db } = await import('../src/db.js');
const { createAgentRouter } = await import('../src/routes/agent.js');
const { AGENT_SETTINGS_KEYS } = await import('../src/agent/config.js');
// 假 supervisor：显式计数器 + 可切换的 isLive，照 tools/test-agent-http.js 的写法。
// disabled 时路由层必须在调用任何 supervisor 方法之前就短路，计数器让这一点可断言。
class FakeSupervisor {
  constructor() {
    this.calls = []; this.listeners = new Set(); this.live = true;
    this.startCalls = 0; this.promptCalls = 0; this.cancelTurnCalls = 0; this.setApprovalTierCalls = 0; this.publicStatusCalls = 0;
  }
  resetCounters() { this.startCalls = 0; this.promptCalls = 0; this.cancelTurnCalls = 0; this.setApprovalTierCalls = 0; this.publicStatusCalls = 0; this.calls.length = 0; }
  publicStatus(scope) { this.publicStatusCalls += 1; return { status: 'stopped', scope, caseId: null, caseName: '', pendingInteractions: [], history: [] }; }
  async start(scope) { this.startCalls += 1; this.calls.push(['start', scope]); return { status: 'ready', scope, caseId: null, caseName: '' }; }
  isLive() { return this.live; }
  prompt(...args) { this.promptCalls += 1; this.calls.push(['prompt', ...args]); return Promise.resolve(); }
  cancelTurn(scope) { this.cancelTurnCalls += 1; this.calls.push(['cancel', scope]); return true; }
  setApprovalTier(scope, tier) { this.setApprovalTierCalls += 1; this.calls.push(['tier', scope, tier]); return { ok: true, approvalTier: tier }; }
  onEvent(scope, fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  broadcast(event) { for (const fn of [...this.listeners]) fn(event); }
}
db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(AGENT_SETTINGS_KEYS.enabled, 'false');
db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(AGENT_SETTINGS_KEYS.model, 'deepseek-chat');
db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(AGENT_SETTINGS_KEYS.apiKeyEnv, 'GLOBAL_HTTP_KEY');
const supervisor = new FakeSupervisor(); const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.actor = 'global-http-test'; next(); }); app.use('/api', createAgentRouter(supervisor));
const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function req(pathname, options = {}) { const r = await fetch(base + pathname, { headers: { 'Content-Type': 'application/json' }, ...options }); const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; } return { status: r.status, data }; }
async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await new Promise((r) => setTimeout(r, intervalMs)); }
  return predicate();
}
// 读 SSE 流直到 buffer 里出现 `needle`（或超时）；返回累计文本。
async function readUntil(reader, state, needle, timeoutMs = 3000) {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  while (!state.buffer.includes(needle) && Date.now() < deadline) {
    const timer = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), Math.max(1, deadline - Date.now())));
    const chunk = await Promise.race([reader.read(), timer]);
    if (chunk.timeout || chunk.done) break;
    state.buffer += decoder.decode(chunk.value, { stream: true });
  }
  return state.buffer;
}
function parseFrame(buffer, eventName) {
  const frames = buffer.split('\n\n').filter(Boolean);
  const frame = frames.find((f) => f.split('\n')[0] === `event: ${eventName}`);
  if (!frame) return null;
  const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
  return dataLine ? JSON.parse(dataLine.slice(6)) : null;
}
try {
  // ---- 既有：disabled 下 start 被拒、supervisor 未被调用 ----
  let out = await req('/api/agent/global/start', { method: 'POST' }); assert.equal(out.status, 409); assert.equal(supervisor.calls.length, 0);

  // ---- R6.1 disabled 矩阵：四个 POST 端点 409 agent_disabled，events 首帧 status:disabled，supervisor 计数全 0 ----
  supervisor.resetCounters();
  for (const [name, pathname, body] of [
    ['start', '/api/agent/global/start', undefined],
    ['prompt', '/api/agent/global/prompt', { text: '你好' }],
    ['cancel', '/api/agent/global/cancel', undefined],
    ['approval-tier', '/api/agent/global/approval-tier', { approvalTier: '1' }],
  ]) {
    out = await req(pathname, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(out.status, 409, `${name} disabled 必须 409`);
    assert.equal(out.data.code, 'agent_disabled', `${name} disabled 必须带 code=agent_disabled`);
  }
  {
    const ac = new AbortController();
    const response = await fetch(`${base}/api/agent/global/events`, { signal: ac.signal });
    assert.equal(response.status, 200);
    assert.ok((response.headers.get('content-type') || '').includes('text/event-stream'));
    const reader = response.body.getReader(); const state = { buffer: '' };
    await readUntil(reader, state, '\n\n');
    assert.ok(state.buffer.startsWith('event: status\n'), `disabled 时首帧必须是 status（实际 ${JSON.stringify(state.buffer)}）`);
    const frame = parseFrame(state.buffer, 'status');
    assert.equal(frame.status, 'disabled'); assert.equal(frame.scope, 'global'); assert.equal(frame.caseId, null);
    assert.equal(supervisor.listeners.size, 0, 'disabled 的 SSE 不得订阅 supervisor 事件');
    ac.abort(); await reader.cancel().catch(() => {});
  }
  assert.deepEqual(
    { start: supervisor.startCalls, prompt: supervisor.promptCalls, cancelTurn: supervisor.cancelTurnCalls, setApprovalTier: supervisor.setApprovalTierCalls, publicStatus: supervisor.publicStatusCalls },
    { start: 0, prompt: 0, cancelTurn: 0, setApprovalTier: 0, publicStatus: 0 },
    'disabled 矩阵下 supervisor 任何方法都不得被调用',
  );

  db.prepare('UPDATE settings SET value=? WHERE key=?').run('true', AGENT_SETTINGS_KEYS.enabled); process.env.GLOBAL_HTTP_KEY = 'fake-key';
  supervisor.resetCounters();
  out = await req('/api/agent/status?scope=global'); assert.equal(out.status, 200); assert.equal(out.data.worker.scope, 'global'); assert.equal(out.data.worker.caseId, null);
  out = await req('/api/agent/global/prompt', { method: 'POST', body: JSON.stringify({ text: '' }) }); assert.equal(out.status, 400);
  out = await req('/api/agent/global/prompt', { method: 'POST', body: JSON.stringify({ text: '你好', attachmentIds: ['sha256:' + 'a'.repeat(64)] }) }); assert.equal(out.status, 400); assert.equal(out.data.code, 'images_not_supported_global');

  // ---- R6.2 超长 prompt → 400；isLive()=false → 409 worker_not_running；二者都不得进 supervisor.prompt ----
  const promptsBefore = supervisor.promptCalls;
  out = await req('/api/agent/global/prompt', { method: 'POST', body: JSON.stringify({ text: '张'.repeat(8001) }) }); assert.equal(out.status, 400, '8001 字符必须 400');
  assert.equal(supervisor.promptCalls, promptsBefore, '超长 prompt 不得转发给 supervisor');
  supervisor.live = false;
  out = await req('/api/agent/global/prompt', { method: 'POST', body: JSON.stringify({ text: '你好' }) }); assert.equal(out.status, 409); assert.equal(out.data.code, 'worker_not_running');
  assert.equal(supervisor.promptCalls, promptsBefore, 'worker 未运行时不得转发给 supervisor');
  supervisor.live = true;

  out = await req('/api/agent/global/prompt', { method: 'POST', body: JSON.stringify({ text: '你好' }) }); if (out.status !== 202) console.error('prompt', out); assert.equal(out.status, 202); assert.equal(supervisor.calls.at(-1)[1], 'global');
  out = await req('/api/agent/global/cancel', { method: 'POST' }); assert.equal(out.status, 200);
  out = await req('/api/agent/global/approval-tier', { method: 'POST', body: JSON.stringify({ approvalTier: '1' }) }); assert.equal(out.status, 200);

  // ---- R6.4 approval-tier 非法值 → 400 invalid_tier，且不转发 ----
  const tiersBefore = supervisor.setApprovalTierCalls;
  out = await req('/api/agent/global/approval-tier', { method: 'POST', body: JSON.stringify({ approvalTier: '9' }) });
  assert.equal(out.status, 400); assert.equal(out.data.code, 'invalid_tier');
  assert.equal(supervisor.setApprovalTierCalls, tiersBefore, '非法档位不得转发给 supervisor');

  // ---- R6.3 SSE：首帧 status(scope=global, caseId=null) → 广播 turn/start 转发 → 断开后反订阅 ----
  {
    const ac = new AbortController();
    const response = await fetch(`${base}/api/agent/global/events`, { signal: ac.signal });
    assert.equal(response.status, 200);
    assert.ok((response.headers.get('content-type') || '').includes('text/event-stream'));
    const reader = response.body.getReader(); const state = { buffer: '' };
    await readUntil(reader, state, '\n\n');
    assert.ok(state.buffer.startsWith('event: status\n'), `首帧必须是 status（实际 ${JSON.stringify(state.buffer)}）`);
    const first = parseFrame(state.buffer, 'status');
    assert.equal(first.scope, 'global'); assert.equal(first.caseId, null);
    assert.equal(await waitUntil(() => supervisor.listeners.size === 1), true, '首帧之后必须已订阅 supervisor 事件');
    supervisor.broadcast({ type: 'turn/start', at: new Date().toISOString(), origin: 'supervisor', data: {} });
    await readUntil(reader, state, '"origin":"supervisor"');
    const forwarded = parseFrame(state.buffer, 'turn/start');
    assert.ok(forwarded, `客户端必须收到 event: turn/start（buffer=${JSON.stringify(state.buffer)}）`);
    assert.equal(forwarded.scope, 'global'); assert.equal(forwarded.caseId, null); assert.equal(forwarded.origin, 'supervisor');
    ac.abort(); await reader.cancel().catch(() => {});
    assert.equal(await waitUntil(() => supervisor.listeners.size === 0), true, '客户端断开后必须反订阅，listener 集合应为空');
  }

  out = await req('/api/agent/global/commands'); assert.equal(out.status, 404);
  console.log('global agent HTTP: disabled matrix (4 POST + SSE, zero supervisor calls), prompt length/not-running, approval-tier validation, SSE frames/unsubscribe, scope forwarding and command absence passed');
} finally { await new Promise((resolve) => server.close(resolve)); db.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
