-- 004: 案件联系人（当事人/法院人员等）。
-- 敏感层级最高的表（身份证/电话）：铁律 9 在接口层执行——本表数据只出 /api（人用），
-- 永不进 /internal（LLM 面）响应；audit 亦不落号码明文。

CREATE TABLE contacts (
  id         INTEGER PRIMARY KEY,
  case_id    INTEGER NOT NULL REFERENCES cases(id),
  role       TEXT NOT NULL,                -- 当事人|对方当事人|承办法官|法官助理|书记员|对方律师|其他
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL DEFAULT '',
  id_no      TEXT NOT NULL DEFAULT '',     -- 身份证号（法院人员留空）
  org        TEXT NOT NULL DEFAULT '',     -- 单位/法院庭室
  note       TEXT NOT NULL DEFAULT '',     -- 送达地址/微信/固话分机等
  created_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX idx_contacts_case ON contacts(case_id);
