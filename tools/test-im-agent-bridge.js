import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-im-bridge-'));
process.env.DB_PATH = path.join(scratch, 'bridge.db');
const { runMigrations, db } = await import('../src/db.js');
runMigrations(db);
const { createAgentBridge } = await import('../src/lib/im/agent-bridge.js');
const { GLOBAL_SCOPE } = await import('../src/agent/supervisor.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class FakeSupervisor {
  constructor() { this.listeners = new Set(); this.live = true; this.promptCalls = []; this.pending = []; this.starts = 0; this.cancelCalls = 0; this.answers = []; this.startResult = {}; this.promptError = null; this.nextTurnId = 1; }
  onEvent(_scope, fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(event) { for (const fn of this.listeners) fn(event); }
  isLive() { return this.live; }
  async start() { this.starts += 1; this.live = this.startResult.status !== 'error'; return this.startResult; }
  prompt(...args) {
    this.promptCalls.push(args);
    const turnId = this.nextTurnId++;
    this.emit({ type: 'turn/start', data: { turnId, origin: 'im:wecom' } });
    return new Promise((resolve, reject) => this.pending.push({ turnId, resolve, reject }));
  }
  finish(text = '最终回复', index = 0, { origin = 'im:wecom' } = {}) {
    const item = this.pending[index];
    if (!item) throw new Error('no pending prompt');
    if (origin === 'web') this.emit({ type: 'turn/start', data: { turnId: item.turnId } });
    this.emit({ type: 'assistant/message', origin: 'wire', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text }] } } });
    this.emit({ type: 'turn/end', data: { turnId: item.turnId, outcome: 'completed' } });
    item.resolve({ turnId: item.turnId });
    this.pending.splice(index, 1);
  }
  reject(error, index = 0) { const item = this.pending[index]; item.reject(error); this.pending.splice(index, 1); }
  cancelTurn() { this.cancelCalls += 1; const item = this.pending.shift(); item?.reject(Object.assign(new Error('turn cancelled'), { code: 'cancelled' })); return { ok: true }; }
  resolveQuestion(_scope, id, answer) { this.answers.push({ id, answer }); return { ok: true }; }
}
function transport() {
  return { replies: [], pushes: [], async replyStream(...args) { this.replies.push(args); return { status: 'sent' }; }, async sendMarkdown(...args) { this.pushes.push(args); return { status: 'sent' }; } };
}
function message(text, id = `m-${Math.random()}`) { return { msgid: id, userid: 'zhangsan_test', text, frame: { body: { from: { userid: 'zhangsan_test' } }, headers: { req_id: id } } }; }
function make(loadConfig = () => ({ enabled: true }), options = {}) {
  const supervisor = new FakeSupervisor();
  const first = transport();
  let current = first;
  const bridge = createAgentBridge({ db, supervisor, hub: { ownerUserid: () => 'zhangsan_test' }, getTransport: () => current, loadConfig, timeoutMs: options.timeoutMs ?? 1000, maxQueue: 3 });
  return { supervisor, bridge, first, setTransport(value) { current = value; } };
}
async function waitFor(predicate, timeoutMs = 500) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (predicate()) return true; await sleep(5); } return predicate(); }

// disabled gate and worker startup failure are human-readable and do not prompt
{
  const x = make(() => ({ enabled: false }));
  assert.equal(await x.bridge.handle(message('测试', 'disabled')), 'agent_disabled');
  assert.equal(x.supervisor.promptCalls.length, 0);
  assert.match(x.first.replies.at(-1)[2], /AI 助理没有开启/);
  x.bridge.close();
  const y = make(() => ({ enabled: true }));
  y.supervisor.live = false; y.supervisor.startResult = { status: 'error' };
  assert.equal(await y.bridge.handle(message('启动失败', 'start-fail')), 'failed');
  assert.equal(y.supervisor.promptCalls.length, 0);
  y.bridge.close();
}

