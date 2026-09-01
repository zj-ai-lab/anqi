# BLOCKED（待裁决清单）

## 悬而未决

### AI 助理斜杠命令（2026-09-01）

无。

## 已裁决 / 已销案

### ~~T2-Visible-Fallback-Notice — 文件页可见提示需要修改明确禁区（2026-08-26）~~（已销案：2026-08-26 工作会话 8 特批落地）

- 原阻塞：`src/routes/files.js` 与 `public/js/case.js` 均不在上一轮白名单内，后端 `fallbackNotice` 无法送到文件页显示。
- 销案依据：本轮任务书特批恰好这两处最小范围。`files.js` 只在 `GET /cases/:id/files` 响应加只读 `workspace_notice` 透传（回落时逐字带出、正常/双失案省略），`case.js` 在文件列表上方用 `textContent` + 三皮肤既有类渲染、为空即移除；回归 `tools/test-files-workspace-notice-http.js` + `tools/test-case-workspace-notice.js`（check 第 57/58 步）与隔离实例浏览器取证均已通过。详见 `PROGRESS.md` 工作会话 8。
