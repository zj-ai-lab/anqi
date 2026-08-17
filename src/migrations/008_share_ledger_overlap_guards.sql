-- 008: 同款分成义务防重与显式历史 closed 承接。
-- 只增加索引/触发器；不自动改写、作废、认领或重算任何既有业务行。
-- migration runner 为每个文件包事务；本文件禁止自带 BEGIN/COMMIT。

CREATE INDEX idx_share_overlap_fee_identity
  ON fee_shares(fee_item_id, direction, counterpart, agreement_id)
  WHERE fee_item_id IS NOT NULL AND is_void = 0 AND cancelled_at = '';
CREATE INDEX idx_share_agreement_active_identity
  ON fee_share_agreements(case_id, direction, counterpart)
  WHERE status = 'active';

-- 同案、同方向、精确合作对象只能有一个 active agreement；公式变化须追加 revision。
CREATE TRIGGER trg_share_agreement_active_identity_insert
BEFORE INSERT ON fee_share_agreements
WHEN NEW.status = 'active' AND EXISTS (
  SELECT 1 FROM fee_share_agreements agreement
   WHERE agreement.case_id = NEW.case_id
     AND agreement.direction = NEW.direction
     AND trim(agreement.counterpart) = trim(NEW.counterpart)
     AND agreement.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'active fee share agreement identity already exists');
END;

CREATE TRIGGER trg_share_agreement_active_identity_update
BEFORE UPDATE OF case_id, direction, counterpart, status ON fee_share_agreements
WHEN NEW.status = 'active' AND EXISTS (
  SELECT 1 FROM fee_share_agreements agreement
   WHERE agreement.id <> OLD.id
     AND agreement.case_id = NEW.case_id
     AND agreement.direction = NEW.direction
     AND trim(agreement.counterpart) = trim(NEW.counterpart)
     AND agreement.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'active fee share agreement identity already exists');
END;

-- legacy/manual 新行不得与同款活动台账、null-agreement 对应的 active agreement，
-- 或显式 agreement 已有的 plan/settlement history 并存。
CREATE TRIGGER trg_share_manual_managed_overlap_insert
BEFORE INSERT ON fee_shares
WHEN NEW.settlement_snapshot_id IS NULL
 AND NEW.entry_kind IN ('legacy', 'manual')
 AND NEW.fee_item_id IS NOT NULL
 AND NEW.is_void = 0 AND NEW.cancelled_at = ''
 AND (
   EXISTS (
     SELECT 1 FROM fee_shares share
      WHERE share.fee_item_id = NEW.fee_item_id
        AND share.is_void = 0 AND share.cancelled_at = ''
        AND share.cancelled_by_run_id IS NULL
        AND (share.settlement_snapshot_id IS NOT NULL
             OR NEW.agreement_id IS NULL OR share.agreement_id IS NULL)
        AND (
          (NEW.agreement_id IS NOT NULL AND share.agreement_id = NEW.agreement_id)
          OR ((NEW.agreement_id IS NULL OR share.agreement_id IS NULL)
              AND share.direction = NEW.direction
              AND trim(share.counterpart) = trim(NEW.counterpart))
        )
   )
   OR (NEW.agreement_id IS NULL AND EXISTS (
     SELECT 1 FROM fee_items fee
     JOIN fee_share_agreements agreement
       ON agreement.case_id = fee.case_id
      AND agreement.direction = NEW.direction
      AND trim(agreement.counterpart) = trim(NEW.counterpart)
      AND agreement.status = 'active'
    WHERE fee.id = NEW.fee_item_id
   ))
   OR (NEW.agreement_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM fee_share_agreements agreement
      WHERE agreement.id = NEW.agreement_id
        AND agreement.case_id = NEW.case_id
        AND agreement.direction = NEW.direction
        AND trim(agreement.counterpart) = trim(NEW.counterpart)
   ))
   OR (NEW.agreement_id IS NOT NULL AND EXISTS (
     SELECT 1 FROM fee_share_assignments assignment
      WHERE assignment.fee_item_id = NEW.fee_item_id
        AND assignment.agreement_id = NEW.agreement_id
   ))
   OR (NEW.agreement_id IS NOT NULL AND EXISTS (
     SELECT 1 FROM fee_share_settlement_snapshots snapshot
      WHERE snapshot.fee_item_id = NEW.fee_item_id
        AND snapshot.agreement_id = NEW.agreement_id
   ))
 )
