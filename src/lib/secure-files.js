import fs from 'node:fs';
import path from 'node:path';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export class SecurePathError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SecurePathError';
    this.code = code;
  }
}

function pathError(code, message, cause) {
  return new SecurePathError(code, message, cause);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function containedBy(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function lstatOrPathError(absolute, message = '文件或目录不存在') {
  try {
    return fs.lstatSync(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw pathError('not_found', message, error);
    }
    throw error;
  }
}

function realpathOrPathError(absolute) {
  try {
    return fs.realpathSync.native(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw pathError('not_found', '文件或目录不存在', error);
    }
    throw error;
  }
}

function identityRecord(absolute, stat) {
  return { absolute, dev: stat.dev, ino: stat.ino };
}

function verifyIdentities(records) {
  for (const record of records) {
    const current = lstatOrPathError(record.absolute);
    if (current.isSymbolicLink() || !sameFile(current, record)) {
      throw pathError('path_changed', '文件路径在操作期间发生变化，请重试');
    }
  }
}

export function normalizeCaseDirectoryName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name === '.' || name === '..' || name.startsWith('.')) return null;
  if (CONTROL_CHARS.test(name) || name.includes('/') || name.includes('\\')) return null;
  if (path.isAbsolute(name) || Buffer.byteLength(name, 'utf8') > 255) return null;
  return name;
}

// 分组：部署者可以把文件根下的若干一级文件夹登记为「分组」（如 诉讼/、顾问/），
// 这时案件夹也可以是分组下的一级文件夹，folder_path 记为「分组/案件夹」。最多两层，
// 第一层必须是**当前登记**的分组：没登记分组时，两段路径一律按旧口径视为不合法、
// 回落 cases.name——017 之前遗留的 OneDrive/... 多层指针因此行为完全不变。
// 分组本身不是案件夹、案件夹不互相嵌套，由建案 / 换绑 / 分组设置三处写入口保证
// （routes/cases.js）；这里只负责结构与真实路径边界。
function caseFolderGroupSet(groups) {
  return new Set((Array.isArray(groups) ? groups : [])
    .map((group) => normalizeCaseDirectoryName(group))
    .filter(Boolean));
}

export function normalizeCaseFolderPath(value, { groups = [] } = {}) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw.includes('/')) return normalizeCaseDirectoryName(raw);
  const parts = raw.split('/');
  if (parts.length !== 2) return null;
  const group = normalizeCaseDirectoryName(parts[0]);
  const name = normalizeCaseDirectoryName(parts[1]);
  if (!group || !name || !caseFolderGroupSet(groups).has(group)) return null;
  return `${group}/${name}`;
}

// 只接受 normalizeCaseFolderPath() 的输出。
export function splitCaseFolderPath(folderPath) {
  const index = folderPath.indexOf('/');
  return index < 0
    ? { group: '', name: folderPath }
    : { group: folderPath.slice(0, index), name: folderPath.slice(index + 1) };
}

// cases.name 是案件标题；folder_path 才是 ANJIAN_FILES_ROOT 下的工作区名。
// 兼容迁移前的空值：在 017 migration 尚未跑过的独立 fixture/旧备份上仍以
// name 作为一次性 fallback，但所有新写入都会把 folder_path 物化为非空值。
// 标题回落只认单层目录名，标题里的「/」不会被当成分组路径。
export function caseDirectoryName(caseRow, options = {}) {
  if (typeof caseRow === 'string') return normalizeCaseFolderPath(caseRow, options);
  if (!caseRow || typeof caseRow !== 'object') return null;
  return normalizeCaseFolderPath(caseRow.folder_path, options)
    || normalizeCaseDirectoryName(caseRow.name);
}

// 案件夹的身份锚：文件根、（分组下的案件）分组文件夹、案件夹本身。
function caseAnchorIdentities(context) {
  return [context.filesRootIdentity, context.groupIdentity, context.caseRootIdentity].filter(Boolean);
}

