import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-tier2-policy-'));
process.env.DB_PATH = path.join(scratch, 'tier2-policy.db');

try {
  const { db } = await import('../src/db.js');
  const { AgentSupervisor } = await import('../src/agent/supervisor.js');
  const {
    createDeepSeekRiskDecider,
    createRiskClassifier,
  } = await import('../src/agent/risk-classifier.js');
  const { apply: applyToolApprovalPolicy } = await import(
    '../src/agent/assets/plugins/dsh-anqi-tool-approval/index.js'
  );

  const apiKey = 'sk-tier2-must-never-appear';
  const caseMaterial = '案卷绝密内容不得外发';
  const requests = [];
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });
    const rawAction = body.messages.at(-1).content;
    const decision = rawAction === '/tmp/案件夹外.txt' ? 'ask' : 'allow';
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ decision, reason: `judge-${decision}` }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const classifier = createRiskClassifier({
    enabled: true,
    decide: createDeepSeekRiskDecider({ getApiKey: () => apiKey, fetchFn }),
  });

  const safe = await classifier.classify({ toolName: 'bash', reason: 'bash command\nls -la' });
  assert.deepEqual(safe, { decision: 'allow', reason: 'judge-allow' });
  const outsideWrite = await classifier.classify({
    toolName: 'write', reason: 'outside file write target\n/tmp/案件夹外.txt',
  });
  assert.deepEqual(outsideWrite, { decision: 'ask', reason: 'judge-ask' });
  const destructive = await classifier.classify({
    toolName: 'bash', reason: 'bash command\nrm -rf /tmp/案件夹外',
  });
  assert.equal(destructive.decision, 'block', '明显破坏动作必须在模型误判 allow 时仍被政策下限拦住');
  const databaseRead = await classifier.classify({
    toolName: 'bash', reason: 'bash command\nsqlite3 /srv/anjian.db "SELECT * FROM cases"',
  });
  assert.equal(databaseRead.decision, 'block', '读取 DB 必须直接 block');

  assert.equal(requests.length, 4, '四条危险动作各调用一次独立分类器');
  for (const request of requests) {
    assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(request.body.model, 'deepseek-v4-flash');
    assert.deepEqual(request.body.thinking, { type: 'disabled' });
    assert.equal(request.body.messages.length, 2);
    assert.equal(request.body.messages[0].role, 'system');
    assert.equal(request.body.messages[1].role, 'user');
    assert.equal(typeof request.body.messages[1].content, 'string');
    assert.equal(JSON.stringify(request.body).includes(apiKey), false, 'key 不得进入请求 body');
    assert.equal(JSON.stringify(request.body).includes(caseMaterial), false, '案卷内容不得进入分类器请求');
    assert.equal(request.options.headers.Authorization, `Bearer ${apiKey}`);
  }
  assert.deepEqual(
    requests.map((request) => request.body.messages[1].content),
    ['ls -la', '/tmp/案件夹外.txt', 'rm -rf /tmp/案件夹外', 'sqlite3 /srv/anjian.db "SELECT * FROM cases"'],
    '分类器 user message 只能是剥离宿主前缀后的动作原文',
  );

  const errored = createRiskClassifier({
    enabled: true,
    decide: createDeepSeekRiskDecider({
      getApiKey: () => apiKey,
      fetchFn: async () => { throw new Error('upstream down'); },
    }),
  });
  assert.deepEqual(
    await errored.classify({ toolName: 'web_search', reason: 'web_search query\n最高人民法院 指导案例' }),
    { decision: 'ask', reason: 'classifier_error' },
    '分类器报错必须 fail closed 为 ask',
  );

  let preExecute;
  let insideNextCalls = 0;
  const workspaceRoot = path.join(scratch, '当前案件');
  fs.mkdirSync(workspaceRoot);
  applyToolApprovalPolicy(
    { on(_event, handler) { preExecute = handler; } },
    { askTools: ['web_search', 'bash'], outsideWriteTools: ['write', 'edit', 'str_replace_editor'], workspaceRoot },
  );
  const inside = await preExecute(
    { name: 'write', arguments: { file_path: '本案笔记.md', content: caseMaterial } },
    async () => { insideNextCalls += 1; return { kind: 'allow' }; },
  );
  assert.deepEqual(inside, { kind: 'allow' });
  assert.equal(insideNextCalls, 1, '案件夹内写入必须直达原工具，不产生分类请求');
  const outside = await preExecute(
    { name: 'write', arguments: { file_path: '/tmp/案件夹外.txt', content: caseMaterial } },
    async () => ({ kind: 'allow' }),
  );
  assert.deepEqual(outside, { kind: 'ask', reason: 'outside file write target\n/tmp/案件夹外.txt' });
  assert.equal(outside.reason.includes(caseMaterial), false, '夹外写审批只能带目标路径，不能带写入内容');
  const viewOutside = await preExecute(
    { name: 'str_replace_editor', arguments: { command: 'view', path: '/tmp/只读.txt' } },
    async () => ({ kind: 'allow' }),
  );
  assert.deepEqual(viewOutside, { kind: 'allow' }, 'str_replace_editor view 不是写入，不送分类器');

  const replies = [];
  const emitted = [];
  const supervisor = new AgentSupervisor({ interactionTtlMs: 5_000, riskClassifier: classifier });
  const worker = {
    caseId: 151, sessionId: 'tier2-policy-session', status: 'ready', approvalTier: '2',
    pendingInteractions: new Map(), approvalAllowlist: new Set(),
    redact(value) { return String(value).replaceAll(apiKey, '[REDACTED]'); },
    child: { stdin: { destroyed: false, write(line) { replies.push(JSON.parse(line)); } } },
    emit(type, data) { emitted.push({ type, data }); },
  };
  worker.redact.approval = worker.redact;
  supervisor.workers.set(worker.caseId, worker);
  await supervisor._enqueueApproval(worker, { id: 1 }, {
    sessionId: worker.sessionId, approvalId: 'allow-ls', toolName: 'bash', reason: 'bash command\nls -la',
  });
  assert.equal(replies.at(-1)?.result?.outcome, 'allowed-once');
  await supervisor._enqueueApproval(worker, { id: 2 }, {
    sessionId: worker.sessionId, approvalId: 'block-rm', toolName: 'bash', reason: 'bash command\nrm -rf /tmp/案件夹外',
  });
  assert.equal(replies.at(-1)?.result?.outcome, 'rejected');

  const errorSupervisor = new AgentSupervisor({ interactionTtlMs: 5_000, riskClassifier: errored });
  const errorWorker = { ...worker, caseId: 152, sessionId: 'tier2-error-session', pendingInteractions: new Map() };
  errorSupervisor.workers.set(errorWorker.caseId, errorWorker);
  await errorSupervisor._enqueueApproval(errorWorker, { id: 3 }, {
    sessionId: errorWorker.sessionId,
    approvalId: 'ask-error',
    toolName: 'web_search',
    reason: 'web_search query\n最高人民法院 指导案例',
  });
  const [pending] = errorSupervisor.listPendingInteractions(errorWorker.caseId);
  assert.equal(pending.classifierDecision, 'ask');
  assert.equal(pending.classifierReason, 'classifier_error');
  errorSupervisor.resolveApproval(errorWorker.caseId, pending.id, 'rejected');

  const audits = db.prepare(
    "SELECT detail FROM audit_log WHERE action='agent-risk-classifier' ORDER BY id",
  ).all().map((row) => row.detail);
  assert.ok(audits.some((detail) => detail.includes('action=ls -la decision=allow reason=judge-allow')));
  assert.ok(audits.some((detail) => detail.includes('action=rm -rf /tmp/案件夹外 decision=block')));
  assert.ok(audits.some((detail) => detail.includes('action=最高人民法院 指导案例 decision=ask reason=classifier_error')));
  assert.equal(audits.some((detail) => detail.includes(apiKey)), false, '审计不得含分类器 key');

  console.log('agent T1 tier2 policy: DeepSeek flash + action-only payload + allow/ask/block + outside-write scope + audit/fail-closed passed');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
