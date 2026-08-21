// DSH sidecar supervisor 最小自检——不发模型请求，不需要模型 key。
// 场景 1-3 用注入的 spawnFn 断言"从未被调用"，验证两条门禁红线：
//   1. enabled=false 必须在读 credential、spawn 子进程之前短路返回；
//   2. 案件夹越出 ANJIAN_FILES_ROOT（包括 symlink 越权）必须被拒绝，且同样
//      不能走到 spawn 那一步。
// 场景 4-11 用一个走 stdin/stdout JSON-RPC 协议的 FakeChild（不是真的 DSH 子
// 进程，只回放协议帧）验证修复轮审查发现的几条 turn/worker 生命周期红线：
// turn 超时必须真正终止 worker、首个 turn 的 MCP 门禁失败不能被第二个 turn
// 绕过、跨 session 的反向请求必须原地拒绝不入表、pendingInteractions 对外
// 查询必须脱敏、session/preflight 的宿主侧逐字段核验、turn 失败瞬间必须立即
// 离开 LIVE 状态（不给已排队的下一个 turn 留抢跑窗口）、pendingInteractions
// 必须在同一瞬间清空（不给 resolveApproval 留 fail-open 窗口）。
// 场景 14-22 是本轮加固对应的回归：首 turn 中途出现 reason:'change' 的
// request/header 不能覆盖 initial 快照、子进程 stdio 管道故障不能崩宿主、
// redactDeep 的总量兜底（累计字节预算 + 数组元素上限）、'stopping' 态必须
// 阻止同案重复 spawn、_handleFatal 必须真正 kill+落终态（即使子进程卡死不
// 退出）、worker.error 必须兜底 redact、重复 start() 必须返回实时快照而不是
// 冻结的旧值、_expirePendingInteractions 必须真正应答子进程而不是只清表、
// assets/node_modules 必须由 supervisor 运行时确保（缺失自动补、意外目录拒绝
// 覆盖）。
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
const { caseIdForSession } = await import('../src/agent/session-registry.js');

const REQUIRED_MCP_TOOL = AGENT_RUNTIME_PATHS.requiredMcpTool;
const REQUIRED_SKILL_NAME = AGENT_RUNTIME_PATHS.requiredSkillName;

// 一份能通过宿主侧 isPreflightReady() 逐字段核验的 session/preflight 结果——
// 形状抄参考实现 driver.mjs 的断言块：ready、tools.required/ready/
// visibleNames、skills.complete/names（唯一一个 anqi-case-brief）/ready 全部
// 到位。场景 8 会在此基础上逐个字段改坏，验证宿主侧确实会因为每一项不满足
// 而拒绝，而不是像修复前那样完全不看这个返回值。
const VALID_PREFLIGHT_RESULT = {
  ready: true,
  tools: { required: REQUIRED_MCP_TOOL, ready: true, visibleNames: [REQUIRED_MCP_TOOL, 'read_file', 'search_files'] },
  skills: { complete: true, names: [REQUIRED_SKILL_NAME], ready: true },
};

// ---- 场景 4-11 共用：一个只回放 JSON-RPC 协议帧的假子进程，不拉起真 DSH ----
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
      c.sendLine({ jsonrpc: '2.0', id: frame.id, result: VALID_PREFLIGHT_RESULT });
    } else if (frame.method === 'shutdown') {
      c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
      c.emitExit(0, null);
    }
  });
  return child;
}

