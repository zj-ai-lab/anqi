// DSH sidecar 设置白名单读取的最小自检：enabled 门、provider 白名单、
// baseURL 协议 + 无 userinfo 校验、apiKeyEnv 只是变量名（不读值）。
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { AGENT_SETTINGS_KEYS, loadAgentConfig } from '../src/agent/config.js';

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

clearAgentSettings();
console.log('agent config 自检全部通过');
