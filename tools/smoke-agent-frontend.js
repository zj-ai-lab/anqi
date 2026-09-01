// 前端行为冒烟（任务书 3）：起一个真实 server.js（ANJIAN_UNSAFE_NO_AUTH=1、
// 临时库、固定端口 3009），用 node 脚本直接断言——不依赖浏览器/Playwright：
//   a) counts.agent=false（默认未启用）时，案件页静态 HTML 不含任何硬编码的、
//      脱离 /api/counts 特性探测的助理入口标记——只有一个初始为空的挂载点
//      #agent-entry-slot，真正的入口按钮完全由 js/agent-drawer.js 在运行时
//      按 counts.agent 决定要不要塞进去（本脚本是纯 HTTP 客户端，看不到浏览器
//      执行 JS 之后的 DOM，所以断言的是"静态标记不可能提前泄露入口"这个更强
//      的不变量，而不是等价的"渲染后 DOM 里没有按钮"）；
//   b) agent-drawer.js 源码里，counts.agent 的特性探测门必须严格出现在
//      「往 #agent-entry-slot 塞入口按钮」这行代码之前——静态审查 (a) 的前提
//      不是巧合，是这行代码顺序保证的（SSE 帧到 DOM 映射的静态审查之一）；
//   c) /api/settings 的 agent_* 五键往返：先确认默认 counts.agent=false，PUT
//      五键启用后 GET 能读回同样的值，且 /api/counts 的 agent 立刻变 true
//      （apiKeyEnv 指向的变量在本脚本进程里确实有值）；关掉 enabled 后
//      counts.agent 立刻回落 false；
//   d) SSE 帧到 DOM 的映射：FakeChild 探针基建（tools/test-agent-supervisor.js
//      的 startFakeWorker）钉死在同进程内 monkey-patch supervisor 的 spawnFn，
//      没有 HTTP 边界可跨——无法接到本脚本 spawn 的这个独立 server.js 进程
//      上，所以这一项做静态审查：核对 agent-drawer.js 里監聽的每个 SSE 事件
//      类型（status/worker/ready/turn/start/turn/end/worker/exit/
//      assistant/chunk/assistant/message/tool/call/tool/result/
//      interaction/pending/interaction/expired）都能在 src/routes/agent.js +
//      src/agent/supervisor.js 里找到对应的真实广播来源，确保前端监听的事件
//      名不是凭空编造、后端确实会发这些帧。
//      完整档命令另新增 command/run/command/done，同样必须命中真实广播源。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3009;
const BASE = `http://127.0.0.1:${PORT}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-frontend-smoke-'));
const dbPath = path.join(scratch, 'smoke.db');

let step = 0;
const say = (msg) => console.log(`  [${++step}] ${msg}`);

// ---- a/b：静态审查（不需要真实服务器，先做，快速失败）----
{
  const caseHtml = fs.readFileSync(path.join(ROOT, 'public/case.html'), 'utf8');
  assert.match(caseHtml, /<span id="agent-entry-slot">\s*<\/span>/, 'case.html 必须有一个初始为空的 #agent-entry-slot 挂载点');
  // 反面断言：静态 HTML 里不能出现任何看起来像"已经渲染出来的入口按钮"的
  // 文本/类名——真正出现的唯一渠道应该是运行时 JS 往 #agent-entry-slot 塞
  // 一个 <button>，不该在源文件里就写死。
  const staticLeakMarkers = [/class="agent-drawer"/, /id="agent-entry-btn"/, />\s*AI 助理\s*<\/button>/];
  for (const marker of staticLeakMarkers) {
    assert.doesNotMatch(caseHtml, marker, `case.html 静态源码不应包含 ${marker}——助理入口只能由 JS 运行时按 counts.agent 决定是否渲染`);
  }
  say('case.html 静态源码：只有空挂载点，没有硬编码的助理入口标记');

  const drawerJs = fs.readFileSync(path.join(ROOT, 'public/js/agent-drawer.js'), 'utf8');
  const gateIdx = drawerJs.indexOf('if (!counts.agent) return;');
  const mountIdx = drawerJs.indexOf('slot.replaceChildren(entryBtn);');
  assert.ok(gateIdx >= 0, 'agent-drawer.js 必须有 counts.agent 特性探测门');
  assert.ok(mountIdx >= 0, 'agent-drawer.js 必须有把入口按钮塞进 #agent-entry-slot 的那一行');
  assert.ok(gateIdx < mountIdx, 'counts.agent 门必须在挂载入口按钮之前——否则 counts.agent=false 时静态 HTML 断言 (a) 就不成立');
  say('agent-drawer.js 源码：counts.agent 门确实挡在挂载入口按钮之前（(a) 的不变量由此保证，不是巧合）');

  // 斜杠菜单必须完全由当前案件 worker 的 HTTP 清单驱动：源码里有唯一的清单
  // 路由请求，但不出现任何产品命令名字面量；4xx/空数组均主动隐藏菜单。键盘
  // 和点选补全的四个入口也逐项钉住，避免只做了鼠标可点的“半个菜单”。
  assert.ok(
    drawerJs.includes('fetch(`/api/cases/${caseId}/agent/commands`'),
    '输入斜杠后必须向当前案件命令清单路由取数据',
  );
  assert.doesNotMatch(
    drawerJs,
    /\/(?:compact|goal|feedback|plan)(?=[\s'"`])/u,
    '前端不得硬编码任何已知命令名，菜单项只能来自服务端 descriptors',
  );
  assert.match(drawerJs, /response\.status >= 400 && response\.status < 500[\s\S]*?state\.commands = \[\]/u);
  assert.match(drawerJs, /state\.commands\.length === 0[\s\S]*?hideCommandMenu\(\)/u);
  assert.match(drawerJs, /state\.commands\.filter\(\(command\) => command\.name\.startsWith\(prefix\)\)/u);
  for (const key of ['ArrowDown', 'ArrowUp', 'Tab']) {
    assert.ok(drawerJs.includes(`event.key === '${key}'`), `命令菜单缺少 ${key} 键处理`);
  }
  assert.match(drawerJs, /onclick: \(\) => completeCommand\(command\)/u, '命令菜单缺少点选补全');
  const styleCss = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
  for (const selector of ['.agent-command-menu', '.agent-command-option', '.agent-command-name']) {
    assert.ok(styleCss.includes(selector), `命令菜单样式缺少 ${selector}`);
  }
  say('斜杠菜单静态审查：服务端清单驱动、命令名零硬编码、4xx/空清单不渲染、上下键+Tab+点选补全均存在');

  // SSE 帧到 DOM 的映射静态审查：前端监听的每个事件类型，后端必须有真实广播
  // 来源——但"广播来源"分两种形状，不能用同一条正则一把抓：
  //   ① supervisor 自己的生命周期事件（worker/ready、turn/start、turn/end、
  //     worker/exit、interaction/pending、interaction/expired）+ agent.js
  //     路由单独 send() 的首帧 'status'：这几个类型名在源码里是字面量，能直接
  //     grep 到 `emit('<type>'`；
  //   ② 子进程 wire 事件（assistant/chunk、assistant/message、tool/call、
  //     tool/result 等）：supervisor.js 用一个动态变量转发
  //     `worker.emit(wireType, ...)`（wireType 来自子进程自己的
  //     event.type，见该行上方注释），源码里天然找不到这些类型名的字面量
  //     emit() 调用——这类广播来源要反过来证明：a) 通用转发调用点确实存在；
  //     b) 前端监听的这个类型名本身是 DSH 运行时依赖真实会产出的事件名（不是
  //     臆造的），后者靠 grep runtime 依赖自己的源码里有没有这个字符串字面量
  //     （已在写这个脚本之前用 grep 实测核对过，见文件头注释）。
  const supervisorJs = fs.readFileSync(path.join(ROOT, 'src/agent/supervisor.js'), 'utf8');
  const agentRouteJs = fs.readFileSync(path.join(ROOT, 'src/routes/agent.js'), 'utf8');
  const backend = supervisorJs + '\n' + agentRouteJs;
  const SUPERVISOR_ORIGIN_TYPES = new Set([
    'status', 'worker/ready', 'turn/start', 'turn/end', 'worker/exit',
    'interaction/pending', 'interaction/expired',
  ]);
  const listenerRe = /es\.addEventListener\('([^']+)'/g;
  const listenedTypes = new Set();
  let m;
  while ((m = listenerRe.exec(drawerJs))) listenedTypes.add(m[1]);
  assert.ok(listenedTypes.size >= 10, '至少应该监听到两位数个 SSE 事件类型，说明上面的正则真的抓到了东西');
  assert.ok(listenedTypes.has('command/run'), '前端必须监听 command/run 并渲染命令开始系统行');
  assert.ok(listenedTypes.has('command/done'), '前端必须监听 command/done 并渲染命令结束系统行');
  assert.ok(backend.includes('worker.emit(wireType,'), 'supervisor.js 必须存在把子进程 wire 事件通用转发出去的那一行——wire 事件类型没有字面量 emit() 调用，全靠这一条通用转发');
  const runtimeRoot = path.join(ROOT, 'src/agent/runtime/node_modules/@deepseek-ai');
  const runtimeSource = fs.readdirSync(runtimeRoot)
    .flatMap((pkg) => {
      const libDir = path.join(runtimeRoot, pkg, 'lib');
      if (!fs.existsSync(libDir)) return [];
      return fs.readdirSync(libDir).filter((f) => f.endsWith('.js')).map((f) => path.join(libDir, f));
    })
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  for (const type of listenedTypes) {
    if (SUPERVISOR_ORIGIN_TYPES.has(type)) {
      // 'status' 是 agent.js 路由自己 send('status', ...) 出来的首帧（不经过
      // supervisor 的 emit()/onEvent() 广播管道），其余六个是 supervisor
      // 自身生命周期事件，字面量 emit('<type>', ...)。
      const ok = type === 'status' ? backend.includes(`send('status',`) : backend.includes(`emit('${type}'`);
      assert.ok(ok, `前端监听的 "${type}" 属于 supervisor 自身生命周期事件，但源码里找不到对应的字面量广播源`);
    } else {
      const literal = `"${type}"`;
      assert.ok(runtimeSource.includes(literal), `前端监听的 wire 事件类型 "${type}" 在 DSH 运行时依赖（@deepseek-ai/*）源码里找不到这个字符串字面量——可能是凭空监听一个子进程从不会真正产出的事件名`);
    }
  }
  say(`SSE 帧到 DOM 映射静态审查：前端监听的 ${listenedTypes.size} 个事件类型（${[...listenedTypes].join(', ')}）逐一核对到真实广播源（supervisor 生命周期事件字面量 emit()，或 DSH 运行时依赖真实产出的 wire 事件名 + 通用转发调用点）`);
}

