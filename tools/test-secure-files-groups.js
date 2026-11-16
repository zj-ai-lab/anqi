// 案件夹分组（「分组/案件夹」两层）的路径层回归：规范化、解析、列目录、创建、
// 符号链接与越界拒绝，以及「没登记分组时两段路径照旧不合法、回落标题」的兼容口径。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  caseDirectoryName,
  ensureCaseDirectory,
  listCaseDirectories,
  normalizeCaseFolderPath,
  removeCreatedCaseDirectory,
  resolveCaseDirectory,
  resolveCaseDirectoryForCase,
  writeUniqueSecureFile,
} from '../src/lib/secure-files.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-secure-groups-'));
const root = path.join(scratch, 'files');
const outside = path.join(scratch, 'outside');
fs.mkdirSync(root);
fs.mkdirSync(outside);
const groups = { groups: ['诉讼', '顾问'] };

try {
  // 规范化：一段照旧；两段只在第一段是已登记分组时成立；三段及以上一律不成立。
  assert.equal(normalizeCaseFolderPath(' 示例案 '), '示例案');
  assert.equal(normalizeCaseFolderPath('诉讼/示例案'), null, '未登记分组时两段路径不合法');
  assert.equal(normalizeCaseFolderPath('诉讼/示例案', groups), '诉讼/示例案');
  assert.equal(normalizeCaseFolderPath(' 诉讼 / 示例案 ', groups), '诉讼/示例案');
  for (const invalid of ['未登记/示例案', '诉讼/示例/再一层', '诉讼/', '/示例案', '诉讼/.隐藏', '诉讼/..', '../诉讼/x', '诉讼\\示例案', '诉讼//示例案']) {
    assert.equal(normalizeCaseFolderPath(invalid, groups), null, `应拒绝：${invalid}`);
  }

  // 兼容：017 之前遗留的多段指针在没登记分组时照旧回落标题。
  assert.equal(caseDirectoryName({ folder_path: 'OneDrive/项目/旧案', name: '旧案' }, groups), '旧案');
  assert.equal(caseDirectoryName({ folder_path: '诉讼/旧案', name: '旧案' }), '旧案');
  assert.equal(caseDirectoryName({ folder_path: '诉讼/旧案', name: '旧案' }, groups), '诉讼/旧案');
  assert.equal(caseDirectoryName({ folder_path: '', name: '诉讼/标题带斜杠' }, groups), null, '标题回落只认单层目录名');

  // 解析：分组不存在 → exists=false；分组与案件夹都在 → 真实路径与身份锚。
  let context = resolveCaseDirectory(root, '诉讼/甲案', groups);
  assert.equal(context.exists, false);
  assert.equal(context.caseRoot, path.join(fs.realpathSync(root), '诉讼', '甲案'));
  fs.mkdirSync(path.join(root, '诉讼', '甲案', '法院文书'), { recursive: true });
  context = resolveCaseDirectory(root, '诉讼/甲案', groups);
  assert.equal(context.exists, true);
  assert.equal(context.name, '诉讼/甲案');
  assert.ok(context.groupIdentity, '分组下的案件要带分组身份锚');
  const written = writeUniqueSecureFile(context, '法院文书', '材料.txt', Buffer.from('内容'));
  assert.equal(written.relativePath, '法院文书/材料.txt');
  assert.equal(fs.readFileSync(path.join(root, '诉讼', '甲案', '法院文书', '材料.txt'), 'utf8'), '内容');
  assert.throws(() => resolveCaseDirectory(root, '诉讼/甲案'), { code: 'invalid_case_name' }, '未传分组清单时两段路径不可解析');

  // resolveCaseDirectoryForCase：分组口径透传；指针缺失时只回落文件根下的同名标题目录。
  context = resolveCaseDirectoryForCase(root, { folder_path: '诉讼/甲案', name: '甲案' }, groups);
  assert.equal(context.exists, true);
  assert.equal(context.name, '诉讼/甲案');

  // 列目录：分组不出现在根下候选里；分组内只列一层真实目录，隐藏项与符号链接都不出现。
  fs.mkdirSync(path.join(root, '散案'));
  fs.mkdirSync(path.join(root, '诉讼', '.隐藏'));
  fs.mkdirSync(path.join(root, '诉讼', '甲案', '证据'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, '诉讼', '外链案'));
  fs.writeFileSync(path.join(root, '诉讼', '不是目录.txt'), 'x');
  let listing = listCaseDirectories(root, groups);
  assert.deepEqual(listing.names, ['散案']);
  assert.deepEqual(listing.groups.find((group) => group.name === '诉讼'), { name: '诉讼', exists: true, names: ['甲案'] });
  assert.deepEqual(listing.groups.find((group) => group.name === '顾问'), { name: '顾问', exists: false, names: [] });
  listing = listCaseDirectories(root);
  assert.deepEqual(listing.names, ['散案', '诉讼'], '没登记分组时诉讼就是普通一级文件夹');
  assert.deepEqual(listing.groups, []);

  // 创建：分组文件夹不存在时一并建出；回滚只删刚建的空案件夹，分组文件夹保留。
  const ensured = ensureCaseDirectory(root, '顾问/乙公司', groups);
  assert.equal(ensured.created, true);
  assert.equal(fs.statSync(path.join(root, '顾问', '乙公司')).isDirectory(), true);
  assert.equal(removeCreatedCaseDirectory(ensured.context), true);
  assert.equal(fs.existsSync(path.join(root, '顾问', '乙公司')), false);
  assert.equal(fs.statSync(path.join(root, '顾问')).isDirectory(), true);
  assert.equal(ensureCaseDirectory(root, '诉讼/甲案', groups).created, false, '已存在的案件夹不重复创建');

  // 符号链接与越界：分组本身是链接、分组下的案件夹是链接，都拒绝，且不在根外建任何东西。
  fs.symlinkSync(outside, path.join(root, '链接组'));
  const linkGroups = { groups: ['链接组'] };
  assert.throws(() => resolveCaseDirectory(root, '链接组/丙案', linkGroups), { code: 'symlink' });
  assert.throws(() => ensureCaseDirectory(root, '链接组/丙案', linkGroups), { code: 'symlink' });
  assert.equal(fs.existsSync(path.join(outside, '丙案')), false, '经链接分组不得在根外建目录');
  assert.throws(() => resolveCaseDirectory(root, '诉讼/外链案', groups), { code: 'symlink' });
  fs.writeFileSync(path.join(root, '文件组'), 'x');
  assert.throws(() => ensureCaseDirectory(root, '文件组/丁案', { groups: ['文件组'] }), (error) => error.code === 'not_directory' || error.code === 'ENOTDIR');

  console.log('secure files groups: 分组/案件夹 两层规范化 + 兼容回落 + 列目录只到两层 + 创建/回滚 + 链接与越界拒绝 passed');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
