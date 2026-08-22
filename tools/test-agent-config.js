// DSH sidecar 设置白名单读取的最小自检：enabled 门、provider 白名单、
// baseURL 协议 + 无 userinfo + 允许域策略校验、apiKeyEnv 只是变量名（不读值）
// 且排除保留名。
//
// DB_PATH 隔离到临时文件：这个脚本会写 settings 表，不能落在仓库真实的
// data/anjian.db——db.js 的 DB_PATH 在模块首次执行时读一次 process.env，必须
// 在任何静态 import 触发它加载之前设置好，所以这里延后到动态 import（与
// tools/test-auth-security.js 同一套写法）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-config-'));
process.env.DB_PATH = path.join(scratch, 'agent-config.db');

const { db } = await import('../src/db.js');
const {
  AGENT_SETTINGS_KEYS,
  loadAgentConfig,
  resolveAgentApiKey,
  getStoredApiKey,
  agentKeyStatus,
  PROVIDER_CANONICAL_KEY_ENV,
} = await import('../src/agent/config.js');
const { encryptSecret, resolveMasterKey } = await import('../src/lib/secret-box.js');

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

// 1) 默认（没有任何 agent_* 行）必须是 disabled，且不报错。
clearAgentSettings();
assert.deepEqual(loadAgentConfig(), { enabled: false });

// 2) enabled 不是字面量 'true' 一律当 false（防止 'TRUE'/'1' 等误配置意外放行）。
setSetting(AGENT_SETTINGS_KEYS.enabled, '1');
assert.equal(loadAgentConfig().enabled, false);

// 3) enabled=true 但 provider 不在白名单 → disabled + error，且不把
//    apiKeyEnv/baseURL 之类信息當作已启用配置返回。
setSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
setSetting(AGENT_SETTINGS_KEYS.provider, 'anthropic-direct');
let result = loadAgentConfig();
assert.equal(result.enabled, false);
assert.ok(result.error);

// 4) provider 合法但 model 缺失。
setSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
setSetting(AGENT_SETTINGS_KEYS.model, '');
assert.equal(loadAgentConfig().enabled, false);

// 5) apiKeyEnv 必须是合法环境变量名，不能是奇怪字符串或看起来像 key 本身的值。
setSetting(AGENT_SETTINGS_KEYS.model, 'deepseek-chat');
setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'sk-not-an-env-name');
assert.equal(loadAgentConfig().enabled, false);

// 6) baseURL 带 userinfo 必须拒绝。
setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'DEEPSEEK_API_KEY');
setSetting(AGENT_SETTINGS_KEYS.baseURL, 'https://user:pass@api.deepseek.com');
assert.equal(loadAgentConfig().enabled, false);

// 7) baseURL 非 http/https 协议必须拒绝。
setSetting(AGENT_SETTINGS_KEYS.baseURL, 'file:///etc/passwd');
assert.equal(loadAgentConfig().enabled, false);

// 8) 全部字段合法：返回完整白名单五个字段，且 baseURL 去掉尾部斜杠。
setSetting(AGENT_SETTINGS_KEYS.baseURL, 'https://api.deepseek.com/');
result = loadAgentConfig();
assert.equal(result.enabled, true);
assert.equal(result.provider, 'deepseek-official');
assert.equal(result.model, 'deepseek-chat');
assert.equal(result.apiKeyEnv, 'DEEPSEEK_API_KEY');
assert.equal(result.baseURL, 'https://api.deepseek.com');
assert.equal(Object.prototype.hasOwnProperty.call(result, 'apiKeyValue'), false, 'config.js 绝不应该读出或返回 key 的值');

// 9) openai-completions 走 runtimeProvider 字典键 'anqi-openai'。
setSetting(AGENT_SETTINGS_KEYS.provider, 'openai-completions');
setSetting(AGENT_SETTINGS_KEYS.baseURL, 'https://my-endpoint.example.com');
result = loadAgentConfig();
assert.equal(result.enabled, true);
assert.equal(result.runtimeProvider, 'anqi-openai');

