import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-files-http-'));
const filesRoot = path.join(scratch, 'files');
const outside = path.join(scratch, 'outside');
const dbPath = path.join(scratch, 'files.db');
const logPath = path.join(scratch, 'server.log');
const port = 42000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
fs.mkdirSync(filesRoot);
fs.mkdirSync(outside);
const log = fs.openSync(logPath, 'w');
const child = spawn(process.execPath, ['server.js'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    DB_PATH: dbPath,
    PORT: String(port),
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    ANJIAN_UNSAFE_NO_AUTH: '1',
    ANJIAN_FILES_ROOT: filesRoot,
    LEGALRAG_URL: '',
    LEGALRAG_INTERNAL_KEY: '',
  },
  stdio: ['ignore', log, log],
});

async function waitReady() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${fs.readFileSync(logPath, 'utf8')}`);
    try { if ((await fetch(base + '/healthz')).ok) return; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${fs.readFileSync(logPath, 'utf8')}`);
}

async function request(method, route, body, expected = 200, contentType = 'application/json') {
  const response = await fetch(base + route, {
    method,
    headers: contentType ? { 'Content-Type': contentType } : {},
    body: body === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(body) : body,
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  assert.equal(response.status, expected, `${method} ${route}: ${response.status} ${raw}`);
  return { data, headers: response.headers };
}

try {
  await waitReady();

  for (const name of ['../逃逸案', '甲/乙', '甲\\乙', '.隐藏案', '.', '..', '坏\n名']) {
    await request('POST', '/api/cases', { name, procedure: '一审' }, 400);
  }
  const created = (await request('POST', '/api/cases', {
    name: '  示例文件案  ', procedure: '一审', client: '张三', cause: '示例纠纷',
  })).data;
  assert.equal(created.name, '示例文件案');
  const caseId = created.id;
  await request('PATCH', `/api/cases/${caseId}`, { name: '../改名逃逸' }, 400);

  const caseRoot = path.join(filesRoot, created.name);
  fs.mkdirSync(caseRoot);
  let result = await request(
    'PUT',
    `/api/cases/${caseId}/files?dir=${encodeURIComponent('法院文书')}&name=${encodeURIComponent('材料 中文.txt')}`,
    Buffer.from('第一份内容'),
    200,
    'application/octet-stream'
  );
  assert.equal(result.data.rel_path, '法院文书/材料 中文.txt');
  result = await request(
    'PUT',
    `/api/cases/${caseId}/files?dir=${encodeURIComponent('法院文书')}&name=${encodeURIComponent('材料 中文.txt')}`,
    Buffer.from('第二份内容'),
    200,
    'application/octet-stream'
  );
  assert.equal(result.data.rel_path, '法院文书/材料 中文(2).txt');

  result = await request('GET', `/api/cases/${caseId}/files?dir=${encodeURIComponent('法院文书')}`);
  assert.deepEqual(result.data.files.map((file) => file.name).sort(), ['材料 中文(2).txt', '材料 中文.txt']);
  const downloaded = await request(
    'GET',
    `/api/cases/${caseId}/file?path=${encodeURIComponent('法院文书/材料 中文.txt')}`,
    undefined,
    200,
    ''
  );
  assert.equal(downloaded.data, '第一份内容');
  assert.match(downloaded.headers.get('content-disposition'), /%E6%9D%90%E6%96%99/);

  const traversal = encodeURIComponent('../../etc/passwd');
  await request('GET', `/api/cases/${caseId}/file?path=${traversal}`, undefined, 404, '');
  await request('GET', `/api/cases/${caseId}/files?dir=${traversal}`, undefined, 404, '');
  await request('GET', `/api/cases/${caseId}/files/sig?dir=${traversal}`, undefined, 404, '');

  result = await request('POST', `/api/cases/${caseId}/attachments`, {
    rel_path: '法院文书/材料 中文.txt', entity: '', entity_id: null,
  });
  assert.equal(result.data.rel_path, '法院文书/材料 中文.txt');
  assert.equal(result.data.size, Buffer.byteLength('第一份内容'));

  fs.writeFileSync(path.join(outside, '秘密.txt'), '外部秘密');
  fs.symlinkSync(path.join(outside, '秘密.txt'), path.join(caseRoot, '法院文书', '外链文件.txt'));
  fs.symlinkSync(outside, path.join(caseRoot, '外链目录'));
  await request('GET', `/api/cases/${caseId}/file?path=${encodeURIComponent('法院文书/外链文件.txt')}`, undefined, 404, '');
  await request('GET', `/api/cases/${caseId}/file?path=${encodeURIComponent('外链目录/秘密.txt')}`, undefined, 404, '');
  await request('POST', `/api/cases/${caseId}/attachments`, {
    rel_path: '法院文书/外链文件.txt', entity: '',
  }, 400);
  result = await request('GET', `/api/cases/${caseId}/files?dir=${encodeURIComponent('法院文书')}`);
  assert.equal(result.data.files.some((file) => file.name === '外链文件.txt'), false);
  result = await request('GET', `/api/cases/${caseId}/files`);
  assert.equal(result.data.dirs.includes('外链目录'), false);

  fs.symlinkSync(outside, path.join(caseRoot, '客户沟通'));
  await request(
    'PUT',
    `/api/cases/${caseId}/files?dir=${encodeURIComponent('客户沟通')}&name=${encodeURIComponent('不得外写.txt')}`,
    Buffer.from('不得写出'),
    400,
    'application/octet-stream'
  );
  assert.equal(fs.existsSync(path.join(outside, '不得外写.txt')), false);

  const fee = (await request('POST', `/api/cases/${caseId}/fees`, {
    label: '示例代理费', amount: '1000.00', due_on: '2099-01-01',
  })).data;
  result = await request(
    'PUT',
    `/api/fees/${fee.id}/files?version=${fee.version}&kind=receipt&name=${encodeURIComponent('收款凭证.pdf')}`,
    Buffer.from('凭证一'),
    200,
    'application/pdf'
  );
  assert.equal(result.data.file.rel_path, '财务凭证/收款凭证.pdf');
  result = await request(
    'PUT',
    `/api/fees/${fee.id}/files?version=${fee.version}&kind=receipt&name=${encodeURIComponent('收款凭证.pdf')}`,
    Buffer.from('凭证二'),
    200,
    'application/pdf'
  );
  assert.equal(result.data.file.rel_path, '财务凭证/收款凭证(2).pdf');

  const linkedCase = (await request('POST', '/api/cases', { name: '链接案件', procedure: '一审' })).data;
  fs.symlinkSync(outside, path.join(filesRoot, linkedCase.name));
  await request('GET', `/api/cases/${linkedCase.id}/files`, undefined, 404, '');

  const missingCase = (await request('POST', '/api/cases', { name: '尚未建夹案件', procedure: '一审' })).data;
  result = await request('GET', `/api/cases/${missingCase.id}/files`);
  assert.deepEqual(result.data, { exists: false, dir: '', dirs: [], files: [] });

  console.log('files HTTP tests: case names + symlink boundaries + exclusive uploads + voucher paths passed');
} finally {
  child.kill('SIGTERM');
  fs.closeSync(log);
  fs.rmSync(scratch, { recursive: true, force: true });
}
