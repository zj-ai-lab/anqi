// 案齐 powerful 工具的统一 tools/pre-execute 审批闸门。
//
// Phase 1 建立机制；Phase 2/4 按顺序分别把 web_search、bash 接进来。
// 闸门只产出 DSH 原生
// {kind:'ask', reason}，实际 one-shot 审批、超时与断线 fail-closed 继续由
// dsh-user-approval → dsh-anqi-jsonrpc → supervisor 既有链路负责。

import Schema from '@deepseek-ai/schemastery';

export const Config = Schema.object({
  // 只允许设计稿已经点名、且会分别经过 Phase 2/4 回归的两类 powerful tool。
  // 拼错或未来新增名称必须让 Cordis 配置装载失败，不能静默失去审批。
  askTools: Schema.array(Schema.union(['web_search', 'bash'])).default([]),
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

export function apply(ctx, config = {}) {
  const askTools = new Set(
    Array.isArray(config.askTools)
      ? config.askTools.filter((name) => typeof name === 'string' && name)
      : [],
  );
  ctx.on('tools/pre-execute', (exec, next) => {
    if (!askTools.has(exec?.name)) return next();
    const reason = approvalReasonForExecution(exec);
    if (reason === null) {
      return {
        kind: 'deny',
        reason: `tool "${String(exec?.name || 'unknown')}" approval detail exceeds ${MAX_APPROVAL_REASON_CHARS} characters`,
      };
    }
    return { kind: 'ask', reason };
  });
}
