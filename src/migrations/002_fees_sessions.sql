-- 002: 律师费款项管理 + 账号密码登录会话

-- 律师费按付款节点管理（house 规则：付款挂程序节点不挂结果）
CREATE TABLE fee_items (
  id         INTEGER PRIMARY KEY,
  case_id    INTEGER NOT NULL REFERENCES cases(id),
  label      TEXT NOT NULL,                  -- 签约款/受理款/结案款…
  amount     REAL,                           -- 元；NULL=金额待定（择一条款，明确后回填）
  node       TEXT NOT NULL DEFAULT '',       -- 挂的程序节点（合同原文表述）
  due_on     TEXT NOT NULL DEFAULT '',       -- 节点日期明确时填；空=节点未到
  status     TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid','waived')),
  paid_on    TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX idx_fee_case ON fee_items(case_id);
CREATE INDEX idx_fee_status ON fee_items(status, due_on);

-- 登录会话（30 天滚动）
CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  expires_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
