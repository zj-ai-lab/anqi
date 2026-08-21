// DSH sidecar supervisor 最小自检——不发模型请求，不需要模型 key。
// 场景 1-3 用注入的 spawnFn 断言"从未被调用"，验证两条门禁红线：
//   1. enabled=false 必须在读 credential、spawn 子进程之前短路返回；
//   2. 案件夹越出 ANJIAN_FILES_ROOT（包括 symlink 越权）必须被拒绝，且同样
//      不能走到 spawn 那一步。
// 场景 4-7 用一个走 stdin/stdout JSON-RPC 协议的 FakeChild（不是真的 DSH 子
// 进程，只回放协议帧）验证修复轮审查发现的几条 turn/worker 生命周期红线：
// turn 超时必须真正终止 worker、首个 turn 的 MCP 门禁失败不能被第二个 turn
// 绕过、跨 session 的反向请求必须原地拒绝不入表、pendingInteractions 对外
// 查询必须脱敏。
//
// DB_PATH 隔离到临时文件：这个脚本会插入案件行、写 agent_* 设置，绝不能碰
// 仓库真实的 data/anjian.db——否则跑一次自检就会在真实设置表里把
// agent_enabled=true 打开、留下几条自检案永久残留。db.js 的 DB_PATH 在模块
// 首次执行时读一次 process.env，必须在任何静态 import 触发它加载之前设置
// 好，所以这里延后到动态 import（与 tools/test-auth-security.js 同一套写法）。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

const scratchDb = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-supervisor-db-'));
process.env.DB_PATH = path.join(scratchDb, 'agent-supervisor.db');

const { db } = await import('../src/db.js');
const { AgentSupervisor, AGENT_RUNTIME_PATHS } = await import('../src/agent/supervisor.js');
const { AGENT_SETTINGS_KEYS } = await import('../src/agent/config.js');

const REQUIRED_MCP_TOOL = AGENT_RUNTIME_PATHS.requiredMcpTool;

// ---- 场景 4-7 共用：一个只回放 JSON-RPC 协议帧的假子进程，不拉起真 DSH ----
class FakeChild extends EventEmitter {
  constructor(onFrame) {
    super();
    this.pid = 424242;
    this.exitCode = null;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.stdin.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        onFrame(JSON.parse(line), this);
      }
    });
  }

  sendLine(obj) {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  kill(signal) {
    this.killed = true;
    this.lastKillSignal = signal;
    // 真实子进程收到 SIGTERM 后是异步退出的；这里也异步 emit，避免掩盖
    // supervisor 对"退出是异步事件"这件事的处理。
    setImmediate(() => this.emitExit(0, signal));
  }

  emitExit(code, signal) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code, signal);
  }
}

// 默认自动应答 initialize/session-create/preflight/shutdown，让场景只需要
// 关心 session/prompt 之后的行为；handlers 可以覆盖任意一个方法名。
function makeFakeChild(sessionId, handlers = {}) {
  const child = new FakeChild((frame, c) => {
    const handler = handlers[frame.method];
    if (handler) {
      handler(frame, c);
      return;
    }
    if (frame.method === 'initialize') {
      c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
    } else if (frame.method === 'session/create') {
      c.sendLine({ jsonrpc: '2.0', id: frame.id, result: { sessionId } });
    } else if (frame.method === 'session/preflight') {
      c.sendLine({ jsonrpc: '2.0', id: frame.id, result: { ready: true } });
    } else if (frame.method === 'shutdown') {
      c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
      c.emitExit(0, null);
    }
  });
  return child;
}

function sendRunningIdleTurnEnd(child, sessionId, { includeMcpEvidence }) {
  child.sendLine({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'running' } });
  if (includeMcpEvidence) {
    child.sendLine({
      jsonrpc: '2.0', method: 'session.event',
      params: { sessionId, event: { type: 'request/header', data: { reason: 'initial', tools: [{ name: REQUIRED_MCP_TOOL }] } } },
    });
    child.sendLine({
      jsonrpc: '2.0', method: 'session.event',
      params: { sessionId, event: { type: 'tool/call', data: { name: REQUIRED_MCP_TOOL } } },
    });
  } else {
    child.sendLine({
      jsonrpc: '2.0', method: 'session.event',
      params: { sessionId, event: { type: 'request/header', data: { reason: 'initial', tools: [] } } },
    });
  }
  child.sendLine({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } });
  child.sendLine({
    jsonrpc: '2.0', method: 'session.event',
    params: { sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  });
}

