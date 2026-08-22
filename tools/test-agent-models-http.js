// POST /api/agent/models 的路由层回归：provider/baseURL 输入校验（复用与
// 保存设置同一套 validateBaseURL，SSRF 拦截）、apiKey 取值优先级（请求体 >
// 仅 deepseek-official 才允许的 env/已存加密 key 回落）、错误码 → HTTP 状态
// 映射、审计与响应体绝不含 apiKey/明文。网络层本身（真实 fetch 解析/超时/
// 大小上限）已经在 tools/test-agent-models-client.js 用真实本地服务器覆盖
// 过。这里注入假 fetchModels（同 AgentSupervisor 的 spawnFn 依赖注入风格）
// 只验证路由自己的职责——不在这个文件里发起任何真实网络调用，顺带断言
// "baseURL 校验失败时压根没调用过 fetchModels"（防止校验被绕过/顺序颠倒）。
//
// 【2026-08-23 减法】此前这里还注入一个假 resolvePinnedAddress() 验证"连接
// 期 DNS 解析 + IP 钉住"这道闸门的接线（场景 3.5）——该层已随
// resolvePinnedAddress() 一起从 src/agent/config.js/src/routes/agent.js 整体
// 移除（理由见两处顶部注释），createAgentRouter() 也不再接受这个注入点，
// 场景 3.5 与相关断言已一并删除。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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

  // ---- 7.5) 【红线回归，2026-08-23 复审修复】openai-completions 下,
  //      apiKey 省略时一律拒绝——不再有任何"与已保存 baseURL 同源就自动
  //      回落"的路径。此前的实现把"这次请求的 baseURL 是否与 settings 表
  //      里当前的 agent_base_url 同源"当作信任凭据，但那个凭据本身就是同
  //      一个 PUT /api/settings 面可写的：复审探针实测复现了完整的两步攻
  //      击——① PUT 把 agent_base_url 改成攻击者自己的地址（只需
  //      agent_provider+agent_base_url 两个字段，不需要 model/key），
  //      "同源"判定立刻为真；② 省略 apiKey 的 POST /api/agent/models 就把
  //      已存的完整明文 key 发给攻击者服务器——且这一切在 agent_enabled=false
  //      时同样成立（该端点刻意不经过 enabled 门）。这里同时验证：修复后
  //      "同源"这条路径已经不存在（即使 baseURL 与已保存值完全一致，
  //      openai-completions 依然要求显式 apiKey）；deepseek-official 因为
  //      baseURL 钉死官方域、不是攻击者可写的值，继续允许省略 apiKey 回落。
  //      ----
  {
    setSetting(AGENT_SETTINGS_KEYS.provider, 'openai-completions');
    setSetting(AGENT_SETTINGS_KEYS.baseURL, 'https://saved.example.com/v1');
    setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, '');
    setSetting(AGENT_SETTINGS_KEYS.apiKeyEncrypted, encryptSecret('sk-openai-stored', resolveMasterKey()));

    // 7.5a) baseURL 与已保存的不同源（攻击者指定的任意地址）→ 拒绝回落，
    //       且从未把 key 发给 fetchModels。
    const before = fetchModels.calls.length;
    const untrusted = await postModels({
      provider: 'openai-completions',
      baseURL: 'https://totally-unrelated-attacker.example.com/v1',
    });
    assert.equal(untrusted.status, 400, '未提供 apiKey 时 openai-completions 必须拒绝');
    assert.equal(untrusted.data.code, 'api_key_required_for_custom_provider');
    assert.equal(fetchModels.calls.length, before, '不可信 baseURL 时不应该把已存/环境变量 key 交给 fetchModels');

    // 7.5b) 【完整攻击场景复现，修复后必须仍然被拒绝】baseURL 与已保存的
    //       完全同源——模拟攻击者刚用 PUT /api/settings 把 agent_base_url
    //       改成这个值之后紧接着发起的 POST。此前的实现在这里会放行（把
    //       它当"用户已经决定信任"），修复后不再有这条路径，必须仍然是
    //       400，不是 200。
    const sameAsSaved = await postModels({ provider: 'openai-completions', baseURL: 'https://saved.example.com/v1' });
    assert.equal(sameAsSaved.status, 400, '【回归】即使 baseURL 与已保存值完全同源，openai-completions 省略 apiKey 也必须拒绝——"同源"不再是信任凭据');
    assert.equal(sameAsSaved.data.code, 'api_key_required_for_custom_provider');
    assert.equal(fetchModels.calls.length, before, 'baseURL 同源也不应该把已存 key 交给 fetchModels');

    // 7.5c) 请求体自带 apiKey 依然放行（这条红线只挡"静默回落已存 key"，
    //       不挡"用户自己在这次请求里明确提供的 key"）。
    const withOwnKey = await postModels({
      provider: 'openai-completions',
      baseURL: 'https://totally-unrelated-attacker.example.com/v1',
      apiKey: 'sk-user-provided-explicitly',
    });
    assert.equal(withOwnKey.status, 200);
    assert.equal(fetchModels.calls[fetchModels.calls.length - 1].apiKey, 'sk-user-provided-explicitly');

    // 7.5d) deepseek-official：baseURL 钉死官方域，不是攻击者可写的值，
    //       继续允许省略 apiKey 回落到已存/环境变量 key（与场景 6/7 一致，
    //       这里用 openai-completions 的已存 key 混在同一个 settings 行里
    //       再切回 deepseek-official，确认切换 provider 不会把 openai 的
    //       已存 key 错误地带出来——deepseek-official 应该用它自己那一份
    //       已存 key，也就是场景 6/7 设置过的 'sk-from-env-var'/'sk-stored-in-db'
    //       所在的同一个 apiKeyEncrypted 行；这里只重新确认走的是 stored/env
    //       链路而不是被 7.5a-c 期间设置的 openai key 污染）。
    setSetting(AGENT_SETTINGS_KEYS.apiKeyEncrypted, encryptSecret('sk-deepseek-stored-after-switch', resolveMasterKey()));
    const officialFallback = await postModels({ provider: 'deepseek-official', baseURL: '' });
    assert.equal(officialFallback.status, 200);
    assert.equal(fetchModels.calls[fetchModels.calls.length - 1].apiKey, 'sk-deepseek-stored-after-switch', 'deepseek-official 应该继续允许省略 apiKey 回落到已存 key');

    // 复位，避免影响后续场景。
    setSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
    setSetting(AGENT_SETTINGS_KEYS.baseURL, '');
  }

  // ---- 8) fetchModels 抛出各类错误 → 正确映射 HTTP 状态码,且响应体来自
  //      error.message/error.code,不是路由层自己拼的文案。
  //      【2026-08-23 UX 缺陷修复，编排方人工验收发现】upstream_unauthorized
  //      的 expectStatus 从 401 改成 502——此前上游供应商认证失败（用户
  //      设置页填错一个字符的 API Key）也让本端点回 401，而
  //      public/js/api.js 的全局 fetch 封装把任何 401 一律当成"anqi 会话
  //      过期"直接跳 /login.html，用户永远看不到下面这句写好的中文提示。
  //      现在 401 专属 apiAuth 中间件（会话失效），本端点的任何错误分支都
  //      不再产出 401，见下面循环结束后的核心回归断言。 ----
  const errorCases = [
    { code: 'upstream_unauthorized', message: 'API Key 无效或无权限，请检查后重试', expectStatus: 502 },
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
    assert.notEqual(status, 401, `code=${code} 绝不应该让本端点回 401（401 专属 apiAuth 会话失效语义，见 public/js/api.js）`);
    assert.equal(data.code, code);
    assert.equal(data.error, message);
  }
  // 核心回归（本次修复的原始缺陷）：上游明确的认证类失败必须仍然携带
  // code:upstream_unauthorized 与原样的中文提示，但 HTTP 状态码本身绝不能
  // 是 401——否则前端会把它误判成 anqi 自己的会话过期。
  {
    fetchModels.setError(Object.assign(new Error('API Key 无效或无权限，请检查后重试'), { code: 'upstream_unauthorized' }));
    const { status, data } = await postModels({ provider: 'deepseek-official', baseURL: '', apiKey: 'sk-wrong' });
    assert.notEqual(status, 401, '上游 401/403 绝不能让 POST /api/agent/models 本身也回 401');
    assert.equal(data.code, 'upstream_unauthorized', '上游认证失败的机器可读 code 必须保留，前端据此展示而不是跳登录页');
    assert.equal(data.error, 'API Key 无效或无权限，请检查后重试', '中文提示原样保留');
  }
  fetchModels.setResult({ models: [] });

  // ---- 8.5) 前端纵深防御静态断言（public/js/api.js）——没有可独立测试的
  //      纯函数（判断逻辑内联在 api() 里），按任务要求改为静态断言：
  //      a) 401 分支必须先做一次"响应体是否带业务 code 字段"的判断，不能
  //         无条件跳登录页（回归此前的 bug：`if (res.status === 401) {
  //         location.href = ...}` 中间没有任何条件分支）；
  //      b) 判断条件必须锚定 code 字段本身（`body.code` / `.code`），不是
  //         随便找一个占位判断混过静态检查。 ----
  {
    const apiJsPath = path.join(ROOT, 'public/js/api.js');
    const apiJsSrc = fs.readFileSync(apiJsPath, 'utf8');
    const authBlockMatch = apiJsSrc.match(/if\s*\(\s*res\.status\s*===\s*401\s*\)\s*\{([\s\S]*?)\n\s*\}\n\s*if\s*\(\s*!res\.ok\s*\)/);
    assert.ok(authBlockMatch, 'public/js/api.js 必须存在 `if (res.status === 401) { ... }` 分支（紧接着 `if (!res.ok)`）');
    const authBlockBody = authBlockMatch[1];
    assert.match(authBlockBody, /body\s*\.\s*code/, '401 分支必须读取响应体的 code 字段做判断依据，而不是无条件处理');
    // 【回归红线】location.href 跳转必须被包在一个"条件里引用了 code 字段"
    // 的 if 语句块内部，不能是紧跟在 `if (res.status === 401) {` 之后、无
    // 任何条件判断就执行的第一行（那正是此前的 bug：`if (res.status===401)
    // { location.href = '/login.html'; ... }`，中间没有任何分支）。用嵌套
    // 正则而不是"取分支体第一行"这种位置判断——后者会被这个分支体开头新增
    // 的解释性注释行悄悄绕过，不是可靠的回归信号。
    assert.match(
      authBlockBody,
      /if\s*\([^)]*code[^)]*\)\s*\{[^}]*location\.href\s*=\s*['"]\/login\.html['"]/,
      '401 分支的 location.href 跳转必须被包在一个引用了 code 字段的条件判断里，不能是无条件跳转（回归此前的 bug）'
    );
  }

  // ---- 9) audit_log 里不含任何提交过的明文 apiKey ----
  {
    const rows = db.prepare(`SELECT detail FROM audit_log WHERE entity = 'agent-models'`).all();
    const joined = rows.map((r) => r.detail).join('\n');
    for (const leaked of ['sk-request-body-key', 'sk-stored-in-db', 'sk-from-env-var', 'sk-any', 'sk-openai-stored', 'sk-user-provided-explicitly', 'sk-deepseek-stored-after-switch']) {
      assert.ok(!joined.includes(leaked), `audit_log 不应该包含明文 key: ${leaked}`);
    }
  }

  console.log('agent models HTTP 路由测试全部通过：provider/baseURL(SSRF) 校验 + apiKey 取值优先级(请求体>env>stored) + 错误码映射(上游认证失败不再回 401) + 审计/响应体不含明文 key + 前端 401 判断静态回归');
} finally {
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
