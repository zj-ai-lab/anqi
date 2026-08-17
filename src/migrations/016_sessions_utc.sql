-- 016: 登录会话时间统一为 UTC；保留存量 token 与已按 UTC 写入的续期时间。

CREATE TABLE sessions_v16 (
  token      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO sessions_v16 (token, created_at, expires_at, last_seen)
SELECT token,
       datetime(created_at, '-8 hours'),
       expires_at,
       CASE
         -- 002 的初始 created_at/last_seen 同为 UTC+8；运行时续期后的 last_seen 已经是 UTC。
         WHEN last_seen = created_at THEN datetime(last_seen, '-8 hours')
         ELSE last_seen
       END
  FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_v16 RENAME TO sessions;
