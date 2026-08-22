# AI 助理 sidecar · 交付门禁证据台账

> 本文对应设计稿 `anqi-spike-dsh/spikes/dsh-agent/docs/mainline-plan.md` §6 的十条交付门禁，
> 逐条登记**证据在哪个文件的哪一段**，以及这条证据的强度属于哪一档。
>
> 本文只登记证据，不替代证据：任何一条的判定都必须能被读者顺着下面的文件路径自己复核。
> 新增/改动 sidecar 相关代码时，本文与 `tools/check.sh` 必须同步更新——门禁条目失去对应的
> 可复跑证据，等同于该条门禁失效。

## 证据强度分档

| 档 | 含义 |
|---|---|
| **机械** | `npm run check` 里有一条会因为该不变量被破坏而变红的断言（最强，回归可复跑） |
| **结构** | 由代码结构本身保证（例如某能力压根没有入口），可静态复核，但没有专门的失败用例 |
| **静态** | 只有源码/配置层面的核对（含对第三方包行为的引用），没有在本仓库跑过真实端到端 |
| **动态** | 拉起真实 DSH 子进程 + 真实模型 key 实跑过 |

`npm run check` 当前 39 步，其中第 30–36、39 步专供 sidecar；第 37–38 步是打包/桌面版接线守卫。

---

## 门禁 1 · 绑定案件以外的数据不会进入模型请求

*（spike 阶段的表述是「三条 seed demo 案件以外的数据」；主线的等价要求是「worker 绑定案以外的任何案件数据」。）*

- **结构** — 模型可见的三个 anqi 工具（`src/agent/assets/plugins/dsh-anqi/index.js`）**没有任何参数可以选择案件**：
  `anqi_case_get` / `anqi_digest` 的 `parameters` 均为 `{}`，案件绑定只来自 supervisor 注入的
  `ANQI_AGENT_SESSION_ID`。
- **结构** — 服务端按 session 反查，不信任请求方：`src/routes/internal.js` 的
  `/agent-case-view`、`/agent-digest` 都先 `caseIdForSession()`（`src/agent/session-registry.js`），
  查不到直接 403，绝不回落。
- **结构** — 单案投影：`src/lib/digest.js` 的 `buildDigest(caseId)` 对每个分桶按 `case_id` 过滤、
  `counts` 按同一 caseId 重新聚合，不从全所口径派生。
- **结构** — 字段白名单：同一插件里的 `CASE_FIELDS` / `EVENT_FIELDS` / `DEADLINE_FIELDS` /
  `TASK_FIELDS` / `WORKLOG_FIELDS` / `RECOMMENDATION_FIELDS` / `DIGEST_ROW_FIELDS` 逐字段 `pick()`，
  `contacts` 不在任何一份名单里；`src/routes/internal.js` 的 `buildCaseView()` 本身也不 JOIN contacts。
- **结构** — 文件面：worker 的 fs 沙箱根 = `DSH_CWD` = supervisor 用
  `src/lib/secure-files.js` 的 `resolveCaseDirectory()` 解析出的那一个案件夹
  （`src/agent/assets/anqi.cordis.yml` 的 `sandbox-policy.workspaceRoot` / `fs-sandbox.cwd`，缺失即抛错，无 `process.cwd()` 兜底）。
- **机械** — `tools/test-agent-session-read-http.js`（check 第 34 步）：逐分桶同时断言「本案的行在」
  与「他案的行不在」，并覆盖 electron-auto key 的挂载栈收窄。

## 门禁 2 · `enabled=false` 在 credential、MCP、prewarm、spawn 之前短路

- **结构** — `src/agent/config.js` 的 `loadAgentConfig()` 第一件事读 `agent_enabled`，
  非 `'true'` 立即 `return { enabled:false }`，后面任何一行（含读 `apiKeyEnv` 字段）都不执行。
- **结构** — `src/agent/supervisor.js` 的 `_startWorker()` 第 1 步就是 `loadConfigFn()`；
  未启用时在读 `process.env[apiKeyEnv]`、查案件、动文件系统、`spawnFn` 之前返回 `disabled`。
- **结构** — HTTP 面同判定：`src/routes/agent.js` 的 `GET /api/agent/status` 与
  `GET /api/cases/:id/agent/events` 都先 `loadAgentConfig()`，未启用时首帧直接 `status:'disabled'`，
  完全不触碰 worker。
- **机械** — `tools/test-agent-supervisor.js` 场景 1（check 第 31 步）：注入的 `spawnFn`
  断言**从未被调用**，且未触碰 credential/cwd。
