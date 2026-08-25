// 终局人工门禁：用真实 DeepSeek 模型验证 full 档的 web_search 确实可联网，
// 且 1 档会在联网前弹出包含完整查询词的审批卡。
//
// 本脚本不进 npm run check：它需要外部模型凭据/网络，且绝不能把 key 写入
// repo、命令参数或日志。正确入口：
//   secretctl run anjian.local -- node tools/test-agent-live-web.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

assert.ok(process.env.DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY must be injected without printing it');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-real-model-web-'));
const filesRoot = path.join(scratch, 'files');
const currentCaseName = '当前案件-联网验收';
const currentCaseRoot = path.join(filesRoot, currentCaseName);
const sessionRoot = path.join(scratch, 'sessions');
const databasePath = path.join(scratch, 'anjian-live-web.db');

fs.mkdirSync(currentCaseRoot, { recursive: true });
fs.mkdirSync(sessionRoot, { recursive: true });
fs.writeFileSync(path.join(currentCaseRoot, 'README.txt'), 'isolated live web fixture\n');

process.env.DB_PATH = databasePath;
process.env.ANJIAN_FILES_ROOT = filesRoot;
process.env.ANJIAN_AGENT_SESSION_ROOT = sessionRoot;
process.env.ANJIAN_INTERNAL_KEY = 'isolated-live-web-internal-key-not-production';

