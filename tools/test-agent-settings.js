// /api/settings 的 agent_* 五键白名单回归（任务书 + 设计稿 §1/§5）：
//   - enabled 必须是布尔值（不是 'true' 字符串）；
//   - provider 只认白名单枚举；
//   - model 非空串；
//   - apiKeyEnv 必须是合法环境变量名，且不得是 anqi 自身的保留名/前缀
//     （复用 src/agent/config.js 的 isReservedEnvName，不是本文件重新判断）；
//   - baseURL 经由 src/agent/config.js 的 validateBaseURL() 校验（协议、
//     credential-free、内网/回环拦截、deepseek-official 官方域钉死），provider
//     切换时联动重新校验旧 baseURL；
//   - 校验失败整批 400、一个键都不落（事务原子性）；
//   - 非 agent_* 的既有六个字段不受影响，仍然自由字符串。
// 与 supervisor.js 启动时用的 loadAgentConfig() 共用同一份校验源码——本文件
// 只验证"设置路由真的调用了它、而不是自己重新发明一套更松的规则"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-settings-'));
process.env.DB_PATH = path.join(scratch, 'agent-settings.db');

const { db } = await import('../src/db.js');
const settingsRouter = (await import('../src/routes/settings.js')).default;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { req.actor = 'settings-test'; next(); });
app.use('/api', settingsRouter);

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function put(body) {
  const response = await fetch(base + '/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function get() {
  const response = await fetch(base + '/api/settings');
  return response.json();
}

try {
  // ---- enabled 必须是布尔值，字符串 'true' 拒绝 ----
  {
    const { status, data } = await put({ agent_enabled: 'true' });
    assert.equal(status, 400);
    assert.match(data.error, /布尔/);
  }
  {
    const { status } = await put({ agent_enabled: true });
    assert.equal(status, 200);
    assert.equal((await get()).agent_enabled, 'true');
  }
  {
    const { status } = await put({ agent_enabled: false });
    assert.equal(status, 200);
    assert.equal((await get()).agent_enabled, 'false');
  }

  // ---- provider 枚举 ----
  {
    const { status, data } = await put({ agent_provider: 'anthropic-official' });
    assert.equal(status, 400);
    assert.match(data.error, /agent_provider/);
  }
  {
    const { status } = await put({ agent_provider: 'deepseek-official' });
    assert.equal(status, 200);
  }

  // ---- model 非空 ----
  {
    const { status, data } = await put({ agent_model: '   ' });
    assert.equal(status, 400);
    assert.match(data.error, /agent_model/);
  }
  {
    const { status } = await put({ agent_model: 'deepseek-v4-flash' });
    assert.equal(status, 200);
    assert.equal((await get()).agent_model, 'deepseek-v4-flash');
  }

  // ---- apiKeyEnv：格式 + 保留名/前缀 ----
  for (const bad of ['1BAD', 'has-dash', 'has space', '']) {
    const { status } = await put({ agent_api_key_env: bad });
    assert.equal(status, 400, `应该拒绝非法环境变量名: ${JSON.stringify(bad)}`);
  }
  for (const reserved of ['ANJIAN_INTERNAL_KEY', 'ANQI_ANYTHING', 'DSH_FOO', 'PATH', 'NODE_ENV']) {
    const { status, data } = await put({ agent_api_key_env: reserved });
    assert.equal(status, 400, `应该拒绝保留名/前缀: ${reserved}`);
    assert.match(data.error, /保留/);
  }
  {
    const { status } = await put({ agent_api_key_env: 'MY_DEEPSEEK_KEY' });
    assert.equal(status, 200);
    assert.equal((await get()).agent_api_key_env, 'MY_DEEPSEEK_KEY');
  }

  // ---- baseURL：协议、凭据、内网/回环、deepseek-official 官方域 ----
  const badUrls = [
    'not a url',
    'ftp://example.com',
    'https://user:pass@example.com',
    'http://127.0.0.1:1234',
    'http://localhost',
    'http://10.0.0.5',
    'http://192.168.1.1',
    'http://foo.local',
  ];
  for (const bad of badUrls) {
    const { status, data } = await put({ agent_base_url: bad });
    assert.equal(status, 400, `应该拒绝非法 baseURL: ${bad}`);
    assert.match(data.error, /agent_base_url/);
  }
  // provider 当前是 deepseek-official（上面已经落库），非官方域即使协议/内网都合法也要拒绝
  {
    const { status, data } = await put({ agent_base_url: 'https://not-deepseek.example.com' });
    assert.equal(status, 400);
    assert.match(data.error, /deepseek-official/);
  }
  {
    const { status } = await put({ agent_base_url: 'https://api.deepseek.com' });
    assert.equal(status, 200);
    assert.equal((await get()).agent_base_url, 'https://api.deepseek.com');
  }

  // ---- provider 切换后联动重新校验旧 baseURL：换成 openai-completions 时，
  //      刚才落库的 https://api.deepseek.com 依然合法（不是 deepseek 专属域名限制）；
  //      但如果换成一个会让已存 baseURL 变得非法的 provider，必须整批拒绝。----
  {
    const { status } = await put({ agent_provider: 'openai-completions' });
    assert.equal(status, 200, 'openai-completions 对已存的 https://api.deepseek.com 没有域名限制，应该放行');
    assert.equal((await get()).agent_provider, 'openai-completions');
  }
  // 换回 deepseek-official 时，若同时不改 baseURL，旧值仍是 api.deepseek.com（上面测试链路里从未被换成别的值），应该放行
  {
    const { status } = await put({ agent_provider: 'deepseek-official' });
    assert.equal(status, 200);
  }
  // 现在把 baseURL 显式换成一个非官方域（此时 provider 仍是 deepseek-official，不额外传 agent_provider）——应该被拒绝，且不写脏值
  {
    const before = (await get()).agent_base_url;
    const { status } = await put({ agent_base_url: 'https://not-deepseek.example.com' });
    assert.equal(status, 400);
    assert.equal((await get()).agent_base_url, before, '校验失败不应该改动已落库的值');
  }

  // ---- 校验失败时整批不落：同一次 PUT 里夹带一个合法的非 agent 字段，agent 字段非法应该让整批 400，且合法字段也不落 ----
  {
    const before = await get();
    const { status } = await put({ name: '不应该落库的名字', agent_model: '   ' });
    assert.equal(status, 400);
    const after = await get();
    assert.equal(after.name, before.name, 'agent_* 校验失败时，同批次里的其它合法字段也不应该落库');
  }

  // ---- 既有六个人工字段不受影响：自由字符串，无格式校验 ----
  {
    const { status } = await put({ name: '方大状', phone: '13800000000' });
    assert.equal(status, 200);
    const after = await get();
    assert.equal(after.name, '方大状');
    assert.equal(after.phone, '13800000000');
  }

  // ---- GET 不返回任何 apiKeyEnv 之外的 key 值（本来就没有别的地方能存 key 值）----
  {
    const after = await get();
    assert.equal(after.agent_api_key_env, 'MY_DEEPSEEK_KEY');
    assert.ok(!Object.keys(after).some((k) => k.toLowerCase().includes('secret')));
  }

  console.log('agent settings 白名单测试全部通过：enabled 布尔 + provider 枚举 + model 非空 + apiKeyEnv 格式/保留名 + baseURL 协议/内网/官方域 + provider 联动 + 事务原子性');
} finally {
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
