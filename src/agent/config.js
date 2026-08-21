// DSH sidecar 设置白名单读取。
//
// 只认下面五个键（设计稿 §1 的白名单）：enabled / provider / baseURL / model /
// apiKeyEnv。键值都存在既有的 settings key-value 表（迁移 014，见
// src/routes/settings.js 的既有用法——那张表本身不做键名约束，白名单永远在
// 应用层）；本文件是这五个 agent_* 键的唯一读路径，下一阶段的设置路由只需要
// 调用这里的 loadAgentConfig() / AGENT_SETTINGS_KEYS，不用重新实现校验。
//
// 硬规则（红线，见任务书）：
//   - enabled=false 必须在触碰 credential/MCP/prewarm/spawn 之前短路返回。
//     本函数第一件事就是读 enabled；一旦不是显式 'true'，立即返回
//     { enabled:false } —— 后面几个键（尤其 apiKeyEnv 指向的环境变量值）
//     根本不会被读取，调用方也不应该在 enabled:false 时读 process.env。
//   - apiKeyEnv 只是"环境变量名"，从不是 key 本身；本文件不读取、不返回、
//     不缓存 process.env[apiKeyEnv] 的值。谁需要真正的 key 值，自己在
//     spawn 前按名字读一次 process.env，且只能进子进程 env，不能进日志/DB/
//     HTTP/SSE（见 supervisor.js 的 credential 门禁与 sanitized spawn env）。
//   - baseURL 必须经过协议、credential-free 和允许域策略三项校验（设计稿
//     §5）；apiKeyEnv 除了合法环境变量名格式，还必须排除 anqi 自身会用到的
//     保留前缀/名称——见下面 isReservedEnvName 的注释。
import { db } from '../db.js';

const ALLOWED_PROVIDERS = new Set(['deepseek-official', 'openai-completions']);
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// apiKeyEnv 保留名黑名单：这个键只应该指向"模型 provider 自己的 key 变量
// 名"，绝不能被配成 anqi 自身进程里已经存在的内部/宿主变量名——否则
// supervisor.js 的 buildSpawnEnv 会原样把该变量的值当 Authorization bearer
// 发给 baseURL 指向的任意地址，红线「key 值永不进 HTTP」直接被配置侧击穿
// （例如把 apiKeyEnv 设成 ANJIAN_INTERNAL_KEY，就会把 anqi 自己的内部密钥
// 发给用户填的第三方 baseURL）。前缀覆盖 ANJIAN_/ANQI_/DSH_ 三个内部命名
// 空间；精确名单覆盖常见宿主/系统变量。
const RESERVED_ENV_PREFIXES = ['ANJIAN_', 'ANQI_', 'DSH_'];
const RESERVED_ENV_NAMES = new Set([
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SHELL', 'USER',
  'PWD', 'NODE_OPTIONS', 'NODE_ENV', 'SystemRoot', 'windir',
]);

