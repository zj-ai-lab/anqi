// DSH sidecar 进程外 worker 管理器（设计稿 §3）。
//
// 库化自 anqi-spike-dsh 的 driver.mjs：同一套 JSON-RPC 协议客户端逻辑（spawn →
// initialize → session/create → session/preflight → session/prompt →
// running/idle/turn-end 追踪 → shutdown），改造点是：
//   - driver.mjs 是"一次性 CLI，一个案件、一个 prompt、退出"；这里是长期library，
//     per-case 单 worker 注册表，turn 可以来一串、可以取消、worker 可以重启。
//   - driver.mjs 的 approval/user-question 用 CLI 参数配的静态策略（固定 reject
//     或固定答案）；这里没有 UI 层可以问人，所以把这两类反向 RPC 变成
//     one-shot pending 表——外部（下阶段的 HTTP 层）用 resolveApproval() /
//     resolveQuestion() 来喂答案，超时或未消费一律 fail-closed 到
//     rejected/unavailable，不因为没人应答就放行。
//   - 增加结构化事件管道：所有 wire 事件转发前做字段截断 + secret redaction，
//     再按 case 广播给订阅者（下阶段 SSE 层的数据源）。
//
// 红线（任务书 + 设计稿 §1/§3/§4，本文件必须满足）：
//   - enabled=false 必须在读 credential、初始化 MCP、spawn 子进程之前短路——
//     start() 第一步就是 loadAgentConfig()，不通过直接返回，不碰 process.env
//     里的 apiKeyEnv、不碰案件目录、不 spawn。
//   - 案件夹必须在 ANJIAN_FILES_ROOT 下且与 case.name 精确对应、禁 symlink——
//     直接复用 src/lib/secure-files.js 的 resolveCaseDirectory()（files.js/
//     fees.js 已经在用的同一份实现），不重新发明一套路径校验。
//   - key 的值永不进 UI/DB/HTTP/SSE/日志/错误串/仓库——spawn 用最小 env
//     （buildSpawnEnv），事件管道用 redact() 过滤 apiKeyEnv 指向的值与内部
//     key 值，长度做截断。
//   - Electron 下 spawn 用 process.execPath + ELECTRON_RUN_AS_NODE=1
//     （process.versions.electron 存在时）；服务器模式直接 process.execPath
//     ——见 electronSpawnEnv()。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { db, audit } from '../db.js';
import { resolveCaseDirectory } from '../lib/secure-files.js';
import { loadAgentConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, 'assets');
const RUNTIME_DIR = path.join(__dirname, 'runtime');
const CORDIS_CONFIG = path.join(ASSETS_DIR, 'anqi.cordis.yml');
const DSH_BIN = path.join(
  RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-demo', 'lib', 'bin.js'
);
const TRUSTED_SKILLS_ROOT = path.join(ASSETS_DIR, 'skills');
const REQUIRED_SKILL_NAME = 'anqi-case-brief';
const REQUIRED_SKILL_FILE = path.join(TRUSTED_SKILLS_ROOT, REQUIRED_SKILL_NAME, 'SKILL.md');
const REQUIRED_MCP_TOOL = 'mcp__anqi-local__case_folder_info';
// repo-root/data：与 src/db.js 的 DB_PATH 默认值同一目录，已经被 .gitignore 的
// `data/` 规则覆盖，不需要额外忽略规则。
const DEFAULT_SESSION_ROOT = path.join(__dirname, '..', '..', 'data', 'agent-sessions');

const TERMINAL_STATUSES = new Set(['stopped', 'crashed', 'error', 'disabled']);
const LIVE_STATUSES = new Set(['starting', 'ready', 'running']);
const APPROVAL_EXTERNAL_OUTCOMES = new Set(['allowed-once', 'rejected']);

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 90_000;
const DEFAULT_INTERACTION_TTL_MS = 2 * 60 * 1000;
const MAX_EVENT_FIELD_CHARS = 4000;
const REDACTED = '[REDACTED]';

