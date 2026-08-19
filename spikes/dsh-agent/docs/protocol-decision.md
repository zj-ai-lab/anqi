# DSH rc.7 协议选型：扩展 JSON-RPC，而非 ACP

## 结论

anqi 选择 **保留完整事件流的扩展 NDJSON JSON-RPC**。ACP 在会话级 cwd、取消和断线清理上更完整，也原生桥接审批；但 rc.7 有意只向客户端发送已提交的 assistant message chunk，不转发 `request/header`、`tool/call`、`tool/result`、原始 assistant chunk 或 `turn/end`。律师侧无法据此还原模型看到了哪些工具、调用了什么、结果是否报错以及 turn 如何结束，这一缺口不能靠 UI 推断补齐。

本 PoC 因而保留 stock server 的完整 `session.event` 转发，只替换它硬编码的 session factory：在 factory `setup(agentCtx)` 中挂载 anqi preset，并利用同一条双向 stdio JSON-RPC 连接反向发出 `approval/request` 与 `user-question/request`。它仍是钉死 `0.1.0-rc.7` 编译产物内部字段的 spike，不是稳定协议承诺。

证据等级：**[S] 源码核实**；**[T] 实测**（仅指 `REPORT.md` 或本轮明确记录的运行）；**[D] 文档说法**。同一格有多个等级时逐项标注。

## 逐项对照

| 维度 | ACP（rc.7） | stock JSON-RPC（rc.7） | 本 PoC 的扩展 JSON-RPC | 判断 |
|---|---|---|---|---|
| 会话创建、cwd | **[S]** `session/new` 为每个 session 创建 agent，要求绝对 cwd；拒绝非空 `additionalDirectories` 与 client-supplied `mcpServers`。 | **[S]** `initialize({cwd, provider, model})` 保存进程级参数；首次 `session/prompt` 遇到未知 ID 才惰性创建 agent。没有 `session/new`。 | **[S]** 保持惰性创建，但覆写 factory，session meta 同时写 cwd 与 `agentPreset: anqi`。cwd 仍来自该进程的 initialize。 | anqi 采用“一案件一 worker”，不把 stock 的 sessions map 误当作不同 cwd 的隔离。 |
| 事件粒度 | **[S]** 只把已提交的 `assistant/message` 映射成 `agent_message_chunk`；过滤 raw chunk、reasoning、tool、plan、title、retry 和 `turn/end`。 | **[S]** 原样转发所有 `session/event`。**[T]** Spike A 已看到 `request/header`、首 chunk、`tool/call`、`tool/result`、`turn/end`。 | **[S]** 继承同一 server 构造器和 event forwarding，未重编码事件。 | 这是决定性差异；anqi 的律师侧透明度要求只能由完整事件流满足。 |
| 审批往返 | **[S]** 把 DSH `approval/request` 桥为 ACP `session/request_permission`，结果仅 allow-once / reject-once；源码测试覆盖取消和失败关闭。 | **[S]** wire 只有 initialize / prompt / shutdown；没有 answer RPC。**[T]** Spike A 越权写入得到 “requires approval, but no approval channel is available”。 | **[S]** agent scope 内监听 waterfall，从未决 `approval/asked` 审计事件认领 ID，经 `JsonRpcLineTransport.request()` 反向询问 driver；仅接受 `allowed-once \| rejected \| cancelled \| unavailable`，异常/畸形/超时均失败关闭。动态 reject/allow 实跑待授权会话复验。 | ACP 的权限桥不能弥补事件缺失；扩展 JSON-RPC 可同时保留审计事件和人工应答。 |
| user questions 往返 | **[S]** ACP bridge 没有注册 `ctx.userQuestions` provider。 | **[S]** 无问题 RPC；provider 缺失抛 `NO_PROVIDER`。**[T]** Spike A C 场景真实出现该错误。 | **[S]** 注册唯一 host provider，要求 exact live root agent；反向请求后逐项校验 session、ID/顺序、选项、多选和 custom text，再返回结构化 answer。取消、超时、断线均抛错，不代填。动态实跑待复验。 | 两个 stock 协议都不够；需要 anqi 自有桥。 |
| preset 挂载 | **[S]** ACP `newSession` 没有 preset composition。 | **[S]** stock `createSession()` 没有 `setup`，preset 服务会警告未加入 roster。 | **[S]** 覆写 `createSession()`，在 agent 发布前 await `agentPresets.mount(agentCtx, 'anqi')`；host 只保留 registry/service，persona 与 model-facing tools 只在 preset。**[T]** 回环失败端点 smoke 已证明 persona、fs/search、skill、todo、ask-user 各行可由真实 mount 出现在首 header；完整组合的本地插件路径改为相对 preset 文件解析，最终复跑待授权。 | 不能把 host scope 复刻或 default roster 当作真实 mount 证据。 |
| 取消 | **[S]** `session/cancel` 中止该 session admission/agent 并等待其收敛；不会取消同连接其他 session。 | **[S]** 无 session cancel；SIGTERM、EOF、shutdown 都是进程级。 | **[S]** 反向交互绑定 owning step 的 `AbortSignal`，shutdown 会取消未决审批/提问；尚未新增 session-level cancel。 | 一案件一 worker 时，进程级取消可作为 PoC 边界；主线若复用 worker，必须先补 session cancel。 |
| 单进程多 session | **[S]** 一条连接可持有多个独立 cwd/session，并分别 cancel/dispose。 | **[S]** 有 sessions map，但 cwd/provider/model 是 initialize 级；没有逐 session close。没有双 session 实测。 | **[S]** 保留 map 与 single-flight creation；每个 agent 都 mount 同一 standing preset，但仍共享进程级 cwd/provider/model。 | 数据结构上的“多个 ID”不等于生产级案件隔离；主线按每案 worker 设计。 |
| 断线与恢复 | **[S]** connection close 会取消并 dispose 该连接拥有的 session；不支持 list/load/resume/fork，属于清理而非续接。 | **[S]** stdin EOF/信号会 dispose root 并退出；shutdown 也结束进程。无 reattach。 | **[S]** transport close 会拒绝所有 pending reverse requests；失败不会转成允许或伪造答案。持久 JSONL 可供事后读取，但 wire 仍无 reattach。 | 两者均无断线续接；恢复需另定义基于持久 session log 的协议。 |
| rc.7 稳定性 | **[D]** release 是 prerelease，无生产稳定承诺。**[S]** ACP 有较多源码测试，但不等于生产稳定。 | **[T]** 仅在 2026-08-19 单机 B/C/E 场景实跑；cold 567–608 ms、首 chunk 1015–1796 ms。 | **[S]** subclass 访问 stock `.d.ts` 标成 private、但编译 JS 仍为普通属性的 `ctx/cwd/provider/model/maxTokens/sessions`；升级可能立即破坏。 | 只可作为钉版本 sidecar spike；升级 DSH 前必须重跑协议与组合验收。 |

