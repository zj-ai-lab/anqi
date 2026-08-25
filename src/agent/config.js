// DSH sidecar 设置白名单读取。
//
// 只认下面七个运行配置键：enabled / capabilityMode / provider / baseURL /
// model / apiKeyEnv / pluginPatch。键值都存在既有的 settings key-value 表（迁移 014，见
// src/routes/settings.js 的既有用法——那张表本身不做键名约束，白名单永远在
// 应用层）；本文件是这些 agent_* 键的唯一读路径，src/routes/settings.js 的
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
import fs from 'node:fs';
import path from 'node:path';

// 以下几个常量/函数均导出：src/routes/settings.js 的 agent_* 白名单 PUT 校验
// 与这里的 loadAgentConfig() 必须共用同一套规则（provider 枚举、apiKeyEnv
// 格式与保留名、baseURL 协议/凭据/内网/官方域策略），不允许两处各写一份、
// 悄悄跑偏——那样迟早出现"设置页存进去的值合法，但 supervisor 启动时又被
// 拒绝"或反过来"设置页挡不住、只能在 spawn 前才发现"的不一致。
export const ALLOWED_PROVIDERS = new Set(['deepseek-official', 'openai-completions']);
export const ALLOWED_AGENT_CAPABILITY_MODES = new Set(['project', 'full']);
export const ALLOWED_AGENT_APPROVAL_TIERS = new Set(['1', '2', '3']);
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateAgentPluginPatch(value) {
  const filename = String(value ?? '').trim();
  if (!filename) return { ok: true, normalized: '' };
  if (filename.length > 4096 || /[\0-\x1f\x7f]/u.test(filename)) {
    return { ok: false, error: '插件 patch 路径非法或过长' };
  }
  if (!path.isAbsolute(filename) || !/\.ya?ml$/i.test(filename)) {
    return { ok: false, error: '插件 patch 必须是绝对路径的 .yml/.yaml 文件' };
  }
  let stat;
  try { stat = fs.lstatSync(filename); } catch {
    return { ok: false, error: '插件 patch 文件不存在或不可读取' };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { ok: false, error: '插件 patch 必须是普通文件，不能是符号链接' };
  }
  return { ok: true, normalized: path.resolve(filename) };
}

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

export function isPrivateOrLoopbackHost(hostname) {
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
  // 网络的服务）。这条判断只作用于 baseURL 字符串字面量本身——本文件不再
  // 对 hostname 做真实 DNS 解析（见文件顶部关于移除连接期 DNS 钉住层的说明），
  // 所以不存在"解析结果落在这个网段"需要单独豁免 fake-ip 代理的问题。
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
  // 不接受查询参数/片段：src/agent/models-client.js 用字符串拼接
  // `${baseURL}/models` 构造上游 URL，而不是 `new URL('models', base)`——
  // 带 `?`/`#` 的 baseURL 会把 `/models` 后缀拼进错误位置（探针实测：
  // 以 '/v1#frag' 结尾时 `/models` 后缀被静默吞掉，实际请求变成
  // `GET /v1`；以 '/v1?token=abc' 结尾时变成 `GET /v1?token=abc/models`）。
  // 这类 baseURL 恰好能通过下面的所有校验、被原样存进
  // agent_base_url（连同 query/fragment 一起），于是 DSH 运行时也会继承
  // 同一个坏值。直接在这里拒绝，比在 models-client.js 里改用更宽容的 URL
  // 拼接更安全——baseURL 本来就不应该带查询参数或片段。
  if (parsed.search || parsed.hash) {
    return { ok: false, error: 'baseURL 不得包含查询参数（?）或片段（#）' };
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    return { ok: false, error: 'baseURL 不得指向内网/回环地址' };
  }
  // 公网地址强制 https：内网/回环地址已经在上面被整体拒绝，能走到这里的
  // host 按定义就是"公网地址"，key 会以明文 Bearer 头发出去——继续允许
  // http 就是让它在链路上明文传输。仓库自己在 android-v1.1.0（见
  // docs/CHANGES.md）已经立过同一条规则："公网强制 HTTPS，回环/RFC1918/
  // .local 允许 HTTP 并明示"；这里同样的取舍更该成立，因为回环/内网本来
  // 就已经被拒绝了，不存在"内网自签证书用不了 https"这种需要放行 http 的
  // 正当理由。
  if (parsed.protocol === 'http:') {
    return { ok: false, error: 'baseURL 指向公网地址时必须使用 https（回环/内网地址不受此限，但那些地址本身已被拒绝）' };
  }
  if (provider === 'deepseek-official' && parsed.hostname.toLowerCase() !== DEEPSEEK_OFFICIAL_HOST) {
    return { ok: false, error: `deepseek-official 的 baseURL 只允许 ${DEEPSEEK_OFFICIAL_HOST}` };
  }
  return { ok: true, parsed, normalized: parsed.toString().replace(/\/$/, '') };
}