// rc.7 真实 wire 形状：request/header 的 event.data = { header: EpochHeader,
// reason }，工具列表在 data.header.tools（不是 data.tools）——修复轮之前这里
// 回放的是错误形状（data: {reason, tools}），结构上不可能发现字段路径 bug，
// 所以这里必须照抄真实形状，同 supervisor.js 里 isPreflightReady/
// _maybeResolveTurn 的读取路径保持一致。
function sendRunningIdleTurnEnd(child, sessionId, { includeMcpEvidence }) {
  child.sendLine({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'running' } });
  if (includeMcpEvidence) {
    child.sendLine({
      jsonrpc: '2.0', method: 'session.event',
      params: { sessionId, event: { type: 'request/header', data: { reason: 'initial', header: { tools: [{ name: REQUIRED_MCP_TOOL }] } } } },
    });
    child.sendLine({
      jsonrpc: '2.0', method: 'session.event',
      params: { sessionId, event: { type: 'tool/call', data: { name: REQUIRED_MCP_TOOL } } },
    });
  } else {
    child.sendLine({
      jsonrpc: '2.0', method: 'session.event',
      params: { sessionId, event: { type: 'request/header', data: { reason: 'initial', header: { tools: [] } } } },
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
  console.log('  [1/22] enabled=false 短路：ok（未触碰 credential/cwd/spawn）');
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
  console.log('  [2/22] 案件夹不存在：ok（cwd 校验拒绝，未 spawn）');
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
  console.log('  [3/22] 案件夹是 symlink：ok（cwd 校验拒绝，未 spawn）');
}

// 场景 4-11 共用：起一个用 FakeChild 顶替真实 DSH 子进程的 worker。
// startFakeWorkerRaw 不对最终状态做断言（场景 8 需要故意让 start() 失败）；
// startFakeWorker 在此基础上断言必须进入 ready，是场景 4-7/9/10 的常规路径。
async function startFakeWorkerRaw({ handlers = {}, extra = {} } = {}) {
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
  const worker = supervisor.workers.get(caseId);
  return { supervisor, caseId, worker, sessionId, status };
}

async function startFakeWorker(opts) {
  const result = await startFakeWorkerRaw(opts);
  assert.equal(result.status.status, 'ready', `worker 必须成功进入 ready（实际 ${result.status.status}/${result.status.error}）`);
  return result;
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
  console.log('  [4/22] turn 超时：ok（真正终止了 worker，不是只改 status）');
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
  console.log('  [5/22] 首个 turn MCP 门禁失败：ok（未被置位免检，worker 已终止）');
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
  console.log('  [6/22] 跨 session 反向请求：ok（原地拒绝，未入表）');
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
  console.log('  [7/22] listPendingInteractions 脱敏：ok（未泄漏 key 值）');
}

// ---- 场景 8：session/preflight 的返回值必须被宿主逐字段核验 ----
// 修复前：supervisor 只 await session/preflight，从不检查它的返回值——子
// 进程返回一个 tools/skills 都不满足门禁的结果，宿主照样把 worker 判成
// ready。这里子进程回一个 ready:false、tools 里没有 REQUIRED_MCP_TOOL、
// skills 里混了别的技能名的结果，验证 start() 必须失败，不能进入 ready。
{
  const badPreflight = {
    ready: false,
    tools: { required: REQUIRED_MCP_TOOL, ready: false, visibleNames: ['bash', 'web_search'] },
    skills: { complete: false, names: [REQUIRED_SKILL_NAME, '用户自带技能', '另一个技能'], ready: false },
  };
  const { status, worker } = await startFakeWorkerRaw({
    handlers: {
      'session/preflight': (frame, c) => {
        c.sendLine({ jsonrpc: '2.0', id: frame.id, result: badPreflight });
      },
    },
  });
  assert.equal(status.status, 'error', `不满足门禁的 preflight 结果必须让 start() 失败（实际 ${status.status}）`);
  assert.match(status.error || '', /startup_failed/, 'error 字段必须体现是启动序列失败');
  const childKilled = await waitUntil(() => worker.child.killed || worker.child.exitCode !== null);
  assert.equal(childKilled, true, 'preflight 门禁失败后必须终止子进程，不能泄漏');
  console.log('  [8/22] session/preflight 宿主侧核验：ok（不完整的 tools/skills 快照被拒绝，未放行到 ready）');
}

// ---- 场景 9：turn 失败必须立即离开 LIVE 状态，不给已排队的下一个 turn 留 ----
// ---- 抢跑窗口 ----
// 修复前：失败分支把 status 改回 'ready'（LIVE）之后才异步 stop()；已经排队
// 在 turnLock 后面的下一个 turn 会在这段 shutdown 往返窗口里被 LIVE 守卫放
// 行，跑起来但一个模型事件都收不到，最终被 supervisor 当成"正常完成"。这里
// 复现同样的排队时序：turn2 会超时失败，turn2 还在飞时就把 turn3 排上队，
// 断言 turn3 必须因为 worker 不再存活而 reject，不能被静默 resolve。
{
  let promptCount = 0;
  const { supervisor, caseId } = await startFakeWorker({
    extra: { turnTimeoutMs: 80 },
    handlers: {
      'session/prompt': (frame, c) => {
        promptCount += 1;
        c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
        if (promptCount === 1) {
          // turn1：正常走完，让 firstTurnChecked 落定，不干扰 turn2 的超时判定。
          sendRunningIdleTurnEnd(c, frame.params.sessionId, { includeMcpEvidence: true });
        }
        // turn2：故意不回 running/idle/turn-end，逼 supervisor 走超时分支。
        // turn3 理论上不会有机会发出 session/prompt（worker 应该已经不在
        // LIVE_STATUSES 里）；如果它真的发出去了，说明抢跑窗口仍然存在。
      },
      // 故意拖延 shutdown 的响应：生产环境里 stop() 的 shutdown 往返/强杀等待
      // 有真实的秒级延迟，这里用一个明显大于 turnTimeoutMs（80ms）的延迟
      // （300ms）在单测里复现同一种"turn 判失败"和"worker 真正终止"之间存在
      // 时间差的场景——如果 turn 判失败的瞬间不立即离开 LIVE 状态，这段窗口
      // 足够让排队的下一个 turn 在 worker 真正终止前抢跑。
      shutdown: (frame, c) => {
        const timer = setTimeout(() => {
          c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
          c.emitExit(0, null);
        }, 300);
        timer.unref?.();
      },
    },
  });
  const turn1 = await settle(supervisor.prompt(caseId, 'turn1：正常完成'));
  assert.equal(turn1.ok, true, 'turn1 应该正常完成');

  const turn2 = supervisor.prompt(caseId, 'turn2：会超时失败');
  // turn3 在 turn2 还没有结果时就排队——复现"迟到收尾窗口期被抢跑"的时序。
  const turn3 = supervisor.prompt(caseId, 'turn3：排在 turn2 后面，不应该被静默放行');
  // 两个 settle() 都必须在 turn2/turn3 刚创建、还没来得及 reject 时就同步挂上
  // 处理函数——如果先 await settle(turn2) 再创建 settle(turn3) 的处理函数，
  // turn3 可能在这段等待期间就已经 reject，Node 会把它当成一条没有挂
  // 处理函数的 unhandled rejection 直接崩掉进程（不是测试想验证的东西）。
  const turn2Settled = settle(turn2);
  const turn3Settled = settle(turn3);
  const outcome2 = await turn2Settled;
  assert.equal(outcome2.ok, false, 'turn2 必须超时失败');
  const outcome3 = await turn3Settled;
  assert.equal(outcome3.ok, false, 'turn3 不能被静默 resolve——worker 必须已经离开 LIVE 状态');
  assert.equal(promptCount, 2, 'turn3 不应该真的发出 session/prompt（worker 应在排队时已判定不再存活）');
  console.log('  [9/22] turn 失败立即离开 LIVE 状态：ok（排队的下一个 turn 未被抢跑放行）');
}

// ---- 场景 10：turn 失败瞬间必须清空 pendingInteractions，approval 不能在 ----
// ---- shutdown 往返窗口内被放行 ----
// 修复前：turn 判定失败后 pendingInteractions 要等 exit/fatal 事件才清空，
// resolveApproval 的 LIVE_STATUSES 校验又因为 status 被错误改回 ready 而形同
// 虚设——一条本该 fail-closed 的审批可以在这段窗口里被放行、真的写进子进程
// stdin。这里让子进程先发一条 approval/request，再让 turn 超时失败，断言在
// turn 判失败之后立即调用 resolveApproval 必须返回 ok:false。
{
  const { supervisor, caseId } = await startFakeWorker({
    extra: { turnTimeoutMs: 80, interactionTtlMs: 5000 },
    handlers: {
      'session/prompt': (frame, c) => {
        c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
        c.sendLine({
          jsonrpc: '2.0', id: 9003, method: 'approval/request',
          params: { sessionId: frame.params.sessionId, approvalId: 'a3', toolName: 'write' },
        });
        // 故意不回 running/idle/turn-end，逼 turn 走超时分支。
      },
      // 同场景 9：故意拖延 shutdown 的响应。这条延迟很关键——如果不拖延，
      // 默认的 shutdown 处理器几乎立即应答，_handleExit 触发的"退出时兜底
      // 清表"会在测试来得及断言之前就已经把 pendingInteractions 清空，掩盖
      // 掉"turn 判失败瞬间就同步清空"这条修复是否真的存在；拖延后才能确认
      // 断言时刻看到的空表确实来自 turn 失败分支本身，而不是碰巧提前完成的
      // exit 路径。
      shutdown: (frame, c) => {
        const timer = setTimeout(() => {
          c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
          c.emitExit(0, null);
        }, 300);
        timer.unref?.();
      },
    },
  });
  const turnOutcomePromise = settle(supervisor.prompt(caseId, '触发一个 approval 之后 turn 本身超时'));
  const pendingAppeared = await waitUntil(() => supervisor.listPendingInteractions(caseId).length > 0);
  assert.equal(pendingAppeared, true, '应该先出现一条待处理的 approval');
  const interactionId = supervisor.listPendingInteractions(caseId)[0].id;
  const outcome = await turnOutcomePromise;
  assert.equal(outcome.ok, false, 'turn 应该因为超时而失败');
  // turn 判失败与 pendingInteractions 清空必须是同一步——不需要再等待任何
  // exit/fatal 事件，此刻 resolveApproval 必须已经 fail-closed。
  const result = supervisor.resolveApproval(caseId, interactionId, 'allowed-once');
  assert.equal(result.ok, false, 'turn 判失败后必须立即 fail-closed，approval 不能再被放行');
  assert.deepEqual(supervisor.listPendingInteractions(caseId), [], 'pendingInteractions 必须已经清空');
  console.log('  [10/22] turn 失败瞬间清空 pendingInteractions：ok（shutdown 往返窗口内 approval 仍 fail-closed）');
}

// ---- 场景 11：supervisor 必须真的接线 session-registry 的 bind/unbind ----
// 审查发现：tools/test-agent-proposals-http.js 只测了消费端（/internal/
// agent-proposals 路由反查 caseIdForSession），生产端（supervisor.start()
// 登记、_finalizeWorker 注销）从未被断言过——把 supervisor.js 里 bindSession/
// unbindSession 两行删掉，其余用例照样全绿。这里直接断言 session-registry
// 这张服务端登记表的状态随 worker 生命周期变化：start() 之后必须能反查到
// caseId；worker 终态收尾（这里走 graceful stop，覆盖 _finalizeWorker 的
// 收敛路径）之后必须反查不到——不然要么 §2 调用链整条打不通（403
// session_not_bound），要么已退出 worker 的 session_id 永久有效。
{
  const { supervisor, caseId, worker } = await startFakeWorker({});
  assert.equal(caseIdForSession(worker.sessionId), caseId, 'start() 之后必须能通过 session-registry 反查到绑定的 caseId');
  await supervisor.stop(caseId, 'test cleanup: 场景 11 收尾');
  assert.equal(caseIdForSession(worker.sessionId), null, 'worker 终态收尾之后 session-registry 里的绑定必须被注销');
  console.log('  [11/22] supervisor 接线 session-registry：ok（start 绑定、终态收尾注销）');
}

// ---- 场景 12：onEvent() 与 worker 生命周期解耦（登记在 supervisor 层，不
// 挂在某一次 Worker 实例上）----
// 审查发现：onEvent() 之前的实现是 `const worker = this.workers.get(caseId);
// if (!worker) return () => {};`——没有 worker 时什么都不注册、返回一个假的
// 退订函数；worker 每次 start() 都是全新实例、监听器集合全新为空。结果是
// (a) 浏览器按自然顺序"先连 events 再点启动"时，onEvent() 在 worker 尚未
// 创建的瞬间是静默空操作，之后即便 worker 创建出来也不会补挂；(b) 即使先
// start 再连，一旦 worker 崩溃/被 stop 后重新 start，旧监听器就被孤儿化，
// SSE 连接永久收不到任何后续事件。这里验证两点都已修复：先于 start() 调用
// onEvent()，之后仍能收到 start() 过程中广播的 worker/ready；worker 被
// stop() 后重新 start() 出一个全新实例，同一个订阅依旧能收到新实例广播的
// 事件。
{
  clearAgentSettings();
  setSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
  setSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
  setSetting(AGENT_SETTINGS_KEYS.model, 'deepseek-chat');
  setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'TEST_DEEPSEEK_FAKE_API_KEY');
  process.env.TEST_DEEPSEEK_FAKE_API_KEY = 'not-a-real-key';
  process.env.ANJIAN_INTERNAL_KEY = 'not-a-real-internal-key';

  const caseName = '自检案-onEvent生命周期';
  const caseId = insertCase(caseName);
  fs.mkdirSync(path.join(filesRoot, caseName));

  const supervisor = new AgentSupervisor({
    filesRoot,
    spawnFn: () => makeFakeChild(undefined, {
      'session/create': (frame, c) => {
        c.sendLine({ jsonrpc: '2.0', id: frame.id, result: { sessionId: frame.params.sessionId } });
      },
    }),
  });

  const events = [];
  const unsubscribe = supervisor.onEvent(caseId, (event) => events.push(event));

  const status1 = await supervisor.start(caseId);
  assert.equal(status1.status, 'ready', 'worker 应该成功进入 ready');
  assert.ok(
    events.some((e) => e.type === 'worker/ready'),
    '提前订阅必须能收到 start() 过程中广播的 worker/ready（修复前 onEvent() 在 worker 尚未创建时是静默空操作）'
  );

  const workerBefore = supervisor.workers.get(caseId);
  await supervisor.stop(caseId, 'test: 场景 12 触发重启');
  events.length = 0; // 只关注重启之后的新事件

  const status2 = await supervisor.start(caseId);
  assert.equal(status2.status, 'ready', '重启后 worker 应该再次成功进入 ready');
  const workerAfter = supervisor.workers.get(caseId);
  assert.notEqual(workerAfter, workerBefore, '重启之后必须是一个全新的 Worker 实例');
  assert.ok(
    events.some((e) => e.type === 'worker/ready'),
    '同一个订阅在 worker 重建之后仍必须能收到新实例广播的事件（修复前旧订阅在这里被孤儿化）'
  );

  unsubscribe();
  await supervisor.stop(caseId, 'test cleanup: 场景 12 收尾');
  console.log('  [12/22] onEvent() 与 worker 生命周期解耦：ok（提前订阅 + 跨重启订阅均生效）');
}

// ---- 场景 13：setInternalBaseURL() 生效于新 spawn；forceKillAll() 兜底强杀 ----
// 审查发现：AgentSupervisor 构造时对 internalBaseURL 只能给一个兜底猜测
// （env 未设时硬编码 3007），与 server.js 实际监听端口大概率不一致，会导致
// DSH 子进程的每一次 anqi MCP 工具调用都 ECONNREFUSED；server.js 现在会在
// httpServer.listen() 回调里调用 setInternalBaseURL() 用真实端口纠正它。
// 这里验证：(a) setInternalBaseURL() 之后新 start() 出的 worker，其 spawn
// env 里的 ANQI_BASE_URL 确实是纠正后的新值，不是构造时的默认值；
// (b) forceKillAll()（gracefulShutdown 优雅关闭总时限跑满时的兜底路径）能
// 对仍存活的子进程真正发送 SIGKILL，不是空转。
{
  clearAgentSettings();
  setSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
  setSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
  setSetting(AGENT_SETTINGS_KEYS.model, 'deepseek-chat');
  setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'TEST_DEEPSEEK_FAKE_API_KEY');
  process.env.TEST_DEEPSEEK_FAKE_API_KEY = 'not-a-real-key';
  process.env.ANJIAN_INTERNAL_KEY = 'not-a-real-internal-key';

  const caseName = '自检案-internalBaseURL与强杀';
  const caseId = insertCase(caseName);
  fs.mkdirSync(path.join(filesRoot, caseName));

  let capturedEnv = null;
  const supervisor = new AgentSupervisor({
    filesRoot,
    internalBaseURL: 'http://127.0.0.1:9999', // 构造时的默认值——刻意设成一个错误端口
    spawnFn: (execPath, args, opts) => {
      capturedEnv = opts.env;
      return makeFakeChild(undefined, {
        'session/create': (frame, c) => {
          c.sendLine({ jsonrpc: '2.0', id: frame.id, result: { sessionId: frame.params.sessionId } });
        },
      });
    },
  });

  supervisor.setInternalBaseURL('http://127.0.0.1:12345');
  const status = await supervisor.start(caseId);
  assert.equal(status.status, 'ready');
  assert.equal(
    capturedEnv.ANQI_BASE_URL, 'http://127.0.0.1:12345',
    'setInternalBaseURL() 之后的新 start() 必须把纠正后的值传给子进程，而不是构造时的默认值'
  );

  const worker = supervisor.workers.get(caseId);
  const child = worker.child;
  assert.equal(child.exitCode, null, '强杀前子进程应仍存活');
  supervisor.forceKillAll();
  const killed = await waitUntil(() => child.exitCode !== null);
  assert.equal(killed, true, 'forceKillAll() 之后子进程必须真的退出');
  assert.equal(child.lastKillSignal, 'SIGKILL', 'forceKillAll() 必须发送 SIGKILL，不是走 graceful shutdown 往返');
  console.log('  [13/22] setInternalBaseURL()/forceKillAll()：ok（新 spawn 用纠正后的 base URL；兜底强杀真的杀）');
}

