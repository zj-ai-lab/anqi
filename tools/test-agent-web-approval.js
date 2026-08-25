import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-web-approval-'));
process.env.DB_PATH = path.join(scratch, 'web-approval.db');

try {
  const { db } = await import('../src/db.js');
  const { AgentSupervisor } = await import('../src/agent/supervisor.js');
  const { AGENT_SETTINGS_KEYS, loadAgentConfig } = await import('../src/agent/config.js');
  const { apply: applyToolApprovalPolicy } = await import('../src/agent/assets/plugins/dsh-anqi-tool-approval/index.js');

  const setSetting = (key, value) => db.prepare(
    'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(key, value);
  setSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
  setSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
  setSetting(AGENT_SETTINGS_KEYS.model, 'deepseek-chat');
  setSetting(AGENT_SETTINGS_KEYS.baseURL, 'https://api.deepseek.com');
  setSetting(AGENT_SETTINGS_KEYS.capabilityMode, 'full');
  setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, '');
  setSetting(AGENT_SETTINGS_KEYS.pluginPatch, '');

  assert.equal(loadAgentConfig().approvalTier, '1', '旧库缺键时必须默认 1 档');
  setSetting(AGENT_SETTINGS_KEYS.approvalTier, '3');
  assert.equal(loadAgentConfig().approvalTier, '3');
  setSetting(AGENT_SETTINGS_KEYS.approvalTier, '9');
  assert.equal(loadAgentConfig().enabled, false, '非法审批档必须 fail closed');
  setSetting(AGENT_SETTINGS_KEYS.approvalTier, '1');

  let preExecute;
  applyToolApprovalPolicy({ on(_event, handler) { preExecute = handler; } }, { askTools: ['web_search'] });
  const queries = ['深圳 2026 最新民事诉讼规则', '最高人民法院 指导案例'];
  const gate = await preExecute({ name: 'web_search', arguments: { queries } }, async () => ({ kind: 'allow' }));
  assert.equal(gate.kind, 'ask');
  for (const query of queries) assert.match(gate.reason, new RegExp(query));

  const replies = [];
  const emitted = [];
  const supervisor = new AgentSupervisor({ interactionTtlMs: 5_000 });
  const worker = {
    caseId: 92, sessionId: 'phase2-session', status: 'ready', approvalTier: '1',
    pendingInteractions: new Map(), approvalAllowlist: new Set(),
    redact(value) { return String(value); },
    child: { stdin: { destroyed: false, write(line) { replies.push(JSON.parse(line)); } } },
    emit(type, data) { emitted.push({ type, data }); },
  };
  supervisor.workers.set(worker.caseId, worker);

  supervisor._enqueueApproval(worker, { id: 10 }, {
    sessionId: worker.sessionId, approvalId: 'web-1', toolName: 'web_search', reason: gate.reason,
  });
  assert.equal(worker.pendingInteractions.size, 1, '1 档 web_search 必须弹卡');
  const firstId = [...worker.pendingInteractions.keys()][0];
  supervisor.resolveApproval(worker.caseId, firstId, 'rejected');

  assert.deepEqual(supervisor.setApprovalTier(worker.caseId, '3'), { ok: true, approvalTier: '3' });
  const emittedBeforeTier3 = emitted.length;
  supervisor._enqueueApproval(worker, { id: 11 }, {
    sessionId: worker.sessionId, approvalId: 'web-2', toolName: 'web_search', reason: gate.reason,
  });
  assert.equal(worker.pendingInteractions.size, 0, '3 档 web_search 不应生成卡片');
  assert.equal(emitted.length, emittedBeforeTier3);
  assert.equal(replies.at(-1)?.result?.outcome, 'allowed-once');

  assert.deepEqual(supervisor.setApprovalTier(worker.caseId, '2'), { ok: true, approvalTier: '2' });
  await supervisor._enqueueApproval(worker, { id: 12 }, {
    sessionId: worker.sessionId, approvalId: 'web-3', toolName: 'web_search', reason: gate.reason,
  });
  assert.equal(worker.pendingInteractions.size, 1, '分类器默认关闭时 2 档必须 fail closed 到人工卡');

  const yaml = fs.readFileSync(new URL('../src/agent/assets/anqi.cordis.yml', import.meta.url), 'utf8');
  // Phase 4 在同一累计组合里追加 bash 后，Phase 2 回归仍要求 web_search 留在
  // 精确审批表中；直接断言当前完整表，不能靠模糊 contains 掩盖名单漂移。
  assert.match(yaml, /askTools:\s*\[web_search, bash\]/);
  assert.match(yaml, /fetch:\s*false/);
  const drawer = fs.readFileSync(new URL('../public/js/agent-drawer.js', import.meta.url), 'utf8');
  assert.match(drawer, /agent-approval-tier/);
  const profile = fs.readFileSync(new URL('../public/profile.html', import.meta.url), 'utf8');
  assert.match(profile, /id="agent-approval-tier"/);

  console.log('agent Phase 2 web approval: full queries + tier1 ask + tier2 fail-closed + tier3 auto-allow + fetch=false passed');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
