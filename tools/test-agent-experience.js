import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-experience-'));
process.env.DB_PATH = path.join(scratch, 'experience.db');

try {
  const { AgentSupervisor } = await import('../src/agent/supervisor.js');
  const supervisor = new AgentSupervisor();
  const emitted = [];
  const redact = (value) => String(value);
  redact.deep = (value) => value;
  const worker = {
    caseId: 155,
    caseName: '体验回归案',
    sessionId: 'phase5-session',
    status: 'ready',
    approvalTier: '1',
    pendingInteractions: new Map(),
    uiHistory: [],
    redact,
    emit(type, data) { emitted.push({ type, data }); },
  };
  supervisor.workers.set(worker.caseId, worker);

  supervisor._appendUiHistory(worker, { role: 'user', text: '请概括案情' });
  supervisor._handleNotification(worker, {
    method: 'session.event',
    params: {
      sessionId: worker.sessionId,
      event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这是案情摘要。' }] } } },
    },
  });
  supervisor._handleNotification(worker, {
    method: 'session.event',
    params: {
      sessionId: worker.sessionId,
      event: { type: 'tool/call', data: { callId: 'call-1', name: 'anqi_case_get', arguments: '{}' } },
    },
  });

  const snapshot = supervisor.publicStatus(worker.caseId);
  assert.deepEqual(snapshot.history.map((item) => item.role), ['user', 'assistant', 'tool']);
  assert.equal(snapshot.history[0].text, '请概括案情');
  assert.equal(snapshot.history[1].text, '这是案情摘要。');
  assert.equal(snapshot.history[2].name, 'anqi_case_get');
  assert.ok(snapshot.history.every((item) => !('sessionId' in item)), 'UI 历史不得泄漏内部 session id');

  for (let i = 0; i < 205; i += 1) {
    supervisor._appendUiHistory(worker, { role: 'user', text: `bounded-${i}` });
  }
  assert.equal(supervisor.publicStatus(worker.caseId).history.length, 200, '历史快照必须有硬条数上限');
  assert.equal(supervisor.publicStatus(worker.caseId).history.at(-1).text, 'bounded-204');

  const drawer = fs.readFileSync(new URL('../public/js/agent-drawer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(drawer, /启动 AI 助理/, 'Phase 5 后不应再要求先点启动按钮');
  assert.match(drawer, /STARTABLE_STATUSES\.has\(state\.status\)[\s\S]*?agent\/start[\s\S]*?agent\/prompt/,
    '首次发送必须先自动 start，再提交 prompt');
  assert.match(drawer, /data\.history/, '刷新快照必须渲染 supervisor 下发的历史');

  const profileHtml = fs.readFileSync(new URL('../public/profile.html', import.meta.url), 'utf8');
  assert.match(profileHtml, /id="agent-model"[^>]*value="deepseek-v4-flash"/);
  assert.match(profileHtml, /placeholder="deepseek-v4-flash"/);
  const profileJs = fs.readFileSync(new URL('../public/js/profile.js', import.meta.url), 'utf8');
  assert.match(profileJs, /DEFAULT_AGENT_MODEL\s*=\s*'deepseek-v4-flash'/);
  assert.match(profileJs, /s\.agent_model\s*\|\|\s*DEFAULT_AGENT_MODEL/);
  const yaml = fs.readFileSync(new URL('../src/agent/assets/anqi.cordis.yml', import.meta.url), 'utf8');
  assert.match(yaml, /process\.env\.DSH_MODEL \?\? 'deepseek-v4-flash'/);

  console.log('agent Phase 5 experience: send-to-autostart + bounded refresh history + deepseek-v4-flash default passed');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