// 10) apiKeyEnv 格式合法但是保留名/保留前缀——必须拒绝，防止把 anqi 自身的
//     内部密钥（ANJIAN_INTERNAL_KEY 之类）当模型 provider 的 Authorization
//     bearer 发给用户填的 baseURL。
for (const reserved of ['ANJIAN_INTERNAL_KEY', 'ANJIAN_STATIC_TOKEN', 'ANQI_ANYTHING', 'DSH_ANYTHING', 'PATH', 'HOME']) {
  setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, reserved);
  const rejected = loadAgentConfig();
  assert.equal(rejected.enabled, false, `apiKeyEnv=${reserved} 必须被拒绝`);
  assert.ok(rejected.error, `apiKeyEnv=${reserved} 必须带 error`);
}
setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'MY_OPENAI_KEY');

// 11) baseURL 指向内网/回环地址必须拒绝（SSRF 风格拦截，防止 baseURL 被指回
//     anqi 自己的 internal API 或宿主机上的其它本地服务）。
for (const host of ['http://127.0.0.1:3007', 'http://localhost:9999', 'http://10.0.0.5', 'http://192.168.1.1', 'http://internal.local']) {
  setSetting(AGENT_SETTINGS_KEYS.baseURL, host);
  const rejected = loadAgentConfig();
  assert.equal(rejected.enabled, false, `baseURL=${host} 必须被拒绝`);
}

// 11.5) *.localhost 后缀（RFC 6761 保留、天然解析回回环地址）与 IPv6 链路本地
//       fe80::/10、已废弃的站点本地 fec0::/10——探针曾用 http://api.localhost/v1
//       实测被 ALLOW（之前只挡了裸 'localhost' 和 *.local，没覆盖这个同样常
//       见的后缀）；fe80::/10 之前只挡了 ULA fc00::/7，同样漏了；fec0::/10
//       挨着 fe80::/10，虽然 RFC 3879 已废弃但仍是私网等价段，一并挡上。
for (const host of [
  'http://api.localhost/v1',
  'http://foo.bar.localhost:8080/',
  'http://[fe80::1]/',
  'http://[fe80::abcd:1234]/',
  'http://[febf:ffff::1]/', // fe80::/10 段末尾
  'http://[fec0::1]/', // 已废弃的 IPv6 站点本地 fec0::/10 起始
  'http://[feff:ffff::1]/', // fec0::/10 段末尾
]) {
  setSetting(AGENT_SETTINGS_KEYS.baseURL, host);
  const rejected = loadAgentConfig();
  assert.equal(rejected.enabled, false, `baseURL=${host} 必须被拒绝（.localhost 后缀 / fe80::/10 链路本地 / fec0::/10 站点本地）`);
}
// 边界之外的地址必须仍然放行，确认没有误伤——2001:db8::1 是文档用途的公网
// IPv6 段，既不在 fe80::/10 也不在 fec0::/10 里。用 https：公网地址现在强制
// https（见下方 13.6），这里用 https 只是为了不让"公网强制 https"这条独立
// 规则干扰这条测的是"SSRF 黑名单没有误伤"这件事。
setSetting(AGENT_SETTINGS_KEYS.baseURL, 'https://[2001:db8::1]/');
assert.equal(loadAgentConfig().enabled, true, 'fe80::/10 与 fec0::/10 段之外的公网 IPv6 不应该被误伤');

// 11.6) 尾点 FQDN（"localhost."、"api.localhost."、"foo.local."）——WHATWG
//       URL 会原样保留 hostname 末尾这个点，但 DNS 侧解析结果与去掉点之后完
//       全相同。探针实测过这三种写法均被 ALLOW，等于换一种记号法就绕开了
//       刚补上的 *.localhost / *.local 拦截。
for (const host of [
  'http://LOCALHOST./v1',
  'http://api.localhost./v1',
  'http://foo.local./v1',
]) {
  setSetting(AGENT_SETTINGS_KEYS.baseURL, host);
  const rejected = loadAgentConfig();
  assert.equal(rejected.enabled, false, `baseURL=${host} 必须被拒绝（尾点 FQDN 与去掉尾点后解析到同一回环/内网地址）`);
}

