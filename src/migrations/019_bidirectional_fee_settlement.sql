-- 017: 律师费收款结算同时支持应收与应付分成。
-- 旧版 assignment / receipt snapshot 只允许 payable，导致已记录的 receivable
-- 约定无法在具体律师费收款时被选择。方案仍按款项逐笔决定，避免独立应收被自动误挂。

DROP TRIGGER trg_share_assignment_valid_insert;
DROP TRIGGER trg_share_assignment_valid_update;
DROP TRIGGER trg_share_snapshot_validate_insert;

CREATE TRIGGER trg_share_assignment_valid_insert
BEFORE INSERT ON fee_share_assignments
WHEN NOT EXISTS (
  SELECT 1
    FROM fee_items fee
    JOIN fee_share_agreements agreement
      ON agreement.id = NEW.agreement_id AND agreement.case_id = NEW.case_id
   WHERE fee.id = NEW.fee_item_id AND fee.case_id = NEW.case_id AND fee.status IN ('unpaid', 'paid')
     AND agreement.direction IN ('payable', 'receivable') AND agreement.status = 'active'
)
OR (NEW.status = 'assigned' AND NOT EXISTS (
  SELECT 1 FROM fee_share_formula_revisions revision
   WHERE revision.id = NEW.formula_revision_id
     AND revision.agreement_id = NEW.agreement_id
     AND revision.case_id = NEW.case_id
     AND revision.sealed = 1
))
BEGIN
  SELECT RAISE(ABORT, 'assignment requires local unpaid/paid fee, active share agreement and sealed pinned revision');
END;

CREATE TRIGGER trg_share_assignment_valid_update
BEFORE UPDATE ON fee_share_assignments
WHEN NOT EXISTS (
  SELECT 1
    FROM fee_items fee
    JOIN fee_share_agreements agreement
      ON agreement.id = NEW.agreement_id AND agreement.case_id = NEW.case_id
   WHERE fee.id = NEW.fee_item_id AND fee.case_id = NEW.case_id AND fee.status IN ('unpaid', 'paid')
     AND agreement.direction IN ('payable', 'receivable') AND agreement.status = 'active'
)
OR (NEW.status = 'assigned' AND NOT EXISTS (
  SELECT 1 FROM fee_share_formula_revisions revision
   WHERE revision.id = NEW.formula_revision_id
     AND revision.agreement_id = NEW.agreement_id
     AND revision.case_id = NEW.case_id
     AND revision.sealed = 1
))
BEGIN
  SELECT RAISE(ABORT, 'assignment requires local unpaid/paid fee, active share agreement and sealed pinned revision');
END;

CREATE TRIGGER trg_share_snapshot_validate_insert
BEFORE INSERT ON fee_share_settlement_snapshots
BEGIN
  -- receipt/correction 按确认当下的 assignment 版本与 pinned revision 冻结；
  -- reversal 则必须原样沿用 source snapshot，不能被 assignment 日后的显式改版或 agreement 退役阻断。
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM fee_share_settlement_runs run
      JOIN fee_share_agreements agreement
        ON agreement.id = NEW.agreement_id AND agreement.case_id = NEW.case_id
      JOIN fee_share_formula_revisions revision
        ON revision.id = NEW.formula_revision_id
       AND revision.agreement_id = NEW.agreement_id
       AND revision.case_id = NEW.case_id
       AND revision.sealed = 1
     WHERE run.id = NEW.settlement_run_id
       AND run.case_id = NEW.case_id
       AND run.fee_item_id = NEW.fee_item_id
       AND run.base_amount_fen IS NEW.base_amount_fen
       AND (NEW.base_amount_fen IS NOT NULL OR revision.result_kind = 'fixed')
       AND (
         run.run_kind = 'reversal'
         OR (
           agreement.direction = NEW.direction
           AND agreement.counterpart = NEW.counterpart
           AND EXISTS (
             SELECT 1 FROM fee_share_assignments assignment
              WHERE assignment.id = NEW.assignment_id
                AND assignment.fee_item_id = NEW.fee_item_id
                AND assignment.agreement_id = NEW.agreement_id
                AND assignment.case_id = NEW.case_id
                AND assignment.version = NEW.plan_version
                AND assignment.status = 'assigned'
                AND assignment.formula_revision_id = NEW.formula_revision_id
           )
         )
       )
  ) THEN RAISE(ABORT, 'settlement snapshot facts do not match current assignment/source snapshot, agreement, run or sealed revision') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM fee_share_settlement_runs run
     WHERE run.id = NEW.settlement_run_id AND run.run_kind = 'receipt'
       AND (
         NEW.source_snapshot_id IS NOT NULL
         OR NEW.entry_kind <> 'calculated'
         OR NEW.closed_amount_fen <> 0
         OR NEW.new_amount_fen <> NEW.desired_amount_fen
         OR NEW.due_month <> substr(run.paid_on, 1, 7)
         OR NOT EXISTS (
           SELECT 1
             FROM fee_share_agreements agreement
             JOIN fee_share_assignments assignment ON assignment.id = NEW.assignment_id
            WHERE agreement.id = NEW.agreement_id
              AND agreement.case_id = NEW.case_id
              AND agreement.status = 'active'
              AND agreement.direction = NEW.direction
              AND assignment.revision_choice = NEW.revision_choice
              AND assignment.revision_choice IN ('initial', 'keep_current', 'adopt_latest')
         )
       )
  ) THEN RAISE(ABORT, 'invalid receipt settlement snapshot') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM fee_share_settlement_runs run
     WHERE run.id = NEW.settlement_run_id AND run.run_kind = 'correction'
       AND (
         NEW.entry_kind <> 'adjustment'
         OR NEW.due_month <> substr(run.paid_on, 1, 7)
         OR NOT EXISTS (
           SELECT 1 FROM fee_share_assignments assignment
            WHERE assignment.id = NEW.assignment_id
              AND assignment.revision_choice = NEW.revision_choice
              AND assignment.revision_choice IN ('initial', 'keep_current', 'adopt_latest')
         )
       )
  ) THEN RAISE(ABORT, 'invalid correction settlement snapshot') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM fee_share_settlement_runs run
     WHERE run.id = NEW.settlement_run_id AND run.run_kind = 'reversal'
       AND (
         NEW.source_snapshot_id IS NULL
         OR NEW.entry_kind <> 'adjustment'
         OR NEW.revision_choice <> 'source'
         OR NEW.desired_amount_fen <> 0
         OR NOT EXISTS (
           SELECT 1 FROM fee_share_settlement_snapshots source
            WHERE source.id = NEW.source_snapshot_id
              AND source.case_id = NEW.case_id
              AND source.fee_item_id = NEW.fee_item_id
              AND source.agreement_id = NEW.agreement_id
              AND source.assignment_id = NEW.assignment_id
              AND source.plan_version = NEW.plan_version
              AND source.formula_revision_id = NEW.formula_revision_id
              AND source.formula_json = NEW.formula_json
              AND source.trace_json = NEW.trace_json
              AND source.base_amount_fen IS NEW.base_amount_fen
              AND source.direction = NEW.direction
              AND source.counterpart = NEW.counterpart
              AND source.due_month = NEW.due_month
         )
       )
  ) THEN RAISE(ABORT, 'invalid reversal settlement snapshot') END;
END;
