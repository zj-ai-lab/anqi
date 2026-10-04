-- 020：合作对象通讯录 + 案件参与人。
-- people 是跨案件的轻量通讯录；role 只属于某个案件，放在关联表上。
CREATE TABLE people (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
  phone      TEXT NOT NULL DEFAULT '',
  org        TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX idx_people_name ON people(name);
CREATE UNIQUE INDEX idx_people_identity ON people(name COLLATE NOCASE, phone);

CREATE TABLE case_participants (
  id         INTEGER PRIMARY KEY,
  case_id    INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  role       TEXT NOT NULL DEFAULT '合作律师'
             CHECK (role IN ('合作律师','对方律师','其他')),
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  UNIQUE(case_id, person_id)
);
CREATE INDEX idx_case_participants_case ON case_participants(case_id, id);
CREATE INDEX idx_case_participants_person ON case_participants(person_id, case_id);

ALTER TABLE fee_share_agreements
  ADD COLUMN person_id INTEGER REFERENCES people(id);
ALTER TABLE fee_shares
  ADD COLUMN person_id INTEGER REFERENCES people(id);
CREATE INDEX idx_share_agreement_person ON fee_share_agreements(person_id);
CREATE INDEX idx_share_person ON fee_shares(person_id);

-- 存量联系人不丢：已有案件里的合作律师 / 对方律师自动进入通讯录并挂回原案件。
INSERT OR IGNORE INTO people (name, phone, org, note)
SELECT trim(name), COALESCE(trim(phone), ''), MAX(trim(org)), MAX(trim(note))
  FROM contacts
 WHERE role IN ('合作律师', '对方律师') AND length(trim(name)) > 0
 GROUP BY trim(name), COALESCE(trim(phone), '');

INSERT OR IGNORE INTO case_participants (case_id, person_id, role, note)
SELECT c.case_id, p.id, CASE WHEN c.role = '对方律师' THEN '对方律师' ELSE '合作律师' END, trim(c.note)
  FROM contacts c
  JOIN people p ON p.name = trim(c.name) COLLATE NOCASE AND p.phone = COALESCE(trim(c.phone), '')
 WHERE c.role IN ('合作律师', '对方律师') AND length(trim(c.name)) > 0;
