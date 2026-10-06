-- 同步传输状态独立于不可变 change_log；不修改其 UPDATE/DELETE 防护。
CREATE TABLE sync_entities (
  sync_id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  local_id INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  group_key TEXT NOT NULL,
  UNIQUE(entity,local_id)
);
CREATE TABLE sync_baselines (
  sync_id TEXT NOT NULL REFERENCES sync_entities(sync_id),
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY(sync_id,version)
);
CREATE TABLE sync_outbox (
  op_id TEXT PRIMARY KEY,
  sync_id TEXT NOT NULL REFERENCES sync_entities(sync_id),
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','acked','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  acked_at TEXT,
  UNIQUE(sync_id,version)
);
CREATE TABLE sync_inbox (
  op_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  outcome TEXT NOT NULL,
  actor TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY,
  op_id TEXT NOT NULL,
  sync_id TEXT NOT NULL,
  field TEXT NOT NULL,
  base_value TEXT,
  local_value TEXT,
  remote_value TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  resolution TEXT,
  resolved_at TEXT,
  UNIQUE(op_id,field)
);
CREATE INDEX idx_sync_outbox_status ON sync_outbox(status);
CREATE INDEX idx_sync_conflict_status ON sync_conflicts(status);
