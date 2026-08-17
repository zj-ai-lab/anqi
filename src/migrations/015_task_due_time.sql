-- 015: 待办截止时刻（仅截止时刻；不引入开始时刻）
--
-- 空串表示全天待办；应用层负责校验 HH:MM 的 00:00–23:59 范围。
-- NOT NULL + 默认空串保证旧任务升级后仍保持“无截止时刻”的语义。

ALTER TABLE tasks ADD COLUMN due_time TEXT NOT NULL DEFAULT '';
