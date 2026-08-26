// 案齐 powerful 工具的统一 tools/pre-execute 审批闸门。
//
// Phase 1 建立机制；Phase 2/4 按顺序分别把 web_search、bash 接进来。
// 闸门只产出 DSH 原生
// {kind:'ask', reason}，实际 one-shot 审批、超时与断线 fail-closed 继续由
// dsh-user-approval → dsh-anqi-jsonrpc → supervisor 既有链路负责。

import Schema from '@deepseek-ai/schemastery';
import path from 'node:path';

export const Config = Schema.object({
  // 只允许设计稿已经点名、且会分别经过 Phase 2/4 回归的两类 powerful tool。
  // 拼错或未来新增名称必须让 Cordis 配置装载失败，不能静默失去审批。
  askTools: Schema.array(Schema.union(['web_search', 'bash'])).default([]),
  // 标准文件工具的案件夹内读写不进审批；只有写目标在 workspaceRoot 外时才
  // 生成 path-only 审批，不把 content/old_string/new_string 送给分类器。
  outsideWriteTools: Schema.array(Schema.union(['write', 'edit', 'str_replace_editor'])).default([]),
  workspaceRoot: Schema.string().default(''),
});

export const MAX_APPROVAL_REASON_CHARS = 16 * 1024;

function jsonDetail(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return '';
  }
}

export function approvalReasonForExecution(exec) {
  const args = exec?.arguments || {};
  let reason;
  if (exec?.name === 'bash') {
    reason = `bash command\n${String(args.command ?? '')}`;
  } else if (exec?.name === 'web_search') {
    const queries = Array.isArray(args.queries) ? args.queries.map((item) => String(item)) : [];
    reason = `web_search query\n${queries.join('\n')}`;
  } else if (['web_fetch', 'fetch', 'url_fetch'].includes(exec?.name)) {
    reason = `${exec.name} URL\n${String(args.url ?? '')}`;
  } else {
    reason = `${String(exec?.name || 'unknown')} arguments\n${jsonDetail(args)}`;
  }
  return reason.length <= MAX_APPROVAL_REASON_CHARS ? reason : null;
}

function containedBy(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function outsideWriteTarget(exec, workspaceRoot) {
  if (exec?.name === 'str_replace_editor' && exec?.arguments?.command === 'view') return null;
  const raw = exec?.name === 'str_replace_editor'
    ? exec?.arguments?.path
    : exec?.arguments?.file_path;
  if (typeof raw !== 'string' || !raw) return null;
  const target = path.resolve(workspaceRoot, raw);
  return containedBy(workspaceRoot, target) ? null : raw;
}

export function apply(ctx, config = {}) {
  const askTools = new Set(
    Array.isArray(config.askTools)
      ? config.askTools.filter((name) => typeof name === 'string' && name)
      : [],
  );
  const outsideWriteTools = new Set(
    Array.isArray(config.outsideWriteTools)
      ? config.outsideWriteTools.filter((name) => typeof name === 'string' && name)
      : [],
  );
  const workspaceRoot = typeof config.workspaceRoot === 'string' && config.workspaceRoot
    ? path.resolve(config.workspaceRoot)
    : '';
  ctx.on('tools/pre-execute', (exec, next) => {
    let reason;
    if (askTools.has(exec?.name)) {
      reason = approvalReasonForExecution(exec);
    } else if (workspaceRoot && outsideWriteTools.has(exec?.name)) {
      const target = outsideWriteTarget(exec, workspaceRoot);
      if (target === null) return next();
      reason = `outside file write target\n${target}`;
    } else {
      return next();
    }
    if (reason === null) {
      return {
        kind: 'deny',
        reason: `tool "${String(exec?.name || 'unknown')}" approval detail exceeds ${MAX_APPROVAL_REASON_CHARS} characters`,
      };
    }
    return { kind: 'ask', reason };
  });
}
