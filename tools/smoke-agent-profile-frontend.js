// 「用户中心 · AI 助理」设置面易用性改造的前端冒烟（任务书「你的任务」）：
//   a) 静态审查 public/profile.html：供应商下拉两项齐全、Base URL 只读提示、
//      API Key 密码输入框 + 掩码提示段、Model 手填/下拉双控件 + 拉取按钮 +
//      结果提示、apiKeyEnv 折进 <details class="adder">「高级选项」（默认
//      收起,即不带 open 属性）——不是散落在外层的一等字段;
//   b) 静态审查 public/js/profile.js：provider 切换联动 baseURL 只读/自动
//      带出、key 三态展示逻辑（env 禁用/stored 掩码/none 提示）都存在、
//      POST /agent/models 请求体的取值来源、PUT /settings 时"留空不修改
//      已保存 key"的分支确实存在（不会把空字符串当成"清空"信号误发）；
//      「清除已保存的 key」按钮（2026-08-23 复审新增）确实绑定了点击处理、
//      确实显式 PUT agent_api_key:''（与后端既有的"空字符串=清空"信号
//      同源，不是新协议），且只在 source==='stored' 时展示——此前界面只有
//      "留空提交=不修改"这一条路径，用户没有任何入口能把本机保存的加密
//      key 真正删掉，只能改库;
//   c) 起一个真实 server.js（固定端口 3013，ANJIAN_UNSAFE_NO_AUTH=1，临时
//      库）：验证 /api/settings 的 agent_api_key 明文入参 → 加密落库 →
//      GET 只回掩码这条链路在真实进程里成立，响应体全文不含明文 key；
//      验证 apiKeyEnv 优先级（env 有值时 source 翻成 'env'，掩码换成 env
//      值的末四位，同样不含明文）；
//   d) 起一个本地假 /models 服务器（node:http，OpenAI 兼容格式）：
//      d1) 直接调用 fetchProviderModels() 验证响应体确实能被解析成
//          profile.js 期待的 { models:[...] } 形状（与
//          tools/test-agent-models-client.js 同一手法，这里只是锚定"前端
//          期待的确实是这个函数产出的形状"，不重复它的超时/大小上限覆盖）；
//      d2) 对真实 3013 服务器发 POST /api/agent/models，baseURL 指向这个
//          假服务器的回环地址——预期被 SSRF 校验拒绝（400，"内网/回环"）。
//          这不是测试缺陷，是刻意断言：即使显式带了 apiKey，「拉取可用
//          模型」这个按钮打的端点也不会因为是配置期工具就放松 baseURL 的
//          安全校验（设计 4/门禁 9）——本仓库目前没有可控的公网 HTTPS 目标
//          能在冒烟里跑通"真实网络 + 通过路由层"的成功路径，这也是
//          tools/test-agent-models-http.js 改用依赖注入 fetchModels 而不是
//          真实网络的原因，这里保持同一约束、不试图绕过这条红线。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3013;
const BASE = `http://127.0.0.1:${PORT}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-profile-smoke-'));
const dbPath = path.join(scratch, 'smoke.db');

let step = 0;
const say = (msg) => console.log(`  [${++step}] ${msg}`);

// ---- a/b：静态审查 ----
const profileHtml = fs.readFileSync(path.join(ROOT, 'public/profile.html'), 'utf8');
const profileJs = fs.readFileSync(path.join(ROOT, 'public/js/profile.js'), 'utf8');

{
  assert.match(profileHtml, /id="agent-provider"[^>]*>[\s\S]*?value="deepseek-official"/, 'Provider 下拉必须有 deepseek-official 选项');
  assert.match(profileHtml, /value="openai-completions"/, 'Provider 下拉必须有 openai-completions 选项');
  assert.match(profileHtml, /id="agent-base-url"/, '必须有 Base URL 输入框');
  assert.match(profileHtml, /id="agent-base-url-note"/, '必须有「只读/官方地址」说明段');
  assert.match(profileHtml, /id="agent-api-key"[^>]*type="password"/, 'API Key 必须是密码输入框');
  assert.match(profileHtml, /id="agent-api-key-note"/, '必须有 API Key 状态说明段');
  assert.match(profileHtml, /id="agent-api-key-clear"/, '必须有「清除已保存的 key」按钮入口（2026-08-23 复审新增：此前界面无法真正删掉已存 key，只能改库）');
  assert.match(profileHtml, /id="agent-model"[^>]*>/, '必须保留手填 Model 输入框（兜底）');
  assert.match(profileHtml, /id="agent-model-select"/, '必须有 Model 下拉（拉取成功后展示）');
  assert.match(profileHtml, /id="agent-model-toggle"/, '必须有「改手动填写」切回入口');
  assert.match(profileHtml, /id="agent-fetch-models"/, '必须有「拉取可用模型」按钮');
  assert.match(profileHtml, /id="agent-models-status"/, '必须有拉取结果/错误提示段');
  say('profile.html：供应商/BaseURL/API Key/Model 拉取四组新控件齐全');

  // apiKeyEnv 必须折进 <details class="adder">「高级选项」，且不带 open——
  // 默认收起（设计 5）。用一段简单的子串区间检查：details 开标签到对应
  // </details> 之间必须包含 agent-api-key-env 这个 id。
  const detailsStart = profileHtml.indexOf('<details class="adder" id="agent-advanced">');
  assert.ok(detailsStart >= 0, '必须存在 id="agent-advanced" 的高级选项折叠区，且复用 details.adder 折叠样式');
  assert.doesNotMatch(profileHtml.slice(detailsStart, detailsStart + 60), /\bopen\b/, '高级选项默认必须是收起态（不带 open 属性）');
  const detailsEnd = profileHtml.indexOf('</details>', detailsStart);
  assert.ok(detailsEnd > detailsStart, '高级选项 details 必须闭合');
  const detailsBody = profileHtml.slice(detailsStart, detailsEnd);
  assert.match(detailsBody, /id="agent-api-key-env"/, 'apiKeyEnv 输入框必须在高级选项折叠区内部，不是外层一等字段');
  assert.match(detailsBody, /id="agent-plugin-patch"/, 'DSH 插件 patch 输入框必须在高级选项折叠区内部');
  assert.match(profileHtml, /id="agent-capability-mode"[\s\S]*?value="project"[\s\S]*?value="full"/, '必须提供 project/full 两档能力选择');
  say('profile.html：能力档位与 apiKeyEnv/plugin patch 高级选项齐全，默认收起');
}

{
  assert.match(profileJs, /function applyProviderUI/, 'profile.js 必须有 provider→baseURL 联动函数');
  assert.match(profileJs, /agentBaseUrl\.readOnly\s*=\s*isOfficial/, 'deepseek-official 时 baseURL 必须被设为只读');
  assert.match(profileJs, /function applyKeyUI/, 'profile.js 必须有 key 三态展示函数');
  assert.match(profileJs, /keySnapshot\.source === 'env'/, '必须区分 env 来源并禁用输入框');
  assert.match(profileJs, /agentApiKey\.disabled = true/, 'env 来源时必须禁用 API Key 输入框');
  assert.match(profileJs, /末四位/, '必须展示已保存 key 的掩码末四位提示');
  assert.match(profileJs, /api\('\/agent\/models', \{ method: 'POST', body \}\)/, '拉取模型必须调用 POST /agent/models');
  assert.match(profileJs, /if \(!agentApiKey\.disabled && keyInput\) body\.agent_api_key = keyInput;/, '保存时必须只在用户真正填了新 key 时才带上 agent_api_key（留空=不修改）');
  assert.match(profileJs, /agentApiKeyClear\.addEventListener\('click'/, '「清除已保存的 key」按钮必须绑定点击处理');
  assert.match(profileJs, /body:\s*\{\s*agent_api_key:\s*''\s*\}/, '清除按钮必须显式 PUT agent_api_key:\'\'（后端既有的清空信号，不是新协议）');
  assert.match(profileJs, /agentApiKeyClear\.hidden = keySnapshot\.source !== 'stored'/, '清除按钮只应该在 source===\'stored\' 时展示——env 态输入框本身禁用、none 态没有可清除的东西');
  assert.match(profileJs, /agent_plugin_patch:\s*agentPluginPatch\.value\.trim\(\)/, '保存完整配置时必须提交 DSH plugin patch 路径');
  assert.match(profileJs, /agent_capability_mode:\s*agentCapabilityMode\.value/, '保存完整配置时必须提交 project/full 能力档位');
  say('profile.js：provider 联动 / key 三态 / 拉取模型请求 / 保存时留空不覆盖 / 清除已保存 key 按钮，五条逻辑均命中');

  // 【2026-08-23 三次复审新增】POST /api/agent/models 收紧到"openai-completions
  // 一律要求显式 apiKey"之后（c40b042），前端必须跟着同步：(1) env 来源 +
  // openai-completions 时输入框不能再被无差别禁用；(2) 输入框为空且 provider
  // 不是 deepseek-official 时拉取按钮必须置灰 + 就地提示，而不是先发一次注定
  // 400 的请求。以下静态断言锚定这两条逻辑确实存在，不只是口头修复。
  assert.match(profileJs, /envLocksInput\s*=\s*keySnapshot\.source === 'env'\s*&&\s*provider === 'deepseek-official'/, 'env 态禁用输入框必须收窄到只对 deepseek-official 生效——openai-completions 下该 provider 的用户需要一次性输入口子');
  assert.match(profileJs, /function updateFetchGate/, '必须有一个统一的「拉取模型」按钮置灰/提示同步函数');
  assert.match(profileJs, /needsExplicitKey\s*=\s*provider !== 'deepseek-official'/, '必须识别"该 provider 需要显式 key"这条条件（与后端 api_key_required_for_custom_provider 同源）');
  assert.match(profileJs, /agentFetchBtn\.disabled\s*=\s*blocked/, '条件成立时必须真的把「拉取可用模型」按钮置灰,不能只是弹一次性提示');
  assert.match(profileJs, /agentApiKey\.addEventListener\('input', updateFetchGate\)/, '输入框内容变化必须实时重算按钮可用性,不能只在页面加载/保存时算一次');
  say('profile.js：openai-completions 下 env 来源不再无差别禁用输入框 + 拉取按钮按 provider/输入实时置灰，两条可用性回归修复均命中');

  // 【2026-08-23 UX 缺陷修复回归，编排方人工验收发现】拉取模型失败时，手填
  // Model 入口必须始终可达：
  //   (1) 首次拉取（此前从未成功过）时手填输入框本来就是 profile.html 里
  //       默认可见的一等控件（agent-model-label 不带 hidden，见上面 HTML
  //       静态审查），不依赖任何 JS 逻辑；
  //   (2) 已经成功拉取过一次、之后再次拉取又失败这条路径，此前下拉框会继续
  //       停留在旧列表、手填框保持折叠，用户还需要额外点一次「改手动填写」
  //       才能摸到手填入口——这里断言 catch 分支必须在下拉框仍展示时主动
  //       调用 showModelManual() 把手填框重新露出来，不能指望用户自己找到
  //       那枚切换按钮。
  // 用 catch/finally 这对锚点定位「拉取可用模型」按钮点击处理里的失败分支
  // ——不用括号计数/正则贪婪匹配（profile.js 里 `api('/agent/models', {
  // method: 'POST', body });` 这行本身就含有一个提前的 "});" 子串，天真地
  // 找第一个 "});" 会把捕获范围截断在 try 块中途,连 catch 都进不去）。
  const fetchHandlerStart = profileJs.indexOf("agentFetchBtn.addEventListener('click'");
  assert.ok(fetchHandlerStart >= 0, '必须存在「拉取可用模型」按钮的点击处理');
  const catchStart = profileJs.indexOf('} catch (e) {', fetchHandlerStart);
  const finallyStart = profileJs.indexOf('} finally {', catchStart);
  assert.ok(catchStart > fetchHandlerStart, '拉取模型点击处理必须有 catch 分支');
  assert.ok(finallyStart > catchStart, '拉取模型点击处理的 catch 分支后必须跟着 finally');
  const catchBody = profileJs.slice(catchStart, finallyStart);
  assert.match(catchBody, /if\s*\(\s*!agentModelSelectWrap\.hidden\s*\)\s*showModelManual\(\)/, '拉取失败时，若此刻仍在下拉模式，必须自动调用 showModelManual() 露出手填入口，不能让用户困在"旧下拉列表+折叠手填框"里');
  say('profile.js：拉取模型失败时手填 Model 入口自动露出（首次失败默认可见 + 二次失败自动切回手填）');
}

// ---- c：起真实 server.js，验证 settings 掩码往返在真实进程里成立 ----
const AGENT_TEST_KEY_ENV = 'SMOKE_PROFILE_FAKE_KEY';
const AGENT_TEST_KEY_VALUE = 'env-side-secret-value-zzzz';
const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    NODE_ENV: 'test',
    DB_PATH: dbPath,
    ANJIAN_UNSAFE_NO_AUTH: '1',
    [AGENT_TEST_KEY_ENV]: AGENT_TEST_KEY_VALUE,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

let modelsStubServer = null;

async function cleanup(exitCode) {
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve)).catch(() => {});
  if (modelsStubServer) await new Promise((resolve) => modelsStubServer.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
  if (exitCode) {
    console.error('---- server 日志 ----');
    console.error(serverLog);
  }
  process.exit(exitCode);
}
process.on('SIGINT', () => cleanup(1));

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch { /* 还没起来，继续等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server.js 在 10s 内没有起来');
}

try {
  await waitReady();
  say(`真实 server.js 已起（PORT=${PORT}，ANJIAN_UNSAFE_NO_AUTH=1，临时库）`);

  const putSettings = async (body) => {
    const r = await fetch(`${BASE}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, text, data: JSON.parse(text) };
  };
  const getSettings = async () => {
    const r = await fetch(`${BASE}/api/settings`);
    const text = await r.text();
    return { status: r.status, text, data: JSON.parse(text) };
  };

  // 界面填明文 key → 落库 → 响应体只回掩码，绝不含明文。
  const PLAINTEXT_KEY = 'sk-smoke-test-not-real-abcd1234';
  {
    const { status, text, data } = await putSettings({
      agent_enabled: true,
      agent_provider: 'deepseek-official',
      agent_model: 'deepseek-chat',
      agent_base_url: 'https://api.deepseek.com',
      agent_api_key: PLAINTEXT_KEY,
    });
    assert.equal(status, 200, `PUT 应该成功，实际：${text}`);
    assert.equal(data.agent_api_key_configured, true);
    assert.equal(data.agent_api_key_source, 'stored');
    assert.equal(data.agent_api_key_masked, `…${PLAINTEXT_KEY.slice(-4)}`);
    assert.ok(!text.includes(PLAINTEXT_KEY), 'PUT 响应体全文绝不能包含明文 key');
    assert.ok(!Object.keys(data).some((k) => k.includes('encrypted')), '响应体不应该带出 agent_api_key_encrypted 这一行');
  }
  {
    const { text, data } = await getSettings();
    assert.equal(data.agent_api_key_configured, true);
    assert.equal(data.agent_api_key_source, 'stored');
    assert.equal(data.agent_api_key_masked, `…${PLAINTEXT_KEY.slice(-4)}`);
    assert.ok(!text.includes(PLAINTEXT_KEY), 'GET 响应体全文绝不能包含明文 key');
  }
  say('agent_api_key 明文入参 → 加密落库 → GET/PUT 只回掩码，响应体全文不含明文（真实进程实测）');

  // apiKeyEnv 优先级：环境变量有值时 source 翻成 'env'，掩码换成 env 值的
  // 末四位；env 值同样不出现在响应体里（即使我们自己在测试里知道它是什
  // 么）。
  {
    const { status, text, data } = await putSettings({ agent_api_key_env: AGENT_TEST_KEY_ENV });
    assert.equal(status, 200, `PUT apiKeyEnv 应该成功，实际：${text}`);
    assert.equal(data.agent_api_key_source, 'env', 'apiKeyEnv 指向的环境变量有值时，source 必须翻成 env（优先级高于已存 key）');
    assert.equal(data.agent_api_key_masked, `…${AGENT_TEST_KEY_VALUE.slice(-4)}`);
    assert.ok(!text.includes(AGENT_TEST_KEY_VALUE), '响应体不能包含 env 值的明文');
    assert.ok(!text.includes(PLAINTEXT_KEY), '切到 env 来源后，响应体也不应该意外带出此前存的界面 key 明文');
  }
  say('apiKeyEnv 优先级：环境变量有值时 source=env 且掩码/来源正确，明文全程不出现在响应体里');

  // 留空清空：显式传 agent_api_key:'' 是「清空已存 key」的信号（与「不出现
  // 这个键」的「不修改」语义分开）——先清掉 apiKeyEnv 让优先级链回落到本机
  // 存储，再验证清空后 configured 翻 false。
  {
    await putSettings({ agent_api_key_env: '' });
    const { data } = await putSettings({ agent_api_key: '' });
    assert.equal(data.agent_api_key_configured, false, '显式传空字符串清空已存 key 后，configured 必须翻 false');
    assert.equal(data.agent_api_key_source, 'none');
  }
  say('显式传空字符串清空已存 key：configured 回落 false、source 回落 none');

  // ---- d：本地假 /models 服务器 ----
  const stubModels = [{ id: 'stub-model-a', object: 'model' }, { id: 'stub-model-b', object: 'model' }];
  modelsStubServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: stubModels }));
  });
  await new Promise((resolve) => modelsStubServer.listen(0, '127.0.0.1', resolve));
  const stubPort = modelsStubServer.address().port;
  const stubBaseURL = `http://127.0.0.1:${stubPort}/v1`;

  // d1：直接验证 fetchProviderModels() 解析出的形状与 profile.js 期待的
  // { models:[...] } 一致——锚定"前端拿到的确实是这个函数产出的形状"，不
  // 重复 tools/test-agent-models-client.js 已经覆盖过的超时/大小上限等。
  {
    const { fetchProviderModels } = await import('../src/agent/models-client.js');
    const result = await fetchProviderModels({ baseURL: stubBaseURL, apiKey: 'stub-model-key' });
    assert.deepEqual(result.models, ['stub-model-a', 'stub-model-b']);
  }
  say('本地假 /models 服务器（OpenAI 兼容格式）→ fetchProviderModels() 解析出 profile.js 期待的 { models:[...] } 形状');

  // d2：对真实运行中的 3013 服务器发 POST /api/agent/models，baseURL 指向
  // 这个假服务器的回环地址——即使显式带上 apiKey，也必须被 SSRF 校验拒绝，
  // 不能因为这是"配置期工具"就放行内网/回环目标（设计 4 红线）。
  {
    const r = await fetch(`${BASE}/api/agent/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai-completions', baseURL: stubBaseURL, apiKey: 'stub-model-key' }),
    });
    const data = await r.json();
    assert.equal(r.status, 400, 'POST /api/agent/models 对回环地址必须 400');
    assert.match(data.error, /内网\/回环/, '错误消息必须点明是内网/回环地址被拒绝');
  }
  say('POST /api/agent/models 对本地假服务器（回环地址）正确 400 拒绝——即使显式带 apiKey，「拉取模型」也不会绕开 SSRF 校验');

  console.log('AI 助理设置面前端冒烟全部通过 ✅');
  await cleanup(0);
} catch (error) {
  console.error('❌', error.message);
  await cleanup(1);
}