// 12) deepseek-official 的 baseURL 只允许官方域名，不能被覆盖成任意第三方
//     host（否则等于把 deepseek 的 key 发给攻击者服务器）。
setSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'DEEPSEEK_API_KEY');
setSetting(AGENT_SETTINGS_KEYS.baseURL, 'https://attacker.example.com');
assert.equal(loadAgentConfig().enabled, false, 'deepseek-official 不得覆盖成非官方 baseURL');
// 官方域名本身必须仍然放行。
setSetting(AGENT_SETTINGS_KEYS.baseURL, 'https://api.deepseek.com');
assert.equal(loadAgentConfig().enabled, true, 'deepseek-official 官方域名必须放行');

// 13) 内网/回环判定的三类套壳绕过写法必须被拦——openai-completions 走
//     SSRF 风格拦截，provider 切回它才能触发这条分支（deepseek-official 靠
//     域名白名单本来就已经把这些堵死，这里专门测 isPrivateOrLoopbackHost）。
setSetting(AGENT_SETTINGS_KEYS.provider, 'openai-completions');
setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'MY_OPENAI_KEY');
for (const host of [
  'http://[::ffff:127.0.0.1]/', // IPv4-mapped IPv6，点分十进制形式
  'http://[::ffff:7f00:1]/', // 同上，Node 归一化后的十六进制形式
  'http://[fd00::1]/', // IPv6 ULA fc00::/7
  'http://[fc12::1]/',
  'http://100.64.0.1/', // CGNAT 100.64.0.0/10 起始
  'http://100.100.100.100/',
  'http://100.127.255.255/', // CGNAT 段末尾
]) {
  setSetting(AGENT_SETTINGS_KEYS.baseURL, host);
  const rejected = loadAgentConfig();
  assert.equal(rejected.enabled, false, `baseURL=${host} 必须被拒绝（内网/回环套壳绕过）`);
}
// 边界之外的地址必须仍然放行，确认没有误伤——100.128.0.1 已经在 CGNAT 段
// 之外，是合法公网地址。用 https：公网地址现在强制 https（见下方 13.6）。
setSetting(AGENT_SETTINGS_KEYS.baseURL, 'https://100.128.0.1/');
assert.equal(loadAgentConfig().enabled, true, 'CGNAT 段之外的 100.128.0.1 不应该被误伤');

// 13.5) 【红线回归】黑名单进一步补漏——云元数据主机名/*.internal 后缀、
//      IPv4-compatible IPv6（::a.b.c.d，与已经处理的 ::ffff:a.b.c.d 不同）、
//      0.0.0.0/8、RFC 2544 基准测试段 198.18.0.0/15。探针逐条实测过这五类
//      在补丁前均被 ALLOW。
for (const host of [
  'http://metadata.google.internal/v1', // GCP 元数据主机名——解析到 169.254.169.254
  'http://metadata.goog/v1', // 同一服务的别名域名
  'http://foo.metadata.goog/v1',
  'http://foo.internal/v1', // GCP/多家云厂商约定的内部专用后缀
  'http://[::127.0.0.1]/v1', // IPv4-compatible IPv6（弃用形态），归一化后是 [::7f00:1]
  'http://[::0.1.2.3]/v1', // 同上，嵌入的是非回环但仍属 0.0.0.0/8 的地址
  'http://0.1.2.3/v1', // 0.0.0.0/8（"this network"）
  'http://0.0.0.1/v1',
  'http://198.18.0.1/v1', // RFC 2544 基准测试段起始
  'http://198.19.255.255/v1', // 段末尾
]) {
  setSetting(AGENT_SETTINGS_KEYS.baseURL, host);
  const rejected = loadAgentConfig();
  assert.equal(rejected.enabled, false, `baseURL=${host} 必须被拒绝（黑名单补漏）`);
}
// 边界之外的地址必须仍然放行，确认没有误伤：198.18.0.0/15 段紧邻两侧的
// 198.17.255.255 与 198.20.0.0 都是合法公网地址；2001:db8::1 是不满足
// IPv4-compatible 展开条件的普通公网 IPv6，不应该被新加的展开逻辑误伤。用
// https：公网地址现在强制 https（见下方 13.6）。
for (const host of ['https://198.17.255.255/v1', 'https://198.20.0.0/v1', 'https://[2001:db8::1]/v1']) {
  setSetting(AGENT_SETTINGS_KEYS.baseURL, host);
  assert.equal(loadAgentConfig().enabled, true, `baseURL=${host} 不应该被误伤`);
}

