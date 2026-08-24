import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '../src/agent/runtime/node_modules/@deepseek-ai/cordis/lib/index.js';
import AnqiWorkspaceFileSystem from '../src/agent/assets/plugins/dsh-anqi-fs/index.js';
import { apply as applySearchGuard } from '../src/agent/assets/plugins/dsh-anqi-workspace-guard/index.js';

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

  console.log('agent workspace guard tests: read/write provider + glob/grep absolute/symlink containment passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}