// ---- c：起真实 server.js，用真实 HTTP 断言 counts.agent 门 + 设置五键往返 ----
const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    NODE_ENV: 'test',
    DB_PATH: dbPath,
    ANJIAN_UNSAFE_NO_AUTH: '1',
    // apiKeyEnv 允许指向任意非保留名的环境变量——这里在本进程里真的给它一个
    // 值，好验证 agentReady()/counts.agent 在「enabled 且 apiKeyEnv 有值」时
    // 确实翻成 true，不是永远卡在 false。
    SMOKE_TEST_FAKE_KEY: 'smoke-test-not-a-real-key',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

async function cleanup(exitCode) {
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve)).catch(() => {});
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
  say('真实 server.js 已起（PORT=3009，ANJIAN_UNSAFE_NO_AUTH=1，临时库）');

  // 默认未配置：counts.agent 必须是 false。
  {
    const counts = await (await fetch(`${BASE}/api/counts`)).json();
    assert.equal(counts.agent, false, '默认（agent_enabled 未设置）时 /api/counts.agent 必须是 false');
  }
  // 案件页 HTML 是纯静态文件，服务端不因 counts.agent 状态改写它——这里额外
  // 确认"真实起服务时"读到的仍是同一份静态文件（跟上面源码审查互相印证）。
  {
    const html = await (await fetch(`${BASE}/case.html`)).text();
    assert.match(html, /<span id="agent-entry-slot">\s*<\/span>/);
  }
  say('/api/counts.agent=false 得到确认；/case.html 静态文件与源码审查一致');

  // ---- 设置五键往返 ----
  const putSettings = async (body) => {
    const r = await fetch(`${BASE}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  {
    const { status, data } = await putSettings({
      agent_enabled: true,
      agent_provider: 'deepseek-official',
      agent_model: 'deepseek-chat',
      agent_base_url: 'https://api.deepseek.com',
      agent_api_key_env: 'SMOKE_TEST_FAKE_KEY',
    });
    assert.equal(status, 200, `五键 PUT 应该成功，实际：${JSON.stringify(data)}`);
    assert.equal(data.agent_enabled, 'true');
    assert.equal(data.agent_provider, 'deepseek-official');
    assert.equal(data.agent_model, 'deepseek-chat');
    assert.equal(data.agent_base_url, 'https://api.deepseek.com');
    assert.equal(data.agent_api_key_env, 'SMOKE_TEST_FAKE_KEY');
  }
  {
    const readBack = await (await fetch(`${BASE}/api/settings`)).json();
    assert.equal(readBack.agent_enabled, 'true');
    assert.equal(readBack.agent_provider, 'deepseek-official');
    assert.equal(readBack.agent_model, 'deepseek-chat');
    assert.equal(readBack.agent_base_url, 'https://api.deepseek.com');
    assert.equal(readBack.agent_api_key_env, 'SMOKE_TEST_FAKE_KEY');
  }
  say('/api/settings 五键 PUT → GET 往返一致');

  // 启用且 apiKeyEnv 真的有值 → counts.agent 翻 true（案件页此时才会渲染入口）。
  {
    const counts = await (await fetch(`${BASE}/api/counts`)).json();
    assert.equal(counts.agent, true, '启用 + apiKeyEnv 指向的变量有值时，/api/counts.agent 必须翻成 true');
  }
  say('启用五键 + apiKeyEnv 有值后，/api/counts.agent=true（案件页此时才会渲染助理入口）');

  // 关闭 → 立刻回落 false（不需要重新提交其余四个字段）。
  {
    const { status } = await putSettings({ agent_enabled: false });
    assert.equal(status, 200, 'agent_enabled=false 这一次 PUT 不应该被其余字段的校验拖累（关闭时前端只提交这一个键）');
    const counts = await (await fetch(`${BASE}/api/counts`)).json();
    assert.equal(counts.agent, false, '关闭后 /api/counts.agent 必须立刻回落 false');
  }
  say('关闭 agent_enabled（只提交这一个键）后，/api/counts.agent 立刻回落 false');

  console.log('前端行为冒烟全部通过 ✅');
  await cleanup(0);
} catch (error) {
  console.error('❌', error.message);
  await cleanup(1);
}
