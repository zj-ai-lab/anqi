import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { CASE_TYPES, caseType, typeOrder, procedureLabel, inferCaseType } from '../public/js/case-types.js';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-types-')), 'test.db');
process.env.ANJIAN_FILES_ROOT = '';
const { db } = await import('../src/db.js');
const { default: router } = await import('../src/routes/cases.js');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = 'test'; next(); });
app.use(router());
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

async function call(url, method, body) {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    signal: AbortSignal.timeout(10000),
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  return [r.status, data];
}

try {
  assert.equal(procedureLabel('一审'), '民事一审');
  assert.equal(procedureLabel('二审'), '民事二审');
  assert.equal(procedureLabel('刑事一审'), '刑事一审');
  assert.equal(procedureLabel('行政一审'), '行政一审');
  assert.equal(caseType({}), '未分类');
  assert.equal(inferCaseType('刑事侦查'), '刑事');
  assert.equal(inferCaseType('行政一审'), '行政');
  assert.equal(inferCaseType('一审'), '未分类');
  assert.equal(inferCaseType('非诉'), '未分类');

  const [status, c] = await call('/cases', 'POST', { name: '虚构类型验收', procedure: '一审', stage: '立案准备', case_type: '民事' });
  assert.equal(status, 200, JSON.stringify(c));
  assert.equal(c.case_type, '民事');
  assert.equal((await call('/cases/' + c.id, 'PATCH', { case_type: '行政' }))[0], 200);
  assert.equal(db.prepare('SELECT procedure FROM cases WHERE id=?').get(c.id).procedure, '一审');
  assert.equal((await call('/cases/' + c.id, 'PATCH', { case_type: 'invalid' }))[0], 400);
  assert.ok(db.prepare("SELECT id FROM change_log WHERE field='case_type' AND case_id=?").get(c.id));

  const [sAdmin, adminCase] = await call('/cases', 'POST', { name: '虚构行政默认类型', procedure: '行政一审', stage: '立案准备' });
  assert.equal(sAdmin, 200, JSON.stringify(adminCase));
  assert.equal(adminCase.case_type, '行政');
  const [sCivil, civilCase] = await call('/cases', 'POST', { name: '虚构民事默认未分类', procedure: '一审', stage: '立案准备' });
  assert.equal(sCivil, 200, JSON.stringify(civilCase));
  assert.equal(civilCase.case_type, '未分类');

  const a = await call('/cases', 'POST', { name: '批量甲', procedure: '一审', case_type: '未分类' });
  const b = await call('/cases', 'POST', { name: '批量乙', procedure: '刑事一审', case_type: '未分类' });
  const d = await call('/cases', 'POST', { name: '批量丙', procedure: '行政一审', case_type: '行政' });
  assert.equal(a[0], 200); assert.equal(b[0], 200); assert.equal(d[0], 200);
  const ids = [a[1].id, b[1].id, d[1].id];

  const [badType] = await call('/cases/batch-type', 'POST', { ids, case_type: '外星' });
  assert.equal(badType, 400);
  const [badIds] = await call('/cases/batch-type', 'POST', { ids: [], case_type: '民事' });
  assert.equal(badIds, 400);
  const [badNum] = await call('/cases/batch-type', 'POST', { ids: ['x'], case_type: '民事' });
  assert.equal(badNum, 400);
  const [missing, missingBody] = await call('/cases/batch-type', 'POST', { ids: [ids[0], 999999], case_type: '民事' });
  assert.equal(missing, 404);
  assert.deepEqual(missingBody.missing, [999999]);
  assert.equal(db.prepare('SELECT case_type FROM cases WHERE id=?').get(ids[0]).case_type, '未分类', '404 不得部分写入');

  const [ok, body] = await call('/cases/batch-type', 'POST', { ids, case_type: '刑事' });
  assert.equal(ok, 200, JSON.stringify(body));
  // 未分类×2 与 行政×1 全部改为 刑事
  assert.deepEqual(new Set(body.updated), new Set(ids));
  assert.deepEqual(body.unchanged, []);

  for (const id of ids) {
    assert.equal(db.prepare('SELECT case_type FROM cases WHERE id=?').get(id).case_type, '刑事');
    assert.ok(db.prepare("SELECT id FROM change_log WHERE field='case_type' AND entity_id=? AND new_value='刑事'").get(id));
    assert.ok(db.prepare("SELECT id FROM audit_log WHERE action='batch-case-type' AND entity_id=?").get(id));
  }

  const [again, body2] = await call('/cases/batch-type', 'POST', { ids: [ids[0]], case_type: '刑事' });
  assert.equal(again, 200);
  assert.deepEqual(body2.updated, []);
  assert.deepEqual(body2.unchanged, [ids[0]]);

  assert.deepEqual([...CASE_TYPES].reverse().map((case_type) => ({ case_type })).sort(typeOrder).map(caseType), CASE_TYPES);
  console.log('PASS: case type API validation, inferCaseType, batch-type, local audit, stable procedure mapping and grouping order');
} finally {
  server.close();
  db.close();
}
