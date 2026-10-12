-- 031: provenance for worklog entries
ALTER TABLE worklog ADD COLUMN created_by TEXT NOT NULL DEFAULT 'manual'
  CHECK (created_by IN ('manual','ai','import'));