- **机械** — `tools/test-agent-http.js`（check 第 36 步）覆盖 `enabled=false` 的 REST/SSE 短路。
- **机械** — `tools/smoke-agent-frontend.js`（check 第 39 步）：默认态 `/api/counts.agent=false`，
  且 `case.html` 静态源码里只有一个空挂载点 `#agent-entry-slot`，不含任何硬编码入口标记。

## 门禁 3 · 每个 worker 的 session、真实 `cwd` 和 case 权限不可被 prompt 改写

- **结构** — `cwd` 只来自 `resolveCaseDirectory(filesRoot, case.name)`（禁 symlink、必须在
  `ANJIAN_FILES_ROOT` 下且与 `cases.name` 精确对应），模型没有任何输入能影响它。
- **结构** — `sessionId` 由 supervisor 铸造（`anqi-${randomUUID()}`）并在 **spawn 之前**
  `bindSession()` 登记；worker 终态收尾时 `unbindSession()`。
- **结构** — skill 根不接受用户 YAML：`preset/anqi/agent.cordis.yml` 的 `customSkillDirs`
  对 `DSH_ANQI_SKILLS_ROOT` 缺失显式抛错；`verifyTrustedSkillsRoot()` 拒绝符号链接与非常规条目，
  每次启动拷进独立 0700 临时目录，退出即删。
- **结构** — 无 shell/web/subagent/workflow/ralph：`anqi.cordis.yml` 刻意不挂
  `dsh-permission-presets`（该插件会 inject `shell`），`sandbox-policy.mode: read-only` +
  `user-approval.policy: never`。
- **机械** — `tools/test-agent-supervisor.js` 场景 2/3：案件夹不存在、案件夹是 symlink，
  两条都拒绝且**未 spawn**；场景 11：`bindSession/unbindSession` 确实接线。

## 门禁 4 · 首个 `request/header` 含唯一 anqi skill 与精确 MCP 工具，且同一 turn 实际调用该工具

- **结构** — 「唯一 anqi skill」在 **preflight** 一侧核验：`isPreflightReady()`
  （`src/agent/supervisor.js`）要求 `skills.names.length === 1 && names[0] === 'anqi-case-brief'`
  且 `skills.complete === true`、`skills.ready === true`。
- **结构** — 「精确 MCP 工具 + 同 turn 实际调用」在 **首 turn** 一侧核验：`_maybeResolveTurn()`
  要求 `_firstRequestHeader.reason === 'initial'`、`header.tools` 含
  `mcp__anqi-local__case_folder_info`，且 `_sawRequiredMcpCall === true`。
- ⚠️ **口径说明**：设计稿原文是「首个 `request/header` **同时**含唯一 anqi skill 和精确 MCP 工具」。
  实现把 skill 那一半放在 preflight 的逐字段核验里，而不是从首个 header 里读 —— 两处合起来覆盖了
  同一组不变量，但**不是逐字照做**。改动这两处任何一处时必须同时看另一处。
- **机械** — 场景 8：preflight 返回值逐字段改坏，均被拒绝、未放行到 ready。
- **机械** — 场景 5：首 turn 门禁失败**不会**被同一 worker 的下一个 turn 绕过（`firstTurnChecked`
  只在真正通过后置位）。
- **机械** — 场景 14：首 turn 中途的 `reason:'change'` header 不覆盖 `initial` 快照。
- 未在本仓库做过**动态**验收（真实 DSH 子进程 + 真实模型 key）；上述场景用的是回放 JSON-RPC 帧的
  FakeChild。真实模型-backed 跑见 spike 的 `REPORT.md` §13.2/§13.4。

## 门禁 5 · approval / question 的 allow / reject / answer / timeout / disconnect / shutdown 全部 session-bound、one-shot、fail-closed

- **结构** — 三重绑定 + 消费即删：`_enqueueApproval` / `_enqueueQuestion` 先比对
  `params.sessionId === worker.sessionId`（不匹配原地回 `unavailable`，不入表、不广播）；
  `resolveApproval` / `resolveQuestion` 再校验 worker 仍在 `LIVE_STATUSES`、record 类型与
  `record.sessionId`，命中即 `delete`。
- **结构** — 受限 outcome：`APPROVAL_EXTERNAL_OUTCOMES = {allowed-once, rejected}`，
  白名单只有 supervisor 一份，路由层不复刻。
- **结构** — 严格答案：`src/routes/agent.js` 的 `buildQuestionAnswer()` 要求逐题一一对应、
  id 命中且不重复、非空、≤2000 字符，任一不满足整体 400，不做部分采纳。
- **结构** — 客户端不自报归属：`POST /api/agent/interactions/:id/answer` 的唯一入参是
  interactionId，case/worker 由 `findInteractionOwner()` 反查。
