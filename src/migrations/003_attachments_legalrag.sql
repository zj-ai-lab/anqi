-- 003: 附件引用（指向案件夹相对路径，不存文件本体——案件夹是唯一文件真相源）+ LegalRAG 快捷入口

CREATE TABLE attachments (
  id          INTEGER PRIMARY KEY,
  case_id     INTEGER NOT NULL REFERENCES cases(id),
  entity      TEXT NOT NULL DEFAULT '' ,     -- ''=案件级 | event|deadline|fee|worklog
  entity_id   INTEGER,
  rel_path    TEXT NOT NULL,                 -- 相对案件根，如 法院文书/xx判决书.pdf
  filename    TEXT NOT NULL,
  size        INTEGER,
  source      TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload','link')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX idx_att_case ON attachments(case_id);
CREATE INDEX idx_att_entity ON attachments(entity, entity_id);

ALTER TABLE cases ADD COLUMN legalrag_url TEXT NOT NULL DEFAULT '';
