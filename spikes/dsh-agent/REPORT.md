# Spike A：anqi 内置 DSH sidecar 可行性报告

日期：2026-08-19
分支：`spike/dsh-agent`
DSH：`0.1.0-rc.7`
结论状态：**Spike A 通路成立并已实跑（§12）；Phase 2 已选定保留完整审计事件的扩展 JSON-RPC，并完成 response-loop / real-preset-mount 的源码实现（§13），但本轮最终动态复验被执行权限层拦截，不能把源码通过写成运行通过。仍不建议合入生产。**

## 1. 结论

DSH rc.7 可以作为 anqi 的进程外 sidecar：anqi 可用一个 Node supervisor 启动 `dsh-jsonrpc-agent`，通过换行分隔的 stdio JSON-RPC 发起会话；会话的 `cwd` 可固定到单个案件夹；anqi 自己的 Cordis 插件可以注册只读案件工具与“仅投递 task 建议”的 inbox 工具。供应商可以在 `deepseek-official` 与自定义 `openai-completions` 路由之间切换，key 只按环境变量名引用。

本次尚不能给出“可上线”的结论，原因有四项：

1. 当前 Claude Code 进程没有继承 `DEEPSEEK_API_KEY`。按任务书约束，没有 key 时不得空转或伪造 B/C/F 的动态结果。
2. 用户已将数据目的地明确限定为 `https://api.deepseek.com` / `deepseek-chat`，并授权执行 package-lock 完整性钉定的 DSH rc.7 与 js-yaml 4.3.1 闭包；但因 key gate 未通过，没有发生模型请求或模型侧数据传输。
3. rc.7 stock JSON-RPC 不挂载 agent preset，也没有审批/问答的 request-response RPC；这两项需要 anqi 自己扩展 agent factory / RPC bridge。
4. 未裁剪安装闭包为 247 MiB，直接装进桌面包偏重，仍需做依赖裁剪或单文件测量。

因此产品判断是：**sidecar 方向可继续，但须先完成 B/C 的去标识演示数据实跑、审批桥和打包裁剪，再决定进入主线。**

## 2. 实现边界

本 spike 只新增 `spikes/dsh-agent/`，未修改 `src/`、`server.js`、`public/`、根 `package.json` 或 `electron/`，也未修改 `~/.dsh` 下任何 profile/preset。

前五个交付提交按任务书顺序独立存在：

```text
36ec1fa spike(dsh): pin sidecar dependencies
62f29f1 spike(dsh): compose provider-neutral sidecar
5b8e159 spike(dsh): add loopback anqi domain tools
ff343c8 spike(dsh): add restricted anqi agent preset
037d8e2 spike(dsh): drive stdio JSON-RPC sessions
```

安全边界：

- sidecar 默认 `enabled: false`；`agent.config.yaml` 被 `.gitignore` 排除；
- `apiKeyEnv` 只能是环境变量名，缺失对应值时 driver 在 spawn 前退出；
- DSH 子进程的 `DSH_CORDIS_CONFIG` 被 driver 钉死到本 spike 的配置，父环境不能换成用户现有 profile；
- 案件夹必须是 `ANJIAN_FILES_ROOT` 下的单层、非隐藏、非符号链接真实目录；
- anqi URL 仅接受字面量 IPv4 `127.0.0.0/8` 或 IPv6 `::1`，不接受 DNS 名或远端地址；
- anqi key 只从 `process.env[internalKeyEnv]` 读取，不写配置、不打印；
- stderr、JSON-RPC 错误与事件输出都会按当前模型 key / internal key 的值做替换脱敏；
- 模型工具面没有 bash/pwsh、subagent、workflow、ralph 或 web；
- 唯一写工具固定调用 `POST /internal/inbox`，body 的 `kind` 固定为 `task`，`note` 只映射为允许字段 `basis`；
- 插件没有 event/deadline 写口，期限仍只由 anqi 确定性引擎产生。

## 3. 验收总表

| 项 | 状态 | 证据 / 阻塞 |
|---|---|---|
| A. anqi 3007 + seed + health/digest | ✅ 通过 | §4（首轮），§12 复用同一 seed 库 |
| B. 期限问答调用领域工具 | ✅ 通过 | §12.1：`anqi_digest` + `anqi_case_get` 并行调用，回答引用 anqi 数据并标注「演示数据非引擎推算」 |
| C. 待办建议进入 pending、无 deadline | ✅ 通过（有设计发现） | §12.2：`anqi_inbox_propose` 落 pending；deadlines 表前后 hash 一致；但触发了 L2 去重的「刷新覆盖」语义，见 §12.5 |
| D. user skills + 本地 stdio MCP | ✅ 通过 | §12.3：会话日志有 `skill-catalog` 用户消息（11 个技能）；第二个 `request/header` 含 `mcp__anqi-local__case_folder_info` |
| E. 无 UI 审批 fail closed + future answerer | ✅ 通过 | §12.4：`FS_SANDBOX_DENIED` → 升权重试 → 「requires approval, but no approval channel is available」，桌面文件未生成 |
| F. 闭包、initialize、首 token、API 面 | ✅ 通过 | 247 MiB；cold_ms 567–608；first chunk 1015–1796 ms；API 面见 §8.4 |
| G. 单文件 / SEA | 未尝试（可选） | 留给 Spike B |
| H. 设置 schema | ✅ 通过 | §11 |

## 4. A：anqi 隔离开发实例

### 4.1 seed（真实执行）

```sh
DB_PATH=./data/spike.db npm run seed
```

真实输出：

```text
种子完成：3 案 + 事件/期限/待办/日志/费用/分成 + 1 条收件箱演示（今天=2026-08-19）
```

