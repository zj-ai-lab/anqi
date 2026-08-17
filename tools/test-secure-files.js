import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inspectSecureDirectory,
  inspectSecureFile,
  listSecureDirectory,
  normalizeCaseDirectoryName,
  openSecureFile,
  resolveCaseDirectory,
  walkSecureFiles,
  writeUniqueSecureFile,
} from '../src/lib/secure-files.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-secure-files-'));
const root = path.join(scratch, 'files');
const outside = path.join(scratch, 'outside');
fs.mkdirSync(root);
fs.mkdirSync(outside);

try {
  for (const invalid of ['', ' ', '.', '..', '.隐藏案', '../逃逸', 'a/b', 'a\\b', '/绝对', '坏\0名', '坏\n名']) {
    assert.equal(normalizeCaseDirectoryName(invalid), null, `案件名应拒绝：${JSON.stringify(invalid)}`);
  }
  assert.equal(normalizeCaseDirectoryName(' 示例案件 '), '示例案件');

  const casePath = path.join(root, '示例案件');
  fs.mkdirSync(path.join(casePath, '法院文书'), { recursive: true });
  fs.writeFileSync(path.join(casePath, '法院文书', '正常材料.txt'), '正常内容');
  let context = resolveCaseDirectory(root, '示例案件');
  assert.equal(context.exists, true);
  assert.equal(inspectSecureDirectory(context, '法院文书').stat.isDirectory(), true);
  assert.equal(inspectSecureFile(context, '法院文书/正常材料.txt').stat.isFile(), true);
  assert.deepEqual(listSecureDirectory(context, '法院文书').files.map((file) => file.name), ['正常材料.txt']);
  assert.deepEqual(walkSecureFiles(context, (name) => name.endsWith('.txt')), ['法院文书/正常材料.txt']);

  fs.writeFileSync(path.join(outside, '秘密.txt'), '不应读取');
  fs.symlinkSync(outside, path.join(casePath, '外链目录'));
  assert.throws(
    () => inspectSecureFile(context, '外链目录/秘密.txt'),
    (error) => error?.code === 'symlink'
  );
  fs.symlinkSync(path.join(outside, '秘密.txt'), path.join(casePath, '法院文书', '外链文件.txt'));
  assert.throws(
    () => openSecureFile(context, '法院文书/外链文件.txt'),
    (error) => error?.code === 'symlink'
  );
  assert.equal(listSecureDirectory(context, '法院文书').files.some((file) => file.name === '外链文件.txt'), false);
  assert.equal(walkSecureFiles(context).includes('外链目录/秘密.txt'), false);

  const first = writeUniqueSecureFile(context, '法院文书', '上传材料.pdf', Buffer.from('第一份'));
  const second = writeUniqueSecureFile(context, '法院文书', '上传材料.pdf', Buffer.from('第二份'));
  assert.equal(first.relativePath, '法院文书/上传材料.pdf');
  assert.equal(second.relativePath, '法院文书/上传材料(2).pdf');
  assert.equal(fs.readFileSync(first.absolute, 'utf8'), '第一份');
  assert.equal(fs.readFileSync(second.absolute, 'utf8'), '第二份');

  fs.symlinkSync(path.join(outside, '秘密.txt'), path.join(casePath, '法院文书', '链接名.pdf'));
  const linkCollision = writeUniqueSecureFile(context, '法院文书', '链接名.pdf', Buffer.from('安全副本'));
  assert.equal(linkCollision.filename, '链接名(2).pdf', '符号链接重名只能触发新名称，不能被跟随或覆盖');
  assert.equal(fs.readFileSync(path.join(outside, '秘密.txt'), 'utf8'), '不应读取');

  const opened = openSecureFile(context, '法院文书/正常材料.txt');
  const originalPath = path.join(casePath, '法院文书', '正常材料.txt');
  const movedPath = path.join(casePath, '法院文书', '正常材料-旧.txt');
  fs.renameSync(originalPath, movedPath);
  fs.writeFileSync(originalPath, '竞态替换内容');
  try {
    assert.equal(fs.readFileSync(opened.fd, 'utf8'), '正常内容', '安全读取必须绑定已验证 inode，而不是重开被替换的路径');
  } finally {
    fs.closeSync(opened.fd);
  }

  const staleContext = resolveCaseDirectory(root, '示例案件');
  const movedCasePath = path.join(root, '示例案件-旧');
  fs.renameSync(casePath, movedCasePath);
  fs.mkdirSync(casePath);
  assert.throws(
    () => inspectSecureDirectory(staleContext),
    (error) => error?.code === 'path_changed',
    '案件夹在检查后被整体替换时必须拒绝旧上下文'
  );

  const linkedCase = path.join(root, '链接案件');
  fs.symlinkSync(outside, linkedCase);
  assert.throws(
    () => resolveCaseDirectory(root, '链接案件'),
    (error) => error?.code === 'symlink'
  );

  const missing = resolveCaseDirectory(root, '尚未建夹案件');
  assert.equal(missing.exists, false, '合法但尚未建立的案件夹应保留既有空状态语义');

  const rootAlias = path.join(scratch, 'files-alias');
  fs.symlinkSync(root, rootAlias);
  assert.equal(resolveCaseDirectory(rootAlias, '尚未建夹案件').filesRoot, fs.realpathSync.native(root));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log('secure files tests: containment + symlink rejection + exclusive writes + inode-bound reads passed');
