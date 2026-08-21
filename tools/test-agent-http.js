// /api/agent* 路由层回归（设计稿 §4）。不 spawn 真实 DSH 子进程、不需要模型
// key：createAgentRouter(supervisor) 是一个接受任意满足接口形状的对象的工厂，
// 这里注入一个纯内存的 FakeSupervisor 记录调用参数、按场景返回预设结果，只
// 对路由自己的职责做黑盒验证——
//   - 状态映射：disabled/error/其它如何变成对应的 HTTP 状态码；
//   - 输入校验：case id 非法/不存在、prompt 文本空/超长、question 答案形状；
//   - 信任边界：interactions/answer 只认 interactionId，不接受任何客户端提交
//     的 case_id/session_id 进入判断（根本不读这样的字段）；
//   - SSE：建立、首帧状态快照、后续事件转发、断开时反订阅。
// AgentSupervisor 自身的生命周期/red-line 覆盖在 tools/test-agent-supervisor.js；
// /internal/agent-proposals 的信任边界覆盖在 tools/test-agent-proposals-http.js；
// 本文件只测 §4 新增的这一层 HTTP 转发/校验代码。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-http-'));
process.env.DB_PATH = path.join(scratch, 'agent-http.db');
delete process.env.ANJIAN_UNSAFE_NO_AUTH;

const { db } = await import('../src/db.js');
const { createAgentRouter } = await import('../src/routes/agent.js');
const { AGENT_SETTINGS_KEYS } = await import('../src/agent/config.js');

// ---- 假 supervisor：只记录调用、按场景返回预设结果 ----
class FakeSupervisor {
  constructor() {
    this.statusResult = { status: 'stopped', caseId: null };
    this.startResult = { status: 'ready', caseId: null };
    this.startThrows = null;
    this.promptCalls = [];
    this.cancelResult = true;
    this.approvalResult = { ok: true };
    this.questionResult = { ok: true };
    this.lastApproval = null;
    this.lastQuestion = null;
    this.interactionOwner = null;
    this.listeners = new Map(); // caseId -> Set<fn>
    // enabled=false 短路的证据字段：SSE 那条路在 config.enabled 为假时必须
    // 完全不触碰 worker 状态，这个计数器让"没调用过 publicStatus()"成为一条
    // 可断言的事实，而不是靠"没看到 ready 帧"间接推断。
    this.publicStatusCalls = 0;
  }
  status() { return this.statusResult; }
  // 真实 supervisor 的安全投影(见 src/agent/supervisor.js publicStatus())：
  // 只吐 status/caseId/caseName/dshVersion/startedAt/provider/model/error/
  // exitInfo，不带 sessionId/cwd/pid——这里照抄同一份字段列表，好让测试断言
  // 真的能验证路由层用的是投影后的方法而不是原始 status()。
  publicStatus() {
    this.publicStatusCalls += 1;
    const full = this.statusResult;
    if (!full) return null;
    const { status, caseId, caseName, dshVersion, startedAt, provider, model, error, exitInfo } = full;
    return { status, caseId, caseName, dshVersion, startedAt, provider, model, error, exitInfo };
  }
  isLive() {
    return ['starting', 'ready', 'running'].includes((this.statusResult || {}).status);
  }
  async start() {
    if (this.startThrows) throw this.startThrows;
    return this.startResult;
  }
  async prompt(caseId, text) {
    this.promptCalls.push({ caseId, text });
    return { turnId: 1 };
  }
  cancelTurn() { return this.cancelResult; }
  onEvent(caseId, listener) {
    if (!this.listeners.has(caseId)) this.listeners.set(caseId, new Set());
    this.listeners.get(caseId).add(listener);
    return () => this.listeners.get(caseId)?.delete(listener);
  }
  emit(caseId, event) {
    for (const fn of this.listeners.get(caseId) || []) fn(event);
  }
  findInteractionOwner() { return this.interactionOwner; }
  resolveApproval(caseId, interactionId, outcome) {
    this.lastApproval = { caseId, interactionId, outcome };
    return this.approvalResult;
  }
  resolveQuestion(caseId, interactionId, answer) {
    this.lastQuestion = { caseId, interactionId, answer };
    return this.questionResult;
  }
}

