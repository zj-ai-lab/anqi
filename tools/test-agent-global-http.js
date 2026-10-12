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
class FakeSupervisor {
  constructor() { this.calls = []; this.listeners = new Set(); }
  publicStatus(scope) { return { status: 'stopped', scope, caseId: null, caseName: '', pendingInteractions: [], history: [] }; }
  async start(scope) { this.calls.push(['start', scope]); return { status: 'ready', scope, caseId: null, caseName: '' }; }
  isLive() { return true; }
  prompt(...args) { this.calls.push(['prompt', ...args]); return Promise.resolve(); }
  cancelTurn(scope) { this.calls.push(['cancel', scope]); return true; }
  setApprovalTier(scope, tier) { this.calls.push(['tier', scope, tier]); return { ok: true, approvalTier: tier }; }
  onEvent(scope, fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}
db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(AGENT_SETTINGS_KEYS.enabled, 'false');
db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(AGENT_SETTINGS_KEYS.model, 'deepseek-chat');
db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(AGENT_SETTINGS_KEYS.apiKeyEnv, 'GLOBAL_HTTP_KEY');
const supervisor = new FakeSupervisor(); const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.actor = 'global-http-test'; next(); }); app.use('/api', createAgentRouter(supervisor));
const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function req(pathname, options = {}) { const r = await fetch(base + pathname, { headers: { 'Content-Type': 'application/json' }, ...options }); const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; } return { status: r.status, data }; }
try {
  let out = await req('/api/agent/global/start', { method: 'POST' }); assert.equal(out.status, 409); assert.equal(supervisor.calls.length, 0);
  db.prepare('UPDATE settings SET value=? WHERE key=?').run('true', AGENT_SETTINGS_KEYS.enabled); process.env.GLOBAL_HTTP_KEY = 'fake-key';
  out = await req('/api/agent/status?scope=global'); assert.equal(out.status, 200); assert.equal(out.data.worker.scope, 'global'); assert.equal(out.data.worker.caseId, null);
  out = await req('/api/agent/global/prompt', { method: 'POST', body: JSON.stringify({ text: '' }) }); assert.equal(out.status, 400);
  out = await req('/api/agent/global/prompt', { method: 'POST', body: JSON.stringify({ text: '你好', attachmentIds: ['sha256:' + 'a'.repeat(64)] }) }); assert.equal(out.status, 400); assert.equal(out.data.code, 'images_not_supported_global');
  out = await req('/api/agent/global/prompt', { method: 'POST', body: JSON.stringify({ text: '你好' }) }); if (out.status !== 202) console.error('prompt', out); assert.equal(out.status, 202); assert.equal(supervisor.calls.at(-1)[1], 'global');
  out = await req('/api/agent/global/cancel', { method: 'POST' }); assert.equal(out.status, 200);
  out = await req('/api/agent/global/approval-tier', { method: 'POST', body: JSON.stringify({ approvalTier: '1' }) }); assert.equal(out.status, 200);
  out = await req('/api/agent/global/commands'); assert.equal(out.status, 404);
  console.log('global agent HTTP: disabled gates, status/prompt validation, scope forwarding and command absence passed');
} finally { await new Promise((resolve) => server.close(resolve)); db.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
