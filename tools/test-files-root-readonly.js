import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-files-root-readonly-'));
const missingRoot = path.join(scratch, 'mount-not-present');
const dbPath = path.join(scratch, 'readonly-root.db');
const logPath = path.join(scratch, 'server.log');
const port = 45000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const log = fs.openSync(logPath, 'w');

assert.equal(fs.existsSync(missingRoot), false, 'fixture root must begin absent');
const child = spawn(process.execPath, ['server.js'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    DB_PATH: dbPath,
    PORT: String(port),
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    ANJIAN_UNSAFE_NO_AUTH: '1',
    ANJIAN_FILES_ROOT: missingRoot,
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
  assert.equal(fs.existsSync(missingRoot), false, 'server startup must not create the configured files root');
  const response = await fetch(base + '/api/case-folders');
  const body = await response.json();
  const rootExists = fs.existsSync(missingRoot);
  console.log(`T3_ROOT_PROBE status=${response.status} error=${JSON.stringify(body.error || '')} root_exists=${rootExists}`);
  assert.equal(response.status, 503, 'read-only folder listing must report an unavailable mount');
  assert.equal(body.error, '文件根不存在');
  assert.equal(rootExists, false, 'GET must not create a shadow empty files root');
} finally {
  child.kill('SIGTERM');
  fs.closeSync(log);
  fs.rmSync(scratch, { recursive: true, force: true });
}