数据均来自仓库 `tools/seed-demo.js`，没有使用真实案件。演示案件包括：

- 张三诉李四民间借贷纠纷
- 王五诉赵六买卖合同纠纷
- 陈七申请执行案

### 4.2 启动（真实执行，凭据按规则不记录）

任务书指定的 `ANJIAN_UNSAFE_NO_AUTH=1` 启动被本执行环境权限层拒绝。实际使用普通登录配置与测试 internal key 启动；所有值只在进程环境中提供，未写入仓库、日志或本报告。

等价的脱敏命令形状：

```sh
HOST=127.0.0.1 \
PORT=3007 \
DB_PATH=./data/spike.db \
ANJIAN_USER='<test-user>' \
ANJIAN_PASS_HASH='<redacted>' \
ANJIAN_INTERNAL_KEY='<redacted>' \
ANJIAN_FILES_ROOT=./data/files-dev \
node server.js
```

真实启动输出：

```text
anjian listening on :3007
```

### 4.3 health（真实执行）

```sh
curl --fail --silent --show-error http://127.0.0.1:3007/healthz
```

```json
{"ok":true}
```

### 4.4 digest（真实执行，节选）

```sh
curl --fail --silent --show-error \
  -H "X-Anjian-Key: $ANJIAN_INTERNAL_KEY" \
  http://127.0.0.1:3007/internal/digest
```

```json
{
  "date": "2026-08-19",
  "counts": {
    "active_cases": 3,
    "inbox_pending": 1,
    "open_tasks": 4,
    "unpaid_fees": 57000
  }
}
```

同一真实响应中的期限数据包括：

```json
[
  {"case_name":"张三诉李四民间借贷纠纷","name":"上诉期","due_on":"2026-08-21","days_left":2},
  {"case_name":"王五诉赵六买卖合同纠纷","name":"举证期限","due_on":"2026-08-25","days_left":6},
  {"case_name":"陈七申请执行案","name":"银行账户续冻申请","due_on":"2026-09-08","days_left":20}
]
```

上述数值只证明 anqi 的确定性数据面；没有把它们发送给模型。

## 5. B/C：领域工具与 inbox 写边界

插件注册三个工具：

- `anqi_case_get(name)`：读取一个精确案件名的案件、事件、期限、待办、近期日志与建议；显式白名单，永不返回 contacts；
- `anqi_digest()`：读取并白名单化 digest 各 bucket；
- `anqi_inbox_propose(case_name, title, note?)`：固定投递 `kind: "task"`，`priority: "normal"`，可选 note 映射为 `basis`。

静态注册检查曾真实得到：

```text
anqi_case_get
anqi_digest
anqi_inbox_propose
```

语法检查：

```sh
node --check spikes/dsh-agent/plugins/dsh-anqi/index.js
node --check spikes/dsh-agent/driver.mjs
node --check spikes/dsh-agent/mcp/server.mjs
```

三条命令均退出 0、无输出。

预定的 C 写请求只有以下形状：

```json
{
  "kind": "task",
  "case_name": "<exact demo case name>",
  "source_ref": "dsh-agent",
  "payload": {
    "title": "<up to 500 chars>",
    "priority": "normal",
    "basis": "<optional note, up to 1000 chars>"
  },
  "recommendation": {"intent": "case.next_action"}
}
```

anqi 的 `/internal/inbox` 服务端也独立拒绝非 task kind，且 `enqueueLlmSuggestion()` 只允许 `title`、`priority`、`basis`。这是双重约束，但不是 C 的动态验收替代品。

由于没有模型 key，本次未执行：

```sh
node driver.mjs --case '张三诉李四民间借贷纠纷' --ask '本案有哪些临近期限？'
node driver.mjs --case '张三诉李四民间借贷纠纷' --ask '帮我登记一个待办：下周三前整理证据清单'
```

因此没有可贴的 `tool/call`、`tool/result`、最终 assistant、pending inbox 或 deadline 前后差分；B/C 保持“未执行”。

## 6. D：skills 与本地 stdio MCP

### 6.1 user skills（真实静态检查）

```sh
find ~/.agents/skills -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort
```

真实输出：

```text
cubox
huashu-design
humanizer-zh
kinglex-oa
neat-freak
notion-movie-log
openclaw
research-to-diagram-repo
storage-analyzer
ui-ux-pro-max
wechat-digest
wkinfo
```

组合中加载了 `@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-skill-filesystem` 与 `@deepseek-ai/dsh-tool-skill`。但 stock JSON-RPC 运行未启动，尚无 `request/header` 或实际 skill call 能证明这些目录进入了会话；故 D 只部分通过。

### 6.2 本地 MCP

`mcp/server.mjs` 是纯本地 stdio server，只提供：

```text
case_folder_info() -> { cwd }
```

Cordis client 使用：

```yaml
serverName: anqi-local
transport: stdio
command: <current Node executable>
args: [<spike>/mcp/server.mjs]
cwd: <case folder>
```

rc.7 的 `dsh-mcp-client` 真实实现将公开工具名构造为：

```text
mcp__<serverName>__<rawName>
```

因此本 fixture 的预期名称为：

```text
mcp__anqi-local__case_folder_info
```

这是源码和组合的静态证据，不是会话可见性的运行证据。后续必须从 `session.event` 的 `request/header.data.header.tools` 中截取该名字，D 才能完全通过。

## 7. E：审批与未来 answerer

### 7.1 rc.7 当前行为

`@deepseek-ai/dsh-user-approval@0.1.0-rc.7` 的回答 vocabulary 是：

```text
allowed-once | rejected | cancelled | unavailable
```