// ---- 场景 14：首 turn 中途出现 reason:'change' 的 request/header 不能覆盖 ----
// ---- initial 快照 ----
// 修复前：_firstRequestHeader 只要 firstTurnChecked 还是 false 就会被无条件
// 覆盖——rc.7 同一个首个 turn 内，工具/技能集合发生变化时会追加一条
// reason:'change' 的后续 request/header（agent-loop/lib/index.js:715），字段
// 形状与 reason:'initial' 完全相同。这里让 initial header 带着所需 MCP 工具，
// 之后追加一条不带任何工具的 change header，断言门禁 4 仍然按 initial 那份
// 快照判断（turn 正常完成），不会被后到的 change header 误判失败。
{
  const { supervisor, caseId } = await startFakeWorker({
    handlers: {
      'session/prompt': (frame, c) => {
        const sessionId = frame.params.sessionId;
        c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
        c.sendLine({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'running' } });
        c.sendLine({
          jsonrpc: '2.0', method: 'session.event',
          params: { sessionId, event: { type: 'request/header', data: { reason: 'initial', header: { tools: [{ name: REQUIRED_MCP_TOOL }] } } } },
        });
        c.sendLine({
          jsonrpc: '2.0', method: 'session.event',
          params: { sessionId, event: { type: 'tool/call', data: { name: REQUIRED_MCP_TOOL } } },
        });
        // 同一首 turn 内追加的 change header——不带所需 MCP 工具。修复前这里
        // 会覆盖 _firstRequestHeader，让门禁 4 在 turn 结尾读到这份"变化后"
        // 的快照，误判一个本该通过的合规 turn 失败。
        c.sendLine({
          jsonrpc: '2.0', method: 'session.event',
          params: { sessionId, event: { type: 'request/header', data: { reason: 'change', header: { tools: [] } } } },
        });
        c.sendLine({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } });
        c.sendLine({
          jsonrpc: '2.0', method: 'session.event',
          params: { sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
        });
      },
    },
  });
  const outcome = await settle(supervisor.prompt(caseId, '首 turn 中途出现 change header'));
  assert.equal(outcome.ok, true, '首 turn 中途追加的 change header 不应该覆盖 initial 快照、误判门禁 4 失败');
  await supervisor.stop(caseId, 'test cleanup: 场景 14 收尾');
  console.log('  [14/22] request/header change 不覆盖 initial 快照：ok（门禁 4 仍按 initial 判定）');
}

