// DSH sidecar 设置白名单读取。
//
// 只认下面五个键（设计稿 §1 的白名单）：enabled / provider / baseURL / model /
// apiKeyEnv。键值都存在既有的 settings key-value 表（迁移 014，见
// src/routes/settings.js 的既有用法——那张表本身不做键名约束，白名单永远在
// 应用层）；本文件是这五个 agent_* 键的唯一读路径，src/routes/settings.js 的
// agent_* PUT 校验直接复用这里导出的规则，不重新实现一份。
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
import { decryptSecret, maskSecret, resolveMasterKey } from '../lib/secret-box.js';

// 以下几个常量/函数均导出：src/routes/settings.js 的 agent_* 白名单 PUT 校验
// 与这里的 loadAgentConfig() 必须共用同一套规则（provider 枚举、apiKeyEnv
// 格式与保留名、baseURL 协议/凭据/内网/官方域策略），不允许两处各写一份、
// 悄悄跑偏——那样迟早出现"设置页存进去的值合法，但 supervisor 启动时又被
// 拒绝"或反过来"设置页挡不住、只能在 spawn 前才发现"的不一致。
export const ALLOWED_PROVIDERS = new Set(['deepseek-official', 'openai-completions']);
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

export function isReservedEnvName(name) {
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

// 把一个已经不含端口/zone-id 的 IPv6 地址字符串展开成 8 个十六进制组
// （处理 `::` 压缩记号）；格式非法（分段数对不上）返回 null。WHATWG URL
// 解析器在归一化 hostname 时,会把内嵌的 IPv4 点分十进制形式（无论是
// ::ffff:a.b.c.d 还是已废弃的 ::a.b.c.d）转换成纯十六进制表示后再按
// RFC 5952 压缩,所以到这里时已经不会再出现字面的点——下面据此统一展开、
// 统一判断,不需要再单独处理带点的中间形态。
function expandIPv6Groups(addr) {
  const doubleColonParts = addr.split('::');
  if (doubleColonParts.length > 2) return null;
  if (doubleColonParts.length === 1) {
    const groups = addr.split(':');
    return groups.length === 8 ? groups : null;
  }
  const [headRaw, tailRaw] = doubleColonParts;
  const head = headRaw ? headRaw.split(':') : [];
  const tail = tailRaw ? tailRaw.split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill('0'), ...tail];
}

