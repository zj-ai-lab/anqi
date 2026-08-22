// POST /api/agent/models 的路由层回归：provider/baseURL 输入校验（复用与
// 保存设置同一套 validateBaseURL，SSRF 拦截）、连接期 DNS 解析+IP 钉住
// （resolvePinnedAddress()）的接线、apiKey 取值优先级（请求体 > 仅
// deepseek-official 才允许的 env/已存加密 key 回落）、错误码 → HTTP 状态
// 映射、审计与响应体绝不含 apiKey/明文。网络层本身（真实 fetch 解析/超时/
// 大小上限/pinnedAddress 连接机制）已经在 tools/test-agent-models-client.js
// 用真实本地服务器覆盖过；DNS 解析规则本身（任意一条私网地址即整体拒绝）
// 已经在 tools/test-agent-config.js 用注入的假 lookupImpl 覆盖过。这里注入
// 假 fetchModels 与假 resolvePinnedAddress（同 AgentSupervisor 的 spawnFn
// 依赖注入风格）只验证路由自己的职责——不在这个文件里发起任何真实网络/DNS
// 调用，顺带断言"baseURL 校验/DNS 钉住失败时压根没调用过 fetchModels"（防止
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

// 假 resolvePinnedAddress：默认对任何 hostname 都放行（返回一个固定的假
// 公网地址），让本文件其余场景专注测试路由自己的逻辑（apiKey 取值优先级/
// 错误映射/审计），不必依赖真实 DNS。可以用 setResult() 切到拒绝态，验证
// 路由层确实调用了这道闸门、拒绝时正确 400 且从未调用 fetchModels——真实
// DNS 解析规则本身（任意一条私网地址即整体拒绝）由 tools/test-agent-
// config.js 单独覆盖，不在这里重复。
function makeFakeResolvePinnedAddress() {
  const calls = [];
  // addresses：resolvePinnedAddress() 现在还带回全部通过校验的候选地址
  // （2026-08-23 四次复审新增，见 src/agent/config.js 顶部注释）——路由层
  // 把整个数组转交给 fetchModels() 的 pinnedAddresses 参数,这里的假实现同
  // 步带上这个字段,不只是 address/family 两个向后兼容字段。
  let nextResult = { ok: true, address: '203.0.113.1', family: 4, addresses: [{ address: '203.0.113.1', family: 4 }] };
  const fn = async (hostname) => {
    calls.push(hostname);
    return nextResult;
  };
  fn.calls = calls;
  fn.setResult = (result) => { nextResult = result; };
  return fn;
}

const resolvePinnedAddress = makeFakeResolvePinnedAddress();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { req.actor = 'models-http-test'; next(); });
app.use('/api', createAgentRouter(fakeSupervisor, { fetchModels, resolvePinnedAddress }));

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

  // ---- 3.5) 【红线回归，2026-08-23 复审新增】连接期 DNS 解析 + IP 钉住的
  //      接线：字符串校验（validateBaseURL）本身放行的 baseURL，如果
  //      resolvePinnedAddress() 判定解析结果落在内网/回环（模拟一个字符串
  //      看起来合法、DNS 却指向 127.0.0.1 的公网域名，如复审探针实测的
  //      `localtest.me`），路由必须整体拒绝，且从未调用 fetchModels——不能
  //      因为字符串校验已经通过就跳过这道第二层闸门。 ----
  {
    resolvePinnedAddress.setResult({ ok: false, error: 'baseURL 解析后指向内网/回环地址，已拒绝（该域名可能被指向了本机或内网 IP）' });
    const before = fetchModels.calls.length;
    const { status, data } = await postModels({ provider: 'openai-completions', baseURL: 'https://looks-public-but-resolves-private.example.com/v1', apiKey: 'sk-x' });
    assert.equal(status, 400, 'DNS 钉住判定为内网/回环时必须整体拒绝，即使字符串校验已经通过');
    assert.match(data.error, /内网|回环/);
    assert.equal(fetchModels.calls.length, before, 'DNS 钉住拒绝时不应该调用 fetchModels');
    assert.ok(resolvePinnedAddress.calls.includes('looks-public-but-resolves-private.example.com'), '路由必须真的调用了 resolvePinnedAddress()，不是摆设');
    resolvePinnedAddress.setResult({ ok: true, address: '203.0.113.1', family: 4, addresses: [{ address: '203.0.113.1', family: 4 }] }); // 复位
  }

  // ---- 4) 合法请求：apiKey 直接在请求体里给出,优先于任何已存配置；实际
  //      连接目标（pinnedAddresses）必须来自 resolvePinnedAddress() 的返回
  //      值，原样透传给 fetchModels()（2026-08-23 四次复审：从单地址
  //      pinnedAddress 换成全部候选地址 pinnedAddresses——路由层只取每条
  //      候选的 address 字符串，family 目前没有消费方需要，见 src/routes/
  //      agent.js 该处注释）----
  {
    fetchModels.setResult({ models: ['deepseek-chat', 'deepseek-reasoner'] });
    const { status, data } = await postModels({ provider: 'deepseek-official', baseURL: '', apiKey: 'sk-request-body-key' });
    assert.equal(status, 200);
    assert.deepEqual(data.models, ['deepseek-chat', 'deepseek-reasoner']);
    assert.equal(fetchModels.calls.length, 1);
    assert.equal(fetchModels.calls[0].apiKey, 'sk-request-body-key', 'apiKey 应该直接透传请求体里的值给 fetchModels');
    assert.equal(fetchModels.calls[0].baseURL, 'https://api.deepseek.com', 'baseURL 留空时 deepseek-official 应该自动带出官方域');
    assert.deepEqual(fetchModels.calls[0].pinnedAddresses, ['203.0.113.1'], 'resolvePinnedAddress() 解析出的候选地址列表必须原样（只取 address）传给 fetchModels()');
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
    for (const leaked of ['sk-request-body-key', 'sk-stored-in-db', 'sk-from-env-var', 'sk-any', 'sk-openai-stored', 'sk-user-provided-explicitly', 'sk-deepseek-stored-after-switch']) {
      assert.ok(!joined.includes(leaked), `audit_log 不应该包含明文 key: ${leaked}`);
    }
  }

  console.log('agent models HTTP 路由测试全部通过：provider/baseURL(SSRF) 校验 + apiKey 取值优先级(请求体>env>stored) + 错误码映射 + 审计/响应体不含明文 key');
} finally {
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
