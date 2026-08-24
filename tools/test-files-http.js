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
  assert.equal(created.folder_path, '示例文件案');
  const caseId = created.id;
  const renamed = (await request('PATCH', `/api/cases/${caseId}`, { name: '../仅是显示标题' })).data;
  assert.equal(renamed.name, '../仅是显示标题');
  assert.equal(renamed.folder_path, '示例文件案', '改案件标题不得隐式切换工作区');

  const caseRoot = path.join(filesRoot, created.name);
  assert.equal(fs.statSync(caseRoot).isDirectory(), true, '建案必须自动创建同名案件工作区');
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
  fs.rmdirSync(path.join(filesRoot, linkedCase.folder_path));
  fs.symlinkSync(outside, path.join(filesRoot, linkedCase.name));
  await request('GET', `/api/cases/${linkedCase.id}/files`, undefined, 404, '');

  const missingCase = (await request('POST', '/api/cases', { name: '尚未建夹案件', procedure: '一审' })).data;
  fs.rmdirSync(path.join(filesRoot, missingCase.folder_path));
  result = await request('GET', `/api/cases/${missingCase.id}/files`);
  assert.deepEqual(result.data, { exists: false, dir: '', dirs: [], files: [] });

  fs.mkdirSync(path.join(filesRoot, '同步盘已有案卷'));
  const workspaceCase = (await request('POST', '/api/cases', {
    name: '标题/与目录不同的案件', folder_path: '同步盘已有案卷', procedure: '一审',
  })).data;
  assert.equal(workspaceCase.name, '标题/与目录不同的案件', '案件标题不是文件路径，可与目录规则解耦');
  assert.equal(workspaceCase.folder_path, '同步盘已有案卷');
  fs.writeFileSync(path.join(filesRoot, '同步盘已有案卷', '现有材料.txt'), '同步原件');
  result = await request('GET', `/api/cases/${workspaceCase.id}/files`);
  assert.equal(result.data.files.some((file) => file.name === '现有材料.txt'), true, '文件桥必须读取 folder_path 指向的工作区');

  result = await request('GET', '/api/case-folders');
  const listed = result.data.folders.find((folder) => folder.name === '同步盘已有案卷');
  assert.equal(listed.bound_case_id, workspaceCase.id, '目录选择器必须标出已绑定案件');
  await request('POST', '/api/cases', {
    name: '不得重复绑定', folder_path: '同步盘已有案卷', procedure: '一审',
  }, 409);

  result = await request('PUT', `/api/cases/${workspaceCase.id}/workspace`, {
    folder_path: '重新绑定的新工作区', create: true,
  });
  assert.equal(result.data.workspace.created, true);
  assert.equal(result.data.case.folder_path, '重新绑定的新工作区');
  assert.equal(fs.existsSync(path.join(filesRoot, '同步盘已有案卷', '现有材料.txt')), true, '换绑不得移动或删除旧工作区');
  assert.equal(fs.statSync(path.join(filesRoot, '重新绑定的新工作区')).isDirectory(), true);

  console.log('files HTTP tests: auto/create/select workspaces + symlink boundaries + exclusive uploads + voucher paths passed');
} finally {
  child.kill('SIGTERM');
  fs.closeSync(log);
  fs.rmSync(scratch, { recursive: true, force: true });
}
