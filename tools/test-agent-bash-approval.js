import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-bash-approval-'));
process.env.DB_PATH = path.join(scratch, 'bash-approval.db');

try {
  const { AgentSupervisor } = await import('../src/agent/supervisor.js');
  const { apply: applyToolApprovalPolicy, MAX_APPROVAL_REASON_CHARS } = await import(
    '../src/agent/assets/plugins/dsh-anqi-tool-approval/index.js'
  );

  let preExecute;
  applyToolApprovalPolicy(
    { on(_event, handler) { preExecute = handler; } },
    { askTools: ['web_search', 'bash'] },
  );
  const command = `sqlite3 ${path.join(scratch, 'formal.db')} "UPDATE deadlines SET due_on='2099-01-01'"`;
  const gate = await preExecute(
    { name: 'bash', arguments: { command } },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(gate.kind, 'ask');
  assert.equal(gate.reason, `bash command\n${command}`, '审批 reason 必须逐字保留完整命令');

  const tooLong = await preExecute(
    { name: 'bash', arguments: { command: 'x'.repeat(MAX_APPROVAL_REASON_CHARS) } },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(tooLong.kind, 'deny', '放不进完整卡片的超长命令必须直接拒绝，不能截断后求授权');

  const replies = [];
  const emitted = [];
  const supervisor = new AgentSupervisor({ interactionTtlMs: 5_000 });
  const worker = {
    caseId: 140, sessionId: 'phase4-session', status: 'ready', approvalTier: '1',
    pendingInteractions: new Map(), approvalAllowlist: new Set(),
    redact(value) { return String(value); },
    child: { stdin: { destroyed: false, write(line) { replies.push(JSON.parse(line)); } } },
    emit(type, data) { emitted.push({ type, data }); },
  };
  supervisor.workers.set(worker.caseId, worker);

  supervisor._enqueueApproval(worker, { id: 41 }, {
    sessionId: worker.sessionId, approvalId: 'bash-1', toolName: 'bash', reason: gate.reason,
  });
  assert.equal(worker.pendingInteractions.size, 1, '1 档 bash 每条命令必须弹卡');
  const tier1Id = [...worker.pendingInteractions.keys()][0];
  const tier1 = supervisor.listPendingInteractions(worker.caseId)[0];
  assert.equal(tier1.reason, `bash command\n${command}`);
  supervisor.resolveApproval(worker.caseId, tier1Id, 'rejected');

  assert.deepEqual(supervisor.setApprovalTier(worker.caseId, '3'), { ok: true, approvalTier: '3' });
  const emittedBeforeTier3 = emitted.length;
  supervisor._enqueueApproval(worker, { id: 42 }, {
    sessionId: worker.sessionId, approvalId: 'bash-2', toolName: 'bash', reason: gate.reason,
  });
  assert.equal(worker.pendingInteractions.size, 0, '3 档 bash 只应免提示');
  assert.equal(emitted.length, emittedBeforeTier3);
  assert.equal(replies.at(-1)?.result?.outcome, 'allowed-once');

  // 3 档只对白名单内、完成专项回归的 bash/web_search 生效；未来 powerful tool
  // 不能因“放开”字样被一锅端自动允许。
  supervisor._enqueueApproval(worker, { id: 43 }, {
    sessionId: worker.sessionId,
    approvalId: 'future-1',
    toolName: 'future_powerful',
    reason: 'future_powerful arguments\n{"target":"formal-db"}',
  });
  assert.equal(worker.pendingInteractions.size, 1, '未知/未来工具即使 3 档也必须弹卡');
  const unknownId = [...worker.pendingInteractions.keys()][0];
  supervisor.resolveApproval(worker.caseId, unknownId, 'rejected');

  assert.deepEqual(supervisor.setApprovalTier(worker.caseId, '2'), { ok: true, approvalTier: '2' });
  await supervisor._enqueueApproval(worker, { id: 44 }, {
    sessionId: worker.sessionId, approvalId: 'bash-3', toolName: 'bash', reason: gate.reason,
  });
  assert.equal(worker.pendingInteractions.size, 1, '分类器默认关闭时 2 档 bash 必须转人工卡');
  const tier2Id = [...worker.pendingInteractions.keys()][0];
  const tier2 = supervisor.listPendingInteractions(worker.caseId)[0];
  assert.equal(tier2.classifierDecision, 'needs-approval');
  assert.equal(tier2.classifierReason, 'classifier_disabled');
  supervisor.resolveApproval(worker.caseId, tier2Id, 'rejected');

  const yaml = fs.readFileSync(new URL('../src/agent/assets/anqi.cordis.yml', import.meta.url), 'utf8');
  assert.match(yaml, /askTools:\s*\[web_search, bash\]/, '真实 full 组合必须同时审批 web_search 与 bash');
  assert.match(yaml, /mode:\s*!!js process\.env\.DSH_PERMISSION_MODE/, 'sandbox-policy 必须继续由宿主钉死');
  assert.doesNotMatch(
    yaml,
    /^\s*mode:\s*(?:!!js\s*)?['"]?danger-full-access/m,
    '3 档不得把真实 DSH sandbox-policy.mode 升级为全宿主访问',
  );

  console.log('agent Phase 4 bash approval: full command + tier1 ask + tier2 fail-closed + tier3 allowlist-only + sandbox mode unchanged passed');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
