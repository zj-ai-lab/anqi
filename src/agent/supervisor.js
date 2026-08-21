// DSH sidecar 进程外 worker 管理器（设计稿 §3）。
//
// 库化自 anqi-spike-dsh 的 driver.mjs：同一套 JSON-RPC 协议客户端逻辑（spawn →
// initialize → session/create → session/preflight → session/prompt →
// running/idle/turn-end 追踪 → shutdown），改造点是：
//   - driver.mjs 是"一次性 CLI，一个案件、一个 prompt、退出"；这里是长期library，
//     per-case 单 worker 注册表，turn 可以来一串、可以取消、worker 可以重启。
//   - driver.mjs 的 approval/user-question 用 CLI 参数配的静态策略（固定 reject
//     或固定答案）；这里没有 UI 层可以问人，所以把这两类反向 RPC 变成
//     one-shot pending 表——外部（src/routes/agent.js 的 HTTP 层）用 resolveApproval() /
//     resolveQuestion() 来喂答案，超时或未消费一律 fail-closed 到
//     rejected/unavailable，不因为没人应答就放行。
//   - 增加结构化事件管道：所有 wire 事件转发前做字段截断 + secret redaction，
//     再按 case 广播给订阅者（src/routes/agent.js 的 SSE 层的数据源）。
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
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
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

// ---- 打包模式路径解析（R2：runtime/assets 随包分发）----
// package.json 的 build.extraResources 把 src/agent/runtime 与 src/agent/assets
// 整棵复制到 Contents/Resources/agent-runtime/{runtime,assets}/（build.files 仍然
// 排除这两棵子树进 app 本体，两边不重复）。process.resourcesPath 在任何 Electron
// 进程（含主进程 fork() 出来、带 ELECTRON_RUN_AS_NODE=1 的 server.js 子进程）里
// 都存在，但 dev 模式（`electron .` 未打包，或压根没有 Electron 的纯
// `node server.js`）下这个目录并不存在——不能只判断 process.resourcesPath 是否
// 定义（dev 模式下 Electron 进程也总有一个指向 Electron.app 自带 Resources 的
// resourcesPath，只是没有我们这棵子树），必须实测目录是否真的在那——存在就是
// 打包模式，优先用它；不存在（含目录判断本身抛错）一律回退仓库路径
// __dirname/{runtime,assets}，与之前的 dev 行为完全一致。
function resolveAgentSubdir(name) {
  const packagedDir = process.resourcesPath
    ? path.join(process.resourcesPath, 'agent-runtime', name)
    : null;
  try {
    if (packagedDir && existsSync(packagedDir)) return packagedDir;
  } catch {
    // existsSync 理论上不抛，防御性兜底：任何异常都视为"打包目录不可用"，回退仓库路径。
  }
  return path.join(__dirname, name);
}

const ASSETS_DIR = resolveAgentSubdir('assets');
const RUNTIME_DIR = resolveAgentSubdir('runtime');

// 是否正在用打包目录（Contents/Resources/agent-runtime/assets），而不是仓库
// 路径——下面 ensureAssetsNodeModulesLink() 需要用它来决定"能不能在这棵目录
// 里写东西"：打包目录是已签名 app 资源树的一部分（hardenedRuntime +
// ad-hoc/正式签名，build/adhoc-sign.cjs 的 codesign --deep 会把当时目录里的
// 一切都封进签名），运行时再写入/改动任何一个文件都会撕开 codesign
// --verify --deep --strict 的资源封条（"a sealed resource is missing or
// invalid"）——这不是权限问题（目录本身在磁盘上仍然可写），是签名完整性
// 问题，权限允许写不代表允许写。
const AGENT_DIR_IS_PACKAGED = ASSETS_DIR !== path.join(__dirname, 'assets');
const CORDIS_CONFIG = path.join(ASSETS_DIR, 'anqi.cordis.yml');
const DSH_BIN = path.join(
  RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-demo', 'lib', 'bin.js'
);
const TRUSTED_SKILLS_ROOT = path.join(ASSETS_DIR, 'skills');
const REQUIRED_SKILL_NAME = 'anqi-case-brief';
const REQUIRED_SKILL_FILE = path.join(TRUSTED_SKILLS_ROOT, REQUIRED_SKILL_NAME, 'SKILL.md');

// ---- assets/node_modules：运行时确保，不再依赖提交进 git 的符号链接 ----
// cordis 加载的插件（plugins/dsh-anqi、plugins/dsh-anqi-jsonrpc）与
// mcp/server.mjs 都用 `import '@deepseek-ai/...'` 这类 ESM 说明符；子进程
// spawn 时 cwd 钉死为 ASSETS_DIR（见 start() 里的 spawnFn 调用），Node 的模块
// 解析会从这个 cwd 开始逐级向上找 node_modules——依赖实际装在
// src/agent/runtime/node_modules（该目录本身从不进仓库：根 .gitignore 的
// `node_modules/` 规则本来就会忽略它，是 src/agent/runtime/package.json 自己
// 的一次 npm install 产出），所以 assets 目录下必须有一条指向它的
// node_modules 链接，ESM 解析才找得到这些依赖（NODE_PATH 环境变量只影响
// CommonJS require() 的搜索路径，对 ESM import 说明符解析完全不生效，不能
// 用它替代这条链接）。
//
// 这条链接在 dev 模式下之前是直接提交进仓库的符号链接对象（git 记录一个
// 120000 类型的 blob，内容是相对路径 "../runtime/node_modules"）——问题是它
// 指向的目标从不进仓库，任何全新 clone 在跑 runtime 自己那次 npm install 之
// 前，这条提交进仓库的链接天然是悬空的。现在改成 supervisor 在每次 start()
// 真正 spawn 子进程之前运行时确保：链接不存在就创建，存在但指向不对就重
// 建，指向已经正确就什么都不做——不再依赖 git 树里那个提交的对象。
//
// 打包模式下不能用同一套"运行时确保"：ASSETS_DIR 这时候指向已签名 app 资源
// 树里的 Contents/Resources/agent-runtime/assets（见上面 AGENT_DIR_IS_PACKAGED
// 的注释），start() 每次都无条件尝试在这里创建/重建符号链接，会在应用签名
// 完成后持续修改一份已被 codesign --deep 封存的资源目录——首次触发就把
// codesign --verify --deep --strict 从 valid 变成 "a sealed resource is
// missing or invalid"（真实复现：打包冒烟第一次跑 AI 助理之后，重新校验
// 签名当场报这个错）。这条链接现在改为构建期建好并随 build/adhoc-sign.cjs
// 的 --deep 重签一并封进签名（见 build/afterpack-agent-runtime-link.cjs，
// package.json 的 build.afterPack 钩子，在 afterSign 之前运行）——打包模式
// 下这里只做只读校验，链接不存在或指向不对直接报错（不静默、也不在运行时
// 尝试自愈写入，写入本身就是问题所在）。
const ASSETS_NODE_MODULES_LINK = path.join(ASSETS_DIR, 'node_modules');
const RUNTIME_NODE_MODULES_DIR = path.join(RUNTIME_DIR, 'node_modules');