// 13.6) 【红线回归】公网地址强制 https：内网/回环地址已经在别处整体拒绝，
//      能走到这一步判断的 host 按定义就是公网地址——key 会以明文 Bearer
//      头发出去，继续允许 http 就是让它在链路上明文传输。仓库自己在
//      android-v1.1.0（docs/CHANGES.md）已经立过同一条规则："公网强制
//      HTTPS，回环/RFC1918/.local 允许 HTTP 并明示"，这里同样的取舍更该
//      成立——不存在"内网强制 https 会误伤自签证书部署"这种顾虑，因为回环
//      /内网本来就已经被拒绝、走不到这条判断。
for (const host of ['http://api.example.com/v1', 'http://8.8.8.8/v1', 'http://[2001:db8::1]/v1']) {
  setSetting(AGENT_SETTINGS_KEYS.baseURL, host);
  const rejected = loadAgentConfig();
  assert.equal(rejected.enabled, false, `baseURL=${host} 公网地址走 http 必须被拒绝`);
  assert.match(rejected.error, /https/, `baseURL=${host} 的拒绝原因应该提到 https`);
}
// https 本身必须放行（不是"公网地址一律拒绝"，只是不接受 http）。
setSetting(AGENT_SETTINGS_KEYS.baseURL, 'https://api.example.com/v1');
assert.equal(loadAgentConfig().enabled, true, '公网地址用 https 必须放行');
// 回环/内网地址继续允许 http——这条规则只加在"公网"分支上，不改变既有的
// 内网自托管场景（例如局域网里自建的 OpenAI 兼容网关，本来就没有走公网）。
setSetting(AGENT_SETTINGS_KEYS.baseURL, 'http://192.168.1.50:8080/v1');
assert.equal(loadAgentConfig().enabled, false, '内网地址仍然按内网/回环规则拒绝');
assert.doesNotMatch(loadAgentConfig().error, /https/, '内网地址被拒绝的原因应该是内网/回环，不是缺 https');

// 14) apiKeyEnv 现在是可选高级项：留空且没有已存加密 key 时，enabled 判定
//     本身仍然是 true（provider/model/baseURL 齐全就够）——"有没有可用的
//     key"是 resolveAgentApiKey()/agentReady() 单独的职责，不是 enabled 门
//     的一部分（否则用户只填了 key、还没点开关时，界面上连"model 是否合
//     法"这类反馈都拿不到）。
clearAgentSettings();
setSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
setSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
setSetting(AGENT_SETTINGS_KEYS.model, 'deepseek-chat');
setSetting(AGENT_SETTINGS_KEYS.baseURL, 'https://api.deepseek.com');
setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, '');
result = loadAgentConfig();
assert.equal(result.enabled, true, 'apiKeyEnv 留空不应该让 enabled 判定失败');
assert.equal(result.apiKeyEnv, '');
assert.equal(result.canonicalKeyEnv, PROVIDER_CANONICAL_KEY_ENV['deepseek-official'], 'canonicalKeyEnv 必须是 provider 固定名，与用户是否填 apiKeyEnv 无关');

// 15) 取值优先级链：env 优先于已存加密 key；两者都没有则 none。
delete process.env.TEST_AGENT_CONFIG_ENV_KEY;
db.prepare('DELETE FROM settings WHERE key = ?').run(AGENT_SETTINGS_KEYS.apiKeyEncrypted);
assert.equal(getStoredApiKey(), null, '没有落库过加密 key 时 getStoredApiKey() 必须是 null');
assert.deepEqual(resolveAgentApiKey(result), { value: null, source: 'none' }, '两个来源都没有时必须是 none');
assert.deepEqual(agentKeyStatus(), { configured: false, keySource: 'none' });

