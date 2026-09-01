// AI 助理命令宿主/HTTP 桥：真实 AgentSupervisor + 真实 Express 路由，只有
// worker stdio 是协议假件。验证 case→worker→session 归属、命令清单投影、
// `/` 命中/未命中/缺服务分流，以及命令只沿 session.status 而不伪造 turn。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-commands-http-'));
process.env.DB_PATH = path.join(scratch, 'commands-http.db');

const { db } = await import('../src/db.js');
const { AgentSupervisor } = await import('../src/agent/supervisor.js');
const { AGENT_SETTINGS_KEYS } = await import('../src/agent/config.js');
const { createAgentRouter } = await import('../src/routes/agent.js');

function upsertSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

upsertSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
upsertSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
upsertSetting(AGENT_SETTINGS_KEYS.model, 'test-model');
upsertSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'TEST_AGENT_COMMANDS_HTTP_KEY');

const caseId = db.prepare(
  "INSERT INTO cases (name, procedure, stage) VALUES ('命令桥绑定案','一审','审理中')"
).run().lastInsertRowid;
const otherCaseId = db.prepare(
  "INSERT INTO cases (name, procedure, stage) VALUES ('命令桥他案','一审','审理中')"
).run().lastInsertRowid;

const descriptors = [
  { name: 'compact', description: 'Compact context', privateField: 'must-not-leak' },
  { name: 'feedback', description: 'Send feedback', input: { hint: '<text>' } },
  { name: 'goal', description: 'Set a goal', input: { hint: '<objective>', images: true } },
  { name: 'plan', description: 'Enter plan mode' },
];
const rpcFrames = [];
const emitted = [];
let listMode = 'available';
let executeMode = 'available';

function identityRedact(value) {
  return String(value);
}
identityRedact.approval = identityRedact;
identityRedact.deep = (value) => structuredClone(value);

const supervisor = new AgentSupervisor({
  loadConfigFn: () => ({ enabled: true }),
  turnTimeoutMs: 1_000,
});
const sessionId = 'owned-session-command-http';
const worker = {
  caseId,
  caseName: '命令桥绑定案',
  sessionId,
  status: 'ready',
  child: null,
  pendingRpc: new Map(),
  pendingInteractions: new Map(),
  uiHistory: [],
  nextRpcId: 1,
  nextTurnId: 1,
  turnLock: Promise.resolve(),
  currentAbort: null,
  _commandState: null,
  _idleWaiters: new Set(),
  _turnResolvers: null,
  firstTurnChecked: true,
  redact: identityRedact,
  emit(type, data, origin = 'supervisor') {
    emitted.push({ type, data, origin });
  },
};

function send(frame) {
  supervisor._handleLine(worker, JSON.stringify(frame));
}

function sendSessionStatus(status) {
  send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status } });
}

function sendSessionEvent(type, data) {
  send({
    jsonrpc: '2.0',
    method: 'session.event',
    params: { sessionId, event: { type, data } },
  });
}

