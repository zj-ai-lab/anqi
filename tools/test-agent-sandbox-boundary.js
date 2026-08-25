// Phase 0 红线回归：DSH bash 的边界必须同时保护正式库和其他案件，而不只是
// “禁止写”。上游 workspace-write 默认仍允许读取宿主其他路径；案齐不能接受
// 这个更宽的通用 coding-agent 语义，因为 contacts 与他案材料都在同一宿主。
//
// 本脚本刻意用真实本地沙箱后端（macOS Seatbelt；Linux bwrap/Landlock）执行
// bash，不 mock 拒绝结果；同一脚本会在 Docker 镜像里再跑一次，证明镜像内
// 后端确实可用。另起一个 DB_PATH 位于案件 workspace 内的坏部署，验证
// supervisor 会在 spawn 前 fail closed，而不是把正式库带进可写根。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../src/agent/runtime/node_modules/@deepseek-ai/cordis/lib/index.js';
import LocalSubprocessRuntime from '../src/agent/runtime/node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js';
import LocalSandboxProvider from '../src/agent/runtime/node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js';
import { installConfidentialSandbox } from '../src/agent/assets/plugins/dsh-anqi-workspace-guard/index.js';
import SandboxPolicyService from '../src/agent/runtime/node_modules/@deepseek-ai/dsh-sandbox-policy/lib/index.js';
import SandboxBashExecutor from '../src/agent/runtime/node_modules/@deepseek-ai/dsh-bash-sandbox/lib/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratchBase = process.env.ANQI_SANDBOX_TEST_ROOT || os.tmpdir();
fs.mkdirSync(scratchBase, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchBase, 'anqi-sandbox-boundary-'));
const filesRoot = path.join(scratch, 'files');
const caseName = '当前案件';
const caseRoot = path.join(filesRoot, caseName);
const otherCaseRoot = path.join(filesRoot, '其他案件');
const databasePath = path.join(caseRoot, 'anjian.db');
fs.mkdirSync(caseRoot, { recursive: true });
fs.mkdirSync(otherCaseRoot, { recursive: true });

// 必须在首次动态 import src/db.js 前设置；这就是故意构造的坏部署。
process.env.DB_PATH = databasePath;
process.env.TEST_PHASE0_MODEL_KEY = 'phase0-not-a-real-model-key';
process.env.ANJIAN_INTERNAL_KEY = 'phase0-not-a-real-internal-key';