export function normalizeRelativeFilePath(value, { allowEmpty = false, rejectHidden = true } = {}) {
  const raw = String(value ?? '');
  if (CONTROL_CHARS.test(raw) || raw.includes('\\') || path.posix.isAbsolute(raw)) {
    throw pathError('invalid_path', '文件相对路径非法');
  }
  if (!raw) {
    if (allowEmpty) return '';
    throw pathError('invalid_path', '文件相对路径非法');
  }
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || (rejectHidden && part.startsWith('.')))) {
    throw pathError('invalid_path', '隐藏或非法路径不允许访问');
  }
  return parts.join('/');
}

export function sanitizeUploadFileName(value) {
  const cleaned = [...String(value || '')]
    .filter((char) => char !== '/' && char !== '\\' && !CONTROL_CHARS.test(char))
    .join('')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.startsWith('.')) return null;
  return cleaned.slice(0, 180);
}

export function resolveFilesRoot(configuredRoot) {
  if (!configuredRoot) throw pathError('root_unconfigured', '未配置文件根（ANJIAN_FILES_ROOT）');
  const configured = path.resolve(configuredRoot);
  let real;
  try { real = fs.realpathSync.native(configured); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw pathError('root_unavailable', '文件根不存在', error);
    }
    throw error;
  }
  const stat = lstatOrPathError(real, '文件根不存在');
  if (!stat.isDirectory()) throw pathError('root_invalid', '文件根不是目录');
  return { absolute: real, identity: identityRecord(real, stat) };
}

export function ensureFilesRoot(configuredRoot) {
  if (!configuredRoot) throw pathError('root_unconfigured', '未配置文件根（ANJIAN_FILES_ROOT）');
  const configured = path.resolve(configuredRoot);
  try {
    fs.mkdirSync(configured, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw pathError('root_unavailable', '文件根无法创建或访问', error);
  }
  return resolveFilesRoot(configured);
}

export function resolveCaseDirectory(configuredRoot, caseName, options = {}) {
  const name = normalizeCaseFolderPath(caseName, options);
  if (!name) throw pathError('invalid_case_name', '案件夹必须是文件根下一个非隐藏的文件夹，或已登记分组下的一个文件夹');
  const filesRoot = resolveFilesRoot(configuredRoot);
  const { group, name: leaf } = splitCaseFolderPath(name);
  let parent = filesRoot.absolute;
  let groupIdentity = null;
  if (group) {
    const groupPath = path.join(filesRoot.absolute, group);
    let groupStat;
    try {
      groupStat = fs.lstatSync(groupPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return {
          name,
          filesRoot: filesRoot.absolute,
          filesRootIdentity: filesRoot.identity,
          groupIdentity: null,
          caseRoot: path.join(groupPath, leaf),
          caseRootIdentity: null,
          exists: false,
        };
      }
      throw error;
    }
    if (groupStat.isSymbolicLink()) throw pathError('symlink', '分组文件夹不能是符号链接');
    if (!groupStat.isDirectory()) throw pathError('not_directory', '分组文件夹不是目录');
    const groupReal = realpathOrPathError(groupPath);
    if (!containedBy(filesRoot.absolute, groupReal)) throw pathError('escape', '分组文件夹真实路径越出文件根');
    const groupRealStat = lstatOrPathError(groupReal);
    if (!sameFile(groupStat, groupRealStat)) throw pathError('path_changed', '分组文件夹在检查期间发生变化，请重试');
    parent = groupReal;
    groupIdentity = identityRecord(groupReal, groupRealStat);
  }
  const expected = path.join(parent, leaf);
  let stat;
  try {
    stat = fs.lstatSync(expected);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        name,
        filesRoot: filesRoot.absolute,
        filesRootIdentity: filesRoot.identity,
        groupIdentity,
        caseRoot: expected,
        caseRootIdentity: null,
        exists: false,
      };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) throw pathError('symlink', '案件夹不能是符号链接');
  if (!stat.isDirectory()) throw pathError('not_directory', '案件夹不是目录');
  const real = realpathOrPathError(expected);
  if (!containedBy(parent, real)) throw pathError('escape', '案件夹真实路径越出文件根');
  const realStat = lstatOrPathError(real);
  if (!sameFile(stat, realStat)) throw pathError('path_changed', '案件夹在检查期间发生变化，请重试');
  return {
    name,
    filesRoot: filesRoot.absolute,
    filesRootIdentity: filesRoot.identity,
    groupIdentity,
    caseRoot: real,
    caseRootIdentity: identityRecord(real, realStat),
    exists: true,
  };
}