const supervisor = new FakeSupervisor();
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { req.actor = 'http-test'; next(); }); // 路由本身不做鉴权，鉴权是 server.js 挂载时的事
app.use('/api', createAgentRouter(supervisor));

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, urlPath, body) {
  const response = await fetch(base + urlPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  return { status: response.status, data };
}

function upsertSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

const caseId = db.prepare(
  "INSERT INTO cases (name, procedure, stage) VALUES ('张三诉李四合同纠纷（agent http 测试）','一审','审理中')"
).run().lastInsertRowid;

try {
  // ---- GET /api/agent/status：agent_enabled 未设置 → disabled，不摸任何 case ----
  {
    const { status, data } = await call('GET', '/api/agent/status');
    assert.equal(status, 200);
    assert.deepEqual(data, { status: 'disabled', enabled: false, error: null, configured: null, worker: null });
  }

  // ---- 打开白名单五键，GET status 不带 case_id → stopped/enabled，不查 worker ----
  upsertSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
  upsertSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
  upsertSetting(AGENT_SETTINGS_KEYS.model, 'test-model');
  upsertSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'TEST_AGENT_HTTP_KEY');
  {
    const { status, data } = await call('GET', '/api/agent/status');
    assert.equal(status, 200);
    assert.equal(data.status, 'stopped');
    assert.equal(data.enabled, true);
    assert.deepEqual(data.configured, { provider: 'deepseek-official', model: 'test-model' });
    assert.equal(data.worker, null);
  }

  // ---- GET status?case_id=不存在 → 404；非法 case_id → 400 ----
  {
    const notFound = await call('GET', `/api/agent/status?case_id=${caseId + 999}`);
    assert.equal(notFound.status, 404);
    const badId = await call('GET', '/api/agent/status?case_id=not-a-number');
    assert.equal(badId.status, 400);
  }

  // ---- GET status?case_id=真实案件 → 透传 supervisor.publicStatus() 投影,
  // 不泄漏内部 sessionId/cwd/pid ----
  supervisor.statusResult = {
    status: 'running', caseId, caseName: '张三诉李四合同纠纷（agent http 测试）',
    sessionId: 'anqi-sess-1', pid: 4242, cwd: '/secret/host/path/案件夹/张三诉李四',
  };
  {
    const { status, data } = await call('GET', `/api/agent/status?case_id=${caseId}`);
    assert.equal(status, 200);
    assert.equal(data.status, 'running');
    assert.equal(data.worker.caseName, '张三诉李四合同纠纷（agent http 测试）');
    assert.equal(data.worker.sessionId, undefined, '下行状态投影不应包含内部 sessionId');
    assert.equal(data.worker.pid, undefined, '下行状态投影不应包含宿主 pid');
    assert.equal(data.worker.cwd, undefined, '下行状态投影不应包含案件夹绝对路径');
  }

  // ---- POST start：不存在的案件 → 404 ----
  {
    const { status } = await call('POST', `/api/cases/${caseId + 999}/agent/start`);
    assert.equal(status, 404);
  }

  // ---- POST start：supervisor 返回 disabled/error/其它 → 409/502/200 ----
  supervisor.startResult = { status: 'disabled', caseId, error: 'agent 未启用' };
  {
    const { status, data } = await call('POST', `/api/cases/${caseId}/agent/start`);
    assert.equal(status, 409);
    assert.equal(data.code, 'agent_disabled');
  }
  supervisor.startResult = { status: 'error', caseId, error: 'credential_missing' };
  {
    const { status, data } = await call('POST', `/api/cases/${caseId}/agent/start`);
    assert.equal(status, 502);
    assert.equal(data.code, 'agent_start_failed');
  }
  // 成功态也必须走 publicStatus() 投影：supervisor.start() 的 resolve 值是完整
  // status()（含 sessionId/cwd/pid），原样 res.json 会把 GET /agent/status 与
  // SSE 首帧刚脱敏掉的三个字段从启动响应这条路补回去。
  supervisor.startResult = { status: 'ready', caseId, sessionId: 'anqi-sess-2-should-not-leak' };
  supervisor.statusResult = {
    status: 'ready', caseId, caseName: '张三诉李四合同纠纷（agent http 测试）',
    sessionId: 'anqi-sess-2-should-not-leak', pid: 4243, cwd: '/secret/host/path/案件夹/张三诉李四',
  };
  {
    const { status, data } = await call('POST', `/api/cases/${caseId}/agent/start`);
    assert.equal(status, 200);
    assert.equal(data.status, 'ready');
    assert.equal(data.sessionId, undefined, '启动响应不应包含内部 sessionId');
    assert.equal(data.pid, undefined, '启动响应不应包含宿主 pid');
    assert.equal(data.cwd, undefined, '启动响应不应包含案件夹绝对路径');
    assert.ok(!JSON.stringify(data).includes('should-not-leak'), '启动响应整体不应出现内部 session 标识');
  }
  supervisor.startThrows = new Error('unexpected boom with a stack trace nobody should see');
  {
    const { status, data } = await call('POST', `/api/cases/${caseId}/agent/start`);
    assert.equal(status, 500);
    assert.equal(data.code, 'internal_error');
    assert.ok(!JSON.stringify(data).includes('boom'), '意外异常的内部消息不应该原样吐给客户端');
  }
  supervisor.startThrows = null;

  // ---- POST prompt：不存在的案件 404；空/超长文本 400；worker 未活着 409 ----
  {
    const notFound = await call('POST', `/api/cases/${caseId + 999}/agent/prompt`, { text: 'hi' });
    assert.equal(notFound.status, 404);
    const empty = await call('POST', `/api/cases/${caseId}/agent/prompt`, { text: '   ' });
    assert.equal(empty.status, 400);
    const tooLong = await call('POST', `/api/cases/${caseId}/agent/prompt`, { text: 'x'.repeat(8001) });
    assert.equal(tooLong.status, 400);
  }
  supervisor.statusResult = { status: 'stopped', caseId };
  {
    const { status, data } = await call('POST', `/api/cases/${caseId}/agent/prompt`, { text: '帮我看看这个案子进度' });
    assert.equal(status, 409);
    assert.equal(data.code, 'worker_not_running');
  }
  // ---- worker 活着（starting/ready/running 均可）→ 202，不阻塞等待整轮完成 ----
  supervisor.statusResult = { status: 'ready', caseId };
  {
    const { status, data } = await call('POST', `/api/cases/${caseId}/agent/prompt`, { text: '帮我看看这个案子进度' });
    assert.equal(status, 202);
    assert.equal(data.accepted, true);
    assert.equal(supervisor.promptCalls.length, 1);
    assert.equal(supervisor.promptCalls[0].caseId, caseId);
    assert.equal(supervisor.promptCalls[0].text, '帮我看看这个案子进度');
  }

  // ---- POST cancel：透传 cancelTurn() 的布尔结果 ----
  supervisor.cancelResult = true;
  {
    const { status, data } = await call('POST', `/api/cases/${caseId}/agent/cancel`);
    assert.equal(status, 200);
    assert.equal(data.cancelled, true);
  }
  supervisor.cancelResult = false;
  {
    const { data } = await call('POST', `/api/cases/${caseId}/agent/cancel`);
    assert.equal(data.cancelled, false);
  }

  // ---- interactions/:id/answer：找不到归属 → 404，且不落任何 approval/question 调用 ----
  supervisor.interactionOwner = null;
  {
    const { status, data } = await call('POST', '/api/agent/interactions/no-such-id/answer', { outcome: 'allowed-once' });
    assert.equal(status, 404);
    assert.equal(data.code, 'interaction_not_found');
  }

  // ---- approval：invalid_outcome → 400；resolveApproval 判定失败态 → 409；成功 → 200 ----
  supervisor.interactionOwner = { caseId, record: { type: 'approval' } };
  supervisor.approvalResult = { ok: false, reason: 'invalid_outcome' };
  {
    const { status, data } = await call('POST', '/api/agent/interactions/appr-1/answer', { outcome: 'yolo-allow' });
    assert.equal(status, 400);
    assert.equal(data.code, 'invalid_outcome');
  }
  supervisor.approvalResult = { ok: false, reason: 'unavailable' };
  {
    const { status, data } = await call('POST', '/api/agent/interactions/appr-1/answer', { outcome: 'rejected' });
    assert.equal(status, 409);
    assert.equal(data.code, 'unavailable');
  }
  supervisor.approvalResult = { ok: true };
  {
    const { status, data } = await call('POST', '/api/agent/interactions/appr-1/answer', { outcome: 'allowed-once' });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(supervisor.lastApproval.caseId, caseId, 'caseId 必须来自 findInteractionOwner 反查，不是客户端提交');
    assert.equal(supervisor.lastApproval.outcome, 'allowed-once');
  }

  // ---- question：答案形状必须逐题严格对应，任何一处不符都是 400，且不落 resolveQuestion 调用 ----
  const questions = [{ id: 'q1', question: '被告身份是否已核实？' }, { id: 'q2', question: '证据是否齐全？' }];
  supervisor.interactionOwner = { caseId, record: { type: 'question', questions } };
  supervisor.lastQuestion = null;
  const badShapes = [
    { answers: [{ id: 'q1', text: '是' }] }, // 少答一题
    { answers: [{ id: 'q1', text: '是' }, { id: 'q1', text: '否' }] }, // 重复 id
    { answers: [{ id: 'q1', text: '是' }, { id: 'no-such-id', text: '否' }] }, // 编造 id
    { answers: [{ id: 'q1', text: '' }, { id: 'q2', text: '是' }] }, // 空答案
    { answers: [{ id: 'q1', text: 'x'.repeat(2001) }, { id: 'q2', text: '是' }] }, // 超长
    { answers: 'not-an-array' },
    {},
  ];
  for (const body of badShapes) {
    const { status, data } = await call('POST', '/api/agent/interactions/q-1/answer', body);
    assert.equal(status, 400, `应拒绝的答案形状被放行了：${JSON.stringify(body)}`);
    assert.equal(data.code, 'invalid_answer');
  }
  assert.equal(supervisor.lastQuestion, null, '非法答案形状不应该触达 resolveQuestion()');
  supervisor.questionResult = { ok: true };
  {
    const { status, data } = await call('POST', '/api/agent/interactions/q-1/answer', {
      answers: [{ id: 'q2', text: '齐全' }, { id: 'q1', text: '已核实' }],
    });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(supervisor.lastQuestion.caseId, caseId);
    // 转换成 DSH 协议要求的 { answers: [{id, selected, custom}] } 形状；DSH 按
    // id 匹配，不依赖数组顺序，这里保留请求体提交的顺序（q2 在前）。
    assert.deepEqual(supervisor.lastQuestion.answer, {
      answers: [{ id: 'q2', selected: [], custom: '齐全' }, { id: 'q1', selected: [], custom: '已核实' }],
    });
  }

  // ---- GET events：建立、首帧状态快照、事件转发、断开后反订阅 ----
  supervisor.statusResult = { status: 'ready', caseId, sessionId: 'anqi-sess-should-not-leak' };
  {
    const controller = new AbortController();
    const response = await fetch(base + `/api/cases/${caseId}/agent/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.ok((response.headers.get('content-type') || '').includes('text/event-stream'));

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    async function readUntil(needle, tries = 50) {
      for (let i = 0; i < tries; i += 1) {
        if (buffer.includes(needle)) return;
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before seeing: ${needle}`);
        buffer += decoder.decode(value, { stream: true });
      }
      throw new Error(`timed out waiting for: ${needle} (got: ${buffer})`);
    }

    await readUntil('event: status');
    assert.ok(buffer.includes('"status":"ready"'), '首帧应带上当前状态快照');
    assert.ok(!buffer.includes('anqi-sess-should-not-leak'), 'SSE 首帧不应该泄漏内部 sessionId');

    assert.equal(supervisor.listeners.get(caseId)?.size, 1, '连接建立后应该恰好挂一个监听器');
    // 真实 Worker.emit() 组装的事件形状是 { type, caseId, sessionId, at, data }
    // ——这里照抄同一形状（含 sessionId），验证路由层转发时也做了投影，而不是
    // 只有首帧状态快照脱敏、后续每一帧都把内部 session 标识原样广播出去。
    supervisor.emit(caseId, {
      type: 'turn/start', caseId, sessionId: 'anqi-sess-event-should-not-leak',
      at: new Date().toISOString(), origin: 'wire', data: { turnId: 7 },
    });
    await readUntil('event: turn/start');
    assert.ok(buffer.includes('"turnId":7'));
    assert.ok(!buffer.includes('anqi-sess-event-should-not-leak'), 'SSE 转发帧不应该泄漏内部 sessionId');
    // origin 必须随字段透传：它是前端区分"宿主生命周期事件"与"子进程 wire
    // 上报事件"的唯一依据（wire 侧撞上宿主保留名时已在 supervisor 侧重写成
    // wire/<type>，见 tools/test-agent-supervisor.js 场景 23）。路由层的字段
    // 投影是显式白名单，漏列 origin 就等于把这条来源标记在 SSE 这一跳丢掉。
    assert.ok(buffer.includes('"origin":"wire"'), 'SSE 转发帧必须透传 origin，前端才能区分事件来源可信度');

    controller.abort();
    // req.close 的反订阅是异步收尾，轮询等一下再断言，避免测试本身产生竞态。
    for (let i = 0; i < 50 && (supervisor.listeners.get(caseId)?.size ?? 0) > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(supervisor.listeners.get(caseId)?.size ?? 0, 0, '连接断开后必须反订阅，不能悬挂监听器');
  }

  // ---- GET events：agent_enabled=false 时必须与 REST /api/agent/status 同一
  //      判定短路——首帧 status:'disabled'，且全程不触碰 worker 状态 ----
  // 「enabled=false 在 credential/MCP/spawn 之前全短路」是红线。SSE 是与 REST
  // /api/agent/status 平行的第二条状态通路，如果它在同一份配置下自己去问
  // supervisor 要状态，前端拿到的会是 'stopped'（"开着但没在跑"）而不是
  // 'disabled'（"根本没启用"）——两条路径对同一份配置给出不同判断，用户看到
  // 的开关状态就取决于哪条通路先到。这里同时断言两件事：下发的是 disabled，
  // 以及路由层压根没调用 publicStatus()、没挂监听器（真的短路了，不是先问了
  // worker 再把结果改写成 disabled）。
  {
    upsertSetting(AGENT_SETTINGS_KEYS.enabled, 'false');
    supervisor.publicStatusCalls = 0;
    supervisor.statusResult = { status: 'ready', caseId, sessionId: 'anqi-sess-should-not-leak' };

    const controller = new AbortController();
    const response = await fetch(base + `/api/cases/${caseId}/agent/events`, { signal: controller.signal });
    // 连接仍然建立：前端不需要区分"没配置"和"网络失败"两种连不上。
    assert.equal(response.status, 200, 'enabled=false 时 SSE 连接仍应建立，只是首帧告知 disabled');
    assert.ok((response.headers.get('content-type') || '').includes('text/event-stream'));

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (let i = 0; i < 50 && !buffer.includes('event: status'); i += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    assert.ok(buffer.includes('event: status'), 'enabled=false 时也必须下发首帧 status');
    assert.ok(buffer.includes('"status":"disabled"'), 'enabled=false 的首帧必须是 disabled，不能是 worker 侧的 stopped/ready');
    assert.ok(!buffer.includes('"status":"ready"'), 'enabled=false 时不得下发 worker 的真实状态');
    assert.ok(!buffer.includes('anqi-sess-should-not-leak'), 'disabled 首帧同样不得泄漏内部 sessionId');
    assert.equal(supervisor.publicStatusCalls, 0, 'enabled=false 必须在问 worker 状态之前就短路，不能先调 publicStatus() 再改写结果');
    assert.equal(supervisor.listeners.get(caseId)?.size ?? 0, 0, 'enabled=false 时不应该给 supervisor 挂事件监听器');

    controller.abort();
    upsertSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
  }

  console.log('agent HTTP 路由测试全部通过：状态映射 + 输入校验 + interactions 信任边界 + SSE 建立/转发/反订阅/enabled=false 短路');
} finally {
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
