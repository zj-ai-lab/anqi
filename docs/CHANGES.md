# 案齐 ANQI · 变更史

> 本文件记录公开产品、数据模型与设计决策的演进。当前可运行版本以 `package.json.version` 为唯一事实源；标为「未发布」的条目描述工作树中的下一版准备，不代表已有 tag、Release、镜像或任何实例升级。
>
> 私有部署坐标、生产数据计数、备份路径、CI run 编号和逐机上线记录不属于公开 changelog，已从本文件移除。公开发行流程见 [RELEASING.md](RELEASING.md)。

## 版本速查

| 版本 | 日期 | 要点 |
|---|---|---|
| **2.6.0** | 2026-08-17 | 开源转换与首次公开候选：AGPL-3.0-only、去混淆与归属/治理材料，两批安全加固，Electron 与公开发行 workflow 更新；Android 改为用户配置自托管服务器，补齐产品 README、当前 UI 截图、图标产线和公开边界中性化；期限规则表经作者核准（review=approved） |
| **2.5.0** | 2026-08-14 | LegalRAG 收费候选持久去重闭环：strict typed key 三态匹配、人工 alias、跨来源继承、正式收费编辑/删除边界；无 migration |
| **2.4.0** | 2026-08-11 | 费用页案卡堆、状态色带与粘性抬头收缩；自托管 Noto Sans/Serif SC 可变字体 |
| **2.3.0** | 2026-08-06 | 折叠体系收敛为事实条、账本行、归档门；8 页响应式重构；无 migration |
| **2.2.6** | 2026-08-05 | 案件详情面板栏头横边距修正；纯前端 |
| **2.2.4** | 2026-08-05 | 阶段变化自动生成工作日志；案件款项独立折叠与费用页案件条加宽 |
| **2.2.3** | 2026-08-05 | 全站原生折叠；连续月历、未排期托盘与图例布局对齐 |
| **2.2.2** | 2026-08-05 | 日历拖拽改为单一 Pointer 管线；跨天长条车道化并支持整体平移 |
| **2.2.1** | 2026-08-04 | Electron 应用显式 ad-hoc 深度重签，避开 Electron 出厂 linker 签名共享 CDHash |
| **2.2.0** | 2026-08-04 | 日历待办调度台、未排期托盘、跨天任务和截止时刻；migration 015 |
| **android-v1.1.0** | 2026-08-18 | 首个公开 Android 发行：壳不再内置服务器地址，首启填写并可随时切换自托管实例（公网强制 HTTPS，回环 / RFC1918 / `.local` 允许 HTTP 并明示），深链与导航严格同源比对，切换服务器清除会话；APK 与 `.sha256` 发布到 GitHub Release |
| **android-v1.0.0** | 2026-08-04 | Android WebView 壳独立发行线：深链、上传、带会话下载和返回键行为 |
| **2.1.4** | 2026-08-04 | maskable 图标安全区增大 |
| **2.1.3** | 2026-08-04 | Web App Manifest 与 192/512/maskable 图标 |
| **2.1.2** | 2026-07-31 | Electron 顶栏为 macOS 红绿灯让位；个人设置落库；migration 014 |
| **2.1.1** | 2026-07-31 | 修复 Electron 首次引导；数据目录自动创建专用子目录；图标适配 macOS 网格 |
| **2.1.0** | 2026-07-31 | 对外英文名改为 ANQI，中文名案齐不变；内部兼容标识继续保留 |
| **2.0.3** | 2026-07-31 | 修复 migration 013 与不可变分成写守卫冲突，补带存量数据 fixture |
| **2.0.2** | 2026-07-31 | Electron 后端只监听回环地址；未签名 DMG 更新改为浏览器下载 |
| **2.0.1** | 2026-07-31 | 历史私有发行链修复，无应用行为变化；该发行方式由 2.6.0 公开发行转换取代 |
| **2.0.0** | 2026-07-31 | 历史闭源产品化：中性 actor、DMG JavaScript 混淆与专有 EULA；许可证和混淆策略由 2.6.0 明确取代 |
| **1.9.0** | 2026-07-31 | 今日页待办分为今日 / 本周 / 全部，无日期项进入“未排期” |
| **1.8.1** | 2026-07-29 | 日历返回全状态待办；图例可筛选类型与已处理项 |
| **1.8.0** | 2026-07-29 | 今日、案件、费用三页阅读层级升级；案件夹款项凭证；migration 012 |
| **1.7.5** | 2026-07-21 | 今日跑道改期、案件搜索补全、设置假交互收口、分成月份与动作一致性 |
| **1.7.4** | 2026-07-21 | 待办/日志就地录入、资金区分层、时间线按需渲染、文件常驻拖放区 |
| **1.7.3** | 2026-07-20 | 文书候选按本案归属、原始材料与直接证据 fail-closed；来源精准定位 |
| **1.7.2** | 2026-07-20 | 费用页就地记款、分成前置引导、可逆减免、结算轨迹直达与无障碍修正 |
| **1.7.1** | 2026-07-20 | 案件页快录默认挂本案、跑道改期、状态确认、案件字段自救和人话文案 |
| **1.7.0** | 2026-07-20 | LLM 推荐 intent + 状态指纹闭环；LegalRAG 逻辑事实与多来源证据分层；migration 011 |
| **1.6.1** | 2026-07-20 | 费用总账突出 `已收 − 应付 + 应收` 的全期净额，并补每案净额 |
| **1.6.0** | 2026-07-19 | 分成管理改为律师可读的资金卡与自然语言算式；migration 010 |
| **1.5.1** | 2026-07-18 | 应收/应付分成直达入口；允许先记金额尚未确定的暂定公式 |
| **1.5.0** | 2026-07-17 | 案件夹与 LegalRAG 共享原件桥、checksum/revision、收费/事件候选；migration 009 |
| **1.4.2** | 2026-07-16 | 费用明细按款项事实、收款条件、分成与结算三层阅读 |
| **1.4.1** | 2026-07-16 | 分成台账防重、active agreement 唯一性与事务嵌套保护；migration 008 |
| **1.4.0** | 2026-07-16 | 不可变公式修订、分成计划、后端预览、确认快照、更正/撤销；migration 007 |
| **1.3.1** | 2026-07-15 | 历史孤儿分成人工修复工作台；migration 006 |
| **1.3.0** | 2026-07-15 | 分成挂款、总账净口径、应收不对称进入全局总账 |
| **1.2.0** | 2026-07-15 | 分成约定与台账、收款联动、待分提醒和统计净口径；migration 005 |
| **1.1.0** | 2026-07-13 | 快录 LLM 整理只回填 `task | log` 表单，不写库、不产期限 |
| **1.0.2** | 2026-07-13 | 修复统计页在无到期期限时渲染字面量 `null` |
| **1.0.1** | 2026-07-13 | `/api/stats` 接入真实数据；案件夹文件类型图标 |
| **1.0.0** | 2026-07-13 | UI v5 三皮肤 + 案件夹 SSE 双向同步 + 版本号归一 |
| **0.9.x** | 2026-07-13 | UI v4“翡翠·增强”原型，后由 v5 取代 |
| **0.5.0** | 2026-07-11 | 案件文件桥：案件夹是唯一文件真相源 |
| **0.3.0** | 2026-07-11 | 账号密码登录与 30 天会话；律师费台账 |
| **0.2.0** | 2026-07-11 | 确定性期限引擎与 L0 digest |
| **0.1.0** | 2026-07-11 | P0 电子台账：SQLite、REST、Web UI 与 CLI |