// ---- 场景 15：子进程 stdio 管道故障不能崩宿主 ----
// 修复前：stderr 的 readline 只挂 'line'，没挂 'error'——readline 会把 input
// 流（child.stderr）的 'error' 原样 re-emit 到自己身上，没有监听器时 Node
// 直接 throw；child.stdin 全程裸 write，从未挂过 'error'，写入失败同样会
// throw。这两处任何一个真的抛出，都会把宿主进程一起崩掉（Node 对没有监听器
// 的 EventEmitter 'error' 事件是同步 throw，不是 reject 一个 promise）。这里
// 分别对两个新 worker 的 stderr/stdin 直接 emit 'error'，用
// assert.doesNotThrow 证明宿主不会崩，并确认 worker 最终被真正收尾（不是卡
// 在一个既非 LIVE 也非终态的中间态）。
{
  const { supervisor: supervisorStderr, caseId: caseIdStderr, worker: workerStderr } = await startFakeWorker({});
  assert.doesNotThrow(
    () => workerStderr.child.stderr.emit('error', new Error('模拟 stderr 管道故障')),
    'stderr 的 error 事件不应该让宿主进程崩溃'
  );
  const stderrTerminal = await waitUntil(() => supervisorStderr.status(caseIdStderr).status === 'crashed');
  assert.equal(stderrTerminal, true, 'stderr 故障之后 worker 必须被真正收尾成 crashed');

  const { supervisor: supervisorStdin, caseId: caseIdStdin, worker: workerStdin } = await startFakeWorker({});
  assert.doesNotThrow(
    () => workerStdin.child.stdin.emit('error', new Error('模拟 stdin 写入故障')),
    'stdin 的 error 事件不应该让宿主进程崩溃'
  );
  const stdinTerminal = await waitUntil(() => supervisorStdin.status(caseIdStdin).status === 'crashed');
  assert.equal(stdinTerminal, true, 'stdin 故障之后 worker 必须被真正收尾成 crashed');
  console.log('  [15/22] stdio 管道故障不崩宿主：ok（stderr/stdin 的 error 事件均被接住并落终态）');
}

