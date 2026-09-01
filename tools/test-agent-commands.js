// dsh-anqi-jsonrpc 命令桥契约：按 exact live session 取 agent、可选服务 fail-closed、
// 已知命令执行而未知命令明确不匹配。transport/ctx 均为边界假件，被测 server 为真实现。
import assert from 'node:assert/strict';

const { AnqiJsonRpcServer, inject } = await import('../src/agent/assets/plugins/dsh-anqi-jsonrpc/index.js');

assert.equal(inject.includes('commands'), false, 'project 档不得被 commands 强制注入拖垮');

const notifications = [];
const transport = {
  notify(method, params) {
    notifications.push({ method, params });
  },
};
const disposers = [];
let commandService;
const agent = {
  id: 'agent-command-test',
  session: { id: 'session-command-test' },
};
const ctx = {
  on() {
    const dispose = () => {};
    disposers.push(dispose);
    return dispose;
  },
  agents: {
    get(id) {
      return id === agent.id ? agent : undefined;
    },
  },
  get(name) {
    assert.equal(name, 'commands');
    return commandService;
  },
};

const server = new AnqiJsonRpcServer(ctx, transport);
server.sessions.set(String(agent.session.id), { handle: { agent, dispose() {} } });

const missingList = await server.handleRequest('command/list', { sessionId: String(agent.session.id) });
assert.deepEqual(missingList, {
  ok: false,
  error: {
    code: 'commands_unavailable',
    message: 'slash commands are unavailable for this worker capability mode',
  },
});
const missingExecute = await server.handleRequest('command/execute', {
  sessionId: String(agent.session.id),
  line: '/compact',
});
assert.equal(missingExecute.ok, false);
assert.equal(missingExecute.error.code, 'commands_unavailable');

const descriptors = Object.freeze([
  Object.freeze({ name: 'compact', description: 'Compact context' }),
  Object.freeze({ name: 'feedback', description: 'Send feedback', input: Object.freeze({ hint: '<text>' }) }),
  Object.freeze({ name: 'goal', description: 'Set a goal', input: Object.freeze({ hint: '<text>' }) }),
  Object.freeze({ name: 'plan', description: 'Enter plan mode' }),
]);
const executeCalls = [];
commandService = {
  list(receivedAgent) {
    assert.equal(receivedAgent, agent, '必须把 session 绑定的 exact live agent 交给命令表');
    return descriptors;
  },
  async execute(receivedAgent, line, images, signal) {
    executeCalls.push({ receivedAgent, line, images, signal });
    if (line !== '/compact') return undefined;
    return {
      commandId: 'command-test-1',
      result: { kind: 'success', text: 'compacted' },
    };
  },
};

const listed = await server.handleRequest('command/list', { sessionId: String(agent.session.id) });
assert.deepEqual(listed, { ok: true, commands: descriptors });

const executed = await server.handleRequest('command/execute', {
  sessionId: String(agent.session.id),
  line: '/compact',
});
assert.deepEqual(executed, {
  ok: true,
  matched: true,
  execution: {
    commandId: 'command-test-1',
    result: { kind: 'success', text: 'compacted' },
  },
});
assert.equal(executeCalls[0].receivedAgent, agent);
assert.deepEqual(executeCalls[0].images, [], '当前宿主协议不接收命令图片');
assert.equal(executeCalls[0].signal, server.shutdownController.signal);

const unmatched = await server.handleRequest('command/execute', {
  sessionId: String(agent.session.id),
  line: '/not-a-command keep this text',
});
assert.deepEqual(unmatched, { ok: true, matched: false });

await assert.rejects(
  server.handleRequest('command/list', { sessionId: 'another-session' }),
  /session is unknown or no longer live/,
);
await assert.rejects(
  server.handleRequest('command/execute', { sessionId: String(agent.session.id), line: '' }),
  /requires a non-empty line/,
);

assert.equal(notifications.length, 0);
await server.shutdown();
assert.equal(server.shutdownController.signal.aborted, true);
console.log(`EVIDENCE_COMMAND_LIST ${JSON.stringify(listed.commands)}`);
console.log(`EVIDENCE_COMMAND_EXECUTE ${JSON.stringify(executed)}`);
console.log('agent command worker bridge: optional service + exact session agent + list/execute/miss contracts passed');
