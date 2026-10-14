import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
import { encryptSecret, resolveMasterKey } from '../src/lib/secret-box.js';
import { settingsEvents } from '../src/lib/settings-events.js';
import { createImHub } from '../src/lib/im/hub.js';
import { createWecomTransport } from '../src/lib/im/wecom-transport.js';
import { createWecomMockServer } from './lib/wecom-mock-server.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await sleep(10); }
  return predicate();
}
const supervisor = { onEvent: () => () => {}, isLive: () => true, prompt: async () => ({ turnId: 1 }) };
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
runMigrations(db);
const mock = await createWecomMockServer();
const env = { ANJIAN_WECOM_BOT_ID: 'bot_test_0001', ANJIAN_WECOM_BOT_SECRET: 'secret-test-not-real', ANJIAN_WECOM_WS_URL: mock.url };
db.prepare("INSERT INTO settings(key,value) VALUES ('im_wecom_enabled','true'),('im_wecom_remind_mode','preview')").run();
let factoryCalls = 0;
const hub = createImHub({ db, supervisor, env, transportFactory: (options) => { factoryCalls += 1; return createWecomTransport(options); } });
await hub.start();
assert.ok(await waitFor(() => hub.status().connection.state === 'ready'));
assert.equal(factoryCalls, 1);
assert.equal(hub.status().credentials.source, 'env');
assert.equal(hub.status().credentials.bot_id, 'bot_test_0001');

const notReadyDb = new Database(':memory:');
runMigrations(notReadyDb);
const notReady = createImHub({ db: notReadyDb, supervisor, env: {}, transportFactory: () => { throw new Error('no external connection'); } });
await notReady.start();
assert.equal(notReady.bindStart().error, 'im_not_ready');
await notReady.stop();
notReadyDb.close();

const challenge = hub.bindStart('web-test');
assert.match(challenge.code, /^绑定 [A-Z2-9]{8}$/);
mock.pushMessage({ msgid: 'group-code', chattype: 'group', userid: 'zhangsan_test', content: challenge.code });
await sleep(40);
assert.equal(hub.status().binding.bound, false);
assert.equal(mock.receivedBy('aibot_respond_msg').length, 0);
mock.pushMessage({ msgid: 'wrong-code', chattype: 'single', userid: 'zhangsan_test', content: '绑定 WRONG000' });
await sleep(40);
assert.equal(hub.status().binding.bound, false);
mock.pushMessage({ msgid: 'bind-ok', chattype: 'single', userid: 'zhangsan_test', content: `  ${challenge.code.toLowerCase().replace(' ', '   ')}  ` });
assert.ok(await waitFor(() => hub.status().binding.bound));
const replyCount = mock.receivedBy('aibot_respond_msg').length;
assert.ok(mock.receivedBy('aibot_respond_msg').some((frame) => JSON.stringify(frame).includes('绑定成功')));
mock.pushMessage({ msgid: 'bind-replay', chattype: 'single', userid: 'zhangsan_test', content: challenge.code });
await sleep(40);
assert.ok(mock.receivedBy('aibot_respond_msg').length >= replyCount);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='im-bind'").get().n, 1, 'one-shot challenge cannot bind twice');
assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='im-bind'").get());
assert.ok(db.prepare("SELECT detail FROM audit_log WHERE action='im-bind'").get().detail.includes('provider=wecom'));
assert.ok(!db.prepare("SELECT detail FROM audit_log WHERE action='im-bind'").get().detail.includes('zhangsan_test'));

// all non-owner and group messages are ignored, and duplicate msgids are processed once
const ignoredBefore = hub.status().counters.ignored;
mock.pushMessage({ msgid: 'other-user', chattype: 'single', userid: 'lisi_test', content: '不处理' });
mock.pushMessage({ msgid: 'owner-group', chattype: 'group', userid: 'zhangsan_test', content: '不处理' });
mock.pushMessage({ msgid: 'other-user', chattype: 'single', userid: 'lisi_test', content: '重复' });
await sleep(80);
assert.equal(hub.status().counters.ignored, ignoredBefore + 2);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM im_inbound WHERE msgid='other-user'").get().n, 1);
assert.equal(db.prepare("SELECT outcome FROM im_inbound WHERE msgid='other-user'").get().outcome, 'ignored');

// unsupported media is answered without touching the supervisor
mock.pushMessage({ msgid: 'image-only', chattype: 'single', userid: 'zhangsan_test', msgtype: 'image' });
assert.ok(await waitFor(() => db.prepare("SELECT outcome FROM im_inbound WHERE msgid='image-only'").get()?.outcome === 'unsupported'));
assert.ok(mock.receivedBy('aibot_respond_msg').some((frame) => JSON.stringify(frame).includes('暂时只支持文字和语音')));
const dump = JSON.stringify(db.prepare('SELECT * FROM im_inbound').all());
assert.ok(!dump.includes('不处理') && !dump.includes('zhangsan_test'));
const old = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
db.prepare("INSERT INTO im_inbound(provider,msgid,received_at,outcome) VALUES ('wecom','old-msg',?,'ignored')").run(old);
hub.prune();
assert.equal(db.prepare("SELECT 1 FROM im_inbound WHERE msgid='old-msg'").get(), undefined);

// changing the current BotID invalidates the binding; changing back restores it
const oldBot = env.ANJIAN_WECOM_BOT_ID;
env.ANJIAN_WECOM_BOT_ID = 'bot_test_0002';
settingsEvents.emit('changed', ['im_wecom_bot_id']);
assert.ok(await waitFor(() => hub.status().credentials.bot_id === 'bot_test_0002'));
assert.equal(hub.status().binding.bound, false);
env.ANJIAN_WECOM_BOT_ID = oldBot;
settingsEvents.emit('changed', ['im_wecom_bot_id']);
assert.ok(await waitFor(() => hub.status().binding.bound));
const afterBotChange = factoryCalls;
settingsEvents.emit('changed', ['im_wecom_remind_mode']);
await sleep(50);
assert.equal(factoryCalls, afterBotChange, 'mode-only reload does not reconnect');

// a stored credential change causes a new transport, while disabled mode never constructs one
const disabledDb = new Database(':memory:');
runMigrations(disabledDb);
let disabledCalls = 0;
const disabled = createImHub({ db: disabledDb, supervisor, env: {}, transportFactory: () => { disabledCalls += 1; throw new Error('external call'); } });
await disabled.start();
assert.equal(disabled.status().connection.state, 'disabled');
assert.equal(disabledCalls, 0);
await disabled.stop();
disabledDb.close();

await hub.stop();
await mock.close();
db.close();
console.log('IM hub binding, dedup, routing, cache/reload and zero-external matrix passed');