// ---- 场景 16：redactDeep 的总量兜底（累计字节预算 + 数组元素数上限）----
// 修复前：redactDeep 只对每个 string 叶子单独限长，容器结构（数组/对象）本身
// 没有总量约束——一个几千元素的数组，每个元素都是几百字符的短字符串，逐叶子
// 检查全部合规，序列化后的整个事件依然可以轻松几百 KB 到几 MB（探针曾复现过
// 1.56MB 的单事件）。这里直接调用 worker.redact.deep()（供 _redactEventData
// 内部使用的同一个函数），喂一个 5000 元素的大数组，断言：a) 数组被截到不超过
// 元素数上限，多出的部分折叠成一条 "[truncated N items]" 标记；b) 折叠后的
// 结构整体序列化后的字节数远小于原始输入。
{
  const { supervisor, caseId, worker } = await startFakeWorker({});
  const originalItemCount = 5000;
  const hugeArray = Array.from({ length: originalItemCount }, (_, i) => `item-${i}-${'x'.repeat(200)}`);
  const originalBytes = Buffer.byteLength(JSON.stringify(hugeArray), 'utf8');
  const redacted = worker.redact.deep({ items: hugeArray });
  assert.ok(Array.isArray(redacted.items), 'items 仍应该是数组，不是被整体丢弃成占位符');
  const lastItem = redacted.items[redacted.items.length - 1];
  assert.equal(typeof lastItem, 'string', '超出上限的部分应该折叠成一条字符串标记');
  assert.match(lastItem, /^\[truncated \d+ items\]$/, '折叠标记必须是 "[truncated N items]" 这个形状');
  const redactedBytes = Buffer.byteLength(JSON.stringify(redacted), 'utf8');
  assert.ok(redactedBytes < originalBytes / 10, `折叠后的字节数（${redactedBytes}）应该远小于原始输入（${originalBytes}），不能只做了逐叶子限长`);
  assert.ok(redacted.items.length < originalItemCount, '保留的元素个数必须明显少于原始数组长度');
  console.log('  [16/22] redactDeep 总量兜底：ok（数组元素数上限 + 累计字节预算均生效）');
  await supervisor.stop(caseId, 'test cleanup: 场景 16 收尾');
}

