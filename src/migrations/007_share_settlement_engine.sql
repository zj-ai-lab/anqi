-- 007: 合作分成结算引擎（稳定约定 → 封存公式版本 → 款项决定 → 结算快照 → 台账）。
-- 只增量承接 005/006；不得重算、补造或改写任何既有分成与修复裁决。
-- migration runner 为每个文件包事务；本文件禁止自带 BEGIN/COMMIT。

-- 005/006 使用 REAL。007 先拒绝不能无损投影为安全整数分/bps 的存量，
-- 避免迁移后同时存在互相矛盾的 REAL 与 canonical integer 两套真相。
CREATE TEMP TABLE migration_007_preflight (
  money_cent_exact INTEGER NOT NULL CONSTRAINT legacy_money_must_be_cent_exact CHECK (money_cent_exact = 1),
  rate_bps_exact   INTEGER NOT NULL CONSTRAINT legacy_rate_must_be_bps_exact CHECK (rate_bps_exact = 1)
);
INSERT INTO migration_007_preflight (money_cent_exact, rate_bps_exact)
SELECT
  CASE WHEN EXISTS (
    SELECT 1
      FROM (
        SELECT amount AS value FROM fee_items WHERE amount IS NOT NULL
        UNION ALL SELECT amount FROM fee_shares WHERE amount IS NOT NULL
        UNION ALL SELECT base_amount FROM fee_shares WHERE base_amount IS NOT NULL
        UNION ALL SELECT flat_amount FROM fee_share_agreements WHERE flat_amount IS NOT NULL
      ) legacy_money
     WHERE typeof(value) NOT IN ('integer', 'real')
        OR ABS(value) > 90071992547409.91
        OR ABS(value * 100.0 - ROUND(value * 100.0)) > 0.000001
  ) THEN 0 ELSE 1 END,
  CASE WHEN EXISTS (
    SELECT 1 FROM fee_share_agreements
     WHERE rate IS NOT NULL
       AND (typeof(rate) NOT IN ('integer', 'real')
         OR rate <= 0 OR rate > 100
         OR ABS(rate * 100.0 - ROUND(rate * 100.0)) > 0.000001)
  ) THEN 0 ELSE 1 END;
DROP TABLE migration_007_preflight;

-- ── 既有收费与稳定约定增加 canonical fen、版本和启停状态 ──
ALTER TABLE fee_items ADD COLUMN amount_fen INTEGER
  CHECK (amount_fen IS NULL OR (
    typeof(amount_fen) = 'integer'
    AND amount_fen BETWEEN -9007199254740991 AND 9007199254740991
  ));
ALTER TABLE fee_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
UPDATE fee_items
   SET amount_fen = CAST(ROUND(amount * 100.0) AS INTEGER)
 WHERE amount IS NOT NULL;

ALTER TABLE fee_share_agreements ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'retired'));
ALTER TABLE fee_share_agreements ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE fee_share_agreements ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE fee_share_agreements SET updated_at = created_at WHERE updated_at = '';

-- 复合外键父键；原 id 主键和 005/006 业务行均不改。
CREATE UNIQUE INDEX idx_fee_items_id_case ON fee_items(id, case_id);
CREATE UNIQUE INDEX idx_share_agreements_id_case ON fee_share_agreements(id, case_id);

-- fee_items.amount_fen 是 canonical 真相。旧入口只写 REAL 时无损派生；显式 fen 要么匹配要么拒绝。
-- REAL 变 NULL 时 canonical fen 必须同步清空。
CREATE TRIGGER trg_fee_item_money_insert_validate
BEFORE INSERT ON fee_items
WHEN NEW.amount IS NOT NULL AND (
  typeof(NEW.amount) NOT IN ('integer', 'real')
  OR ABS(NEW.amount) > 90071992547409.91
  OR ABS(NEW.amount * 100.0 - ROUND(NEW.amount * 100.0)) > 0.000001
  OR (NEW.amount_fen IS NOT NULL
      AND NEW.amount_fen <> CAST(ROUND(NEW.amount * 100.0) AS INTEGER))
)
BEGIN
  SELECT RAISE(ABORT, 'fee amount must be cent-exact, safe and match amount_fen');
