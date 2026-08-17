-- 006: 历史合作分成修复队列。
-- 本 migration 只为满足严格条件的既有行建修复单；不得改动 fee_shares 的金额、状态、
-- 来源关系、合作对象或备注，不得自动挂款、合并、删除或重算。
-- migration runner 为每个文件包事务；此文件禁止自带 BEGIN/COMMIT。

-- `voided` 是逻辑作废标记，不扩展 005 的 status CHECK，也不复用 waived。
ALTER TABLE fee_shares ADD COLUMN is_void INTEGER NOT NULL DEFAULT 0 CHECK (is_void IN (0, 1));
ALTER TABLE fee_shares ADD COLUMN voided_at TEXT NOT NULL DEFAULT '';
ALTER TABLE fee_shares ADD COLUMN void_reason TEXT NOT NULL DEFAULT '';

-- 已作废的记录不再占用收讫联动的去重位；下次人工触发收讫时可正常重新生成。
DROP INDEX idx_share_dedup;
CREATE UNIQUE INDEX idx_share_dedup ON fee_shares(fee_item_id, agreement_id)
  WHERE fee_item_id IS NOT NULL AND agreement_id IS NOT NULL AND is_void = 0;

CREATE TABLE share_repair_queue (
  id                   INTEGER PRIMARY KEY,
  fee_share_id         INTEGER NOT NULL UNIQUE REFERENCES fee_shares(id),
  issue_code           TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'claimed', 'retained_unlinked', 'voided_duplicate')),
  proposed_fee_item_id INTEGER REFERENCES fee_items(id),
  resolution_note      TEXT NOT NULL DEFAULT '',
  exception_reason     TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  resolved_at          TEXT NOT NULL DEFAULT '',
  version              INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX idx_share_repair_status ON share_repair_queue(status, created_at);

-- 只快照 migration 执行时已经存在的案件内已结分成。负数退款冲抵同样是台账金额，
-- 不应由 migration 擅自排除；外部案、已有来源/约定/基数、未结行均明确排除。
INSERT OR IGNORE INTO share_repair_queue (fee_share_id, issue_code)
SELECT id, 'legacy_settled_unlinked'
  FROM fee_shares
 WHERE status = 'settled'
   AND case_id IS NOT NULL
   AND fee_item_id IS NULL
   AND agreement_id IS NULL
   AND base_amount IS NULL;
