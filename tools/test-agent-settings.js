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
//
// 本文件末尾另有一段独立场景（"设置侧联动"），覆盖编排方人工验收发现的运行
// 时缺口：PUT 把 agent_enabled 关掉时,必须同步终止已经在跑的 live worker
// （settings.js 现在是工厂函数 createSettingsRouter(supervisor)，与
// src/routes/agent.js 的 createAgentRouter(supervisor) 同一种接线方式——见
// settings.js 顶部注释）。前半段沿用一个不带 supervisor 的路由实例（白名单
// 校验本身与 supervisor 无关，传 undefined 即可，settings.js 内部会判空跳过
// 联动），后半段单独起一个挂了真正 AgentSupervisor + FakeChild 的应用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

// ---- server.js 必须把「同一个」agentSupervisor 实例接进 createAgentRouter
//      与 createSettingsRouter ----
// 复审点出：settings↔supervisor 联动修复里真正让「关闭开关后 live worker
// 被杀」这条红线成立的那一行——server.js 里 `createSettingsRouter(agentSupervisor)`
// 这处 DI 接线——此前零机械覆盖。人工把它改成 `createSettingsRouter()`（漏
// 传参数）之后，本文件下方"设置侧联动"场景依旧全绿：那段测试自建了一个独
// 立 liveApp、自己手动 `createSettingsRouter(agentSupervisor)`，永远看不到
// server.js 真正怎么接线；真起服务器复测则会看到红线原样复发（子进程在关
// 闭开关后依然存活）。这里照抄 tools/test-electron-backend-env.js [3/3] 的
// 做法——对 server.js 源码做一次静态正则核验，而不是真的 fork 一次带真实
// DB_PATH/登录凭据的完整进程：createAgentRouter 与 createSettingsRouter 必
// 须被同一个标识符调用，且该标识符必须来自 `new AgentSupervisor(`——三处任
// 一处改名/漏传/换成两个不同实例，这里都会现形。
{
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const serverSrc = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');

  const supervisorCtorMatch = serverSrc.match(/const\s+(\w+)\s*=\s*new\s+AgentSupervisor\s*\(/);
  assert.ok(supervisorCtorMatch, 'server.js 必须有一行 `const xxx = new AgentSupervisor(...)` ——全进程唯一的 supervisor 实例');
  const supervisorVar = supervisorCtorMatch[1];

  const agentRouterMatch = serverSrc.match(/createAgentRouter\s*\(\s*(\w+)\s*\)/);
  assert.ok(agentRouterMatch, 'server.js 必须调用 createAgentRouter(...) 接线 agent 路由');
  assert.equal(agentRouterMatch[1], supervisorVar, `createAgentRouter() 必须传入 ${supervisorVar}（那个唯一的 AgentSupervisor 实例），实际传的是 "${agentRouterMatch[1]}"`);

  const settingsRouterMatch = serverSrc.match(/createSettingsRouter\s*\(\s*(\w*)\s*\)/);
  assert.ok(settingsRouterMatch, 'server.js 必须调用 createSettingsRouter(...) 接线 settings 路由');
  assert.equal(
    settingsRouterMatch[1], supervisorVar,
    `createSettingsRouter() 必须传入与 createAgentRouter 相同的 ${supervisorVar} 实例，实际传的是 "${settingsRouterMatch[1] || '(空)'}"——` +
    '漏传或传了另一个实例都会让 PUT /api/settings 关闭开关时找不到/管不到真正在跑的 live worker，编排方实测复现过的红线（关闭开关 14 分钟后 DSH 子进程仍在跑）会原样复发，而本文件下方"设置侧联动"场景因为自建了一个独立 liveApp、自己手动接线，抓不住这一类回归'
  );

  console.log('  [0/*] server.js 接线核验：createAgentRouter/createSettingsRouter 共用同一个 AgentSupervisor 实例：ok');
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-settings-'));
process.env.DB_PATH = path.join(scratch, 'agent-settings.db');

const { db } = await import('../src/db.js');
const { createSettingsRouter } = await import('../src/routes/settings.js');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { req.actor = 'settings-test'; next(); });
app.use('/api', createSettingsRouter(undefined));

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

// 轮询等待——FakeChild 的 'exit' 事件、supervisor 内部的异步收尾都不是同步
// 完成的，不能断言完之后立刻检查结果。
async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
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

  // ---- 能力档位 + trusted DSH plugin patch ----
  {
    const { status } = await put({ agent_capability_mode: 'danger-full-access' });
    assert.equal(status, 400);
  }
  {
    const { status } = await put({ agent_capability_mode: 'full' });
    assert.equal(status, 200);
  }
  // ---- 全局审批默认档：旧库缺键由 config 默认 1；设置面只允许 1/2/3 ----
  {
    const { status } = await put({ agent_approval_tier: '9' });
    assert.equal(status, 400);
  }
  {
    const { status } = await put({ agent_approval_tier: '3' });
    assert.equal(status, 200);
    assert.equal((await get()).agent_approval_tier, '3');
  }
  await put({ agent_approval_tier: '1' });
  {
    const { status } = await put({ agent_plugin_patch: 'relative.patch.yml' });
    assert.equal(status, 400);
  }
  const pluginPatch = path.join(scratch, 'trusted.cordis.patch.yml');
  fs.writeFileSync(pluginPatch, '[]\n');
  {
    const { status } = await put({ agent_plugin_patch: pluginPatch });
    assert.equal(status, 200);
    assert.equal((await get()).agent_plugin_patch, pluginPatch);
  }
  const pluginLink = path.join(scratch, 'linked.patch.yml');
  fs.symlinkSync(pluginPatch, pluginLink);
  {
    const { status } = await put({ agent_plugin_patch: pluginLink });
    assert.equal(status, 400, '插件 patch 不能通过符号链接换目标');
  }
  await put({ agent_plugin_patch: '', agent_capability_mode: 'project' });

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

  // ---- apiKeyEnv：格式 + 保留名/前缀（现在是可选高级项——非空值仍必须
  //      合法，但空字符串本身不再是非法输入，见下面单独一段） ----
  for (const bad of ['1BAD', 'has-dash', 'has space']) {
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
  // ---- apiKeyEnv 留空：设计 5 把它降级为可选高级项——公开版用户走「界面
  //      填 key」这条路，压根不需要碰环境变量；留空必须放行，且落库后 GET
  //      读回的是空字符串（不是拒绝、也不是保留旧值）。----
  {
    const { status } = await put({ agent_api_key_env: '' });
    assert.equal(status, 200, 'agent_api_key_env 留空必须放行——它现在是可选项，不是必填');
    assert.equal((await get()).agent_api_key_env, '', '留空应该落库成空字符串，不是被拒绝或保留旧值');
  }
  {
    const { status } = await put({ agent_api_key_env: 'MY_DEEPSEEK_KEY' });
    assert.equal(status, 200);
  }

  // ---- agent_api_key：明文入参，落库前加密，PUT/GET 响应体永不回显明文
  //      （只回掩码 + 布尔「已配置」+ 来源），且不得写超长输入 ----
  {
    const { status, data } = await put({ agent_api_key: 123 });
    assert.equal(status, 400, 'agent_api_key 非字符串必须拒绝');
    assert.match(data.error, /agent_api_key/);
  }
  {
    const { status, data } = await put({ agent_api_key: 'x'.repeat(5000) });
    assert.equal(status, 400, '超长 agent_api_key 必须拒绝');
    assert.match(data.error, /过长/);
  }
  {
    // apiKeyEnv 此刻已经落库成 MY_DEEPSEEK_KEY，但该环境变量在本测试进程里
    // 没有值——所以填了 agent_api_key 之后，resolveAgentApiKey() 应该走
    // stored 分支（env 优先但 env 为空时兜底），而不是被 env 名的存在挡住。
    delete process.env.MY_DEEPSEEK_KEY;
    const { status, data } = await put({ agent_api_key: 'sk-test-plaintext-abcd1234' });
    assert.equal(status, 200);
    assert.equal(data.agent_api_key_configured, true);
    assert.equal(data.agent_api_key_source, 'stored');
    assert.equal(data.agent_api_key_masked, '…1234', 'masked 只应该带末 4 位');
    assert.ok(
      !JSON.stringify(data).includes('sk-test-plaintext-abcd1234'),
      'PUT 响应体绝不能包含提交上去的明文 key'
    );
    const after = await get();
    assert.equal(after.agent_api_key_configured, true);
    assert.equal(after.agent_api_key_masked, '…1234');
    assert.ok(
      !Object.keys(after).includes('agent_api_key_encrypted'),
      'GET 响应体不应该带出 agent_api_key_encrypted 这一行的密文'
    );
    assert.ok(
      !JSON.stringify(after).includes('sk-test-plaintext-abcd1234'),
      'GET 响应体绝不能包含明文 key'
    );
  }
  // ---- env 优先于已存加密 key：给 MY_DEEPSEEK_KEY 赋值后，source 必须翻成 env ----
  {
    process.env.MY_DEEPSEEK_KEY = 'sk-from-env-value';
    const after = await get();
    assert.equal(after.agent_api_key_source, 'env', 'env 变量一旦有值，必须优先于已存的加密 key');
    assert.equal(after.agent_api_key_masked, '…alue');
    delete process.env.MY_DEEPSEEK_KEY;
  }
  // ---- 清空已存 key：提交空字符串必须能清掉，而不是被当成"不改动" ----
  {
    const { data } = await put({ agent_api_key: '' });
    assert.equal(data.agent_api_key_configured, false, '提交空字符串必须清空已存的 key');
    assert.equal(data.agent_api_key_source, 'none');
  }

  // ---- 【红线回归】agent_api_key 落库前必须 trim，且纯空白必须显式拒绝
  //      ----
  //      复制粘贴 key 时带上首尾空白/换行是最高频的用户错误：不 trim 的话
  //      这个错误会被静默存成密文，直到"实际调用"那一步才以一条完全误导
  //      的 network_error 表现出来（undici 拒绝带 \n 的请求头）；纯空白输
  //      入如果被静默接受成"已配置"，agentReady() 会判定为可用，但
  //      supervisor 实际会拿一把空白 key 去启动 worker。
  {
    // 纯空白（非空字符串，但 trim 后什么都不剩）必须 400，不是静默接受成
    // "已配置"或静默等价于清空。
    delete process.env.MY_DEEPSEEK_KEY;
    const before = await get();
    const { status, data } = await put({ agent_api_key: '   ' });
    assert.equal(status, 400, '纯空白 agent_api_key 必须拒绝');
    assert.match(data.error, /空白/);
    const after = await get();
    assert.equal(after.agent_api_key_configured, before.agent_api_key_configured, '拒绝的输入不应该改动已存的 key 状态');
  }
  {
    // 带首尾空白/换行的 key：落库前必须 trim，掩码/resolveAgentApiKey() 拿
    // 到的都应该是去掉空白之后的值——不能把换行也存进密文里。
    const { status, data } = await put({ agent_api_key: '  sk-paste-with-space-1234  \n' });
    assert.equal(status, 200);
    assert.equal(data.agent_api_key_configured, true);
    assert.equal(data.agent_api_key_masked, '…1234', '掩码必须是 trim 之后的末 4 位，不能带换行/空格');
    assert.ok(!JSON.stringify(data).includes('\\n'), 'PUT 响应体不应该带任何原始换行片段');
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

// ---- 设置侧联动：live worker 在设置页关闭 agent_enabled 时必须被真正终止 ----
// 上面那段只测白名单校验本身,注入的是 undefined supervisor(联动逻辑判空跳
// 过)。这里单独起一个挂了真正 AgentSupervisor + 一个只回放 JSON-RPC 协议帧
// 的 FakeChild 的应用,完整走一遍"起 live worker → PUT 设置关闭 →
// worker 真的被终止"这条链路——只在路由层/supervisor 层各自打桩,证明不了
// 两者接起来之后真的会联动,这里必须端到端验证到子进程这一级。这段是编排方
// 人工验收发现红线缺陷（DSH 子进程在关闭开关 14 分钟后仍在跑）的直接回归。
{
  const { AgentSupervisor } = await import('../src/agent/supervisor.js');
  const { AGENT_SETTINGS_KEYS: LIVE_KEYS } = await import('../src/agent/config.js');

  function setSetting(key, value) {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
  }

  const liveScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-settings-live-'));
  const filesRoot = path.join(liveScratch, 'files');
  fs.mkdirSync(filesRoot, { recursive: true });
  const caseName = `自检案-设置联动-${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(path.join(filesRoot, caseName));
  const caseId = db.prepare(
    `INSERT INTO cases (name, procedure, stage, status) VALUES (?, '一审', '', 'active')`
  ).run(caseName).lastInsertRowid;

  setSetting(LIVE_KEYS.enabled, 'true');
  setSetting(LIVE_KEYS.provider, 'deepseek-official');
  setSetting(LIVE_KEYS.model, 'deepseek-chat');
  setSetting(LIVE_KEYS.apiKeyEnv, 'TEST_AGENT_SETTINGS_LIVE_KEY');
  process.env.TEST_AGENT_SETTINGS_LIVE_KEY = 'not-a-real-key';
  process.env.ANJIAN_INTERNAL_KEY = 'not-a-real-internal-key';

  // 一份能通过宿主侧 isPreflightReady() 逐字段核验的 session/preflight 结果
  // ——形状照抄 tools/test-agent-supervisor.js 的 VALID_PREFLIGHT_RESULT,不
  // 重新发明；这里只需要 worker 能真正跑到 ready,不需要之后再跑 turn。
  const REQUIRED_MCP_TOOL = 'mcp__anqi-local__case_folder_info';
  const REQUIRED_SKILL_NAME = 'anqi-case-brief';
  const VALID_PREFLIGHT_RESULT = {
    ready: true,
    tools: { required: REQUIRED_MCP_TOOL, ready: true, visibleNames: [REQUIRED_MCP_TOOL] },
    skills: { complete: true, names: [REQUIRED_SKILL_NAME], ready: true },
  };

  // 只回放 JSON-RPC 协议帧,不是真的 DSH 子进程——同 tools/test-agent-
  // supervisor.js 的 FakeChild,本文件不共享那个模块内部定义,原样照抄一份。
  class FakeChild extends EventEmitter {
    constructor(onFrame) {
      super();
      this.pid = 4242424;
      this.exitCode = null;
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.killed = false;
      this.stdin.on('data', (chunk) => {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          onFrame(JSON.parse(line), this);
        }
      });
    }
    sendLine(obj) { this.stdout.write(`${JSON.stringify(obj)}\n`); }
    kill(signal) {
      this.killed = true;
      this.lastKillSignal = signal;
      setImmediate(() => this.emitExit(0, signal));
    }
    emitExit(code, signal) {
      if (this.exitCode !== null) return;
      this.exitCode = code;
      this.emit('exit', code, signal);
    }
  }

  const agentSupervisor = new AgentSupervisor({
    filesRoot,
    spawnFn: () => new FakeChild((frame, c) => {
      if (frame.method === 'initialize') {
        c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
      } else if (frame.method === 'session/create') {
        c.sendLine({ jsonrpc: '2.0', id: frame.id, result: { sessionId: frame.params.sessionId } });
      } else if (frame.method === 'session/preflight') {
        c.sendLine({ jsonrpc: '2.0', id: frame.id, result: VALID_PREFLIGHT_RESULT });
      } else if (frame.method === 'shutdown') {
        c.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
        // 退出必须异步于"写完响应"这一刻——真实子进程也是先把 shutdown 响应
        // 写进 stdout 管道，再退出，两者不是同一个事件循环节拍；如果这里跟
        // kill() 不一致地同步 emitExit()，'exit' 事件可能抢在 readline 把
        // 那行 stdout 交给 supervisor 之前就先触发 _handleExit()，让它抢先
        // 用 "exit code=0 signal=none" 这个通用文案落终态审计，_stopWorker()
        // 自己那次带着真正 reason（如 'disabled-by-settings'）的收尾调用则
        // 因为 _finalizeWorker 的幂等守卫变成 no-op——审计详情就再也追不回
        // 真正的关闭原因了。与下面 kill() 的 setImmediate 保持同一节奏，让
        // shutdown 响应先被消费，'exit' 事件仅仅是收尾时机上稍晚。
        setImmediate(() => c.emitExit(0, null));
      }
    }),
  });

  const startResult = await agentSupervisor.start(caseId);
  assert.equal(startResult.status, 'ready', `设置联动场景的 live worker 必须先成功进入 ready（实际 ${startResult.status}/${startResult.error}）`);
  const worker = agentSupervisor.workers.get(caseId);
  const child = worker.child;
  assert.equal(child.exitCode, null, '关闭设置之前子进程应该仍然存活');

  const liveApp = express();
  liveApp.use(express.json({ limit: '1mb' }));
  liveApp.use((req, res, next) => { req.actor = 'settings-live-test'; next(); });
  liveApp.use('/api', createSettingsRouter(agentSupervisor));
  const liveServer = http.createServer(liveApp);
  await new Promise((resolve) => liveServer.listen(0, '127.0.0.1', resolve));
  const liveBase = `http://127.0.0.1:${liveServer.address().port}`;

  try {
    const response = await fetch(`${liveBase}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_enabled: false }),
    });
    assert.equal(response.status, 200, 'PUT 关闭 agent_enabled 本身应该 200（设置落库与 worker 收尾是两回事，后者失败也不该让这次 PUT 报错）');

    const becameNotLive = await waitUntil(() => !['starting', 'ready', 'running'].includes(agentSupervisor.status(caseId).status));
    assert.equal(becameNotLive, true, 'PUT 关闭 agent_enabled 之后，live worker 必须真正离开 ready/running（红线：编排方实测复现过关闭开关 14 分钟后仍在跑的 DSH 子进程）');
    assert.equal(agentSupervisor.status(caseId).status, 'stopped', '联动关闭必须走正常 stop() 流程落 stopped 终态，不是 crashed/error');

    const wasKilledOrExited = await waitUntil(() => child.killed || child.exitCode !== null);
    assert.equal(wasKilledOrExited, true, '设置侧联动关闭之后，子进程必须被真正终止（kill 或收到 shutdown 后正常退出），不能只是状态标记改了但进程还活着');

    const auditRow = db.prepare(
      `SELECT action, detail FROM audit_log WHERE entity = 'agent-worker' AND entity_id = ? ORDER BY id DESC LIMIT 1`
    ).get(caseId);
    assert.ok(auditRow, '联动关闭必须留下一条 agent-worker 审计终态行');
    assert.equal(auditRow.action, 'agent-stopped', '终态审计动作必须是 agent-stopped（走的是正常 stop() 收尾，不是崩溃分支）');
    assert.match(auditRow.detail, /disabled-by-settings/, '终态审计详情必须能追溯到"设置侧联动关闭"，不是普通的手动 stop 原因');

    // POST /api/cases/:id/agent/start 命中这个刚被终止的旧 worker 记录时,
    // 不能因为记录还残留在 workers 表里就当"还活着"处理——这是本轮任务书要
    // 修的另一条红线（supervisor.start() 命中既存 live worker 分支时先返回
    // 旧状态、完全不看当下配置）。这里直接调用 supervisor.start() 复验：此
    // 时 worker 已经是 'stopped' 终态，不在 LIVE_STATUSES 里，会走到
    // _startWorker() 的常规 enabled 门（同样应判 disabled），而不是命中
    // "既存 live worker"这个分支——两条路径都指向同一个结论，这里只确认
    // 最终结果确实是 disabled，不深究具体走了哪一条分支。
    const restart = await agentSupervisor.start(caseId);
    assert.equal(restart.status, 'disabled', 'agent_enabled=false 之后再次 start() 必须返回 disabled，不能复用/暴露任何旧 worker 状态');
  } finally {
    liveServer.close();
    await agentSupervisor.stopAll('test cleanup: 设置联动场景收尾').catch(() => {});
    fs.rmSync(liveScratch, { recursive: true, force: true });
  }

  console.log('agent settings 侧联动测试通过：PUT 关闭 agent_enabled 后 live worker 被真正终止 + 落 stopped 终态 + audit 有 agent-stopped 行 + 再次 start() 仍返回 disabled');
}
