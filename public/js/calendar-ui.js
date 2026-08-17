// 日历任务共用的案件色规则：只返回既有 CSS token，不落新色值。
export function caseColorToken(caseId) {
  const id = Number(caseId);
  if (!Number.isInteger(id) || id <= 0) return '--gray-dot';
  return `--chart-${(id % 6) + 1}`;
}

export function caseColorStyle(caseId) {
  return `--case-color: var(${caseColorToken(caseId)})`;
}