// normal turn: origin is passed, real wire assistant data has no supervisor turnId, and last text wins
{
  const x = make();
  x.supervisor.live = false;
  const pending = x.bridge.handle(message('记一条', 'normal'));
  assert.ok(await waitFor(() => x.supervisor.promptCalls.length === 1));
  assert.equal(x.supervisor.promptCalls[0][0], GLOBAL_SCOPE);
  assert.equal(x.supervisor.promptCalls[0][3].origin, 'im:wecom');
  x.supervisor.emit({ type: 'assistant/message', origin: 'wire', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '中间' }] } } });
  x.supervisor.emit({ type: 'assistant/message', origin: 'wire', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '最终' }] } } });
  x.supervisor.emit({ type: 'turn/end', data: { turnId: 1, outcome: 'completed' } });
  x.supervisor.pending[0].resolve({ turnId: 1 }); x.supervisor.pending.shift();
  assert.equal(await pending, 'prompted');
  assert.equal(x.first.replies[0][2], '收到，正在处理…');
  assert.equal(x.first.replies.at(-1)[2], '最终');
  assert.equal(x.first.replies.at(-1)[3], true);
  x.bridge.close();
}

// question/approval/expired are sent only for the active IM turn; web events do not leak
{
  const x = make();
  const run = x.bridge.handle(message('网页排队后企微', 'interaction'));
  assert.ok(await waitFor(() => x.supervisor.promptCalls.length === 1));
  x.supervisor.emit({ type: 'turn/start', data: { turnId: 999 } });
  x.supervisor.emit({ type: 'interaction/pending', data: { interactionId: 'web-q', type: 'question', questions: [{ id: 'q', question: '网页题' }] } });
  x.supervisor.emit({ type: 'interaction/pending', data: { interactionId: 'web-a', type: 'approval' } });
  assert.equal(x.first.pushes.length, 0);
  x.supervisor.emit({ type: 'turn/start', data: { turnId: 1, origin: 'im:wecom' } });
  x.supervisor.emit({ type: 'interaction/pending', data: { interactionId: 'im-q', type: 'question', questions: [{ id: 'q', question: '企微题' }] } });
  x.supervisor.emit({ type: 'interaction/pending', data: { interactionId: 'im-a', type: 'approval' } });
  assert.equal(x.first.pushes.length, 2);
  assert.match(x.first.pushes[0][1], /企微题/);
  assert.match(x.first.pushes[1][1], /不能批准/);
  x.supervisor.emit({ type: 'interaction/expired', data: { interactionId: 'im-q' } });
  assert.match(x.first.pushes.at(-1)[1], /已超时/);
  x.supervisor.emit({ type: 'turn/end', data: { turnId: 1, outcome: 'completed' } });
  x.supervisor.pending[0].resolve({ turnId: 1 }); x.supervisor.pending.shift();
  await run;
  x.bridge.close();
}

// question answering uses the shared validator and resolveQuestion, never starts a second prompt
{
  const x = make();
  const run = x.bridge.handle(message('开始', 'q-start'));
  await waitFor(() => x.supervisor.promptCalls.length === 1);
  x.supervisor.emit({ type: 'interaction/pending', data: { interactionId: 'question-1', type: 'question', questions: [{ id: 'one', question: '第一题' }] } });
  assert.equal(await x.bridge.handle(message('答案', 'q-answer')), 'answered');
  assert.equal(x.supervisor.promptCalls.length, 1);
  assert.deepEqual(x.supervisor.answers[0].answer, { answers: [{ id: 'one', selected: [], custom: '答案' }] });
  x.supervisor.finish('done');
  await run;
  x.bridge.close();
}

