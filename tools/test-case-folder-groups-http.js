// 案件夹分组的 HTTP 回归（真服务进程 + 临时库 + 临时文件根）：
//   分组设置三条把关（已绑案件的文件夹不能当分组 / 旧多段指针同前缀不能登记 / 分组下有案件不能移除），
//   建案按案件类型落进默认分组、显式选分组里的文件夹、分组本身与嵌套 / 越界 / 链接一律拒绝，
//   换绑进出分组、分组下案件的文件上传与列表，以及 /case-folders 的返回结构。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-folder-groups-http-'));
const filesRoot = path.join(scratch, 'files');
const outside = path.join(scratch, 'outside');
const dbPath = path.join(scratch, 'groups.db');
const logPath = path.join(scratch, 'server.log');
const port = 43000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
fs.mkdirSync(path.join(filesRoot, '诉讼', '既有案'), { recursive: true });
fs.mkdirSync(path.join(filesRoot, '诉讼', '.隐藏'), { recursive: true });
fs.mkdirSync(path.join(filesRoot, '散案'));
fs.mkdirSync(outside);
fs.symlinkSync(outside, path.join(filesRoot, '诉讼', '外链案'));
fs.symlinkSync(outside, path.join(filesRoot, '链接组'));
fs.writeFileSync(path.join(filesRoot, '一个文件'), 'x');
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
  return data;
}

const putGroups = (groups, defaults = {}, expected = 200) => request('PUT', '/api/case-folder-groups', { groups, defaults }, expected);

