import assert from 'node:assert/strict';
import fs from 'node:fs';
const nav = fs.readFileSync('public/js/nav.js', 'utf8');
const drawer = fs.readFileSync('public/js/agent-drawer.js', 'utf8');
const caseJs = fs.readFileSync('public/js/case.js', 'utf8');
const css = fs.readFileSync('public/css/style.css', 'utf8');
assert.match(nav, /mountGlobalAgentDrawer/); assert.match(nav, /c\.agent/); assert.match(nav, /quick-ai-toggle/); assert.match(nav, /anjian-quick-ai/);
for (const endpoint of ['/api/agent/global/start', '/api/agent/global/prompt', '/api/agent/global/cancel', '/api/agent/global/approval-tier', '/api/agent/global/events']) assert.ok(drawer.includes(endpoint));
// 撤销走既有人类删除端点；api() 帮手会自己补 /api，所以映射里必须是相对路径。
for (const endpoint of ["worklog: '/worklog/'", "tasks: '/tasks/'", "events: '/events/'", "contacts: '/contacts/'", "facts: '/facts/'", "deadlines: '/deadlines/'"]) assert.ok(drawer.includes(endpoint), `undo map must use api()-relative path ${endpoint}`);
// 防线（2026-10-13 真机验收抓到 /api/api/... 404）：api() 永远不能收到带 /api 前缀的路径。
for (const source of [drawer, nav, caseJs]) {
  assert.doesNotMatch(source, /\bapi\(\s*[`'"]\/api\//u, 'api() 的路径不得以 /api 开头（帮手会再补一次）');
  assert.doesNotMatch(source, /\bapi\(\s*`\$\{agentPath\}/u, 'api() 不得使用带 /api 前缀的 agentPath');
}
assert.match(drawer, /apiAgentPath = scope === 'global' \? '\/agent\/global' : `\/cases\/\$\{caseId\}\/agent`/u);
assert.match(drawer, /new EventSource\(`\$\{agentPath\}\/events`\)/u, 'EventSource 仍须用带 /api 的 agentPath');
assert.match(drawer, /DIRECT_RECORDS/); assert.doesNotMatch(drawer, /images_not_supported_global/);
// 顶栏多了「AI」入口后，375–430px 手机要收起品牌文字，否则「退出」被挤出屏幕、整页横向溢出（2026-10-13 真机抓到）。
assert.match(css, /@media \(max-width: 440px\)\s*\{\s*\.topnav \{ gap: 6px; \}\s*\.topnav \.brand b \{ display: none; \}/u, 'narrow phones must hide the brand text to fit the AI entry');
// 「交给 AI」模式靠 class 隐藏常规控件，不能把各控件的 hidden 一律改写（否则退出时开庭时刻/地点、空附件标签被放出来）。
assert.match(nav, /bar\.classList\.toggle\('quick-ai-active', active\)/u);
assert.doesNotMatch(nav, /node\.hidden = active/u, 'AI 模式不得批量改写常规控件的 hidden');
assert.match(css, /\.quickbar\.quick-ai-active \.quick-tidy \{ display: none !important; \}/u);
// 「整理」按钮须用专属 class 定位：.btn.ghost 会先命中回形针按钮。
assert.match(nav, /querySelector\('\.quickbar \.quick-tidy'\)/u);
assert.doesNotMatch(nav, /querySelector\('\.quickbar \.btn\.ghost'\)/u);
assert.match(caseJs, /created_by === 'ai'/);
// 日志行的 AI 标签必须在 tlItem 第 4 参（正文数组）里；插成独立位置参数会让整页时间线崩溃（2026-10-13 真机抓到）。
assert.match(caseJs, /'日志'\),\s*(?:\/\/[^\n]*\n\s*)*\[w\.created_by === 'ai' \? el\(/u, 'worklog AI pill must be inside the body array passed to tlItem'); assert.match(css, /\.quick-ai-toggle/); assert.match(css, /@media \(max-width: 767px\)/);

// 统一抽屉 + 「项目」选择器（1.14-A）：一个实例，标题栏下拉在总入口与在办案件间切换
assert.match(drawer, /agent-project-select/, '抽屉标题栏必须有项目选择器');
assert.ok(drawer.includes("'/cases?status=active'"), '项目列表来自在办案件（api() 自带 /api 前缀）');
assert.ok(drawer.includes('总入口 · 不挂案件'), '第一项是总入口');
assert.ok(drawer.includes('anjian-agent-project'), '本标签页的项目选择记在 sessionStorage');
assert.ok(drawer.includes('`/api/cases/${caseId}/agent`'), '案件 scope 端点前缀');
assert.ok(drawer.includes("'/api/agent/global'"), '全局 scope 端点前缀');
assert.equal((drawer.match(/async function createAgentDrawer/gu) || []).length, 1, '全站只有一份抽屉实现');
assert.match(drawer, /mountAgentDrawer[\s\S]*?pageCaseId\s*=/u, '案件页的本页案件要记进模块状态，保证与顶栏入口谁先建都落在本案');

// 切换项目只换 SSE 与端点，不能停/取消/启动任何 worker，也不发任何 POST
const switchSrc = /function switchProject\([\s\S]*?\n  \}\n/u.exec(drawer)?.[0];
assert.ok(switchSrc && switchSrc.length > 200, '必须能取出 switchProject 函数体');
for (const forbidden of ['/cancel', '/stop', '/start', "method: 'POST'", 'method: "POST"', 'api(']) {
  assert.ok(!switchSrc.includes(forbidden), `switchProject 不得出现 ${forbidden}`);
}
for (const reset of ['state.commands = null', 'state.commandFetch = null', 'state.commandGeneration += 1', 'hideCommandMenu()', 'clearDraftImages()', 'clearConversation()']) {
  assert.ok(switchSrc.includes(reset), `switchProject 必须重置每个 worker 的客户端状态：${reset}`);
}
assert.ok(!/state\.submitting\s*=\s*true/u.test(switchSrc), 'switchProject 不得把 submitting 置 true');

// 只有显式改下拉才落 sessionStorage：案件页自动默认与入口按钮都不持久化
assert.match(drawer, /projectSelect\.addEventListener\('change'[\s\S]*?persist:\s*true/u);
assert.equal((drawer.match(/persist:\s*true/gu) || []).length, 2, '只有下拉 change 的两个分支写记忆');
assert.equal((drawer.match(/sessionStorage\.setItem/gu) || []).length, 1);
const mountSrc = /export async function mountAgentDrawer[\s\S]*?\n\}\n/u.exec(drawer)?.[0] || '';
assert.ok(mountSrc.includes("switchProject('case', id)") && !mountSrc.includes('persist'), 'mountAgentDrawer 切到本案但不持久化');
assert.match(caseJs, /mountAgentDrawer\(Number\(id\)\)/);

// 快录条：「→ 目标」小字点击打开抽屉；AI 助理未启用时快录条恢复全部字段且切换按钮隐藏
assert.match(nav, /quick-ai-target/); assert.match(nav, /anjian:agent-open/); assert.match(nav, /anjian:agent-prompt/);
assert.match(nav, /anjian:agent-capability/);
assert.match(drawer, /anjian:agent-open/); assert.match(drawer, /anjian:agent-prompt/);
assert.match(nav, /aiToggle\.hidden\s*=\s*!agentAvailable/);
for (const selector of ['.agent-project-select', '.agent-round-records', '.agent-round-title', '.quick-ai-target']) assert.ok(css.includes(selector), `${selector} 样式缺失`);
assert.doesNotMatch(css, /\.ai-mark/); assert.doesNotMatch(caseJs, /ai-mark/);
console.log('global agent frontend smoke: unified drawer with project selector, both endpoint prefixes, non-destructive switch, quick AI target, undo map and AI worklog mark passed');
