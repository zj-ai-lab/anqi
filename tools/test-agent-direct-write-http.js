// agent 直写黑盒回归：真实 internalAuth + session 反查 + 五类写入盖戳 + 待核隔离/确认。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-direct-write-http-'));
process.env.DB_PATH = path.join(scratch, 'agent-direct-write-http.db');
process.env.ANJIAN_INTERNAL_KEY = 'agent-direct-write-http-key';
delete process.env.ANJIAN_UNSAFE_NO_AUTH;

const { db } = await import('../src/db.js');
const { internalAuth } = await import('../src/middleware/auth.js');
const internalRouter = (await import('../src/routes/internal.js')).default;
const recordsRouter = (await import('../src/routes/records.js')).default;
const legalragRouter = (await import('../src/routes/legalrag.js')).default;
const contactsRouter = (await import('../src/routes/contacts.js')).default;
const { buildDigest } = await import('../src/lib/digest.js');
const { bindSession, unbindSession, _resetSessionRegistryForTest } = await import('../src/agent/session-registry.js');
const { todayCN, addDays } = await import('../src/lib/dates.js');

_resetSessionRegistryForTest();
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/internal', internalAuth, internalRouter);
app.use('/api', (req, _res, next) => { req.actor = 'web-test'; next(); }, recordsRouter, contactsRouter, legalragRouter);

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(pathname, { method = 'GET', body, internalKey } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (internalKey !== undefined) {
    headers['X-Anjian-Key'] = internalKey;
    headers['X-Anjian-Actor'] = 'dsh-agent';
  }
  const response = await fetch(base + pathname, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  return { status: response.status, data, raw };
}

async function agentWrite(sessionId, kind, payload, { caseId, expected = 201 } = {}) {
  const result = await request('/internal/agent-proposals', {
    method: 'POST',
    internalKey: process.env.ANJIAN_INTERNAL_KEY,
    body: {
      mode: 'direct',
      kind,
      session_id: sessionId,
      case_id: caseId,
      payload,
    },
  });
  assert.equal(result.status, expected, `${kind} direct write: ${result.status} ${result.raw}`);
  return result.data;
}

const ownCaseId = db.prepare(
  "INSERT INTO cases (name,procedure,stage,status) VALUES ('张三诉李四合同纠纷（agent 直写）','一审','审理中','active')"
).run().lastInsertRowid;
const otherCaseId = db.prepare(
  "INSERT INTO cases (name,procedure,stage,status) VALUES ('王五诉赵六合同纠纷（他案）','一审','审理中','active')"
).run().lastInsertRowid;
const otherContactId = db.prepare(
  "INSERT INTO contacts (case_id,role,name) VALUES (?,'其他','他案联系人')"
).run(otherCaseId).lastInsertRowid;
const sessionId = 'anqi-direct-write-session';
bindSession(sessionId, ownCaseId);

try {
  const noKey = await request('/internal/agent-proposals', {
    method: 'POST',
    body: { mode: 'direct', kind: 'task', session_id: sessionId, payload: { title: '不得写入' } },
  });
  assert.equal(noKey.status, 401, 'agent 直写必须受 X-Anjian-Key 保护');

  const unbound = await agentWrite('unbound-session', 'task', { title: '不得写入' }, { expected: 403 });
  assert.equal(unbound.code, 'session_not_bound');

  const contact = await agentWrite(sessionId, 'contact', {
    role: '法官助理',
    name: '王助理',
    phone: '13800138000',
    created_by: 'manual',
  }, { caseId: otherCaseId });
  assert.equal(contact.item.case_id, ownCaseId, 'body.case_id 不得覆盖 session 绑定');
  assert.equal(contact.item.created_by, 'ai');
  assert.equal(db.prepare('SELECT created_by FROM contacts WHERE id=?').get(contact.item.id).created_by, 'ai');

  const contactUpdated = await agentWrite(sessionId, 'contact', {
    id: contact.item.id,
    role: '法官助理',
    name: '王助理（更新）',
    note: '联系送达',
  }, { expected: 200 });
  assert.equal(contactUpdated.item.id, contact.item.id);
  assert.equal(contactUpdated.item.created_by, 'ai', '人工可改不等于抹掉原 AI 来源戳');
  await agentWrite(sessionId, 'contact', { id: otherContactId, name: '越权改名' }, { expected: 404 });
  assert.equal(db.prepare('SELECT name FROM contacts WHERE id=?').get(otherContactId).name, '他案联系人');

  const task = await agentWrite(sessionId, 'task', {
    title: '核对法院送达地址',
    plan_date: todayCN(),
    origin: 'manual',
  }, { caseId: otherCaseId });
  assert.equal(task.item.case_id, ownCaseId);
  assert.equal(task.item.origin, 'llm');
  assert.equal(task.item.created_by, 'llm');

  const event = await agentWrite(sessionId, 'event', {
    type: 'other',
    occurred_on: todayCN(),
    instrument: '电话通知',
    note: '补充材料',
    created_by: 'manual',
  });
  assert.equal(event.item.created_by, 'llm');

  const fact = await agentWrite(sessionId, 'fact', {
    content: '法院已通知补充证据',
    occurred_on: todayCN(),
    source: '电话记录',
    created_by: 'manual',
  });
  assert.equal(fact.item.created_by, 'ai');
  assert.equal(db.prepare('SELECT created_by FROM facts WHERE id=?').get(fact.item.id).created_by, 'ai');

  const dueOn = addDays(todayCN(), 2);
  const deadline = await agentWrite(sessionId, 'deadline', {
    name: '补充证据期限',
    due_on: dueOn,
    severity: 'critical',
    review_status: 'confirmed',
    created_by: 'manual',
  });
  assert.equal(deadline.item.created_by, 'ai');
  assert.equal(deadline.item.review_status, 'pending_review');
  assert.ok(!buildDigest().red.some((row) => row.id === deadline.item.id), '待核期限不得进入 red/今日跑道');
  assert.ok(!buildDigest().week.some((row) => row.id === deadline.item.id), '待核期限不得进入 week');
  assert.ok(!buildDigest().watch.some((row) => row.id === deadline.item.id), '待核期限不得进入 watch');

  const caseView = await request('/internal/agent-case-view', {
    internalKey: process.env.ANJIAN_INTERNAL_KEY,
  });
  assert.equal(caseView.status, 400, 'agent-case-view 仍必须携带 session');
  const scopedViewResponse = await fetch(base + '/internal/agent-case-view', {
    headers: {
      'X-Anjian-Key': process.env.ANJIAN_INTERNAL_KEY,
      'X-Anjian-Session-Id': sessionId,
    },
  });
  assert.equal(scopedViewResponse.status, 200);
  const scopedView = await scopedViewResponse.json();
  assert.ok(scopedView.contacts.some((row) => row.id === contact.item.id && row.created_by === 'ai'));
  assert.ok(scopedView.facts.some((row) => row.id === fact.item.id && row.created_by === 'ai'));
  assert.ok(scopedView.deadlines.some((row) => row.id === deadline.item.id && row.review_status === 'pending_review'));
  assert.ok(scopedView.tasks.some((row) => row.id === task.item.id && row.created_by === 'llm'));
  const taskList = await request(`/api/tasks?case_id=${ownCaseId}`);
  assert.equal(taskList.status, 200);
  assert.ok(taskList.data.some((row) => row.id === task.item.id && row.created_by === 'llm'));

  const confirmed = await request(`/api/deadlines/${deadline.item.id}/confirm-review`, { method: 'POST', body: {} });
  assert.equal(confirmed.status, 200, confirmed.raw);
  assert.equal(confirmed.data.review_status, 'confirmed');
  assert.equal(confirmed.data.created_by, 'ai', '确认待核不得抹掉 AI 来源戳');
  assert.ok(buildDigest().red.some((row) => row.id === deadline.item.id), '确认后期限才进入 red/今日跑道');

  const manualFact = await request(`/api/cases/${ownCaseId}/facts`, {
    method: 'POST',
    body: { content: '当事人已补交授权材料', occurred_on: todayCN(), source: '人工核对' },
  });
  assert.equal(manualFact.status, 200, manualFact.raw);
  assert.equal(manualFact.data.created_by, 'manual');
  const factList = await request(`/api/cases/${ownCaseId}/facts`);
  assert.equal(factList.status, 200);
  assert.ok(factList.data.some((row) => row.id === manualFact.data.id && row.created_by === 'manual'));
  const patchedFact = await request(`/api/facts/${manualFact.data.id}`, {
    method: 'PATCH',
    body: { content: '当事人已补交完整授权材料' },
  });
  assert.equal(patchedFact.status, 200);
  assert.equal(patchedFact.data.content, '当事人已补交完整授权材料');
  const deletedFact = await request(`/api/facts/${manualFact.data.id}`, { method: 'DELETE' });
  assert.equal(deletedFact.status, 200);
  assert.equal(deletedFact.data.ok, true);

  const auditEntities = new Set(db.prepare(
    "SELECT entity FROM audit_log WHERE actor IN ('dsh-agent','web-test')"
  ).all().map((row) => row.entity));
  for (const entity of ['contact', 'task', 'event', 'fact', 'deadline']) {
    assert.ok(auditEntities.has(entity), `${entity} 直写/人工写必须进入审计`);
  }

  console.log(`EVIDENCE_CONTACT ${JSON.stringify({ id: contact.item.id, case_id: contact.item.case_id, role: contact.item.role, name: contactUpdated.item.name, created_by: contact.item.created_by, get_visible: scopedView.contacts.some((row) => row.id === contact.item.id) })}`);
  console.log(`EVIDENCE_DEADLINE_PENDING ${JSON.stringify({ id: deadline.item.id, created_by: deadline.item.created_by, review_status: deadline.item.review_status, red: false, week: false, watch: false })}`);
  console.log(`EVIDENCE_DEADLINE_CONFIRMED ${JSON.stringify({ id: confirmed.data.id, created_by: confirmed.data.created_by, review_status: confirmed.data.review_status, red: buildDigest().red.some((row) => row.id === deadline.item.id) })}`);
  console.log(`EVIDENCE_CASE_GET ${JSON.stringify({ contacts: scopedView.contacts.length, facts: scopedView.facts.length, task_created_by: taskList.data.find((row) => row.id === task.item.id)?.created_by })}`);
  console.log(`EVIDENCE_MANUAL_FACT ${JSON.stringify({ id: manualFact.data.id, created_by: manualFact.data.created_by, patched: patchedFact.data.content, deleted: deletedFact.data.ok })}`);

  unbindSession(sessionId);
  await agentWrite(sessionId, 'fact', { content: '收尾后不得写' }, { expected: 403 });
  console.log('agent direct-write HTTP: key + session-bound case + 5 stamped writes + pending deadline isolation/confirm + manual fact CRUD passed');
} finally {
  unbindSession(sessionId);
  server.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