setSetting(AGENT_SETTINGS_KEYS.apiKeyEncrypted, encryptSecret('sk-stored-only', resolveMasterKey()));
result = loadAgentConfig();
assert.deepEqual(resolveAgentApiKey(result), { value: 'sk-stored-only', source: 'stored' }, '只存了加密 key 时必须走 stored 分支');
assert.deepEqual(agentKeyStatus(), { configured: true, keySource: 'stored' });

setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'TEST_AGENT_CONFIG_ENV_KEY');
process.env.TEST_AGENT_CONFIG_ENV_KEY = 'sk-from-env';
result = loadAgentConfig();
assert.deepEqual(
  resolveAgentApiKey(result), { value: 'sk-from-env', source: 'env' },
  'env 与已存加密 key 同时存在时，env 必须优先——保证现有 Docker/桌面部署零改动继续工作'
);
assert.deepEqual(agentKeyStatus(), { configured: true, keySource: 'env' });
delete process.env.TEST_AGENT_CONFIG_ENV_KEY;

// 15.5) 【红线回归】resolveAgentApiKey() 自身必须复检格式/保留名——不能只
//      依赖调用方（loadAgentConfig() 那一条路）先校验过。src/routes/agent.js
//      与 src/routes/settings.js 都有裸读 settings 表 agent_api_key_env 行、
//      手搓 {apiKeyEnv} 直接传给 resolveAgentApiKey() 的消费者，跳过了
//      loadAgentConfig() 内部那层 isReservedEnvName() 校验；探针曾实测把
//      该行直接置成 ANJIAN_INTERNAL_KEY，这两个消费者都会把 anqi 自己的
//      内部密钥当模型 key 读出来。这里直接构造调用方可能传入的裸 config
//      对象（不经过 loadAgentConfig()），断言 resolveAgentApiKey() 本身
//      就会拒绝格式非法/保留名的 apiKeyEnv，回落到 stored（若有）或 none，
//      绝不读取该保留变量的值。
process.env.ANJIAN_INTERNAL_KEY = 'anqi-internal-key-must-never-leak';
assert.deepEqual(
  resolveAgentApiKey({ apiKeyEnv: 'ANJIAN_INTERNAL_KEY' }),
  { value: 'sk-stored-only', source: 'stored' },
  'apiKeyEnv 是保留名时，resolveAgentApiKey() 自己必须拒绝读取该环境变量，回落到 stored'
);
assert.deepEqual(
  resolveAgentApiKey({ apiKeyEnv: 'not a valid env name' }),
  { value: 'sk-stored-only', source: 'stored' },
  'apiKeyEnv 格式非法时同样必须被 resolveAgentApiKey() 自己拒绝，不当成变量名去读 process.env'
);
delete process.env.ANJIAN_INTERNAL_KEY;

// 16) 密文被篡改/主密钥换了都必须安全失败成 null，不抛到调用方炸掉整个
//     loadAgentConfig()/agentKeyStatus() 调用链。
setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, '');
setSetting(AGENT_SETTINGS_KEYS.apiKeyEncrypted, 'v1:not-a-real-nonce:not-a-real-tag:not-a-real-ciphertext');
assert.equal(getStoredApiKey(), null, '格式非法的密文必须安全失败为 null，不能抛出');
assert.deepEqual(agentKeyStatus(), { configured: false, keySource: 'none' });

// 17) enabled=false 时 agentKeyStatus() 必须直接判 none/false，不检查是否
//     存在已存 key（与 loadAgentConfig() 的短路是同一条红线）。
setSetting(AGENT_SETTINGS_KEYS.apiKeyEncrypted, encryptSecret('sk-should-not-matter', resolveMasterKey()));
setSetting(AGENT_SETTINGS_KEYS.enabled, 'false');
assert.deepEqual(agentKeyStatus(), { configured: false, keySource: 'none' }, 'enabled=false 时即使有已存 key 也必须判 none/false');

clearAgentSettings();
db.prepare('DELETE FROM settings WHERE key = ?').run(AGENT_SETTINGS_KEYS.apiKeyEncrypted);
console.log('agent config 自检全部通过');