BEGIN
  SELECT RAISE(ABORT, 'fee share overlaps managed obligation');
END;

-- 普通更新同样受保护。唯一窄例外：受控修复可在 fee/方向/对象不变时，
-- 把既有 null-agreement 行显式挂到 agreement；公共 PATCH 不开放 agreement_id。
CREATE TRIGGER trg_share_manual_managed_overlap_update
BEFORE UPDATE OF fee_item_id, agreement_id, direction, counterpart, is_void, cancelled_at ON fee_shares
WHEN NEW.settlement_snapshot_id IS NULL
 AND NEW.entry_kind IN ('legacy', 'manual')
 AND NEW.fee_item_id IS NOT NULL
 AND NEW.is_void = 0 AND NEW.cancelled_at = ''
 AND NOT (
   OLD.agreement_id IS NULL AND NEW.agreement_id IS NOT NULL
   AND OLD.fee_item_id IS NEW.fee_item_id
   AND OLD.direction = NEW.direction
   AND trim(OLD.counterpart) = trim(NEW.counterpart)
   AND EXISTS (
     SELECT 1 FROM fee_share_agreements agreement
      WHERE agreement.id = NEW.agreement_id
        AND agreement.case_id = NEW.case_id
        AND agreement.direction = NEW.direction
        AND trim(agreement.counterpart) = trim(NEW.counterpart)
   )
 )
 AND (
   EXISTS (
     SELECT 1 FROM fee_shares share
      WHERE share.id <> OLD.id
        AND share.fee_item_id = NEW.fee_item_id
        AND share.is_void = 0 AND share.cancelled_at = ''
        AND share.cancelled_by_run_id IS NULL
        AND (share.settlement_snapshot_id IS NOT NULL
             OR NEW.agreement_id IS NULL OR share.agreement_id IS NULL)
        AND (
          (NEW.agreement_id IS NOT NULL AND share.agreement_id = NEW.agreement_id)
          OR ((NEW.agreement_id IS NULL OR share.agreement_id IS NULL)
              AND share.direction = NEW.direction
              AND trim(share.counterpart) = trim(NEW.counterpart))
        )
   )
   OR (NEW.agreement_id IS NULL AND EXISTS (
     SELECT 1 FROM fee_items fee
     JOIN fee_share_agreements agreement
       ON agreement.case_id = fee.case_id
      AND agreement.direction = NEW.direction
      AND trim(agreement.counterpart) = trim(NEW.counterpart)
      AND agreement.status = 'active'
    WHERE fee.id = NEW.fee_item_id
   ))
   OR (NEW.agreement_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM fee_share_agreements agreement
      WHERE agreement.id = NEW.agreement_id
        AND agreement.case_id = NEW.case_id
        AND agreement.direction = NEW.direction
        AND trim(agreement.counterpart) = trim(NEW.counterpart)
   ))
   OR (NEW.agreement_id IS NOT NULL AND EXISTS (
     SELECT 1 FROM fee_share_assignments assignment
      WHERE assignment.fee_item_id = NEW.fee_item_id
        AND assignment.agreement_id = NEW.agreement_id
   ))
   OR (NEW.agreement_id IS NOT NULL AND EXISTS (
     SELECT 1 FROM fee_share_settlement_snapshots snapshot
      WHERE snapshot.fee_item_id = NEW.fee_item_id
        AND snapshot.agreement_id = NEW.agreement_id
   ))
 )
BEGIN
  SELECT RAISE(ABORT, 'fee share overlaps managed obligation');
END;