其实现通过 Cordis waterfall 事件 `approval/request` 查找 answerer；没有 listener 或 listener 失败时，fallback 为：

```text
unavailable
```

README 同样明确写明：“No built-in answerer — headless or incompletely composed deployments resolve `unavailable` and fail closed.”

本组合在 `workspace-write` 下设置 `approval: ask`，所以没有 answerer 时不会静默放行。但本次没有执行产生审批的工具调用，故上面是**源码核实的行为**，不是任务书要求的“真实报错原文”；E 仍为部分通过。

### 7.2 为什么 stock JSON-RPC 不能回答

rc.7 stock JSON-RPC 的全部 client request 只有：

```text
initialize
session/prompt
shutdown
```

server notification 只有：

```text
session.event
session.status
subagent.started
subagent.finished
```

没有 approval request/answer，也没有 ask-user answer RPC。ACP 提供 permission bridge，但它属于另一协议，不能证明 stock JSON-RPC 已具备该能力。

### 7.3 anqi answerer 应放在哪里

未来应由 **anqi sidecar supervisor / 对话后端** 持有审批状态，新增一个 agent-scoped Cordis answerer 插件，并扩展 JSON-RPC：

1. 插件监听该 agent scope 的 `approval/request`，生成一次性 `requestId`，把 `{requestId, sessionId, action 摘要, cwd, expiresAt}` 发给 supervisor；
2. supervisor 通过 anqi 的已认证对话面呈现请求；
3. UI 回答后，supervisor 发送新增 RPC `approval/answer`：`{requestId, outcome}`；
4. 插件只接受同 session、未过期、未回答 request 的 `allowed-once | rejected | cancelled`；
5. 断线、超时、未知 request、重复回答全部解析为 `unavailable`；
6. 审批记录写入 anqi 审计日志，但绝不记录模型 key、internal key 或原始敏感文件内容。

该桥应在创建 agent 时经 factory 的 `setup(agentCtx)` 安装；同一位置也应调用 `ctx.agentPresets.mount(agentCtx, 'anqi')`。不要把 answerer 放进模型工具，也不要用 prompt 文本模拟授权。

## 8. F：数字与 rc.7 API 面

### 8.1 环境

```sh
node --version
npm --version
```

```text
v26.3.1
11.16.0
```

package 要求 Node `>=22`。

DeepSeek key gate（真实执行，不读取或输出值）：

```sh
node -e 'process.exit(process.env.DEEPSEEK_API_KEY ? 0 : 2)'
```

结果为退出码 2、stdout/stderr 均为空，表示当前进程未继承该变量。driver、DSH runtime 与模型请求因此均未启动。

### 8.2 闭包（真实测量）

```sh
du -sh spikes/dsh-agent
du -sk spikes/dsh-agent
find spikes/dsh-agent/node_modules -type f | wc -l
```

```text
247M    spikes/dsh-agent
252420  spikes/dsh-agent
27839
```

单独 `node_modules`：

```text
246M
252124 KiB
```

这是未裁剪的 npm 安装闭包，不是 Electron 打包后增量，也不是 SEA 体积。

### 8.3 依赖锁与审计（真实执行）

所有直接 DSH 依赖均精确钉在 `0.1.0-rc.7`：

```text
@deepseek-ai/dsh-agent-presets@0.1.0-rc.7
@deepseek-ai/dsh-app-boot@0.1.0-rc.7
@deepseek-ai/dsh-base@0.1.0-rc.7
@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.7
@deepseek-ai/dsh-mcp-client@0.1.0-rc.7
@deepseek-ai/dsh-persona@0.1.0-rc.7
@deepseek-ai/dsh-sdk-jsonrpc-demo@0.1.0-rc.7
@deepseek-ai/dsh-sdk-jsonrpc-server@0.1.0-rc.7
@deepseek-ai/dsh-sdk-protocol@0.1.0-rc.7
@deepseek-ai/dsh-session@0.1.0-rc.7
@deepseek-ai/dsh-tool-ask-user@0.1.0-rc.7
@deepseek-ai/dsh-tools@0.1.0-rc.7
@deepseek-ai/dsh-user-questions@0.1.0-rc.7
@deepseek-ai/schemastery@3.18.1
```

辅助依赖：

```text
@modelcontextprotocol/sdk@1.30.0
js-yaml@4.3.1
```

安装使用 `npm install --ignore-scripts`。审计：

```sh
npm audit --prefix spikes/dsh-agent --omit=dev
```

```text
found 0 vulnerabilities
```

曾短暂使用的 `js-yaml@4.2.0` 有高危 quadratic CPU advisory，已在锁文件形成前升级到 4.3.1；最终审计为 0。

### 8.4 实际依赖的 API/配置面