---

## 未发布 — AI 助理 sidecar（分支 `feat/agent-sidecar`，尚未合并 `main`）

**状态：在 worktree 上迭代中，本条目随分支一起进入 `main` 前必须核对是否需要更新——若分支被放弃或大改，本条目也要相应撤除/改写。**

- 新增受信任写面 `POST /internal/agent-proposals`：DSH agent 的 task-only 提案专用入口，与既有 `/internal/inbox`（L2 自动化）分开、不共用去重状态机；event/deadline 一律拒绝，`source`/`case_id` 由服务端固定，`case_id` 只能来自 `session-registry.js` 的 session→case 绑定反查，body 里带的 `case_id` 一律被忽略；`source_ref.session_id` 同样由服务端用反查得到的权威值覆盖，不采信 worker 自报值。落库后复用 `/api/today` 收件卡片渲染。
- 新增 `agent_*` 系统设置键（`agent_enabled`/`agent_provider`/`agent_base_url`/`agent_model`/`agent_api_key_env`，定义在 `src/agent/config.js`）：sidecar **默认关闭**（`agent_enabled` 未显式置 `true` 时不读 credential、不 spawn 子进程、不发模型请求）。这批键现已接入 `/api/settings` 的白名单（`enabled` 须为布尔、`provider` 只认枚举、`model` 非空、`apiKeyEnv` 须为合法环境变量名且不得是 anqi 自身保留名/前缀、`baseURL` 走协议/凭据/内网回环/deepseek-official 官方域校验——与 `loadAgentConfig()` 共用同一份 `validateBaseURL()`/`isReservedEnvName()`，两处不会各自漂移）；`provider`/`baseURL` 联动校验（改 provider 时重新核对已存 `baseURL`），整批校验失败 400、一个键都不落。
- `AgentSupervisor`（`src/agent/supervisor.js`）已接入 `server.js`：新增 `src/routes/agent.js`（工厂函数 `createAgentRouter(supervisor)`）挂 `GET /api/agent/status`、`POST /api/cases/:id/agent/{start,prompt,cancel}`、`GET /api/cases/:id/agent/events`（authenticated SSE，服务端按 case 过滤，不接受任何客户端提交的 session id 做过滤依据）、`POST /api/agent/interactions/:id/answer`（one-shot；interactionId 是唯一入参，case/worker 完全由服务端反查 `findInteractionOwner()`，approval 的受限 outcome / question 的严格逐题答案校验，未知/过期/跨 session/worker 已退一律拒绝并审计，不落敏感值）。`prompt` 路由不等待整轮完成（一次 turn 可能耗时到 `turnTimeoutMs`），只做同步门禁校验后 202 立即返回，真实进度/结果走 SSE。proposal accept/decline 未新增任何模型可达入口，继续复用既有 `/api/inbox/:id/accept|decline`。`server.js` 新增 SIGTERM/SIGINT 优雅退出钩子：调用 `supervisor.stopAll()` 取消所有 turn、终止所有 worker 后再退出，覆盖裸进程终止与 Electron `before-quit` 两条路径。`/api/counts` 新增 `agent` 字段（与 `llm` 字段同一种特性探测模式：`enabled` 且 `apiKeyEnv` 指向的环境变量确有值才为 `true`）。动态门禁验收（真实 DSH 子进程、真实模型 key）留给后续 workflow。
- 修复轮五：SSE 事件订阅（`onEvent()`）此前挂在 Worker 实例上——worker 尚未创建时静默注册空订阅、worker 重建（崩溃/被 stop 后重新 start）后旧订阅被孤儿化，整条 §4 下行通路实际不通；现改为登记在 supervisor 层（`caseId → Set<listener>`），`Worker.emit()` 经 `supervisor._dispatch()` 扇出，与 worker 实例生命周期解耦。`AgentSupervisor` 新增 `setInternalBaseURL()`：`server.js` 在 `httpServer.listen()` 回调里用 `httpServer.address().port` 拿到真实端口去纠正 `internalBaseURL`（此前默认值硬编码 3007，与实际监听端口不符，DSH 子进程回调 anqi MCP 工具全部 ECONNREFUSED）；`electron/main.js` 为每次启动随机生成一份 `ANJIAN_INTERNAL_KEY` 注入后端子进程 env（不持久化），修复桌面版此前必然 `internal_key_missing` 而无法启动 AI 助理的问题。新增 `AgentSupervisor.isLive()`/`publicStatus()`：路由层不再复刻内部 `LIVE_STATUSES` 字面量集合，HTTP/SSE 下行也不再携带内部 `sessionId`/`cwd`/`pid`。`gracefulShutdown()` 给 `stopAll()` 套一个 8s 总时限的 `Promise.race`，跑满即调用新增的 `forceKillAll()` 兜底强杀，避免优雅关闭的 5s 兜底在 stopAll 落定之后才起算、实际不设上限。