// multi-question cardinality and stale answer
{
  const x = make();
  const run = x.bridge.handle(message('开始', 'multi'));
  await waitFor(() => x.supervisor.promptCalls.length === 1);
  x.supervisor.emit({ type: 'interaction/pending', data: { interactionId: 'multi-q', type: 'question', questions: [{ id: 'a', question: 'A' }, { id: 'b', question: 'B' }] } });
  assert.equal(await x.bridge.handle(message('只有一行', 'multi-bad')), 'answered');
  assert.match(x.first.replies.at(-1)[2], /一共 2 个问题/);
  assert.equal(await x.bridge.handle(message('甲\n乙', 'multi-good')), 'answered');
  assert.equal(x.supervisor.answers.at(-1).answer.answers.length, 2);
  x.supervisor.finish('done'); await run; x.bridge.close();
}

// nine-minute handoff, byte-safe truncation and controls
{
  const x = make(undefined, { timeoutMs: 20 });
  const run = x.bridge.handle(message('慢任务', 'slow'));
  await waitFor(() => x.supervisor.promptCalls.length === 1);
  await sleep(35);
  assert.match(x.first.replies.at(-1)[2], /处理时间较长/);
  x.supervisor.finish(`\u0000${'界'.repeat(10000)}\u0007`);
  await run;
  assert.ok(x.first.pushes.length >= 1);
  const final = x.first.pushes.at(-1)[1];
  assert.ok(!final.includes('\u0000') && Buffer.byteLength(final) <= 20000);
  x.bridge.close();
}

// dynamic transport regression: reload swaps transport and final answer uses the new object
{
  const x = make();
  const run = x.bridge.handle(message('换连接', 'reload'));
  await waitFor(() => x.supervisor.promptCalls.length === 1);
  const second = transport(); x.setTransport(second);
  x.supervisor.finish('新连接回复');
  await run;
  assert.equal(x.first.replies.length, 1);
  assert.equal(second.replies.at(-1)[2], '新连接回复');
  x.bridge.close();
}

// cancellation, error mappings and queue limit
{
  const x = make();
  const run = x.bridge.handle(message('正在跑', 'cancel-run'));
  await waitFor(() => x.supervisor.promptCalls.length === 1);
  assert.equal(await x.bridge.handle(message('取消', 'cancel')), 'cancel');
  assert.equal(x.supervisor.cancelCalls, 1);
  assert.match(x.first.replies.at(-1)[2], /已取消/);
  await run;
  assert.equal(await x.bridge.handle(message('停', 'cancel-idle')), 'cancel');
  assert.match(x.first.replies.at(-1)[2], /没有正在处理/);
  x.bridge.close();

  for (const [messageText, error, expected] of [['超时', Object.assign(new Error('turn timed out'), { code: 'timeout' }), '处理超时'], ['需取消', Object.assign(new Error('turn cancelled'), { code: 'cancelled' }), '已取消'], ['错误', new Error('raw secret error'), 'AI 助理出错']]) {
    const y = make(); const p = y.bridge.handle(message(messageText, `reject-${expected}`)); await waitFor(() => y.supervisor.promptCalls.length === 1); y.supervisor.reject(error); await p; assert.match(y.first.replies.at(-1)[2], new RegExp(expected)); assert.ok(!y.first.replies.at(-1)[2].includes('raw secret error')); y.bridge.close();
  }

  const z = make();
  const first = z.bridge.handle(message('一', 'queue-1'));
  await waitFor(() => z.supervisor.promptCalls.length === 1);
  assert.equal(await z.bridge.handle(message('二', 'queue-2')), 'prompted');
  assert.equal(await z.bridge.handle(message('三', 'queue-3')), 'prompted');
  assert.equal(await z.bridge.handle(message('四', 'queue-4')), 'prompted');
  assert.equal(await z.bridge.handle(message('五', 'queue-5')), 'busy');
  z.supervisor.finish('one'); await first; z.bridge.close();
}

console.log('IM agent bridge full origin/wire/interaction/timeout/cancel/queue/transport matrix passed');
try { db.close(); } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