-- engine 行插入时复核 legacy/manual：receipt 全部阻断；correction/reversal 只允许
-- 显式同 agreement 且已属于对应 closed 状态的历史/手工行。
CREATE TRIGGER trg_share_engine_legacy_overlap_insert
BEFORE INSERT ON fee_shares
WHEN NEW.settlement_snapshot_id IS NOT NULL AND EXISTS (
  SELECT 1
    FROM fee_shares legacy
    JOIN fee_share_settlement_snapshots snapshot ON snapshot.id = NEW.settlement_snapshot_id
    JOIN fee_share_settlement_runs run ON run.id = snapshot.settlement_run_id
   WHERE legacy.fee_item_id = NEW.fee_item_id
     AND legacy.settlement_snapshot_id IS NULL
     AND legacy.entry_kind IN ('legacy', 'manual')
     AND legacy.is_void = 0 AND legacy.cancelled_at = ''
     AND legacy.cancelled_by_run_id IS NULL
     AND (
       (legacy.agreement_id = NEW.agreement_id)
       OR (legacy.agreement_id IS NULL
           AND legacy.direction = NEW.direction
           AND trim(legacy.counterpart) = trim(NEW.counterpart))
     )
     AND (
       legacy.agreement_id IS NULL
       OR run.run_kind = 'receipt'
       OR (run.run_kind = 'correction' AND legacy.status NOT IN ('settled', 'waived'))
       OR (run.run_kind = 'reversal' AND legacy.status <> 'settled')
     )
)
BEGIN
  SELECT RAISE(ABORT, 'engine share overlaps legacy/manual obligation');
END;

-- 007 时代已经存在的重复 active agreement 原样保留，但不得继续用于新的
-- receipt/correction snapshot 或其 engine 台账；reversal 仍须能按 source snapshot 冲销。
CREATE TRIGGER trg_share_snapshot_active_identity_insert
BEFORE INSERT ON fee_share_settlement_snapshots
WHEN EXISTS (
  SELECT 1
    FROM fee_share_settlement_runs run
    JOIN fee_share_agreements agreement ON agreement.id = NEW.agreement_id
   WHERE run.id = NEW.settlement_run_id
     AND run.run_kind IN ('receipt', 'correction')
     AND agreement.status = 'active'
     AND EXISTS (
       SELECT 1 FROM fee_share_agreements sibling
        WHERE sibling.id <> agreement.id
          AND sibling.case_id = agreement.case_id
          AND sibling.direction = agreement.direction
          AND trim(sibling.counterpart) = trim(agreement.counterpart)
          AND sibling.status = 'active'
     )
)
BEGIN
  SELECT RAISE(ABORT, 'settlement uses duplicate active fee share agreement identity');
END;

CREATE TRIGGER trg_share_engine_active_identity_insert
BEFORE INSERT ON fee_shares
WHEN NEW.settlement_snapshot_id IS NOT NULL AND EXISTS (
  SELECT 1
    FROM fee_share_settlement_snapshots snapshot
    JOIN fee_share_settlement_runs run ON run.id = snapshot.settlement_run_id
    JOIN fee_share_agreements agreement ON agreement.id = NEW.agreement_id
   WHERE snapshot.id = NEW.settlement_snapshot_id
     AND run.run_kind IN ('receipt', 'correction')
     AND agreement.status = 'active'
     AND EXISTS (
       SELECT 1 FROM fee_share_agreements sibling
        WHERE sibling.id <> agreement.id
          AND sibling.case_id = agreement.case_id
          AND sibling.direction = agreement.direction
          AND trim(sibling.counterpart) = trim(agreement.counterpart)
          AND sibling.status = 'active'
     )
)
BEGIN
  SELECT RAISE(ABORT, 'engine share uses duplicate active fee share agreement identity');
END;

-- snapshot 的 closed 同时承接 engine closed 行与显式挂到同 agreement 的 legacy/manual closed 行。
DROP TRIGGER IF EXISTS trg_share_snapshot_closed_amount_insert;
CREATE TRIGGER trg_share_snapshot_closed_amount_insert
BEFORE INSERT ON fee_share_settlement_snapshots
WHEN NEW.closed_amount_fen <> COALESCE((
  SELECT SUM(share.amount_fen)
    FROM fee_shares share
    JOIN fee_share_settlement_runs run ON run.id = NEW.settlement_run_id
   WHERE share.case_id IS NEW.case_id
     AND share.fee_item_id IS NEW.fee_item_id
     AND share.agreement_id IS NEW.agreement_id
     AND (share.settlement_snapshot_id IS NOT NULL OR share.entry_kind IN ('legacy', 'manual'))
     AND share.is_void = 0
     AND share.cancelled_at = ''
     AND share.cancelled_by_run_id IS NULL
     AND (
       (run.run_kind = 'correction' AND share.status IN ('settled', 'waived'))
       OR (run.run_kind = 'reversal' AND share.status = 'settled')
     )
), 0)
BEGIN
  SELECT RAISE(ABORT, 'closed_amount_fen does not match frozen settled/waived ledger state');
END;
