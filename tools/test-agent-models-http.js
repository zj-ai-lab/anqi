// POST /api/agent/models 的路由层回归：provider/baseURL 输入校验（复用与
// 保存设置同一套 validateBaseURL，SSRF 拦截）、apiKey 取值优先级（请求体 >
// 环境变量 > 已存加密 key）、错误码 → HTTP 状态映射、审计与响应体绝不含
// apiKey/明文。网络层本身（真实 fetch 解析/超时/大小上限）已经在
// tools/test-agent-models-client.js 用真实本地服务器覆盖过；这里注入一个
// 假 fetchModels（同 AgentSupervisor 的 spawnFn 依赖注入风格）只验证路由
// 自己的职责，顺带断言"baseURL 校验失败时压根没调用过 fetchModels"（防止
// 校验被绕过/顺序颠倒）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-models-http-'));
process.env.DB_PATH = path.join(scratch, 'agent-models-http.db');

const { db } = await import('../src/db.js');
const { createAgentRouter } = await import('../src/routes/agent.js');
const { AGENT_SETTINGS_KEYS } = await import('../src/agent/config.js');
const { encryptSecret, resolveMasterKey } = await import('../src/lib/secret-box.js');

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

// 假 supervisor：本文件不测 /agent/status 之外的任何端点，随便给个最小实现
// 满足 createAgentRouter() 的接口形状即可。
const fakeSupervisor = { publicStatus: () => ({ status: 'stopped' }) };

// 假 fetchModels：记录每次调用参数,按测试场景返回预设结果或抛出预设错误。
function makeFakeFetchModels() {
  const calls = [];
  let nextResult = { models: ['fake-model-a', 'fake-model-b'] };
  let nextError = null;
  const fn = async (args) => {
    calls.push(args);
    if (nextError) throw nextError;
    return nextResult;
  };
  fn.calls = calls;
  fn.setResult = (result) => { nextResult = result; nextError = null; };
  fn.setError = (error) => { nextError = error; };
  return fn;
}