END;
CREATE TRIGGER trg_fee_item_money_update_validate
BEFORE UPDATE OF amount, amount_fen ON fee_items
WHEN NEW.amount IS NOT NULL AND (
  typeof(NEW.amount) NOT IN ('integer', 'real')
  OR ABS(NEW.amount) > 90071992547409.91
  OR ABS(NEW.amount * 100.0 - ROUND(NEW.amount * 100.0)) > 0.000001
  OR (
    NEW.amount_fen IS NOT NULL
    AND NOT (NEW.amount IS NOT OLD.amount AND NEW.amount_fen IS OLD.amount_fen)
    AND NEW.amount_fen <> CAST(ROUND(NEW.amount * 100.0) AS INTEGER)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'fee amount must be cent-exact, safe and match amount_fen');
END;
CREATE TRIGGER trg_fee_item_money_insert_project
AFTER INSERT ON fee_items
WHEN NEW.amount IS NULL OR NEW.amount_fen IS NULL
BEGIN
  UPDATE fee_items
     SET amount_fen = CASE
       WHEN NEW.amount IS NULL THEN NULL
       ELSE CAST(ROUND(NEW.amount * 100.0) AS INTEGER)
     END
   WHERE id = NEW.id;
END;
CREATE TRIGGER trg_fee_item_money_update_project
AFTER UPDATE OF amount ON fee_items
BEGIN
  UPDATE fee_items
     SET amount_fen = CASE
       WHEN NEW.amount IS NULL THEN NULL
       WHEN NEW.amount_fen IS NULL OR NEW.amount_fen IS OLD.amount_fen
         THEN CAST(ROUND(NEW.amount * 100.0) AS INTEGER)
       ELSE NEW.amount_fen
     END
   WHERE id = NEW.id;
END;
CREATE TRIGGER trg_fee_item_money_fen_null_repair
AFTER UPDATE OF amount_fen ON fee_items
WHEN NEW.amount IS NOT NULL AND NEW.amount_fen IS NULL
BEGIN
  UPDATE fee_items
     SET amount_fen = CAST(ROUND(NEW.amount * 100.0) AS INTEGER)
   WHERE id = NEW.id;
END;
CREATE TRIGGER trg_fee_item_money_null_clear
AFTER UPDATE OF amount_fen ON fee_items
WHEN NEW.amount IS NULL AND NEW.amount_fen IS NOT NULL
BEGIN
  UPDATE fee_items SET amount_fen = NULL WHERE id = NEW.id;
END;

-- ── 不可变公式版本：revision 先以 sealed=0 插入，扣减就绪后只允许一次 0→1 封存 ──
CREATE TABLE fee_share_formula_revisions (
  id                    INTEGER PRIMARY KEY,
  agreement_id          INTEGER NOT NULL,
  case_id               INTEGER NOT NULL,
  revision_no           INTEGER NOT NULL CHECK (typeof(revision_no) = 'integer' AND revision_no > 0),
  effective_on          TEXT NOT NULL CHECK (length(effective_on) = 10 AND date(effective_on) = effective_on),
  label                 TEXT NOT NULL CHECK (length(trim(label)) > 0),
  change_note           TEXT NOT NULL CHECK (length(trim(change_note)) > 0),
  rounding_mode         TEXT NOT NULL DEFAULT 'toward_zero' CHECK (rounding_mode = 'toward_zero'),
  result_kind           TEXT NOT NULL CHECK (result_kind IN ('rate', 'fixed')),
  result_basis          TEXT CHECK (result_basis IN ('gross', 'remaining')),
  result_rate_bps       INTEGER CHECK (result_rate_bps IS NULL OR (
                          typeof(result_rate_bps) = 'integer'
                          AND result_rate_bps BETWEEN 1 AND 10000
                        )),
  result_fixed_fen      INTEGER CHECK (result_fixed_fen IS NULL OR (
                          typeof(result_fixed_fen) = 'integer'
                          AND result_fixed_fen BETWEEN -9007199254740991 AND 9007199254740991
                        )),
  created_by            TEXT NOT NULL DEFAULT 'fang' CHECK (length(trim(created_by)) > 0),
  created_at            TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  sealed                INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1)),
  sealed_at             TEXT NOT NULL DEFAULT '',
  sealed_by             TEXT NOT NULL DEFAULT '',
  UNIQUE (agreement_id, revision_no),
  UNIQUE (id, agreement_id, case_id),
  FOREIGN KEY (agreement_id, case_id) REFERENCES fee_share_agreements(id, case_id),
  CHECK (
    (result_kind = 'rate' AND result_basis IS NOT NULL
      AND result_rate_bps IS NOT NULL AND result_fixed_fen IS NULL)
    OR
    (result_kind = 'fixed' AND result_basis IS NULL
      AND result_rate_bps IS NULL AND result_fixed_fen IS NOT NULL)
  ),
  CHECK (
    (sealed = 0 AND sealed_at = '' AND sealed_by = '')
    OR
    (sealed = 1 AND length(sealed_at) > 0 AND length(trim(sealed_by)) > 0)
  )
);
CREATE INDEX idx_share_formula_revision_agreement
  ON fee_share_formula_revisions(agreement_id, revision_no DESC);

CREATE TABLE fee_share_formula_deductions (
  id            INTEGER PRIMARY KEY,
  revision_id   INTEGER NOT NULL REFERENCES fee_share_formula_revisions(id),
  sequence      INTEGER NOT NULL CHECK (typeof(sequence) = 'integer' AND sequence > 0),
  label         TEXT NOT NULL CHECK (length(trim(label)) > 0),
  kind          TEXT NOT NULL CHECK (kind IN ('fixed', 'rate')),
  basis         TEXT CHECK (basis IN ('gross', 'remaining')),
  fixed_fen     INTEGER CHECK (fixed_fen IS NULL OR (
                  typeof(fixed_fen) = 'integer'
                  AND fixed_fen BETWEEN 0 AND 9007199254740991
                )),
  rate_bps      INTEGER CHECK (rate_bps IS NULL OR (
                  typeof(rate_bps) = 'integer'
                  AND rate_bps BETWEEN 1 AND 10000
                )),
  UNIQUE (revision_id, sequence),
  CHECK (
    (kind = 'fixed' AND basis IS NULL AND fixed_fen IS NOT NULL AND rate_bps IS NULL)
    OR
    (kind = 'rate' AND basis IS NOT NULL AND rate_bps IS NOT NULL AND fixed_fen IS NULL)
  )
);

CREATE TRIGGER trg_share_formula_revision_unsealed_insert
BEFORE INSERT ON fee_share_formula_revisions
WHEN NEW.sealed <> 0
BEGIN
  SELECT RAISE(ABORT, 'fee share revision must be inserted unsealed');
END;
CREATE TRIGGER trg_share_formula_revision_contiguous_insert
BEFORE INSERT ON fee_share_formula_revisions
WHEN NEW.revision_no <> COALESCE(
  (SELECT MAX(revision_no) + 1 FROM fee_share_formula_revisions WHERE agreement_id = NEW.agreement_id),
  1
)
BEGIN
  SELECT RAISE(ABORT, 'fee share revision_no must be contiguous');
END;

CREATE TRIGGER trg_share_formula_deduction_unsealed_insert
BEFORE INSERT ON fee_share_formula_deductions
WHEN COALESCE((SELECT sealed FROM fee_share_formula_revisions WHERE id = NEW.revision_id), 1) <> 0
BEGIN
  SELECT RAISE(ABORT, 'cannot insert deduction on sealed fee share revision');
END;
CREATE TRIGGER trg_share_formula_deduction_unsealed_update
BEFORE UPDATE ON fee_share_formula_deductions
WHEN COALESCE((SELECT sealed FROM fee_share_formula_revisions WHERE id = OLD.revision_id), 1) <> 0
   OR COALESCE((SELECT sealed FROM fee_share_formula_revisions WHERE id = NEW.revision_id), 1) <> 0
BEGIN
  SELECT RAISE(ABORT, 'cannot update deduction on sealed fee share revision');
END;
CREATE TRIGGER trg_share_formula_deduction_unsealed_delete
BEFORE DELETE ON fee_share_formula_deductions
WHEN COALESCE((SELECT sealed FROM fee_share_formula_revisions WHERE id = OLD.revision_id), 1) <> 0
BEGIN
  SELECT RAISE(ABORT, 'cannot delete deduction on sealed fee share revision');
END;

