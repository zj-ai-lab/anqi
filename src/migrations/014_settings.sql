-- 014: 系统设置键值表（先服务「用户中心 · 个人设置」六个字段）
--
-- 刻意做成 key-value 而不是单行宽表：这些是纯展示型的个人抬头信息（姓名/执业证号/
-- 律所/电话/邮箱/地址），既不进期限引擎也不进任何计算，日后加一项不该再来一次 migration。
-- 写入白名单在应用层（src/routes/settings.js），schema 不做键名约束——键名是产品决定，
-- 不该固化进数据库；白名单外的键在路由层就被丢弃，根本到不了这里。

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