- **机械** — 场景 6（跨 session 原地拒绝、不入表）、场景 7 / 7b（`listPendingInteractions()` /
  `publicStatus()` 脱敏投影）、场景 10（turn 失败瞬间清空 pending，shutdown 往返窗口内仍 fail-closed）、
  场景 21（TTL 到期/worker 提前终态化都**真正回子进程一个应答**，不是只清表）、
  场景 15/18（stdio 故障、卡死不退的子进程也落终态并收尾）。
- **机械** — `tools/test-agent-http.js`：interactions 信任边界（未知/过期/跨 session/worker 已退）。

## 门禁 6 · proposal retry 保持 `proposal_id` 幂等；同题异 ID 不互相吞并

- **结构** — `src/lib/recommendations.js` 的 `enqueueAgentProposal()`：
  `state_fingerprint = <trusted proposal_id>`（不做 hash），`intent_key='v1:agent-proposal'`，
  `content_key` 只存 normalized title；`proposalId` 必须是字符串本身（拒绝 `String(x)` 强转塌缩）。
- **结构** — 与 L2 的 `enqueueLlmSuggestion()` 并列、不共用状态机；`source='agent-propose'`
  使既有唯一性约束天然分流，无需 migration。
- **机械** — `tools/test-agent-proposals.js`（check 第 32 步）：幂等 retry（返回新鲜快照）、
  同题异 ID 并存、decline 记忆、与 L2 互不覆盖。
- **机械** — `tools/test-agent-proposals-http.js`（check 第 33 步）：幂等状态码、
  `session_id` 服务端覆盖、payload/source_ref 白名单。

## 门禁 7 · 接受后只复用既有人类 accept→task 路径；模型永远不能直接写 task/event/deadline

- **结构** — 模型可达的唯一写面是 `POST /internal/agent-proposals`，它只接受
  `kind==='task'`（`event`/`deadline` 一律 400），落库目标是 `inbox`（待裁决队列），不是 `tasks`/`events`/`deadlines`。
- **结构** — accept/decline 在 `src/routes/views.js` 的 `/api/inbox/:id/accept|decline`，
  挂在 `app.use('/api', apiAuth, ...)` 之下，需要人类会话；`src/routes/agent.js` 明确不新开任何
  模型可达的 accept API。
- **结构** — 桌面版自动生成的 internal key 被 `src/middleware/auth.js` 的
  `ELECTRON_AUTO_KEY_ALLOWED_PATHS` 收窄到三个 agent 端点，其余 `/internal/*` 403。
- **结构** — accept 产出的 task 落 `origin='llm'`，audit 记录来源 `agent-propose`。
- **机械** — `tools/test-agent-proposals-http.js`：kind/source 白名单与 session 绑定信任边界。

## 门禁 8 · 重启、取消、半完成 turn 和 worker 崩溃都有可审计终态

- **结构** — 启动路径逐分支写 audit：`agent-start-skip`（disabled）、`agent-start-fail`
  （credential_missing / internal_key_missing / case_not_found / cwd_invalid / case_folder_missing /
  skills_root_invalid / runtime_link_invalid）、`agent-start`（含 session/pid）。
- **结构** — 终态统一收尾：`_finalizeWorker()` 写 `agent-<status>`（stopped/crashed/error）
  并对 detail 做 `worker.redact()` + 截断；`exitInfo` 随 `publicStatus()` 下发。
- **结构** — 每案单 worker：`start()` 的 in-flight 互斥表 + `stop()` 的 in-flight 去重，
  杜绝孤儿 worker（孤儿 worker 会既不在注册表、也永远不被收尾）。
- **机械** — 场景 4（turn 超时真正终止 worker）、场景 9（turn 失败立即离开 LIVE 态）、
  场景 12（订阅跨重启不被孤儿化）、场景 13（`forceKillAll()` 真的杀）、场景 17/17b
  （stopping 窗口内并发 start 只跑一次启动序列）、场景 18（卡死子进程也落 crashed 并清临时目录）、
  场景 20（重复 start 返回实时快照）。
- **结构** — 进程级：`server.js` 的 SIGTERM/SIGINT 钩子 → `stopAll()`（8s 总时限）→
  `forceKillAll()` 兜底 → `httpServer.close()`。

## 门禁 9 · UI、DB、SSE、logs、requests、error strings 全部通过 secret scan

- **结构** — key 值只存在于两处：`process.env[apiKeyEnv]` 的一次读取，与 `buildSpawnEnv()`
  产出的子进程 env（白名单起步，不是 `{...process.env}` 展开）。`src/agent/config.js` 不读、不返回、
  不缓存该值；`/api/counts` 只回 `!!process.env[name]` 一个布尔。