const fetchModels = makeFakeFetchModels();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { req.actor = 'models-http-test'; next(); });
app.use('/api', createAgentRouter(fakeSupervisor, { fetchModels }));

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function postModels(body) {
  const response = await fetch(`${base}/api/agent/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data };
}

try {
  // ---- 1) provider 非法 → 400，且从未调用 fetchModels ----
  {
    const { status, data } = await postModels({ provider: 'anthropic-direct', baseURL: 'https://x.example.com', apiKey: 'sk-x' });
    assert.equal(status, 400);
    assert.match(data.error, /provider/);
    assert.equal(fetchModels.calls.length, 0, 'provider 非法时不应该调用 fetchModels');
  }

  // ---- 2) baseURL 未过 SSRF 校验 → 400，且从未调用 fetchModels（防止校验
  //      被绕过——这是与保存设置同一套 validateBaseURL()，见
  //      src/agent/config.js）----
  for (const badBaseURL of ['http://127.0.0.1:9999', 'http://localhost/v1', 'http://192.168.1.1', 'not a url', 'ftp://x.com']) {
    const { status, data } = await postModels({ provider: 'openai-completions', baseURL: badBaseURL, apiKey: 'sk-x' });
    assert.equal(status, 400, `应该拒绝非法/SSRF baseURL: ${badBaseURL}`);
    assert.ok(data.error);
    assert.equal(fetchModels.calls.length, 0, `baseURL 校验失败时不应该调用 fetchModels: ${badBaseURL}`);
  }

  // ---- 3) deepseek-official 的 baseURL 官方域钉死同样在这里生效 ----
  {
    const { status } = await postModels({ provider: 'deepseek-official', baseURL: 'https://attacker.example.com', apiKey: 'sk-x' });
    assert.equal(status, 400);
    assert.equal(fetchModels.calls.length, 0);
  }

  // ---- 4) 合法请求：apiKey 直接在请求体里给出,优先于任何已存配置 ----
  {
    fetchModels.setResult({ models: ['deepseek-chat', 'deepseek-reasoner'] });
    const { status, data } = await postModels({ provider: 'deepseek-official', baseURL: '', apiKey: 'sk-request-body-key' });
    assert.equal(status, 200);
    assert.deepEqual(data.models, ['deepseek-chat', 'deepseek-reasoner']);
    assert.equal(fetchModels.calls.length, 1);
    assert.equal(fetchModels.calls[0].apiKey, 'sk-request-body-key', 'apiKey 应该直接透传请求体里的值给 fetchModels');
    assert.equal(fetchModels.calls[0].baseURL, 'https://api.deepseek.com', 'baseURL 留空时 deepseek-official 应该自动带出官方域');
    assert.ok(!JSON.stringify(data).includes('sk-request-body-key'), '响应体不能包含 apiKey');
  }

  // ---- 5) apiKey 省略时,没有已存配置 → 400 api_key_missing,且不调用 fetchModels ----
  {
    const before = fetchModels.calls.length;
    const { status, data } = await postModels({ provider: 'deepseek-official', baseURL: '' });
    assert.equal(status, 400);
    assert.equal(data.code, 'api_key_missing');
    assert.equal(fetchModels.calls.length, before, 'apiKey 缺失时不应该调用 fetchModels');
  }

  // ---- 6) apiKey 省略时,回落到已存的加密 key(stored) ----
  {
    setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, '');
    setSetting(AGENT_SETTINGS_KEYS.apiKeyEncrypted, encryptSecret('sk-stored-in-db', resolveMasterKey()));
    const { status } = await postModels({ provider: 'deepseek-official', baseURL: '' });
    assert.equal(status, 200);
    const lastCall = fetchModels.calls[fetchModels.calls.length - 1];
    assert.equal(lastCall.apiKey, 'sk-stored-in-db', 'apiKey 省略时应该回落到已存的加密 key');
  }

  // ---- 7) apiKey 省略时,env 优先于已存加密 key(env 与 stored 同时存在) ----
  {
    setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'TEST_AGENT_MODELS_HTTP_KEY');
    process.env.TEST_AGENT_MODELS_HTTP_KEY = 'sk-from-env-var';
    const { status } = await postModels({ provider: 'deepseek-official', baseURL: '' });
    assert.equal(status, 200);
    const lastCall = fetchModels.calls[fetchModels.calls.length - 1];
    assert.equal(lastCall.apiKey, 'sk-from-env-var', 'env 与已存加密 key 同时存在时，env 必须优先');
    delete process.env.TEST_AGENT_MODELS_HTTP_KEY;
  }

  // ---- 8) fetchModels 抛出各类错误 → 正确映射 HTTP 状态码,且响应体来自
  //      error.message/error.code,不是路由层自己拼的文案 ----
  const errorCases = [
    { code: 'upstream_unauthorized', message: 'API Key 无效或无权限，请检查后重试', expectStatus: 401 },
    { code: 'upstream_not_found', message: '该地址未提供 /models 接口（404），请检查 baseURL', expectStatus: 404 },
    { code: 'upstream_error', message: '模型服务返回错误（HTTP 500）', expectStatus: 502 },
    { code: 'timeout', message: '连接模型服务超时，请检查网络与 baseURL', expectStatus: 504 },
    { code: 'network_error', message: '连接模型服务失败，请检查网络与 baseURL', expectStatus: 504 },
    { code: 'response_too_large', message: '模型服务返回内容过大，已中止', expectStatus: 502 },
    { code: 'invalid_upstream_json', message: '模型服务返回内容不是合法 JSON', expectStatus: 502 },
    { code: 'unrecognized_upstream_shape', message: '模型服务返回格式无法识别（既不是 {data:[...]} 也不是数组）', expectStatus: 502 },
  ];
  for (const { code, message, expectStatus } of errorCases) {
    fetchModels.setError(Object.assign(new Error(message), { code }));
    const { status, data } = await postModels({ provider: 'deepseek-official', baseURL: '', apiKey: 'sk-any' });
    assert.equal(status, expectStatus, `code=${code} 应该映射到 HTTP ${expectStatus}`);
    assert.equal(data.code, code);
    assert.equal(data.error, message);
  }
  fetchModels.setResult({ models: [] });

  // ---- 9) audit_log 里不含任何提交过的明文 apiKey ----
  {
    const rows = db.prepare(`SELECT detail FROM audit_log WHERE entity = 'agent-models'`).all();
    const joined = rows.map((r) => r.detail).join('\n');
    for (const leaked of ['sk-request-body-key', 'sk-stored-in-db', 'sk-from-env-var', 'sk-any']) {
      assert.ok(!joined.includes(leaked), `audit_log 不应该包含明文 key: ${leaked}`);
    }
  }

  console.log('agent models HTTP 路由测试全部通过：provider/baseURL(SSRF) 校验 + apiKey 取值优先级(请求体>env>stored) + 错误码映射 + 审计/响应体不含明文 key');
} finally {
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
