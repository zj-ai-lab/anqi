// 分成台账更正的纯逻辑（无 DOM、无网络）。案件页、费用页与结算弹层共用同一套判断，
// tools/test-share-correct.js 在 Node 里直接回归这里的函数。
// 口径与后端 src/routes/shares.js 一致：系统结算生成的台账只能追加更正，不能直接改删；
// 手动 / 历史直记可以直接更正金额、月份、状态与备注，也可以删除。

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const YUAN_RE = /^-?\d+(\.\d{1,2})?$/;
const STATUSES = ['pending', 'settled', 'waived'];

export function isEngineShare(share) {
  return share?.settlement_snapshot_id != null
    || share?.assignment_id != null
    || share?.entry_kind === 'calculated'
    || share?.entry_kind === 'adjustment';
}

export function canCorrectManualShare(share) {
  return Boolean(share) && !isEngineShare(share) && !share.is_void;
}

export function shareStatusText(share) {
  const receivable = share.direction === 'receivable';
  if (share.status === 'settled') return receivable ? '已收' : '已分';
  if (share.status === 'waived') return '减免';
  return receivable ? '待收' : '待分';
}

// 把更正弹层的输入折算成 PATCH /shares/:id 的最小请求体：只带真正变化的字段。
// 返回 { body } 或 { error }；body 为空对象表示没有改动。
export function manualShareCorrectionBody(share, values, today) {
  const body = {};

  const amountText = String(values.amount ?? '').trim();
  if (!YUAN_RE.test(amountText) || Number(amountText) === 0) {
    return { error: '分成金额须为不等于 0 的数字，最多两位小数' };
  }
  const amount = Number(amountText);
  if (amount !== Number(share.amount)) body.amount = amount;

  const dueMonth = String(values.due_month ?? '').trim();
  if (!MONTH_RE.test(dueMonth)) return { error: '请选择月份' };
  if (dueMonth !== share.due_month) body.due_month = dueMonth;

  const status = String(values.status ?? share.status);
  if (!STATUSES.includes(status)) return { error: '状态不正确' };
  if (status !== share.status) body.status = status;

  const previousSettledOn = String(share.settled_on || '');
  if (status === 'settled') {
    const settledOn = String(values.settled_on ?? '').trim() || previousSettledOn || today;
    if (!DATE_RE.test(settledOn)) return { error: '请填写正确的日期' };
    if (settledOn !== previousSettledOn) body.settled_on = settledOn;
  } else if (previousSettledOn) {
    // 退回待收 / 待分或改成减免时，旧的结清日期不能留在记录里。
    body.settled_on = '';
  }

  const note = String(values.note ?? '');
  if (note !== String(share.note || '')) body.note = note;

  return { body };
}

function yuanText(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '';
  return (amount < 0 ? '−¥' : '¥') + Math.abs(amount).toLocaleString('en-US');
}

// 结算弹层里，把与本次结算重叠的手动记录翻成一句人话。
export function describeConflictShare(share) {
  const relation = share.direction === 'receivable'
    ? `${share.counterpart}应给我`
    : `我应给${share.counterpart}`;
  return [relation, yuanText(share.amount), shareStatusText(share), share.due_month]
    .filter(Boolean)
    .join(' · ');
}
