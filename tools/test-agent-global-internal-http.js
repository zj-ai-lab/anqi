import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-global-internal-'));
process.env.DB_PATH = path.join(scratch, 'global.db');
process.env.ANJIAN_INTERNAL_KEY = 'global-internal-key';
const { db } = await import('../src/db.js');
const router = (await import('../src/routes/internal.js')).default;
const { internalAuth } = await import('../src/middleware/auth.js');
const registry = await import('../src/agent/session-registry.js');
const { todayCN, weekdayCN } = await import('../src/lib/dates.js');
// weekdayCN 只看日期字符串本身，与进程时区无关。
assert.equal(weekdayCN('2026-10-13'), '星期二'); assert.equal(weekdayCN('2099-11-04'), '星期三'); assert.equal(weekdayCN('2026-02-30x'), '');
registry._resetSessionRegistryForTest();

const app = express();
app.use(express.json());
app.use('/internal', internalAuth, router);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const headers = { 'X-Anjian-Key': process.env.ANJIAN_INTERNAL_KEY, 'Content-Type': 'application/json' };
async function req(pathname, options = {}) {
  const response = await fetch(base + pathname, { headers, ...options });
  return { status: response.status, data: await response.json() };
}
async function post(pathname, body) {
  return req(pathname, { method: 'POST', body: JSON.stringify(body) });
}
const counts = () => Object.fromEntries(
  ['events', 'deadlines', 'tasks', 'worklog', 'contacts', 'facts']
    .map((table) => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n])
);
const beforeCounts = counts();

const one = db.prepare("INSERT INTO cases (name,client,case_no,court,status) VALUES ('张三案','张三','(2099)测0000民初1号','测试人民法院','active')").run().lastInsertRowid;
const two = db.prepare("INSERT INTO cases (name,client,case_no,court,status) VALUES ('李四案','李四','(2099)测0000民初2号','测试人民法院','active')").run().lastInsertRowid;
const three = db.prepare("INSERT INTO cases (name,client,case_no,court,status) VALUES ('张三第二案','张三','(2099)测0000民初3号','测试人民法院','active')").run().lastInsertRowid;
const unoffered = db.prepare("INSERT INTO cases (name,client,case_no,court,status) VALUES ('王五案','王五','(2099)测0000民初5号','测试人民法院','active')").run().lastInsertRowid;
const closed = db.prepare("INSERT INTO cases (name,client,case_no,court,status) VALUES ('已结张三案','张三','(2099)测0000民初9号','测试人民法院','closed')").run().lastInsertRowid;
assert.ok(unoffered > 0 && closed > 0);

const sessionId = 'global-http-session';
const caseSessionId = 'case-http-session';
registry.bindGlobalSession(sessionId);
registry.bindSession(caseSessionId, one);

