-- 005: 合作律师分成（约定 + 台账）。
-- 方向：payable=应付（我方收案收费，分给合作律师）；receivable=应收（对方案件分我方）。
-- 金额单位=元（REAL，与 fee_items 同口径）；比例计算规则唯一实现在 src/lib/share.js：
--   按「分」向零取整（Math.trunc），不足一分的零头永远留在付款方。
-- 敏感性：counterpart 仅存姓名（与 case_name 同级），电话/证件仍只在 contacts（铁律 9 不变）；
-- 本二表的 CRUD 只出 /api，/internal 面仅 digest 透出 方向+姓名+金额+月份+案件名（无 note 等自由文本）。

CREATE TABLE fee_share_agreements (
  id          INTEGER PRIMARY KEY,
  case_id     INTEGER NOT NULL REFERENCES cases(id),
  direction   TEXT NOT NULL CHECK (direction IN ('payable','receivable')),
  counterpart TEXT NOT NULL,                    -- 合作律师姓名（如「张三」；跨案汇总按此聚合）
  contact_id  INTEGER REFERENCES contacts(id),  -- 可选挂本案联系人（角色=合作律师）
  rate        REAL,                             -- 比例 %（0<rate<=100，最多两位小数）
  flat_amount REAL,                             -- 固定金额（元）
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  CHECK ((rate IS NULL) <> (flat_amount IS NULL))  -- 比例/固定额恰好二选一
);
CREATE INDEX idx_sharagr_case ON fee_share_agreements(case_id);

CREATE TABLE fee_shares (
  id            INTEGER PRIMARY KEY,
  case_id       INTEGER REFERENCES cases(id),   -- 可空：NULL=外部案件（方向 B 典型），届时 external_case 必填（应用层校验，先例：tasks.case_id 可空）
  external_case TEXT NOT NULL DEFAULT '',       -- 外部案件描述（如「李四律师·某借贷案」）
  agreement_id  INTEGER REFERENCES fee_share_agreements(id),
  fee_item_id   INTEGER REFERENCES fee_items(id), -- 方向 A 联动生成时挂来源款项
  direction     TEXT NOT NULL CHECK (direction IN ('payable','receivable')),
  counterpart   TEXT NOT NULL,
  base_amount   REAL,                           -- 计算基数（来源收费额，元）；手录可空
  amount        REAL NOT NULL,                  -- 分成金额（元；负数=退款冲抵，符合 fee_items 负数惯例）
  due_month     TEXT NOT NULL,                  -- 'YYYY-MM'：应完成分成的月份 = 收到律师费当月
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','settled','waived')),
  settled_on    TEXT NOT NULL DEFAULT '',       -- 已分日期（YYYY-MM-DD）
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX idx_share_case   ON fee_shares(case_id);
CREATE INDEX idx_share_status ON fee_shares(status, due_month);
-- 收讫联动去重：同一款项 × 同一约定只生成一次（paid→unpaid→paid 不重复生成）
CREATE UNIQUE INDEX idx_share_dedup ON fee_shares(fee_item_id, agreement_id)
  WHERE fee_item_id IS NOT NULL AND agreement_id IS NOT NULL;
