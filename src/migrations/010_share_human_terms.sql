-- 010: 分成管理的人类语义字段。
-- settlement_term 属于稳定约定；暂定状态属于不可变公式版本，随 revision 一并保全。

-- 007 的不可变触发器只认识旧列。迁移内先撤下，补齐/迁移新列后以完整字段集重建；
-- 迁移仍由 runner 的单一事务包住，失败不会留下保护空窗。
DROP TRIGGER trg_share_formula_revision_only_seal_update;

ALTER TABLE fee_share_agreements
  ADD COLUMN settlement_term TEXT NOT NULL DEFAULT '';

ALTER TABLE fee_share_formula_revisions
  ADD COLUMN is_provisional INTEGER NOT NULL DEFAULT 0
    CHECK (is_provisional IN (0, 1));

ALTER TABLE fee_share_formula_revisions
  ADD COLUMN pending_deductions TEXT NOT NULL DEFAULT '';

-- payable 的既有结算语义一直是“收到律师费当月”；receivable 没有统一事实，诚实标为待确定。
UPDATE fee_share_agreements
   SET settlement_term = CASE direction
     WHEN 'payable' THEN '收到律师费当月'
     ELSE '待确定'
   END
 WHERE settlement_term = '';

-- 1.5.1 已允许用文字记录“暂定比例、扣费待定”。只迁移通用语义，
-- 不按案件名或合作人做任何特判，也不改变公式或生成金额台账。
UPDATE fee_share_formula_revisions
   SET is_provisional = 1,
       pending_deductions = CASE
         WHEN EXISTS (
           SELECT 1 FROM fee_share_agreements agreement
            WHERE agreement.id = fee_share_formula_revisions.agreement_id
              AND (agreement.note LIKE '%扣税%' OR agreement.note LIKE '%税费%')
              AND agreement.note LIKE '%律所%'
         ) THEN '税费、律所费用'
         ELSE '前置扣费'
       END
 WHERE result_kind = 'rate'
   AND (
     label LIKE '%暂定%'
     OR change_note LIKE '%暂定%'
     OR (
      revision_no = 1
      AND result_basis = 'gross'
      AND NOT EXISTS (
        SELECT 1 FROM fee_share_formula_deductions deduction
         WHERE deduction.revision_id = fee_share_formula_revisions.id
      )
      AND EXISTS (
        SELECT 1 FROM fee_share_agreements agreement
         WHERE agreement.id = fee_share_formula_revisions.agreement_id
           AND agreement.note LIKE '%扣%'
           AND (agreement.note LIKE '%待确定%' OR agreement.note LIKE '%待定%')
      )
     )
   );

CREATE TRIGGER trg_share_formula_revision_only_seal_update
BEFORE UPDATE ON fee_share_formula_revisions
WHEN NOT (
  OLD.sealed = 0 AND NEW.sealed = 1
  AND NEW.id = OLD.id
  AND NEW.agreement_id = OLD.agreement_id
  AND NEW.case_id = OLD.case_id
  AND NEW.revision_no = OLD.revision_no
  AND NEW.effective_on = OLD.effective_on
  AND NEW.label = OLD.label
  AND NEW.change_note = OLD.change_note
  AND NEW.rounding_mode = OLD.rounding_mode
  AND NEW.result_kind = OLD.result_kind
  AND NEW.result_basis IS OLD.result_basis
  AND NEW.result_rate_bps IS OLD.result_rate_bps
  AND NEW.result_fixed_fen IS OLD.result_fixed_fen
  AND NEW.is_provisional = OLD.is_provisional
  AND NEW.pending_deductions = OLD.pending_deductions
  AND NEW.created_by = OLD.created_by
  AND NEW.created_at = OLD.created_at
  AND OLD.sealed_at = '' AND length(NEW.sealed_at) > 0
  AND OLD.sealed_by = '' AND length(trim(NEW.sealed_by)) > 0
)
BEGIN
  SELECT RAISE(ABORT, 'fee share revisions are immutable except one-way sealing');
END;
