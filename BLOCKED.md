# BLOCKED（待裁决清单）

## T2-Visible-Fallback-Notice — 文件页可见提示需要修改明确禁区（2026-08-26）

- `src/lib/secure-files.js` 已在失效 `folder_path` 回落到同名目录时返回 `fallbackNotice`，隔离真实文件 API 也已证明会正确读取同名案卷且不创建错误目录。
- 但 `src/routes/files.js` 的 `GET /cases/:id/files` 手工构造响应并丢弃 context 里的提示字段；`public/js/case.js` 的 `loadFiles()` 才是文件页提示渲染点。两者均不在修改白名单内，其中 `src/routes/files.js` 还被任务书点名为“碰都不许碰”的主线业务路由。
- 因此无法同时满足“文件页给一条提示”和“禁区零修改”。最小待裁决范围是：允许 `src/routes/files.js` 透传一个只读 `workspace_notice` 字段，并允许 `public/js/case.js` 在文件列表上方显示该字段；除此不需要扩大范围。