// 【2026-08-23 复审修复，替换已废弃的 baseURLsShareOrigin()】此前
// POST /api/agent/models 曾经把"这次请求的 baseURL 是否与 settings 表里
// 当前的 agent_base_url 同源"当作"用户已经决定信任这个地址"的证据，藉此
// 允许省略 apiKey 时静默回落到已存/环境变量的 key。这个信任锚点本身就是
// 同一个 PUT /api/settings 面可写的——攻击者（典型场景：XSS）只需要两次
// 请求就能把它变成一条完整明文 key 外带通道：第一次 PUT 把 agent_base_url
// 改成攻击者自己的地址（只需 agent_provider + agent_base_url 两个字段），
// "同源"判定随之立刻变为真；第二次 POST /api/agent/models 省略 apiKey，
// 校验通过，已存 key 解密后直接发给攻击者服务器（该端点还刻意不经过
// config.enabled 门，enabled=false 时同样成立）。也就是说，"与已保存值
// 是否一致"这类可以被同一权限面在同一时刻改写的值，从来不是一个可靠的
// 信任锚点——不再复用它。现在只保留一种可以自动回落的情形：
// provider === 'deepseek-official'，因为它的 baseURL 已经被
// validateBaseURL() 钉死成官方域常量（DEEPSEEK_OFFICIAL_HOST），不存在
// "指向任意主机"的可能，不依赖 settings 表里任何可被同一 PUT 面改写的值。
// openai-completions 的 baseURL 天然是用户自定义、可被攻击者用同一条
// PUT 通道随时改写，因此该 provider 下拉取模型必须显式在请求体里带上
// apiKey，不再提供任何形式的静默回落——见 src/routes/agent.js 该端点的
// 具体判断分支。