## 实现边界与失败语义

1. 双向请求复用 `JsonRpcLineTransport.request(method, params, signal)`；request ID、pending response、abort listener 和 close rejection 都由 rc.7 transport 持有，本插件不建立第二套底层相关表。
2. approval ID 不由桥另造。`dsh-user-approval` 先追加 `approval/asked`，桥按 `callId`、`toolName`、未决/未认领状态找到该 ID；`approval/decided` 继续由原服务形成审计闭环。
3. driver 默认 `--approval reject`。只有显式 `--approval allow-once` 才返回 `allowed-once`；未知 session、重复 request ID、畸形字段都返回 JSON-RPC error。
4. `--question-answer` 未提供时，driver 返回错误；多个问题按 ` / ` 顺序映射。server 仍会按原问题逐项复核，绝不把 driver 字符串直接当成可信结构。
5. 同一 `request/header`、`tool/call`、`tool/result` 和 `turn/end` 仍来自 DSH session log；反向请求/响应是 supervisor 控制面，不伪装成模型工具。

## 已知缺口

- 没有 session-level cancel、不同 cwd 的单进程并发或断线 reattach。
- `createSession()` 与 apply wiring 复制了 stock rc.7 的小段实现，并依赖其编译后可访问的“private”字段；没有上游稳定扩展点。
- 本轮最终的 reject / allow-once / ask-user 三个有模型验收，以及相对路径修正后的完整 preset smoke，因当前执行权限未获准而不能标成通过；命令与预期证据必须由有既有授权的会话复跑后再更新 `REPORT.md`。

## 源码锚点

- stock server：`node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js`（事件转发 47–82；initialize 89–103；dispatch 155–161；factory 178–190；stdio apply 216–251）。
- bidirectional transport：`node_modules/@deepseek-ai/dsh-sdk-protocol/lib/index.js`（`request()`、incoming request/response 分类、close rejection）。
- approval：`node_modules/@deepseek-ai/dsh-user-approval/lib/index.js`；既有 ID 认领模式见 `node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js:1922` 起。
- user questions：`node_modules/@deepseek-ai/dsh-user-questions/lib/index.js:31-72`；严格答案匹配见 `node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js:1335-1351`。
- preset：`node_modules/@deepseek-ai/dsh-agent-presets/lib/index.js:707-734,954-960,1130-1158`；persona 的 agent-scope 覆盖见 `node_modules/@deepseek-ai/dsh-persona/lib/index.js`。
- ACP（exact tag `dsh-v0.1.0-rc.7`）：`packages/acp/acp/src/index.ts` 的 event filter、permission bridge、session creation、cancel 与 disconnect teardown。
- 既有实测：`REPORT.md` §12 B/C/E 与 §12.5。
