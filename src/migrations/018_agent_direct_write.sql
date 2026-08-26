-- anjian 018：agent 可直写正式记录；所有 AI 写入可追溯，期限额外经过待核闸。

ALTER TABLE contacts
  ADD COLUMN created_by TEXT NOT NULL DEFAULT 'manual'
  CHECK (created_by IN ('manual','ai','import'));

ALTER TABLE deadlines
  ADD COLUMN review_status TEXT NOT NULL DEFAULT 'confirmed'
  CHECK (review_status IN ('confirmed','pending_review'));

ALTER TABLE deadlines
  ADD COLUMN created_by TEXT NOT NULL DEFAULT 'manual'
  CHECK (created_by IN ('manual','ai','engine','import'));

-- 与 legalrag_candidate_facts 分开：后者是 OCR 候选的跨文件裁决状态，
-- 本表才是用户/agent 可直接录入、可修改、可删除的正式案件事实。
CREATE TABLE facts (
  id           INTEGER PRIMARY KEY,
  case_id      INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  content      TEXT NOT NULL CHECK (length(trim(content)) > 0),
  occurred_on  TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL DEFAULT 'manual'
               CHECK (created_by IN ('manual','ai','import')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX idx_facts_case ON facts(case_id, occurred_on DESC, id DESC);
