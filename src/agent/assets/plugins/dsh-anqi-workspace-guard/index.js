// Guard DSH search tools that execute ripgrep directly instead of going through
// ctx.fs. The stock glob/grep implementation accepts an absolute `path`; without
// this wrapper it could search outside the current case even though read/write
// themselves use the contained anqi filesystem provider.
import { existsSync, realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path, { isAbsolute, relative, resolve, sep } from 'node:path';

function contains(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function workspaceDenied(toolName, requestedPath) {
  const error = new Error(
    `${toolName} cannot search "${requestedPath}": outside the anqi case workspace`,
  );
  error.code = 'FS_SANDBOX_DENIED';
  return error;
}

function canonicalDirectory(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`anqi-sandbox: ${label} is required`);
  try { return realpathSync.native(value); } catch (error) {
    throw new Error(`anqi-sandbox: ${label} is unavailable`, { cause: error });
  }
}

function canonicalFile(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`anqi-sandbox: ${label} is required`);
  try { return realpathSync.native(value); } catch (error) {
    throw new Error(`anqi-sandbox: ${label} is unavailable`, { cause: error });
  }
}

function existing(paths) {
  return [...new Set(paths.map((entry) => path.resolve(entry)).filter((entry) => existsSync(entry)))];
}

function minimalRoots(paths) {
  const roots = [...new Set(paths.map((entry) => path.resolve(entry)))].sort((a, b) => a.length - b.length);
  return roots.filter((candidate, index) => !roots.slice(0, index).some((root) => contains(root, candidate)));
}