async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

// supervisor.js 里 turnTimeoutMs/interactionTtlMs 相关的计时器都故意
// `.unref()`——生产环境下这是对的（真实子进程句柄本来就会撑住事件循环，
// 一个计时器本身不该单独阻止整个进程退出）。但这里的 FakeChild 只是几个
// PassThrough + EventEmitter，没有任何真实 OS 句柄撑住事件循环；如果直接
// `await` 一个只能靠这类 unref 计时器才会 settle 的 promise，一旦其它调度都
// 跑完，Node 会判定"事件循环已经没有活干了"而不会等这个 unref 计时器触发，
// 顶层 await 因此真的会永远挂起。用 waitUntil 的 ref 式 setTimeout 轮询把
// settle 结果"钓"出来，规避的是测试替身的这个环境差异，不是在绕过被测代码。
async function settle(promise) {
  let outcome;
  promise.then((value) => { outcome = { ok: true, value }; }, (error) => { outcome = { ok: false, error }; });
  const done = await waitUntil(() => outcome !== undefined, { timeoutMs: 5000 });
  assert.equal(done, true, 'promise 迟迟没有 settle——测试本身卡住了');
  return outcome;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

function clearAgentSettings() {
  for (const key of Object.values(AGENT_SETTINGS_KEYS)) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
}

function insertCase(name) {
  const info = db.prepare(
    `INSERT INTO cases (name, procedure, stage, status) VALUES (?, '一审', '', 'active')`
  ).run(name);
  return info.lastInsertRowid;
}

function neverSpawn() {
  return () => { throw new Error('spawnFn must not be called for this scenario'); };
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-supervisor-'));
const filesRoot = path.join(scratch, 'files');
fs.mkdirSync(filesRoot, { recursive: true });

// ---- 场景 1：enabled=false 短路 ----
{
  clearAgentSettings(); // 默认 enabled 不是 'true'
  const caseId = insertCase('自检案-未启用');
  fs.mkdirSync(path.join(filesRoot, '自检案-未启用'));

  const supervisor = new AgentSupervisor({
    filesRoot,
    spawnFn: neverSpawn(),
  });
  const result = await supervisor.start(caseId);
  assert.equal(result.status, 'disabled', 'enabled 非 true 时必须返回 disabled');
  assert.equal(supervisor.workers.has(caseId), false, 'disabled 短路不应该创建 worker 记录');
  console.log('  [1/7] enabled=false 短路：ok（未触碰 credential/cwd/spawn）');
}

// ---- 场景 2：enabled=true 但案件夹越出 ANJIAN_FILES_ROOT（不存在/未对应）----
{
  clearAgentSettings();
  setSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
  setSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
  setSetting(AGENT_SETTINGS_KEYS.model, 'deepseek-chat');
  setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'TEST_DEEPSEEK_FAKE_API_KEY');
  process.env.TEST_DEEPSEEK_FAKE_API_KEY = 'not-a-real-key';
  process.env.ANJIAN_INTERNAL_KEY = 'not-a-real-internal-key';

  const caseId = insertCase('自检案-无案件夹');
  // 故意不创建 filesRoot/自检案-无案件夹 目录。

  const supervisor = new AgentSupervisor({
    filesRoot,
    spawnFn: neverSpawn(),
  });
  const result = await supervisor.start(caseId);
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'case_folder_missing');
  assert.equal(supervisor.workers.has(caseId) === false || supervisor.workers.get(caseId)?.status === 'error', true);
  console.log('  [2/7] 案件夹不存在：ok（cwd 校验拒绝，未 spawn）');
}

// ---- 场景 3：案件夹是 symlink（越权手法之一）----
{
  clearAgentSettings();
  setSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
  setSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
  setSetting(AGENT_SETTINGS_KEYS.model, 'deepseek-chat');
  setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'TEST_DEEPSEEK_FAKE_API_KEY');

  const caseName = '自检案-符号链接';
  const caseId = insertCase(caseName);
  const outside = path.join(scratch, 'outside-real-dir');
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(filesRoot, caseName), 'dir');

  const supervisor = new AgentSupervisor({
    filesRoot,
    spawnFn: neverSpawn(),
  });
  const result = await supervisor.start(caseId);
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'cwd_invalid');
  console.log('  [3/7] 案件夹是 symlink：ok（cwd 校验拒绝，未 spawn）');
}

