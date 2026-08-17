-- 009: 案件夹 → LegalRAG 解析 → 案齐人工确认回填
-- 案件夹仍是唯一文件真相源；本 migration 只存同步、revision、提取与裁决状态。

CREATE TABLE legalrag_case_links (
  case_id           INTEGER PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
  legalrag_case_id  TEXT NOT NULL DEFAULT '',
  sync_enabled      INTEGER NOT NULL DEFAULT 1 CHECK (sync_enabled IN (0,1)),
  status            TEXT NOT NULL DEFAULT 'unlinked'
                    CHECK (status IN ('unlinked','linked','error')),
  last_error        TEXT NOT NULL DEFAULT '',
  last_synced_at    TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);

CREATE TABLE legalrag_files (
  id                    INTEGER PRIMARY KEY,
  case_id               INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  rel_path              TEXT NOT NULL,
  filename              TEXT NOT NULL,
  file_size             INTEGER NOT NULL DEFAULT 0,
  mtime_ms              INTEGER NOT NULL DEFAULT 0,
  content_checksum      TEXT NOT NULL DEFAULT '',
  revision              INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  sync_status           TEXT NOT NULL DEFAULT 'observed'
                        CHECK (sync_status IN (
                          'observed','queued','registering','processing','ready',
                          'extracting','review','failed','missing','ignored'
                        )),
  priority              INTEGER NOT NULL DEFAULT 0,
  attempts              INTEGER NOT NULL DEFAULT 0,
  next_attempt_at       TEXT NOT NULL DEFAULT '',
  legalrag_case_id      TEXT NOT NULL DEFAULT '',
  legalrag_document_id  TEXT NOT NULL DEFAULT '',
  legalrag_job_id       TEXT NOT NULL DEFAULT '',
  last_error            TEXT NOT NULL DEFAULT '',
  last_seen_at          TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  missing_since         TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  UNIQUE(case_id, rel_path, revision)
);
CREATE INDEX idx_legalrag_files_path ON legalrag_files(case_id, rel_path, revision DESC);
CREATE INDEX idx_legalrag_files_queue ON legalrag_files(sync_status, priority DESC, next_attempt_at, id);
CREATE INDEX idx_legalrag_files_document ON legalrag_files(legalrag_document_id);

CREATE TABLE legalrag_extractions (
  id              INTEGER PRIMARY KEY,
  file_id         INTEGER NOT NULL REFERENCES legalrag_files(id) ON DELETE CASCADE,
  extractor       TEXT NOT NULL,
  schema_version  INTEGER NOT NULL CHECK (schema_version > 0),
  model           TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'processing'
                  CHECK (status IN ('processing','done','failed')),
  document_type   TEXT NOT NULL DEFAULT '',
  raw_json        TEXT NOT NULL DEFAULT '',
  last_error      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  finished_at     TEXT NOT NULL DEFAULT '',
  UNIQUE(file_id, extractor, schema_version)
);

CREATE TABLE legalrag_candidates (
  id                  INTEGER PRIMARY KEY,
  extraction_id       INTEGER NOT NULL REFERENCES legalrag_extractions(id) ON DELETE CASCADE,
  file_id             INTEGER NOT NULL REFERENCES legalrag_files(id) ON DELETE CASCADE,
  case_id             INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('fee','event')),
  payload             TEXT NOT NULL,
  confidence          REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  source_page         INTEGER CHECK (source_page IS NULL OR source_page > 0),
  source_quote        TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','accepted','declined','superseded')),
  accepted_entity     TEXT NOT NULL DEFAULT '',
  accepted_entity_id  INTEGER,
  decided_at          TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  UNIQUE(extraction_id, kind, payload, source_page, source_quote)
);
CREATE INDEX idx_legalrag_candidates_case ON legalrag_candidates(case_id, status, id DESC);
CREATE INDEX idx_legalrag_candidates_file ON legalrag_candidates(file_id, status);

CREATE TABLE legalrag_bridge_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
