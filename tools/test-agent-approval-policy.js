import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-approval-policy-'));
process.env.DB_PATH = path.join(scratch, 'approval-policy.db');

try {
  const { AgentSupervisor } = await import('../src/agent/supervisor.js');
  const {
    apply: applyToolApprovalPolicy,
  } = await import('../src/agent/assets/plugins/dsh-anqi-tool-approval/index.js');

  // Phase 1 的真实工具先不接线；用一个假 powerful 工具验证同一条
  // tools/pre-execute seam 会产出 ask，且 reason 保留原始参数。
  let preExecute;
  applyToolApprovalPolicy({
    on(event, handler) {
      assert.equal(event, 'tools/pre-execute');
      preExecute = handler;
    },
  }, { askTools: ['fake_powerful'] });
  const rawAction = 'printf phase1-approval-exact-payload';
  const gate = await preExecute({
    name: 'fake_powerful',
    arguments: { command: rawAction },
  }, async () => ({ kind: 'allow' }));
  assert.equal(gate.kind, 'ask');
  assert.match(gate.reason, /fake_powerful/);
  assert.match(gate.reason, new RegExp(rawAction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  // 反向 JSON-RPC → supervisor pending → “本类不再询问” → 下一次同类请求
  // 自动 allowed-once。这里不 mock 红线判断：真实调用 supervisor 的状态机。
  const replies = [];
  const emitted = [];
  const supervisor = new AgentSupervisor({ interactionTtlMs: 5_000 });
  const worker = {
    caseId: 91,
    sessionId: 'phase1-session',
    status: 'ready',
    pendingInteractions: new Map(),
    approvalAllowlist: new Set(),
    redact(value) { return String(value); },
    child: {
      stdin: {
        destroyed: false,
        write(line) { replies.push(JSON.parse(line)); },
      },
    },
    emit(type, data) { emitted.push({ type, data }); },
  };
  supervisor.workers.set(worker.caseId, worker);

  supervisor._enqueueApproval(worker, { id: 1 }, {
    sessionId: worker.sessionId,
    approvalId: 'approval-1',
    toolName: 'fake_powerful',
    reason: gate.reason,
  });
  const [pending] = supervisor.listPendingInteractions(worker.caseId);
  assert.equal(pending.toolName, 'fake_powerful');
  assert.equal(pending.reason, gate.reason, '完整 reason 必须进入刷新快照');
  assert.equal(emitted.at(-1)?.data?.reason, gate.reason, '完整 reason 必须进入实时 SSE 事件');

  const first = supervisor.resolveApproval(
    worker.caseId,
    pending.id,
    'allowed-once',
    { rememberTool: true },
  );
  assert.equal(first.ok, true);
  assert.equal(worker.approvalAllowlist.has('fake_powerful'), true);
  assert.equal(replies.at(-1)?.result?.outcome, 'allowed-once');

  const beforeSecond = emitted.length;
  supervisor._enqueueApproval(worker, { id: 2 }, {
    sessionId: worker.sessionId,
    approvalId: 'approval-2',
    toolName: 'fake_powerful',
    reason: 'second call',
  });
  assert.equal(worker.pendingInteractions.size, 0, '同一 live session/case 的同类放行不应再生成卡片');
  assert.equal(emitted.length, beforeSecond, '同类放行命中后不应再广播 pending');
  assert.equal(replies.at(-1)?.id, 2);
  assert.equal(replies.at(-1)?.result?.outcome, 'allowed-once');

  const drawerSource = fs.readFileSync(new URL('../public/js/agent-drawer.js', import.meta.url), 'utf8');
  assert.match(drawerSource, /本类不再询问/);
  assert.match(drawerSource, /reason/);

  console.log('agent Phase 1 approval policy: fake powerful ask + full reason + remember-per-session/tool passed');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