// ---- 场景 17：'stopping' 态必须阻止同一案件重复 spawn ----
// 修复前：LIVE_STATUSES 不含 'stopping'，turn 失败后 worker 进入 'stopping'
// 到真正终态化之间有一段窗口（最坏 30s shutdown 往返 + 10s 强杀等待）；这段
// 窗口里再调用 start()，旧的 LIVE 判断直接放过，会重新 spawn 一个全新 worker
// ——两个活子进程同时挂在同一个 caseId 名下，违反"每案最多一个 active
// worker"。这里手工制造同样的时序：turn 因超时触发内部 stop()，在它真正落定
// 之前（worker.status 恰好是 'stopping'）直接调用 start()，断言：a) 只重新
// spawn 了一次；b) 新 spawn 发生时旧的子进程必须已经真正退出（start() 确实
// 先 await 了在飞的 stop()，不是抢跑）。
{
  clearAgentSettings();
  setSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
  setSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
  setSetting(AGENT_SETTINGS_KEYS.model, 'deepseek-chat');
  setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'TEST_DEEPSEEK_FAKE_API_KEY');
  process.env.TEST_DEEPSEEK_FAKE_API_KEY = 'not-a-real-key';
  process.env.ANJIAN_INTERNAL_KEY = 'not-a-real-internal-key';

  const caseName = `自检案-防重复spawn-${Math.random().toString(36).slice(2)}`;
  const caseId = insertCase(caseName);
  fs.mkdirSync(path.join(filesRoot, caseName));

  const children = [];
  const supervisor = new AgentSupervisor({
    filesRoot,
    turnTimeoutMs: 80,
    spawnFn: () => {
      const child = makeFakeChild(undefined, {
        'session/create': (frame, c) => {
          c.sendLine({ jsonrpc: '2.0', id: frame.id, result: { sessionId: frame.params.sessionId } });
        },
        'session/prompt': (frame, c) => {
          c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
          // 故意不回 running/idle/turn-end——逼超时，触发内部 stop()。
        },
        shutdown: (frame, c) => {
          // 拖延应答：制造"判失败"与"真正终止"之间足够宽的时间差窗口。
          const timer = setTimeout(() => {
            c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
            c.emitExit(0, null);
          }, 300);
          timer.unref?.();
        },
      });
      children.push(child);
      return child;
    },
  });

  const status1 = await supervisor.start(caseId);
  assert.equal(status1.status, 'ready');
  const firstChild = children[0];

  const turnOutcome = settle(supervisor.prompt(caseId, '会超时失败，触发内部 stop()'));
  const enteredStopping = await waitUntil(() => supervisor.workers.get(caseId).status === 'stopping');
  assert.equal(enteredStopping, true, 'turn 超时后 worker 应该先进入 stopping');

  // 在这个窗口内直接调用 start()，模拟"用户立刻重开 drawer"。这个 start()
  // 内部要 await 在飞的 stop()，而 stop() 落定依赖 FakeChild 那个故意 unref
  // 的 300ms shutdown 计时器——必须用 settle()（ref 式轮询）包一层，否则前面
  // 两个 waitUntil/settle 的保活轮询都已经结束，事件循环会判定"无事可做"，
  // 这个 await 会真的永远挂起（同本文件顶部关于 unref 计时器的注释）。
  const status2Settled = await settle(supervisor.start(caseId));
  assert.equal(status2Settled.ok, true, '重新 start() 不应该 reject');
  const status2 = status2Settled.value;
  await turnOutcome;

  assert.equal(children.length, 2, '应该恰好重新 spawn 了一次（不多不少）');
  assert.equal(firstChild.exitCode, 0, '旧 worker 的子进程必须已经真正退出，才轮到新 worker spawn（start() 必须先 await 在飞的 stop()）');
  assert.equal(status2.status, 'ready', '等旧 worker 收尾完之后，新 worker 应该正常进入 ready');
  // 收尾用的 stop() 同样要走 settle()：新 worker 的 FakeChild 复用了同一份
  // handlers（shutdown 依然是那个故意 unref 的 300ms 延迟应答），没有保活
  // 轮询的话这次 await 也会真的永远挂起。
  await settle(supervisor.stop(caseId, 'test cleanup: 场景 17 收尾'));
  console.log('  [17/22] "stopping" 态阻止重复 spawn：ok（start() 等在飞 stop() 落定才重新 spawn）');
}

