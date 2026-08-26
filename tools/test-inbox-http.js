// L2 推荐 HTTP：意图去重、裁决记忆、状态变化重提、原子 accept 与 deadline 写口关闭。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-inbox-http-'));
const dbPath = path.join(scratch, 'inbox.db');
const logPath = path.join(scratch, 'server.log');
const port = 41000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const internalKey = 'inbox-http-key';
const log = fs.openSync(logPath, 'w');
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    DB_PATH: dbPath,
    PORT: String(port),
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    ANJIAN_UNSAFE_NO_AUTH: '1',
    ANJIAN_INTERNAL_KEY: internalKey,
  },
  stdio: ['ignore', log, log],
});
let db;

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try { if ((await fetch(base + '/healthz')).ok) return; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

async function request(method, route, body, expected = 200, internal = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (internal) headers['X-Anjian-Key'] = internalKey;
  const response = await fetch(base + route, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  assert.equal(response.status, expected, `${method} ${route}: ${response.status} ${raw}`);
  return data;
}

const suggestion = (caseName, title, intent, subjectId) => ({
  kind: 'task',
  payload: { title, priority: 'normal', basis: 'HTTP 回归依据' },
  source: 'llm-suggest',
  case_name: caseName,
  recommendation: { intent, ...(subjectId ? { subject_id: subjectId } : {}) },
});

try {
  await waitReady();
  db = new Database(dbPath);
  db.pragma('foreign_keys=ON');
  const caseName = '张三诉李四合同纠纷（推荐测试）';
  const caseId = db.prepare(
    "INSERT INTO cases(name,procedure,stage) VALUES (?,'一审','审理中')"
  ).run(caseName).lastInsertRowid;

  await request('POST', '/internal/inbox', {
    kind: 'deadline', payload: { name: '模型期限', due_on: '2026-08-01' },
    source: 'llm-suggest', case_name: caseName,
  }, 400, true);
  await request('POST', '/internal/inbox', {
    kind: 'event', payload: { type: 'filed', occurred_on: '2026-07-20' },
    source: 'not-llm', case_name: caseName,
  }, 400, true);
  await request('POST', '/internal/inbox', {
    ...suggestion(caseName, '试图藏入日期', 'case.next_action'),
    payload: { title: '试图藏入日期', priority: 'normal', due_on: '2099-01-01' },
  }, 400, true);
  await request('POST', '/internal/inbox', {
    ...suggestion(caseName, '伪造来源', 'case.next_action'), source: 'import',
  }, 400, true);

  let result = await request('POST', '/internal/inbox',
    suggestion(caseName, '核对下一步材料', 'case.next_action'), 201, true);
  assert.equal(result.created, true);
  const nextActionId = result.item_id;
  result = await request('POST', '/internal/inbox',
    suggestion(caseName, '换一种说法：整理材料', 'case.next_action'), 200, true);
  assert.equal(result.outcome, 'coalesced');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM inbox WHERE intent_key='v1:case.next_action'").get().c, 1);
  assert.equal(db.prepare('SELECT seen_count FROM inbox WHERE id=?').get(nextActionId).seen_count, 2);
  const persistedMarker = JSON.parse(db.prepare('SELECT state_marker FROM inbox WHERE id=?').get(nextActionId).state_marker);
  assert.deepEqual(Object.keys(persistedMarker.tasks).sort(), ['count', 'fingerprint']);
  assert.equal(JSON.stringify(persistedMarker).includes('核对下一步材料'), false);

  // 未裁决期间状态变化：刷新原卡，不保留过期文案，也不新建第二张卡。
  db.prepare("INSERT INTO events(case_id,type,occurred_on) VALUES (?,'accepted','2026-07-19')").run(caseId);
  result = await request('POST', '/internal/inbox',
    suggestion(caseName, '状态变化后的新动作', 'case.next_action'), 200, true);
  assert.equal(result.outcome, 'refreshed_after_state_change');
  assert.equal(result.item_id, nextActionId);
  assert.equal(JSON.parse(result.item.payload).title, '状态变化后的新动作');
  assert.match(result.item.change_summary, /程序事件/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM inbox WHERE intent_key='v1:case.next_action'").get().c, 1);

  await request('POST', `/api/inbox/${nextActionId}/snooze`, { until: '2099-01-01', reason: '等待材料' });
  result = await request('POST', '/internal/inbox',
    suggestion(caseName, '再换一种说法', 'case.next_action'), 200, true);
  assert.equal(result.reason, 'snoozed');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM inbox WHERE intent_key='v1:case.next_action'").get().c, 1);
  await request('POST', `/api/inbox/${nextActionId}/decline`, {}, 409);

  // 到期唤回原行，再 accept；双击不会造第二条正式待办。
  db.prepare("UPDATE inbox SET snooze_until='2000-01-01' WHERE id=?").run(nextActionId);
  await request('GET', '/api/inbox?status=pending', undefined);
  const otherCaseId = db.prepare(
    "INSERT INTO cases(name,procedure,stage) VALUES ('另案（越案保护测试）','一审','审理中')"
  ).run().lastInsertRowid;
  await request('POST', `/api/inbox/${nextActionId}/accept`, { payload: { case_id: otherCaseId } }, 400);
  await request('POST', `/api/inbox/${nextActionId}/accept`, {});
  await request('POST', `/api/inbox/${nextActionId}/accept`, {}, 409);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM tasks WHERE case_id=? AND origin='llm'").get(caseId).c, 1);
  result = await request('POST', '/internal/inbox',
    suggestion(caseName, '继续提醒下一步', 'case.next_action'), 200, true);
  assert.equal(result.reason, 'accepted_open');

  // 待办完成是实质变化，允许生成一条新建议并解释原因。
  const taskId = db.prepare("SELECT id FROM tasks WHERE case_id=? AND origin='llm'").get(caseId).id;
  db.prepare("UPDATE tasks SET status='done',done_at='2026-07-20' WHERE id=?").run(taskId);
  result = await request('POST', '/internal/inbox',
    suggestion(caseName, '完成后评估下一步', 'case.next_action'), 201, true);
  assert.equal(result.outcome, 'reproposed_after_state_change');
  assert.match(result.item.change_summary, /待办/);

  // 同状态弃置永久抑制；新增程序事件后才可重提。
  result = await request('POST', '/internal/inbox',
    suggestion(caseName, '核对期限缺口', 'case.deadline_review'), 201, true);
  const deadlineReviewId = result.item_id;
  await request('POST', `/api/inbox/${deadlineReviewId}/decline`, { reason: '当前无需核对' });
  assert.equal(db.prepare('SELECT decision_reason FROM inbox WHERE id=?').get(deadlineReviewId).decision_reason, '当前无需核对');
  result = await request('POST', '/internal/inbox',
    suggestion(caseName, '换写：检查期限', 'case.deadline_review'), 200, true);
  assert.equal(result.reason, 'declined_same_state');
  db.prepare(
    "INSERT INTO events(case_id,type,occurred_on) VALUES (?,'filed','2026-07-20')"
  ).run(caseId);
  result = await request('POST', '/internal/inbox',
    suggestion(caseName, '案件变化后重新核对期限', 'case.deadline_review'), 201, true);
  assert.equal(result.outcome, 'reproposed_after_state_change');
  assert.match(result.item.change_summary, /程序事件/);
  await request('POST', `/api/inbox/${deadlineReviewId}/snooze`, { until: '2099-01-01' }, 409);

  await request('POST', '/internal/inbox',
    suggestion(caseName, '未知意图', 'case.unknown'), 400, true);
  await request('POST', '/internal/inbox',
    suggestion(caseName, '错误收费节点', 'fee.collect', 999999), 400, true);

  const invalidDateInbox = db.prepare(
    `INSERT INTO inbox(kind,payload,source,case_id)
     VALUES ('task',?,'import',?)`
  ).run(JSON.stringify({ title: '非法日期待办', due_on: '明天' }), caseId).lastInsertRowid;
  await request('POST', `/api/inbox/${invalidDateInbox}/accept`, {}, 400);
  assert.equal(db.prepare('SELECT status FROM inbox WHERE id=?').get(invalidDateInbox).status, 'pending');

  const contactId = db.prepare(
    "INSERT INTO contacts(case_id,role,name) VALUES (?,'法官助理','王助理')"
  ).run(caseId).lastInsertRowid;
  const byName = await request('GET', `/internal/cases/byname/${encodeURIComponent(caseName)}`, undefined, 200, true);
  assert.ok(Array.isArray(byName.tasks_recent_closed));
  assert.ok(Array.isArray(byName.recommendations_recent));
  assert.ok(Array.isArray(byName.contacts));
  assert.ok(byName.contacts.some((row) => row.id === contactId && row.created_by === 'manual'));
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  console.log('inbox HTTP tests: intent dedup + feedback memory + state-change reproposal + atomic decisions passed');
} finally {
  child.kill('SIGTERM');
  db?.close();
  fs.closeSync(log);
  fs.rmSync(scratch, { recursive: true, force: true });
}
