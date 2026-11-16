import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '../src/agent/runtime/node_modules/@deepseek-ai/cordis/lib/index.js';
import AnqiWorkspaceFileSystem from '../src/agent/assets/plugins/dsh-anqi-fs/index.js';
import { apply as applySearchGuard, installConfidentialSandbox } from '../src/agent/assets/plugins/dsh-anqi-workspace-guard/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-dsh-workspace-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-dsh-outside-'));
fs.writeFileSync(path.join(root, 'inside.txt'), 'inside');
fs.mkdirSync(path.join(root, '..notes'));
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'outside-link.txt'));

try {
  const ctx = new Context();
  ctx.provide('sandboxPolicy', { defaultMode: 'workspace-write' });
  const provider = new AnqiWorkspaceFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 1024 * 1024 });

  const insideTarget = await provider.resolve('inside.txt');
  assert.equal(await provider.readText(insideTarget), 'inside');
  await assert.rejects(() => provider.resolve(path.join(outside, 'secret.txt')), (error) => {
    assert.equal(error.code, 'FS_SANDBOX_DENIED');
    return true;
  });
  await assert.rejects(() => provider.resolve('outside-link.txt'), (error) => {
    assert.equal(error.code, 'FS_SANDBOX_DENIED');
    return true;
  });

  let executeGuard;
  applySearchGuard({
    on(event, handler) {
      assert.equal(event, 'tools/execute');
      executeGuard = handler;
    },
  });
  const run = (name, requestedPath) => executeGuard({
    name,
    arguments: requestedPath === undefined ? {} : { path: requestedPath },
    agent: { session: { header: { cwd: root } } },
  }, async () => 'allowed');

  assert.equal(await run('glob', '.'), 'allowed');
  assert.equal(await run('grep', 'inside.txt'), 'allowed');
  assert.equal(await run('glob', '..notes'), 'allowed', '工作区内以两个点开头的普通名称不是路径穿越');
  assert.equal(await run('glob', undefined), 'allowed');
  await assert.rejects(() => run('glob', outside), (error) => error.code === 'FS_SANDBOX_DENIED');
  await assert.rejects(() => run('grep', 'outside-link.txt'), (error) => error.code === 'FS_SANDBOX_DENIED');
  await assert.rejects(() => run('grep', '../missing'), (error) => error.code === 'FS_SANDBOX_DENIED');

  // 分组下的案件夹（文件根/分组/案件夹）：bwrap 先用 tmpfs 遮蔽整个文件根，再逐级 --dir 补出
  // 分组目录，只把本案夹 bind 回来；同组的他案与分组里的其他内容不进 namespace。
  const groupScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-dsh-groups-'));
  try {
    const filesRoot = path.join(groupScratch, 'files');
    const groupedCase = path.join(filesRoot, '诉讼', '甲案');
    const sibling = path.join(filesRoot, '诉讼', '乙案');
    const dataDir = path.join(groupScratch, 'data');
    const tempRoot = path.join(groupScratch, 'tmp');
    for (const dir of [groupedCase, sibling, dataDir, tempRoot]) fs.mkdirSync(dir, { recursive: true });
    const databasePath = path.join(dataDir, 'anjian.db');
    fs.writeFileSync(databasePath, '');
    const sandboxCtx = { sandbox: { confine: async () => ({ argv: ['bwrap'] }) }, effect() {} };
    installConfidentialSandbox(sandboxCtx, { filesRoot, databasePath, tempRoot });
    const { argv } = await sandboxCtx.sandbox.confine(['ls'], { mode: 'workspace-write', workspaceRoot: groupedCase });
    const realFiles = fs.realpathSync(filesRoot);
    const realCase = fs.realpathSync(groupedCase);
    const pairAt = (flag, value) => argv.findIndex((item, index) => item === flag && argv[index + 1] === value);
    const tmpfs = pairAt('--tmpfs', realFiles);
    const groupDir = pairAt('--dir', path.join(realFiles, '诉讼'));
    const caseDir = pairAt('--dir', realCase);
    const bind = argv.findIndex((item, index) => item === '--bind' && argv[index + 1] === realCase && argv[index + 2] === realCase);
    assert.ok(tmpfs >= 0, '整个文件根必须先被 tmpfs 遮蔽');
    assert.ok(groupDir > tmpfs && caseDir > groupDir && bind > caseDir, '遮蔽 → 补分组目录 → 补案件夹目录 → 只挂回本案夹');
    assert.equal(argv.includes(fs.realpathSync(sibling)), false, '同组他案不得出现在沙箱参数里');
    await assert.rejects(
      () => sandboxCtx.sandbox.confine(['ls'], { mode: 'workspace-write', workspaceRoot: dataDir }),
      (error) => error.code === 'SANDBOX_UNAVAILABLE',
      'workspace 不在文件根内必须 fail-closed',
    );
  } finally {
    fs.rmSync(groupScratch, { recursive: true, force: true });
  }

  console.log('agent workspace guard tests: read/write provider + glob/grep absolute/symlink containment + grouped case bwrap mask passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}