| 包 / 服务 | 本 spike 使用面 |
|---|---|
| `dsh-sdk-jsonrpc-demo` | bin `dsh-jsonrpc-agent`；argv config path；`DSH_CORDIS_CONFIG` 优先级。 |
| `dsh-sdk-jsonrpc-server` | Cordis plugin；`maxTokensAsSuccess: false`；三种 request 和四种 notification。 |
| `dsh-tools` | `defineTool()`、`ctx.tools.register()`、显式 output schema + render。 |
| `dsh-mcp-client` | `serverName`、stdio `command/args/env/cwd`、`toolCallTimeoutMs`、`failOnStartupError`；公开名 `mcp__*`。 |
| `dsh-llm-pi-ai` | `providers` 字典；`api: openai-completions`；`baseURL`、`apiKeyEnv`、`models`。 |
| `dsh-llm-deepseek`（由 base 闭包安装） | `apiKeyEnv`、`baseURL`、`models[].id`。 |
| `dsh-base` | 作为 rc.7 引擎闭包来源；其 patch 不是可直接作为 Cordis row 加载的插件，因此实际配置复制最小服务行。 |
| `dsh-agent-presets` | `roots/includeUserRoot`；factory `setup(agentCtx)` 中真实 `mount(agentCtx, 'anqi')`；standing composition 与 agent scope 绑定。 |
| `dsh-persona` | 在 mounted agent scope 覆盖 host-owned system-prompt registry 的 persona section，不发布新的 process-global service。 |
| `dsh-sdk-protocol` | `JsonRpcLineTransport.request()` 复用同一 stdio stream 发送 child-originated approval/question request；由 transport 管理 ID、pending、abort 与 close rejection。 |
| `dsh-session` | `SessionId()` branded ID；读取 session audit events 认领既有 `approval/asked.id`。 |
| `dsh-user-approval`（rc.7 间接包） | `policy: ask/never`；exact-agent `approval/request` waterfall；闭集 outcome；缺 answerer → `unavailable`。 |
| `dsh-user-questions` | 单个 host provider；exact live root-agent ownership；`UserQuestionError` 分类；严格 question/answer 匹配。 |
| `@modelcontextprotocol/sdk` | `McpServer`、`StdioServerTransport`、`registerTool()`。 |
| `js-yaml` | driver 的 `yaml.load()`，只解析五字段本地配置，并另做 unknown-field/type 校验。 |

### 8.5 实测 wire 面与文档差异

源码与安装产物一致的 rc.7 wire：

```text
initialize({ cwd, provider, model, maxTokens? })
  -> { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } }

session/prompt({ sessionId, contentBlocks })
  -> { messageId }

shutdown()
  -> {}
```

会话在首次 `session/prompt` 遇到未知 `sessionId` 时惰性创建；不存在 `session/new`、`session/create` 或 `tools/list`。

事件通过：

```text
session.event({ sessionId, event })
session.status({ sessionId, status: "running" | "idle" })
```

关键 event type：

```text
request/header
assistant/chunk
assistant/message
tool/call
tool/result
turn/end
```

包版本是 `0.1.0-rc.7`，但 wire `serverInfo.version` 固定返回 `0.0.1`。这不是本 spike 的版本写错，而是 rc.7 实现现状；升级回归不能只看 wire version。

旧注释中出现过 `session/prompt -> {accepted:true}`，实装和类型均为 `{messageId}`，driver 按实装处理。

### 8.6 未得到的时间数字

driver 已在真实返回时打印：

```text
[initialize] ... cold_ms=<spawn-before-initialize to response>
[metric] first_assistant_chunk_ms=<prompt send to first assistant/chunk>
```

但本次没有执行 DSH runtime，因此没有 cold initialize 或首 token 数值。两个字段必须在有 key、且明确允许只向选定 provider 发送 seed demo 数据后补测；不能以源码推算。

## 9. 关键踩坑

1. npm `latest` 不是目标版本；所有 DSH direct dependencies 必须精确钉 `0.1.0-rc.7`。
2. `@deepseek-ai/dsh-base` 是 profile/patch bundle，不是可以直接写成一个 runnable Cordis plugin row；外部 config 需要展开服务行。
3. `dsh-jsonrpc-agent` 没有内置 config fallback；argv 或 `DSH_CORDIS_CONFIG` 必须存在，且环境变量优先。
4. stdout 必须只含 JSON-RPC frame；诊断走 stderr。driver 分离两条流。
5. 非 `deepseek-official` provider 不会由 JSON-RPC server 自动挂 adapter；自定义 endpoint 必须在 initialize 前由组合注册。
6. `dsh-llm-pi-ai` rc.7 的 `providers` 是字典，不是旧示例中的数组。
7. stock JSON-RPC 不挂 agent preset。只加载 roster 也不够；必须在 agent factory 的 setup 路径调用 `agentPresets.mount()`。
8. stock JSON-RPC 没有 approval/ask-user answer RPC；`approval: ask` 在 headless 下返回 `unavailable`。
9. `session/prompt` 只是入队 receipt。driver 必须等待目标 session 的 `running -> idle`，并检查 `turn/end`；不能把 receipt 当最终结果。
10. 关闭 stdin 会触发 launcher 直接 dispose。正常结束应先 request `shutdown`，等待 response 与进程退出。
11. `DSH_CORDIS_CONFIG` 会覆盖 argv。driver 必须在子进程环境中把它钉死，否则用户 shell 的旧值可能换掉本 spike 的组合。
12. MCP/skill/persona 在 host scope 复刻只是 rc.7 stock server 的兼容办法；它不是 preset 挂载成功的证据。
13. 当前配置依靠 `dsh-base` 的一致版本闭包提供若干转移插件。正式化时应生成/校验完整 runtime manifest，避免未来 npm 嵌套布局改变后 bare plugin resolution 失效。
14. 当前闭包 247 MiB；在没有裁剪数据前，不能把“sidecar 可嵌入”推导成“适合直接塞进 Electron 安装包”。
15. rc.7 ACP 的 session cwd、cancel、断线 dispose 与 permission bridge 比 stock JSON-RPC 完整，但它有意只发 committed assistant message chunk；`request/header`、tool call/result、reasoning/raw chunk 与 `turn/end` 都不出 wire。anqi 的律师侧工具审计因此选择扩展 JSON-RPC，完整对照见 `docs/protocol-decision.md`。
16. `@deepseek-ai/dsh-system-prompt` 是 host service，不可作为普通 preset row 发布到 root realm；真实 mount 会拒绝 service leak。host 保留空 registry/service，preset 改用 scope-only `@deepseek-ai/dsh-persona`。
17. preset include 会把自己的 `baseUrl` 改到 `agent.cordis.yml` 所在目录；以 `.` 开头的 plugin 名相对此处解析。`../../plugins/dsh-anqi/index.js` 可静态确定为本 spike 插件 URL。rc.7 的 `PresetTree.import()` 源码也明确支持绝对路径，所以此前“绝对 `!!js process.cwd()` 行加入后 mount 同步停住”的观察**尚不能归因为绝对路径本身**；相对路径完整组合仍待动态复验。
18. stock class 的 `.d.ts` 把 `ctx/cwd/provider/model/maxTokens/sessions` 声明为 private，rc.7 编译 JS 却是普通属性。本 PoC subclass 访问这些字段并复制 stock `apply()` wiring；这是 exact-version spike 耦合，不是可升级的扩展 API。
19. approval/question 的反向请求必须复用 `JsonRpcLineTransport.request()`；child plugin 另建 ID/pending map 会与 transport 的 response classification、abort cleanup、close rejection 冲突。plugin 只保存 live agent↔session 与已认领 approval ID；driver 复用原有 client-request pending map，并额外记 active session 与已处理 child request ID。
20. `session/prompt` receipt 和 `idle` 都不单独代表成功。Phase 2 driver 同时要求目标 session 已出现 `running`、`idle` 与 `turn/end(reason.kind=completed)`；异常 turn/end 立即失败。

