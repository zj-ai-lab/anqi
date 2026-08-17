-- 011: L2 推荐反馈闭环 + LegalRAG 跨文档逻辑事实
-- migration runner 为本文件包事务；禁止自带 BEGIN/COMMIT。

-- 推荐身份与模型标题解耦。旧行保持 intent_key/state_fingerprint 为空，
-- 启动时的幂等 backfill 只补可确认的内容键/实体链接；不伪造历史状态指纹。
ALTER TABLE inbox ADD COLUMN intent_key TEXT NOT NULL DEFAULT '';
ALTER TABLE inbox ADD COLUMN content_key TEXT NOT NULL DEFAULT '';
ALTER TABLE inbox ADD COLUMN state_fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE inbox ADD COLUMN state_marker TEXT NOT NULL DEFAULT '{}';
ALTER TABLE inbox ADD COLUMN seen_count INTEGER NOT NULL DEFAULT 1 CHECK (seen_count >= 1);
ALTER TABLE inbox ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT '';
ALTER TABLE inbox ADD COLUMN decision_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE inbox ADD COLUMN accepted_entity TEXT NOT NULL DEFAULT '';
ALTER TABLE inbox ADD COLUMN accepted_entity_id INTEGER;
ALTER TABLE inbox ADD COLUMN supersedes_inbox_id INTEGER REFERENCES inbox(id);
ALTER TABLE inbox ADD COLUMN change_summary TEXT NOT NULL DEFAULT '';

UPDATE inbox SET last_seen_at=created_at WHERE last_seen_at='';
UPDATE inbox
   SET content_key=lower(trim(COALESCE(json_extract(payload,'$.title'),'')))
 WHERE json_valid(payload) AND content_key='';

CREATE INDEX idx_inbox_recommendation_lookup
  ON inbox(source,case_id,kind,intent_key,status,id DESC);
CREATE INDEX idx_inbox_content_decision
  ON inbox(source,case_id,kind,content_key,status,id DESC);
CREATE UNIQUE INDEX uq_inbox_recommendation_state
  ON inbox(source,kind,COALESCE(case_id,0),intent_key,state_fingerprint)
  WHERE intent_key<>'' AND state_fingerprint<>'';

-- 1.6 及更早的推荐没有 intent/state，无法可靠重建其当时语义和案件状态。
-- 单独保存这些历史弃置，避免把“部署时当前状态”伪装成“裁决时状态”。
-- 历史 L2 的稳定契约是每案下一步，因此对 next_action 做保守长期抑制；
-- 其他意图仍可用 content_key 精确命中同一条历史弃置。
CREATE TABLE llm_legacy_suppressions (
  id              INTEGER PRIMARY KEY,
  case_id         INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  source_inbox_id INTEGER NOT NULL UNIQUE REFERENCES inbox(id) ON DELETE CASCADE,
  intent_key      TEXT NOT NULL DEFAULT 'v1:case.next_action',
  content_key     TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX idx_llm_legacy_suppressions_lookup
  ON llm_legacy_suppressions(case_id,intent_key,content_key);

-- fact = 跨文件共享裁决的逻辑事实；candidate = 每份文件/页码/引文的来源证据。
CREATE TABLE legalrag_candidate_facts (
  id                  INTEGER PRIMARY KEY,
  case_id             INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('fee','event')),
  fact_key            TEXT NOT NULL,
  canonical_payload   TEXT NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','accepted','declined')),
  accepted_entity     TEXT NOT NULL DEFAULT '',
  accepted_entity_id  INTEGER,
  decision_reason     TEXT NOT NULL DEFAULT '',
  decided_at          TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  UNIQUE(case_id,kind,fact_key)
);
CREATE INDEX idx_legalrag_candidate_facts_case
  ON legalrag_candidate_facts(case_id,status,id DESC);

ALTER TABLE legalrag_candidates
  ADD COLUMN fact_id INTEGER REFERENCES legalrag_candidate_facts(id) ON DELETE SET NULL;
CREATE INDEX idx_legalrag_candidates_fact
  ON legalrag_candidates(fact_id,status,id);
