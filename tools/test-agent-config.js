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
const { AGENT_SETTINGS_KEYS, loadAgentConfig } = await import('../src/agent/config.js');

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
//       fe80::/10——探针曾用 http://api.localhost/v1 实测被 ALLOW（之前只挡了
//       裸 'localhost' 和 *.local，没覆盖这个同样常见的后缀）；fe80::/10 之前
//       只挡了 ULA fc00::/7，同样漏了。
for (const host of [
  'http://api.localhost/v1',
  'http://foo.bar.localhost:8080/',
  'http://[fe80::1]/',
  'http://[fe80::abcd:1234]/',
  'http://[febf:ffff::1]/', // fe80::/10 段末尾
]) {
  setSetting(AGENT_SETTINGS_KEYS.baseURL, host);
  const rejected = loadAgentConfig();
  assert.equal(rejected.enabled, false, `baseURL=${host} 必须被拒绝（.localhost 后缀 / fe80::/10 链路本地）`);
}
// 边界之外的地址必须仍然放行，确认没有误伤——fec0:: 已经在 fe80::/10 之外。
setSetting(AGENT_SETTINGS_KEYS.baseURL, 'http://[fec0::1]/');
assert.equal(loadAgentConfig().enabled, true, 'fe80::/10 段之外的 fec0:: 不应该被误伤');

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
// 之外，是合法公网地址。
setSetting(AGENT_SETTINGS_KEYS.baseURL, 'http://100.128.0.1/');
assert.equal(loadAgentConfig().enabled, true, 'CGNAT 段之外的 100.128.0.1 不应该被误伤');

clearAgentSettings();
console.log('agent config 自检全部通过');
