import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveStartupConfig } from '../src/lib/startup-config.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-im-settings-'));
process.env.DB_PATH = path.join(scratch, 'settings.db');
process.env.ANJIAN_SECRET = 'secret-test-not-real-0123456789-abcdef';
const { db, audit } = await import('../src/db.js');
const { createSettingsRouter } = await import('../src/routes/settings.js');
const { settingsEvents } = await import('../src/lib/settings-events.js');
const supervisor = { stops: 0, async stopAll() { this.stops += 1; } };
const changes = [];
const onChange = (keys) => changes.push([...keys]);
settingsEvents.on('changed', onChange);
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = 'settings-test'; next(); });
app.use('/api', createSettingsRouter(supervisor));
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function put(body) {
  const response = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function get() { return fetch(`${base}/api/settings`).then((r) => r.json()); }
try {
  let result = await put({ im_wecom_secret: 'secret-test-not-real' });
  assert.equal(result.status, 200);
  const encrypted = db.prepare("SELECT value FROM settings WHERE key='im_wecom_secret_encrypted'").get().value;
  assert.match(encrypted, /^v1:/);
  assert.ok(!encrypted.includes('secret-test-not-real'));
  let view = await get();
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes('secret-test-not-real'));
  assert.ok(!serialized.includes(encrypted));
  assert.equal(view.im_wecom_secret_configured, true);
  assert.equal(view.im_wecom_secret_source, 'stored');
  assert.equal(view.im_wecom_secret_masked, '…real');
  assert.equal(changes.at(-1).includes('im_wecom_secret_encrypted'), true);

  result = await put({ im_wecom_secret: '' });
  assert.equal(result.status, 200);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='im_wecom_secret_encrypted'").get().value, '');
  assert.equal((await get()).im_wecom_secret_configured, false);
  assert.equal((await put({ im_wecom_secret: '   ' })).status, 400);

  assert.equal((await put({ im_wecom_enabled: 'yes' })).status, 400);
  assert.equal((await put({ im_wecom_remind_mode: 'later' })).status, 400);
  assert.equal((await put({ im_wecom_bot_id: 'bot bad' })).status, 400);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='im_wecom_enabled'").get(), undefined);
  assert.equal((await put({ im_wecom_secret_encrypted: 'v1:client-forged' })).status, 200);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='im_wecom_secret_encrypted'").get().value, '');

  const beforeStops = supervisor.stops;
  await put({ im_wecom_enabled: 'true', im_wecom_bot_id: 'bot_test_0001', im_wecom_remind_mode: 'preview' });
  assert.equal(supervisor.stops, beforeStops, 'IM settings never stop the AI worker');
  assert.ok(changes.some((keys) => keys.includes('im_wecom_enabled')));
  await put({ agent_model: 'test-model' });
  assert.ok(supervisor.stops > beforeStops, 'agent runtime setting still stops workers');
  const auditRows = db.prepare("SELECT detail FROM audit_log WHERE action='update'").all();
  assert.ok(auditRows.every((row) => !row.detail.includes('secret-test-not-real')));

  process.env.ANJIAN_WECOM_BOT_ID = 'bot_test_0001';
  process.env.ANJIAN_WECOM_BOT_SECRET = 'secret-test-not-real';
  view = await get();
  assert.equal(view.im_wecom_secret_source, 'env');
  assert.equal(view.im_wecom_bot_id_source, 'env');
  assert.equal(view.im_wecom_bot_id, 'bot_test_0001');
  delete process.env.ANJIAN_WECOM_BOT_SECRET;
  assert.throws(() => resolveStartupConfig({ NODE_ENV: 'test', HOST: '127.0.0.1', ANJIAN_UNSAFE_NO_AUTH: '1', ANJIAN_WECOM_BOT_ID: 'bot_test_0001' }), /必须同时配置/);
  assert.throws(() => resolveStartupConfig({ NODE_ENV: 'test', HOST: '127.0.0.1', ANJIAN_UNSAFE_NO_AUTH: '1', ANJIAN_WECOM_WS_URL: 'ws://example.com' }), /wss/);
  assert.equal(resolveStartupConfig({ NODE_ENV: 'test', HOST: '127.0.0.1', ANJIAN_UNSAFE_NO_AUTH: '1', ANJIAN_WECOM_WS_URL: 'ws://127.0.0.1:1234' }).wecom.wsUrl, 'ws://127.0.0.1:1234');
  assert.equal(resolveStartupConfig({ NODE_ENV: 'test', HOST: '127.0.0.1', ANJIAN_UNSAFE_NO_AUTH: '1', ANJIAN_WECOM_WS_URL: 'wss://example.com' }).wecom.wsUrl, 'wss://example.com');
  console.log('IM settings HTTP secret, validation, env, events and worker-isolation matrix passed');
} finally {
  settingsEvents.off('changed', onChange);
  await new Promise((resolve) => server.close(resolve));
  db.close();
  delete process.env.ANJIAN_WECOM_BOT_ID;
  delete process.env.ANJIAN_WECOM_BOT_SECRET;
  delete process.env.ANJIAN_SECRET;
  fs.rmSync(scratch, { recursive: true, force: true });
}
