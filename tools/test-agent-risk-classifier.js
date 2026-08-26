import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-risk-classifier-'));
process.env.DB_PATH = path.join(scratch, 'risk-classifier.db');

try {
  const { db } = await import('../src/db.js');
  const { AgentSupervisor } = await import('../src/agent/supervisor.js');
  const { createRiskClassifier } = await import('../src/agent/risk-classifier.js');

  let disabledCalls = 0;
  const disabled = createRiskClassifier({
    decide: async () => { disabledCalls += 1; return { decision: 'allow', reason: 'must-not-run' }; },
  });
  assert.deepEqual(
    await disabled.classify({ toolName: 'web_search', reason: 'web_search query\n公开法条' }),
    { decision: 'ask', reason: 'classifier_disabled' },
  );
  assert.equal(disabledCalls, 0, '分类器默认关闭时不得把 action 发给 decide/model');

  for (const decision of ['allow', 'ask', 'block']) {
    const classifier = createRiskClassifier({
      enabled: true,
      decide: async (action) => ({ decision, reason: `judge:${action.toolName}` }),
    });
    assert.deepEqual(
      await classifier.classify({ toolName: 'web_search', reason: 'query' }),
      { decision, reason: 'judge:web_search' },
    );
  }

  const invalid = createRiskClassifier({ enabled: true, decide: async () => ({ decision: 'auto-allow', reason: 'wrong enum' }) });
  assert.deepEqual(await invalid.classify({ toolName: 'web_search', reason: 'query' }), {
    decision: 'ask', reason: 'classifier_invalid_output',
  });
  const failed = createRiskClassifier({ enabled: true, decide: async () => { throw new Error('secret upstream detail'); } });
  assert.deepEqual(await failed.classify({ toolName: 'web_search', reason: 'query' }), {
    decision: 'ask', reason: 'classifier_error',
  });
  const timedOut = createRiskClassifier({ enabled: true, timeoutMs: 20, decide: async () => new Promise(() => {}) });
  assert.deepEqual(await timedOut.classify({ toolName: 'web_search', reason: 'query' }), {
    decision: 'ask', reason: 'classifier_timeout',
  });

  const runSupervisorDecision = async (decision, messageId) => {
    const replies = [];
    const emitted = [];
    const riskClassifier = createRiskClassifier({
      enabled: true,
      decide: async () => ({ decision, reason: `fixture-${decision}` }),
    });
    const supervisor = new AgentSupervisor({ interactionTtlMs: 5_000, riskClassifier });
    const worker = {
      caseId: 93 + messageId, sessionId: `phase3-${messageId}`, status: 'ready', approvalTier: '2',
      pendingInteractions: new Map(), approvalAllowlist: new Set(),
      redact(value) { return String(value); },
      child: { stdin: { destroyed: false, write(line) { replies.push(JSON.parse(line)); } } },
      emit(type, data) { emitted.push({ type, data }); },
    };
    supervisor.workers.set(worker.caseId, worker);
    await supervisor._enqueueApproval(worker, { id: messageId }, {
      sessionId: worker.sessionId,
      approvalId: `classifier-${messageId}`,
      toolName: 'web_search',
      reason: 'web_search query\n公开判例',
    });
    return { supervisor, worker, replies, emitted };
  };

  const allowed = await runSupervisorDecision('allow', 1);
  assert.equal(allowed.worker.pendingInteractions.size, 0);
  assert.equal(allowed.replies.at(-1)?.result?.outcome, 'allowed-once');

  const blocked = await runSupervisorDecision('block', 2);
  assert.equal(blocked.worker.pendingInteractions.size, 0);
  assert.equal(blocked.replies.at(-1)?.result?.outcome, 'rejected');

  const asked = await runSupervisorDecision('ask', 3);
  assert.equal(asked.worker.pendingInteractions.size, 1);
  assert.equal(asked.emitted.at(-1)?.type, 'interaction/pending');
  const pendingId = [...asked.worker.pendingInteractions.keys()][0];
  asked.supervisor.resolveApproval(asked.worker.caseId, pendingId, 'rejected');

  const audits = db.prepare(
    "SELECT action, detail FROM audit_log WHERE action = 'agent-risk-classifier' ORDER BY id",
  ).all();
  assert.ok(audits.some((row) => /decision=allow reason=fixture-allow/.test(row.detail)));
  assert.ok(audits.some((row) => /decision=block reason=fixture-block/.test(row.detail)));
  assert.ok(audits.some((row) => /decision=ask reason=fixture-ask/.test(row.detail)));
  assert.ok(audits.every((row) => row.detail.includes('action=公开判例')), '每条审计必须包含动作原文');

  console.log('agent Phase 3 risk classifier: default-off seam + allow/ask/block triage + timeout/error/invalid fail-closed + action audit passed');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