function handleRpc(frame) {
  rpcFrames.push(structuredClone(frame));
  if (frame.method === 'command/list') {
    if (listMode === 'unavailable') {
      send({
        jsonrpc: '2.0', id: frame.id,
        result: { ok: false, error: { code: 'commands_unavailable', message: 'project mode' } },
      });
      return;
    }
    if (listMode === 'empty') {
      send({ jsonrpc: '2.0', id: frame.id, result: { ok: true, commands: [] } });
      return;
    }
    if (listMode === 'malformed') {
      send({ jsonrpc: '2.0', id: frame.id, result: { ok: true, commands: [{ name: '../escape' }] } });
      return;
    }
    send({ jsonrpc: '2.0', id: frame.id, result: { ok: true, commands: descriptors } });
    return;
  }
  if (frame.method === 'command/execute') {
    if (executeMode === 'unavailable') {
      send({
        jsonrpc: '2.0', id: frame.id,
        result: { ok: false, error: { code: 'commands_unavailable', message: 'project mode' } },
      });
      return;
    }
    const line = frame.params.line;
    if (line === '/compact') {
      sendSessionEvent('command/run', {
        commandId: 'command-compact-http', name: 'compact', source: { kind: 'user' },
      });
      sendSessionEvent('command/done', {
        commandId: 'command-compact-http', kind: 'success', text: 'No compactable history yet.',
      });
      send({
        jsonrpc: '2.0', id: frame.id,
        result: {
          ok: true, matched: true,
          execution: {
            commandId: 'command-compact-http',
            result: { kind: 'success', text: 'No compactable history yet.' },
          },
        },
      });
      return;
    }
    if (line.startsWith('/goal ')) {
      sendSessionEvent('command/run', {
        commandId: 'command-goal-http', name: 'goal', args: line.slice(6), source: { kind: 'user' },
      });
      sendSessionEvent('command/done', {
        commandId: 'command-goal-http', kind: 'success', text: 'Goal created',
      });
      send({
        jsonrpc: '2.0', id: frame.id,
        result: {
          ok: true, matched: true,
          execution: {
            commandId: 'command-goal-http',
            result: { kind: 'success', text: 'Goal created' },
          },
        },
      });
      // goal-round-driver 可以在命令 RPC 已结算后才异步唤醒 agent。故意把
      // running 放到 response 后，钉住 supervisor 的 late-status 串行边界。
      setTimeout(() => sendSessionStatus('running'), 5);
      setTimeout(() => sendSessionStatus('idle'), 35);
      return;
    }
    send({ jsonrpc: '2.0', id: frame.id, result: { ok: true, matched: false } });
    return;
  }
  if (frame.method === 'session/prompt') {
    send({ jsonrpc: '2.0', id: frame.id, result: { messageId: `message-${frame.id}` } });
    queueMicrotask(() => {
      sendSessionStatus('running');
      sendSessionStatus('idle');
      sendSessionEvent('turn/end', { reason: { kind: 'completed' } });
    });
    return;
  }
  throw new Error(`unexpected RPC method: ${frame.method}`);
}

