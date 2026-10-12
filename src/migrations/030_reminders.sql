-- 030: deterministic reminder subsystem (derived reminders + channel deliveries)
CREATE TABLE reminders (
  id INTEGER PRIMARY KEY,
  origin TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT '',
  source_id INTEGER,
  tier TEXT NOT NULL DEFAULT '',
  case_id INTEGER REFERENCES cases(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  fire_at TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'scheduled',
  status_reason TEXT NOT NULL DEFAULT '',
  confirmed_at TEXT NOT NULL DEFAULT '',
  fired_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_reminders_auto_key
  ON reminders(source_type, source_id, tier)
  WHERE origin='auto' AND status IN ('scheduled','sending');
CREATE INDEX idx_reminders_due ON reminders(status, fire_at);
CREATE INDEX idx_reminders_case ON reminders(case_id, fire_at);

CREATE TABLE reminder_deliveries (
  id INTEGER PRIMARY KEY,
  reminder_id INTEGER NOT NULL REFERENCES reminders(id),
  reminder_version INTEGER NOT NULL,
  channel TEXT NOT NULL,
  delivery_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  attempted_at TEXT NOT NULL,
  acked_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_deliveries_queue ON reminder_deliveries(channel, status, attempted_at);