CREATE TRIGGER trg_share_formula_revision_seal_validate
BEFORE UPDATE OF sealed ON fee_share_formula_revisions
WHEN OLD.sealed = 0 AND NEW.sealed = 1
BEGIN
  SELECT CASE WHEN NEW.result_kind = 'fixed' AND EXISTS (
    SELECT 1 FROM fee_share_formula_deductions WHERE revision_id = OLD.id
  ) THEN RAISE(ABORT, 'fixed terminal revision cannot contain deductions') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM (
        SELECT COUNT(*) AS step_count, MIN(sequence) AS first_sequence, MAX(sequence) AS last_sequence
          FROM fee_share_formula_deductions
         WHERE revision_id = OLD.id
      ) sequence_stats
     WHERE step_count > 0 AND (first_sequence <> 1 OR last_sequence <> step_count)
  ) THEN RAISE(ABORT, 'fee share deduction sequence must be contiguous') END;
END;
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
  AND NEW.created_by = OLD.created_by
  AND NEW.created_at = OLD.created_at
  AND OLD.sealed_at = '' AND length(NEW.sealed_at) > 0
  AND OLD.sealed_by = '' AND length(trim(NEW.sealed_by)) > 0
)
BEGIN
  SELECT RAISE(ABORT, 'fee share revisions are immutable except one-way sealing');
END;
CREATE TRIGGER trg_share_formula_revision_no_delete
BEFORE DELETE ON fee_share_formula_revisions
BEGIN
  SELECT RAISE(ABORT, 'fee share formula revisions are immutable');
END;

-- 每个 005 agreement 恰好回填一个等价、带明确 legacy 元数据且已封存的 revision 1。
-- 不回填 deductions、assignment、run、snapshot 或 share。
INSERT INTO fee_share_formula_revisions
  (agreement_id, case_id, revision_no, effective_on, label, change_note, rounding_mode,
   result_kind, result_basis, result_rate_bps, result_fixed_fen, created_by, created_at)
SELECT id,
       case_id,
       1,
       substr(created_at, 1, 10),
       'Legacy formula (005)',
       'Backfilled from fee_share_agreements without recalculation',
       'toward_zero',
       CASE WHEN rate IS NOT NULL THEN 'rate' ELSE 'fixed' END,
       CASE WHEN rate IS NOT NULL THEN 'gross' ELSE NULL END,
       CASE WHEN rate IS NOT NULL THEN CAST(ROUND(rate * 100.0) AS INTEGER) ELSE NULL END,
       CASE WHEN flat_amount IS NOT NULL THEN CAST(ROUND(flat_amount * 100.0) AS INTEGER) ELSE NULL END,
       'migration-007',
       created_at
  FROM fee_share_agreements;
UPDATE fee_share_formula_revisions
   SET sealed = 1, sealed_at = created_at, sealed_by = 'migration-007'
 WHERE created_by = 'migration-007' AND sealed = 0;

-- ── 款项决定：只允许本地 unpaid/paid fee × active payable agreement ──
CREATE TABLE fee_share_assignments (
  id                   INTEGER PRIMARY KEY,
  case_id              INTEGER NOT NULL,
  fee_item_id          INTEGER NOT NULL,
  agreement_id         INTEGER NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('assigned', 'not_applicable')),
  formula_revision_id  INTEGER REFERENCES fee_share_formula_revisions(id),
  revision_choice      TEXT NOT NULL
                         CHECK (revision_choice IN ('initial', 'keep_current', 'adopt_latest', 'not_applicable')),
  decision_note        TEXT NOT NULL DEFAULT '',
  decided_by           TEXT NOT NULL DEFAULT 'fang' CHECK (length(trim(decided_by)) > 0),
  created_at           TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  version              INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version > 0),
  UNIQUE (fee_item_id, agreement_id),
  UNIQUE (id, fee_item_id, agreement_id, case_id),
  FOREIGN KEY (fee_item_id, case_id) REFERENCES fee_items(id, case_id),
  FOREIGN KEY (agreement_id, case_id) REFERENCES fee_share_agreements(id, case_id),
  CHECK (
    (status = 'assigned' AND formula_revision_id IS NOT NULL
      AND revision_choice IN ('initial', 'keep_current', 'adopt_latest'))
    OR
    (status = 'not_applicable' AND formula_revision_id IS NULL
      AND revision_choice = 'not_applicable')
  )
);
CREATE INDEX idx_share_assignment_fee ON fee_share_assignments(fee_item_id, status);

CREATE TRIGGER trg_share_assignment_valid_insert
BEFORE INSERT ON fee_share_assignments
WHEN NOT EXISTS (
  SELECT 1
    FROM fee_items fee
    JOIN fee_share_agreements agreement
      ON agreement.id = NEW.agreement_id AND agreement.case_id = NEW.case_id
   WHERE fee.id = NEW.fee_item_id AND fee.case_id = NEW.case_id AND fee.status IN ('unpaid', 'paid')
     AND agreement.direction = 'payable' AND agreement.status = 'active'
)
OR (NEW.status = 'assigned' AND NOT EXISTS (
  SELECT 1 FROM fee_share_formula_revisions revision
   WHERE revision.id = NEW.formula_revision_id
     AND revision.agreement_id = NEW.agreement_id
     AND revision.case_id = NEW.case_id
     AND revision.sealed = 1
))
BEGIN
  SELECT RAISE(ABORT, 'assignment requires local unpaid/paid fee, active payable agreement and sealed pinned revision');
END;
CREATE TRIGGER trg_share_assignment_valid_update
BEFORE UPDATE ON fee_share_assignments
WHEN NOT EXISTS (
  SELECT 1
    FROM fee_items fee
    JOIN fee_share_agreements agreement
      ON agreement.id = NEW.agreement_id AND agreement.case_id = NEW.case_id
   WHERE fee.id = NEW.fee_item_id AND fee.case_id = NEW.case_id AND fee.status IN ('unpaid', 'paid')
     AND agreement.direction = 'payable' AND agreement.status = 'active'
)
OR (NEW.status = 'assigned' AND NOT EXISTS (
  SELECT 1 FROM fee_share_formula_revisions revision
   WHERE revision.id = NEW.formula_revision_id
     AND revision.agreement_id = NEW.agreement_id
     AND revision.case_id = NEW.case_id
     AND revision.sealed = 1
))
BEGIN
  SELECT RAISE(ABORT, 'assignment requires local unpaid/paid fee, active payable agreement and sealed pinned revision');