function isPrivateOrLoopbackHost(hostname) {
  let lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // 尾点 FQDN（如 "localhost."、"api.localhost."）——WHATWG URL 会原样保留
  // 这个尾部的点（`new URL('http://LOCALHOST./v1').hostname === 'localhost.'`），
  // 但 DNS 侧 "localhost." 与 "localhost" 解析结果完全相同。不去掉这个点的
  // 话，下面 `lower === 'localhost'`、`.endsWith('.localhost')`、
  // `.endsWith('.local')` 这几条判断全部落空（探针实测
  // http://LOCALHOST./v1、http://api.localhost./v1、http://foo.local./v1
  // 均被 ALLOW），等于用一个记号法差异就绕开了先前刚补上的 *.localhost 拦
  // 截——这正是要堵的"baseURL 被指回本机/anqi 自己 internal API"那条路。
  lower = lower.replace(/\.$/, '');
  // ::ffff:a.b.c.d（或其规范化后的十六进制形式 ::ffff:7f00:1）是 IPv4-mapped
  // IPv6：不展开的话，套一层这个壳就能让 127.0.0.1/10.0.0.0/8 等纯 IPv4 正则
  // 检查全部落空，但地址本身依然可达对应的 IPv4 回环/内网目标。
  if (lower.startsWith('::ffff:')) {
    const rest = lower.slice('::ffff:'.length);
    lower = rest.includes('.') ? rest : ipv4FromMappedHex(rest) || lower;
  }
  if (lower === 'localhost' || lower === '0.0.0.0' || lower === '::1' || lower === '::') return true;
  if (lower.endsWith('.local')) return true;
  // RFC 6761 保留的 .localhost 顶级域：任何符合 *.localhost 的 hostname 都
  // 应当解析到回环地址（探针曾用 http://api.localhost/v1 实测被这里
  // ALLOW——之前只挡了裸 'localhost' 和 *.local，没覆盖这个同样常见、同样
  // 指回本机的后缀）。
  if (lower.endsWith('.localhost')) return true;
  // 云厂商元数据服务主机名——不解析成回环/内网字面量，但会被云环境的
  // resolver 指向 169.254.169.254 这类元数据端点（AWS/Azure 直接用 IP，
  // GCP 提供了这个专门的主机名）；探针实测 http://metadata.google.internal/v1
  // 被前面的纯 IP/字面量判断放行——如果 anqi 本身部署在 GCP 上，这就是一条
  // 现成的元数据 SSRF（可读到实例凭据）。metadata.goog 是同一服务的另一个
  // 域名别名，一并挡上；*.internal 是 GCP/多家云厂商约定的内部专用后缀，
  // 同样不应该被允许当作 baseURL 的目标。
  if (lower === 'metadata.google.internal' || lower === 'metadata.goog' || lower.endsWith('.metadata.goog')) return true;
  if (lower.endsWith('.internal')) return true;
  if (/^127\./.test(lower)) return true;
  // 0.0.0.0/8（"this network"，RFC 791/1122）——探针实测 http://0.1.2.3/v1
  // 被放行；这段地址在多数系统里会被内核当作到本机的路由处理，等价于回环。
  if (/^0\./.test(lower)) return true;
  if (/^10\./.test(lower)) return true;
  if (/^192\.168\./.test(lower)) return true;
  if (/^169\.254\./.test(lower)) return true;
  // 198.18.0.0/15（RFC 2544 网络设备基准测试专用段，198.18.0.0-198.19.255.255）
  // ——不路由到公网，探针实测 http://198.18.0.1/v1 被放行；同一批"特殊用途
  // 地址registry"里的段，与上面几条一并堵上，理由相同（不是真正可达的公网
  // 地址，允许它没有正当理由，反而可能撞到宿主环境里恰好用这段做内部测试
  // 网络的服务）。
  if (/^198\.(18|19)\./.test(lower)) return true;
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
  // IPv6 链路本地 fe80::/10（fe80:: 到 febf:ffff:...），等价于 IPv4 的
  // 169.254.0.0/16——之前只挡了 ULA fc00::/7，没挡这一段，探针曾实测放行。
  // 第二个十六进制组的取值范围是 0x80-0xbf（次高两位固定为 '10'），也就是
  // 十六进制第二位落在 8/9/a/b 这四个字符里。
  if (/^fe[89ab][0-9a-f]{0,2}:/.test(lower)) return true;
  // IPv6 站点本地 fec0::/10（fec0:: 到 feff:ffff:...，第二个十六进制组第二
  // 位落在 c/d/e/f）——RFC 3879 已废弃，但仍是等价于私网地址的历史保留段，
  // 拦掉与上面的链路本地一并兜底，避免只挡了一半 fe80::/10 就留下相邻这一
  // 段没挡。
  if (/^fe[cdef][0-9a-f]{0,2}:/.test(lower)) return true;
  // IPv4-compatible IPv6（::a.b.c.d，RFC 4291 已弃用形态，前 96 位全 0、末
  // 32 位是内嵌 IPv4）——与上面已经处理的 IPv4-mapped（::ffff:a.b.c.d，第 6
  // 组固定 ffff）不同，这种地址第 6 组是 0。WHATWG URL 解析器会把它归一化
  // 成纯十六进制压缩形式（探针实测 http://[::127.0.0.1]/v1 被归一化成
  // [::7f00:1]，绕开了前面所有纯 IPv4 正则，但地址本身依然是 127.0.0.1）。
  // 只在不是 `::ffff:` 开头时才走这条分支，避免与上面的 IPv4-mapped 判断
  // 重复展开。
  if (lower.startsWith('::') && !lower.startsWith('::ffff:')) {
    const groups = expandIPv6Groups(lower);
    if (groups && groups.length === 8 && groups.slice(0, 6).every((g) => /^0{0,4}$/.test(g))) {
      const hi = parseInt(groups[6], 16);
      const lo = parseInt(groups[7], 16);
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        const embeddedIPv4 = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
        if (isPrivateOrLoopbackHost(embeddedIPv4)) return true;
      }
    }
  }
  return false;
}

