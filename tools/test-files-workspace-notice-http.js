// T2-Visible-Fallback-Notice · 透传回归（HTTP 真实 server）：
//   a) folder_path 失效 + 同名目录存在 → GET /cases/:id/files 响应含 workspace_notice，
//      值等于 secure-files 的 fallbackNotice 原文，且文件仍从同名目录读出；
//   b) folder_path 有效的正常案件 → 响应省略 workspace_notice（防对正常案件误报）；
//   c) folder_path 失效且同名目录也不存在 → exists:false 且无 workspace_notice。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-workspace-notice-http-'));
const filesRoot = path.join(scratch, 'files');
const dbPath = path.join(scratch, 'notice-http.db');
const logPath = path.join(scratch, 'server.log');
const port = 45000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
fs.mkdirSync(filesRoot);
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

async function createCase(name) {
  const response = await fetch(base + '/api/cases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, procedure: '一审' }),
  });
  assert.equal(response.status, 200, `创建案件 ${name} 失败`);
  return await response.json();
}

function setFolderPath(caseId, folderPath) {
  const sqlite = new Database(dbPath);
  try {
    sqlite.prepare('UPDATE cases SET folder_path=? WHERE id=?').run(folderPath, caseId);
  } finally {
    sqlite.close();
  }
}

try {
  await waitReady();

  // a) 回落案：folder_path 失效、同名 name 目录存在
  const fallbackCase = await createCase('提示回落案');
  const wrongFolder = '提示失效旧指针';
  fs.writeFileSync(path.join(filesRoot, fallbackCase.name, '提示回落证据.txt'), 'notice fallback fixture');
  setFolderPath(fallbackCase.id, wrongFolder);
  const fallbackResponse = await fetch(`${base}/api/cases/${fallbackCase.id}/files`);
  const fallbackBody = await fallbackResponse.json();
  assert.equal(fallbackResponse.status, 200);
  assert.equal(fallbackBody.exists, true);
  assert.equal(
    fallbackBody.workspace_notice,
    `原案件夹“${wrongFolder}”不存在，已临时回落到同名目录“${fallbackCase.name}”`,
    '回落发生时 workspace_notice 必须逐字透传 secure-files 的 fallbackNotice',
  );
  assert.equal(fallbackBody.files.some((file) => file.name === '提示回落证据.txt'), true, '回落案仍必须读出同名目录里的文件');
  console.log(`T2V_HTTP_FALLBACK status=${fallbackResponse.status} notice="${fallbackBody.workspace_notice}"`);

  // b) 正常案：folder_path 有效（创建时默认指向同名目录且目录存在）
  const normalCase = await createCase('提示正常案');
  fs.writeFileSync(path.join(filesRoot, normalCase.name, '提示正常证据.txt'), 'normal fixture');
  const normalResponse = await fetch(`${base}/api/cases/${normalCase.id}/files`);
  const normalBody = await normalResponse.json();
  assert.equal(normalResponse.status, 200);
  assert.equal(normalBody.exists, true);
  assert.equal('workspace_notice' in normalBody, false, 'folder_path 有效时必须整个省略 workspace_notice，不留空占位');
  assert.equal(normalBody.files.some((file) => file.name === '提示正常证据.txt'), true);
  console.log(`T2V_HTTP_NORMAL status=${normalResponse.status} workspace_notice=omitted files=${normalBody.files.length}`);

  // c) 双失案：folder_path 失效且同名目录也不存在 → exists:false、无提示
  const missingCase = await createCase('提示双失案');
  fs.rmSync(path.join(filesRoot, missingCase.name), { recursive: true });
  setFolderPath(missingCase.id, '提示双失旧指针');
  const missingResponse = await fetch(`${base}/api/cases/${missingCase.id}/files`);
  const missingBody = await missingResponse.json();
  assert.equal(missingResponse.status, 200);
  assert.equal(missingBody.exists, false);
  assert.equal('workspace_notice' in missingBody, false, '案件夹不存在时不得冒出回落提示');
  console.log(`T2V_HTTP_BOTH_MISSING status=${missingResponse.status} exists=${missingBody.exists} workspace_notice=omitted`);

  console.log('files workspace notice HTTP: fallback passthrough + normal omission + both-missing silence passed');
} finally {
  child.kill('SIGTERM');
  fs.closeSync(log);
  fs.rmSync(scratch, { recursive: true, force: true });
}
