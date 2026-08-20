# anqi DSH sidecar 主线落地计划

> 本文是设计稿，不是主线实现。Phase 2 Commit 4 只新增本文件；不修改 `src/`、`server.js`、`public/`、根 `package.json`、`electron/` 或现有 `~/.dsh` 配置。

## 1. 边界与目标

DSH 只作为 anqi supervisor 管理的可选、进程外 worker。worker 不能成为 anqi 的事实源，也不能取得 anqi 的确定性写权限。案件事实、期限和事件仍由 anqi 提供或计算；模型只能读取 anqi-owned tools 返回的事实，并提出供律师裁决的 task 建议。

主线首版只支持每个案件一个 worker、一个固定 session 和一个固定案件夹 `cwd`。同一案件的 turn 串行化；关闭、取消、崩溃和重启都由 supervisor 决定。模型文本不是授权凭据：approval、user-question、proposal accept/decline 均必须经过有身份绑定的服务器端通路。

建议的设置白名单只有：

- `enabled`
- `provider`
- `baseURL`
- `model`
- `apiKeyEnv`

key 的值永远不进入 UI、数据库、HTTP response、SSE、日志、错误消息、请求审计或仓库。`enabled=false` 必须在读取 credential、初始化 MCP、预热 DSH 或 spawn 子进程之前短路返回。

## 2. Agent proposal 数据契约

新增专用入口 `POST /internal/agent-proposals`，不要扩展现有 `/internal/inbox` 的语义，也不要把 proposal 混入 `case.next_action`。入口只接受已经由 supervisor 绑定案件和 session 的 task-only 建议；不能接受 event、deadline、直接 task 创建或任意写入动作。

业务层新增 `enqueueAgentProposal()`，与现有 `enqueueLlmSuggestion()` 分开。建议的调用链为：

```text
DSH tool call
  → supervisor 校验 session/case/tool scope
  → POST /internal/agent-proposals
  → enqueueAgentProposal()
  → inbox proposal（待律师裁决）
  → 现有 human accept → task 路径
```

每条 proposal 至少包含以下受信字段：

- `case_id`：由 supervisor 的固定案件绑定产生，不从模型正文推断；
- `proposal_id`：由 supervisor 生成或派生，重试时保持稳定；
- `source='agent-propose'`；
- `intent_key='v1:agent-proposal'`；
- `state_fingerprint=<trusted proposal_id>`；
- `content_key`：只存 normalized title，不把完整模型正文作为去重键；
- `source_ref`：包含可审计的 session、turn、tool-call 关联标识，但不包含 secret 或完整案卷内容；
- task-only 的 normalized title、说明和证据引用摘要。

`proposal_id` 是幂等主键语义：同一 proposal ID 的 retry 返回已有 proposal，不重复插入；不同 proposal ID 即使 title 相同也保持为不同建议。标题规范化只用于展示稳定性和 `content_key`，不能把不同的 trusted proposal ID 折叠为一条。proposal 的 accept/decline 记忆只属于该 proposal ID；接受或拒绝后，新的事实必须由新的 proposal ID 表示，不因案件状态变化自动刷新、重开或重新接受旧建议。

现有唯一性约束已包含 `source`，因此 proposal 使用独立的 `source='agent-propose'` 后不需要初始 inbox migration。接受 proposal 时复用当前 human accept→task 逻辑，生成的 task 保持 `tasks.origin='llm'`；source-aware audit 记录 `agent-propose`，不为首版重建 task-origin CHECK 或迁移历史任务。

## 3. Supervisor 生命周期与恢复

### 3.1 启动和绑定

用户打开案件 assistant 且设置允许启用时，supervisor 先验证配置白名单和案件权限，再解析 `case_id` 到唯一真实案件夹。它生成 session ID，并固定记录：`case_id`、真实 `cwd`、worker PID、DSH 版本、provider/model（不含 key）、启动时间和状态。不得让模型通过 prompt 改变 `cwd`，也不得接受用户 YAML 提供的 skill root。

启动顺序固定为：

```text
enabled/credential gate
  → exact case cwd validation
  → spawn with sanitized environment
  → initialize
  → session/create
      → await anqi preset mount
  → session/preflight
      → exact scoped MCP registry + exact skill snapshot
  → session/prompt
```

每个案件最多一个 active worker。重复打开 drawer 复用该案件的 supervisor 状态，不重复 spawn；切换案件先取消前一案件未完成 turn，再建立后一案件 worker。worker 只可看到 anqi-owned preset、MCP 工具和 case-bound filesystem，不得获得 shell、web、subagent、workflow 或 ralph 工具。

### 3.2 Turn、取消和退出

