import assert from 'node:assert/strict';
import { createWecomMockServer } from './lib/wecom-mock-server.js';
import { createWecomTransport } from '../src/lib/im/wecom-transport.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}
function messageFrame(msgid, userid = 'zhangsan_test') {
  return { cmd: 'aibot_msg_callback', headers: { req_id: `r-${msgid}` }, body: { msgid, chattype: 'single', from: { userid }, msgtype: 'text', text: { content: 'hi' } } };
}

// authentication, heartbeat-compatible mock and normalized callbacks
{
  const mock = await createWecomMockServer();
  const transport = createWecomTransport({ botId: 'bot_test_0001', secret: 'secret-test-not-real', wsUrl: mock.url, requestTimeout: 80, reconnectInterval: 10 });
  const messages = [];
  transport.on('message', (value) => messages.push(value));
  transport.connect();
  assert.ok(await waitFor(() => transport.state().state === 'ready'));
  mock.pushMessage({ msgid: 'text-1', msgtype: 'text', content: '文字' });
  mock.pushMessage({ msgid: 'voice-1', msgtype: 'voice', content: '语音转写' });
  mock.pushMessage({ msgid: 'mixed-1', msgtype: 'mixed', items: [{ msgtype: 'image' }, { msgtype: 'text', text: { content: '图文' } }, { msgtype: 'text', text: { content: '消息' } }] });
  mock.pushMessage({ msgid: 'image-1', msgtype: 'image' });
  assert.ok(await waitFor(() => messages.length === 4));
  assert.equal(messages[0].text, '文字');
  assert.equal(messages[1].text, '语音转写');
  assert.equal(messages[2].text, '图文消息');
  assert.equal(messages[3].text, '');
  assert.equal(messages[3].userid, 'zhangsan_test');
  assert.equal((await transport.sendMarkdown('zhangsan_test', '测试')).status, 'sent');
  assert.ok(mock.receivedBy('aibot_send_msg').length >= 1);
  transport.disconnect();
  await mock.close();
}

// three authentication failures exhaust the SDK retry budget and do not loop forever
{
  const mock = await createWecomMockServer({ authErrcode: 40001 });
  const transport = createWecomTransport({ botId: 'bot_test_0001', secret: 'secret-test-not-real', wsUrl: mock.url, reconnectInterval: 10, requestTimeout: 50 });
  transport.connect();
  assert.ok(await waitFor(() => transport.state().state === 'auth_failed', 1200));
  const count = mock.connections();
  await sleep(100);
  assert.equal(mock.connections(), count);
  transport.disconnect();
  await mock.close();
}

// acknowledgement outcomes, pre-connect failure and disconnect-at-send are distinct
{
  const mock = await createWecomMockServer({ ackErrcode: 40001 });
  const transport = createWecomTransport({ botId: 'bot_test_0001', secret: 'secret-test-not-real', wsUrl: mock.url, requestTimeout: 60 });
  assert.equal((await transport.sendMarkdown('zhangsan_test', '未连接')).status, 'failed');
  transport.connect();
  assert.ok(await waitFor(() => transport.state().state === 'ready'));
  const failed = await transport.sendMarkdown('zhangsan_test', '失败');
  assert.equal(failed.status, 'failed');
  assert.match(failed.detail, /40001/);
  transport.disconnect();
  await mock.close();

  const noAck = await createWecomMockServer({ sendAck: false });
  const t2 = createWecomTransport({ botId: 'bot_test_0001', secret: 'secret-test-not-real', wsUrl: noAck.url, requestTimeout: 40 });
  t2.connect();
  assert.ok(await waitFor(() => t2.state().state === 'ready'));
  assert.equal((await t2.sendMarkdown('zhangsan_test', '无回执')).status, 'unknown');
  const before = noAck.receivedBy('aibot_send_msg').length;
  const inFlight = t2.sendMarkdown('zhangsan_test', '断线');
  await sleep(5);
  noAck.closeClients();
  assert.equal((await inFlight).status, 'unknown');
  assert.equal(noAck.receivedBy('aibot_send_msg').length, before + 1);
  assert.ok(await waitFor(() => t2.state().state === 'ready', 1500));
  assert.equal(noAck.receivedBy('aibot_send_msg').length, before + 1, 'unknown send is never replayed after reconnect');
  t2.disconnect();
  await noAck.close();
}

// kicked connections stay down until an explicit connect()
{
  const mock = await createWecomMockServer();
  const transport = createWecomTransport({ botId: 'bot_test_0001', secret: 'secret-test-not-real', wsUrl: mock.url, reconnectInterval: 10 });
  transport.connect();
  assert.ok(await waitFor(() => transport.state().state === 'ready'));
  mock.pushEvent('disconnected_event');
  assert.ok(await waitFor(() => transport.state().state === 'kicked'));
  const count = mock.connections();
  await sleep(80);
  assert.equal(mock.connections(), count);
  transport.connect();
  assert.ok(await waitFor(() => transport.state().state === 'ready'));
  transport.disconnect();
  await mock.close();
}

// the per-user limiter is bounded and returns rate_limited without a real minute-long wait
{
  const mock = await createWecomMockServer();
  const transport = createWecomTransport({ botId: 'bot_test_0001', secret: 'secret-test-not-real', wsUrl: mock.url, requestTimeout: 50, rateLimitMax: 25, rateLimitWindowMs: 60000, now: () => 0 });
  transport.connect();
  assert.ok(await waitFor(() => transport.state().state === 'ready'));
  for (let i = 0; i < 25; i += 1) assert.equal((await transport.sendMarkdown('zhangsan_test', `#${i}`)).status, 'sent');
  assert.equal((await transport.sendMarkdown('zhangsan_test', '#26')).status, 'failed');
  assert.equal((await transport.sendMarkdown('zhangsan_test', '#27')).detail, 'rate_limited');
  transport.disconnect();
  await mock.close();
}

// all logger output is redacted, and an SDK error event is contained
{
  const lines = [];
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (...args) => lines.push(`${level}:${args.join(' ')}`)]));
  const mock = await createWecomMockServer();
  const transport = createWecomTransport({ botId: 'bot_test_0001', secret: 'secret-test-not-real', wsUrl: mock.url, logger, requestTimeout: 50 });
  transport.on('error', () => {});
  transport.connect();
  assert.ok(await waitFor(() => transport.state().state === 'ready'));
  transport._client().emit('error', new Error('secret-test-not-real bot_test_0001')); // must not terminate this process
  assert.ok(lines.every((line) => !line.includes('secret-test-not-real') && !line.includes('bot_test_0001')));
  transport.disconnect();
  await mock.close();
}

console.log('wecom transport authentication/message/send/rate-limit/kick/error matrix passed');
