// 分成计算（确定性纯函数，全系统唯一实现；前端不算钱，LLM 更无写入通道）。
// 规则：金额单位元；比例最多两位小数；按分向零取整，不足一分归付款方。
import { db, audit } from '../db.js';
import { todayCN } from './dates.js';
import { findShareWriteConflict } from './share-overlap.js';
import {
  calculateSettlementFormula,
  fenToYuan,
  parseMoneyToFen,
  parsePercentToBps,
} from './settlement.js';

export function computeShare(baseYuan, ratePct) {
  const { amount_fen: shareFen } = calculateSettlementFormula({
    base_fen: parseMoneyToFen(baseYuan),
    result_kind: 'rate',
    result_basis: 'gross',
    result_rate_bps: parsePercentToBps(ratePct),
    deductions: [],
  });
  return fenToYuan(shareFen);
}

// 1.4 前收讫联动的兼容 helper：方向 A（payable）的比例约定 → 自动登记 pending 分成。
// 新结算不得调用它；正式路径由 settlement service 读取 revision/assignment 后确认入账。
// 触发者是人按「收讫」那一下（同步人工路径），不是任何 LLM 产物。
// INSERT OR IGNORE + 部分唯一索引保证 paid→unpaid→paid 幂等；改回 unpaid 不自动删 share，
// 因为该行可能已经结清，须由人判断。款项金额或约定比例事后改动也不追溯重算既有 share。
export function generateSharesForPaidFee(fee, actor) {
  const baseFen = Number.isSafeInteger(fee.amount_fen)
    ? fee.amount_fen
    : (fee.amount == null ? null : parseMoneyToFen(fee.amount));
  if (baseFen == null) return []; // 金额待定的款项不生成（人工补录）
  const baseYuan = fenToYuan(baseFen);
  const agreements = db.prepare(
    `SELECT * FROM fee_share_agreements
      WHERE case_id = ? AND direction = 'payable' AND status = 'active' AND rate IS NOT NULL`
  ).all(fee.case_id);
  const created = [];
  for (const a of agreements) {
    const existing = db.prepare(
      `SELECT id FROM fee_shares
        WHERE fee_item_id = ? AND agreement_id = ? AND settlement_snapshot_id IS NULL
          AND is_void = 0 AND cancelled_at = '' AND cancelled_by_run_id IS NULL
        ORDER BY id LIMIT 1`
    ).get(fee.id, a.id);
    if (existing) continue;
    const conflict = findShareWriteConflict({
      caseId: fee.case_id,
      feeItemId: fee.id,
      agreementId: a.id,
      direction: 'payable',
      counterpart: a.counterpart,
    });
    if (conflict) {
      const error = new Error('款项已有方案、结算历史或重叠分成，旧收讫联动不得继续生成 legacy 台账');
      error.code = 'fee_share_overlap_conflict';
      error.conflict = conflict;
      throw error;
    }
    const rateBps = parsePercentToBps(a.rate);
    const { amount_fen: amountFen } = calculateSettlementFormula({
      base_fen: baseFen,
      result_kind: 'rate',
      result_basis: 'gross',
      result_rate_bps: rateBps,
      deductions: [],
    });
    const amt = fenToYuan(amountFen);
    const info = db.prepare(
      `INSERT OR IGNORE INTO fee_shares
         (case_id, agreement_id, fee_item_id, direction, counterpart,
          base_amount, base_amount_fen, amount, amount_fen, due_month)
       VALUES (?, ?, ?, 'payable', ?, ?, ?, ?, ?, ?)`
    ).run(
      fee.case_id,
      a.id,
      fee.id,
      a.counterpart,
      baseYuan,
      baseFen,
      amt,
      amountFen,
      (fee.paid_on || '').slice(0, 7) || todayCN().slice(0, 7)
    );
    if (info.changes) {
      audit(actor, 'create', 'share', info.lastInsertRowid, `联动生成 ${a.counterpart} ${amt}`);
      created.push(info.lastInsertRowid);
    }
  }
  return created;
}
