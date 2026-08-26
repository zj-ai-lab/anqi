// /internal/agent-proposals 路由层回归：软建议 kind 不再限 task、source 伪造→400、
// session_id 缺失/未绑定→400/403、payload/source_ref 白名单、case_id 绝不信任请求体
// （即使 body 带 case_id 也必须被忽略，caseId 只能来自 session-registry 反查）、
// source_ref.session_id 同理绝不信任请求体（落库的必须是反查用的权威 session_id）、
// case_not_found→404、201/200 幂等状态码。
//
// 这条路由的"必须由 supervisor 登记 session→case 绑定"是设计稿 §2/§4 的红线要求，
// 但 AgentSupervisor 真正 spawn DSH 子进程的门槛很高（需要 provider/apiKey/真实案件夹），
// 不适合在这里整套跑起来。session-registry.js 的登记/反查是纯内存 Map、与 supervisor
// 的进程管理彻底解耦，所以本测试直接调用 bindSession()/unbindSession() 模拟 supervisor
// 侧的登记动作，只对路由的"信任边界"这一件事做黑盒 HTTP 验证——与 tools/test-inbox-http.js
// 的黑盒风格一致，但用同进程 http server（不 spawn server.js 子进程）：session-registry
// 是进程内 Map，子进程间不共享，必须和被测路由在同一个 Node 进程里才能注入绑定。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-proposals-http-'));
process.env.DB_PATH = path.join(scratch, 'agent-proposals-http.db');
process.env.ANJIAN_INTERNAL_KEY = 'agent-proposals-http-key';
delete process.env.ANJIAN_UNSAFE_NO_AUTH;

const { db } = await import('../src/db.js');
const { internalAuth } = await import('../src/middleware/auth.js');
const internalRouter = (await import('../src/routes/internal.js')).default;
const { bindSession, unbindSession, _resetSessionRegistryForTest } = await import('../src/agent/session-registry.js');

_resetSessionRegistryForTest();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/internal', internalAuth, internalRouter);

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function post(body, expected) {
  const response = await fetch(base + '/internal/agent-proposals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Anjian-Key': process.env.ANJIAN_INTERNAL_KEY },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  assert.equal(response.status, expected, `POST /internal/agent-proposals: ${response.status} ${raw}`);
  return data;
}

const caseId = db.prepare(
  "INSERT INTO cases (name, procedure, stage) VALUES ('张三诉李四合同纠纷（agent 提案 http 测试）','一审','审理中')"
).run().lastInsertRowid;

const sessionId = 'anqi-http-test-session-1';
bindSession(sessionId, caseId);

const ref = (callId) => ({ session_id: sessionId, call_id: callId, root_call_id: 'root-1' });

