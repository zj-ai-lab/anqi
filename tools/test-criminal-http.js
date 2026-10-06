// 回归正常 HTTP 建案链路；强制隔离库，保留所有临时文件，不执行清理删除。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-criminal-http-'));
process.env.DB_PATH = path.join(scratch, 'test.db');
process.env.ANJIAN_FILES_ROOT = '';
const { db } = await import('../src/db.js');
const { createCasesRouter } = await import('../src/routes/cases.js');
const { default: records } = await import('../src/routes/records.js');
const { default: changes } = await import('../src/routes/changes.js');
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.actor = 'web'; next(); });
app.use('/api', createCasesRouter(null), records, changes);
app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
async function request(method, route, body, status = 200) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, status, `${route}: ${JSON.stringify(data)}`);
  return data;
}
try {
  const fields = { case_side: '辩护', entrust_stage: '全案', crime_type: '普通', trial_mode: '普通程序', case_nature: '公诉', custody_status: '在押', co_counsel: '虚构合作律师', contract_no: 'TEST-01', custody_place: '虚构看守所', handling_agency: '虚构办案机关' };
  const c = await request('POST', '/cases', { name: '虚构辩护测试', procedure: '刑事侦查', ...fields });
  for (const [key, value] of Object.entries(fields)) assert.equal(c[key], value);
  await request('POST', '/cases', { name: '错误枚举', crime_type: '抢劫罪' }, 400);
  await request('PATCH', `/cases/${c.id}`, { custody_status: '未知' }, 400);
  const event = await request('POST', `/cases/${c.id}/events`, { type: 'detained', occurred_on: '2026-09-01' });
  let bundle = await request('GET', `/cases/${c.id}`);
  assert.equal(bundle.deadlines.length, 2);
  assert.equal(bundle.condition_warnings.length, 0);
  const ordinary = bundle.deadlines.find(d => d.name.includes('普通案件'));
  const cap = bundle.deadlines.find(d => d.name.includes('37'));
  assert.equal(ordinary.due_on, '2026-09-04');
  const before = await request('PATCH', `/cases/${c.id}`, { crime_type: '流窜作案' });
  assert.equal(before.needs_confirm, true);
  assert.equal((await request('GET', `/cases/${c.id}`)).case.crime_type, '普通');
  const changed = await request('PATCH', `/cases/${c.id}`, { crime_type: '流窜作案', confirm_rederive: true });
  assert.equal(changed.reconciled.retire.length, 1);
  assert.equal(changed.reconciled.deadlines.length, 1);
  await request('PATCH', `/deadlines/${cap.id}`, { due_on: '2026-10-20', override_reason: '虚构人工核验日期' });
  const shifted = await request('PATCH', `/events/${event.id}`, { occurred_on: '2026-09-02' });
  assert.equal(shifted.needs_confirm, true);
  await request('PATCH', `/events/${event.id}`, { occurred_on: '2026-09-02', confirm: true });
  bundle = await request('GET', `/cases/${c.id}`);
  assert.equal(bundle.deadlines.find(d => d.id === cap.id).due_on, '2026-10-20');
  const open = bundle.deadlines.find(d => d.status === 'pending' && d.id !== cap.id);
  const params = await request('PATCH', `/deadlines/${open.id}`, { manual_days: 2, manual_unit: 'months', manual_count_from: 'next_day', manual_roll: 'none', override_reason: '虚构参数' });
  assert.equal(params.due_on, '2026-11-03');
  await request('PATCH', `/events/${event.id}`, { occurred_on: '2026-09-03', type: 'invalid', confirm: true }, 400);
  assert.equal((await request('GET', `/cases/${c.id}`)).deadlines.find(d => d.id === open.id).due_on, '2026-11-03', '校验失败不可先改期限');
  await request('PATCH', `/deadlines/${open.id}`, { due_on: '2026-12-01', override_reason: '参数改为指定日期' });
  await request('PATCH', `/events/${event.id}`, { occurred_on: '2026-09-03', confirm: true });
  const direct = (await request('GET', `/cases/${c.id}`)).deadlines.find(d => d.id === open.id);
  assert.equal(direct.due_on, '2026-12-01');
  assert.equal(direct.manual_days, null);
  const task = await request('POST', '/tasks', { case_id: c.id, title: '虚构任务', due_on: '2026-09-03' });
  await request('PATCH', `/tasks/${task.id}`, { status: 'done' });
  await request('POST', '/worklog', { case_id: c.id, worked_on: '2026-09-02', content: '虚构办理日志' });
  await request('PATCH', `/cases/${c.id}`, { status: 'closed' });
  const empty = await request('POST', '/cases', { name: '虚构条件缺失测试', procedure: '刑事侦查' });
  await request('POST', `/cases/${empty.id}/events`, { type: 'detained', occurred_on: '2026-09-01' });
  bundle = await request('GET', `/cases/${empty.id}`);
  assert.ok(bundle.condition_warnings.some(w => w.field === 'crime_type'));
  assert.equal(bundle.deadlines.length, 1);
  await request('PATCH', `/cases/${empty.id}`, { crime_type: '普通', custody_status: '在押' });
  bundle = await request('GET', `/cases/${empty.id}`);
  assert.equal(bundle.deadlines.length, 2, '补录条件后应补派生期限');
  const complaint = await request('POST', '/cases', { name: '虚构控告测试', procedure: '刑事控告立案前', case_side: '控告' });
  await request('POST', `/cases/${complaint.id}/events`, { type: 'accepted', occurred_on: '2026-09-01' });
  bundle = await request('GET', `/cases/${complaint.id}`);
  assert.ok(bundle.deadlines.some(d => d.due_on === '2026-09-04'));
  const audit = await request('GET', `/changes?case_id=${c.id}&limit=200`);
  assert.ok(audit.items.some(i => i.field === 'crime_type' && i.new_value === '流窜作案'));
  assert.throws(() => db.prepare('UPDATE change_log SET synced_at=?').run('test'), /append-only/);
  console.log(`criminal HTTP: create/edit/validation/conditions/recalc/manual/task/worklog/complaint/audit passed; retained ${scratch}`);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  db.close();
}
