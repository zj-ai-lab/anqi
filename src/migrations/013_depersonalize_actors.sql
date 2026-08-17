-- 013: 去个人化——把 007 表里残留的个人名 actor 标准化为中性值。
--
-- 背景：007 的三张表在 schema 层 DEFAULT 'fang'（个人自用时期遗留）：
--   fee_share_formula_revisions.created_by
--   fee_share_assignments.decided_by
--   fee_share_settlement_runs.confirmed_by
-- 产品化后运行时 actor 已由应用层传入实际用户名（auth.js 的
-- DEFAULT_ACTOR = env ANJIAN_DEFAULT_ACTOR || 'web'），DEFAULT 不再被命中。
--
-- 🔴 2026-07-31 修正：初版 013 无差别 UPDATE 这三张表，但**三张表在 007 里都挂了写守卫**，
--    在任何有存量数据的库上都会被 ABORT（runMigrations 抛 SQLITE_CONSTRAINT_TRIGGER，
--    后端直接起不来）。空库没有命中行才侥幸通过，见 CHANGES.md §三十。
--    逐表处置如下，原则是**不拆 007 的守卫**——守卫在的地方，那份 actor 就是历史证据：
--
--    1) fee_share_formula_revisions —— trg_share_formula_revision_only_seal_update
--       只放行「未封存 → 封存」一次性转换，且逐列要求含 created_by 在内的其它字段全部不变。
--       封存的分成修订就是历史证据，改它等于篡改留痕。→ **不清洗，存量 'fang' 保留**。
--
--    2) fee_share_settlement_runs —— trg_share_run_no_update 是**无条件**的：
--       这张表上任何 UPDATE 都 ABORT（配套还有 trg_share_run_no_delete）。
--       007 的原话就是「人工确认的不可变 run」。→ **不清洗，存量 'fang' 保留**。
--
--    3) fee_share_assignments —— trg_share_assignment_versioned_update 不是禁止修改，
--       而是要求按乐观锁契约修改。→ **正常清洗**，见下。
--
-- 所以本 migration 实际只动 assignments 一张表。另两张表的存量 'fang' 是不可变的历史留痕，
-- 按设计保留；新产品化部署不会产生 'fang' 数据（应用层传实际用户名）。
--
-- 纯 UPDATE，零表重建，幂等（已为 'system' 的行不再触碰）。

-- trg_share_assignment_versioned_update 要求：id/case_id/fee_item_id/agreement_id/created_at
-- 保持不变、**version 恰好 +1**、updated_at 非空且与原值不同。这是乐观锁契约，不是需要绕开的
-- 障碍——本次确实改了这一行，那就按它的规矩递增版本、刷新 updated_at。
-- updated_at 用 MAX(now, 旧值+1秒) 而不是裸 now：两者都是 'YYYY-MM-DD HH:MM:SS'，字典序即时序，
-- 这样保证严格大于旧值——否则同一秒内建库又迁移时 now 会等于旧值，触发器照样 ABORT。
UPDATE fee_share_assignments
   SET decided_by = 'system',
       version    = version + 1,
       updated_at = MAX(datetime('now','+8 hours'), datetime(updated_at, '+1 second'))
 WHERE decided_by = 'fang';
