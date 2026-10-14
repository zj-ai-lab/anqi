CREATE TABLE im_bindings (
  provider TEXT PRIMARY KEY CHECK (provider IN ('wecom')),
  userid TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE im_inbound (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('wecom')),
  msgid TEXT NOT NULL,
  received_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('prompted','answered','bound','ignored','unsupported','agent_disabled','busy','cancel','failed')),
  UNIQUE(provider, msgid)
);
CREATE INDEX idx_im_inbound_received ON im_inbound(received_at);
