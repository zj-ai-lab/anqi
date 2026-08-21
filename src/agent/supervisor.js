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
  readFileSync,
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
import { bindSession, unbindSession } from './session-registry.js';

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

// 设计稿 §3.1 要求固定记录的字段之一：DSH 版本。initialize 的 wire 协议不
// 回传版本号，rc.7 也没有单独的 version RPC，所以在模块加载时读一次自己钉死
// 的运行时依赖版本（package.json 里的 "version" 字段，与 runtime/package.json
// 锁定的 0.1.0-rc.7 一致），失败也不阻塞——status() 里用 'unknown' 兜底。
function readDshVersion() {
  try {
    const pkgPath = path.join(
      RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-demo', 'package.json'
    );
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
const DSH_VERSION = readDshVersion();
const REQUIRED_MCP_TOOL = 'mcp__anqi-local__case_folder_info';

// session/preflight 的返回值必须被宿主逐字段核验——设计稿 §3.1「session/
// preflight → exact scoped MCP registry + exact skill snapshot」与 §6 门禁 4
// 「首个 request/header 同时含唯一 anqi skill 和精确 mcp__anqi-local__
// case_folder_info」在这里对应的是唯一的宿主侧信任锚点：子进程 plugins/
// dsh-anqi-jsonrpc/index.js 只校验了 tool 一侧，"唯一 anqi skill" 那一半此前
// 完全没有宿主侧机械约束（只剩子进程自证）。逐字段核验照抄参考实现
// driver.mjs 的 assertFirstRequestReadiness/preflight 断言块。
function isPreflightReady(preflight) {
  const visibleToolNames = preflight?.tools?.visibleNames;
  const skillNames = preflight?.skills?.names;
  return preflight?.ready === true
    && preflight.tools?.required === REQUIRED_MCP_TOOL
    && preflight.tools?.ready === true
    && Array.isArray(visibleToolNames)
    && visibleToolNames.includes(REQUIRED_MCP_TOOL)
    && preflight.skills?.complete === true
    && Array.isArray(skillNames)
    && skillNames.length === 1
    && skillNames[0] === REQUIRED_SKILL_NAME
    && preflight.skills?.ready === true;
}

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

function redactString(input, secretValues) {
  let text = typeof input === 'string' ? input : JSON.stringify(input);
  for (const secret of secretValues) text = text.split(secret).join(REDACTED);
  if (text.length > MAX_EVENT_FIELD_CHARS) {
    text = `${text.slice(0, MAX_EVENT_FIELD_CHARS)}…[truncated ${text.length - MAX_EVENT_FIELD_CHARS} chars]`;
  }
  return text;
}

// 逐叶子字段做 secret redaction + 长度截断，而不是对 JSON.stringify(整包) 之后
// 的完整字符串做长度截断——旧实现把 MAX_EVENT_FIELD_CHARS 施加在整条序列化
// JSON 上，截断点大概率落在字符串中间，产生的不是合法 JSON；_redactEventData
// 再 JSON.parse 这段文本必然抛错，catch 分支把整条 data 静默丢成
// {redacted:true}。assistant 长回答、anqi_case_get 的工具结果（白名单案卷
// events+deadlines+tasks+worklog）日常就会超过 4KB，等于设计稿 §5「有限的
// assistant 文本、工具调用摘要」在事件管道里恒为空。现在只对每个 string 叶子
// 单独限长，容器结构（对象/数组）完整保留，只有真正过长的单个字符串字段会被
// 截断。
function redactDeep(value, secretValues, depth = 0) {
  if (depth > 8) return '[REDACTED:max-depth]';
  if (typeof value === 'string') return redactString(value, secretValues);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secretValues, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, secretValues, depth + 1);
    return out;
  }
  return value;
}

function redactor(secretValues) {
  const values = secretValues.filter(Boolean);
  const fn = (input) => redactString(input, values);
  fn.deep = (data) => redactDeep(data, values);
  return fn;
}