// ---- 场景 18：_handleFatal 必须真正 kill + 落终态，即使子进程卡死不退出 ----
// 修复前：_handleFatal 只把 status 标成 'error'（一个非 LIVE 但也非终态的
// 中间态），从不 kill 子进程也不调用 _finalizeWorker——如果 'exit' 事件永远
// 不来（子进程卡死、不响应 SIGTERM），worker 会永久卡在这个中间态：0700
// 临时 skill 目录永远不会被清理，也没有一条可审计的最终状态记录。这里覆写
// child.kill() 让它"收到信号也不真的退出"，模拟卡死场景，断言 _handleFatal
// 仍然必须：a) 尝试 kill；b) 把 worker 落到 'crashed' 终态；c) 清理临时
// skill 目录，而不是永远等一个不会来的 'exit'。
{
  const { supervisor, caseId, worker } = await startFakeWorker({});
  const child = worker.child;
  child.kill = (signal) => { child.killed = true; child.lastKillSignal = signal; }; // 不再自动 emitExit
  child.stdout.emit('error', new Error('模拟 stdout 管道故障，子进程本身卡死不退出'));
  const becameCrashed = await waitUntil(() => supervisor.status(caseId).status === 'crashed');
  assert.equal(becameCrashed, true, '即使子进程卡死不退出，_handleFatal 也必须真正落 crashed 终态');
  assert.equal(child.killed, true, '仍存活的子进程必须先被尝试 SIGTERM');
  assert.equal(worker.skillsRootTmp, null, '终态落定后必须已经清理 0700 临时 skill 目录');
  console.log('  [18/22] _handleFatal 收尾兜底：ok（卡死不退出的子进程也会被落 crashed 且清理临时目录）');
}

// ---- 场景 19：worker.error 必须兜底 redact，不能有任何路径绕过 ----
// 修复前：_finalizeWorker 把 detail 原样存进 worker.error，status()/
// publicStatus() 会把它原样下发给 HTTP/SSE 层——探针已经证实某些调用点传入
// 未经 redact 的 detail 时，key 值会明文出现在 status().error 里。这里直接
// 喂一段含 key 值的 detail 给 _finalizeWorker（模拟"某个调用点忘记先 redact"
// 的情况），断言 status().error 里不含明文 key、且体现出已经被 redact。
{
  const FAKE_KEY = 'not-a-real-key'; // 与 startFakeWorker 里设的 apiKeyEnv 值一致
  const { supervisor, caseId, worker } = await startFakeWorker({});
  supervisor._finalizeWorker(worker, 'error', `boom: leaked ${FAKE_KEY} here`);
  const status = supervisor.status(caseId);
  assert.equal(status.error.includes(FAKE_KEY), false, 'status().error 不能包含 key 明文');
  assert.equal(status.error.includes('[REDACTED]'), true, 'status().error 必须体现已经被 redact 过');
  console.log('  [19/22] worker.error 兜底 redact：ok（未泄漏 key 值）');
}

// ---- 场景 20：重复 start() 必须返回实时快照，不是冻结的旧 ready 快照 ----
// 修复前：worker 仍 LIVE 时重复 start() 直接返回 existing.readyPromise——那
// 是启动刚成功那一刻（worker.status 恰好是 'ready'）resolve 掉的旧 Promise，
// 之后 worker 进入 'running' 甚至变化多次，调用方拿到的永远是那张冻结快照。
// 这里让 worker 停在 'running'（故意不回 running/idle/turn-end），断言重复
// start() 返回的 status 是 'running' 而不是历史缓存的 'ready'。
{
  const { supervisor, caseId } = await startFakeWorker({
    extra: { turnTimeoutMs: 5000 },
    handlers: {
      'session/prompt': (frame, c) => {
        c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
        // 故意不回 running/idle/turn-end——让 worker 长期停在 'running'。
      },
    },
  });
  supervisor.prompt(caseId, '让 worker 停在 running').catch(() => {});
  const becameRunning = await waitUntil(() => supervisor.workers.get(caseId).status === 'running');
  assert.equal(becameRunning, true, 'worker 应该先进入 running');
  const reopened = await supervisor.start(caseId);
  assert.equal(reopened.status, 'running', '重复 start() 必须反映当下真实状态，不能返回启动刚成功那一刻冻结的 ready 快照');
  await supervisor.stop(caseId, 'test cleanup: 场景 20 收尾');
  console.log('  [20/22] start() 重复调用返回实时快照：ok（不是冻结的旧 ready 快照）');
}

// ---- 场景 21：_expirePendingInteractions 必须真正应答子进程，不能只清表 ----
// 修复前：这里只清表、只广播 interaction/expired，从未真正应答子进程那一头
// 还挂着的 approval/request、user-question/request——子进程可能因此一直阻塞
// 在等待审批/回答上。这里让子进程发出一条 approval 和一条 question，之后 turn
// 因超时失败触发清表，断言 supervisor 确实往 child.stdin 写回了对应 id 的
// 应答帧（approval → outcome:'unavailable'；question → JSON-RPC error），
// 而不是子进程那头永远等不到回复。
{
  const framesFromSupervisor = [];
  const { supervisor, caseId, worker } = await startFakeWorker({
    extra: { turnTimeoutMs: 80, interactionTtlMs: 5000 },
    handlers: {
      'session/prompt': (frame, c) => {
        c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
        c.sendLine({
          jsonrpc: '2.0', id: 9010, method: 'approval/request',
          params: { sessionId: frame.params.sessionId, approvalId: 'a10', toolName: 'write' },
        });
        c.sendLine({
          jsonrpc: '2.0', id: 9011, method: 'user-question/request',
          params: { sessionId: frame.params.sessionId, questions: [{ id: 'q1', question: '要不要继续？' }] },
        });
        // 故意不回 running/idle/turn-end——逼 turn 走超时分支，连带触发
        // pendingInteractions 的清表。
      },
      shutdown: (frame, c) => {
        const timer = setTimeout(() => {
          c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
          c.emitExit(0, null);
        }, 300);
        timer.unref?.();
      },
    },
  });
  worker.child.stdin.on('data', (chunk) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      framesFromSupervisor.push(JSON.parse(line));
    }
  });
  const outcome = await settle(supervisor.prompt(caseId, '触发两个待处理反向请求，之后 turn 超时'));
  assert.equal(outcome.ok, false, 'turn 应该因为超时而失败');
  const approvalReply = framesFromSupervisor.find((f) => f.id === 9010);
  const questionReply = framesFromSupervisor.find((f) => f.id === 9011);
  assert.ok(approvalReply, 'turn 失败清表时必须真正应答子进程那条 approval/request，不能只清表不回');
  assert.equal(approvalReply.result?.outcome, 'unavailable', '过期 approval 必须回 outcome:unavailable');
  assert.ok(questionReply, 'turn 失败清表时必须真正应答子进程那条 user-question/request');
  assert.ok(questionReply.error, '过期 question 必须回 JSON-RPC error，而不是悬空不回');
  console.log('  [21/22] _expirePendingInteractions 真正应答子进程：ok（approval unavailable / question error）');
}

