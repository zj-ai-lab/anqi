// 手动 / 历史直记分成的更正与删除（案件页、费用页、结算弹层共用）。
// 系统结算生成的分成不走这里：它们只能在对应律师费上「修改这笔结算」或「撤销这次收款」。
import { api, el, toast, todayStr } from './api.js';
import { datePrompt } from './dateedit.js';
import { canCorrectManualShare, manualShareCorrectionBody } from './share-correct.js';

export async function correctManualShare(share, { onChanged = null } = {}) {
  const receivable = share.direction === 'receivable';
  const values = await datePrompt({
    title: `更正与「${share.counterpart}」的这笔分成`,
    hint: '这是手动记的分成，可以直接改。合作对象或方向记错了，请删除后重新记录。',
    fields: [
      {
        key: 'amount', type: 'number', step: '0.01', inputmode: 'decimal', required: true,
        label: receivable ? '我应收的分成（元）' : '我应付的分成（元）', value: share.amount,
      },
      {
        key: 'due_month', type: 'month', required: true,
        label: receivable ? '应收月份' : '应分月份', value: share.due_month,
      },
      {
        key: 'status', type: 'select', label: '状态', value: share.status,
        options: [
          { value: 'pending', label: receivable ? '待收' : '待分' },
          { value: 'settled', label: receivable ? '已收' : '已分' },
          { value: 'waived', label: '减免' },
        ],
      },
      {
        key: 'settled_on', value: share.settled_on || '',
        label: receivable ? '收款日期（仅「已收」时填）' : '分成日期（仅「已分」时填）',
      },
      { key: 'note', type: 'text', label: '备注', value: share.note || '' },
    ],
  });
  if (!values) return false;
  const result = manualShareCorrectionBody(share, values, todayStr());
  if (result.error) {
    toast('❌ ' + result.error);
    return false;
  }
  if (!Object.keys(result.body).length) {
    toast('没有改动');
    return false;
  }
  await api(`/shares/${share.id}`, { method: 'PATCH', body: result.body });
  toast('分成记录已更正 ✓');
  await onChanged?.();
  return true;
}

export async function deleteManualShare(share, { onChanged = null } = {}) {
  const closed = share.status !== 'pending';
  const question = closed
    ? `这笔分成已经结清或减免。删除后它会从台账和统计里消失，确定删除与「${share.counterpart}」的这笔分成？`
    : `删除与「${share.counterpart}」的这笔分成？`;
  if (!confirm(question)) return false;
  await api(`/shares/${share.id}`, { method: 'DELETE' });
  toast('分成记录已删除');
  await onChanged?.();
  return true;
}

// 手动记录的行内按钮：更正始终可用；删除由调用方决定是否放在当前页面。
export function manualShareButtons(share, { onChanged = null, allowDelete = true } = {}) {
  if (!canCorrectManualShare(share)) return [];
  const buttons = [el('button', {
    class: 'btn small', type: 'button',
    onclick: () => correctManualShare(share, { onChanged }),
  }, '更正')];
  if (allowDelete) {
    buttons.push(el('button', {
      class: 'btn small danger', type: 'button',
      onclick: () => deleteManualShare(share, { onChanged }),
    }, '删'));
  }
  return buttons;
}
