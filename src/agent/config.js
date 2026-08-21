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
//   - baseURL 必须是不含凭据的 http/https 绝对地址。
import { db } from '../db.js';

const ALLOWED_PROVIDERS = new Set(['deepseek-official', 'openai-completions']);
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