- **结构** — 下行统一脱敏：`redactor([apiKeyValue, internalKeyValue])`，`redactDeep()` 对
  **字符串叶子、对象 key 名、`method`、事件 `type`、`toolName`、`worker.error`** 全部过滤，
  并有三道总量闸门（字节预算 / 数组条目上限 / 对象 key 上限）。
- **结构** — 投影收窄：`publicStatus()` 不下发 `sessionId`/`cwd`/`pid`；SSE 转发帧同一档投影。
- **结构** — 配置侧堵死"把宿主内部 key 当模型 key 发出去"：`isReservedEnvName()` 拒绝
  `ANJIAN_`/`ANQI_`/`DSH_` 前缀与常见宿主变量名；`validateBaseURL()` 拒绝内网/回环/带凭据 URL，
  `deepseek-official` 钉死官方域。
- **机械** — 场景 7（`listPendingInteractions` 脱敏）、场景 16c（对象 key 名脱敏）、
  场景 19（`worker.error` 兜底脱敏）、场景 23（wire 事件撞名重写）；
  `tools/test-agent-config.js` / `tools/test-agent-settings.js` 覆盖保留名与 baseURL 策略。
- **人工** — 分支全量 secret scan（`main..HEAD` 全部提交的 patch + 全部 tracked 文件）：
  未命中 `sk-*`/`ghp_*`/`AKIA*`/`AIza*`/`xox?-*`/PEM 私钥/JWT/`_authToken` 任一模式。
  `src/agent/runtime/node_modules`、`src/agent/assets/node_modules` 均被 `.gitignore` 排除，未进仓库。

## 门禁 10 · 关闭 sidecar 不改变现有 inbox、deadline、event 和任务主线行为

- **机械** — `npm run check` 第 1–29 步（sidecar 之前的全部既有回归）在本分支保持全绿。
- **结构** — 无 migration：`src/migrations/` 与 `main` 完全一致（最高仍是 `016`），
  唯一新状态是 `settings` 表里可能多出的 `agent_*` 五个键；与 2.6.0 可互换回退。
- **结构** — 主线接口只做加法：`/api/counts` 增 `agent` 布尔；`/api/settings` 白名单增 5 键；
  `today.js` 的收件卡片文案分叉只在 `source === 'agent-propose'` 时生效。
- ⚠️ **一处非零加法**：`src/lib/digest.js` 的 `shares_pending` 投影新增了 `s.case_id` 列，
  因此 `/api/digest` 与 `/internal/digest` 的该分桶行在**关闭 sidecar 时也会**多出一个
  `case_id` 字段（单案投影唯一的过滤依据，见该处注释）。纯加法、不改动既有字段，
  但严格讲不是"零改动"。

---

## 未覆盖 / 已知限制

1. **动态门禁未在本仓库验收**：门禁 4、5 的证据基于回放 JSON-RPC 帧的 FakeChild，
   本仓库从未拉起真实 DSH 子进程 + 真实模型 key 跑通一条完整 turn。真实模型-backed 跑发生在
   spike 仓库（`anqi-spike-dsh`），主线未复现——而且**那次跑的不是主线这套配置**：
   spike 侧的 sandbox 是 `workspace-write`（主线已钉死 `read-only`），
   `anqi_case_get`/`anqi_inbox_propose` 当时还带模型可控的 `name`/`case_name` 参数
   （主线已全部移除、改成 session 反查）。所以 spike 的动态记录只能证明「wire 协议本身跑得通」，
   **不能**当成主线这三条收窄之后的端到端证据。GA 前应在主线补一次动态验收。
2. **`write`/`edit` 工具名仍对模型可见**：rc.7 的 `@deepseek-ai/dsh-tool-fs` 不可拆分只读子集，
   只能靠 `sandbox-policy.mode: read-only` + `user-approval.policy: never` 拒绝，
   不是"工具不存在"级别的保证（见 `preset/anqi/agent.cordis.yml` 顶部注释）。
3. **打包体积**：本轮 bundle 的是全闭包而非 trace-derived 最小闭包，双架构 DMG 均较
   2.6.0 基线（140,389,719 B）显著增大——arm64 200,356,527 B（+42.71%）、
   x64 205,187,873 B（+46.16%），依赖裁剪留给 GA（见 `CHANGES.md`）。
4. **DMG 体积/双架构可跑性无法在纯源码树复核**：`dist-electron/` 不入库，
   相关数字与 `codesign --verify` 结论来自当时的本机构建记录，复核需重跑
   `RELEASING.md` 的本机打包流程或 CI 的 "Verify agent runtime bundled in DMG" 步骤。