END;
CREATE TRIGGER trg_share_assignment_versioned_update
BEFORE UPDATE ON fee_share_assignments
WHEN NEW.id IS NOT OLD.id
  OR NEW.case_id IS NOT OLD.case_id
  OR NEW.fee_item_id IS NOT OLD.fee_item_id
  OR NEW.agreement_id IS NOT OLD.agreement_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.version <> OLD.version + 1
  OR length(NEW.updated_at) = 0
  OR NEW.updated_at = OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'assignment update must preserve identity and created_at, increment version by one and set updated_at');
END;

-- ── 人工确认的不可变 run 与逐 agreement 结算快照 ──
CREATE TABLE fee_share_settlement_runs (
  id                  INTEGER PRIMARY KEY,
  case_id             INTEGER NOT NULL,
  fee_item_id         INTEGER NOT NULL,
  run_kind            TEXT NOT NULL CHECK (run_kind IN ('receipt', 'correction', 'reversal')),
  source_run_id       INTEGER,
  request_id          TEXT NOT NULL DEFAULT '',
  preview_hash        TEXT NOT NULL CHECK (length(preview_hash) > 0),
  preview_inputs_json TEXT NOT NULL
                        CHECK (json_valid(preview_inputs_json) AND json_type(preview_inputs_json) = 'object'),
  base_amount_fen     INTEGER CHECK (base_amount_fen IS NULL OR (
                        typeof(base_amount_fen) = 'integer'
                        AND base_amount_fen BETWEEN -9007199254740991 AND 9007199254740991
                      )),
  fee_version         INTEGER NOT NULL CHECK (typeof(fee_version) = 'integer' AND fee_version > 0),
  target_status       TEXT NOT NULL CHECK (target_status IN ('unpaid', 'paid')),
  paid_on             TEXT NOT NULL DEFAULT ''
                        CHECK (paid_on = '' OR (length(paid_on) = 10 AND date(paid_on) = paid_on)),
  reason              TEXT NOT NULL DEFAULT '',
  confirmed_by        TEXT NOT NULL DEFAULT 'fang' CHECK (length(trim(confirmed_by)) > 0),
  confirmed_at        TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  UNIQUE (id, case_id, fee_item_id),
  FOREIGN KEY (fee_item_id, case_id) REFERENCES fee_items(id, case_id),
  FOREIGN KEY (source_run_id, case_id, fee_item_id)
    REFERENCES fee_share_settlement_runs(id, case_id, fee_item_id),
  CHECK (
    (run_kind = 'receipt' AND source_run_id IS NULL
      AND target_status = 'paid' AND paid_on <> '')
    OR
    (run_kind = 'correction' AND source_run_id IS NOT NULL
      AND target_status = 'paid' AND paid_on <> '' AND length(trim(reason)) > 0)
    OR
    (run_kind = 'reversal' AND source_run_id IS NOT NULL
      AND target_status = 'unpaid' AND paid_on = '' AND length(trim(reason)) > 0)
  ),
  CHECK (run_kind = 'receipt' OR length(trim(request_id)) > 0)
);
CREATE UNIQUE INDEX idx_share_run_receipt_once
  ON fee_share_settlement_runs(fee_item_id) WHERE run_kind = 'receipt';
CREATE UNIQUE INDEX idx_share_run_request_id
  ON fee_share_settlement_runs(request_id) WHERE request_id <> '';
CREATE UNIQUE INDEX idx_share_run_preview_idempotency
  ON fee_share_settlement_runs(fee_item_id, run_kind, preview_hash);
-- 一条 run 最多一个直接后继；全链因此保持 receipt → correction/reversal → ... 的单线历史。
CREATE UNIQUE INDEX idx_share_run_one_successor
  ON fee_share_settlement_runs(source_run_id) WHERE source_run_id IS NOT NULL;

CREATE TRIGGER trg_share_run_lineage_insert
BEFORE INSERT ON fee_share_settlement_runs
WHEN (NEW.run_kind = 'correction' AND NOT EXISTS (
        SELECT 1 FROM fee_share_settlement_runs source
         WHERE source.id = NEW.source_run_id
           AND source.case_id = NEW.case_id
           AND source.fee_item_id = NEW.fee_item_id
           AND source.run_kind IN ('receipt', 'correction', 'reversal')
      ))
   OR (NEW.run_kind = 'reversal' AND NOT EXISTS (
        SELECT 1 FROM fee_share_settlement_runs source
         WHERE source.id = NEW.source_run_id
           AND source.case_id = NEW.case_id
           AND source.fee_item_id = NEW.fee_item_id
           AND source.run_kind IN ('receipt', 'correction')
           AND source.target_status = 'paid'
      ))
BEGIN
  SELECT RAISE(ABORT, 'invalid correction or reversal source run');
END;
CREATE TRIGGER trg_share_run_no_update
BEFORE UPDATE ON fee_share_settlement_runs
BEGIN
  SELECT RAISE(ABORT, 'fee share settlement runs are immutable');
END;
CREATE TRIGGER trg_share_run_no_delete
BEFORE DELETE ON fee_share_settlement_runs
BEGIN
  SELECT RAISE(ABORT, 'fee share settlement runs are immutable');
END;

