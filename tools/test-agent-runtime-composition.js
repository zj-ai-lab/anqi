import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'src/agent/assets');
const CONFIG = path.join(ASSETS, 'anqi.cordis.yml');
const BIN = path.join(ASSETS, 'bin.mjs');

async function bootAndPreflight(mode, { pluginPatch = '', onReady } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `anqi-dsh-${mode}-`));
  const cwd = path.join(scratch, 'case');
  const sessionRoot = path.join(scratch, 'sessions');
  const sandboxTemp = path.join(scratch, 'sandbox-temp');
  const databasePath = path.join(scratch, 'protected.db');
  fs.mkdirSync(cwd);
  fs.mkdirSync(sessionRoot);
  fs.mkdirSync(sandboxTemp);
  fs.writeFileSync(databasePath, 'composition-boundary-placeholder');

  const sessionId = `composition-${mode}`;
  const child = spawn(process.execPath, ['--expose-internals', BIN, CONFIG], {
    cwd: ASSETS,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG || 'en_US.UTF-8',
      DSH_CORDIS_CONFIG: CONFIG,
      DSH_PROVIDER_KIND: 'deepseek-official',
      DSH_API_KEY_ENV: 'DEEPSEEK_API_KEY',
      DEEPSEEK_API_KEY: 'composition-test-key',
      DSH_BASE_URL: 'https://api.deepseek.com',
      DSH_MODEL: 'deepseek-chat',
      DSH_CAPABILITY_MODE: mode,
      DSH_PERMISSION_MODE: mode === 'full' ? 'workspace-write' : 'read-only',
      DSH_CWD: cwd,
      DSH_ANQI_FILES_ROOT: scratch,
      DSH_ANQI_DB_PATH: databasePath,
      DSH_ANQI_SANDBOX_TMP: sandboxTemp,
      DSH_ANQI_SKILLS_ROOT: path.join(ASSETS, 'skills'),
      DSH_SESSION_ROOT: sessionRoot,
      DSH_PREFLIGHT_TIMEOUT_MS: '8000',
      ANQI_BASE_URL: 'http://127.0.0.1:9',
      ANQI_INTERNAL_KEY_ENV: 'ANJIAN_INTERNAL_KEY',
      ANJIAN_INTERNAL_KEY: 'composition-test-internal-key',
      ANQI_AGENT_SESSION_ID: sessionId,
      ...(pluginPatch ? { DSH_PLUGIN_PATCH: pluginPatch } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let sequence = 0;
  let stderr = '';
  const pending = new Map();
  const output = readline.createInterface({ input: child.stdout });
  output.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`${message.error.message}\nDSH stderr:\n${stderr}`));
    else request.resolve(message.result);
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = String(++sequence);
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 20_000);

  try {
    await rpc('initialize', { cwd, provider: 'deepseek-official', model: 'deepseek-chat' });
    await rpc('session/create', { sessionId });
    const preflight = await rpc('session/preflight', { sessionId });
    assert.equal(preflight.ready, true);
    assert.deepEqual(preflight.skills.names, ['anqi-case-brief']);
    const readyResult = onReady
      ? await onReady({ rpc, preflight, sessionId })
      : new Set(preflight.tools.visibleNames);
    await rpc('shutdown');
    child.stdin.end();
    await new Promise((resolve, reject) => {
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`DSH exited ${code}: ${stderr}`)));
    });
    assert.doesNotMatch(stderr, /plugin tree failed to load|failed to apply loader entry/);
    return readyResult;
  } finally {
    clearTimeout(killTimer);
    output.close();
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const projectTools = await bootAndPreflight('project');
for (const name of ['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'skill', 'todo_write']) {
  assert.ok(projectTools.has(name), `project 档缺少案件项目工具 ${name}`);
}
for (const name of ['bash', 'web_search', 'subagent', 'workflow', 'ralph']) {
  assert.equal(projectTools.has(name), false, `project 档不应发布完整能力工具 ${name}`);
}

const fullTools = await bootAndPreflight('full');
for (const name of [
  'bash', 'web_search', 'subagent', 'subagent_fork', 'list_agents', 'send_message',
  'workflow', 'ralph', 'create_goal', 'get_goal', 'update_goal', 'str_replace_editor',
  'job_list', 'job_output', 'job_kill',
]) {
  assert.ok(fullTools.has(name), `full 档缺少上游完整能力工具 ${name}`);
}

console.log('agent runtime composition tests: project/full real boot + scoped tools + trusted skill passed');

const hotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-dsh-plugin-hot-'));
try {
  const pluginFile = path.join(hotRoot, 'hot-plugin.mjs');
  const patchFile = path.join(hotRoot, 'cordis.patch.yml');
  const toolsImport = path.join(
    ROOT,
    'src/agent/runtime/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
  );
  fs.writeFileSync(pluginFile, `
import { defineTool } from ${JSON.stringify(`file://${toolsImport}`)};
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'anqi_hot_plugin_probe',
    description: 'test-only hot plugin probe',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'ok'; },
  }));
}
`);
  const mountedPatch = `- insert:\n    - id: anqi-hot-plugin-probe\n      name: ${JSON.stringify(pluginFile)}\n`;
  fs.writeFileSync(patchFile, mountedPatch);

  await bootAndPreflight('full', {
    pluginPatch: patchFile,
    async onReady({ rpc, preflight, sessionId }) {
      assert.ok(preflight.tools.visibleNames.includes('anqi_hot_plugin_probe'));
      fs.writeFileSync(patchFile, '[]\n');
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const snapshot = await rpc('session/preflight', { sessionId });
        if (!snapshot.tools.visibleNames.includes('anqi_hot_plugin_probe')) return;
      }
      assert.fail('Cordis plugin patch changed but the live DSH worker did not hot-reload it');
    },
  });
  console.log('agent plugin compatibility test: trusted Cordis patch mounted and hot-removed without worker restart');
} finally {
  fs.rmSync(hotRoot, { recursive: true, force: true });
}