// ---- 场景 22：assets/node_modules 由 supervisor 运行时确保 ----
// 修复前：src/agent/assets/node_modules 是提交进仓库的一条符号链接，指向
// src/agent/runtime/node_modules（该目录本身从不进仓库）——全新 clone 在跑
// runtime 自己那次 npm install 之前，这条链接天然悬空。现在改成
// ensureAssetsNodeModulesLink() 在每次 start() 真正 spawn 之前运行时确保：
// 链接缺失就补回来；那个位置被换成一个意外的非符号链接条目（例如误放的真实
// 目录）时必须拒绝，不能静默覆盖调用方可能有意放置的东西。这里直接操作仓库
// 真实的 assets/node_modules（单例路径，不是测试隔离出来的临时目录），用
// try/finally 保证测试结束后一定恢复成正确状态。
{
  const assetsLinkPath = path.join(AGENT_RUNTIME_PATHS.assetsDir, 'node_modules');
  const runtimeNodeModulesPath = path.join(AGENT_RUNTIME_PATHS.runtimeDir, 'node_modules');
  const originalStat = fs.lstatSync(assetsLinkPath);
  assert.equal(originalStat.isSymbolicLink(), true, '测试前置条件：assets/node_modules 应该已经是一条符号链接');

  fs.rmSync(assetsLinkPath, { force: true });
  try {
    clearAgentSettings();
    setSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
    setSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
    setSetting(AGENT_SETTINGS_KEYS.model, 'deepseek-chat');
    setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'TEST_DEEPSEEK_FAKE_API_KEY');
    process.env.TEST_DEEPSEEK_FAKE_API_KEY = 'not-a-real-key';
    process.env.ANJIAN_INTERNAL_KEY = 'not-a-real-internal-key';

    // 场景 A：链接缺失时，start() 必须在 spawn 之前自己补回来。
    const caseNameA = `自检案-node_modules链接缺失-${Math.random().toString(36).slice(2)}`;
    const caseIdA = insertCase(caseNameA);
    fs.mkdirSync(path.join(filesRoot, caseNameA));
    const supervisorA = new AgentSupervisor({
      filesRoot,
      spawnFn: () => makeFakeChild(undefined, {
        'session/create': (frame, c) => {
          c.sendLine({ jsonrpc: '2.0', id: frame.id, result: { sessionId: frame.params.sessionId } });
        },
      }),
    });
    const statusA = await supervisorA.start(caseIdA);
    assert.equal(statusA.status, 'ready', '缺失链接不应该阻止启动——supervisor 应该自己先补回来');
    const relinked = fs.lstatSync(assetsLinkPath);
    assert.equal(relinked.isSymbolicLink(), true, 'start() 之后 assets/node_modules 必须重新是一条符号链接');
    assert.equal(
      fs.realpathSync(assetsLinkPath), fs.realpathSync(runtimeNodeModulesPath),
      '重建的链接必须指向 runtime/node_modules'
    );
    await supervisorA.stop(caseIdA, 'test cleanup: 场景 22A 收尾');

    // 场景 B：那个位置被换成一个意外的真实目录时，start() 必须拒绝。
    fs.rmSync(assetsLinkPath, { recursive: true, force: true });
    fs.mkdirSync(assetsLinkPath);
    const caseNameB = `自检案-node_modules意外目录-${Math.random().toString(36).slice(2)}`;
    const caseIdB = insertCase(caseNameB);
    fs.mkdirSync(path.join(filesRoot, caseNameB));
    const supervisorB = new AgentSupervisor({ filesRoot, spawnFn: neverSpawn() });
    const statusB = await supervisorB.start(caseIdB);
    assert.equal(statusB.status, 'error');
    assert.equal(statusB.error, 'runtime_link_invalid', '意外的非符号链接条目必须让 start() 拒绝，不能静默覆盖');
    assert.equal(supervisorB.workers.has(caseIdB), false, '拒绝时不应该留下一个已注册的 worker');
  } finally {
    fs.rmSync(assetsLinkPath, { recursive: true, force: true });
    fs.symlinkSync(runtimeNodeModulesPath, assetsLinkPath, 'dir');
  }
  console.log('  [22/22] assets/node_modules 运行时确保：ok（缺失自动补链接；意外目录拒绝覆盖）');
}

clearAgentSettings();
console.log('agent supervisor 自检全部通过');
