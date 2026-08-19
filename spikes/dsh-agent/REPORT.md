# Spike A：anqi 内置 DSH sidecar 可行性报告

日期：2026-08-19
分支：`spike/dsh-agent`
DSH：`0.1.0-rc.7`
结论状态：**静态通路成立；demo 数据目的地与外部代码来源已获明确授权，但当前进程没有 `DEEPSEEK_API_KEY`，动态产品验收未执行；当前不建议合入生产。**

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
| A. anqi 3007 + seed + health/digest | 部分通过 | 真实跑通 seed、`/healthz`、`/internal/digest`；请求中的 unsafe-no-auth 形式被权限层拒绝，实际以更强的普通认证启动。 |
| B. 期限问答调用领域工具 | 未执行 | 无模型 key；未发起任何模型请求。driver 和三工具已实现并通过语法/静态注册检查。 |
| C. 待办建议进入 pending、无 deadline | 未执行 | 无模型 key；没有为了“凑结果”手工模拟 agent 写入。源码边界固定为 task-only。 |
| D. user skills + 本地 stdio MCP | 部分通过 | user skills 真实列出；MCP server 与命名规则有静态证据；未取得会话 `request/header` 运行证据。 |
| E. 无 UI 审批 fail closed + future answerer | 部分通过 | rc.7 实现与 README 明确返回 `unavailable`；未执行运行时审批请求，故没有把源码文字冒充“报错原文”。桥接位置已给出。 |
| F. 闭包、initialize、首 token、API 面 | 部分通过 | 247 MiB / 252,420 KiB、27,839 个 node_modules 文件、API 面完成；initialize 与首 token 未测。 |
| G. 单文件 / SEA | 未尝试（可选） | 遵守“无 key 先停”约束，未扩张到可选工作。 |
| H. 设置 schema | 通过 | 报告末尾提供草案。 |

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
@deepseek-ai/dsh-app-boot@0.1.0-rc.7
@deepseek-ai/dsh-base@0.1.0-rc.7
@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.7
@deepseek-ai/dsh-mcp-client@0.1.0-rc.7
@deepseek-ai/dsh-sdk-jsonrpc-demo@0.1.0-rc.7
@deepseek-ai/dsh-sdk-jsonrpc-server@0.1.0-rc.7
@deepseek-ai/dsh-tool-ask-user@0.1.0-rc.7
@deepseek-ai/dsh-tools@0.1.0-rc.7
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
| `dsh-agent-presets`（rc.7 间接包） | `agent.cordis.yml` 文件格式；未来 factory 需显式 `mount(agentCtx, id)`。stock server 未调用。 |
| `dsh-user-approval`（rc.7 间接包） | `policy: ask/never`；`approval/request` waterfall；缺 answerer → `unavailable`。 |
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