CREATE TABLE fee_share_settlement_snapshots (
  id                    INTEGER PRIMARY KEY,
  settlement_run_id     INTEGER NOT NULL,
  case_id               INTEGER NOT NULL,
  fee_item_id           INTEGER NOT NULL,
  agreement_id          INTEGER NOT NULL,
  formula_revision_id   INTEGER NOT NULL,
  assignment_id         INTEGER NOT NULL,
  plan_version          INTEGER NOT NULL CHECK (typeof(plan_version) = 'integer' AND plan_version > 0),
  revision_choice       TEXT NOT NULL
                          CHECK (revision_choice IN ('initial', 'keep_current', 'adopt_latest', 'source')),
  source_snapshot_id    INTEGER,
  direction             TEXT NOT NULL CHECK (direction IN ('payable', 'receivable')),
  counterpart           TEXT NOT NULL CHECK (length(trim(counterpart)) > 0),
  formula_json          TEXT NOT NULL CHECK (json_valid(formula_json) AND json_type(formula_json) = 'object'),
  trace_json            TEXT NOT NULL CHECK (json_valid(trace_json) AND json_type(trace_json) = 'array'),
  base_amount_fen       INTEGER CHECK (base_amount_fen IS NULL OR (
                          typeof(base_amount_fen) = 'integer'
                          AND base_amount_fen BETWEEN -9007199254740991 AND 9007199254740991
                        )),
  desired_amount_fen    INTEGER NOT NULL CHECK (
                          typeof(desired_amount_fen) = 'integer'
                          AND desired_amount_fen BETWEEN -9007199254740991 AND 9007199254740991
                        ),
  closed_amount_fen     INTEGER NOT NULL CHECK (
                          typeof(closed_amount_fen) = 'integer'
                          AND closed_amount_fen BETWEEN -9007199254740991 AND 9007199254740991
                        ),
  new_amount_fen        INTEGER NOT NULL CHECK (
                          typeof(new_amount_fen) = 'integer'
                          AND new_amount_fen BETWEEN -9007199254740991 AND 9007199254740991
                        ),
  entry_kind            TEXT NOT NULL CHECK (entry_kind IN ('calculated', 'adjustment')),
  due_month             TEXT NOT NULL
                          CHECK (due_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
                            AND substr(due_month, 6, 2) BETWEEN '01' AND '12'),
  created_at            TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  UNIQUE (settlement_run_id, agreement_id),
  UNIQUE (id, case_id, fee_item_id, agreement_id),
  FOREIGN KEY (settlement_run_id, case_id, fee_item_id)
    REFERENCES fee_share_settlement_runs(id, case_id, fee_item_id),
  FOREIGN KEY (agreement_id, case_id) REFERENCES fee_share_agreements(id, case_id),
  FOREIGN KEY (formula_revision_id, agreement_id, case_id)
    REFERENCES fee_share_formula_revisions(id, agreement_id, case_id),
  FOREIGN KEY (assignment_id, fee_item_id, agreement_id, case_id)
    REFERENCES fee_share_assignments(id, fee_item_id, agreement_id, case_id),
  FOREIGN KEY (source_snapshot_id, case_id, fee_item_id, agreement_id)
    REFERENCES fee_share_settlement_snapshots(id, case_id, fee_item_id, agreement_id),
  CHECK (new_amount_fen = desired_amount_fen - closed_amount_fen)
);
CREATE INDEX idx_share_snapshot_run ON fee_share_settlement_snapshots(settlement_run_id);
CREATE INDEX idx_share_snapshot_source ON fee_share_settlement_snapshots(source_snapshot_id);

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
         OR NEW.direction <> 'payable'
         OR NEW.due_month <> substr(run.paid_on, 1, 7)
         OR NOT EXISTS (
           SELECT 1
             FROM fee_share_agreements agreement
             JOIN fee_share_assignments assignment ON assignment.id = NEW.assignment_id
            WHERE agreement.id = NEW.agreement_id
              AND agreement.case_id = NEW.case_id
              AND agreement.status = 'active'
              AND agreement.direction = 'payable'
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
CREATE TRIGGER trg_share_snapshot_no_update
BEFORE UPDATE ON fee_share_settlement_snapshots
BEGIN
  SELECT RAISE(ABORT, 'fee share settlement snapshots are immutable');
END;
CREATE TRIGGER trg_share_snapshot_no_delete
BEFORE DELETE ON fee_share_settlement_snapshots
BEGIN
  SELECT RAISE(ABORT, 'fee share settlement snapshots are immutable');
END;

-- ── 已发生台账增加 canonical fen 与不可变结算来源；005/006 业务字段原样保留 ──
ALTER TABLE fee_shares ADD COLUMN amount_fen INTEGER
  CHECK (amount_fen IS NULL OR (
    typeof(amount_fen) = 'integer'
    AND amount_fen BETWEEN -9007199254740991 AND 9007199254740991
  ));
ALTER TABLE fee_shares ADD COLUMN base_amount_fen INTEGER
  CHECK (base_amount_fen IS NULL OR (
    typeof(base_amount_fen) = 'integer'
    AND base_amount_fen BETWEEN -9007199254740991 AND 9007199254740991
  ));
ALTER TABLE fee_shares ADD COLUMN assignment_id INTEGER REFERENCES fee_share_assignments(id);
ALTER TABLE fee_shares ADD COLUMN settlement_snapshot_id INTEGER REFERENCES fee_share_settlement_snapshots(id);
ALTER TABLE fee_shares ADD COLUMN entry_kind TEXT NOT NULL DEFAULT 'manual'
  CHECK (entry_kind IN ('legacy', 'manual', 'calculated', 'adjustment'));
ALTER TABLE fee_shares ADD COLUMN cancelled_at TEXT NOT NULL DEFAULT '';
ALTER TABLE fee_shares ADD COLUMN cancel_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE fee_shares ADD COLUMN cancelled_by_run_id INTEGER REFERENCES fee_share_settlement_runs(id);

UPDATE fee_shares
   SET amount_fen = CAST(ROUND(amount * 100.0) AS INTEGER),
       base_amount_fen = CASE
         WHEN base_amount IS NULL THEN NULL
         ELSE CAST(ROUND(base_amount * 100.0) AS INTEGER)
       END,
       entry_kind = 'legacy';

-- legacy/manual 仍按 fee × agreement 去重；每个 settlement snapshot 最多一条 engine 台账。
DROP INDEX idx_share_dedup;
CREATE UNIQUE INDEX idx_share_dedup ON fee_shares(fee_item_id, agreement_id)
  WHERE fee_item_id IS NOT NULL
    AND agreement_id IS NOT NULL
    AND settlement_snapshot_id IS NULL
    AND is_void = 0;
CREATE UNIQUE INDEX idx_share_snapshot_ledger
  ON fee_shares(settlement_snapshot_id)
  WHERE settlement_snapshot_id IS NOT NULL;
-- 同一款项 × agreement 同时最多一条尚未取消的 pending engine 义务。
CREATE UNIQUE INDEX idx_share_one_current_pending_engine
  ON fee_shares(fee_item_id, agreement_id)
  WHERE settlement_snapshot_id IS NOT NULL
    AND status = 'pending'
    AND cancelled_by_run_id IS NULL;

-- snapshot 的 closed 是插入时冻结的已关闭义务：更正计 settled+waived，冲销只计 settled。
-- pending 永不计入 closed；它必须先由本 run 的 snapshot 建立审计依据，再取消旧行、插入替代行。
CREATE TRIGGER trg_share_snapshot_closed_amount_insert
BEFORE INSERT ON fee_share_settlement_snapshots
WHEN NEW.closed_amount_fen <> COALESCE((
  SELECT SUM(share.amount_fen)
    FROM fee_shares share
    JOIN fee_share_settlement_runs run ON run.id = NEW.settlement_run_id
   WHERE share.case_id IS NEW.case_id
     AND share.fee_item_id IS NEW.fee_item_id
     AND share.agreement_id IS NEW.agreement_id
     AND share.settlement_snapshot_id IS NOT NULL
     AND share.is_void = 0
     AND share.cancelled_by_run_id IS NULL
     AND (
       (run.run_kind = 'correction' AND share.status IN ('settled', 'waived'))
       OR (run.run_kind = 'reversal' AND share.status = 'settled')
     )
), 0)
BEGIN
  SELECT RAISE(ABORT, 'closed_amount_fen does not match frozen settled/waived ledger state');
END;

CREATE TRIGGER trg_share_due_month_insert
BEFORE INSERT ON fee_shares
WHEN NOT (
  NEW.due_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
  AND substr(NEW.due_month, 6, 2) BETWEEN '01' AND '12'
)
BEGIN
  SELECT RAISE(ABORT, 'fee share due_month must be YYYY-MM');
END;
CREATE TRIGGER trg_share_due_month_update
BEFORE UPDATE OF due_month ON fee_shares
WHEN NOT (
  NEW.due_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
  AND substr(NEW.due_month, 6, 2) BETWEEN '01' AND '12'
)
BEGIN
  SELECT RAISE(ABORT, 'fee share due_month must be YYYY-MM');
END;

-- legacy/manual 的 REAL 是既有输入：必须分精确，并在省略 canonical fen 时派生。
-- calculated/adjustment 的 fen 才是真相：REAL 必须精确等于 CAST(fen AS REAL)/100，绝不反推或覆盖 fen。
CREATE TRIGGER trg_share_money_insert_validate
BEFORE INSERT ON fee_shares
WHEN (NEW.entry_kind IN ('legacy', 'manual') AND (
        typeof(NEW.amount) NOT IN ('integer', 'real')
        OR ABS(NEW.amount) > 90071992547409.91
        OR ABS(NEW.amount * 100.0 - ROUND(NEW.amount * 100.0)) > 0.000001
        OR (NEW.amount_fen IS NOT NULL
            AND NEW.amount_fen <> CAST(ROUND(NEW.amount * 100.0) AS INTEGER))
        OR (NEW.base_amount IS NULL AND NEW.base_amount_fen IS NOT NULL)
        OR (NEW.base_amount IS NOT NULL AND (
          typeof(NEW.base_amount) NOT IN ('integer', 'real')
          OR ABS(NEW.base_amount) > 90071992547409.91
          OR ABS(NEW.base_amount * 100.0 - ROUND(NEW.base_amount * 100.0)) > 0.000001
          OR (NEW.base_amount_fen IS NOT NULL
              AND NEW.base_amount_fen <> CAST(ROUND(NEW.base_amount * 100.0) AS INTEGER))
        ))
      ))
   OR (NEW.entry_kind IN ('calculated', 'adjustment') AND (
        typeof(NEW.amount_fen) <> 'integer'
        OR NEW.amount_fen NOT BETWEEN -9007199254740991 AND 9007199254740991
        OR NEW.amount IS NOT CAST(NEW.amount_fen AS REAL) / 100.0
        OR (NEW.base_amount IS NULL AND NEW.base_amount_fen IS NOT NULL)
        OR (NEW.base_amount IS NOT NULL AND (
          typeof(NEW.base_amount_fen) <> 'integer'
          OR NEW.base_amount_fen NOT BETWEEN -9007199254740991 AND 9007199254740991
          OR NEW.base_amount IS NOT CAST(NEW.base_amount_fen AS REAL) / 100.0
        ))
      ))
BEGIN
  SELECT RAISE(ABORT, 'share money must be cent-exact legacy input or deterministic engine fen projection');
END;
CREATE TRIGGER trg_share_money_update_validate
BEFORE UPDATE OF entry_kind, amount, amount_fen, base_amount, base_amount_fen ON fee_shares
WHEN (NEW.entry_kind IN ('legacy', 'manual') AND (
        typeof(NEW.amount) NOT IN ('integer', 'real')
        OR ABS(NEW.amount) > 90071992547409.91
        OR ABS(NEW.amount * 100.0 - ROUND(NEW.amount * 100.0)) > 0.000001
        OR (
          NEW.amount_fen IS NOT NULL
          AND NOT (NEW.amount IS NOT OLD.amount AND NEW.amount_fen IS OLD.amount_fen)
          AND NEW.amount_fen <> CAST(ROUND(NEW.amount * 100.0) AS INTEGER)
        )
        OR (NEW.base_amount IS NULL AND NEW.base_amount_fen IS NOT NULL
            AND NOT (NEW.base_amount IS NOT OLD.base_amount AND NEW.base_amount_fen IS OLD.base_amount_fen))
        OR (NEW.base_amount IS NOT NULL AND (
          typeof(NEW.base_amount) NOT IN ('integer', 'real')
          OR ABS(NEW.base_amount) > 90071992547409.91
          OR ABS(NEW.base_amount * 100.0 - ROUND(NEW.base_amount * 100.0)) > 0.000001
          OR (
            NEW.base_amount_fen IS NOT NULL
            AND NOT (NEW.base_amount IS NOT OLD.base_amount AND NEW.base_amount_fen IS OLD.base_amount_fen)
            AND NEW.base_amount_fen <> CAST(ROUND(NEW.base_amount * 100.0) AS INTEGER)
          )
        ))
      ))
   OR (NEW.entry_kind IN ('calculated', 'adjustment') AND (
        typeof(NEW.amount_fen) <> 'integer'
        OR NEW.amount_fen NOT BETWEEN -9007199254740991 AND 9007199254740991
        OR NEW.amount IS NOT CAST(NEW.amount_fen AS REAL) / 100.0
        OR (NEW.base_amount IS NULL AND NEW.base_amount_fen IS NOT NULL)
        OR (NEW.base_amount IS NOT NULL AND (
          typeof(NEW.base_amount_fen) <> 'integer'
          OR NEW.base_amount_fen NOT BETWEEN -9007199254740991 AND 9007199254740991
          OR NEW.base_amount IS NOT CAST(NEW.base_amount_fen AS REAL) / 100.0
        ))
      ))
BEGIN
  SELECT RAISE(ABORT, 'share money must be cent-exact legacy input or deterministic engine fen projection');
END;
CREATE TRIGGER trg_share_money_insert_project
AFTER INSERT ON fee_shares
WHEN NEW.entry_kind IN ('legacy', 'manual')
BEGIN
  UPDATE fee_shares
     SET amount_fen = CASE
           WHEN NEW.amount_fen IS NULL THEN CAST(ROUND(NEW.amount * 100.0) AS INTEGER)
           ELSE NEW.amount_fen
         END,
         base_amount_fen = CASE
           WHEN NEW.base_amount IS NULL THEN NULL
           WHEN NEW.base_amount_fen IS NULL THEN CAST(ROUND(NEW.base_amount * 100.0) AS INTEGER)
           ELSE NEW.base_amount_fen
         END
   WHERE id = NEW.id;
END;
CREATE TRIGGER trg_share_money_update_project
AFTER UPDATE OF amount, base_amount ON fee_shares
WHEN NEW.entry_kind IN ('legacy', 'manual')
BEGIN
  UPDATE fee_shares
     SET amount_fen = CASE
           WHEN NEW.amount_fen IS NULL OR NEW.amount_fen IS OLD.amount_fen
             THEN CAST(ROUND(NEW.amount * 100.0) AS INTEGER)
           ELSE NEW.amount_fen
         END,
         base_amount_fen = CASE
           WHEN NEW.base_amount IS NULL THEN NULL
           WHEN NEW.base_amount_fen IS NULL OR NEW.base_amount_fen IS OLD.base_amount_fen
             THEN CAST(ROUND(NEW.base_amount * 100.0) AS INTEGER)
           ELSE NEW.base_amount_fen
         END
   WHERE id = NEW.id;
END;
CREATE TRIGGER trg_share_money_amount_fen_null_repair
AFTER UPDATE OF amount_fen ON fee_shares
WHEN NEW.entry_kind IN ('legacy', 'manual') AND NEW.amount_fen IS NULL
BEGIN
  UPDATE fee_shares
     SET amount_fen = CAST(ROUND(NEW.amount * 100.0) AS INTEGER)
   WHERE id = NEW.id;
END;
CREATE TRIGGER trg_share_money_base_fen_null_repair
AFTER UPDATE OF base_amount_fen ON fee_shares
WHEN NEW.entry_kind IN ('legacy', 'manual')
  AND NEW.base_amount IS NOT NULL AND NEW.base_amount_fen IS NULL
BEGIN
  UPDATE fee_shares
     SET base_amount_fen = CAST(ROUND(NEW.base_amount * 100.0) AS INTEGER)
   WHERE id = NEW.id;
END;
CREATE TRIGGER trg_share_money_base_null_clear
AFTER UPDATE OF base_amount_fen ON fee_shares
WHEN NEW.entry_kind IN ('legacy', 'manual')
  AND NEW.base_amount IS NULL AND NEW.base_amount_fen IS NOT NULL
BEGIN
  UPDATE fee_shares SET base_amount_fen = NULL WHERE id = NEW.id;
END;

-- engine 行必须逐字段等于 snapshot/assignment，并与 run kind 对应；旧/人工行不得伪装 engine 来源。
CREATE TRIGGER trg_share_entry_links_insert
BEFORE INSERT ON fee_shares
WHEN (NEW.entry_kind IN ('calculated', 'adjustment')
        AND (NEW.settlement_snapshot_id IS NULL OR NEW.assignment_id IS NULL
             OR NEW.amount_fen IS NULL
             OR (NEW.base_amount IS NOT NULL AND NEW.base_amount_fen IS NULL)))
  OR (NEW.entry_kind IN ('legacy', 'manual')
        AND (NEW.settlement_snapshot_id IS NOT NULL OR NEW.assignment_id IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'fee share entry_kind and settlement source mismatch');
END;
CREATE TRIGGER trg_share_entry_links_update
BEFORE UPDATE OF entry_kind, settlement_snapshot_id, assignment_id ON fee_shares
WHEN (NEW.entry_kind IN ('calculated', 'adjustment')
        AND (NEW.settlement_snapshot_id IS NULL OR NEW.assignment_id IS NULL))
  OR (NEW.entry_kind IN ('legacy', 'manual')
        AND (NEW.settlement_snapshot_id IS NOT NULL OR NEW.assignment_id IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'fee share entry_kind and settlement source mismatch');
END;
CREATE TRIGGER trg_share_snapshot_bind_insert
BEFORE INSERT ON fee_shares
WHEN NEW.settlement_snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM fee_share_settlement_snapshots snapshot
    JOIN fee_share_settlement_runs run ON run.id = snapshot.settlement_run_id
   WHERE snapshot.id = NEW.settlement_snapshot_id
     AND snapshot.case_id IS NEW.case_id
     AND snapshot.fee_item_id IS NEW.fee_item_id
     AND snapshot.agreement_id IS NEW.agreement_id
     AND snapshot.assignment_id IS NEW.assignment_id
     AND snapshot.direction = NEW.direction
     AND snapshot.counterpart = NEW.counterpart
     AND snapshot.base_amount_fen IS NEW.base_amount_fen
     AND snapshot.new_amount_fen IS NEW.amount_fen
     AND snapshot.entry_kind = NEW.entry_kind
     AND snapshot.due_month = NEW.due_month
     AND ((NEW.entry_kind = 'calculated' AND run.run_kind = 'receipt')
       OR (NEW.entry_kind = 'adjustment' AND run.run_kind IN ('correction', 'reversal')))
     AND NEW.external_case = ''
     AND NEW.status = 'pending' AND NEW.settled_on = ''
     AND NEW.is_void = 0 AND NEW.voided_at = '' AND NEW.void_reason = ''
     AND NEW.cancelled_at = '' AND NEW.cancel_reason = '' AND NEW.cancelled_by_run_id IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'fee share ledger facts do not match settlement snapshot or run kind');
END;
-- 旧人工行若被显式挂到 snapshot，也必须经过同一逐字段绑定；日后单改 due_month/note 不重验快照原值。
CREATE TRIGGER trg_share_snapshot_bind_update
BEFORE UPDATE OF case_id, external_case, agreement_id, fee_item_id, direction, counterpart,
                 base_amount, amount, created_at, is_void, voided_at, void_reason,
                 amount_fen, base_amount_fen, assignment_id, settlement_snapshot_id, entry_kind
ON fee_shares
WHEN NEW.settlement_snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM fee_share_settlement_snapshots snapshot
    JOIN fee_share_settlement_runs run ON run.id = snapshot.settlement_run_id
   WHERE snapshot.id = NEW.settlement_snapshot_id
     AND snapshot.case_id IS NEW.case_id
     AND snapshot.fee_item_id IS NEW.fee_item_id
     AND snapshot.agreement_id IS NEW.agreement_id
     AND snapshot.assignment_id IS NEW.assignment_id
     AND snapshot.direction = NEW.direction
     AND snapshot.counterpart = NEW.counterpart
     AND snapshot.base_amount_fen IS NEW.base_amount_fen
     AND snapshot.new_amount_fen IS NEW.amount_fen
     AND snapshot.entry_kind = NEW.entry_kind
     AND ((NEW.entry_kind = 'calculated' AND run.run_kind = 'receipt')
       OR (NEW.entry_kind = 'adjustment' AND run.run_kind IN ('correction', 'reversal')))
     AND NEW.external_case = ''
     AND NEW.is_void = 0 AND NEW.voided_at = '' AND NEW.void_reason = ''
)
BEGIN
  SELECT RAISE(ABORT, 'fee share ledger facts do not match settlement snapshot or run kind');
END;

-- snapshot-linked 行的金额/身份/来源事实不可变；due_month 与 note 是可维护的排程/注记。
CREATE TRIGGER trg_share_snapshot_facts_no_update
BEFORE UPDATE ON fee_shares
WHEN OLD.settlement_snapshot_id IS NOT NULL AND (
  NEW.id IS NOT OLD.id
  OR NEW.case_id IS NOT OLD.case_id
  OR NEW.external_case IS NOT OLD.external_case
  OR NEW.agreement_id IS NOT OLD.agreement_id
  OR NEW.fee_item_id IS NOT OLD.fee_item_id
  OR NEW.direction IS NOT OLD.direction
  OR NEW.counterpart IS NOT OLD.counterpart
  OR NEW.base_amount IS NOT OLD.base_amount
  OR NEW.amount IS NOT OLD.amount
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.is_void IS NOT OLD.is_void
  OR NEW.voided_at IS NOT OLD.voided_at
  OR NEW.void_reason IS NOT OLD.void_reason
  OR NEW.amount_fen IS NOT OLD.amount_fen
  OR NEW.base_amount_fen IS NOT OLD.base_amount_fen
  OR NEW.assignment_id IS NOT OLD.assignment_id
  OR NEW.settlement_snapshot_id IS NOT OLD.settlement_snapshot_id
  OR NEW.entry_kind IS NOT OLD.entry_kind
)
BEGIN
  SELECT RAISE(ABORT, 'snapshot-linked fee share facts are immutable');
END;
CREATE TRIGGER trg_share_snapshot_status_lifecycle
BEFORE UPDATE OF status, settled_on ON fee_shares
WHEN OLD.settlement_snapshot_id IS NOT NULL AND NOT (
  (NEW.status = OLD.status AND NEW.settled_on = OLD.settled_on)
  OR (
    OLD.cancelled_at = '' AND OLD.cancel_reason = '' AND OLD.cancelled_by_run_id IS NULL
    AND OLD.status = 'pending' AND NEW.status = 'settled'
    AND length(NEW.settled_on) = 10 AND date(NEW.settled_on) = NEW.settled_on
  )
  OR (
    OLD.cancelled_at = '' AND OLD.cancel_reason = '' AND OLD.cancelled_by_run_id IS NULL
    AND OLD.status = 'pending' AND NEW.status = 'waived' AND NEW.settled_on = ''
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid snapshot-linked fee share status transition');
END;
CREATE TRIGGER trg_share_snapshot_ledger_no_delete
BEFORE DELETE ON fee_shares
WHEN OLD.settlement_snapshot_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'snapshot-linked fee shares cannot be deleted');
END;

CREATE TRIGGER trg_share_cancel_empty_insert
BEFORE INSERT ON fee_shares
WHEN NEW.cancelled_at <> '' OR NEW.cancel_reason <> '' OR NEW.cancelled_by_run_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'fee share cancellation is a one-way post-insert lifecycle update');
END;
CREATE TRIGGER trg_share_cancel_once_update
BEFORE UPDATE OF cancelled_at, cancel_reason, cancelled_by_run_id ON fee_shares
WHEN NOT (
  (NEW.cancelled_at = OLD.cancelled_at
    AND NEW.cancel_reason = OLD.cancel_reason
    AND NEW.cancelled_by_run_id IS OLD.cancelled_by_run_id)
  OR (
    OLD.settlement_snapshot_id IS NOT NULL
    AND OLD.entry_kind IN ('calculated', 'adjustment')
    AND OLD.status = 'pending' AND NEW.status = 'pending'
    AND OLD.settled_on = '' AND NEW.settled_on = ''
    AND OLD.cancelled_at = '' AND OLD.cancel_reason = '' AND OLD.cancelled_by_run_id IS NULL
    AND length(NEW.cancelled_at) > 0
    AND length(trim(NEW.cancel_reason)) > 0
    AND NEW.cancelled_by_run_id IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM fee_share_settlement_runs cancelling_run
        JOIN fee_share_settlement_snapshots cancelling_snapshot
          ON cancelling_snapshot.settlement_run_id = cancelling_run.id
       WHERE cancelling_run.id = NEW.cancelled_by_run_id
         AND cancelling_run.run_kind IN ('correction', 'reversal')
         AND cancelling_run.case_id IS OLD.case_id
         AND cancelling_run.fee_item_id IS OLD.fee_item_id
         AND cancelling_snapshot.agreement_id IS OLD.agreement_id
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'fee share cancellation requires an uncancelled pending engine row and same-fee correction or reversal');
END;