function timeoutPromise(ms, message) {
  let timer;
  const promise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

// ---- 受信任 skill 根的校验与隔离拷贝（移植自 driver.mjs，逻辑未改动）----
// customSkillDirs 指向的目录不能含符号链接、不能被案件夹或用户配置污染；每次
// 启动都拷到一个新的 0700 临时目录里喂给 DSH，worker 退出后立即删除。
function verifyTrustedSkillsRoot() {
  let rootStat;
  try {
    rootStat = lstatSync(TRUSTED_SKILLS_ROOT);
  } catch {
    throw new Error(`trusted anqi skill root not found: ${TRUSTED_SKILLS_ROOT}`);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`trusted anqi skill root must be a real directory: ${TRUSTED_SKILLS_ROOT}`);
  }
  const root = realpathSync(TRUSTED_SKILLS_ROOT);
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = readdirSync(directory);
    } catch (error) {
      throw new Error(`trusted anqi skill root could not be read: ${directory}`, { cause: error });
    }
    for (const name of entries) {
      const entryPath = path.join(directory, name);
      let entryStat;
      try {
        entryStat = lstatSync(entryPath);
      } catch (error) {
        throw new Error(`trusted anqi skill entry could not be inspected: ${entryPath}`, { cause: error });
      }
      if (entryStat.isSymbolicLink()) {
        throw new Error(`trusted anqi skill tree must not contain symlinks: ${entryPath}`);
      }
      if (entryStat.isDirectory()) pending.push(entryPath);
      else if (!entryStat.isFile()) {
        throw new Error(`trusted anqi skill tree contains a non-regular entry: ${entryPath}`);
      }
    }
  }
  if (!existsSync(REQUIRED_SKILL_FILE)) {
    throw new Error(`required anqi skill not found: ${REQUIRED_SKILL_FILE}`);
  }
  return root;
}

function materializeTrustedSkillsRoot(sourceRoot) {
  const runtimeRoot = mkdtempSync(path.join(tmpdir(), 'anqi-dsh-skills-'));
  try {
    chmodSync(runtimeRoot, 0o700);
    const runtimeSkillDir = path.join(runtimeRoot, REQUIRED_SKILL_NAME);
    mkdirSync(runtimeSkillDir, { mode: 0o700 });
    chmodSync(runtimeSkillDir, 0o700);
    copyFileSync(
      path.join(sourceRoot, REQUIRED_SKILL_NAME, 'SKILL.md'),
      path.join(runtimeSkillDir, 'SKILL.md')
    );
    chmodSync(path.join(runtimeSkillDir, 'SKILL.md'), 0o600);
    return runtimeRoot;
  } catch (error) {
    rmSync(runtimeRoot, { recursive: true, force: true });
    throw new Error(`could not materialize trusted anqi skills: ${sourceRoot}`, { cause: error });
  }
}

// ---- sanitized spawn env ----
// 白名单起步：只带子进程真正需要的少量宿主变量，不是 `{...process.env}`。
const BASE_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'windir'];

