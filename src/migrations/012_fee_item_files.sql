-- 012: 款项凭证指针
-- 文件本体仍以案件夹为唯一真相源；这里只保存款项与相对路径的关联。

CREATE TABLE fee_item_files (
  id          INTEGER PRIMARY KEY,
  fee_item_id INTEGER NOT NULL REFERENCES fee_items(id),
  case_id     INTEGER NOT NULL REFERENCES cases(id),
  rel_path    TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'other'
              CHECK (kind IN ('receipt','invoice','share_sheet','other')),
  size        INTEGER NOT NULL CHECK (size >= 0),
  created_at  TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  UNIQUE(case_id, rel_path)
);

CREATE INDEX idx_fee_item_files_fee ON fee_item_files(fee_item_id, id);
CREATE INDEX idx_fee_item_files_case ON fee_item_files(case_id, id);
