import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCaseDirectoryForCase } from '../src/lib/secure-files.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-folder-fallback-'));
const filesRoot = path.join(scratch, 'files');
fs.mkdirSync(filesRoot);

try {
  const name = '同名案件夹';
  const wrongFolder = '已失效的旧指针';
  const nameRoot = path.join(filesRoot, name);
  fs.mkdirSync(nameRoot);
  fs.writeFileSync(path.join(nameRoot, '回落证据.txt'), 'fallback fixture');

  const fallback = resolveCaseDirectoryForCase(filesRoot, { name, folder_path: wrongFolder });
  assert.equal(fallback.exists, true);
  assert.equal(fallback.name, name);
  assert.equal(fallback.caseRoot, fs.realpathSync.native(nameRoot));
  assert.equal(fallback.fallbackFrom, wrongFolder);
  assert.equal(fallback.fallbackNotice, `原案件夹“${wrongFolder}”不存在，已临时回落到同名目录“${name}”`);
  assert.equal(fs.readFileSync(path.join(fallback.caseRoot, '回落证据.txt'), 'utf8'), 'fallback fixture');

  fs.mkdirSync(path.join(filesRoot, wrongFolder));
  const primary = resolveCaseDirectoryForCase(filesRoot, { name, folder_path: wrongFolder });
  assert.equal(primary.name, wrongFolder, 'folder_path 存在时必须继续以权威指针为准');
  assert.equal(primary.fallbackFrom, undefined);
  fs.rmdirSync(path.join(filesRoot, wrongFolder));

  const bothMissing = resolveCaseDirectoryForCase(filesRoot, {
    name: '同名也不存在', folder_path: '主指针也不存在',
  });
  assert.equal(bothMissing.exists, false);
  assert.equal(bothMissing.name, '主指针也不存在', '两边都不存在时不得静默改写目标');
  assert.equal(bothMissing.fallbackFrom, undefined);

  const outside = path.join(scratch, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(filesRoot, '危险旧指针'));
  assert.throws(
    () => resolveCaseDirectoryForCase(filesRoot, { name, folder_path: '危险旧指针' }),
    (error) => error?.code === 'symlink',
    'folder_path 是符号链接时必须拒绝，不能借 fallback 掩盖边界错误',
  );

  console.log('secure files T2 folder fallback: missing folder_path -> existing same-name directory + notice; primary/symlink authority preserved passed');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