function baseSpawnEnv() {
  const env = {};
  for (const key of BASE_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

// Electron 下没有独立的 node 可执行文件——process.execPath 指向 Electron 本体
// （一个会起 Chromium/Electron 运行时的可执行文件）。ELECTRON_RUN_AS_NODE=1 是
// Electron 官方支持的开关：子进程仍用同一个 process.execPath 启动，但表现为
// 纯 Node 进程，不初始化 Electron/Chromium。服务器模式（无 Electron）下
// process.versions.electron 不存在，直接用 process.execPath 当普通 node 二进
// 制即可，不需要这个变量。
function electronSpawnEnv() {
  return process.versions?.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
}

function buildSpawnEnv({ config, apiKeyValue, internalKeyEnv, internalKeyValue, internalBaseURL, caseCwd, sessionId, sessionRoot, skillsRoot }) {
  return {
    ...baseSpawnEnv(),
    ...electronSpawnEnv(),
    // 用户 shell 里若已经装过别的 DSH 项目，DSH_CORDIS_CONFIG 的存在会让
    // launcher 优先用它而不是 argv（§9 踩坑 #11）；这里显式钉死，防止被继承
    // 的宿主环境顶掉本仓库的组合。
    DSH_CORDIS_CONFIG: CORDIS_CONFIG,
    DSH_PROVIDER_KIND: config.provider,
    DSH_API_KEY_ENV: config.apiKeyEnv,
    [config.apiKeyEnv]: apiKeyValue,
    DSH_BASE_URL: config.baseURL,
    DSH_MODEL: config.model,
    DSH_CWD: caseCwd,
    DSH_ANQI_SKILLS_ROOT: skillsRoot,
    DSH_SESSION_ROOT: sessionRoot,
    ANQI_BASE_URL: internalBaseURL,
    ANQI_INTERNAL_KEY_ENV: internalKeyEnv,
    [internalKeyEnv]: internalKeyValue,
    ANQI_AGENT_SESSION_ID: sessionId,
  };
}

function redactor(secretValues) {
  const values = secretValues.filter(Boolean);
  return (input) => {
    let text = typeof input === 'string' ? input : JSON.stringify(input);
    for (const secret of values) text = text.split(secret).join(REDACTED);
    if (text.length > MAX_EVENT_FIELD_CHARS) {
      text = `${text.slice(0, MAX_EVENT_FIELD_CHARS)}…[truncated ${text.length - MAX_EVENT_FIELD_CHARS} chars]`;
    }
    return text;
  };
}

function nowIso() {
  return new Date().toISOString();
}

// 一个案件 worker 的完整生命周期：spawn → initialize → session/create →
// session/preflight → 一串串行 turn → stop/crash。
class Worker {
  constructor(caseId, caseName, sessionId) {
    this.caseId = caseId;
    this.caseName = caseName;
    this.cwd = null;
    this.sessionId = sessionId;
    this.status = 'starting';
    this.startedAt = nowIso();
    this.child = null;
    this.pid = null;
    this.provider = null;
    this.model = null;
    this.error = null;
    this.exitInfo = null;
    this.skillsRootTmp = null;
    this.listeners = new Set();
    this.pendingRpc = new Map(); // outgoing request id -> {resolve,reject,method}
    this.pendingInteractions = new Map(); // interactionId -> record
    this.nextRpcId = 1;
    this.nextTurnId = 1;
    this.turnLock = Promise.resolve();
    this.currentAbort = null;
    this.firstTurnChecked = false;
    this.redact = (text) => String(text);
    this.readyPromise = null;
    this._finalized = false;
  }

  emit(type, data) {
    const event = { type, caseId: this.caseId, sessionId: this.sessionId, at: nowIso(), data };
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* 订阅者自己的错误不影响 worker */ }
    }
  }
}

export class AgentSupervisor {
  constructor({
    filesRoot = process.env.ANJIAN_FILES_ROOT,
    internalKeyEnv = process.env.ANQI_INTERNAL_KEY_ENV || 'ANJIAN_INTERNAL_KEY',
    internalBaseURL = process.env.ANQI_AGENT_BASE_URL || 'http://127.0.0.1:3007',
    sessionRoot = DEFAULT_SESSION_ROOT,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    preflightTimeoutMs = DEFAULT_PREFLIGHT_TIMEOUT_MS,
    interactionTtlMs = DEFAULT_INTERACTION_TTL_MS,
    spawnFn = spawn,
    loadConfigFn = loadAgentConfig,
    resolveCaseDirectoryFn = resolveCaseDirectory,
    actor = 'agent-supervisor',
  } = {}) {
    this.filesRoot = filesRoot;
    this.internalKeyEnv = internalKeyEnv;
    this.internalBaseURL = internalBaseURL;
    this.sessionRoot = sessionRoot;
    this.turnTimeoutMs = turnTimeoutMs;
    this.preflightTimeoutMs = preflightTimeoutMs;
    this.interactionTtlMs = interactionTtlMs;
    this.spawnFn = spawnFn;
    this.loadConfigFn = loadConfigFn;
    this.resolveCaseDirectoryFn = resolveCaseDirectoryFn;
    this.actor = actor;
    this.workers = new Map(); // caseId -> Worker
  }

  // ---- 对外只读状态 ----
  status(caseId) {
    const worker = this.workers.get(caseId);
    if (!worker) return { status: 'stopped', caseId };
    return {
      status: worker.status,
      caseId: worker.caseId,
      caseName: worker.caseName,
      sessionId: worker.sessionId,
      startedAt: worker.startedAt,
      provider: worker.provider,
      model: worker.model,
      error: worker.error,
      exitInfo: worker.exitInfo,
    };
  }

  onEvent(caseId, listener) {
    const worker = this.workers.get(caseId);
    if (!worker) return () => {};
    worker.listeners.add(listener);
    return () => worker.listeners.delete(listener);
  }