// 场景 4-7 共用：起一个用 FakeChild 顶替真实 DSH 子进程的 worker，跑到 ready。
async function startFakeWorker({ handlers = {}, extra = {} } = {}) {
  clearAgentSettings();
  setSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
  setSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
  setSetting(AGENT_SETTINGS_KEYS.model, 'deepseek-chat');
  setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'TEST_DEEPSEEK_FAKE_API_KEY');
  process.env.TEST_DEEPSEEK_FAKE_API_KEY = 'not-a-real-key';
  process.env.ANJIAN_INTERNAL_KEY = 'not-a-real-internal-key';

  const caseName = `自检案-协议回放-${Math.random().toString(36).slice(2)}`;
  const caseId = insertCase(caseName);
  fs.mkdirSync(path.join(filesRoot, caseName));

  let sessionId;
  const supervisor = new AgentSupervisor({
    filesRoot,
    turnTimeoutMs: 80,
    interactionTtlMs: 150,
    spawnFn: () => {
      // start() 在 spawnFn 调用前就已经把 sessionId 生成好了，但这里拿不到；
      // 用 session/create 请求里携带的 sessionId 当真值来源即可（供 handlers
      // 与断言复用），child 自己在收到该请求时把它记下来。
      const child = makeFakeChild(undefined, {
        'session/create': (frame, c) => {
          sessionId = frame.params.sessionId;
          c.sendLine({ jsonrpc: '2.0', id: frame.id, result: { sessionId } });
        },
        ...handlers,
      });
      return child;
    },
    ...extra,
  });
  const status = await supervisor.start(caseId);
  assert.equal(status.status, 'ready', `worker 必须成功进入 ready（实际 ${status.status}/${status.error}）`);
  const worker = supervisor.workers.get(caseId);
  return { supervisor, caseId, worker, sessionId };
}

// ---- 场景 4：turn 超时必须真正终止 worker，不能只把 status 改回 ready ----
// 修复前：超时分支只 emit turn/end failed，child 从不被 kill/abort；下一个
// turn 会被 turnA 迟到的 running/idle/turn-end 误判成自己已完成。
{
  const { supervisor, caseId, worker } = await startFakeWorker({
    handlers: {
      'session/prompt': (frame, c) => {
        c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
        // 故意不发 running/idle/turn-end——模拟"turn 卡住不回"，逼 supervisor
        // 走 turnTimeoutMs 超时分支。
      },
    },
  });
  const child = worker.child;
  const outcome = await settle(supervisor.prompt(caseId, '第一个 turn'));
  assert.equal(outcome.ok, false, 'turn 超时必须 reject，不能悬空');
  assert.match(outcome.error.message, /turn timed out/);
  const becameNotLive = await waitUntil(() => supervisor.status(caseId).status !== 'ready' && supervisor.status(caseId).status !== 'running');
  assert.equal(becameNotLive, true, '超时后 worker 必须离开 ready/running（被终止）');
  const wasKilledOrShutdown = await waitUntil(() => child.killed || child.exitCode !== null);
  assert.equal(wasKilledOrShutdown, true, '超时后必须真正终止子进程（kill 或 shutdown→exit），不能只是 status 回 ready');
  console.log('  [4/7] turn 超时：ok（真正终止了 worker，不是只改 status）');
}

// ---- 场景 5：首个 turn 的 MCP 门禁失败不能被同一 worker 的下一个 turn 绕过 ----
// 修复前：firstTurnChecked 在失败分支也会被置 true，第二个 turn 直接跳过门禁。
// 现在失败分支不置位，且失败会终止整个 worker，第二个 turn 连排队的资格都
// 没有（worker 已经不是同一个存活实例）。
{
  const { supervisor, caseId, worker } = await startFakeWorker({
    handlers: {
      'session/prompt': (frame, c) => {
        c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
        sendRunningIdleTurnEnd(c, frame.params.sessionId, { includeMcpEvidence: false });
      },
    },
  });
  const outcome = await settle(supervisor.prompt(caseId, '没有证据证明用过 MCP 工具'));
  assert.equal(outcome.ok, false, 'MCP 门禁未满足时首个 turn 必须 reject');
  assert.match(outcome.error.message, /first turn did not establish the required MCP tool readiness/);
  await waitUntil(() => supervisor.status(caseId).status !== 'ready' && supervisor.status(caseId).status !== 'running');
  // 门禁失败后 worker 必须终止；同一个 worker 实例不可能再拿到"已经
  // firstTurnChecked=true"的免检资格——再 prompt 只会因为 worker 不在跑而被拒。
  assert.equal(worker.firstTurnChecked, false, 'firstTurnChecked 不应该在失败时被置 true');
  await assert.rejects(supervisor.prompt(caseId, '第二个 turn 想蹭免检'), /worker is not running/);
  console.log('  [5/7] 首个 turn MCP 门禁失败：ok（未被置位免检，worker 已终止）');
}

