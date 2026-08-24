// Guard DSH search tools that execute ripgrep directly instead of going through
// ctx.fs. The stock glob/grep implementation accepts an absolute `path`; without
// this wrapper it could search outside the current case even though read/write
// themselves use the contained anqi filesystem provider.
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

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

export const inject = ['tools'];

export function apply(ctx) {
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
}

export default { inject, apply };