同一案件的 prompt 必须串行。supervisor 为每个 turn 分配 turn ID，并持有可取消的 `AbortController`；超时、用户点击停止、页面离开、案件切换、server shutdown 或 worker disconnect 都会取消当前 turn。取消后不把部分 assistant 文本当成完成，不自动写入 proposal。

所有 `request/header`、`tool/call`、`tool/result`、assistant event、approval/question relay、错误和 `turn/end` 都经过 supervisor 的结构化事件管道。持久化或转发前做字段长度限制和 secret redaction；原始 key、Authorization header、内部 key 和完整敏感案卷正文不进入事件记录。浏览器只接收当前 authenticated user、case 和 session 有权看到的事件。

worker 退出后进入 `stopped` 或 `crashed`，而不是静默重试。supervisor 保存最后一个 turn 的终态、退出原因和可恢复边界。重启只允许从新的 turn 开始；不能假设 DSH 内存中的 session、未完成 approval 或未提交 proposal 仍然存在。重启后重新执行 `initialize → session/create → preflight`，并用新的 worker/session ID 关联审计。对已经成功写入的 proposal，依靠 `proposal_id` 幂等；对状态未知的写入先查询，不盲目重放。

## 4. 反向交互和 HTTP/SSE 安全

DSH 的 approval 与 user-question 继续走同一条扩展 JSON-RPC 通道。supervisor 只响应当前 live agent 的请求，并同时核对 `sessionId`、interaction ID、tool/call ID 和 one-shot 状态。答案必须有明确过期时间，成功消费后立即删除；未知、重复、格式错误、超时、断线、取消或 shutdown 一律 fail closed。approval 默认 `rejected` 或 `unavailable`，不能因 prompt 文本要求而变成 allow；user-question 不能伪造答案。

浏览器事件使用 authenticated SSE：连接必须验证登录身份、case 权限和 server-side session binding，并在每条事件上再次按 case/session 过滤。SSE 只用于下行事件，不承载 secret，也不把浏览器传来的任意 session ID 当作权限依据。

approval 和 user-question 的回答使用 authenticated one-shot answer POST。POST body 只包含 opaque interaction ID、受限 outcome 或严格校验后的答案；服务端从已存的 session binding 取得 case/agent，不信任客户端提交的 case/cwd。interaction 过期、已经消费、属于别的用户、属于别的 session 或 worker 已退出时返回拒绝，并将拒绝原因写入不含敏感值的审计记录。

proposal accept/decline 也必须走现有 authenticated human action，不允许模型调用 accept API。任何来自模型的 `source_ref` 只能帮助审计关联，不能代替当前用户授权。

## 5. UI 与设置

首版 UI 只需要案件 assistant drawer：状态徽标（disabled / starting / ready / running / stopped / error）、有限的 assistant 文本、工具调用摘要、可展开的错误和 proposal 卡片。proposal 卡片显示 normalized title、事实来源摘要、建议动作、产生时间和 accept/decline 按钮；不展示 key、内部 header、完整原始 JSON 或越权路径。

设置页只暴露白名单字段。`apiKeyEnv` 是变量名而不是输入框中的 key 值；provider 和 model 只能选择允许的值，`baseURL` 必须经过协议、credential-free 和允许域策略校验。保存配置时不得把进程环境变量展开写入数据库。禁用时显示“未启动”，并保证网络/MCP/child-process 计数均为零。

## 6. 交付门禁

进入主线前必须逐项获得真实证据：

1. 三条 seed demo 案件以外的数据不会进入模型请求；
2. `enabled=false` 在 credential、MCP、prewarm、spawn 之前短路；
3. 每个 worker 的 session、真实 `cwd` 和 case 权限不可被 prompt 改写；
4. 首个 `request/header` 同时含唯一 anqi skill 和精确 `mcp__anqi-local__case_folder_info`，且同一 turn 实际调用该工具；
5. approval/question 的 allow/reject/answer/timeout/disconnect/shutdown 路径均经过 session-bound、one-shot、fail-closed 验证；
6. proposal retry 保持 `proposal_id` 幂等，标题相同但 proposal ID 不同的建议不互相吞并；
7. proposal 接受后只复用现有人类 accept→task 路径，模型永远不能直接写 task/event/deadline；
8. 重启、取消、半完成 turn 和 worker 崩溃都有可审计终态；
9. UI、DB、SSE、logs、requests、error strings 全部通过 secret scan；
10. 关闭 sidecar 不改变现有 inbox、deadline、event 和任务主线行为。

在这些门禁完成前，sidecar 继续保持 spike/optional 状态；不因为静态 preset 或源码检查通过，就宣称模型-backed production readiness。