// 【2026-08-23 减法：移除连接期 DNS 解析 + IP 钉住层】此前这里还有一个
// resolvePinnedAddress()——validateBaseURL() 的 isPrivateOrLoopbackHost()
// 只对 URL 解析出来的 hostname 字符串做黑名单匹配、不做 DNS 解析，任何一个
// 字符串看起来"人畜无害"、实际解析到回环/内网地址的公网注册域名（例如会
// 真实解析到 127.0.0.1 的 `localtest.me`）都能跳过全部字符串校验；
// resolvePinnedAddress() 曾经在真正发起请求前对 hostname 做一次真实 DNS
// 解析、把连接钉死在核对过的具体地址上，堵住这类绕过与 DNS rebinding 窗口。
//
// 该函数与它在 src/routes/agent.js／src/agent/models-client.js 里的全部接线
// （pinnedAddress/pinnedAddresses 参数、故障转移、fake-ip/198.18 豁免）已
// 整体删除，理由（编排方决策，非本文件单方面判断）：
//   1) POST /api/agent/models 已经在 apiAuth 之后——能调用它的调用方本来就能
//      通过既有 supervisor 路径（改 baseURL + 开开关 + start worker）达成
//      同等外联；worker 启动路径从未有过 DNS 钉住（见 supervisor.js 的
//      buildSpawnEnv()，只过字符串层 validateBaseURL()），DNS 钉住并没有
//      消除这一类风险，只是把这一个端点的门槛从两步变三步，两条路径现在
//      重新处于同一水位，不再有"一个端点比另一个端点更安全"的误导性落差。
//   2) 它在真实环境里会大面积误伤：本机开着 Surge/Clash 等 fake-ip 类透明
//      代理时，所有域名都会被解析到 198.18.0.0/15，为绕开这类误伤而加的
//      豁免又让这道闸门对这批用户整体退化成 no-op——"有一道其实不生效的
//      闸门，文档却写着它有效"比"明确没有这道闸门"更糟。
//   3) 它给一个纯设置校验动作引入了运行时 DNS 依赖：VPN/代理/企业 DNS 都会
//      让"拉取模型列表"这条易用性流程报"网络错误"，与本轮"降低配置门槛"的
//      目标直接冲突。
// 现状（如实描述，不含糊）：baseURL 的 SSRF 防线现在只剩 validateBaseURL()
// 这一层纯字符串校验（协议白名单/禁 userinfo/禁 query-fragment/公网强制
// https/字面量回环-内网-链路本地-CGNAT-metadata 主机名黑名单/deepseek-
// official 官方域钉死）——不再对 hostname 做任何 DNS 解析或连接目标核对，
// 这意味着一个字符串看起来合法、实际解析到内网/回环的公网注册域名（如
// localtest.me 一类）仍然能通过这层校验；这是本轮明确接受的取舍，见
// docs/CHANGES.md 与 docs/agent-gates.md 门禁 9 的记录。
//
// settings 表里的键名。设置路由只 PUT/GET 这些键，其余一律丢弃——与
// src/routes/settings.js 既有的白名单模式保持一致。
export const AGENT_SETTINGS_KEYS = Object.freeze({
  enabled: 'agent_enabled',
  capabilityMode: 'agent_capability_mode',
  approvalTier: 'agent_approval_tier',
  provider: 'agent_provider',
  baseURL: 'agent_base_url',
  model: 'agent_model',
  apiKeyEnv: 'agent_api_key_env',
  pluginPatch: 'agent_plugin_patch',
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
//   { enabled: true, capabilityMode, provider, runtimeProvider, baseURL, model,
//     apiKeyEnv, pluginPatch } ——白名单字段全部合法；apiKeyEnv 仍然只是变量名，不含值。
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

  // 旧数据库没有这一行时使用收敛的 project 档；只有设置页显式保存 full
  // 才扩大到 shell/web/workflow/Ralph 等上游完整能力。
  const capabilityMode = readSetting(AGENT_SETTINGS_KEYS.capabilityMode).trim() || 'project';
  if (!ALLOWED_AGENT_CAPABILITY_MODES.has(capabilityMode)) {
    return { enabled: false, error: 'capabilityMode 必须是 project 或 full' };
  }

  // 旧库没有该 KV 时一律落 1 档（每步问）；非法存量不猜、不降级成放开，
  // 直接让整份 agent config fail closed。
  const approvalTier = readSetting(AGENT_SETTINGS_KEYS.approvalTier).trim() || '1';
  if (!ALLOWED_AGENT_APPROVAL_TIERS.has(approvalTier)) {
    return { enabled: false, error: 'approvalTier 必须是 1、2 或 3' };
  }

  // 任意 DSH 插件都是宿主进程内代码，只在用户显式选择 full 档时加载。
  // project 档保留设置值但不解析、不读取该文件，也不把路径传给 sidecar。
  let pluginPatch = '';
  if (capabilityMode === 'full') {
    const patchResult = validateAgentPluginPatch(readSetting(AGENT_SETTINGS_KEYS.pluginPatch));
    if (!patchResult.ok) return { enabled: false, error: patchResult.error };
    pluginPatch = patchResult.normalized;
  }

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
    capabilityMode,
    approvalTier,
    pluginPatch,
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
//
// 格式/保留名校验在这里再做一遍（而不是只信任调用方已经校验过）：
// loadAgentConfig() 是唯一"写侧强制过 isReservedEnvName()"的路径，但
// src/routes/agent.js 与 src/routes/settings.js 里另有两处消费者直接裸读
// settings 表的 agent_api_key_env 行、手搓 {apiKeyEnv} 传进来，跳过了那层
// 校验（历史存量行、被恢复的备份、或直接改库都能让这一行绕过 PUT 时的校
// 验）。探针实测过：把该行直接置成 anqi 自己的 ANJIAN_INTERNAL_KEY，走这
// 两个消费者的路径都会把内部密钥当模型 key 读出来。把校验下沉到这里，让
// 所有调用方自动继承，不必要求每个新调用方都记得自己重复一遍。
export function resolveAgentApiKey(config) {
  const apiKeyEnv = config?.apiKeyEnv ? String(config.apiKeyEnv) : '';
  if (apiKeyEnv && ENV_NAME_RE.test(apiKeyEnv) && !isReservedEnvName(apiKeyEnv)) {
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