let db;
let supervisor;
let unsubscribe;
try {
  ({ db } = await import('../src/db.js'));
  const { AgentSupervisor } = await import('../src/agent/supervisor.js');
  const { AGENT_SETTINGS_KEYS } = await import('../src/agent/config.js');

  const setSetting = (key, value) => db.prepare(
    'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(key, value);
  setSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
  setSetting(AGENT_SETTINGS_KEYS.capabilityMode, 'full');
  setSetting(AGENT_SETTINGS_KEYS.approvalTier, '3');
  setSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
  setSetting(AGENT_SETTINGS_KEYS.baseURL, 'https://api.deepseek.com');
  setSetting(AGENT_SETTINGS_KEYS.model, 'deepseek-v4-flash');
  setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'DEEPSEEK_API_KEY');
  setSetting(AGENT_SETTINGS_KEYS.pluginPatch, '');

  const caseId = Number(db.prepare(
    `INSERT INTO cases (name, procedure, stage, status, folder_path)
     VALUES (?, '一审', '隔离联网验收', 'active', ?)`,
  ).run(currentCaseName, currentCaseName).lastInsertRowid);

  supervisor = new AgentSupervisor({
    filesRoot,
    sessionRoot,
    turnTimeoutMs: 240_000,
    preflightTimeoutMs: 120_000,
    interactionTtlMs: 60_000,
  });

  const events = [];
  let tier1Card = null;
  let autoRejectTier1 = false;
  unsubscribe = supervisor.onEvent(caseId, (event) => {
    events.push(event);
    if (autoRejectTier1 && event.type === 'interaction/pending' && event.data?.toolName === 'web_search') {
      tier1Card = event.data;
      const decision = supervisor.resolveApproval(caseId, event.data.id, 'rejected');
      assert.equal(decision.ok, true, 'Tier 1 web card must be rejectable exactly once');
    }
  });

  const parseArguments = (raw) => {
    if (raw && typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw || '{}')); } catch { return {}; }
  };
  const toolResultBlock = (data) => data?.message?.content?.find((block) => block?.type === 'tool-result');
  const toolResultText = (data) => {
    const blocks = toolResultBlock(data)?.content;
    if (!Array.isArray(blocks)) return '';
    return blocks.filter((block) => block?.type === 'text').map((block) => String(block.text || '')).join('\n');
  };
  const exactWebCall = (turnEvents, query) => turnEvents.find((event) => {
    if (event.type !== 'tool/call' || event.data?.name !== 'web_search') return false;
    return JSON.stringify(parseArguments(event.data.arguments).queries) === JSON.stringify([query]);
  });

  const start = await supervisor.start(caseId);
  assert.equal(start.status, 'ready', `real model worker did not become ready: ${JSON.stringify(start)}`);
  assert.equal(start.model, 'deepseek-v4-flash');
  assert.equal(start.approvalTier, '3');

  const allowedQuery = '最高人民法院 官方网站';
  const allowedOffset = events.length;
  await supervisor.prompt(caseId, [
    '这是律师授权的隔离联网验收。',
    '先调用 mcp__anqi-local__case_folder_info（空参数），然后必须调用 web_search。',
    `web_search 的 queries 字段逐字使用 ${JSON.stringify([allowedQuery])}，不得改写、增加查询或只口头回答。`,
    '收到结果后不要调用其他工具，只简短报告结果。',
  ].join('\n'));
  const allowedEvents = events.slice(allowedOffset);
  assert.ok(
    allowedEvents.some((event) => event.type === 'tool/call' && event.data?.name === 'mcp__anqi-local__case_folder_info'),
    'first real-model turn must establish the required MCP tool readiness',
  );
  const allowedCall = exactWebCall(allowedEvents, allowedQuery);
  assert.ok(allowedCall, 'Tier 3 real model did not issue the exact web_search call');
  const allowedResult = allowedEvents.find((event) =>
    event.type === 'tool/result' && event.data?.message?.source?.callId === allowedCall.data.callId
  );
  assert.ok(allowedResult, 'Tier 3 exact web_search call has no result');
  assert.notEqual(toolResultBlock(allowedResult.data)?.isError, true, 'Tier 3 web_search returned an error');
  const allowedText = toolResultText(allowedResult.data);
  assert.match(allowedText, /Sources:\s*[\s\S]*https?:\/\//, 'real web_search result must include source URLs');
  assert.equal(
    allowedEvents.some((event) => event.type === 'interaction/pending' && event.data?.toolName === 'web_search'),
    false,
    'Tier 3 web_search must not show an approval card',
  );
  const sourceCount = (allowedText.match(/^- \[/gm) || []).length;
  console.log(`LIVE_WEB_ALLOWED tier=3 query=${JSON.stringify(allowedQuery)} sources=${sourceCount} result=success`);

  await supervisor.stop(caseId, 'switch-to-tier1-web-proof');
  setSetting(AGENT_SETTINGS_KEYS.approvalTier, '1');
  const tier1Start = await supervisor.start(caseId);
  assert.equal(tier1Start.status, 'ready');
  assert.equal(tier1Start.approvalTier, '1');

  const rejectedQuery = '深圳市中级人民法院 官方网站';
  const rejectedOffset = events.length;
  autoRejectTier1 = true;
  await supervisor.prompt(caseId, [
    '这是隔离审批卡验收。先调用 mcp__anqi-local__case_folder_info（空参数），然后必须调用 web_search。',
    `web_search 的 queries 字段逐字使用 ${JSON.stringify([rejectedQuery])}，不得改写。`,
    '若被拒绝就停止，不得重试或改用别的工具。',
  ].join('\n'));
  autoRejectTier1 = false;
  const rejectedEvents = events.slice(rejectedOffset);
  assert.ok(exactWebCall(rejectedEvents, rejectedQuery), 'Tier 1 real model did not issue the exact web_search call');
  assert.ok(tier1Card, 'Tier 1 real-model web_search did not create an approval card');
  assert.equal(tier1Card.toolName, 'web_search');
  assert.equal(tier1Card.reason, `web_search query\n${rejectedQuery}`);
  console.log(`LIVE_WEB_APPROVAL_CARD tool=${tier1Card.toolName}\n${tier1Card.reason}\noutcome=rejected-before-search`);
  console.log('agent terminal live web: tier3 real search + tier1 full-query approval card passed');
} finally {
  try { unsubscribe?.(); } catch { /* no-op */ }
  try { if (supervisor) await supervisor.stopAll?.('live-web-test-finished'); } catch { /* best effort */ }
  try { if (db?.open) db.close(); } catch { /* no-op */ }
  fs.rmSync(scratch, { recursive: true, force: true });
}