// 对外事件的 `type` 字段最终会成为下阶段 SSE 层的 `event:` 字段名（见文件头
// 注释）；它完全由子进程的 wire 消息控制。之前只对它做过 secret redact，没有
// 清洗控制字符——子进程塞一个含 \n 的 type，理论上可以在 SSE 帧里注入伪造的
// 额外字段/事件。这里剥掉 C0 控制字符与 DEL，并把长度钉在一个事件类型名合理
// 的范围内（远小于 MAX_EVENT_FIELD_CHARS，因为这是"名字"不是"内容"）。
const MAX_EVENT_TYPE_CHARS = 200;
function sanitizeEventType(rawType) {
  const stripped = String(rawType || '').replace(/[\x00-\x1f\x7f]/g, '');
  const truncated = stripped.length > MAX_EVENT_TYPE_CHARS ? stripped.slice(0, MAX_EVENT_TYPE_CHARS) : stripped;
  return truncated || 'session.event';
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
    this.redact = redactor([]); // 占位版本（含 .deep），start() 里换成真正带 secret 值的版本
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
      cwd: worker.cwd,
      sessionId: worker.sessionId,
      pid: worker.pid,
      dshVersion: DSH_VERSION,
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
    // 设计稿 §2/§4：session→case 绑定必须在 supervisor 侧登记，/internal/
    // agent-proposals 等路由才能按 session_id 反查、不再信任请求体里的
    // case_id。在 spawn 之前登记，保证子进程第一次能发起 HTTP 请求时绑定
    // 已经存在，不留任何"session 已注入子进程但服务端还查不到"的窗口。
    bindSession(sessionId, caseId);
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
          // 启动序列失败时（initialize/session-create/preflight 任意一步），
          // 子进程往往已经正常收到并处理了前面几条 RPC、依然存活——之前这里
          // 只把 worker 标成终态，从不终止子进程。门禁 4 之前形同虚设时这条
          // 路径几乎不会触发；现在 session/preflight 会被宿主真正校验（见
          // isPreflightReady），配错 provider/skill 的案件每次 start() 都会
          // 走到这里，不 kill 就会真的泄漏一个 DSH 子进程。
          if (child.exitCode === null) {
            try { child.kill('SIGTERM'); } catch { /* 已经退出或不可 kill，忽略 */ }
          }
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
    const preflight = await this._request(worker, 'session/preflight', { sessionId: worker.sessionId }, this.preflightTimeoutMs);
    if (!isPreflightReady(preflight)) {
      throw new Error('session/preflight did not establish the required scoped tools and skill');
    }
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
    // §3.1 固定启动顺序在 supervisor 侧也必须成立：LIVE_STATUSES 把 'starting'
    // 算作"活着"（用于去重重复 open 请求），但 prompt 决不能抢在 initialize/
    // session-create/preflight 完成前把帧写进 stdin——否则顺序保证全押在子进程
    // 侧的 promptSession 断言上，供应链的这一端应该自己也 fail-closed。这里等
    // readyPromise 落定后重新判定，不假设"starting 之后必然是 ready"。
    if (worker.status === 'starting') {
      if (!worker.readyPromise) {
        const error = new Error('worker is not ready yet');
        error.code = 'worker_not_running';
        throw error;
      }
      await worker.readyPromise;
      if (worker.status !== 'ready') {
        const error = new Error('worker failed to become ready');
        error.code = 'worker_not_running';
        throw error;
      }
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

    const abortListener = () => worker._turnResolvers?.rejectTurn(new Error('turn cancelled'));
    controller.signal.addEventListener('abort', abortListener, { once: true });

    try {
      await this._request(worker, 'session/prompt', {
        sessionId: worker.sessionId,
        contentBlocks: [{ type: 'text', text }],
      }, 60_000);
      const timeout = timeoutPromise(this.turnTimeoutMs, 'turn timed out');
      try {
        await Promise.race([turnDone, timeout.promise]);
      } finally {
        timeout.cancel();
      }
      worker.status = 'ready';
      worker.emit('turn/end', { turnId, outcome: 'completed' });
      return { turnId };
    } catch (error) {
      // 超时、取消、turn 异常结束（非 completed 的 reason）都必须真正打断在飞
      // 的模型调用——cancelTurn() 上方注释已经解释过：rc.7 没有 turn 级取消
      // 协议，唯一手段是终止整个 worker 进程，防止一个已经判定失败的 turn
      // 之后还悄悄跑到 anqi_inbox_propose。之前这里只把 status 改回 ready、
      // 从不 abort/kill，导致超时后子进程继续跑，迟到的 running/idle/turn-end
      // 会被下一个 turn 的 resolver 误当成自己的完成事件（wire 事件不带 turn
      // id）。现在任何 turn 失败都统一走：本地 abort（立即生效）+ 终止整个
      // worker（异步收尾）。下一次 start() 必然是全新 session。
      if (!controller.signal.aborted) controller.abort(error);
      // 之前这里把 status 改回 'ready'（一个 LIVE 状态）之后才异步调用
      // this.stop()——stop() 内部有一次 shutdown 请求往返（最多 30s）加一次
      // 强杀等待（最多 10s），这段窗口里 worker.status 仍是 'ready'：
      //   (a) 已经排队、等在 worker.turnLock 后面的下一个 turn 会在这个窗口
      //       里被 prompt()/_runTurn 顶部的 LIVE 守卫放行，抢在 worker 真正
      //       终止前跑起来，继承上一个已判定失败的 turn 迟到的
      //       running/idle/turn-end（wire 事件不带 turn id，见上面注释）；
      //   (b) resolveApproval/resolveQuestion 的 LIVE_STATUSES 存活校验同样
      //       形同虚设，一条本该 fail-closed 的审批可以在这段窗口里被放行
      //       并真的写进已经判定失败的子进程 stdin。
      // 现在 turn 一旦判失败，在这一行同步、立即离开 LIVE_STATUSES（不等
      // stop() 的异步收尾），且立即清空 pendingInteractions——两处都不依赖
      // 之后才会触发的 exit/fatal 事件。
      if (LIVE_STATUSES.has(worker.status)) worker.status = 'stopping';
      this._expirePendingInteractions(worker, 'turn_failed');
      worker.emit('turn/end', { turnId, outcome: 'failed', reason: worker.redact(error.message) });
      this.stop(worker.caseId, `turn_failed:${worker.redact(error.message)}`.slice(0, 200)).catch(() => {});
      throw error;
    } finally {
      controller.signal.removeEventListener('abort', abortListener);
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
  //
  // 这里只 abort，不直接调用 stop()：abort 会经由 _runTurn 里挂的
  // abortListener 拒绝 turnDone，进而落进 _runTurn 自己的 catch 分支——那里
  // 统一处理"任何 turn 失败都终止 worker"，避免这里再重复调一次 stop()
  // 造成两次并发关闭（虽然 _finalizeWorker 本身幂等，但没必要制造竞态）。
  cancelTurn(caseId, reason = 'cancelled by user') {
    const worker = this.workers.get(caseId);
    if (!worker?.currentAbort) return false;
    worker.currentAbort.abort(new Error(reason));
    return true;
  }

  // ---- approval / user-question：one-shot、fail-closed ----
  // 两个方法都先查 worker 是否仍处于 LIVE_STATUSES：worker 一旦终态化
  // （stopped/crashed/error/disabled）就必须拒绝，不能让一条迟到的审批被写进
  // 一个已经死掉（或正在死掉窗口期）的子进程 stdin——见 §4「worker 已退出时
  // 返回拒绝」。仅凭 pendingInteractions 里还残留记录来判断是不够的：
  // _handleFatal 之前不落终态、不清表，留了一段可被 allow 的窗口。
  resolveApproval(caseId, interactionId, outcome) {
    const worker = this.workers.get(caseId);
    if (!worker || !LIVE_STATUSES.has(worker.status)) return { ok: false, reason: 'unavailable' };
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
    if (!worker || !LIVE_STATUSES.has(worker.status)) return { ok: false, reason: 'unavailable' };
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
      // 子进程可能在上面这次 await 期间就已经退出（exit 事件在 _wireChild
      // 注册的那个 listener 里被消费掉了）——'exit' 只会触发一次，这里如果
      // 无条件挂 `child.once('exit', r)` 会注册得太晚，永远等不到那个已经
      // 过去的事件，导致白白等满 10 秒才发现子进程早就没了。所以先查一次
      // 当前 exitCode，已经退出就不再挂新的 once 监听器。
      if (worker.child.exitCode === null) {
        const { promise, cancel } = timeoutPromise(10_000, 'shutdown wait timed out');
        try {
          await Promise.race([
            new Promise((r) => worker.child.once('exit', r)),
            promise,
          ]);
        } catch { /* 超时兜底 */ }
        cancel();
      }
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
      // method 本身也是子进程可控字段（wire 上任意字符串），之前只有 data
      // 走 redact()，method 原样透出——子进程把 key 值塞进 method 就能绕过
      // 「所有 wire 事件做 secret redaction」。
      worker.emit('notification', {
        method: worker.redact(String(message.method)),
        data: worker.redact(JSON.stringify(params)),
      });
      return;
    }
    if (params.sessionId !== worker.sessionId) return;
    const event = params.event || {};
    // event.type 同理是子进程可控字段；emit() 把它当成对外事件的 type 字段，
    // 必须先过 redact() 才能广播出去。注意下面 request/header / tool/call /
    // turn/end 的判断仍然用原始 event.type（未 redact），因为那是内部状态机
    // 比对，不是对外可见字段——两者互不影响。
    worker.emit(sanitizeEventType(worker.redact(String(event.type || 'session.event'))), this._redactEventData(worker, event.data));

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
      // rc.7 的 wire 形状：request/header 的 event.data = { header: EpochHeader,
      // reason }（@deepseek-ai/dsh-cordis-host-runner/lib/typert.host.js 的
      // 'request/header' 类型、@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js
      // 原样透传 session event）——tools 在 data.header.tools 而不是 data.tools。
      // 之前这里读的是 data.tools（恒为 undefined），门禁 4 在生产环境从未
      // 真正校验过 header 里的 MCP 工具，参考实现 driver.mjs 的
      // firstRequestHeader.header?.tools 才是正确路径。
      const requestHeader = worker._firstRequestHeader;
      const tools = requestHeader?.header?.tools;
      const ready = requestHeader?.reason === 'initial'
        && Array.isArray(tools) && tools.some((tool) => tool?.name === REQUIRED_MCP_TOOL)
        && worker._sawRequiredMcpCall === true;
      if (!ready) {
        // firstTurnChecked 只有在门禁真正通过之后才置 true——之前这里无条件
        // 置 true，一次失败的首个 turn 会让门禁对第二个 turn 永久失效（一次
        // 重试即可绕过）。现在失败分支不置位，且 _runTurn 的 catch 会因为
        // rejectTurn 而终止整个 worker（见上方 turn 失败统一处理），下一次
        // start() 必然是全新 worker/firstTurnChecked=false，双重保险。
        state.rejectTurn(new Error('first turn did not establish the required MCP tool readiness'));
        return;
      }
      worker.firstTurnChecked = true;
    }
    state.resolveTurn();
  }

  _redactEventData(worker, data) {
    try {
      return worker.redact.deep(data);
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
  // 两个 _enqueue* 都先校验 params.sessionId === worker.sessionId 再入表——
  // 之前是先 set 进 pendingInteractions、先 emit interaction/pending，只在
  // resolve 时才 fail-closed。结果是一条跨 session（不可能被任何合法调用方
  // 应答）的反向请求会先出现在 UI 待办里、占用 one-shot 表直到 TTL 才清理。
  // 现在会话不匹配时直接原地回 unavailable/rejected，不入表、不广播。
  _enqueueApproval(worker, message, params) {
    if (params.sessionId !== worker.sessionId) {
      this._writeChildResponse(worker, {
        jsonrpc: '2.0', id: message.id,
        result: { sessionId: params.sessionId, approvalId: params.approvalId, outcome: 'unavailable' },
      });
      return;
    }
    const interactionId = randomUUID();
    const expiresAt = Date.now() + this.interactionTtlMs;
    // toolName 存进 map 前就 redact：listPendingInteractions() 直接把这张表
    // 的字段吐给下阶段的 HTTP/UI 层，之前只在 emit('interaction/pending', ...)
    // 这一条路径上 redact，map 里存的仍是原值——子进程把 key 值塞进 toolName
    // 就能靠这条查询接口把它读出来，绕开 SSE 那条已经过滤的路径。
    const toolName = worker.redact(String(params.toolName || ''));
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
      toolName,
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
    worker.emit('interaction/pending', { interactionId, type: 'approval', toolName });
  }

  _enqueueQuestion(worker, message, params) {
    if (params.sessionId !== worker.sessionId) {
      this._writeChildResponse(worker, {
        jsonrpc: '2.0', id: message.id,
        error: { code: -32004, message: 'ask_user_question session mismatch' },
      });
      return;
    }
    const interactionId = randomUUID();
    const questions = Array.isArray(params.questions) ? params.questions : [];
    // id 仍然需要在回答时原样回传给子进程做匹配，不能整体丢弃；但
    // worker.redact() 只是"把已知 secret 值的出现替换成 [REDACTED]"的字符串
    // 变换，正常 id 不含 key 值时完全不受影响。只有子进程刻意把 key 值编码进
    // id（攻击场景）才会被替换掉——那种情况下外部应答者拿到的也只能是
    // [REDACTED]，回传时天然对不上原始 id，子进程侧会拒绝，是期望的
    // fail-closed 结果，不是误伤正常流程。
    const redactedQuestions = questions.map((q) => ({
      id: worker.redact(String(q?.id ?? '')),
      question: worker.redact(String(q?.question || '')),
    }));
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
      questions: redactedQuestions,
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

  // 未消费的反向请求一律 fail-closed、one-shot 清表，不留悬空 Promise——
  // _runTurn 判定 turn 失败、_handleFatal、_handleExit 三处共用同一份实现，
  // 避免各自维护一份"clearTimeout + emit + delete"逻辑而遗漏其中一处。
  _expirePendingInteractions(worker, reason) {
    for (const [interactionId, record] of worker.pendingInteractions) {
      clearTimeout(record.timer);
      worker.emit('interaction/expired', { interactionId, type: record.type, reason });
    }
    worker.pendingInteractions.clear();
  }

  _handleFatal(worker, error) {
    for (const entry of worker.pendingRpc.values()) entry.reject(error);
    worker.pendingRpc.clear();
    worker._turnResolvers?.rejectTurn(error);
    // 子进程 'error' 事件（或 stdout/stderr 读取失败）不保证紧跟着来一个
    // 'exit' 事件——中间可能有一段窗口子进程还没真正退出。不能指望只靠
    // _handleExit 来落终态/清 pendingInteractions：resolveApproval/
    // resolveQuestion 会在这段窗口里把一条本该 fail-closed 的审批放行给一个
    // 已经出故障的 worker。这里立刻让 worker 离开 LIVE_STATUSES 并清空未消费
    // 的反向请求；真正的 exit 事件到达后 _finalizeWorker 仍会按 code/signal
    // 落一次准确的最终状态（stopped/crashed），不冲突。
    if (LIVE_STATUSES.has(worker.status)) worker.status = 'error';
    this._expirePendingInteractions(worker, 'worker_fatal');
  }

  _handleExit(worker, code, signal) {
    this._handleFatal(worker, new Error(`worker exited (code=${code}, signal=${signal || 'none'})`));
    // _handleFatal 已经清过一次表；这里的 pendingInteractions 此时必然为空
    // （同一个事件循环 tick 内同步执行，没有新请求能在两次调用之间插入），
    // 调用只是为了在退出路径上留一个语义明确的收尾点，不会重复 emit。
    this._expirePendingInteractions(worker, 'worker_exit');
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
    // worker 一旦进入终态（graceful stop 或崩溃），它的 session_id 就不再是
    // 一个活的绑定——不注销的话，一个已经退出的 worker 的 session_id 仍能
    // 被拿去 /internal/agent-proposals 提交新提案，等于绕开了「案件 worker
    // 必须活着」这条隐含前提（设计稿 §3.2「重启只允许从新的 turn 开始」同一
    // 条精神）。
    unbindSession(worker.sessionId);
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
  requiredSkillName: REQUIRED_SKILL_NAME,
});
