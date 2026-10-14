import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-im-http-'));
process.env.DB_PATH = path.join(scratch, 'im-http.db');
const { db } = await import('../src/db.js');
const { createImRouter } = await import('../src/routes/im.js');
let state = 'ready';
let bound = false;
let testCalls = 0;
const hub = {
  status: () => ({ enabled: true, credentials: { configured: true, source: 'stored', bot_id: 'bot_test_0001' }, connection: { state, since: '2099-01-01T00:00:00.000Z', last_error: null }, binding: { bound, userid_masked: bound ? 'zh***t' : '', bound_at: bound ? '2099-01-01T00:00:00.000Z' : null }, challenge: { active: false, expires_at: null }, remind_mode: 'preview', counters: { ignored: 0, prompted: 0, answered: 0, unsupported: 0, failed: 0 } }),
  bindStart: () => ({ code: '绑定 ABCD2345', expires_at: '2099-01-01T00:10:00.000Z' }),
  unbind: () => { bound = false; db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,detail) VALUES ('http-test','im-unbind','im-binding',0,'provider=wecom')").run(); return { ok: true }; },
  reconnect: () => ['kicked', 'auth_failed', 'error'].includes(state) && (state = 'ready', true),
  test: async () => { testCalls += 1; return { status: 'sent', detail: 'ok' }; },
};
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = 'http-test'; next(); });
app.use('/api', createImRouter(hub));
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function request(path, method = 'GET') {
  const response = await fetch(base + path, { method });
  return { status: response.status, data: await response.json() };
}
try {
  let response = await request('/api/im/wecom/status');
  assert.equal(response.status, 200);
  assert.equal(response.data.credentials.bot_id, 'bot_test_0001');
  assert.equal(response.data.binding.userid_masked, '');
  assert.ok(!JSON.stringify(response.data).includes('secret-test-not-real'));
  assert.ok(!JSON.stringify(response.data).includes('v1:'));
  response = await request('/api/im/wecom/bind/start', 'POST');
  assert.equal(response.status, 200);
  assert.equal(response.data.code, '绑定 ABCD2345');
  bound = false;
  response = await request('/api/im/wecom/test', 'POST');
  assert.equal(response.status, 409);
  bound = true;
  state = 'connecting';
  response = await request('/api/im/wecom/test', 'POST');
  assert.equal(response.status, 409);
  state = 'ready';
  response = await request('/api/im/wecom/test', 'POST');
  assert.equal(response.status, 200);
  assert.equal(response.data.status, 'sent');
  assert.equal(testCalls, 1);
  state = 'ready';
  response = await request('/api/im/wecom/reconnect', 'POST');
  assert.equal(response.status, 409);
  state = 'kicked';
  response = await request('/api/im/wecom/reconnect', 'POST');
  assert.equal(response.status, 200);
  assert.equal(state, 'ready');
  response = await request('/api/im/wecom/unbind', 'POST');
  assert.equal(response.status, 200);
  assert.equal(response.data.ok, true);
  assert.ok(db.prepare("SELECT action FROM audit_log WHERE action IN ('im-reconnect','im-test','im-unbind')").all().length >= 3);
  console.log('IM HTTP status/bind/unbind/reconnect/test gate and audit matrix passed');
} finally {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