  listPendingInteractions(caseId) {
    const worker = this.workers.get(caseId);
    if (!worker) return [];
    return [...worker.pendingInteractions.entries()].map(([id, record]) => ({
      id,
      type: record.type,
      toolName: record.toolName,
      questions: record.questions,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    }));
  }

  // ---- 启动序列（设计稿 §3.1，顺序不可打乱）----
  async start(caseId) {
    const existing = this.workers.get(caseId);
    if (existing && LIVE_STATUSES.has(existing.status)) {
      // 重复打开 drawer：复用同一个 worker，不重复 spawn。
      return existing.readyPromise ?? this.status(caseId);
    }

    // 1) enabled/credential gate。enabled!==true 时，下面任何一行都不会跑：
    //    不读 apiKeyEnv 指向的环境变量、不查案件、不动文件系统、不 spawn。
    const config = this.loadConfigFn();
    if (!config.enabled) {
      audit(this.actor, 'agent-start-skip', 'agent-worker', caseId, config.error ? `disabled:${config.error}` : 'disabled');
      return { status: 'disabled', caseId, error: config.error };
    }
    const apiKeyValue = process.env[config.apiKeyEnv];
    if (!apiKeyValue) {
      audit(this.actor, 'agent-start-fail', 'agent-worker', caseId, 'credential_missing');
      return { status: 'error', caseId, error: 'credential_missing' };
    }
    const internalKeyValue = process.env[this.internalKeyEnv];
    if (!internalKeyValue) {
      audit(this.actor, 'agent-start-fail', 'agent-worker', caseId, 'internal_key_missing');
      return { status: 'error', caseId, error: 'internal_key_missing' };
    }

    // 2) 案件夹校验：必须在 ANJIAN_FILES_ROOT 下、与 case.name 精确对应、不是
    //    symlink——复用既有的 secure-files.resolveCaseDirectory，不重新发明。
    const caseRow = db.prepare('SELECT id, name FROM cases WHERE id = ?').get(caseId);
    if (!caseRow) {
      audit(this.actor, 'agent-start-fail', 'agent-worker', caseId, 'case_not_found');
      return { status: 'error', caseId, error: 'case_not_found' };
    }
    let dirContext;
    try {
      dirContext = this.resolveCaseDirectoryFn(this.filesRoot, caseRow.name);
    } catch (error) {
      audit(this.actor, 'agent-start-fail', 'agent-worker', caseId, `cwd_invalid:${error.code || error.message}`);
      return { status: 'error', caseId, error: 'cwd_invalid' };
    }
    if (!dirContext.exists) {
      audit(this.actor, 'agent-start-fail', 'agent-worker', caseId, 'case_folder_missing');
      return { status: 'error', caseId, error: 'case_folder_missing' };
    }

    // 3) 受信任 skill 根校验 + 隔离拷贝（每次启动独立一份 0700 临时目录）。
    let trustedSkillsSource;
    let materializedSkillsRoot;
    try {
      trustedSkillsSource = verifyTrustedSkillsRoot();
      materializedSkillsRoot = materializeTrustedSkillsRoot(trustedSkillsSource);
    } catch (error) {
      audit(this.actor, 'agent-start-fail', 'agent-worker', caseId, `skills_root_invalid:${error.message}`.slice(0, 200));
      return { status: 'error', caseId, error: 'skills_root_invalid' };
    }

    const sessionId = `anqi-${randomUUID()}`;
    const worker = new Worker(caseId, caseRow.name, sessionId);
    worker.provider = config.provider;
    worker.model = config.model;
    worker.cwd = dirContext.caseRoot;
    worker.skillsRootTmp = materializedSkillsRoot;
    worker.redact = redactor([apiKeyValue, internalKeyValue]);
    this.workers.set(caseId, worker);

    // 4) sanitized env 下 spawn；不 `{...process.env}` 展开。
    const env = buildSpawnEnv({
      config,
      apiKeyValue,
      internalKeyEnv: this.internalKeyEnv,
      internalKeyValue,
      internalBaseURL: this.internalBaseURL,
      caseCwd: dirContext.caseRoot,
      sessionId,
      sessionRoot: this.sessionRoot,
      skillsRoot: materializedSkillsRoot,
    });

    let child;
    try {
      child = this.spawnFn(process.execPath, [DSH_BIN, CORDIS_CONFIG], {
        cwd: ASSETS_DIR,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this._finalizeWorker(worker, 'error', `spawn_failed:${error.message}`.slice(0, 200));
      return this.status(caseId);
    }
    worker.child = child;
    worker.pid = child.pid ?? null;
    audit(this.actor, 'agent-start', 'agent-worker', caseId, `session=${sessionId} pid=${worker.pid}`);

    this._wireChild(worker, child);

    worker.readyPromise = this._runStartupSequence(worker, child, {
      apiKeyValue,
      internalKeyValue,
      runtimeProvider: config.runtimeProvider,
      model: config.model,
    }).then(
      () => this.status(caseId),
      (error) => {
        if (!TERMINAL_STATUSES.has(worker.status)) {
          this._finalizeWorker(worker, 'error', `startup_failed:${error.message}`.slice(0, 200));
        }
        return this.status(caseId);
      }
    );
    return worker.readyPromise;
  }

  async _runStartupSequence(worker, child, { runtimeProvider, model }) {
    await this._request(worker, 'initialize', { cwd: worker.cwd, provider: runtimeProvider, model }, 120_000);
    const created = await this._request(worker, 'session/create', { sessionId: worker.sessionId }, 120_000);
    if (created?.sessionId !== worker.sessionId) {
      throw new Error('session/create returned the wrong session identity');
    }
    await this._request(worker, 'session/preflight', { sessionId: worker.sessionId }, this.preflightTimeoutMs);
    worker.status = 'ready';
    worker.emit('worker/ready', {});
  }

  // ---- turn 执行：串行 + 可取消 ----
  async prompt(caseId, text) {
    const worker = this.workers.get(caseId);
    if (!worker || !LIVE_STATUSES.has(worker.status)) {
      const error = new Error('worker is not running');
      error.code = 'worker_not_running';
      throw error;
    }
    const run = () => this._runTurn(worker, text);
    const turnPromise = worker.turnLock.then(run, run);
    // 后续 turn 排队；任何一个 turn 失败不阻塞下一个 turn 排队执行。
    worker.turnLock = turnPromise.then(() => {}, () => {});
    return turnPromise;
  }

  async _runTurn(worker, text) {
    if (!LIVE_STATUSES.has(worker.status)) {
      const error = new Error('worker is not running');
      error.code = 'worker_not_running';
      throw error;
    }
    const turnId = worker.nextTurnId++;
    const controller = new AbortController();
    worker.currentAbort = controller;
    worker.status = 'running';
    worker.emit('turn/start', { turnId });

    const turnDone = new Promise((resolveTurn, rejectTurn) => {
      worker._turnResolvers = { resolveTurn, rejectTurn, turnId, sawRunning: false, sawIdle: false, sawEnd: false };
    });
    turnDone.catch(() => {});

    try {
      await this._request(worker, 'session/prompt', {
        sessionId: worker.sessionId,
        contentBlocks: [{ type: 'text', text }],
      }, 60_000);
      const abortListener = () => worker._turnResolvers?.rejectTurn(new Error('turn cancelled'));
      controller.signal.addEventListener('abort', abortListener, { once: true });
      const timeout = timeoutPromise(this.turnTimeoutMs, 'turn timed out');
      try {
        await Promise.race([turnDone, timeout.promise]);
      } finally {
        timeout.cancel();
        controller.signal.removeEventListener('abort', abortListener);
      }
      worker.status = 'ready';
      worker.emit('turn/end', { turnId, outcome: 'completed' });
      return { turnId };
    } catch (error) {
      if (LIVE_STATUSES.has(worker.status)) worker.status = 'ready';
      worker.emit('turn/end', { turnId, outcome: 'failed', reason: worker.redact(error.message) });
      throw error;
    } finally {
      worker._turnResolvers = null;
      if (worker.currentAbort === controller) worker.currentAbort = null;
    }
  }

  // rc.7 的 JSON-RPC 面没有 turn 级别的取消方法——stock/我们扩展后的 server
  // 都只认 initialize/session/*/shutdown（见 @deepseek-ai/dsh-sdk-jsonrpc-
  // server 源码 handleRequest），没有 turn/cancel 这一档。本地 abort 能让
  // 调用方立刻解除阻塞、不把之后到达的任何输出当成完成，但后台 DSH 进程仍
  // 可能继续跑完它自己的 turn；唯一能真正打断在飞模型调用的手段是终止整个
  // worker 进程，防止一个「已取消」的 turn 之后还悄悄跑到 anqi_inbox_propose。
  // 因此取消 = 本地 abort（立即生效）+ 终止 worker（异步收尾）。下一次
  // start() 必须是全新 session——与设计稿 §3.2「重启只允许从新的 turn 开始」
  // 一致，调用方不应该假设旧 session 还能继续用。
  cancelTurn(caseId, reason = 'cancelled by user') {
    const worker = this.workers.get(caseId);
    if (!worker?.currentAbort) return false;
    worker.currentAbort.abort(new Error(reason));
    this.stop(caseId, reason).catch(() => {});
    return true;
  }

  // ---- approval / user-question：one-shot、fail-closed ----
  resolveApproval(caseId, interactionId, outcome) {
    const worker = this.workers.get(caseId);
    if (!worker) return { ok: false, reason: 'unavailable' };
    const record = worker.pendingInteractions.get(interactionId);
    if (!record || record.type !== 'approval' || record.sessionId !== worker.sessionId) {
      return { ok: false, reason: 'unavailable' };
    }
    if (!APPROVAL_EXTERNAL_OUTCOMES.has(outcome)) return { ok: false, reason: 'invalid_outcome' };
    worker.pendingInteractions.delete(interactionId); // 消费即删：one-shot
    clearTimeout(record.timer);
    record.respond({ outcome });
    return { ok: true };
  }

  resolveQuestion(caseId, interactionId, answer) {
    const worker = this.workers.get(caseId);
    if (!worker) return { ok: false, reason: 'unavailable' };
    const record = worker.pendingInteractions.get(interactionId);
    if (!record || record.type !== 'question' || record.sessionId !== worker.sessionId) {
      return { ok: false, reason: 'unavailable' };
    }
    worker.pendingInteractions.delete(interactionId);
    clearTimeout(record.timer);
    record.respond(answer);
    return { ok: true };
  }

  // ---- 关闭 ----
  async stop(caseId, reason = 'requested') {
    const worker = this.workers.get(caseId);
    if (!worker) return { status: 'stopped', caseId };
    if (worker.currentAbort) worker.currentAbort.abort(new Error('worker stopping'));
    if (worker.child && worker.child.exitCode === null) {
      try {
        await this._request(worker, 'shutdown', undefined, 30_000);
      } catch { /* 走到下面的强制终止兜底 */ }
      const { promise, cancel } = timeoutPromise(10_000, 'shutdown wait timed out');
      try {
        await Promise.race([
          new Promise((r) => worker.child.once('exit', r)),
          promise,
        ]);
      } catch { /* 超时兜底 */ }
      cancel();
      if (worker.child.exitCode === null) worker.child.kill('SIGTERM');
    }
    this._finalizeWorker(worker, worker.status === 'crashed' ? 'crashed' : 'stopped', reason);
    return this.status(caseId);
  }

  async stopAll(reason = 'server shutdown') {
    await Promise.allSettled([...this.workers.keys()].map((caseId) => this.stop(caseId, reason)));
  }

  // ---- 内部：wire 协议 ----
  _request(worker, method, params, timeoutMs = 60_000) {
    const child = worker.child;
    if (!child || child.stdin.destroyed) return Promise.reject(new Error('worker is not connected'));
    const id = worker.nextRpcId++;
    const timeout = timeoutPromise(timeoutMs, `JSON-RPC ${method} timed out`);
    const response = new Promise((resolve, reject) => {
      worker.pendingRpc.set(id, { method, resolve, reject });
      const frame = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
      child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error) {
          worker.pendingRpc.delete(id);
          reject(error);
        }
      });
    });
    return Promise.race([response, timeout.promise]).finally(() => {
      timeout.cancel();
      worker.pendingRpc.delete(id);
    });
  }

  _writeChildResponse(worker, frame) {
    const child = worker.child;
    if (!child || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  _wireChild(worker, child) {
    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdout.on('line', (line) => this._handleLine(worker, line));
    stdout.on('error', () => this._handleFatal(worker, new Error('stdout error')));

    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderr.on('line', (line) => worker.emit('stderr', { line: worker.redact(line) }));

    child.once('error', (error) => this._handleFatal(worker, error));
    child.once('exit', (code, signal) => this._handleExit(worker, code, signal));
  }

  _handleLine(worker, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      worker.emit('protocol-error', { detail: worker.redact(`non-JSON stdout: ${line}`) });
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      this._handleChildRequest(worker, message);
      return;
    }
    if (message.id !== undefined && ('result' in message || 'error' in message)) {
      const entry = worker.pendingRpc.get(message.id);
      if (!entry) return;
      worker.pendingRpc.delete(message.id);
      if (message.error) {
        entry.reject(new Error(`JSON-RPC ${entry.method} failed: ${worker.redact(message.error.message || JSON.stringify(message.error))}`));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (message.method) this._handleNotification(worker, message);
  }

  _handleNotification(worker, message) {
    const params = message.params || {};
    if (message.method === 'session.status') {
      if (params.sessionId === worker.sessionId && worker._turnResolvers) {
        if (params.status === 'running') worker._turnResolvers.sawRunning = true;
        if (params.status === 'idle') {
          worker._turnResolvers.sawIdle = true;
          this._maybeResolveTurn(worker);
        }
      }
      return;
    }
    if (message.method !== 'session.event') {
      worker.emit('notification', { method: message.method, data: worker.redact(JSON.stringify(params)) });
      return;
    }
    if (params.sessionId !== worker.sessionId) return;
    const event = params.event || {};
    worker.emit(event.type || 'session.event', this._redactEventData(worker, event.data));

    if (event.type === 'request/header') {
      if (!worker.firstTurnChecked) {
        worker._firstRequestHeader = event.data;
      }
    } else if (event.type === 'tool/call') {
      if (event.data?.name === REQUIRED_MCP_TOOL) worker._sawRequiredMcpCall = true;
    } else if (event.type === 'turn/end') {
      if (worker._turnResolvers) {
        worker._turnResolvers.sawEnd = true;
        if (event.data?.reason?.kind !== 'completed') {
          worker._turnResolvers.rejectTurn(new Error(`turn ended with ${worker.redact(JSON.stringify(event.data?.reason || {}))}`));
        } else {
          this._maybeResolveTurn(worker);
        }
      }
    }
  }

  _maybeResolveTurn(worker) {
    const state = worker._turnResolvers;
    if (!state || !state.sawRunning || !state.sawIdle || !state.sawEnd) return;
    if (!worker.firstTurnChecked) {
      worker.firstTurnChecked = true;
      const header = worker._firstRequestHeader;
      const tools = header?.tools;
      const ready = header?.reason === 'initial'
        && Array.isArray(tools) && tools.some((tool) => tool?.name === REQUIRED_MCP_TOOL)
        && worker._sawRequiredMcpCall === true;
      if (!ready) {
        state.rejectTurn(new Error('first turn did not establish the required MCP tool readiness'));
        return;
      }
    }
    state.resolveTurn();
  }

  _redactEventData(worker, data) {
    try {
      const text = worker.redact(JSON.stringify(data));
      return JSON.parse(text.includes(REDACTED) ? JSON.stringify({ redacted: text }) : text);
    } catch {
      return { redacted: true };
    }
  }

  _handleChildRequest(worker, message) {
    const params = message.params || {};
    if (message.method === 'approval/request') {
      this._enqueueApproval(worker, message, params);
      return;
    }
    if (message.method === 'user-question/request') {
      this._enqueueQuestion(worker, message, params);
      return;
    }
    this._writeChildResponse(worker, {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `unknown method: ${message.method}` },
    });
  }

  // 反向 RPC → one-shot pending 表。三重绑定：interactionId 只在这一个
  // worker（案件+固定 session）的 map 里查得到；record.sessionId 必须等于
  // worker 当前 sessionId；record 一旦被消费（resolveApproval/Question 命中，
  // 或超时兜底）立即从 map 删除，第二次用同一个 interactionId 必然查不到。
  _enqueueApproval(worker, message, params) {
    const interactionId = randomUUID();
    const expiresAt = Date.now() + this.interactionTtlMs;
    const timer = setTimeout(() => {
      if (!worker.pendingInteractions.has(interactionId)) return;
      worker.pendingInteractions.delete(interactionId);
      this._writeChildResponse(worker, {
        jsonrpc: '2.0', id: message.id,
        result: { sessionId: params.sessionId, approvalId: params.approvalId, outcome: 'unavailable' },
      });
      worker.emit('interaction/expired', { interactionId, type: 'approval' });
    }, this.interactionTtlMs);
    timer.unref?.();
    worker.pendingInteractions.set(interactionId, {
      type: 'approval',
      sessionId: params.sessionId,
      toolName: params.toolName,
      createdAt: nowIso(),
      expiresAt: new Date(expiresAt).toISOString(),
      timer,
      respond: ({ outcome }) => {
        this._writeChildResponse(worker, {
          jsonrpc: '2.0', id: message.id,
          result: { sessionId: params.sessionId, approvalId: params.approvalId, outcome },
        });
      },
    });
    worker.emit('interaction/pending', {
      interactionId, type: 'approval', toolName: worker.redact(String(params.toolName || '')),
    });
  }

  _enqueueQuestion(worker, message, params) {
    const interactionId = randomUUID();
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const timer = setTimeout(() => {
      if (!worker.pendingInteractions.has(interactionId)) return;
      worker.pendingInteractions.delete(interactionId);
      this._writeChildResponse(worker, {
        jsonrpc: '2.0', id: message.id,
        error: { code: -32004, message: 'ask_user_question timed out waiting for an answer' },
      });
      worker.emit('interaction/expired', { interactionId, type: 'question' });
    }, this.interactionTtlMs);
    timer.unref?.();
    worker.pendingInteractions.set(interactionId, {
      type: 'question',
      sessionId: params.sessionId,
      questions: questions.map((q) => ({ id: q?.id, question: worker.redact(String(q?.question || '')) })),
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + this.interactionTtlMs).toISOString(),
      timer,
      respond: (answer) => {
        this._writeChildResponse(worker, {
          jsonrpc: '2.0', id: message.id,
          result: { sessionId: params.sessionId, answer },
        });
      },
    });
    worker.emit('interaction/pending', { interactionId, type: 'question' });
  }

  _handleFatal(worker, error) {
    for (const entry of worker.pendingRpc.values()) entry.reject(error);
    worker.pendingRpc.clear();
    worker._turnResolvers?.rejectTurn(error);
  }

  _handleExit(worker, code, signal) {
    this._handleFatal(worker, new Error(`worker exited (code=${code}, signal=${signal || 'none'})`));
    // 未消费的反向请求一律 fail-closed，不留悬空 Promise。
    for (const [interactionId, record] of worker.pendingInteractions) {
      clearTimeout(record.timer);
      worker.emit('interaction/expired', { interactionId, type: record.type, reason: 'worker_exit' });
    }
    worker.pendingInteractions.clear();
    const wasClean = code === 0;
    this._finalizeWorker(worker, wasClean ? 'stopped' : 'crashed', `exit code=${code} signal=${signal || 'none'}`, { code, signal });
  }

  // 终态只落一次账：graceful stop() 与子进程 'exit' 事件可能前后脚都想收尾同
  // 一个 worker，第二次调用只是 no-op（不重复审计、不重复 emit worker/exit）。
  _finalizeWorker(worker, status, detail, exitInfo = null) {
    if (worker._finalized) return;
    worker._finalized = true;
    worker.status = status;
    worker.error = TERMINAL_STATUSES.has(status) && status !== 'stopped' ? detail : worker.error;
    worker.exitInfo = exitInfo;
    if (worker.skillsRootTmp) {
      rmSync(worker.skillsRootTmp, { recursive: true, force: true });
      worker.skillsRootTmp = null;
    }
    audit(this.actor, `agent-${status}`, 'agent-worker', worker.caseId, worker.redact(String(detail || '')).slice(0, 200));
    worker.emit('worker/exit', { status, detail: worker.redact(String(detail || '')) });
  }
}

export const AGENT_RUNTIME_PATHS = Object.freeze({
  assetsDir: ASSETS_DIR,
  runtimeDir: RUNTIME_DIR,
  cordisConfig: CORDIS_CONFIG,
  dshBin: DSH_BIN,
  trustedSkillsRoot: TRUSTED_SKILLS_ROOT,
  requiredMcpTool: REQUIRED_MCP_TOOL,
});