export function resolveCaseDirectoryForCase(configuredRoot, caseRow, options = {}) {
  const directoryName = caseDirectoryName(caseRow, options);
  if (!directoryName) throw pathError('invalid_case_name', '案件工作区必须是单一、非隐藏的目录名称');
  const primary = resolveCaseDirectory(configuredRoot, directoryName, options);
  if (primary.exists || !caseRow || typeof caseRow !== 'object') return primary;

  // beta3 兼容：只有“合法、非空的 folder_path 指针目标确实不存在”这一种情
  // 形，才尝试同名 name 目录。folder_path 若是 symlink/普通文件/越界路径，
  // resolveCaseDirectory() 会在上面直接抛错，不能用 fallback 掩盖边界故障。
  const configuredName = normalizeCaseFolderPath(caseRow.folder_path, options);
  const fallbackName = normalizeCaseDirectoryName(caseRow.name);
  if (!configuredName || !fallbackName || configuredName === fallbackName) return primary;
  const fallback = resolveCaseDirectory(configuredRoot, fallbackName);
  if (!fallback.exists) return primary;
  return {
    ...fallback,
    fallbackFrom: configuredName,
    fallbackNotice: `原案件夹“${configuredName}”不存在，已临时回落到同名目录“${fallbackName}”`,
  };
}