function sbplString(value) {
  return `"${value.replaceAll('\\\\', String.raw`\\\\`).replaceAll('"', String.raw`\\"`)}"`;
}

function bwrapDirectoryArgs(maskRoot, target) {
  if (!contains(maskRoot, target)) return [];
  const rel = path.relative(maskRoot, target);
  if (!rel) return [];
  const args = [];
  let current = maskRoot;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    args.push('--dir', current);
  }
  return args;
}

function unavailable(mode, detail) {
  const error = new Error(
    `sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; `
    + `refusing to run the command unconfined. ${detail}`
  );
  error.name = 'SandboxUnavailableError';
  error.code = 'SANDBOX_UNAVAILABLE';
  return error;
}

function assertPolicy(policy, filesRoot, databasePath) {
  const workspaceRoot = canonicalDirectory(policy.workspaceRoot, 'workspaceRoot');
  if (!contains(filesRoot, workspaceRoot)) {
    throw unavailable(policy.mode, 'anqi workspace is outside ANJIAN_FILES_ROOT');
  }
  if (contains(workspaceRoot, databasePath)) {
    throw unavailable(policy.mode, 'anqi database overlaps the case workspace');
  }
  return { ...policy, workspaceRoot };
}

function confineBwrap(argv, policy, upstream, filesRoot, databaseRoot, tempRoot) {
  const aliasRoot = '/run/anqi-sandbox';
  const aliasWorkspace = path.join(aliasRoot, 'workspace');
  const maskRoots = minimalRoots(['/tmp', filesRoot, databaseRoot]);
  const profile = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--unshare-pid',
    '--proc', '/proc',
    '--die-with-parent',
    '--dir', aliasRoot,
    '--bind', policy.workspaceRoot, aliasWorkspace,
  ];
  for (const root of maskRoots) profile.push('--tmpfs', root);
  for (const target of [policy.workspaceRoot, tempRoot]) {
    const owner = maskRoots.find((root) => contains(root, target));
    if (owner) profile.push(...bwrapDirectoryArgs(owner, target));
  }
  profile.push(
    '--bind', aliasWorkspace, policy.workspaceRoot,
    '--chdir', policy.workspaceRoot,
    '--',
    ...argv,
  );
  return { ...upstream, argv: ['bwrap', ...profile] };
}

function confineLandlock(argv, policy, upstream, tempRoot) {
  const readOnly = existing([
    '/bin', '/sbin', '/usr', '/usr/local', '/lib', '/lib64', '/etc', '/opt',
    '/dev', '/proc', '/sys', policy.workspaceRoot, tempRoot,
  ]);
  const readWrite = existing(['/dev/null', policy.workspaceRoot, tempRoot]);
  const grants = [
    ...readOnly.flatMap((root) => ['--ro', root]),
    ...readWrite.flatMap((root) => ['--rw', root]),
  ];
  return { ...upstream, argv: [upstream.argv[0], ...grants, '--', ...argv] };
}

function confineSeatbelt(argv, policy, upstream, tempRoot) {
  const readRoots = existing([
    '/System', '/usr', '/bin', '/sbin', '/Library', '/private/etc', '/dev',
    '/opt/homebrew', policy.workspaceRoot, tempRoot,
  ]);
  const writeRoots = existing(['/dev/null', policy.workspaceRoot, tempRoot]);
  const profile = [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(allow process*)',
    '(allow signal)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow network*)',
    `(allow file-read* ${readRoots.map((root) => `(subpath ${sbplString(root)})`).join(' ')})`,
    `(allow file-write* ${writeRoots.map((root) => `(subpath ${sbplString(root)})`).join(' ')})`,
  ].join(' ');
  return { ...upstream, argv: [upstream.argv[0], '-p', profile, '--', ...argv] };
}

export function installConfidentialSandbox(ctx, config) {
  const filesRoot = canonicalDirectory(config.filesRoot, 'filesRoot');
  const databasePath = canonicalFile(config.databasePath, 'databasePath');
  const databaseRoot = canonicalDirectory(path.dirname(databasePath), 'databaseRoot');
  const tempRoot = canonicalDirectory(config.tempRoot, 'tempRoot');
  if (filesRoot === path.parse(filesRoot).root || databaseRoot === path.parse(databaseRoot).root) {
    throw new Error('anqi-sandbox: refusing to treat the filesystem root as a sensitive deployment root');
  }

  const originalConfine = ctx.sandbox.confine.bind(ctx.sandbox);
  const guardedConfine = (argv, rawPolicy) => {
    const policy = assertPolicy(rawPolicy, filesRoot, databasePath);
    const upstream = originalConfine(argv, policy);
    const program = path.basename(upstream.argv[0] || '');
    if (program === 'bwrap') return confineBwrap(argv, policy, upstream, filesRoot, databaseRoot, tempRoot);
    if (program === 'landlock-run') return confineLandlock(argv, policy, upstream, tempRoot);
    if (program === 'sandbox-exec') return confineSeatbelt(argv, policy, upstream, tempRoot);
    throw unavailable(policy.mode, `anqi confidential sandbox has no read-isolating profile for ${program || process.platform}`);
  };
  ctx.sandbox.confine = guardedConfine;
  ctx.effect(() => () => {
    if (ctx.sandbox.confine === guardedConfine) ctx.sandbox.confine = originalConfine;
  });
}


export const inject = ['tools'];

export function apply(ctx, config = {}) {
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'glob' && exec.name !== 'grep') return next();

    const requestedPath = exec.arguments?.path;
    if (requestedPath === undefined) return next();
    if (typeof requestedPath !== 'string' || requestedPath.trim() === '') return next();

    const cwd = exec.agent?.session.header.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw workspaceDenied(exec.name, requestedPath);
    }

    // Both roots must exist for ripgrep to run. Resolving them here also closes
    // the explicit-symlink escape where `case/link` points at another case.
    let canonicalRoot;
    let canonicalTarget;
    try {
      canonicalRoot = await realpath(cwd);
      canonicalTarget = await realpath(resolve(canonicalRoot, requestedPath));
    } catch {
      throw workspaceDenied(exec.name, requestedPath);
    }
    if (!contains(canonicalRoot, canonicalTarget)) {
      throw workspaceDenied(exec.name, requestedPath);
    }

    return next();
  });

  // project 档没有 sandbox service，这个注入保持 pending；full 档下在上游
  // dsh-sandbox-local 就绪后收窄其 confine profile，同时复用本插件既有目录，
  // 不给 assets HMR 额外增加一个递归 watcher 根。
  // 轻量 search-guard 单测只提供 ctx.on() 这一个最小 seam；真实 Cordis Context
  // 始终有 inject()。缺少 inject 的非运行时测试替身只验证 glob/grep，不得因此
  // 伪造 sandbox service 或把拒绝结果 mock 出来。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sandbox'], (scope) => {
      installConfidentialSandbox(scope, config);
    });
  }
}

export default { inject, apply };