try {
  // Global-only resolve/select: a case-bound session cannot use either endpoint.
  let out = await post('/internal/agent-case-resolve', { session_id: caseSessionId, parties: ['张三'] });
  assert.equal(out.status, 403); assert.equal(out.data.code, 'session_scope_invalid');
  out = await post('/internal/agent-case-select', { session_id: caseSessionId, case_id: one });
  assert.equal(out.status, 403); assert.equal(out.data.code, 'session_scope_invalid');

  out = await req('/internal/agent-case-view?session_id=' + sessionId);
  assert.equal(out.status, 403); assert.equal(out.data.code, 'case_not_granted');
  out = await req(`/internal/agent-case-view?session_id=${sessionId}&case_id=${three}`);
  assert.equal(out.status, 403); assert.equal(out.data.code, 'case_not_granted');

  // Two active 张三 cases are offered; no automatic grant is returned.
  out = await post('/internal/agent-case-resolve', { session_id: sessionId, parties: ['张三'] });
  assert.equal(out.status, 200); assert.equal(out.data.match, 'multiple');
  assert.equal(out.data.candidates.length, 2); assert.equal('granted_case_id' in out.data, false);
  const selected = out.data.candidates.find((row) => row.id === one)?.id;
  assert.equal(selected, one);
  out = await post('/internal/agent-case-select', { session_id: sessionId, case_id: selected });
  assert.deepEqual(out, { status: 200, data: { granted_case_id: selected } });
  out = await post('/internal/agent-case-select', { session_id: sessionId, case_id: two });
  assert.equal(out.status, 403); assert.equal(out.data.code, 'case_not_offered');

  // A later unique resolve grants 李四 without revoking the earlier 张三 grant.
  out = await post('/internal/agent-case-resolve', { session_id: sessionId, parties: ['李四'] });
  assert.equal(out.status, 200); assert.equal(out.data.match, 'unique'); assert.equal(out.data.granted_case_id, two);
  // 总入口靠 resolve 拿「今天」：北京时间日期 + 星期，模型不必问律师。
  assert.equal(out.data.today, todayCN()); assert.equal(out.data.weekday, weekdayCN(todayCN())); assert.match(out.data.weekday, /^星期[日一二三四五六]$/u);
  out = await req(`/internal/agent-case-view?session_id=${sessionId}&case_id=${selected}`);
  assert.equal(out.status, 200); assert.equal(out.data.case.id, selected);
  out = await post('/internal/agent-case-resolve', { session_id: sessionId, parties: ['不存在'] });
  assert.equal(out.status, 200); assert.equal(out.data.match, 'none'); assert.equal('granted_case_id' in out.data, false);

  // Global digest remains fail-closed because caseIdForSession(global) is null.
  out = await req('/internal/agent-digest?session_id=' + sessionId);
  assert.equal(out.status, 403);

  // Direct-write authorization matrix.
  out = await post('/internal/agent-proposals', {
    mode: 'direct', kind: 'event', session_id: sessionId, case_id: three,
    payload: { type: 'other', occurred_on: '2099-02-01' },
  });
  assert.equal(out.status, 403); assert.equal(out.data.code, 'case_not_granted');
  out = await post('/internal/agent-proposals', {
    mode: 'direct', kind: 'event', session_id: sessionId, case_id: selected,
    payload: { type: 'other', occurred_on: '2099-02-01' },
  });
  assert.equal(out.status, 201); assert.equal(out.data.item.created_by, 'llm'); assert.equal(out.data.case_id, selected);
  out = await post('/internal/agent-proposals', {
    mode: 'direct', kind: 'contact', session_id: sessionId,
    payload: { role: '承办法官', name: '王助理' },
  });
  assert.equal(out.status, 400); assert.equal(out.data.code, 'case_id_required');
  out = await post('/internal/agent-proposals', {
    mode: 'direct', kind: 'contact', session_id: sessionId, case_id: selected,
    payload: { role: '承办法官', name: '王助理' },
  });
  assert.equal(out.status, 201); assert.equal(out.data.item.created_by, 'ai');
  out = await post('/internal/agent-proposals', {
    mode: 'direct', kind: 'fact', session_id: sessionId, case_id: selected,
    payload: { content: '已通知补证' },
  });
  assert.equal(out.status, 201); assert.equal(out.data.item.created_by, 'ai');
  out = await post('/internal/agent-proposals', {
    mode: 'direct', kind: 'deadline', session_id: sessionId, case_id: selected,
    payload: { name: '律师口述期限', due_on: '2099-03-01' },
  });
  assert.equal(out.status, 201); assert.equal(out.data.item.created_by, 'ai');
  assert.equal(out.data.item.review_status, 'pending_review');
  out = await post('/internal/agent-proposals', {
    mode: 'direct', kind: 'task', session_id: sessionId, case_id: selected,
    payload: { title: '已授予案件待办' },
  });
  assert.equal(out.status, 201); assert.equal(out.data.item.origin, 'llm'); assert.equal(out.data.item.case_id, selected);
  out = await post('/internal/agent-proposals', {
    mode: 'direct', kind: 'worklog', session_id: sessionId,
    payload: { content: '所务记录', worked_on: '2099-01-01' },
  });
  assert.equal(out.status, 201); assert.equal(out.data.case_id, null); assert.equal(out.data.item.created_by, 'ai');

  // A case session still ignores both top-level and payload case_id.
  out = await post('/internal/agent-proposals', {
    mode: 'direct', kind: 'worklog', session_id: caseSessionId, case_id: two,
    payload: { content: '绑定案日志', worked_on: '2099-01-02', case_id: two },
  });
  assert.equal(out.status, 201); assert.equal(out.data.item.created_by, 'ai'); assert.equal(out.data.item.case_id, one);

  // Soft suggestions: global requires a granted case and preserves it in inbox.
  const ref = (callId) => ({ session_id: sessionId, call_id: callId, root_call_id: 'root-1' });
  out = await post('/internal/agent-proposals', {
    session_id: sessionId, proposal_id: 'soft-no-case', payload: { title: '无案软建议' }, source_ref: ref('soft-1'),
  });
  assert.equal(out.status, 400);
  out = await post('/internal/agent-proposals', {
    session_id: sessionId, case_id: three, proposal_id: 'soft-ungranted', payload: { title: '未授予软建议' }, source_ref: ref('soft-2'),
  });
  assert.equal(out.status, 403); assert.equal(out.data.code, 'case_not_granted');
  out = await post('/internal/agent-proposals', {
    session_id: sessionId, case_id: selected, proposal_id: 'soft-granted', payload: { title: '已授予软建议' }, source_ref: ref('soft-3'),
  });
  assert.equal(out.status, 201);
  assert.equal(db.prepare('SELECT case_id FROM inbox WHERE id=?').get(out.data.item_id).case_id, selected);

  // Closed matches are counted but never offered as candidates.
  out = await post('/internal/agent-case-resolve', { session_id: sessionId, parties: ['张三'] });
  assert.equal(out.status, 200); assert.equal(out.data.inactive_hits, 1);
  assert.equal(out.data.candidates.some((row) => row.id === closed), false);

  // Audit details contain only match/count metadata, never the original hints.
  const resolveAudits = db.prepare("SELECT action,detail FROM audit_log WHERE action='agent-case-resolve'").all();
  const selectAudits = db.prepare("SELECT action,detail FROM audit_log WHERE action='agent-case-select'").all();
  assert.ok(resolveAudits.length >= 1); assert.ok(selectAudits.length >= 1);
  assert.ok(resolveAudits.every((row) => !row.detail.includes('张三') && !row.detail.includes('李四')));

  registry.unbindSession(sessionId);
  out = await req(`/internal/agent-case-view?session_id=${sessionId}&case_id=${selected}`);
  assert.equal(out.status, 403);
  out = await post('/internal/agent-case-resolve', { session_id: sessionId, parties: ['张三'] });
  assert.equal(out.status, 403);
  out = await post('/internal/agent-case-select', { session_id: sessionId, case_id: selected });
  assert.equal(out.status, 403);
  out = await post('/internal/agent-proposals', {
    mode: 'direct', kind: 'worklog', session_id: sessionId, payload: { content: '解绑后不得写入' },
  });
  assert.equal(out.status, 403);

  const afterCounts = counts();
  assert.deepEqual(Object.fromEntries(Object.keys(beforeCounts).map((table) => [table, afterCounts[table] - beforeCounts[table]])), {
    events: 1, deadlines: 1, tasks: 1, worklog: 2, contacts: 1, facts: 1,
  });
  console.log('global internal HTTP: resolve/select/grant, scoped reads, direct/soft write matrix, audit redaction, row-count accounting and fail-closed trust boundary passed');
} finally {
  registry.unbindSession(sessionId);
  registry.unbindSession(caseSessionId);
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  registry._resetSessionRegistryForTest();
}