// baseURL 的完整校验（协议、credential-free、内网/回环拦截、deepseek-official
// 官方域钉死）。loadAgentConfig() 与设置路由（src/routes/settings.js 的
// agent_base_url PUT 校验）共用这一份实现——不允许两处独立实现同一条红线、
// 校验尺度各自漂移。provider 传空字符串/未知值时按"不给 deepseek-official
// 默认值、也不做官方域强校验"处理，交由调用方的 provider 校验先行判空。
export function validateBaseURL(baseURLRaw, provider) {
  let value = String(baseURLRaw ?? '').trim();
  if (!value && provider === 'deepseek-official') value = 'https://api.deepseek.com';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'baseURL 必须是合法的绝对 URL' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'baseURL 必须使用 http 或 https 协议' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'baseURL 不得包含凭据（userinfo）' };
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    return { ok: false, error: 'baseURL 不得指向内网/回环地址' };
  }
  if (provider === 'deepseek-official' && parsed.hostname.toLowerCase() !== DEEPSEEK_OFFICIAL_HOST) {
    return { ok: false, error: `deepseek-official 的 baseURL 只允许 ${DEEPSEEK_OFFICIAL_HOST}` };
  }
  return { ok: true, parsed, normalized: parsed.toString().replace(/\/$/, '') };
}

// 两个 baseURL 是否同源（协议+host+port，用 URL.origin 归一化，自动处理
// 默认端口的省略形式）。POST /api/agent/models 用它判断"调用方给的 baseURL
// 是不是用户已经保存过的那一个"——只有同源才允许把 env/本机存储的 key 自动
// 回落进 Authorization 头，见 src/routes/agent.js 的红线注释：这个端点刻意
// 不经过 config.enabled 门，如果对任意调用方指定的 baseURL 都放行已存
// key，就等于把一条"完整明文 key 外带到调用方指定的任意主机"的通道正式
// 开放出来（GET /api/settings 只回末 4 位掩码，绕过这道门就相当于把这个
// 边界废掉）。任一入参不是合法 URL 时按不同源处理（fail-closed）。
export function baseURLsShareOrigin(a, b) {
  try {
    return new URL(String(a ?? '')).origin === new URL(String(b ?? '')).origin;
  } catch {
    return false;
  }
}

// settings 表里的键名。设置路由只 PUT/GET 这五个键，其余一律丢弃——与
// src/routes/settings.js 既有的白名单模式保持一致。
export const AGENT_SETTINGS_KEYS = Object.freeze({
  enabled: 'agent_enabled',
  provider: 'agent_provider',
  baseURL: 'agent_base_url',
  model: 'agent_model',
  apiKeyEnv: 'agent_api_key_env',
  // 界面填的 key 落库前用 src/lib/secret-box.js 加密后存在这一键——本文件
  // 与 settings.js 都不直接读它拼进 SELECT/PUT 白名单响应体（那样会把密文
  // 回显出去，虽然密文本身不是明文，但没有正当理由顺手带出去）；只有下面
  // 的 getStoredApiKey() 会读它、解密、并且只把解密结果留在内存里用一次。
  apiKeyEncrypted: 'agent_api_key_encrypted',
});

// provider → 子进程里存放 key 值的固定环境变量名（设计稿 §3「DSH 侧变量名
// 固定为 provider 对应的名字」）。用户可选填的 apiKeyEnv 只控制"从宿主环境
// 的哪个变量名读取 key 值"这一件事（取值优先级链的第一环，见
// resolveAgentApiKey()）；不管 key 最终来自哪个来源（宿主环境变量、还是
// 界面填的加密存储），注入子进程时一律用这里固定的 provider 专属变量名，
// 与 src/agent/assets/anqi.cordis.yml 里 DSH_API_KEY_ENV 的默认值一一对应。
export const PROVIDER_CANONICAL_KEY_ENV = Object.freeze({
  'deepseek-official': 'DEEPSEEK_API_KEY',
  'openai-completions': 'OPENAI_API_KEY',
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

  // apiKeyEnv 现在是可选的高级选项（任务书设计 5）：公开版用户走「界面填 key
  // →加密存储」这条路，压根不需要碰环境变量；只有留空时才不校验格式——一旦
  // 填了非空值，仍然必须是合法环境变量名、且不是 anqi 自身的保留名/前缀，
  // 校验尺度与此前完全一致，不因为"现在是可选的"就顺带放松格式要求。
  const apiKeyEnv = readSetting(AGENT_SETTINGS_KEYS.apiKeyEnv).trim();
  if (apiKeyEnv) {
    if (!ENV_NAME_RE.test(apiKeyEnv)) {
      return { enabled: false, error: 'apiKeyEnv 必须是合法的环境变量名（不是 key 本身）' };
    }
    if (isReservedEnvName(apiKeyEnv)) {
      return { enabled: false, error: 'apiKeyEnv 不得使用 anqi 自身的保留变量名/前缀' };
    }
  }

  const baseURLResult = validateBaseURL(readSetting(AGENT_SETTINGS_KEYS.baseURL), provider);
  if (!baseURLResult.ok) return { enabled: false, error: baseURLResult.error };
  const parsed = baseURLResult.parsed;

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
    // 子进程里固定要用的变量名——与 apiKeyEnv（"从宿主环境的哪个变量名读
    // 取"）是两个独立概念，见 PROVIDER_CANONICAL_KEY_ENV 顶部注释。
    canonicalKeyEnv: PROVIDER_CANONICAL_KEY_ENV[provider],
  };
}