worker.child = {
  exitCode: null,
  stdin: {
    destroyed: false,
    write(chunk, callback) {
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) handleRpc(JSON.parse(line));
      }
      callback?.();
      return true;
    },
  },
};
supervisor.workers.set(caseId, worker);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => { req.actor = 'agent-commands-http-test'; next(); });
app.use('/api', createAgentRouter(supervisor));
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, urlPath, body) {
  const response = await fetch(base + urlPath, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

try {
  // router 在生产 server.js 中必须位于 apiAuth 之后；工厂本身不另造第二套鉴权。
  const serverSource = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(serverSource, /app\.use\(\s*'\/api', apiAuth,[\s\S]*?agentRouter[\s\S]*?\);/u);

  const beforeList = rpcFrames.length;
  const listed = await call(
    'GET',
    `/api/cases/${caseId}/agent/commands?sessionId=attacker-session&case_id=${otherCaseId}`,
  );
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.commands.map((command) => command.name), ['compact', 'feedback', 'goal', 'plan']);
  assert.equal(listed.data.commands[0].privateField, undefined, 'wire 描述符额外字段不得透到 HTTP');
  const listFrame = rpcFrames.slice(beforeList).find((frame) => frame.method === 'command/list');
  assert.deepEqual(listFrame.params, { sessionId }, 'session 必须来自 supervisor 的 worker，不信任 query');

  const otherCase = await call('GET', `/api/cases/${otherCaseId}/agent/commands`);
  assert.equal(otherCase.status, 409);
  assert.equal(otherCase.data.code, 'worker_not_running');

  listMode = 'unavailable';
  const unavailable = await call('GET', `/api/cases/${caseId}/agent/commands`);
  assert.equal(unavailable.status, 404);
  assert.equal(unavailable.data.code, 'commands_unavailable');
  listMode = 'empty';
  const empty = await call('GET', `/api/cases/${caseId}/agent/commands`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data, { commands: [] });
  listMode = 'malformed';
  const malformed = await call('GET', `/api/cases/${caseId}/agent/commands`);
  assert.equal(malformed.status, 502);
  assert.equal(malformed.data.code, 'command_bridge_failed');
  listMode = 'available';

  // 命中 /compact：只有 command/run·done wire 事件，不产生宿主 turn/*。
  const compactEventStart = emitted.length;
  const compactFrameStart = rpcFrames.length;
  const compact = await call('POST', `/api/cases/${caseId}/agent/prompt`, { text: '/compact' });
  assert.equal(compact.status, 202);
  assert.equal(await waitUntil(() => rpcFrames.slice(compactFrameStart).some((frame) => frame.method === 'command/execute')), true);
  await worker.turnLock;
  const compactFrames = rpcFrames.slice(compactFrameStart);
  assert.deepEqual(compactFrames.map((frame) => frame.method), ['command/execute']);
  assert.deepEqual(compactFrames[0].params, { sessionId, line: '/compact' });
  const compactEvents = emitted.slice(compactEventStart);
  assert.deepEqual(compactEvents.map((event) => event.type), ['command/run', 'command/done']);
  assert.ok(compactEvents.every((event) => event.origin === 'wire'));
  assert.equal(compactEvents.some((event) => event.type === 'turn/start' || event.type === 'turn/end'), false);

  // 命中并触发 agent 工作的命令：RPC 返回后仍保持 running，真实 idle 到达才
  // 恢复 ready/释放串行锁；仍不得伪造宿主 turn 生命周期。
  const goalEventStart = emitted.length;
  const goalFrameStart = rpcFrames.length;
  const goal = await call('POST', `/api/cases/${caseId}/agent/prompt`, { text: '/goal 核对证据' });
  assert.equal(goal.status, 202);
  assert.equal(await waitUntil(() => worker.status === 'running'), true);
  const goalEvents = emitted.slice(goalEventStart);
  assert.deepEqual(goalEvents.map((event) => event.type), ['command/run', 'command/done']);
  assert.equal(goalEvents.some((event) => event.type === 'turn/start' || event.type === 'turn/end'), false);

  const queuedStart = rpcFrames.length;
  const queuedAfterGoal = supervisor.prompt(caseId, '真实 idle 后再发这一轮');
  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.equal(
    rpcFrames.slice(queuedStart).some((frame) => frame.method === 'session/prompt'),
    false,
    '命令后的 late running 尚未回 idle 时，不得启动下一条普通 turn',
  );
  await queuedAfterGoal;
  assert.equal(worker.status, 'ready');
  assert.deepEqual(
    rpcFrames.slice(goalFrameStart).map((frame) => frame.method),
    ['command/execute', 'session/prompt'],
  );

  // 未命中和 project 缺服务都把原文交给普通 prompt；普通文本则根本不探测
  // command/execute。三条路径均使用 supervisor 持有的 session。
  const unknownStart = rpcFrames.length;
  await call('POST', `/api/cases/${caseId}/agent/prompt`, { text: '/unknown keep this exact' });
  assert.equal(await waitUntil(() => rpcFrames.slice(unknownStart).filter((frame) => frame.method === 'session/prompt').length === 1), true);
  await worker.turnLock;
  const unknownFrames = rpcFrames.slice(unknownStart);
  assert.deepEqual(unknownFrames.map((frame) => frame.method), ['command/execute', 'session/prompt']);
  assert.equal(unknownFrames[1].params.sessionId, sessionId);
  assert.equal(unknownFrames[1].params.contentBlocks[0].text, '/unknown keep this exact');

  executeMode = 'unavailable';
  const projectStart = rpcFrames.length;
  await call('POST', `/api/cases/${caseId}/agent/prompt`, { text: '/project-only-text' });
  assert.equal(await waitUntil(() => rpcFrames.slice(projectStart).some((frame) => frame.method === 'session/prompt')), true);
  await worker.turnLock;
  assert.deepEqual(rpcFrames.slice(projectStart).map((frame) => frame.method), ['command/execute', 'session/prompt']);
  executeMode = 'available';

  const plainStart = rpcFrames.length;
  await call('POST', `/api/cases/${caseId}/agent/prompt`, { text: '普通文本' });
  assert.equal(await waitUntil(() => rpcFrames.length > plainStart), true);
  await worker.turnLock;
  assert.deepEqual(rpcFrames.slice(plainStart).map((frame) => frame.method), ['session/prompt']);

  console.log(`EVIDENCE_HTTP_COMMAND_LIST ${JSON.stringify(listed.data.commands)}`);
  console.log(`EVIDENCE_HTTP_COMPACT_EVENTS ${JSON.stringify(compactEvents)}`);
  console.log(`EVIDENCE_HTTP_SLASH_FALLBACK ${JSON.stringify(unknownFrames.map((frame) => ({ method: frame.method, params: frame.params })))}`);
  console.log('agent command host/http bridge: auth mount + supervisor-owned session + list projection + hit/miss/status contracts passed');
} finally {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