let db;
let sandboxCtx;
try {
  const dbModule = await import('../src/db.js');
  db = dbModule.db;
  const {
    AGENT_BASH_SANDBOX_UNAVAILABLE,
    AgentSupervisor,
    probeHostBashSandbox,
  } = await import('../src/agent/supervisor.js');
  const { AGENT_SETTINGS_KEYS } = await import('../src/agent/config.js');

  const setSetting = (key, value) => db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
  setSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
  setSetting(AGENT_SETTINGS_KEYS.capabilityMode, 'full');
  setSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
  setSetting(AGENT_SETTINGS_KEYS.baseURL, 'https://api.deepseek.com');
  setSetting(AGENT_SETTINGS_KEYS.model, 'deepseek-chat');
  setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'TEST_PHASE0_MODEL_KEY');

  // Linux server 的 full/bash 必须在读凭据、案件夹或 spawn 之前先确认存在
  // 可兑现的真沙箱；默认容器若 bwrap/Landlock 都不可用，要把固定中文原因交给
  // UI，而不是允许 worker ready 后等第一条 bash 才突然失败。
  const bwrapCapability = probeHostBashSandbox({
    platform: 'linux',
    runtimeDir: '/fixture/runtime',
    spawnSyncFn(program) {
      return { status: program === 'bwrap' ? 0 : 125, stdout: '' };
    },
  });
  assert.deepEqual(bwrapCapability, { available: true, backend: 'bwrap', enforcement: 'full' });
  const landlockCapability = probeHostBashSandbox({
    platform: 'linux',
    runtimeDir: '/fixture/runtime',
    spawnSyncFn(program) {
      return program === 'bwrap'
        ? { status: 1, stdout: '' }
        : { status: 0, stdout: 'landlock-run: fully enforced\n' };
    },
  });
  assert.deepEqual(landlockCapability, { available: true, backend: 'landlock', enforcement: 'full' });
  const unavailableCapability = probeHostBashSandbox({
    platform: 'linux',
    runtimeDir: '/fixture/runtime',
    spawnSyncFn(program) {
      return program === 'bwrap'
        ? { status: 1, stdout: '' }
        : { status: 0, stdout: 'landlock-run: partially enforced (older Landlock ABI)\n' };
    },
  });
  assert.deepEqual(unavailableCapability, {
    available: false,
    backend: null,
    enforcement: 'unavailable',
    reason: AGENT_BASH_SANDBOX_UNAVAILABLE,
  });

  let serverGateSpawnCalls = 0;
  let serverGateCaseReads = 0;
  const serverGate = new AgentSupervisor({
    filesRoot,
    loadConfigFn: () => ({ enabled: true, capabilityMode: 'full', apiKeyEnv: 'MUST_NOT_BE_READ' }),
    bashSandboxProbeFn: () => unavailableCapability,
    resolveCaseDirectoryFn() {
      serverGateCaseReads += 1;
      throw new Error('server sandbox gate ran too late');
    },
    spawnFn() {
      serverGateSpawnCalls += 1;
      throw new Error('server sandbox gate ran too late');
    },
  });
  const serverRejected = await serverGate.start(999999);
  assert.deepEqual(serverRejected, {
    status: 'error',
    caseId: 999999,
    error: AGENT_BASH_SANDBOX_UNAVAILABLE,
  });
  assert.equal(serverGateCaseReads, 0, '无真沙箱时不得读取案件夹');
  assert.equal(serverGateSpawnCalls, 0, '无真沙箱时不得 spawn DSH worker');

  const expectUnavailable = process.env.ANQI_EXPECT_SANDBOX_UNAVAILABLE === '1';
  if (expectUnavailable) {
    const actualCapability = probeHostBashSandbox();
    assert.deepEqual(actualCapability, {
      available: false,
      backend: null,
      enforcement: 'unavailable',
      reason: AGENT_BASH_SANDBOX_UNAVAILABLE,
    });
    let actualCaseReads = 0;
    let actualSpawns = 0;
    const actualGate = new AgentSupervisor({
      filesRoot,
      loadConfigFn: () => ({ enabled: true, capabilityMode: 'full', apiKeyEnv: 'MUST_NOT_BE_READ' }),
      bashSandboxProbeFn: () => actualCapability,
      resolveCaseDirectoryFn() { actualCaseReads += 1; },
      spawnFn() { actualSpawns += 1; },
    });
    const actualRejected = await actualGate.start(999998);
    assert.equal(actualRejected.status, 'error');
    assert.equal(actualRejected.error, AGENT_BASH_SANDBOX_UNAVAILABLE);
    assert.equal(actualCaseReads, 0);
    assert.equal(actualSpawns, 0);
    console.log(`SERVER_SANDBOX_GATE platform=${process.platform} backend=unavailable result=rejected-before-credential-case-spawn`);
    console.log(`SERVER_SANDBOX_REASON ${actualRejected.error}`);
  } else {
  const caseId = db.prepare(
    `INSERT INTO cases (name, procedure, stage, status, folder_path)
     VALUES (?, '一审', '', 'active', ?)`
  ).run(caseName, caseName).lastInsertRowid;
  let spawnCalls = 0;
  const supervisor = new AgentSupervisor({
    filesRoot,
    spawnFn() {
      spawnCalls += 1;
      throw new Error('Phase 0 overlap gate failed before spawn');
    },
  });
  const overlap = await supervisor.start(caseId);
  assert.equal(overlap.status, 'error');
  assert.equal(overlap.error, 'sandbox_db_overlap');
  assert.equal(spawnCalls, 0, 'DB 落入案件 workspace 时必须在 spawn 前拒绝');

  // Dockerfile 必须显式把 bubblewrap 带进服务器镜像；运行期若 bwrap 仍不可用，
  // 严格 provider 才可选用能满足同一读写边界的 Landlock，否则 fail closed。
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /apt-get\s+install[^\n]*bubblewrap/);

  // 真实 bash 沙箱：当前案可读写；他案文件既不可写，也不可读。
  const sandboxRoot = path.join(scratch, 'sandbox-current-case');
  const sandboxOther = path.join(scratch, 'sandbox-other-case');
  const sandboxTemp = path.join(scratch, 'sandbox-temp');
  fs.mkdirSync(sandboxRoot);
  fs.mkdirSync(sandboxOther);
  fs.mkdirSync(sandboxTemp);
  const otherSecret = path.join(sandboxOther, 'contacts-secret.txt');
  fs.writeFileSync(otherSecret, 'contact=never-visible');

  sandboxCtx = new Context();
  await sandboxCtx.plugin(LocalSubprocessRuntime);
  await sandboxCtx.plugin(SandboxPolicyService, {
    mode: 'workspace-write',
    workspaceRoot: sandboxRoot,
  });
  await sandboxCtx.plugin(LocalSandboxProvider, {
    runnerCommand: [],
    runnerFailureSignatures: [],
    probeTimeoutMs: 5_000,
  });
  installConfidentialSandbox(sandboxCtx, {
    filesRoot: scratch,
    databasePath,
    tempRoot: sandboxTemp,
  });
  await sandboxCtx.plugin(SandboxBashExecutor, {
    cwd: sandboxRoot,
    timeoutMs: 10_000,
    maxTimeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    maxSpillBytes: 1024 * 1024,
    graceMs: 1_000,
  });

  const run = (command) => sandboxCtx.shell.run(sandboxCtx.shell.resolve({ command }));
  const insideFile = path.join(sandboxRoot, 'inside.txt');
  const inside = await run(`printf 'inside-ok' > ${JSON.stringify(insideFile)} && cat ${JSON.stringify(insideFile)}`);
  assert.equal(inside.exitCode, 0);
  assert.equal(inside.stdout.text, 'inside-ok');
  assert.equal(inside.sandbox?.mode, 'workspace-write');
  assert.equal(inside.sandbox?.denied, false);
  const selected = sandboxCtx.sandbox.selectedRunner;
  assert.ok(selected && typeof selected === 'object', '真实沙箱必须报告实际选中的后端');
  assert.equal(selected.enforcement, 'full', '案齐不接受 partial 沙箱兑现 full/bash');
  if (process.platform === 'linux') assert.ok(['bwrap', 'landlock'].includes(selected.runner));
  if (process.platform === 'darwin') assert.equal(selected.runner, 'seatbelt');

  const outsideWrite = path.join(sandboxOther, 'must-not-exist.txt');
  const writeDenied = await run(`printf 'escape' > ${JSON.stringify(outsideWrite)}`);
  assert.notEqual(writeDenied.exitCode, 0);
  assert.equal(writeDenied.sandbox?.denied, true);
  assert.equal(fs.existsSync(outsideWrite), false);

  const readDenied = await run(`cat ${JSON.stringify(otherSecret)}`);
  assert.notEqual(readDenied.exitCode, 0, 'bash 不得读取其他案件/contacts 所在宿主路径');
  assert.equal(readDenied.sandbox?.denied, true);
  assert.doesNotMatch(readDenied.stdout.text, /never-visible/);

  const compact = (result) => String(result.stderr?.text || '')
    .trim()
    .replaceAll(scratch, '<scratch>');
  console.log(`SANDBOX_BACKEND platform=${process.platform} runner=${selected.runner} enforcement=${selected.enforcement}`);
  console.log(`SANDBOX_DENIAL outside-write exit=${writeDenied.exitCode} stderr=${JSON.stringify(compact(writeDenied))}`);
  console.log(`SANDBOX_DENIAL other-case-read exit=${readDenied.exitCode} stderr=${JSON.stringify(compact(readDenied))}`);

  console.log(
    `agent sandbox boundary tests: DB/workspace overlap fail-closed + real ${process.platform} `
    + 'sandbox allows current-case rw and denies other-case read/write passed'
  );
  }
} finally {
  if (sandboxCtx) await sandboxCtx.fiber.dispose();
  if (db?.open) db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
