// 律师费收入口径：纯应收挂款只是他方收取的基数，不是我的律师费收入。
// 同一款同时有应收和应付时，仍按双向结算定义视为我方律师费。
export function isExternalCollectedFee(shares = []) {
  const active = Array.isArray(shares) ? shares.filter(Boolean) : [];
  return active.some((share) => share.direction === 'receivable')
    && !active.some((share) => share.direction === 'payable');
}

// SQL 与 isExternalCollectedFee 保持同一口径：有应收且没有应付的有效分成挂款
// 才排除；void/cancelled 行不再代表当前收款关系。
export function ownFeePredicate(alias = 'f') {
  return `(
    NOT EXISTS (
      SELECT 1 FROM fee_shares external_share
       WHERE external_share.fee_item_id = ${alias}.id
         AND external_share.direction = 'receivable'
         AND external_share.is_void = 0
         AND external_share.cancelled_at = ''
         AND external_share.cancelled_by_run_id IS NULL
    )
    OR EXISTS (
      SELECT 1 FROM fee_shares own_share
       WHERE own_share.fee_item_id = ${alias}.id
         AND own_share.direction = 'payable'
         AND own_share.is_void = 0
         AND own_share.cancelled_at = ''
         AND own_share.cancelled_by_run_id IS NULL
    )
  )`;
}
