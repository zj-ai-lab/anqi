import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-im-e2e-'));
process.env.DB_PATH = path.join(scratch, 'e2e.db');
const { runMigrations, db } = await import('../src/db.js');
const { createImHub } = await import('../src/lib/im/hub.js');
const { createWecomTransport } = await import('../src/lib/im/wecom-transport.js');
const { createWecomMockServer } = await import('./lib/wecom-mock-server.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 1500) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (predicate()) return true; await sleep(10); } return predicate(); }
class FakeSupervisor {
  constructor() { this.listeners = new Set(); this.live = true; this.next = 1; }
  onEvent(_scope, fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  isLive() { return this.live; }
  async start() { this.live = true; return { status: 'ready' }; }
  async prompt() {
    const turnId = this.next++;
    this.listeners.forEach((fn) => fn({ type: 'turn/start', data: { turnId, origin: 'im:wecom' } }));
    queueMicrotask(() => {
      this.listeners.forEach((fn) => fn({ type: 'assistant/message', origin: 'wire', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'AI 总入口最终结果' }] } } }));
      this.listeners.forEach((fn) => fn({ type: 'turn/end', data: { turnId, outcome: 'completed' } }));
    });
    return { turnId };
  }
}
runMigrations(db);
db.prepare("INSERT INTO settings(key,value) VALUES ('im_wecom_enabled','true'),('im_wecom_remind_mode','preview'),('agent_enabled','true'),('agent_provider','deepseek-official'),('agent_model','deepseek-chat'),('agent_base_url','https://api.deepseek.com/v1')").run();
const mock = await createWecomMockServer();
const env = { ANJIAN_WECOM_BOT_ID: 'bot_test_0001', ANJIAN_WECOM_BOT_SECRET: 'secret-test-not-real', ANJIAN_WECOM_WS_URL: mock.url };
const hub = createImHub({ db, supervisor: new FakeSupervisor(), env, transportFactory: (options) => createWecomTransport(options) });
await hub.start();
assert.ok(await waitFor(() => hub.status().connection.state === 'ready'));
const challenge = hub.bindStart('e2e-test');
mock.pushMessage({ msgid: 'e2e-bind', userid: 'zhangsan_test', content: challenge.code });
assert.ok(await waitFor(() => hub.status().binding.bound));
const before = mock.receivedBy('aibot_respond_msg').length;
mock.pushMessage({ msgid: 'e2e-prompt', userid: 'zhangsan_test', content: '请记住这一条' });
assert.ok(await waitFor(() => mock.receivedBy('aibot_respond_msg').length >= before + 2));
const frames = mock.receivedBy('aibot_respond_msg').slice(before);
const streams = frames.map((frame) => frame.body?.stream);
assert.equal(streams[0].finish, false);
assert.equal(streams.at(-1).finish, true);
assert.equal(streams.at(-1).content, 'AI 总入口最终结果');
const after = mock.receivedBy('aibot_respond_msg').length;
mock.pushMessage({ msgid: 'e2e-other', userid: 'lisi_test', content: '不应处理' });
await sleep(100);
assert.equal(mock.receivedBy('aibot_respond_msg').length, after);
await hub.stop();
await mock.close();
db.close();
fs.rmSync(scratch, { recursive: true, force: true });
console.log('IM end-to-end SDK/mock/hub/bridge flow passed');