try {
  // ---- 旧 kind 限制主动移除：event/deadline 名义的软建议仍只落 inbox task 卡，
  //      不会借此直接创建正式 event/deadline ----
  const eventSoft = await post(
    { session_id: sessionId, proposal_id: 'p-1', kind: 'event', payload: { title: '核对事件' }, source_ref: ref('c1') },
    201
  );
  const deadlineSoft = await post(
    { session_id: sessionId, proposal_id: 'p-2', kind: 'deadline', payload: { title: '核对期限' }, source_ref: ref('c2') },
    201
  );
  assert.equal(eventSoft.item.kind, 'task');
  assert.equal(deadlineSoft.item.kind, 'task');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM events WHERE case_id=?').get(caseId).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM deadlines WHERE case_id=?').get(caseId).c, 0);

  // ---- source 由服务端固定，body 伪造直接拒绝 ----
  await post({ session_id: sessionId, proposal_id: 'p-3', source: 'llm-suggest', payload: { title: 'x' }, source_ref: ref('c3') }, 400);

  // ---- session_id 缺失/非法 ----
  await post({ proposal_id: 'p-4', payload: { title: 'x' }, source_ref: ref('c4') }, 400);
  await post({ session_id: '', proposal_id: 'p-4', payload: { title: 'x' }, source_ref: ref('c4') }, 400);

  // ---- session_id 未绑定（未曾 bindSession，或已经被 unbindSession 收尾）----
  const unbound403 = await post(
    { session_id: 'no-such-session', proposal_id: 'p-5', payload: { title: 'x' }, source_ref: ref('c5') },
    403
  );
  assert.equal(unbound403.code, 'session_not_bound');

  // ---- case_id 绝不信任请求体：即使 body 带了别的 case_id 也必须被忽略，
  //      落库的 case_id 只能是 session-registry 反查出来的那个 ----
  const spoofedCaseId = caseId + 999;
  const created = await post(
    {
      session_id: sessionId, case_id: spoofedCaseId, proposal_id: 'p-6',
      payload: { title: '核对送达回证', priority: 'normal', basis: 'HTTP 回归依据' },
      source_ref: ref('c6'),
    },
    201
  );
  assert.equal(created.created, true);
  assert.equal(created.item.case_id, caseId, 'case_id 必须来自 session 绑定，body.case_id 必须被忽略');
  assert.notEqual(created.item.case_id, spoofedCaseId);
  const storedPayload = JSON.parse(created.item.payload);
  assert.equal(storedPayload.basis, 'HTTP 回归依据', 'payload.basis 必须原样落库，供 today.js 渲染"依据："');

  // ---- source_ref.session_id 绝不信任请求体：即使 body 里的 source_ref.session_id
  //      填了一个别的 session，落库的必须是路由反查用的那个真实 session_id ----
  const spoofedRefCreated = await post(
    {
      session_id: sessionId, proposal_id: 'p-6b', payload: { title: '核对身份证复印件' },
      source_ref: { session_id: 'attacker-claimed-session', call_id: 'c6b', root_call_id: 'root-1' },
    },
    201
  );
  const spoofedRefStored = JSON.parse(spoofedRefCreated.item.source_ref);
  assert.equal(spoofedRefStored.session_id, sessionId, 'source_ref.session_id 必须被服务端权威值覆盖，不采信 body 自报值');
  assert.notEqual(spoofedRefStored.session_id, 'attacker-claimed-session', 'body 里伪造的 session_id 不应该原样落库');

  // ---- payload 白名单：note/evidence 等旧字段名必须被拒绝 ----
  await post(
    { session_id: sessionId, proposal_id: 'p-7', payload: { title: 'x', note: '旧字段名' }, source_ref: ref('c7') },
    400
  );

  // ---- source_ref 必备且字段名白名单：缺失、旧字段名（session/turn/toolCallId）都拒绝 ----
  await post({ session_id: sessionId, proposal_id: 'p-8', payload: { title: 'x' } }, 400);
  await post(
    {
      session_id: sessionId, proposal_id: 'p-9', payload: { title: 'x' },
      source_ref: { session: 'sess-1', turn: '1', toolCallId: 'call-1' },
    },
    400
  );

  // ---- 幂等状态码：同 proposal_id 重试 200 coalesced，不同 proposal_id 201 ----
  const retry = await post(
    { session_id: sessionId, proposal_id: 'p-6', payload: { title: '核对送达回证（重试措辞不同）' }, source_ref: ref('c10') },
    200
  );
  assert.equal(retry.created, false);
  assert.equal(retry.outcome, 'coalesced');
  assert.equal(retry.item_id, created.item_id);

  // ---- worker 收尾（unbindSession）后，同一个 session_id 不能再提交新提案 ----
  unbindSession(sessionId);
  const afterUnbind = await post(
    { session_id: sessionId, proposal_id: 'p-11', payload: { title: 'y' }, source_ref: ref('c11') },
    403
  );
  assert.equal(afterUnbind.code, 'session_not_bound');

  // ---- case_not_found：session 绑定指向一个已不存在的 case（供 supervisor 极端时序兜底）----
  const staleSession = 'anqi-http-test-session-stale';
  bindSession(staleSession, 9999999);
  const staleRefBody = { session_id: staleSession, proposal_id: 'p-12', payload: { title: 'z' }, source_ref: ref('c12') };
  staleRefBody.source_ref.session_id = staleSession;
  const notFound = await post(staleRefBody, 404);
  assert.equal(notFound.code, 'case_not_found');
  unbindSession(staleSession);

  console.log('agent-proposals HTTP tests: soft kind normalization + source/session trust boundary + payload/source_ref whitelist + idempotent statuses passed');
} finally {
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