function resolvedSymlinkTarget(linkPath) {
  let target;
  try {
    target = readlinkSync(linkPath);
  } catch {
    return null;
  }
  return path.resolve(path.dirname(linkPath), target);
}

function ensureAssetsNodeModulesLink() {
  if (AGENT_DIR_IS_PACKAGED) {
    // 只读校验，绝不写入已签名资源树——见上方大段注释。
    let currentStat;
    try {
      currentStat = lstatSync(ASSETS_NODE_MODULES_LINK);
    } catch (error) {
      throw new Error(
        `打包资源里缺少 agent-runtime/assets/node_modules 链接（${ASSETS_NODE_MODULES_LINK}）——`
        + `构建期的 afterPack 钩子（build/afterpack-agent-runtime-link.cjs）应该已经建好这条链接`
        + `并随签名一起封存，缺失说明打包流程本身有问题，不应该在运行时补建`,
        { cause: error },
      );
    }
    if (!currentStat.isSymbolicLink()) {
      throw new Error(`打包资源里 ${ASSETS_NODE_MODULES_LINK} 不是符号链接（意外条目）`);
    }
    const resolvedCurrent = resolvedSymlinkTarget(ASSETS_NODE_MODULES_LINK);
    if (resolvedCurrent !== RUNTIME_NODE_MODULES_DIR) {
      throw new Error(
        `打包资源里 ${ASSETS_NODE_MODULES_LINK} 指向 ${resolvedCurrent ?? '(无法解析)'}，`
        + `与期望的 ${RUNTIME_NODE_MODULES_DIR} 不一致`,
      );
    }
    return;
  }

  let currentStat;
  try {
    currentStat = lstatSync(ASSETS_NODE_MODULES_LINK);
  } catch {
    currentStat = null;
  }
  if (currentStat) {
    if (!currentStat.isSymbolicLink()) {
      // 不是符号链接的意外条目（例如有人手误在这里放了一个真实目录/文件）
      // ——不静默覆盖调用方可能有意放置的东西，原地报错交给 start() 的
      // catch 分支转成 error 状态。
      throw new Error(`unexpected non-symlink entry at ${ASSETS_NODE_MODULES_LINK}`);
    }
    const resolvedCurrent = resolvedSymlinkTarget(ASSETS_NODE_MODULES_LINK);
    if (resolvedCurrent === RUNTIME_NODE_MODULES_DIR) return; // 已经指对了
    rmSync(ASSETS_NODE_MODULES_LINK, { force: true });
  }
  symlinkSync(RUNTIME_NODE_MODULES_DIR, ASSETS_NODE_MODULES_LINK, 'dir');
}

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
// `data/` 规则覆盖，不需要额外忽略规则。这个默认值只对"裸 node server.js 跑
// 在仓库里"（dev、Docker、tools/check.sh）成立——__dirname 在 Electron 打包后
// 解析进 Contents/Resources/app/src/agent，同一相对路径会把 session
// transcript 写进已签名的 app 资源树本体。真正的桌面版路径由
// electron/main.js 的 startBackend() 把 ANJIAN_AGENT_SESSION_ROOT 设成
// dataDir 下的目录，server.js 构造 AgentSupervisor 时读这个环境变量传进
// sessionRoot；未设置时才落回这里的默认值，构造函数签名见下方
// constructor 的 sessionRoot 参数默认值。
const DEFAULT_SESSION_ROOT = path.join(__dirname, '..', '..', 'data', 'agent-sessions');

const TERMINAL_STATUSES = new Set(['stopped', 'crashed', 'error', 'disabled']);
const LIVE_STATUSES = new Set(['starting', 'ready', 'running']);
const APPROVAL_EXTERNAL_OUTCOMES = new Set(['allowed-once', 'rejected']);

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 90_000;
const DEFAULT_INTERACTION_TTL_MS = 2 * 60 * 1000;
const MAX_EVENT_FIELD_CHARS = 4000;
// redactDeep 的总量兜底：逐叶子限长只保证单个字符串字段不超过
// MAX_EVENT_FIELD_CHARS，但一个事件可以有成千上万个叶子（例如工具结果里一
// 个超长数组，每个元素都是几百字符的短字符串）——探针曾用这种形状产出过一
// 条 1.56MB 的单事件，逐叶子限长对此完全没有约束力。这里加三道总量闸门：
// 一是叶子内容字节预算（对象 key 名与数字/布尔/null 叶子也计入，不只是字符
// 串叶子——否则 {k0..k99999: 1} 这种"key 多但 value 是数字"的形状能完全绕
// 开预算，探针复现过 1MB+ 的这类单事件；深度超限/预算耗尽后返回的占位符本
// 身也计入，避免深层嵌套结构靠"零成本占位符"指数级放大输出），二是单个数
// 组允许保留的元素个数上限，三是单个对象允许保留的 key 个数上限（否则对象
// 没有类似数组的条目数上限，key 数量可以无限堆）。任何一道触顶，超出部分直
// 接折叠成一条 "[truncated N items/keys]" 标记，不再逐项处理。
//
// 注意：MAX_EVENT_TOTAL_BYTES 是"叶子内容字节 + 容器自身的方括号/花括号"
// 预算，不是序列化后 JSON 文本的精确字节数——数组/对象内部逐元素之间的逗号、
// 对象 key 两侧的引号与冒号这些分隔符开销仍不计入（每个容器只按自身一对
// "[]"/"{}" 记 2 字节，元素越多不代表分隔符开销线性计入预算）。对宽而浅的
// 短数字叶子（如 6~7 位数字组成的大数组），实测折叠后的序列化体积大约落在
// 预算的 1.1~1.3 倍之间（tools/test-agent-supervisor.js 场景 16b/16d 实测），
// 不存在一个能覆盖所有输入形状的固定倍数。这里把它当成一个近似的成本刹车、
// 不是"单条事件序列化后 ≤ 256KB"的精确硬上限，调用方不应依赖后者。
const MAX_EVENT_TOTAL_BYTES = 256 * 1024;
const MAX_EVENT_ARRAY_ITEMS = 200;
const MAX_EVENT_OBJECT_KEYS = 200;
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