## 10. 后续动态验收步骤

目的地已拍板为 `deepseek-official` / `https://api.deepseek.com` / `deepseek-chat`，key 变量名为 `DEEPSEEK_API_KEY`。剩余前提是当前 Claude Code 进程实际继承该变量；key 值不得发到对话、写进命令、配置或日志。仅允许使用上述三条 seed demo 案件。

建议顺序：

1. 在 key gate 通过后，复制 `agent.config.example.yaml` 为被 gitignore 的 `agent.config.yaml`，设置 `enabled: true`、`provider: deepseek-official`、`baseURL: https://api.deepseek.com`、`model: deepseek-chat`、`apiKeyEnv: DEEPSEEK_API_KEY`；
2. 创建 seed 案件同名空案件夹，设置 `ANJIAN_FILES_ROOT`；
3. 启动 3007 的隔离 anqi 实例；
4. 先跑 initialize，记录 `cold_ms`、`serverInfo`、`request/header` 中的工具名与 skills；
5. 跑 B，保存 `anqi_case_get`/`anqi_digest` tool call/result、首 chunk 延迟和引用实际期限的最终回答；
6. C 前记录 `deadlines` 总数/hash，运行 task prompt，随后检查 pending inbox，并复查 deadlines 完全不变；
7. 单独触发一个需审批的 filesystem write，保存 `unavailable` 的真实 tool/result 与 `turn/end`；
8. `shutdown` 后确认子进程 exit 0；
9. 只把脱敏输出补进本报告。

## 11. 配置面 schema 草案

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://anqi.local/schemas/agent-settings.json",
  "title": "Anqi agent sidecar settings",
  "type": "object",
  "additionalProperties": false,
  "required": ["enabled", "perCaseAssistance"],
  "properties": {
    "enabled": {
      "type": "boolean",
      "default": false,
      "description": "全局启用 sidecar；false 时不得 spawn DSH。"
    },
    "provider": {
      "type": "string",
      "enum": ["deepseek-official", "openai-completions"]
    },
    "baseURL": {
      "type": "string",
      "format": "uri",
      "pattern": "^https?://",
      "description": "模型供应商 endpoint，不得包含用户名、密码或 API key。"
    },
    "model": {
      "type": "string",
      "minLength": 1
    },
    "apiKeyEnv": {
      "type": "string",
      "pattern": "^[A-Za-z_][A-Za-z0-9_]*$",
      "description": "只保存环境变量名，不保存 key 值。"
    },
    "perCaseAssistance": {
      "type": "string",
      "enum": ["off", "read-only", "suggest-tasks"],
      "default": "off",
      "description": "每案辅助档位；任何档位都不能让 AI 新建或修改 deadline/event。"
    }
  },
  "allOf": [
    {
      "if": {"properties": {"enabled": {"const": true}}, "required": ["enabled"]},
      "then": {"required": ["provider", "baseURL", "model", "apiKeyEnv"]}
    }
  ]
}
```

## 12. 动态验收补跑（2026-08-19，anqi 主会话）

运行方式：anqi 隔离实例（3007，`ANJIAN_UNSAFE_NO_AUTH=1` 回环 + 测试 internal key + seed 库 `data/spike.db`，案件夹 `data/files-dev/<案名>/`）；driver 由 `secretctl run anjian.local -- env … node driver.mjs …` 启动，`DEEPSEEK_API_KEY` 只注入该子进程，任何日志/本报告都不含 key 值。出站范围：`https://api.deepseek.com` / `deepseek-chat`，只发 3 个 seed 演示案的数据。

**先修了一处组合问题才跑起来**：`@deepseek-ai/dsh-permission-presets` inject `shell`，本组合刻意无 bash，导致 app-boot `assertEntriesActivated` 报 `1 entry did not activate … permission-presets: pending (waiting for service: shell)`，进程 exit 1（首个 `initialize`/`request/header` 已发出后才失败）。该行只是 sandbox 模式 + 审批策略的可切换预设 UI 面，真正旋钮是 `sandbox-policy.mode` 与 `user-approval.policy`，已从 `anqi.cordis.yml` 移除并注释原因。

