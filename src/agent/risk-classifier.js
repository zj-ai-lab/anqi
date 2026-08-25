// Phase 3 风险分类器的宿主侧窄接口。
//
// 本模块刻意不选择模型、凭据、判据或信心阈值：那些必须先与 Hermes 判官
// 对齐。默认实例永远 disabled，且 disabled 时连 action 都不会交给 decide()。
// 将来获裁决后只需注入一个与主会话解耦的 decide(action, { signal }) 实现；
// 无论上游超时、抛错还是返回畸形结构，都统一 fail closed 到人工审批。

export const RISK_CLASSIFIER_DECISIONS = Object.freeze([
  'auto-allow',
  'needs-approval',
  'block',
]);

const DECISIONS = new Set(RISK_CLASSIFIER_DECISIONS);
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_ACTION_REASON_CHARS = 16 * 1024;
const MAX_DECISION_REASON_CHARS = 1_000;

function fallback(reason) {
  return { decision: 'needs-approval', reason };
}

function normalizeAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  const toolName = typeof action.toolName === 'string' ? action.toolName.trim() : '';
  const reason = typeof action.reason === 'string' ? action.reason : '';
  if (!toolName || toolName.length > 128 || reason.length > MAX_ACTION_REASON_CHARS) return null;
  return Object.freeze({ toolName, reason });
}

function normalizeDecision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!DECISIONS.has(value.decision)) return null;
  if (typeof value.reason !== 'string') return null;
  const reason = value.reason.trim();
  if (!reason || reason.length > MAX_DECISION_REASON_CHARS) return null;
  return Object.freeze({ decision: value.decision, reason });
}

export function createRiskClassifier({
  enabled = false,
  decide,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const active = enabled === true;
  const boundedTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.max(1, Math.min(Math.trunc(timeoutMs), 30_000))
    : DEFAULT_TIMEOUT_MS;

  return Object.freeze({
    enabled: active,
    async classify(action) {
      // 默认关闭意味着“零外发”，不是调用模型后再忽略结果。
      if (!active) return fallback('classifier_disabled');
      if (typeof decide !== 'function') return fallback('classifier_unavailable');

      const normalizedAction = normalizeAction(action);
      if (!normalizedAction) return fallback('classifier_invalid_action');

      const controller = new AbortController();
      const timeoutError = new Error('risk classifier timed out');
      timeoutError.code = 'CLASSIFIER_TIMEOUT';
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort(timeoutError);
            reject(timeoutError);
          }, boundedTimeoutMs);
        });
        const raw = await Promise.race([
          Promise.resolve().then(() => decide(normalizedAction, { signal: controller.signal })),
          timeout,
        ]);
        return normalizeDecision(raw) || fallback('classifier_invalid_output');
      } catch (error) {
        return fallback(error?.code === 'CLASSIFIER_TIMEOUT' ? 'classifier_timeout' : 'classifier_error');
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