## 未发布 — 依赖升级

- Express 4.22 → 5.2：路由全为简单 `:param`，未使用 v5 移除的 API；`tools/check.sh` 全绿，无行为变化。
- better-sqlite3 12.11 → 13.0：上游改用 N-API，预编译产物随包自带（含 darwin arm64/x64、linux glibc/musl），`electron:rebuild` 不再触发本机编译；SQLite 3.53.4。随之 Node 最低版本升为 22（`package.json.engines`），`allowScripts` 同步为 `better-sqlite3@13.0.3`。Dockerfile 改为 `npm install --omit=dev --ignore-scripts`：node:22-slim 自带的 npm 10 不认 v13 的 `"gypfile": false`，会对 `binding.gyp` 触发 node-gyp 编译而 slim 镜像无工具链（docker-release 干跑首次即因此失败，修后 amd64 / arm64 本地构建与冒烟均通过）。已知无害噪音：v13 在 `db.close()` 后事件循环短暂存活，自检第 25 步末尾会打印数条 `legalrag bridge tick … connection is not open`，测试仍通过。
- GitHub Actions 全组升级到 Node 24 运行时（checkout v7、setup-node v7、setup-java v5、upload-artifact v7、download-artifact v8、docker/* v4·v7）；download-artifact v8 起摘要不匹配默认失败。三条发行 workflow 需在下次发版前用 `workflow_dispatch` 干跑一次。

## 2.6.0 — 开源转换与安全基线

**状态：2026-08-17 作者完成 `LEGAL-NOTICE.md` 与期限规则表核准，放行首次公开提交。**

### 许可证与归属

- 项目许可证改为 `AGPL-3.0-only`；根 `LICENSE` 使用 GNU AGPL 3.0 官方完整文本，`package.json.license` 同步。
- 删除 Electron 打包时的 JavaScript 混淆钩子和 `javascript-obfuscator`。2.0.0 的专有 EULA、禁商用政策和 DMG 混淆均是**历史事实，现已被本次转换取代**；AGPL 本身允许商业使用，但网络交互、修改与分发须遵守许可证义务。
- Noto Sans SC / Noto Serif SC 继续按 SIL Open Font License 1.1 分发；`LICENSES/OFL-1.1.txt`、字体来源和保留名称说明随桌面包一并收录。
- 增加 `ACKNOWLEDGEMENTS.md`、`LEGAL-NOTICE.md`、`SECURITY.md`、`SELF-HOSTING.md` 与公开贡献治理。`LEGAL-NOTICE.md` 已于 2026-08-17 经作者核准，公开版不再带待核准标记。

### 安全加固（首批）

- 启动改为 fail-closed：默认只监听 `127.0.0.1`；账号与密码 hash 必须成对配置；非回环监听还必须配置独立 `ANJIAN_INTERNAL_KEY`。
- 只保留精确 `ANJIAN_UNSAFE_NO_AUTH=1` 的开发逃生口，且仅限非 production 与明确回环 IP；其他组合拒绝启动。
- 增加显式 trusted-proxy 策略；客户端来源与 HTTPS 状态统一使用 Express 解析后的 `req.ip` / `req.secure`。
- 密码 hash 改为版本化 `scrypt-v1$N$r$p$dkLen$salt$hash`，保留旧 `salt:hash` 验证兼容并在成功登录时提示维护者手工迁移。
- 登录限速按来源与账号分桶并设置 TTL 和容量上限；会话数据库与 cookie 同步滚动续期。
- migration 016 将 session 时间统一为 UTC；配套 fixture 验证存量升级、完整性与回滚边界。
- production 未捕获异常只返回稳定错误码与 UUID correlation ID，完整错误留在服务端日志。
- 固定分成引用查询的 prepared statement，不再让动态表名进入 SQL。

### 安全加固（第二批）

- 案件创建与改名统一要求 `cases.name` 为单一、非隐藏的目录名称；文件 API、款项凭证和 LegalRAG 改为共用真实路径安全层。
- 文件根先解析 canonical realpath；案件夹、中间目录和目标逐级 `lstat` 拒绝符号链接，并在操作前后复核真实路径 containment 与 inode 身份。目录列表和 reconciliation 不跟随链接。
- 文件取流以 `O_NOFOLLOW` 打开已验证描述符；上传以 `O_CREAT|O_EXCL|O_NOFOLLOW` 原子创建，消除 `exists→write` 覆盖竞态，同时保留重名 `(2)` 行为。读取端点把穿越、符号链接和真实路径越界统一隐藏为 404；写入类非法输入继续返回可纠正的 400。
- `ANJIAN_STATIC_TOKEN`、`X-Anjian-Key` 和用户名均先摘要为固定长度，再用 `timingSafeEqual` 比较；未知用户名也执行配置 hash 的完整 scrypt 验证。
- 增加正常中文路径、案件根/中间目录/目标符号链接、路径整体替换、重名上传、凭证和 LegalRAG 的单元与 HTTP 回归。

### 公开治理与发行转换

- README 改为公开项目说明；Issues、Discussions 与 Forks 欢迎，外部 Pull Request 依据维护政策自动关闭。该政策不缩减 AGPL 授予的权利。
- 增加 Bug、Feature 与期限规则勘误表单。期限勘误只是一条待独立法律复核的线索，不会自动改变 `rules/deadline_rules.json` 的 review 状态。
- `RELEASING.md` 已改写为 GitHub Releases、GHCR 与 Android 三条公开发行线：tag 才能发布，手动 dispatch 只能构建、校验并上传 Actions artifacts 和 `.sha256`。
- Electron 工具链升级到 Electron 43.4.0、electron-builder 26.15.7、`@electron/rebuild` 4.2.0 与 electron-updater 6.8.9，更新源切为 `zj-ai-lab/anqi` 的 GitHub provider；增加按月分组的 Dependabot 配置。
- macOS 与 Android workflow 只在对应 tag 下写入 GitHub Release，Docker workflow 只在 `v*` tag 下向 `ghcr.io/zj-ai-lab/anqi` 推送 `X.Y.Z`、`X.Y` 与 `latest` 多架构镜像；手动 dispatch 永久限于 dry-run。三条 workflow 已移除 SSH/scp、私有主机与生产路径，并通过 tag 门、权限、secret 集合和私有坐标反向验收；2026-08-17 首次公开提交已获放行，tag、Release、镜像与实例升级仍按各自发行流程另行执行。

### 首次公开候选补全

- Android WebView 壳移除固定站点与 host App Link：首次启动必须配置服务器 origin，之后可从常显原生控件修改；Intent 和站内导航改为严格同源比较，切换实例会清除登录态。公网地址必须 HTTPS；只有 loopback、RFC1918 与 `.local` 可显式使用 HTTP，并在界面提示明文风险。
- `/internal` 未显式携带 actor 时的新默认值改为 `internal`；升级前已落库的 `hermes` 只作为历史兼容证据保留，不做 migration 或批量重写。公开界面、运行时代码和 migration 注释中的特定同步/自动化/代理产品措辞改为中性能力描述。
- 公开 README 改为 Docker-first 且符合 fail-closed 启动顺序的完整自托管说明，补产品边界、完整能力表、架构图、Android 连接规则与当前 UI 三皮肤截图。九张 1440×900 演示图只含虚构数据，图标源 PNG 与三份生成/构图提示记录一并收入 `garden-gpt-image-2/`。

---

## 0.1.0–1.2.0 — 台账、期限与分成基础

### 0.1.0：P0 电子台账

建立 Node.js ESM + Express + better-sqlite3 单进程骨架、编号 migration、Web UI 与 `case` CLI。案件、事件、期限、待办、工作日志和收件箱使用同一 SQLite 真相源；附件只存案件夹指针。

### 0.2.0：确定性期限引擎

事件进入正式表后由纯函数读取规则和节假日数据派生期限；法院指定期限只标缺口，不由模型填空。级联重算保护人工覆盖，L0 digest 不经过任何模型。

### 0.3.0–0.5.0：登录、费用与文件桥

账号密码替代反向代理 URL token，浏览器使用 30 天会话；静态 token 仅保留给受信任 CLI。新增律师费台账和案件文件桥：配置根下的案件夹是唯一文件真相源，数据库只存引用，解除关联不删除原件。

### 1.0.0：v5 三皮肤

v4“翡翠·增强”原型采用以品牌色为中心的玻璃氛围，后续评审认为它与期限管理内容关系不足。v5 改为“一个骨架、三种材质”：

| 皮肤 | 角色 | 材质 |
|---|---|---|
| `pro` | 默认亮色 | 白表面、1px 灰边、零阴影、等宽数字 |
| `paper` | 纸感亮色 | 暖白纸底、直角、衬线、零玻璃 |
| `jade` | 暗色 | 墨绿底、受控毛玻璃与弥散光 |
| `auto` | 跟随系统 | 亮色映射 pro，暗色映射 jade |

共享层负责布局，皮肤层只负责材质；`border-width` 恒为 1px，粗规则线用 inset shadow，避免切换皮肤时推动内容。`anjian-skin` 等既有 localStorage 键继续保留。

1.0.0 同时为案件夹增加 SSE 文件变化推送；平台不支持 `fs.watch` 时，前端只在页面可见期间对轻量目录指纹进行降级轮询。

### 1.1.0：同步与异步 LLM 两条确认路

快录整理只接收用户输入的最小文本，只能返回 `task | log` 表单建议。案件匹配在本地进行且只认唯一命中；人按“记”才写库。后台提取或导入属于异步场景，只能进入 inbox 等待人工裁决。两条路径共同保持“LLM 没有正式写入口”。

### 1.2.0：合作分成

migration 005 建立分成约定和台账。已收律师费可按人工确认的约定形成应付分成；L0 增加待分提醒，统计增加分成后净口径。分成不进入期限引擎，也不开放 LLM 写入。

---

## 1.3.0–1.4.2 — 分成审计闭环

### 1.3.0：分成体系化

分成从平行孤儿台账变为可挂到具体款项的一等记录。全局总账采用：

```text
net_retained = paid − share_payable + share_receivable
```

无案件归属的外部应收只进入全局总账，不伪造本案款项。手工挂账、约定解析和来源款变更均有同案校验与幂等边界。

### 1.3.1：历史修复工作台

migration 006 只将满足严格条件的升级前孤儿分成加入人工修复队列，不自动改金额、挂款、合并、删除或重算。人工可认领同案已收款、保留未认领或逻辑作废；软重复只作提示，例外认领必须填写理由。`is_void=1` 的历史证据保留，但退出正常列表、总账、统计和 L0。

### 1.4.0：公式与结算闭环

migration 007 将分成建模为 agreement / immutable revision / fee plan / settlement run / snapshot / ledger 五层：

- 金额以整数分、比例以万分位保存；封闭 DSL 只允许有序 fixed/rate 扣减与 terminal 计算。
- 后端使用 `BigInt` 逐步向零取整并保存 trace，浏览器不计算钱。
- 未收计划和 preview 不进入总账；确认时在 `BEGIN IMMEDIATE` 中重读、重算并原子写入不可变快照和台账。
- 公式新版不静默替换已钉版本；更正和撤销追加 cancellation / adjustment，不覆盖历史。

案件页和费用页复用同一结算组件，避免不同入口产生不同金额口径。

### 1.4.1–1.4.2：防重与阅读层级

migration 008 增加 active agreement 唯一性、历史/手工台账与引擎台账的硬冲突检查，以及嵌套 savepoint 保护。费用明细改为“款项事实 / 收款条件 / 分成与结算”三层，实际分成另起结果带；三皮肤保持同骨架。

---

## 1.5.0–1.7.5 — 文书派生、推荐闭环与律师化界面

### 1.5.0：案件夹 × LegalRAG

migration 009 保存文件 revision、持久队列、提取运行与候选。案齐和可选 LegalRAG 服务登记同一共享原件，按 checksum 复用解析；同路径内容变化追加 revision。首次启用只建立存量基线，不把历史文件自动全量送去 OCR。

提取器类型闭合为 `fee | event`，不能产生 deadline 或 share。候选连续展示路径、页码和原文；收费候选由人确认，事件确认后才交给确定性期限引擎。旧 revision 和未裁决候选在新 revision 出现时退出当前队列，但历史证据不删除。

### 1.5.1–1.6.1：分成管理律师化

应收与应付改成两个直达动作；金额和扣费尚未确定时允许先封存暂定公式，但不生成金额台账。migration 010 增加结算约定、暂定状态与待定扣费。

默认界面不要求使用者理解 revision、assignment、run 或 snapshot，而是连续回答“谁给谁分、怎么算、现在能确定多少、什么时候结算、下一步是什么”。底层不可变版本、后端重算和并发保护保持不变。费用首页只突出总账净额，并明示：

```text
律师费已收 − 已发生应付分成 + 已发生应收分成
```

### 1.7.0：推荐与文书事实闭环

migration 011 引入两项闭环：

1. L2 推荐用固定 intent 和服务端状态指纹识别，不把模型标题当身份。pending、snoozed、采纳后待办仍 open、同状态 declined 等情况只累计 seen；相关业务状态变化后才可解释性重提。
2. LegalRAG 将逻辑事实与来源证据分表。人工裁决跨文件和 revision 继承，而每份路径、页码、引文和置信度继续保留。

`/internal/inbox` 只接受固定来源的 task 建议白名单，不接受日期、event、note 或 deadline。

### 1.7.1–1.7.5：四轮 UX 走查

- 案件页快录默认挂当前案；跑道支持改期且保留人工覆盖；结案/搁置和删除增加确认。
- 费用页可直接记款；未确认分成前置展示；`unpaid ↔ waived` 可逆，已有真实结算历史时继续硬拦。
- 文书筛选升级为“LLM 语义判断 + 本地 fail-closed”：只准入本案直接原始材料、高置信且可回指 OCR 的引文；检索报告、类案、分析、草稿和引用材料清零。
- 待办/日志就地录入；时间线默认只构建最近 20 条；文件区常驻拖放面。
- 案件搜索补案由和法院；危险动作、分成月份与引擎行按钮保持前后端一致。

---

## 1.8.0–1.9.0 — 工作台阅读层级

### 1.8.0：今日、案件与费用三页重构

今日页按“先处理这个 / 还在追的期限 / 今天要做的 / 等你裁决”排序；案件页改为卷宗抬头、主工作流和侧栏；费用页突出单一净额和“要追的钱”。三页不改变原有写入口。

migration 012 增加 `fee_item_files`，款项凭证固定写入案件夹 `财务凭证/`，数据库只存引用。待办首次完成时在同一事务生成工作日志，重复完成不重复留痕。

### 1.8.1：日历全状态一致性

修复日历 SQL 只返回 open 待办的问题；done/dropped 待办改为灰显划线。图例变成语义正确的筛选按钮，类型与“已处理”偏好保存在既有本地存储键中。

### 1.9.0：待办三层分组

今日页增加今日 / 本周 / 全部三层。`effective = due_on || plan_date`；今日和本周互斥，全部兜底所有 open task，无日期项以“未排期”沉底。示例和测试只使用虚构案件数据。

---

## 2.0.0–2.2.6 — 桌面产品化与日历调度

### 2.0.0：历史闭源阶段

2.0.0 曾将 actor 默认值从个人标识改为 `ANJIAN_DEFAULT_ACTOR || 'web'`，并通过 migration 013 清理可变记录；同时引入 DMG JavaScript 混淆和专有 EULA。后两项现已由 2.6.0 开源转换明确取代，本节只保留历史事实，不表示当前许可证政策。

### 2.0.2–2.0.3：桌面监听与 migration 013

Electron 后端改为明确监听 `127.0.0.1`，避免桌面应用意外暴露到局域网。未签名且只发行 DMG 时，更新操作改为打开下载页，避免 `electron-updater` 走不存在的 zip 静默更新路径。

初版 migration 013 试图修改受 migration 007 不可变触发器保护的历史 actor，带存量数据会启动失败。2.0.3 改为：

- 不改不可变 formula revision 和 settlement run 的历史 actor；
- 只按乐观锁契约更新 assignment，`version + 1` 且 `updated_at` 严格变晚；
- 增加带存量数据的 migration fixture，反向断言三个写守卫仍存在且有效；
- migration 与 `PRAGMA user_version` 保持同一事务，失败整体回滚。

### 2.1.0：对外更名 ANQI

中文名案齐不变，对外英文名改为 ANQI。以下兼容标识故意不改：

- npm 包名 `anjian`；
- Electron appId `asia.fdonglawyer.anjian`；
- `ANJIAN_*` 与 `X-Anjian-Key`；
- localStorage 键、数据库名和 Electron userData 目录。

这些标识关联既有配置和持久数据；看到 `anjian` 不是遗漏。

### 2.1.1–2.1.4：首次引导、桌面外壳与 PWA

- 修复 onboarding 脚本与 preload 全局同名导致整份脚本无法解析的问题；选定父目录后自动创建“案齐数据”子目录。
- macOS 图标按 1024 画布内 824 图形本体重排；网页图标使用去透明边裁法。
- `hiddenInset` 窗口在 Electron 侧注入红绿灯让位和拖拽区，不污染浏览器版布局。
- migration 014 增加设置表，只有姓名、执业证号、律所、电话、邮箱和办公地址六个白名单键可写。
- 增加 Web App Manifest 和 maskable 图标；随后把 maskable 主视觉缩到 62%，为 Android 遮罩保留安全区。

### android-v1.0.0：Android 壳

独立 Gradle 工程使用单 Activity + WebView，支持深链、文件选择、带会话 Cookie 的下载、FileProvider 打开文件、网页历史返回和断网重试。Android 版本线使用 `android-v*`，不占用服务端 `v*` 版本号。

### 2.2.0：日历待办调度台

migration 015 为任务增加可选 `due_time`。日历增加未排期托盘、任务弹层、按案件配色、跨天长条、开工/截止端点和分钟级显示；服务端校验日期顺序，并在端点交叉时钳到同日。

### 2.2.1：ad-hoc 重签

无 Developer ID 时，electron-builder 产物曾保留 Electron 出厂 linker ad-hoc 签名，可能共享已被系统撤销的 CDHash。`build/adhoc-sign.cjs` 对应用执行项目自己的 deep ad-hoc 重签，并断言不再是 linker-signed 且 Identifier 保持 `asia.fdonglawyer.anjian`。检测到正式证书时钩子跳过。

ad-hoc 只能把“共享签名被撤销”降级为普通未公证应用的手工放行；无 Developer ID 与公证时，不承诺静默安装或零弹窗。

### 2.2.2–2.2.6：拖拽、折叠与留痕

- 删除互相触发 `pointercancel` 的 HTML5 DnD 双轨，统一为 Pointer 输入；真实拖拽验收必须使用真实输入管线，合成 `dispatchEvent` 不算通过。
- 跨天长条使用固定车道，同周等高，多任务分道；支持整体平移和端点调整。
- 全站低频区域使用原生 `<details>` 渐进披露；日历合并为连续 sheet。
- 案件阶段真正变化时自动生成工作日志；重复或无变化 PATCH 不造日志。
- 案件款项和费用案件条的折叠、尺寸与面板边距在三皮肤和 390px 下保持一致。

---

## 2.3.0–2.5.0 — 信息密度、字体与候选去重

### 2.3.0：折叠三手法

一页主视线最多保留一道归档箭头，其余内容分为：

- **事实条 `.factstrip`**：固定事实常显，编辑时就地展开；
- **账本行 `.ledger`**：同构集合在收起态仍是可读数据行；
- **归档门 `.archive-door`**：已完结、已忽略或已归档的整段，放在页面末尾。

8 页折叠门总数由 27 收到 6。案件款项明细切换改为缓存数据的纯前端重渲染，不再为开合额外请求 API。

### 2.4.0：费用页层次与自托管字体

费用页从跨案连续表改为案卡堆：每案独立卡片，展开后以状态色带、背景深井和款项白卡分层。粘性抬头随滚动收缩，只钉导航行，并用不占布局高度的 mini overlay 显示净额与待追款。

Noto Sans SC / Noto Serif SC 使用 OFL 1.1 的 unicode-range WOFF2 切片自托管，按页面实际字符加载；可变字重 100–900 提供真实层级。字体许可证、来源与保留名称说明随源码和桌面产物分发。

### 2.5.0：LegalRAG 收费候选持久去重

收费事实收敛为“来源证据 → 逻辑事实 → 正式收费 alias”：

- 本地确定性代码按同案 strict typed key 返回 `zero / unique / ambiguous`。标签做 NFKC/大小写/空白归一；金额使用权威整数分；明确日期相同，日期为空时才比较付款条件。
- `unique` 只建立关联，不新增或修改正式收费；`zero` 和 `ambiguous` 留给人工，多命中绝不任选第一条。
- 人工可显式把事实关联到任意同案收费；同 fact key 在其他文件、revision 或 schema 中再次出现时继承 alias。
- 历史 accepted/declined 优先于系统匹配。正式收费编辑不重算 alias；删除时在同一事务把关联事实转为可恢复的 declined 并清理软链接，不自动改绑。
- 自动与人工关联都在 immediate transaction 中重查 pending 状态和案件所有权；跨案拒绝，歧义接受返回冲突。
- 界面显示唯一/歧义提示和“关联已有收费”；三皮肤与 390px 保持同骨架。

本版无 migration、无新依赖。