### B 实跑片段（2026-08-19，deepseek-official / deepseek-chat，seed 演示数据）
```text
[initialize] {"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}} cold_ms=567.1
[metric] first_assistant_chunk_ms=1796.0
[tool/call] {"turn":1,"step":1,"callId":"call_00_xDLEmLtSn1JvIc7vRNjB8446","name":"anqi_digest","arguments":"{}"}
[tool/call] {"turn":1,"step":1,"callId":"call_01_LZoCjrb4oHhsIgs6heRM1276","name":"anqi_case_get","arguments":"{\"name\": \"张三诉李四民间借贷纠纷\"}"}
[tool/result] {"turn":1,"step":1,"message":{"source":{"kind":"tool","callId":"call_00_xDLEmLtSn1JvIc7vRNjB8446"},"content":[{"type":"tool-result","toolCallId":"call_00_xDLEmLtSn1JvIc7vRNjB8446","content":[{"type":"text","text":"{\n  \"date\": \"2026-08-19\",\n  \"counts\": {\n    \"active_cases\": 3,\n    \"inbox_pending\": 1,\n    \"open_tasks\": 4,\n    \"unpaid_fees\": 57000\n  },\n  \"red\": [\n    {\n      \"id\ …
[tool/result] {"turn":1,"step":1,"message":{"source":{"kind":"tool","callId":"call_01_LZoCjrb4oHhsIgs6heRM1276"},"content":[{"type":"tool-result","toolCallId":"call_01_LZoCjrb4oHhsIgs6heRM1276","content":[{"type":"text","text":"{\n  \"case\": {\n    \"id\": 1,\n    \"name\": \"张三诉李四民间借贷纠纷\",\n    \"case_no\": \"(2026)粤0305民初10001号\",\n    \"cause\": \"民间借贷纠纷\",\n    \"court\": \"深圳市南山区人民法院\",\n    \"procedure\": \"一审 …
[assistant] 本案（张三诉李四民间借贷纠纷，案号 (2026)粤0305民初10001号）的临近期限如下，数据均来自案齐引擎的期限/任务/费用台账，我只做读取和解释：
[turn/end] {"turn":1,"reason":{"kind":"completed"}}
[shutdown] {}
```

### C 实跑片段
```text
[initialize] {"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}} cold_ms=607.8
[metric] first_assistant_chunk_ms=1015.2
[tool/call] {"turn":1,"step":1,"callId":"call_00_3Xmb0uZZVqnhMPJ2FC1H6459","name":"anqi_case_get","arguments":"{\"name\": \"张三诉李四民间借贷纠纷\"}"}
[tool/call] {"turn":1,"step":1,"callId":"call_01_1KOthdZCy9sERIWNjQFA9450","name":"anqi_digest","arguments":"{}"}
[tool/call] {"turn":1,"step":2,"callId":"call_00_81i9ZmfGAHjmQ72ShWGY6300","name":"ask_user_question","arguments":"{\"questions\": [{\"id\": \"case\", \"header\": \"关联案件\", \"question\": \"这个\\\"整理证据清单\\\"待办要关联到哪个案件？\", \"options\": [{\"label\": \"张三诉李四民间借贷纠纷 (Recommended)\", \"description\": \"当前案件夹即此案，一审已判决、上诉期至 2026-08-21，可能配合上诉/二审证据组织。\"}, {\"label\": \" …
[tool/call] {"turn":1,"step":3,"callId":"call_00_MfA7kVTkaTj2rdADq6LC4452","name":"anqi_inbox_propose","arguments":"{\"case_name\": \"张三诉李四民间借贷纠纷\", \"title\": \"整理证据清单\", \"note\": \"用户原话：\\\"下周三前整理证据清单\\\"。按今日 2026-08-19（周三）推算，\\\"下周三\\\"即 2026-08-26 前，请律师确认具体截止日后再登记期限（本建议不承载期限）。默认关联本案：一审已于 2026-08-06 判决（部分胜诉）、上诉期至 2026-08-21 届满，此证据清单或与是否上诉/二审证据组织相关，与案内\\\ …
[tool/call] {"turn":1,"step":4,"callId":"call_00_ew8YVVvSQTIgrK0r2aH64279","name":"anqi_digest","arguments":"{}"}
[tool/result] {"turn":1,"step":2,"message":{"source":{"kind":"tool","callId":"call_00_81i9ZmfGAHjmQ72ShWGY6300"},"content":[{"type":"tool-result","toolCallId":"call_00_81i9ZmfGAHjmQ72ShWGY6300","content":[{"type":"text","text":"Error: no user-questions provider is registered"}],"isError":true}],"role":"user","id":"dcb6f687-46d2-4481-877c-94444da152bc"},"error":{"name":"UserQuestionError","code":"NO_PROVIDER"}}
[tool/result] {"turn":1,"step":3,"message":{"source":{"kind":"tool","callId":"call_00_MfA7kVTkaTj2rdADq6LC4452"},"content":[{"type":"tool-result","toolCallId":"call_00_MfA7kVTkaTj2rdADq6LC4452","content":[{"type":"text","text":"{\n  \"created\": false,\n  \"outcome\": \"refreshed_after_state_change\",\n  \"reason\": \"pending\",\n  \"item_id\": \"1\",\n  \"status\": \"pending\"\n}"}],"isError":false}],"role":"user","id":"9c19c372-bcff-4e7b-83a4-cf26b4c97a08"}}
[turn/end] {"turn":1,"reason":{"kind":"completed"}}
```

