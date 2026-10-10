// 快录开庭 HTTP 回归：模型只提供建议，parse 不写库，/quick 才由确定性事件引擎入表。
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-quick-hearing-'));
let calls = 0;
const upstream = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(404).end(); return; }
  calls++;
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const prompt = JSON.parse(body).messages?.at(-1)?.content || '';
    const value = /无日期/.test(prompt)
      ? { kind: 'hearing', title: '开庭', date: '', time: '09:99', location: '第五法庭', case_hint: '张三' }
      : { kind: 'hearing', title: '开庭', date: '2099-11-03', time: '09:30', location: '第五法庭', case_hint: '张三', case_id: 99999 };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
  });
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstream.address().port;
const port = 39892;
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, DB_PATH: path.join(scratch, 'db.sqlite'), PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', ANJIAN_UNSAFE_NO_AUTH: '1', DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstreamPort}` },
  stdio: ['ignore', 'ignore', 'pipe'],
});
const get = async (url, options = {}) => { const response = await fetch(`http://127.0.0.1:${port}${url}`, options); const json = await response.json(); return { response, json }; };
for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
try {
  const created = await get('/api/cases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '张三案（快录）', procedure: '一审', client: '张三' }) });
  assert.ok([200, 201].includes(created.response.status)); const cid = created.json.id;
  const before = await get('/api/cases/' + cid);
  const parsed = await get('/api/quick/parse', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '11月3日上午9点半在第五法庭开庭，张三案' }) });
  assert.equal(parsed.response.status, 200); assert.equal(parsed.json.kind, 'hearing'); assert.equal(parsed.json.case_id, cid); assert.equal(parsed.json.time, '09:30');
  const after = await get('/api/cases/' + cid);
  assert.equal(after.json.events.length, before.json.events.length); assert.equal(after.json.deadlines.length, before.json.deadlines.length);
  const quick = await get('/api/quick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'hearing', text: '开庭原文', date: '2099-11-03', time: '09:30', location: '第五法庭', case_id: cid }) });
  assert.equal(quick.response.status, 200); assert.equal(quick.json.kind, 'hearing'); assert.equal(quick.json.row.occurred_time, '09:30');
  const parsedNoDate = await get('/api/quick/parse', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '无日期开庭' }) });
  assert.equal(parsedNoDate.json.kind, 'task'); assert.match(parsedNoDate.json.downgraded, /没有明确日期/); assert.equal(parsedNoDate.json.time, '');
  const noCase = await get('/api/quick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'hearing', text: '开庭', date: '2099-11-04' }) });
  assert.equal(noCase.response.status, 400);
  const final = await get('/api/cases/' + cid);
  assert.equal(final.json.events.length, before.json.events.length + 1);
  assert.equal(final.json.deadlines.length, before.json.deadlines.length);
  assert.ok(calls >= 2);
  console.log('quick hearing http ok');
} finally {
  child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); await new Promise((resolve) => upstream.close(resolve));
}