try {
  await waitReady();

  // 初始：没有分组，一级文件夹平铺，链接与普通文件不出现。
  let folders = await request('GET', '/api/case-folders');
  assert.deepEqual(folders.groups, []);
  assert.deepEqual(folders.defaults, {});
  assert.deepEqual(folders.folders.map((folder) => [folder.name, folder.group]), [['散案', ''], ['诉讼', '']]);
  await request('POST', '/api/cases', { name: '提前用分组路径', folder_path: '诉讼/既有案' }, 400);

  // 把关一：已绑成案件夹的一级文件夹不能登记为分组（否则案件夹会套住别的案件夹）。
  const flat = await request('POST', '/api/cases', { name: '平铺案', folder_path: '散案' });
  assert.equal(flat.folder_path, '散案');
  let error = await putGroups(['散案'], {}, 409);
  assert.match(error.error, /已是案件「平铺案」的案件夹/);

  // 把关二：与旧的多段指针同前缀的分组不能登记（防止 017 前遗留指针被改判）。
  const legacy = await request('POST', '/api/cases', { name: '旧指针案' });
  const sqlite = new Database(dbPath);
  try {
    sqlite.prepare('UPDATE cases SET folder_path=? WHERE id=?').run('顾问/旧指针案', legacy.id);
  } finally {
    sqlite.close();
  }
  error = await putGroups(['诉讼', '顾问'], {}, 409);
  assert.match(error.error, /旧路径以「顾问\/」开头/);
  await request('PUT', `/api/cases/${legacy.id}/workspace`, { folder_path: '旧指针案' });

  // 参数校验：非法分组名、未知案件类型、默认分组不在清单、文件根下同名的不是普通文件夹。
  await putGroups(['诉讼/子'], {}, 400);
  await putGroups(['.隐藏'], {}, 400);
  await putGroups('诉讼', {}, 400);
  await putGroups(['诉讼'], { 不存在的类型: '诉讼' }, 400);
  await putGroups(['诉讼'], { 民事: '顾问' }, 400);
  await putGroups(['链接组'], {}, 400);
  await putGroups(['一个文件'], {}, 400);

  // 登记：诉讼（已存在）+ 顾问（还不存在），民事/刑事进诉讼、非诉进顾问。
  folders = await putGroups(['诉讼', '顾问', '诉讼'], { 民事: '诉讼', 刑事: '诉讼', 非诉: '顾问', 其他: '' });
  assert.deepEqual(folders.groups, [
    { name: '诉讼', exists: true, case_count: 0 },
    { name: '顾问', exists: false, case_count: 0 },
  ]);
  assert.deepEqual(folders.defaults, { 民事: '诉讼', 刑事: '诉讼', 非诉: '顾问' });
  assert.deepEqual(
    folders.folders.map((folder) => [folder.name, folder.group]),
    [['旧指针案', ''], ['散案', ''], ['诉讼/既有案', '诉讼']],
    '分组本身不进根下候选；分组里只列一层真实目录（隐藏项与链接不出现）',
  );

  // 建案按类型落进默认分组；没有默认分组的类型照旧放文件根下。
  const civil = await request('POST', '/api/cases', { name: '甲诉乙案', case_type: '民事', procedure: '一审' });
  assert.equal(civil.folder_path, '诉讼/甲诉乙案');
  assert.equal(fs.statSync(path.join(filesRoot, '诉讼', '甲诉乙案')).isDirectory(), true);
  const advisory = await request('POST', '/api/cases', { name: '某公司常年顾问', case_type: '非诉', procedure: '非诉' });
  assert.equal(advisory.folder_path, '顾问/某公司常年顾问');
  assert.equal(fs.statSync(path.join(filesRoot, '顾问', '某公司常年顾问')).isDirectory(), true, '分组文件夹不存在时一并建出');
  const other = await request('POST', '/api/cases', { name: '其他事务', case_type: '其他' });
  assert.equal(other.folder_path, '其他事务');
  await request('POST', '/api/cases', { name: '甲/乙', case_type: '民事' }, 400);

  // 显式选择：分组里的已有文件夹可以绑；分组本身、未登记的两段、三段、穿越、链接都拒绝。
  const picked = await request('POST', '/api/cases', { name: '用既有文件夹', folder_path: '诉讼/既有案' });
  assert.equal(picked.folder_path, '诉讼/既有案');
  await request('POST', '/api/cases', { name: '重复绑定', folder_path: '诉讼/既有案' }, 409);
  error = await request('POST', '/api/cases', { name: '绑分组本身', folder_path: '诉讼' }, 400);
  assert.match(error.error, /是分组文件夹/);
  for (const [index, bad] of ['未登记/某案', '诉讼/甲诉乙案/证据', '诉讼/../散案', '../诉讼', '诉讼/.隐藏'].entries()) {
    await request('POST', '/api/cases', { name: `坏路径${index}`, folder_path: bad }, 400);
  }
  await request('POST', '/api/cases', { name: '链接案', folder_path: '诉讼/外链案' }, 400);
  assert.equal(fs.readdirSync(outside).length, 0, '任何请求都不得在文件根外建目录');

  // 分组下的案件：文件上传落在 分组/案件夹 里，列表读得到。
  const uploaded = await request(
    'PUT',
    `/api/cases/${civil.id}/files?dir=${encodeURIComponent('法院文书')}&name=${encodeURIComponent('起诉状.txt')}`,
    Buffer.from('示例内容'),
    200,
    'application/octet-stream',
  );
  assert.equal(uploaded.rel_path, '法院文书/起诉状.txt');
  assert.equal(fs.readFileSync(path.join(filesRoot, '诉讼', '甲诉乙案', '法院文书', '起诉状.txt'), 'utf8'), '示例内容');
  const listed = await request('GET', `/api/cases/${civil.id}/files?dir=${encodeURIComponent('法院文书')}`);
  assert.ok(JSON.stringify(listed).includes('起诉状.txt'), '分组下的案件文件列表应读到上传的文件');

  // 换绑：进分组（新建）、出分组（回文件根）、绑分组本身拒绝。
  let rebound = await request('PUT', `/api/cases/${other.id}/workspace`, { folder_path: '顾问/改放顾问', create: true });
  assert.equal(rebound.case.folder_path, '顾问/改放顾问');
  assert.equal(rebound.workspace.created, true);
  assert.equal(fs.existsSync(path.join(filesRoot, '其他事务')), true, '换绑不移动、不删除旧文件夹');
  rebound = await request('PUT', `/api/cases/${other.id}/workspace`, { folder_path: '其他事务' });
  assert.equal(rebound.case.folder_path, '其他事务');
  await request('PUT', `/api/cases/${other.id}/workspace`, { folder_path: '顾问' }, 400);
  await request('PUT', `/api/cases/${other.id}/workspace`, { folder_path: '诉讼/既有案' }, 409);

  // 把关三：分组下还有案件时不能移除；清空后才能移除。
  folders = await request('GET', '/api/case-folders');
  assert.deepEqual(folders.groups.map((group) => [group.name, group.case_count]), [['诉讼', 2], ['顾问', 1]]);
  error = await putGroups(['诉讼'], { 民事: '诉讼' }, 409);
  assert.match(error.error, /分组「顾问」下还有 1 个案件/);
  await request('PUT', `/api/cases/${advisory.id}/workspace`, { folder_path: '顾问留档', create: true });
  folders = await putGroups(['诉讼'], { 民事: '诉讼' });
  assert.deepEqual(folders.groups.map((group) => group.name), ['诉讼']);
  assert.ok(folders.folders.some((folder) => folder.name === '顾问' && folder.group === ''), '移除后「顾问」回到普通一级文件夹');

  // 分组下的案件解析不受其他分组变动影响；案件详情的文件区仍可读。
  await request('GET', `/api/cases/${civil.id}/files?dir=${encodeURIComponent('法院文书')}`);

  console.log('case folder groups HTTP: 分组设置三条把关 + 默认分组建案 + 显式选择 + 嵌套/越界/链接拒绝 + 换绑进出分组 + 分组下文件读写 passed');
} finally {
  child.kill('SIGTERM');
  fs.closeSync(log);
  fs.rmSync(scratch, { recursive: true, force: true });
}