// ---- 场景 6：跨 session 的反向请求必须原地拒绝，不进 pendingInteractions ----
{
  const framesFromSupervisor = [];
  const { supervisor, caseId, worker } = await startFakeWorker({
    handlers: {
      'session/prompt': (frame, c) => {
        c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
        // 子进程发一个 sessionId 对不上的 approval/request（跨 session 或过期
        // session 的反向请求）。
        c.sendLine({
          jsonrpc: '2.0', id: 9001, method: 'approval/request',
          params: { sessionId: 'some-other-session', approvalId: 'a1', toolName: 'write' },
        });
        sendRunningIdleTurnEnd(c, frame.params.sessionId, { includeMcpEvidence: true });
      },
    },
  });
  // child.stdin 是 supervisor → child 方向；额外挂一个监听器，把 supervisor
  // 写回来的所有帧（包括对 id=9001 这条跨 session 请求的即时应答）都记下来。
  worker.child.stdin.on('data', (chunk) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      framesFromSupervisor.push(JSON.parse(line));
    }
  });
  const outcome = await settle(supervisor.prompt(caseId, '正常 turn，附带一个跨 session 的审批请求'));
  assert.equal(outcome.ok, true, '这个 turn 本身应该正常完成（只是附带一条跨 session 反向请求）');
  assert.deepEqual(supervisor.listPendingInteractions(caseId), [], '跨 session 的反向请求不应该进入待办表');
  const reply = framesFromSupervisor.find((f) => f.id === 9001);
  assert.ok(reply, '必须已经原地回了这条跨 session 请求的响应');
  assert.equal(reply.result?.outcome, 'unavailable', '跨 session 的 approval 必须回 unavailable，而不是悬在待办表里');
  console.log('  [6/7] 跨 session 反向请求：ok（原地拒绝，未入表）');
}

// ---- 场景 7：listPendingInteractions() 必须脱敏，不能原样吐出 toolName ----
{
  const FAKE_KEY = 'not-a-real-key'; // 与 startFakeWorker 里设的 apiKeyEnv 值一致
  const { supervisor, caseId } = await startFakeWorker({
    // 拉长 turnTimeoutMs：这个场景不关心 turn 本身的结局（故意不回
    // running/idle/turn-end），只关心 approval/request 入表后 listPendingInteractions
    // 是否脱敏；默认的 80ms 短超时会在断言跑完前就把 worker 终止掉，产生竞态。
    extra: { turnTimeoutMs: 5000 },
    handlers: {
      'session/prompt': (frame, c) => {
        c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
        // 子进程把 key 值塞进 toolName——模拟被攻陷/失控子进程试图靠这条查询
        // 接口把 key 值带出去。
        c.sendLine({
          jsonrpc: '2.0', id: 9002, method: 'approval/request',
          params: { sessionId: frame.params.sessionId, approvalId: 'a2', toolName: `evil-${FAKE_KEY}` },
        });
      },
    },
  });
  supervisor.prompt(caseId, '触发一个会塞入 key 值的 approval/request').catch(() => {});
  const found = await waitUntil(() => supervisor.listPendingInteractions(caseId).length > 0);
  assert.equal(found, true, '应该已经产生一条待处理的 approval');
  const pending = supervisor.listPendingInteractions(caseId);
  assert.equal(pending.length, 1, '应该只有一条待处理的 approval');
  assert.equal(pending[0].toolName.includes(FAKE_KEY), false, 'listPendingInteractions 不能原样吐出 key 值');
  assert.equal(pending[0].toolName.includes('[REDACTED]'), true, 'toolName 必须被 redact 过');
  await supervisor.stop(caseId, 'test cleanup');
  console.log('  [7/7] listPendingInteractions 脱敏：ok（未泄漏 key 值）');
}

clearAgentSettings();
console.log('agent supervisor 自检全部通过');