function byteLength(str) {
  return Buffer.byteLength(str, 'utf8');
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
//
// 但逐叶子限长只约束"单个字符串"，约束不了"叶子数量"——一个几千元素的数
// 组，每个元素都是几百字符的短字符串，逐叶子检查全部合规，序列化后的整个
// 事件依然可以轻松几百 KB 到几 MB（探针曾复现过 1.56MB 的单事件）。这里加
// 三道总量闸门，跨递归调用共享同一份可变预算 `budget`（同一次 .deep() 调用
// 的所有叶子共用，不是每个叶子各自开一份）：
//   - budget.remaining：整个结构累计消耗的字节数，字符串叶子、对象 key 名、
//     数字/布尔/null 叶子都按各自序列化后的字节数扣减（不止字符串叶子——
//     否则一个几十万条数字叶子的宽对象可以完全绕开预算），容器本身（数组/
//     对象）进入时也先扣自身 "[]"/"{}" 的 2 字节结构开销，空容器不例外——
//     否则一个"每层 200 分支、深度 3、叶子是空容器"的结构，几百万个空数组/
//     空对象叶子全部零消耗，同样能完全绕开预算（tools/test-agent-
//     supervisor.js 场景 16e 复现）。触顶后后续叶子一律折叠成占位符，不再
//     继续递归展开；
//   - MAX_EVENT_ARRAY_ITEMS：单个数组保留的元素个数上限，超出的元素不逐个
//     处理，整体折叠成一条 `[truncated N items]` 标记；
//   - MAX_EVENT_OBJECT_KEYS：单个对象保留的 key 个数上限，超出的 key 不逐
//     个处理，整体折叠成一条 `[truncated]: "N more keys"` 标记。
function redactDeep(value, secretValues, budget, depth = 0) {
  // 这两条早退此前直接 return 占位符、一个字节都不扣预算——对深度超限这条
  // 尤其致命：一个 3 叉 9 层的嵌套数组，第 9 层每个数字叶子都在此处被替换成
  // 20 字节的 "[REDACTED:max-depth]"，替换次数随分支数指数增长，探针复现过
  // 59KB 输入放大成 472KB 输出（8x）、预算全程未触发一次。现在两条占位符也
  // 按自身字节数扣预算，口径与字符串/数字叶子一致，触顶后同样不再继续展开。
  if (depth > 8) {
    const marker = '[REDACTED:max-depth]';
    budget.remaining -= byteLength(marker);
    return marker;
  }
  if (budget.remaining <= 0) {
    const marker = '[REDACTED:budget-exceeded]';
    budget.remaining -= byteLength(marker);
    return marker;
  }
  if (typeof value === 'string') {
    const redacted = redactString(value, secretValues);
    budget.remaining -= byteLength(redacted);
    return redacted;
  }
  if (Array.isArray(value)) {
    // 容器自身的结构字节（"[" + "]"）必须先扣一次，空数组也不例外——之前
    // 空数组叶子（value.length === 0）走到这里 keep=0、循环不执行、
    // kept(0) 不小于 value.length(0) 不触发截断标记，整条分支零消耗返回
    // []，跟原语叶子一样可以被当成"零成本占位符"批量堆叠：一个"每层 200
    // 分支、深度 3、叶子是空容器"的结构，8,000,000 个空数组叶子全部零计
    // 费，字节预算从未触发，序列化后的真实输出体积可以达到预算的数十倍
    // （tools/test-agent-supervisor.js 场景 16e 复现）。这里按 JSON 文本
    // 里 "[]" 的固定 2 字节记账，无论数组是否为空、无论内容占多少字节都
    // 会先扣这 2 个字节，堵住"空容器免费"这条路。
    budget.remaining -= 2;
    const keep = Math.min(value.length, MAX_EVENT_ARRAY_ITEMS);
    const out = [];
    let kept = 0;
    for (; kept < keep; kept++) {
      if (budget.remaining <= 0) break;
      out.push(redactDeep(value[kept], secretValues, budget, depth + 1));
    }
    if (kept < value.length) {
      const marker = `[truncated ${value.length - kept} items]`;
      budget.remaining -= byteLength(marker);
      out.push(marker);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    // 同上：对象自身的结构字节（"{" + "}"）先扣 2 字节，空对象（{}）同样
    // 不再零成本——"空对象叶子"与"空数组叶子"是同一类旁路，堵法一致。
    budget.remaining -= 2;
    // 对象的 key 名本身来自子进程、同样可能被用来夹带 secret 值——之前这里
    // 只对 value 递归脱敏，key 原样透传（`out[key] = ...`），等于给
    // redactDeep 留了一条不脱敏的旁路：子进程把 apiKeyValue 塞进任意键名就
    // 能整条穿透到 SSE 帧（value 侧被 [REDACTED]、key 侧明文出街）。现在 key
    // 也过 redactString，并把 key 的字节数计入预算；同时对象的 key 数量也
    // 设上限（对齐数组的 MAX_EVENT_ARRAY_ITEMS——之前对象没有任何条目数上
    // 限，配合下面"数字/布尔/null 叶子也计费"，堵住"几十万个数字叶子的
    // 宽对象完全绕开总量预算"这条路，探针曾用这种形状复现过 1MB+ 的单事件）。
    const entries = Object.entries(value);
    const keep = Math.min(entries.length, MAX_EVENT_OBJECT_KEYS);
    const out = {};
    let kept = 0;
    for (; kept < keep; kept++) {
      if (budget.remaining <= 0) break;
      const [key, item] = entries[kept];
      const redactedKey = redactString(String(key), secretValues);
      budget.remaining -= byteLength(redactedKey);
      out[redactedKey] = redactDeep(item, secretValues, budget, depth + 1);
    }
    if (kept < entries.length) {
      const marker = `${entries.length - kept} more keys`;
      budget.remaining -= byteLength(marker);
      out['[truncated]'] = marker;
    }
    return out;
  }
  // number/boolean/null 等原语叶子本身不含 secret、无需脱敏，但序列化后仍
  // 占字节——之前这里零消耗，一个几十万条数字叶子的对象可以完全绕开总量预
  // 算（探针复现过 1,088,900 字节的单事件，预算 262,144 完全没触发）。这里
  // 按其 JSON 文本形式的字节数扣减，口径与字符串叶子一致。
  budget.remaining -= byteLength(String(value));
  return value;
}

function redactor(secretValues) {
  const values = secretValues.filter(Boolean);
  const fn = (input) => redactString(input, values);
  fn.deep = (data) => redactDeep(data, values, { remaining: MAX_EVENT_TOTAL_BYTES });
  return fn;
}

// 对外事件的 `type` 字段最终会成为 SSE 层（src/routes/agent.js）的 `event:` 字段名（见文件头
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

// 事件命名空间隔离（R-M2）：supervisor 自己产生的生命周期事件（worker/ready、
// turn/start、turn/end、interaction/pending、interaction/expired、worker/exit、
// stderr、protocol-error、notification）与子进程 wire 侧上报的 session.event
// 事件共用同一条 emit() → SSE 广播通路，但 `type` 字段的可信度完全不同：前者
// 的 type 是宿主代码里的字面量，后者的 type 是子进程 wire 消息里的自由字符串
// （只做过 sanitizeEventType 的控制字符清洗与长度截断，没有做过"不得和宿主保
// 留名重名"的检查）。一个被攻破/行为异常的子进程完全可以在 session.event 里
// 塞一条 `type:'interaction/pending'`，靠这个撞名让前端把它误当成宿主发出的
// 真实审批待办卡片——即便 data 字段本身已经过 redact，`type` 撞名本身就是一
// 次可以骗过前端渲染逻辑的伪造。这里给两条来源分别打上 origin 标记，并且只
// 有 wire 侧的 type 在撞上 supervisor 保留名时才会被强制加前缀重写成
// `wire/<type>`（supervisor 侧永远是这些字面量本身，不需要、也不会被重写）。
// 'status' 也在保留名之列：它不是本文件 Worker.emit() 出来的字面量（那些已
// 经在这张表里），而是 SSE 路由层（src/routes/agent.js）在连接建立/重连时
// 单独 send('status', supervisor.publicStatus(caseId)) 下发的宿主快照帧名——
// 但它同样是"前端不校验 origin 就信"的可信帧名（真快照顶层没有 origin/data
// 包装，见路由层注释），子进程一样能靠 session.event 里塞 type:'status' 撞
// 名，把伪造的状态（例如 status:'crashed'）当成宿主快照喂给前端，锁死整个
// 抽屉。和其它九个保留名同等对待，撞名一律重写成 wire/status。
const SUPERVISOR_RESERVED_EVENT_TYPES = new Set([
  'worker/ready', 'turn/start', 'turn/end', 'stderr', 'protocol-error',
  'notification', 'interaction/pending', 'interaction/expired', 'worker/exit',
  'status',
]);

function namespaceWireEventType(type) {
  return SUPERVISOR_RESERVED_EVENT_TYPES.has(type) ? `wire/${type}` : type;
}

// 一个案件 worker 的完整生命周期：spawn → initialize → session/create →
// session/preflight → 一串串行 turn → stop/crash。
class Worker {
  // dispatch: (event) => void——由 supervisor 传入、绑定了 caseId 的广播函数。
  // Worker 自己不持有订阅者集合：onEvent() 的监听器登记在 supervisor 层
  // （caseId 维度，见 AgentSupervisor.listeners），不挂在某一次 Worker 实例
  // 上——worker 重启（崩溃/被 stop 后重新 start）是全新的 Worker 实例，若监听
  // 器挂在实例上就会被孤儿化，SSE 连接从此永久收不到任何后续事件；且如果
  // onEvent() 在 worker 尚未创建时调用（浏览器先连 events、再点启动的自然顺
  // 序），挂在实例上的写法会直接返回一个假的空订阅，整条下行通路形同虚设。
  constructor(caseId, caseName, sessionId, dispatch) {
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
    this.dispatch = dispatch;
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

  // origin 区分事件的可信来源：'supervisor'（宿主代码自己 emit 的生命周期
  // 事件，type 是字面量，可信）与 'wire'（转发自子进程 session.event 的
  // type，只是清洗过控制字符/长度，不代表内容可信——见上方
  // SUPERVISOR_RESERVED_EVENT_TYPES 的注释）。调用方不传时默认 'supervisor'，
  // 因为绝大多数 emit() 调用点都是宿主自己的生命周期事件；唯一的 wire 转发点
  // （_handleNotification 里的 session.event 分支）显式传 'wire'。
  emit(type, data, origin = 'supervisor') {
    const event = { type, caseId: this.caseId, sessionId: this.sessionId, at: nowIso(), origin, data };
    this.dispatch(event);
  }
}

export class AgentSupervisor {
  constructor({
    filesRoot = process.env.ANJIAN_FILES_ROOT,
    internalKeyEnv = process.env.ANQI_INTERNAL_KEY_ENV || 'ANJIAN_INTERNAL_KEY',
    // 纯粹的构造期兜底猜测：server.js 在 httpServer.listen() 的回调里、确认
    // 实际监听 host/port 之后，会立刻调用 setInternalBaseURL() 用真实值纠正
    // 这里的默认值（见该文件 gracefulShutdown 上方注释与 setInternalBaseURL()
    // 的说明）——真正生效的值从不是这个默认值。此前这里读一个
    // ANQI_AGENT_BASE_URL 环境变量当默认值，但仓库里没有任何地方（Dockerfile/
    // electron/main.js/文档）设置过这个变量，且即使设置了也会在 listen 回调
    // 里被无条件覆盖，是一条从未生效过的死配置通路——这里直接去掉，只保留字面
    // 量默认值，避免误导（以为设置这个环境变量能改变实际使用的 base URL）。
    internalBaseURL = 'http://127.0.0.1:3007',
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
    this.listeners = new Map(); // caseId -> Set<listener>，与 worker 生命周期解耦（见 Worker 类注释）
    this.stopPromises = new Map(); // caseId -> 在飞的 stop() Promise，见 start()/stop() 的互斥说明
    this.startPromises = new Map(); // caseId -> 在飞的 start() 互斥 Promise，见 start()/_startWorker() 的互斥说明
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

  // 对外（HTTP/SSE）安全的状态投影：status() 本身仍保留 sessionId/cwd/pid
  // 供 supervisor 内部与反查逻辑使用，但案件 drawer UI（设计稿 §5：状态徽标/
  // 有限 assistant 文本/工具摘要/可展开错误/proposal 卡片）并不需要内部会话
  // 绑定标识或宿主机绝对路径——这两处一旦通过 HTTP/SSE 下发就没有必要地扩
  // 大了暴露面（虽然 session→case 的权限判断由服务端反查覆盖，不是靠隐藏
  // sessionId 兜底，但没有理由顺手带出去）。
  publicStatus(caseId) {
    const full = this.status(caseId);
    return {
      status: full.status,
      caseId: full.caseId,
      caseName: full.caseName,
      dshVersion: full.dshVersion,
      startedAt: full.startedAt,
      provider: full.provider,
      model: full.model,
      error: full.error,
      exitInfo: full.exitInfo,
      // 案件 assistant drawer 需要在「打开抽屉/刷新页面」这一刻就看到已经在
      // 等待人工应答的 approval/question——不这样做的话，抽屉只能靠后续
      // 恰好广播的 interaction/pending 事件才知道有交互待办，一个在 SSE
      // 订阅建立之前就已经挂起的交互会被永久错过（与上面 dshVersion 等字段
      // 同理：SSE 首帧补的正是这份 publicStatus() 快照）。listPendingInteractions()
      // 已经是脱敏过的对外投影（见该方法与场景 7 的测试），这里直接复用，不
      // 重新实现一份过滤逻辑。
      pendingInteractions: this.listPendingInteractions(caseId),
    };
  }

  // 供路由层复用的权威"活着"判断——不要在 supervisor 之外复刻 LIVE_STATUSES
  // 字面量集合：那样一旦这里新增/调整存活态，路由层的前置门禁就可能与真正
  // 的判断分叉（能启动但发不出 prompt，或反之）。
  isLive(caseId) {
    const worker = this.workers.get(caseId);
    return !!worker && LIVE_STATUSES.has(worker.status);
  }

  onEvent(caseId, listener) {
    let set = this.listeners.get(caseId);
    if (!set) {
      set = new Set();
      this.listeners.set(caseId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(caseId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(caseId);
    };
  }

  // Worker.emit() 最终都经这里广播——监听器登记在 supervisor 层，不挂在某一
  // 次 Worker 实例上，因此：(a) onEvent() 可以在 worker 尚未创建时提前订阅，
  // 不会静默丢事件；(b) worker 崩溃/被 stop 后重新 start() 出一个全新实例，
  // 已建立的订阅依然能收到新实例广播的事件，不会被孤儿化。
  _dispatch(caseId, event) {
    const set = this.listeners.get(caseId);
    if (!set) return;
    for (const listener of set) {
      try { listener(event); } catch { /* 订阅者自己的错误不影响广播 */ }
    }
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
      //
      // existing.readyPromise 是 _runStartupSequence 那次调用产生的、早就已
      // 经 settle 过的 Promise——它 resolve 的值是"启动刚成功那一刻"拍下的
      // status() 快照（那时 worker.status 恰好是 'ready'）。之前这里直接把
      // 这个旧 Promise 原样返回：调用方等到的永远是那张冻结快照，哪怕此刻
      // worker 早已经进入 'running'（正在跑 turn）甚至已经变化多次，drawer
      // 重新打开时看到的 status 也会一直是当初刚 ready 那一秒的旧值。现在改
      // 成在这个（早已 settle 的）Promise 后面再接一次 `.then(() =>
      // this.status(caseId))`——resolve 几乎立即发生，但重新调用 status()
      // 取的是"这次调用当下"的真实快照，不是历史缓存值。worker 仍在
      // 启动中（readyPromise 还没 settle）时，这一样正确：等它 settle 后再
      // 取一次当下状态，而不是直接假设"settle 之后就是 ready"。
      return existing.readyPromise
        ? existing.readyPromise.then(() => this.status(caseId))
        : this.status(caseId);
    }

    // 互斥：下面 _startWorker() 里"等在飞 stop() 落定"到"workers.set() 完成
    // spawn"之间隔着好几个 await（db 查询、skill 根校验/隔离拷贝、runtime
    // link 确保……），而这一段中途 this.workers 里对该 caseId 要么还是旧的
    // 'stopping' worker、要么暂时为空，上面 existing/LIVE_STATUSES 那次判断
    // 挡不住第二个并发 start()。以前这里没有互斥：'stopping' 窗口内两个
    // start() 会双双越过等待点各自 spawn 出一个 worker，后跑完的那个把先跑
    // 完、甚至已经 ready 的那个从 this.workers 顶掉——被顶掉的 worker 既不
    // 在 workers 表里也从未被 _finalizeWorker 收尾：子进程永远不会被
    // stopAll()/forceKillAll() 够到，它绑定的 sessionId 在 caseIdForSession()
    // 里依然查得到（可以永远拿去打 /internal/agent-proposals），0700 临时
    // skill 目录也永久泄漏。现在同一 caseId 的 start() 全部 join 同一个
    // in-flight promise，任意时刻只有一次真正的启动序列在跑。
    const inFlightStart = this.startPromises.get(caseId);
    if (inFlightStart) return inFlightStart;

    const startPromise = this._startWorker(caseId);
    this.startPromises.set(caseId, startPromise);
    try {
      return await startPromise;
    } finally {
      if (this.startPromises.get(caseId) === startPromise) this.startPromises.delete(caseId);
    }
  }

  async _startWorker(caseId) {
    // 同一案件的上一个 worker 可能正在 stop()（异步、最多 30s shutdown 往返
    // + 10s 强杀等待）——'stopping' 不在 LIVE_STATUSES 里，start() 顶部那个
    // 判断会直接放过，走到下面重新 spawn 一个全新 worker，而旧 worker 的子
    // 进程可能还没真正退出：两个活子进程同时挂在同一个 caseId 名下，违反
    // "每案最多一个 active worker"。这里先等在飞的 stop() 完成——它落定之
    // 后旧 worker 必然已经终态化（_finalizeWorker 已跑过），再往下走的
    // spawn 是安全的。start() 顶部的互斥保证同一时刻只有一次 _startWorker
    // 在执行，所以这里不必再担心被另一个并发 start() 抢跑。
    const inFlightStop = this.stopPromises.get(caseId);
    if (inFlightStop) await inFlightStop;

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

    // 3.5) assets/node_modules 运行时确保（见 ensureAssetsNodeModulesLink()
    //      顶部注释）——必须在 spawn 之前做，否则子进程起来也会立刻因为
    //      ESM 说明符解析失败而崩，且这一步失败不该留下一份刚拷好、之后
    //      永远不会被清理的临时 skill 目录，所以失败分支要先清掉它。
    try {
      ensureAssetsNodeModulesLink();
    } catch (error) {
      rmSync(materializedSkillsRoot, { recursive: true, force: true });
      audit(this.actor, 'agent-start-fail', 'agent-worker', caseId, `runtime_link_invalid:${error.message}`.slice(0, 200));
      return { status: 'error', caseId, error: 'runtime_link_invalid' };
    }

    const sessionId = `anqi-${randomUUID()}`;
    // 设计稿 §2/§4：session→case 绑定必须在 supervisor 侧登记，/internal/
    // agent-proposals 等路由才能按 session_id 反查、不再信任请求体里的
    // case_id。在 spawn 之前登记，保证子进程第一次能发起 HTTP 请求时绑定
    // 已经存在，不留任何"session 已注入子进程但服务端还查不到"的窗口。
    bindSession(sessionId, caseId);
    const worker = new Worker(caseId, caseRow.name, sessionId, (event) => this._dispatch(caseId, event));
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
      // 会被下一个 turn 的 resolver 误当成自己的完成事件——带 turn id 的只是
      // 一部分 session.event 子类型（权威定义见 runtime 依赖里的
      // @deepseek-ai/dsh-cordis-host-runner/lib/typert.host.js 的
      // SessionEventMap，本注释第三次修订、逐条核对过完整类型表，以下两侧均
      // 已穷举，不再是抽样枚举）：带 event.data.turn 的是 turn/start、
      // turn/end、step/start、step/end、assistant/chunk、assistant/message、
      // tool/call、tool/result 这八种（即 turn/*、step/*、assistant/*、
      // tool/call、tool/result）；不带的除 session.status 通知（running/idle
      // 就来自这里）外，还有 request/header、request/context、todo/write、
      // user/message、approval/asked、approval/decided、approval/policy（即
      // approval/*）、tool/code-dispatch-start、tool/code-dispatch、
      // goal/change、command/run、command/done、session/end-seed、
      // agent/inbox/spliced——不是"只有 status 不带"这么整齐。但宿主侧目前就
      // 是靠 worker._turnResolvers
      // 这一个单槽位状态机匹配 running/idle/turn-end，不按 turn id 区分，所以
      // 同一个槽位依旧会把迟到事件误记成"当前"turn 的。现在任何 turn 失败都
      // 统一走：本地 abort（立即生效）+ 终止整个
      // worker（异步收尾）。下一次 start() 必然是全新 session。
      if (!controller.signal.aborted) controller.abort(error);
      // 之前这里把 status 改回 'ready'（一个 LIVE 状态）之后才异步调用
      // this.stop()——stop() 内部有一次 shutdown 请求往返（最多 30s）加一次
      // 强杀等待（最多 10s），这段窗口里 worker.status 仍是 'ready'：
      //   (a) 已经排队、等在 worker.turnLock 后面的下一个 turn 会在这个窗口
      //       里被 prompt()/_runTurn 顶部的 LIVE 守卫放行，抢在 worker 真正
      //       终止前跑起来，继承上一个已判定失败的 turn 迟到的
      //       running/idle/turn-end（同上：宿主侧按单槽位而非 turn id 匹配，
      //       见上面注释）；
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

  // 只读反查：interactionId（supervisor 生成的随机 UUID，one-shot，只在其
  // 所属 worker 的 pendingInteractions 表里存在）属于哪个 case/worker。
  // 设计稿 §4「服务端从已存的 session binding 取得 case/agent，不信任客户端
  // 提交的 case/cwd」在 HTTP 层的落地——answer 路由只收到不透明的
  // interactionId，绝不接受调用方自报的 case_id；这里扫描全部存活 worker
  // （数量=案件数，读操作，代价可忽略）来确定归属，找不到就是找不到，不
  // 兜底猜测。
  findInteractionOwner(interactionId) {
    if (typeof interactionId !== 'string' || !interactionId) return null;
    for (const worker of this.workers.values()) {
      if (worker.pendingInteractions.has(interactionId)) {
        return { caseId: worker.caseId, worker, record: worker.pendingInteractions.get(interactionId) };
      }
    }
    return null;
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
  // 同一个 caseId 的 stop() 全程只跑一份在飞 Promise——供 start() 在 spawn
  // 新 worker 之前先等它落定（见 start() 里对 stopPromises 的检查），避免
  // "上一个 worker 还没真正终止、下一个 worker 已经 spawn 出来"这条"每案
  // 最多一个 active worker"红线的破口；也让并发调用 stop() 本身天然去重
  // （第二个调用者拿到同一个 Promise，不会对同一个 worker 重复跑一遍
  // shutdown 往返/强杀等待）。
  async stop(caseId, reason = 'requested') {
    const existingStop = this.stopPromises.get(caseId);
    if (existingStop) {
      await existingStop;
      return this.status(caseId);
    }
    const worker = this.workers.get(caseId);
    if (!worker) return { status: 'stopped', caseId };
    const stopPromise = this._stopWorker(worker, reason);
    this.stopPromises.set(caseId, stopPromise);
    try {
      await stopPromise;
    } finally {
      this.stopPromises.delete(caseId);
    }
    return this.status(caseId);
  }

  async _stopWorker(worker, reason) {
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
  }

  async stopAll(reason = 'server shutdown') {
    await Promise.allSettled([...this.workers.keys()].map((caseId) => this.stop(caseId, reason)));
  }

  // 优雅关闭总时限跑满时的兜底：不再等待逐个 stop() 的完整流程（最坏
  // 30s shutdown RPC 往返 + 10s 强杀等待），直接对所有仍存活的子进程发
  // SIGKILL——server.js 的 gracefulShutdown() 给 stopAll() 套了一个总时限的
  // Promise.race，跑满之后必须还有这一步真正兜底，否则 httpServer 关闭/
  // 进程退出之后这些 worker 会变成脱离 supervisor 掌控的孤儿进程。
  forceKillAll() {
    for (const worker of this.workers.values()) {
      if (worker.child && worker.child.exitCode === null) {
        try { worker.child.kill('SIGKILL'); } catch { /* 已退出或不可 kill，忽略 */ }
      }
    }
  }

  // server.js 在 httpServer.listen() 的回调里、确认实际监听端口后调用这个
  // setter，把构造时的默认值（一个可能与真实端口不符的兜底猜测，例如裸进程
  // 模式下 PORT 未设时的 3000 vs 这里硬编码的 3007；Electron 每次随机挑一个
  // 空闲端口，构造时更是无从得知）纠正成真实值——DSH 子进程的每一次
  // anqi MCP 工具调用（case_folder_info/case_get/inbox_propose…）都以这个
  // base URL 为准，猜错端口等价于子进程的每一次内部调用都 ECONNREFUSED。
  setInternalBaseURL(url) {
    this.internalBaseURL = url;
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

    // readline 的 Interface 会把它 input 流（这里是 child.stderr）上的 'error'
    // 原样 re-emit 到自己身上；之前只挂了 'line'，没有任何监听器接住这个
    // re-emit 的 'error'——Node 的 EventEmitter 对没有监听器的 'error' 事件会
    // 直接 throw，等价于把子进程 stdio 管道的一次读取故障（EPIPE/ECONNRESET
    // 之类）升级成宿主进程自己的 uncaughtException，把整个 anqi 服务器一起
    // 崩掉。这里接住它并统一走 _handleFatal 收尾（kill 存活子进程 + 落
    // 'crashed' 终态），不让一个 worker 的管道故障波及宿主。
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderr.on('line', (line) => worker.emit('stderr', { line: worker.redact(line) }));
    stderr.on('error', () => this._handleFatal(worker, new Error('stderr error')));

    // child.stdin 全程只在 _request()/_writeChildResponse() 里裸 write，从未
    // 挂过 'error' 监听——同样的道理，stdin 一旦因为子进程已经退出/管道破裂而
    // 写入失败，会在 stdin 这个 Writable 上 emit 'error'；没有监听器时 Node
    // 直接 throw，同样会崩掉宿主进程。这里接住并吞掉（不重新抛出），只落
    // worker 终态——挂起的 RPC/turn 由 _handleFatal 统一 reject，调用方看到的
    // 是"worker 已终止"而不是进程崩溃。
    child.stdin.on('error', () => this._handleFatal(worker, new Error('stdin error')));

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
    //
    // namespaceWireEventType()：清洗后的 type 若撞上 SUPERVISOR_RESERVED_EVENT_
    // TYPES 里任何一个宿主生命周期事件名，强制重写成 wire/<type>——子进程发一条
    // event.type='interaction/pending' 不能靠撞名冒充宿主真正的审批待办事件（见
    // 该常量顶部注释）。origin 显式传 'wire'，与 emit() 默认的 'supervisor' 区分。
    const wireType = namespaceWireEventType(sanitizeEventType(worker.redact(String(event.type || 'session.event'))));
    worker.emit(wireType, this._redactEventData(worker, event.data), 'wire');

    if (event.type === 'request/header') {
      // 只在这个 worker 生命周期里第一次看到 request/header 时才记录——rc.7
      // 同一个首个 turn 内，工具/技能集合发生变化（例如懒加载技能命中）会
      // 追加一条 reason:'change' 的后续 request/header（agent-loop/lib/
      // index.js:715），事件字段结构与 reason:'initial' 完全相同。之前这里
      // 只判断 firstTurnChecked（首 turn 门禁是否已经跑完），同一个首 turn
      // 内的第二条 header 依然会命中并覆盖第一条——门禁 4 在 _maybeResolveTurn
      // 里读到的就是"变化后"的快照而不是首个真正的 initial 快照，一个本该
      // 通过（reason:'initial' 且已含所需 MCP 工具）的合规 turn 可能被后到的
      // change header 覆盖判失败，进而误杀整个 worker。现在只在
      // _firstRequestHeader 尚未被设置过时才赋值一次，后续同一 turn 内的任何
      // request/header 都不再覆盖它。
      if (!worker.firstTurnChecked && worker._firstRequestHeader === undefined) {
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
    // 的字段吐给 HTTP/UI 层，之前只在 emit('interaction/pending', ...)
    // 这一条路径上 redact，map 里存的仍是原值——子进程把 key 值塞进 toolName
    // 就能靠这条查询接口把它读出来，绕开 SSE 那条已经过滤的路径。
    const toolName = worker.redact(String(params.toolName || ''));
    // expire()：不管是 TTL 计时器触发，还是 worker 提前终态化（turn 失败/
    // 宿主发现子进程 stdio 故障/子进程退出）触发，都用同一份"回子进程一个
    // unavailable"的应答逻辑——见 _expirePendingInteractions 顶部注释：之前
    // 后一类路径只清表、不应答，子进程可能因此一直卡在等审批上，把 stop()
    // 的两段超时（30s + 10s）白白吃满。
    const expire = () => {
      this._writeChildResponse(worker, {
        jsonrpc: '2.0', id: message.id,
        result: { sessionId: params.sessionId, approvalId: params.approvalId, outcome: 'unavailable' },
      });
    };
    const timer = setTimeout(() => {
      if (!worker.pendingInteractions.has(interactionId)) return;
      worker.pendingInteractions.delete(interactionId);
      expire();
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
      expire,
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
    // expire()：同 approval 侧——TTL 超时与 worker 提前终态化都要真正应答子
    // 进程那一头还挂着的 user-question/request，不能只清表不回。
    const expire = () => {
      this._writeChildResponse(worker, {
        jsonrpc: '2.0', id: message.id,
        error: { code: -32004, message: 'ask_user_question timed out waiting for an answer' },
      });
    };
    const timer = setTimeout(() => {
      if (!worker.pendingInteractions.has(interactionId)) return;
      worker.pendingInteractions.delete(interactionId);
      expire();
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
      expire,
      respond: (answer) => {
        this._writeChildResponse(worker, {
          jsonrpc: '2.0', id: message.id,
          result: { sessionId: params.sessionId, answer },
        });
      },
    });
    // questions 一并广播（已经是脱敏后的 redactedQuestions，见上方入表前的
    // redact）——不这样做的话，已经订阅上 SSE 的抽屉在收到这条事件时除了
    // interactionId/type 一无所知，问不出题面文字，"受限答案表单"无从渲染；
    // 之前只广播 {interactionId,type}，题面文字唯一存在的地方是宿主内存里的
    // pendingInteractions 表，从未离开过 supervisor 进程。
    worker.emit('interaction/pending', { interactionId, type: 'question', questions: redactedQuestions });
  }

  // 未消费的反向请求一律 fail-closed、one-shot 清表，不留悬空 Promise——
  // _runTurn 判定 turn 失败、_handleFatal、_handleExit 三处共用同一份实现，
  // 避免各自维护一份"clearTimeout + emit + delete"逻辑而遗漏其中一处。
  //
  // 之前这里只清表、只广播 interaction/expired，从未真正应答子进程那一头还
  // 挂着的 JSON-RPC 请求——approval/request、user-question/request 都是子
  // 进程发出的、等着宿主写回 result/error 的反向 RPC，宿主这边把
  // pendingInteractions 记录删掉并不会让子进程侧的等待自动结束。子进程可能
  // 因此一直阻塞在等待审批/回答上，而 stop() 里在这之后还要发一次 shutdown
  // RPC（最多等 30s）+ 一次强杀等待（最多 10s）——一个卡在等审批的子进程,
  // shutdown 请求本身也可能因为对方忙于等待而迟迟不处理，等于让 stop() 白白
  // 吃满这两段超时。现在清表之前，先按类型给子进程回一个明确的终态应答：
  // approval 回 outcome:'unavailable'（与 TTL 超时兜底的应答语义一致），
  // question 回 JSON-RPC error（同 TTL 超时兜底），子进程能立即从等待中解
  // 脱，不必等到自己的 TTL 计时器或者宿主强杀。
  _expirePendingInteractions(worker, reason) {
    for (const [interactionId, record] of worker.pendingInteractions) {
      clearTimeout(record.timer);
      record.expire();
      worker.emit('interaction/expired', { interactionId, type: record.type, reason });
    }
    worker.pendingInteractions.clear();
  }

  // 子进程 'error'/stdio 故障共用的即时收尾：拒绝所有在飞的 RPC/turn、让
  // worker 立刻离开 LIVE_STATUSES、清空并真正应答未消费的反向请求（见
  // _expirePendingInteractions）——resolveApproval/resolveQuestion 不能在
  // worker 已经出故障但尚未真正终态化的窗口里把一条本该 fail-closed 的审批
  // 放行给一个已经死掉的 worker。_handleFatal 与 _handleExit 都需要这一段，
  // 但各自之后的终态判定不同（见各自方法的注释），抽出来避免不小心让两条
  // 路径的终态互相抢跑。
  _rejectInFlight(worker, error, reason) {
    for (const entry of worker.pendingRpc.values()) entry.reject(error);
    worker.pendingRpc.clear();
    worker._turnResolvers?.rejectTurn(error);
    if (LIVE_STATUSES.has(worker.status)) worker.status = 'error';
    this._expirePendingInteractions(worker, reason);
  }

  _handleFatal(worker, error) {
    this._rejectInFlight(worker, error, 'worker_fatal');
    // 子进程 'error' 事件（或 stdout/stderr/stdin 读写故障）不保证紧跟着来
    // 一个 'exit' 事件——stdio 管道坏掉不代表子进程本身已经退出，它可能只是
    // 卡住、不再响应但也不退出。之前这里只把 status 标成 'error'（一个非
    // LIVE 但也非终态的中间态）、从不 kill 子进程也不落 _finalizeWorker——
    // 如果 'exit' 事件永远不来，worker 就永久卡在这个中间态：0700 临时
    // skill 目录永远不会被删除（泄漏），也没有一条可审计的最终状态记录。
    // 现在主动收尾：子进程仍存活就先 SIGTERM，再落 _finalizeWorker('crashed')
    // ——_finalizeWorker 本身幂等（_finalized 守卫）；如果真正的 'exit' 事件
    // 随后还是到达，走的是 _handleExit 自己独立的终态判定路径（见下），不
    // 会跟这里已经落定的终态冲突，只是个 no-op。
    if (worker.child && worker.child.exitCode === null) {
      try { worker.child.kill('SIGTERM'); } catch { /* 已退出或不可 kill，忽略 */ }
    }
    this._finalizeWorker(worker, 'crashed', `fatal:${error.message}`.slice(0, 200));
  }

  _handleExit(worker, code, signal) {
    // 不经过 _handleFatal：'exit' 事件本身就意味着子进程已经确实退出，终态
    // 必须由这里根据 code/signal 精确判定 stopped/crashed；_handleFatal 收尾
    // 时会把终态硬编码成 'crashed'，如果这里再调用它，一次干净的 graceful
    // 退出（code 0）也会被那次抢先的 'crashed' 落定（_finalizeWorker 只落一
    // 次账，第二次判定只是 no-op）。这里只复用"拒绝在飞 RPC/turn + 清空并
    // 应答未消费反向请求"这一段两条路径共用的逻辑。
    this._rejectInFlight(worker, new Error(`worker exited (code=${code}, signal=${signal || 'none'})`), 'worker_exit');
    const wasClean = code === 0;
    this._finalizeWorker(worker, wasClean ? 'stopped' : 'crashed', `exit code=${code} signal=${signal || 'none'}`, { code, signal });
  }

  // 终态只落一次账：graceful stop() 与子进程 'exit' 事件可能前后脚都想收尾同
  // 一个 worker，第二次调用只是 no-op（不重复审计、不重复 emit worker/exit）。
  _finalizeWorker(worker, status, detail, exitInfo = null) {
    if (worker._finalized) return;
    worker._finalized = true;
    worker.status = status;
    // worker.error 会经 status()/publicStatus() 原样下发给 HTTP/SSE 层——是
    // 目前唯一一处绕过 redact() 就能到达外部的自由文本字段。detail 的来源五
    // 花八门（error.message、JSON-RPC 错误串……），完全可能包含子进程侧带出
    // 的 key 值（例如 startup_failed:${error.message} 里的 error 本身就可能
    // 是子进程/上游 provider 回传的错误串）。之前这里原样存 detail，探针已
    // 经证实能让 key 明文出现在 status().error 里。这里落地前统一过一遍
    // worker.redact()，与 audit()/emit('worker/exit', ...) 两行一直在用的同
    // 一份脱敏保持一致。
    worker.error = TERMINAL_STATUSES.has(status) && status !== 'stopped' ? worker.redact(String(detail ?? '')) : worker.error;
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
