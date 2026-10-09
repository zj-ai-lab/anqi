/**
 * 复议前置建议（不自动改写案件标志）。
 * 依据：行政复议法§23；实施条例§30、§31。
 */

export const PRECONDITION_YES_TRIGGERS = Object.freeze({
  admin_duty_applied: {
    category: '未履行法定职责（复议法§23①(三)→§11）',
    reason:
      '申请履职后行政机关在法定期限内未受理、受理后不予答复或者不履行的，属行政复议法§23①(三)复议前置（实施条例§30①）；明确答复不予受理、明示拒绝履行、不完全履行的不属于（实施条例§30②）。请确认是否设为「是」。',
  },
  admin_penalty_on_spot: {
    category: '当场行政处罚（复议法§23①(一)）',
    reason:
      '对当场作出的行政处罚决定不服的，应当先申请行政复议（行政复议法§23①(一)）。请确认是否设为「是」。',
  },
  admin_natural_resource_decision: {
    category: '自然资源权属决定（复议法§23①(二)）',
    reason:
      '对行政机关作出的侵犯其已经依法取得的自然资源的所有权或者使用权的决定不服的，应当先申请行政复议（行政复议法§23①(二)）。请确认是否设为「是」。',
  },
  admin_gov_info_not_disclosed: {
    category: '政府信息公开不予公开（复议法§23①(四)；实施条例§31）',
    reason:
      '申请政府信息公开，行政机关不予公开的，应当先申请行政复议（行政复议法§23①(四)）。对属于政府信息公开条例§14–16情形而决定全部或部分不予公开的，亦须先复议（实施条例§31）。请确认是否设为「是」。',
  },
});

/** 实施条例§30②：明示拒绝等 → 不属于§23①(三)未履行，建议翻转为否 */
export const PRECONDITION_NO_TRIGGERS = Object.freeze({
  admin_duty_expressly_refused: {
    category: '明示拒绝履行（实施条例§30②）',
    reason:
      '行政机关明示拒绝履行的，不属于行政复议法§23①(三)的「未履行法定职责」情形（实施条例§30②），可不经复议直接起诉。若本案标志现为「是」或「未确定」，建议改为「否」。',
  },
  admin_duty_partially_performed: {
    category: '不完全履行（实施条例§30②）',
    reason:
      '行政机关不完全履行的，不属于行政复议法§23①(三)的「未履行法定职责」情形（实施条例§30②），可不经复议直接起诉。若本案标志现为「是」或「未确定」，建议改为「否」。',
  },
  admin_expressly_not_accepted: {
    category: '明确答复不予受理（实施条例§30②）',
    reason:
      '行政机关明确答复不予受理的，不属于行政复议法§23①(三)的「未履行法定职责」情形（实施条例§30②），可不经复议直接起诉。若本案标志现为「是」或「未确定」，建议改为「否」。',
  },
});

export const PRECONDITION_SUGGESTION_REASON = PRECONDITION_YES_TRIGGERS.admin_duty_applied.reason;

/**
 * @returns {{ suggest: 'yes'|'no', reason: string, category: string, source_event_type: string } | null}
 */
export function suggestPrecondition(eventType, caseRow) {
  const isAdmin =
    String(caseRow?.procedure || '').startsWith('行政') || caseRow?.case_type === '行政';
  if (!isAdmin) return null;
  const flag = caseRow?.reconsideration_precondition || 'unknown';

  const yes = PRECONDITION_YES_TRIGGERS[eventType];
  if (yes && flag === 'unknown') {
    return {
      suggest: 'yes',
      reason: yes.reason,
      category: yes.category,
      source_event_type: eventType,
    };
  }

  const no = PRECONDITION_NO_TRIGGERS[eventType];
  if (no && (flag === 'yes' || flag === 'unknown')) {
    return {
      suggest: 'no',
      reason: no.reason,
      category: no.category,
      source_event_type: eventType,
    };
  }
  return null;
}
