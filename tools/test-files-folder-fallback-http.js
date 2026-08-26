import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-folder-fallback-http-'));
const filesRoot = path.join(scratch, 'files');
const dbPath = path.join(scratch, 'fallback-http.db');
const logPath = path.join(scratch, 'server.log');
const port = 44000 + Math.floor(Math.random() * 1000);
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

try {
  await waitReady();
  const createResponse = await fetch(base + '/api/cases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'HTTP同名回落案', procedure: '一审' }),
  });
  assert.equal(createResponse.status, 200);
  const created = await createResponse.json();
  const nameRoot = path.join(filesRoot, created.name);
  fs.writeFileSync(path.join(nameRoot, 'HTTP回落证据.txt'), 'http fallback fixture');

  const wrongFolder = 'HTTP不存在旧指针';
  const sqlite = new Database(dbPath);
  try {
    sqlite.prepare('UPDATE cases SET folder_path=? WHERE id=?').run(wrongFolder, created.id);
  } finally {
    sqlite.close();
  }
  assert.equal(fs.existsSync(path.join(filesRoot, wrongFolder)), false);

  const response = await fetch(`${base}/api/cases/${created.id}/files`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.exists, true);
  assert.equal(body.files.some((file) => file.name === 'HTTP回落证据.txt'), true);
  assert.equal(fs.existsSync(path.join(filesRoot, wrongFolder)), false, 'GET/fallback 不得顺手创建失效 folder_path');
  console.log(`T2_HTTP_FALLBACK status=${response.status} file=HTTP回落证据.txt wrong_folder_created=false`);
} finally {
  child.kill('SIGTERM');
  fs.closeSync(log);
  fs.rmSync(scratch, { recursive: true, force: true });
}