// 读取界面存的加密 key 并解密。找不到该键、值为空串、密文格式非法、或主密
// 钥解不开（密钥被换过/密文被篡改）——一律返回 null，不抛出、不让调用方
// 的其它逻辑因为一条读不出来的历史存量密文而崩溃；这是"取值链"里"env 优先，
// 界面存储兜底，都没有则不可用"这条设计里"兜底"必须能安全失败的那一半。
// 从不把解密失败的具体原因（哪一步错）透出给调用方以外的任何地方——本函数
// 本身也绝不 console.log/audit 解密出来的明文。
export function getStoredApiKey() {
  const encrypted = readSetting(AGENT_SETTINGS_KEYS.apiKeyEncrypted);
  if (!encrypted) return null;
  try {
    const key = resolveMasterKey();
    const plaintext = decryptSecret(encrypted, key);
    return plaintext || null;
  } catch {
    return null;
  }
}

// 取值优先级链（任务书 §3，关键，别搞反）：
//   1) config.apiKeyEnv 指向的环境变量若存在且非空 → 用它，source='env'
//      （保证现有 Docker/桌面部署零改动继续工作：老用户本来就是设好环境变量
//      再把变量名填进界面，这条路径必须原样保留、且优先级最高）。
//   2) 否则界面存的加密 key（getStoredApiKey()）→ source='stored'。
//   3) 两者都没有 → value:null, source:'none'。
// 不做 config.enabled 判断——调用方（POST /api/agent/models 这类"保存前先
// 测试 key"的场景）需要在 agent_enabled 还是 false（用户正在填资料、还没点
// 保存开启）的时候也能解析出当前已经填好的 key；enabled 门是 supervisor
// 启动子进程/agentReady() 特性探测各自的职责，不是"key 到底存不存在"这件
// 事本身的前提。
export function resolveAgentApiKey(config) {
  const apiKeyEnv = config?.apiKeyEnv ? String(config.apiKeyEnv) : '';
  if (apiKeyEnv) {
    const fromEnv = process.env[apiKeyEnv];
    if (fromEnv) return { value: fromEnv, source: 'env' };
  }
  const stored = getStoredApiKey();
  if (stored) return { value: stored, source: 'stored' };
  return { value: null, source: 'none' };
}

// /api/counts 与 /api/agent/status 共用：只回答"当前 key 是否可用、来自
// 哪里"，从不返回 key 本身或其掩码（掩码展示是 GET /api/settings 单独的
// 职责，见 settings.js）。enabled=false 时直接判 none/false，保持与
// agentReady() 一致的对外语义——"未启用"与"启用但没配 key"在这里都是不
// 可用，只是 keySource 会诚实反映"即使填了 key 也没被读到"这件事对已保存
// 配置无意义（enabled=false 分支根本不检查是否存在已存 key）。
export function agentKeyStatus() {
  const config = loadAgentConfig();
  if (!config.enabled) return { configured: false, keySource: 'none' };
  const { value, source } = resolveAgentApiKey(config);
  return { configured: !!value, keySource: source };
}

export { maskSecret };

// /api/counts 的特性探测用——与 src/lib/llm.js 的 llmReady() 同一种模式：
// 只回答"当前是否可用"这一个布尔值，供前端决定要不要渲染入口按钮，绝不把
// 实际 key 值透出去（resolveAgentApiKey() 内部只做存在性判断/一次性解密，
// 这里只取它的布尔结果）。enabled=false 或白名单字段本身非法时，跟
// loadAgentConfig() 一样直接判 false，不单独再报错误详情。key 现在有两个
// 可能来源（env 优先、界面存储兜底，见 resolveAgentApiKey() 顶部注释）——
// agentReady() 不关心具体来源，只关心"有没有"。
export function agentReady() {
  const config = loadAgentConfig();
  if (!config.enabled) return false;
  return !!resolveAgentApiKey(config).value;
}