### E 实跑片段
```text
[tool/call] {"turn":1,"step":1,"callId":"call_00_r9PR4KzDo39oaEAjy3Uu5804","name":"write","arguments":"{\"file_path\": \"/Users/2_dogg/Desktop/anqi-spike-approval-test.txt\", \"content\": \"hello\"}"}
[tool/result] {"turn":1,"step":1,"message":{"source":{"kind":"tool","callId":"call_00_r9PR4KzDo39oaEAjy3Uu5804"},"content":[{"type":"tool-result","toolCallId":"call_00_r9PR4KzDo39oaEAjy3Uu5804","content":[{"type":"text","text":"Error: [sandbox: file access denied under workspace-write mode]\n[sandbox: escalation available — retry this exact operation once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]"}],"isError":true}],"role":"user","id":"de4bdfde-3a06-4607-b63a-319ef675f5d4"},"error":{"name":"FsError","code":"FS_SANDBOX_DENIED"}}
[tool/call] {"turn":1,"step":2,"callId":"call_00_lWOTr4aUii31K0oJ0m7Z2639","name":"write","arguments":"{\"file_path\": \"/Users/2_dogg/Desktop/anqi-spike-approval-test.txt\", \"content\": \"hello\", \"sandbox_permissions\": \"danger-full-access\", \"justification\": \"按用户沙箱测试指令，将一行 \\\"hello\\\" 写入案件夹之外的测试文件 /Users/2_dogg/Desktop/anqi-spike-approval-test.txt。\"}"}
[tool/result] {"turn":1,"step":2,"message":{"source":{"kind":"tool","callId":"call_00_lWOTr4aUii31K0oJ0m7Z2639"},"content":[{"type":"tool-result","toolCallId":"call_00_lWOTr4aUii31K0oJ0m7Z2639","content":[{"type":"text","text":"Error: sandbox escalation to \"danger-full-access\" requires approval, but no approval channel is available"}],"isError":true}],"role":"user","id":"b2345125-96b0-4654-b374-8ed8e63ed0ea"}}
[turn/end] {"turn":1,"reason":{"kind":"completed"}}
```


### 12.5 设计发现（进入主线前必须处理）

1. **inbox 去重把 agent 提案当成了 L2「每案一条下一步」**：`anqi_inbox_propose` 走 `/internal/inbox` → `enqueueLlmSuggestion()`，同 (source, kind, case, intent_key=`case.next_action`) 只保留一条活动建议，状态指纹变化即「刷新覆盖」——本次实跑返回 `created:false, outcome:refreshed_after_state_change, item_id:1`，seed 原有的 pending 建议「张三案：若决定上诉…」被覆盖成「整理证据清单」。agent 提出的是任意条数的具体待办，不是周期检视；主线需要为 agent 提案开独立 source（如 `agent-propose`）或 per-proposal intent，并复用 inbox 的 accept/decline 裁决面。
2. **`ask_user_question` 与审批一样缺 answerer**：rc.7 无 UI 时返回 `UserQuestionError NO_PROVIDER`（"no user-questions provider is registered"）；模型这次自行退回默认值并把假设写进备注——行为得体，但 anqi 的对话面必须同时实现 approval answerer 与 user-questions provider 两条回路。
3. **skills 根目录范围**：`skill-filesystem` 默认扫用户全局 `~/.agents/skills`，本次目录里出现了 onepassword-secrets / wechat-digest / openclaw 等与办案无关、且涉及个人凭据的技能。anqi 组合应设 `includeDefaultRoots: false` + `customSkillDirs` 指向 anqi 自有技能根，按最小暴露原则。
4. **MCP 冷启动竞态**：首个模型请求的 header 里没有 `mcp__*` 工具，第二个请求（reason=change）才有；DSH 会在工具集变化时重发 header，功能上无碍，但首轮回答可能看不到 MCP 工具，anqi supervisor 可在 initialize 后等待一次工具集稳定再放行首个 prompt。
5. **数字**：cold_ms 567.1 / 607.8；first_assistant_chunk_ms 1796.0 / 1015.2（含一次 DeepSeek 往返）；未裁剪闭包 247 MiB。

## 13. Phase 2 / Commit 1：扩展 JSON-RPC 与真实 preset mount

### 13.1 决策与实现

协议决策见 `docs/protocol-decision.md`。简要结论：继续使用 NDJSON JSON-RPC，并保留 stock server 对完整 `session.event` 的原样转发；不把 rc.7 ACP 用作唯一 anqi wire，因为 ACP 丢弃律师侧审计所需的 header/tool/result/turn 事件。

spike-local `plugins/dsh-anqi-jsonrpc/index.js` subclass `HarnessSdkJsonRpcServer`，只替换 session factory，并复刻 stock `apply()` 中无法注入 subclass 的 stdio wiring。factory 在 agent 发布前通过 `setup(agentCtx)` await `agentPresets.mount(agentCtx, 'anqi')`。审批 listener 安装在该 exact agent scope，question provider 只接受由本 server 持有且仍 live 的 root agent。两类交互都在原 stdio transport 上由 server 发 request、driver 回普通 JSON-RPC result/error；失败、断线、超时和畸形响应不会变成允许或伪造答案。

### 13.2 分级验收矩阵