function isReservedEnvName(name) {
  const upper = name.toUpperCase();
  if (RESERVED_ENV_NAMES.has(upper)) return true;
  return RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

// baseURL 允许域策略（设计稿 §5：baseURL 需要「协议、credential-free、允许域
// 策略」三项校验，此前只做了前两项）。deepseek-official 钉死只能是官方域名
// ——它本来就有一个硬编码默认值，允许自由覆盖成任意 host 没有任何正当理由，
// 反而是"把 deepseek 的 key 发给攻击者服务器"最直接的路径。openai-completions
// 天然需要指向各种自建/第三方 OpenAI 兼容端点，没法钉死单一域名，这里退而
// 求其次做 SSRF 风格的内网/回环地址拦截：不能指向
// localhost/127.0.0.0/8/10.0.0.0/8/172.16-31.0.0/12/192.168.0.0/16/
// 169.254.0.0/16/*.local——防止 baseURL 被指回 anqi 自己的 internal API 或
// 宿主机上的其它本地服务。这里只做字符串层面判断，不做 DNS 解析（配置校验
// 不引入网络 I/O，也防止 DNS rebinding 绕过一次性解析检查）。
const DEEPSEEK_OFFICIAL_HOST = 'api.deepseek.com';

// IPv4-mapped IPv6 的十六进制形式（Node 的 URL 解析器会把 ::ffff:127.0.0.1
// 归一化成 ::ffff:7f00:1 这种"两个十六进制组"写法而不是保留点分十进制）；
// 展开成点分十进制字符串，方便复用下面同一套 IPv4 私网正则。
function ipv4FromMappedHex(rest) {
  const groups = rest.split(':');
  if (groups.length !== 2) return null;
  const nums = groups.map((g) => parseInt(g, 16));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return [nums[0] >> 8, nums[0] & 0xff, nums[1] >> 8, nums[1] & 0xff].join('.');
}

function isPrivateOrLoopbackHost(hostname) {
  let lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // ::ffff:a.b.c.d（或其规范化后的十六进制形式 ::ffff:7f00:1）是 IPv4-mapped
  // IPv6：不展开的话，套一层这个壳就能让 127.0.0.1/10.0.0.0/8 等纯 IPv4 正则
  // 检查全部落空，但地址本身依然可达对应的 IPv4 回环/内网目标。
  if (lower.startsWith('::ffff:')) {
    const rest = lower.slice('::ffff:'.length);
    lower = rest.includes('.') ? rest : ipv4FromMappedHex(rest) || lower;
  }
  if (lower === 'localhost' || lower === '0.0.0.0' || lower === '::1' || lower === '::') return true;
  if (lower.endsWith('.local')) return true;
  if (/^127\./.test(lower)) return true;
  if (/^10\./.test(lower)) return true;
  if (/^192\.168\./.test(lower)) return true;
  if (/^169\.254\./.test(lower)) return true;
  // CGNAT 100.64.0.0/10（100.64.0.0 - 100.127.255.255）——常见于云厂商/隧道
  // 内网出口，不拦会让 baseURL 指到同一 CGNAT 网段内的其它内部服务。
  const cgnatMatch = /^100\.(\d{1,3})\./.exec(lower);
  if (cgnatMatch) {
    const second = Number(cgnatMatch[1]);
    if (second >= 64 && second <= 127) return true;
  }
  const linkLocalMatch = /^172\.(\d{1,3})\./.exec(lower);
  if (linkLocalMatch) {
    const secondOctet = Number(linkLocalMatch[1]);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }
  // IPv6 ULA fc00::/7（fc00:: 到 fdff:ffff:...），等价于 IPv4 的私网地址段。
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true;
  return false;
}

// settings 表里的键名。设置路由（下阶段）应该只 PUT/GET 这五个键，其余一律丢弃
// ——与 src/routes/settings.js 现有的白名单模式保持一致。
export const AGENT_SETTINGS_KEYS = Object.freeze({
  enabled: 'agent_enabled',
  provider: 'agent_provider',
  baseURL: 'agent_base_url',
  model: 'agent_model',
  apiKeyEnv: 'agent_api_key_env',
});

const settingRow = db.prepare('SELECT value FROM settings WHERE key = ?');

function readSetting(key) {
  const row = settingRow.get(key);
  return row ? String(row.value ?? '') : '';
}

// 返回值只有两种形态：
//   { enabled: false, error?: string } —— 未启用，或白名单字段非法/缺失；
//     error 只在 enabled=true 的分支之后才可能出现，因为字段校验发生在
//     enabled 门之后——调用方不应该把 error 当成"已启用但配置坏了"以外的
//     含义来用。
//   { enabled: true, provider, runtimeProvider, baseURL, model, apiKeyEnv } ——
//     五个白名单字段全部合法；apiKeyEnv 仍然只是变量名，不含值。
export function loadAgentConfig() {
  const enabledRaw = readSetting(AGENT_SETTINGS_KEYS.enabled);
  if (enabledRaw !== 'true') {
    // 硬门：短路在这里发生，后面任何一行都不会执行，包括读 apiKeyEnv 字段。
    return { enabled: false };
  }

  const provider = readSetting(AGENT_SETTINGS_KEYS.provider).trim();
  if (!ALLOWED_PROVIDERS.has(provider)) {
    return { enabled: false, error: `provider 必须是 ${[...ALLOWED_PROVIDERS].join(' 或 ')}` };
  }

  const model = readSetting(AGENT_SETTINGS_KEYS.model).trim();
  if (!model) return { enabled: false, error: 'model 未设置' };

  const apiKeyEnv = readSetting(AGENT_SETTINGS_KEYS.apiKeyEnv).trim();
  if (!ENV_NAME_RE.test(apiKeyEnv)) {
    return { enabled: false, error: 'apiKeyEnv 必须是合法的环境变量名（不是 key 本身）' };
  }
  if (isReservedEnvName(apiKeyEnv)) {
    return { enabled: false, error: 'apiKeyEnv 不得使用 anqi 自身的保留变量名/前缀' };
  }

  let baseURLRaw = readSetting(AGENT_SETTINGS_KEYS.baseURL).trim();
  if (!baseURLRaw && provider === 'deepseek-official') baseURLRaw = 'https://api.deepseek.com';
  let parsed;
  try {
    parsed = new URL(baseURLRaw);
  } catch {
    return { enabled: false, error: 'baseURL 必须是合法的绝对 URL' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { enabled: false, error: 'baseURL 必须使用 http 或 https 协议' };
  }
  if (parsed.username || parsed.password) {
    return { enabled: false, error: 'baseURL 不得包含凭据（userinfo）' };
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    return { enabled: false, error: 'baseURL 不得指向内网/回环地址' };
  }
  if (provider === 'deepseek-official' && parsed.hostname.toLowerCase() !== DEEPSEEK_OFFICIAL_HOST) {
    return { enabled: false, error: `deepseek-official 的 baseURL 只允许 ${DEEPSEEK_OFFICIAL_HOST}` };
  }

  return {
    enabled: true,
    provider,
    // dsh-llm-pi-ai 的 providers 字典键名（见 anqi.cordis.yml 的 llm-pi-ai 行）；
    // deepseek-official 走 dsh-llm-deepseek，不需要这个字典键，固定用它自己的
    // provider 名占位即可，supervisor 不会在该分支使用 runtimeProvider。
    runtimeProvider: provider === 'openai-completions' ? 'anqi-openai' : 'deepseek-official',
    baseURL: parsed.toString().replace(/\/$/, ''),
    model,
    apiKeyEnv,
  };
}
