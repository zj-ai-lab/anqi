# 致谢与第三方材料

案齐建立在自由软件生态和开放字体之上。以下清单用于说明主要直接依赖与项目素材来源；完整的传递依赖及其版本以 `package-lock.json` 和发行物内文件为准。

## 主要软件

| 项目 | 用途 | 许可证 |
|---|---|---|
| [Node.js](https://nodejs.org/) | 服务端 JavaScript 运行时 | MIT，另含第三方许可证 |
| [Express](https://expressjs.com/) | HTTP 路由与中间件 | MIT |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | SQLite 绑定 | MIT |
| [Electron](https://www.electronjs.org/) | macOS 桌面壳 | MIT，另含 Chromium 等第三方许可证 |
| [electron-builder](https://www.electron.build/) | 桌面发行物构建 | MIT |
| [electron-updater](https://www.electron.build/auto-update.html) | 桌面版本检查 | MIT |
| [@electron/rebuild](https://github.com/electron/rebuild) | 原生模块 ABI 重建 | MIT |
| [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) | 案件 AI 助理的 agent 运行时（进程外 sidecar，`@deepseek-ai/dsh-*` 包族，随发行物分发、不进仓库） | BSD-3-Clause |

安装依赖时还会取得上述项目的传递依赖。它们不因案齐采用 AGPL-3.0-only 而改变各自许可证。

## 字体

网页内置 Google Noto CJK 字体的简体中文切片：

- Noto Sans SC（思源黑体）
- Noto Serif SC（思源宋体）

字体按 [SIL Open Font License 1.1](https://openfontlicense.org/) 授权。完整许可证见 [`LICENSES/OFL-1.1.txt`](LICENSES/OFL-1.1.txt)，字体文件、上游归属与保留名称见 [`LICENSES/FONTS.md`](LICENSES/FONTS.md)。

## 项目图标

案齐图标由项目维护者为本项目定制。仓库随附源图 [`garden-gpt-image-2/image/anjian-icon-source-20260731.png`](garden-gpt-image-2/image/anjian-icon-source-20260731.png)，并在 [`garden-gpt-image-2/prompt/`](garden-gpt-image-2/prompt/) 保留三份生成、圆角与视觉中心构图提示记录。图标用于识别案齐官方项目和发行物。

项目源代码许可证不当然授予项目名称和图标的商标权。派生项目可以在满足许可证与适用法律的前提下说明其来源，但不应使用容易让人误认为官方发行版的名称、图标或呈现方式。

## 法律文本

本项目的 AGPL 许可证文本来自 [Free Software Foundation](https://www.gnu.org/licenses/agpl-3.0.html)。许可证名称和项目名称属于其各自权利人。

## 补充与更正

如果你发现第三方归属、许可证名称或随附文本有遗漏，请开一个不包含实质实现代码的 Issue，并指出具体文件、上游项目和可核验的许可证来源。安全问题请改用 [SECURITY.md](SECURITY.md) 中的私密渠道。