| 验收项 | 状态 | 证据等级与结果 |
|---|---|---|
| local server / driver 语法 | ✅ 通过 | **[本机实测]** 两个 `node --check` 均 exit 0、无输出。 |
| direct dependency 钉版本 | ✅ 通过 | **[本机实测]** 13 个 DSH direct package 均为 `0.1.0-rc.7`；`schemastery@3.18.1`、`js-yaml@4.3.1`；`npm audit --omit=dev` 为 0 vulnerabilities。 |
| driver 默认拒绝与 CLI 校验 | ✅ 通过 | **[本机实测]** help 明示 default reject；非法 `--approval always` 在 spawn 前 exit 1。 |
| bidirectional request、agent ownership、失败关闭 | ✅ 源码通过 | **[源码核实]** 复用 transport pending/abort/close；闭集 outcome；session/approval/question ID 与 exact live agent 校验。尚非动态验收替代。 |
| real mount：persona + fs/search + skill + todo + ask-user 子集 | ✅ 通过 | **[本机 no-secret smoke]** dummy key、模型 endpoint `127.0.0.1:9`；逐行增加 preset 后，首个 initial header 实际出现 persona 及 `read/write/glob/grep/edit/read_image/skill/todo_write/ask_user_question`。没有模型成功请求或 demo 数据外发。 |
| real mount：完整 preset（含 dsh-anqi 三工具） | ⚠️ 部分 | **[本机 no-secret smoke]** 使用绝对 `!!js process.cwd()` 名称时 `session/prompt` 未回 receipt，15 s 后 smoke 杀进程；逐行二分只定位到加入该 row 后出现。源码同时表明 absolute 与 relative 均应受支持，故不能声称根因已确定。已改为 preset-owned 相对名 `../../plugins/dsh-anqi/index.js`，静态解析到正确 file URL；最终动态复验被权限层拦截。 |
| reject：Desktop write 不落盘 | ⛔ 未复验 | 需要模型实际发起 sandbox escalation；当前 DSH 执行权限被拒，未创建或改动 Desktop 文件。 |
| allow-once：只写 exact `hello` 并删除 | ⛔ 未复验 | 同上；没有把源码路径写成实际批准证据。 |
| ask-user：`关联张三案 / 2026-08-26` | ⛔ 未复验 | reverse request/response 已实现，尚无真实 `tool/result` 与 assistant 复述。 |
| 首个 initial header 来自完整 mounted preset | ⛔ 未复验 | 子集有实测，完整组合尚无动态 header；Task 3 的 MCP readiness 也不在本 commit 冒充完成。 |

最后一次 full-preset smoke 被权限层以执行外部 package code 为由拒绝。本会话没有换工具或委托其他 session 绕过。以上矩阵故意把 **源码核实 / 子集 smoke / 完整动态** 分开；被拦的行保持未复验。

### 13.3 待有权限会话原样复跑的命令

前置条件：已按 §12 运行 seed 隔离 anqi（3007），`spikes/dsh-agent/agent.config.yaml` 只写 `enabled/provider/baseURL/model/apiKeyEnv` 且不含 key；`secretctl run anjian.local` 只向子进程注入 `DEEPSEEK_API_KEY` 与测试 `ANJIAN_INTERNAL_KEY`。下列命令都只使用 seed demo 案件，并按本机默认 zsh 语法执行：

```zsh
# 1. 默认 reject：先确认目标不存在；结束后仍须不存在。
test ! -e /Users/2_dogg/Desktop/anqi-spike-approval-test.txt
secretctl run anjian.local -- env \
  ANJIAN_FILES_ROOT="$PWD/data/files-dev" \
  ANQI_BASE_URL=http://127.0.0.1:3007 \
  DSH_PERMISSION_MODE=workspace-write \
  node spikes/dsh-agent/driver.mjs \
  --case '张三诉李四民间借贷纠纷' \
  --approval reject \
  --ask '请尝试将内容严格为 hello 的文件写入 /Users/2_dogg/Desktop/anqi-spike-approval-test.txt；如果沙箱要求审批，请按工具要求原样重试。不要改写其他文件。'
test ! -e /Users/2_dogg/Desktop/anqi-spike-approval-test.txt

# 2. allow-once：文件内容必须逐字节等于 hello；核验后立即删除。
test ! -e /Users/2_dogg/Desktop/anqi-spike-approval-test.txt
secretctl run anjian.local -- env \
  ANJIAN_FILES_ROOT="$PWD/data/files-dev" \
  ANQI_BASE_URL=http://127.0.0.1:3007 \
  DSH_PERMISSION_MODE=workspace-write \
  node spikes/dsh-agent/driver.mjs \
  --case '张三诉李四民间借贷纠纷' \
  --approval allow-once \
  --ask '请尝试将内容严格为 hello 的文件写入 /Users/2_dogg/Desktop/anqi-spike-approval-test.txt；如果沙箱要求审批，请按工具要求原样重试。不要改写其他文件。'
cmp -s /Users/2_dogg/Desktop/anqi-spike-approval-test.txt <(printf %s hello)
rm -- /Users/2_dogg/Desktop/anqi-spike-approval-test.txt

# 3. ask_user_question：必须出现 request、response、非错误 tool/result 与最终复述。
secretctl run anjian.local -- env \
  ANJIAN_FILES_ROOT="$PWD/data/files-dev" \
  ANQI_BASE_URL=http://127.0.0.1:3007 \
  DSH_PERMISSION_MODE=workspace-write \
  node spikes/dsh-agent/driver.mjs \
  --case '张三诉李四民间借贷纠纷' \
  --question-answer '关联张三案 / 2026-08-26' \
  --ask '对于“下周三前整理证据清单”这项待办，请先且只调用一次 ask_user_question，一次提出两个问题：关联案件、计划日期。不要自行代答；收到回答后逐字复述两个答案，不调用其他工具，也不要提交待办。'
```

复跑还必须检查同一 session 的第一个 `request/header`：`reason` 为 `initial`，system 含“中国执业律师”，tools 至少含 `anqi_case_get`、`anqi_digest`、`anqi_inbox_propose`、`ask_user_question`，且不含 bash/subagent/workflow/web。Task 3 另行要求这个**第一个** header 同时含 MCP 工具；不能用后续 `reason: change` 代替。