// 只列一层真实子目录：不递归、不跟随 symlink、隐藏项不出现。
function listDirectChildren(parent) {
  const names = [];
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    const name = normalizeCaseDirectoryName(entry.name);
    if (!name || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const absolute = path.join(parent, name);
    let stat;
    try { stat = fs.lstatSync(absolute); } catch { continue; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    let real;
    try { real = fs.realpathSync.native(absolute); } catch { continue; }
    if (!containedBy(parent, real) || real !== absolute) continue;
    names.push(name);
  }
  names.sort((left, right) => left.localeCompare(right, 'zh-CN'));
  return names;
}

// 可绑定 workspace 候选：文件根的直接子目录（names，已登记的分组不在其中），
// 以及每个分组下的直接子目录（groups[].names）。只到这两层，绝不再往下。
export function listCaseDirectories(configuredRoot, options = {}) {
  // 纯读路径必须如实反映同步盘/挂载点是否可用。不能在 GET 时用
  // ensureFilesRoot() 补建一个同名空目录，否则挂载掉线会被伪装成“空案卷”。
  const root = resolveFilesRoot(configuredRoot);
  const groupNames = caseFolderGroupSet(options.groups);
  const rootNames = listDirectChildren(root.absolute);
  const present = new Set(rootNames);
  const groups = [...groupNames].map((group) => ({
    name: group,
    exists: present.has(group),
    names: present.has(group) ? listDirectChildren(path.join(root.absolute, group)) : [],
  }));
  return {
    filesRoot: root.absolute,
    names: rootNames.filter((name) => !groupNames.has(name)),
    groups,
  };
}

export function ensureCaseDirectory(configuredRoot, requestedName, options = {}) {
  const name = normalizeCaseFolderPath(requestedName, options);
  if (!name) throw pathError('invalid_case_name', '案件夹必须是文件根下一个非隐藏的文件夹，或已登记分组下的一个文件夹');
  const filesRoot = ensureFilesRoot(configuredRoot);
  verifyIdentities([filesRoot.identity]);
  const { group } = splitCaseFolderPath(name);
  if (group) {
    // 分组文件夹不存在时顺手建出来；随后 resolveCaseDirectory() 会拒绝符号链接、
    // 非目录与越界，必须在建案件夹之前校验完，避免经被换成链接的分组建到根外。
    try {
      fs.mkdirSync(path.join(filesRoot.absolute, group), { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  const before = resolveCaseDirectory(filesRoot.absolute, name, options);
  let created = false;
  if (!before.exists) {
    verifyIdentities([filesRoot.identity, before.groupIdentity].filter(Boolean));
    try {
      fs.mkdirSync(before.caseRoot, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  const context = resolveCaseDirectory(filesRoot.absolute, name, options);
  if (!context.exists) throw pathError('not_found', '案件工作区创建后不可见');
  verifyIdentities(caseAnchorIdentities(context));
  return { context, created };
}

// 只用于“先建目录、后插案件行”的失败回滚。必须仍是刚才创建的同一个 inode，
// 且目录为空；任何外部同步进来的内容都会让 rmdir 失败并被保留。
export function removeCreatedCaseDirectory(context) {
  if (!context?.exists || !context.caseRootIdentity) return false;
  try {
    verifyIdentities(caseAnchorIdentities(context));
    fs.rmdirSync(context.caseRoot);
    return true;
  } catch {
    return false;
  }
}

function requireCaseDirectory(context) {
  if (!context?.exists || !context.caseRootIdentity) {
    throw pathError('not_found', '案件夹不存在');
  }
  verifyIdentities(caseAnchorIdentities(context));
}

function inspectExistingPath(context, relativePath, expectedType) {
  requireCaseDirectory(context);
  const rel = normalizeRelativeFilePath(relativePath, { allowEmpty: expectedType === 'directory' });
  const parts = rel ? rel.split('/') : [];
  const identities = caseAnchorIdentities(context);
  let absolute = context.caseRoot;
  let stat = lstatOrPathError(absolute);

  for (let index = 0; index < parts.length; index += 1) {
    absolute = path.join(absolute, parts[index]);
    stat = lstatOrPathError(absolute);
    if (stat.isSymbolicLink()) throw pathError('symlink', '路径中不允许符号链接');
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw pathError('not_directory', '路径中的中间项不是目录');
    }
    identities.push(identityRecord(absolute, stat));
  }

  if (expectedType === 'file' && !stat.isFile()) throw pathError('not_file', '目标不是普通文件');
  if (expectedType === 'directory' && !stat.isDirectory()) throw pathError('not_directory', '目标不是目录');
  const real = realpathOrPathError(absolute);
  if (!containedBy(context.caseRoot, real)) throw pathError('escape', '真实路径越出案件夹');
  verifyIdentities(identities);
  return { absolute: real, relativePath: rel, stat, identities };
}

export function inspectSecureFile(context, relativePath) {
  return inspectExistingPath(context, relativePath, 'file');
}

export function inspectSecureDirectory(context, relativePath = '') {
  return inspectExistingPath(context, relativePath, 'directory');
}

export function openSecureFile(context, relativePath) {
  const inspected = inspectSecureFile(context, relativePath);
  let fd;
  try {
    fd = fs.openSync(inspected.absolute, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameFile(opened, inspected.stat)) {
      throw pathError('path_changed', '文件在打开期间发生变化，请重试');
    }
    verifyIdentities(inspected.identities);
    const currentReal = realpathOrPathError(inspected.absolute);
    if (!containedBy(context.caseRoot, currentReal)) throw pathError('escape', '真实路径越出案件夹');
    return { fd, absolute: inspected.absolute, relativePath: inspected.relativePath, stat: opened };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error?.code === 'ELOOP') throw pathError('symlink', '文件不能是符号链接', error);
    throw error;
  }
}

export function listSecureDirectory(context, relativePath = '') {
  const inspected = inspectSecureDirectory(context, relativePath);
  const dirs = [];
  const files = [];
  let entries;
  try {
    entries = fs.readdirSync(inspected.absolute, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw pathError('path_changed', '目录在读取期间发生变化，请重试', error);
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absolute = path.join(inspected.absolute, entry.name);
    let stat;
    try { stat = fs.lstatSync(absolute); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) dirs.push(entry.name);
    else if (stat.isFile()) {
      files.push({
        name: entry.name,
        size: stat.size,
        mtime: stat.mtime.toISOString().slice(0, 10),
        mtime_ms: stat.mtimeMs,
      });
    }
  }
  verifyIdentities(inspected.identities);
  dirs.sort();
  files.sort((left, right) => right.mtime_ms - left.mtime_ms);
  return { dirs, files };
}

export function walkSecureFiles(context, accept = () => true) {
  const out = [];
  if (!context.exists) return out;
  const visit = (relativeDirectory = '') => {
    let listing;
    try { listing = listSecureDirectory(context, relativeDirectory); } catch { return; }
    for (const directory of listing.dirs) {
      const rel = relativeDirectory ? `${relativeDirectory}/${directory}` : directory;
      visit(rel);
    }
    for (const file of listing.files) {
      const rel = relativeDirectory ? `${relativeDirectory}/${file.name}` : file.name;
      if (accept(file.name, rel)) out.push(rel);
    }
  };
  visit();
  return out;
}

function ensureSecureDirectory(context, relativePath) {
  requireCaseDirectory(context);
  const rel = normalizeRelativeFilePath(relativePath);
  const parts = rel.split('/');
  let prefix = '';
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    try {
      inspectSecureDirectory(context, prefix);
    } catch (error) {
      if (error?.code !== 'not_found') throw error;
      const parentRel = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';
      const parent = inspectSecureDirectory(context, parentRel);
      const target = path.join(parent.absolute, part);
      try {
        fs.mkdirSync(target, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      inspectSecureDirectory(context, prefix);
    }
  }
  return inspectSecureDirectory(context, rel);
}

function suffixedName(name, suffix) {
  if (suffix === 1) return name;
  const extension = path.extname(name);
  return `${path.basename(name, extension)}(${suffix})${extension}`;
}

function unlinkIfSameFile(absolute, opened) {
  try {
    const current = fs.lstatSync(absolute);
    if (!current.isSymbolicLink() && sameFile(current, opened)) fs.unlinkSync(absolute);
  } catch { /* 文件已经消失或已被替换，不删除未知对象 */ }
}

export function writeUniqueSecureFile(context, relativeDirectory, requestedName, data) {
  const name = sanitizeUploadFileName(requestedName);
  if (!name) throw pathError('invalid_filename', '文件名非法');
  const directory = ensureSecureDirectory(context, relativeDirectory);
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

  for (let suffix = 1; suffix <= 10000; suffix += 1) {
    const finalName = suffixedName(name, suffix);
    const absolute = path.join(directory.absolute, finalName);
    let fd;
    let opened;
    try {
      fd = fs.openSync(
        absolute,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
        0o600
      );
      opened = fs.fstatSync(fd);
      if (!opened.isFile()) throw pathError('not_file', '新建目标不是普通文件');
      fs.writeFileSync(fd, buffer);
      fs.fsyncSync(fd);
      opened = fs.fstatSync(fd);
      verifyIdentities(directory.identities);
      const current = lstatOrPathError(absolute);
      if (current.isSymbolicLink() || !sameFile(current, opened)) {
        throw pathError('path_changed', '文件在写入期间发生变化，请重试');
      }
      const real = realpathOrPathError(absolute);
      if (!containedBy(context.caseRoot, real)) throw pathError('escape', '新文件真实路径越出案件夹');
      fs.closeSync(fd);
      return {
        absolute: real,
        relativePath: `${normalizeRelativeFilePath(relativeDirectory)}/${finalName}`,
        filename: finalName,
        size: opened.size,
        identity: identityRecord(real, opened),
      };
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* 已关闭 */ }
      }
      if (opened) unlinkIfSameFile(absolute, opened);
      if (error?.code === 'EEXIST') continue;
      if (error?.code === 'ELOOP') continue;
      throw error;
    }
  }
  throw pathError('name_exhausted', '同名文件过多，无法生成安全文件名');
}

export function removeSecureCreatedFile(context, written) {
  if (!written?.identity || !containedBy(context.caseRoot, written.absolute)) return false;
  try {
    verifyIdentities(caseAnchorIdentities(context));
    const current = fs.lstatSync(written.absolute);
    if (current.isSymbolicLink() || !sameFile(current, written.identity)) return false;
    fs.unlinkSync(written.absolute);
    return true;
  } catch {
    return false;
  }
}
