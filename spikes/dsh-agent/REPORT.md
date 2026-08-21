# Spike A：anqi 内置 DSH sidecar 可行性报告

日期：2026-08-19
最后更新：2026-08-21（补跑 Commit 1 response loop 与 full-preset mount 的四项 ⛔/一项 ⚠️ 动态复验，见 §13.4；此前 Commit 3 model-backed readiness redacted run；同日补跑 anqi domain tools read deadlines，注入 `ANJIAN_INTERNAL_KEY` 后动态通过；同日晚些修复轮：§14.4/14.5 与 `docs/packaging-numbers.md` 的 5 处审查发现——cold_ms 数字张冠李戴、tool-call「逐项一致」措辞、§14.7 命令缺失注入变量、临时 SEA driver 副本描述有误、驱动/打包 exit code 与 hash 前后快照证据补强——已逐条核实修正，见对应小节；同日收尾轮：头部结论状态、§1 四点与 §3/§15.3 尾句原先仍写 actual B trace/trace-derived scratch/SEA build「被阻塞」，与 §14.4–14.6 已记录的真实动态结果不一致，本轮据 §14/§15 现状重写；同日第二次修复轮（审查发现 8 处）：packaging-numbers.md 与 §14.1/§14.3 里已被 §14.4 动态核实的 actual MCP child trace / 四类 native reach 结论仍误写成 `[B]`/「未运行」/「没有 actual B trace」，已改为 `[M]`；§8.1/§8.6 的 2026-08-19 pre-run 快照句补充「见 §12」指针；SEA driver 副本 diff 行数（实为 3 处改动共 11 行，非「仅 8 行」）与 fixup 重跑「产物体积与首次一致」均已用新的同长度 `--output` 名重跑核实（体积随文件名字符串长度变化，仅在等长时逐字节复现）；SEA 打包工具目录体积换日复测确认漂移（44,220→43,248 KiB）；§15.3/§15.4bis 的 deadlines 跑前/跑后 hash 与 §14.4 的证据等级已对齐，本轮独立重算跑前基线并留痕，跑后基线复现同一 `secretctl authorization timeout` blocker，未能补拍模型-backed 跑后快照）；同日第三次修复轮（复审发现 4 处证据卫生问题）：§14.5/`docs/packaging-numbers.md` 声称的重建产物体积一致此前只有 `EXIT=0`、无 `stat`/`cmp` 留痕，本轮对仍留存的首次产物与新建的同长度（33 字符）对照名重跑并把命令/`stat`/`cmp` 完整写入 `wf-logs/sea-size-proof.log`；「52 字符」按 `wc -c` 实测更正为 51 字符；§15.3 该行证据栏按 §14.6 惯例补「见 §15.4bis 证据等级说明」并把「跑前/跑后…完全一致」改为「跑前基线独立留痕、跑后为与已知 seed 基线比对未变化」；§14.5/packaging-numbers.md 补记此前遗漏的一次 `fetch failed` 失败构建，与本轮新构建合并计数为 4 次尝试、1 次网络失败）
分支：`spike/dsh-agent`
DSH：`0.1.0-rc.7`
结论状态：**Spike A 通路成立并已实跑（§12）；Phase 2 Commit 1 的扩展 JSON-RPC response loop / real preset mount（§13）已于 2026-08-21 完成动态复验：full-preset mount、reject/allow-once 审批闭环、ask-user 反向问答与首个 initial header 的完整工具集均由真实模型-backed redacted wire 证实（§13.4）。Commit 2 的 actual B loaded trace、trace-derived reached-only scratch 闭包及其 B 复跑、SEA build 均已由 2026-08-21 的本机真实执行动态通过（§14.4–§14.6）：固定 B 场景 reached 84/363 dependency roots（23.14% 包数／35.46% 字节数），scratch 闭包（71,444 KiB，`tar.gz` 19,235,570 B，相当于 v2.6.0 arm64 DMG 的 13.70%）连续 3 次成功复跑，SEA packager exit 0 产出已签名 executable + helper；唯一仍未达成的是 **SEA runtime 完整 B end-to-end**——`initialize`/`session/create` 3/3 成功，但 `session/preflight` 因真实的 `extension ".mjs" not supported` include 不兼容三次全部失败（非权限拦截），仍为 ⚠️ 部分通过。Commit 3 的 anqi-owned skill isolation / exact-agent preflight / first-request gates（§15）已由真实模型-backed redacted wire 动态通过，含此前受 `ANJIAN_INTERNAL_KEY` 缺失阻塞、现已补跑通过的 anqi domain tools 期限读取（§15.4bis）。仍不建议合入生产：产品方向与交互闭环已验证，但 SEA 打包路线需先修复 `.mjs` include 不兼容并补一次完整 B end-to-end，且 `docs/mainline-plan.md` §6 的十项交付门禁（supervisor 生命周期、proposal 去重、HTTP/SSE 鉴权等）尚待落地为代码。**

## 1. 结论

DSH rc.7 可以作为 anqi 的进程外 sidecar：anqi 可用一个 Node supervisor 启动 `dsh-jsonrpc-agent`，通过换行分隔的 stdio JSON-RPC 发起会话；会话的 `cwd` 可固定到单个案件夹；anqi 自己的 Cordis 插件可以注册只读案件工具与“仅投递 task 建议”的 inbox 工具。供应商可以在 `deepseek-official` 与自定义 `openai-completions` 路由之间切换，key 只按环境变量名引用。

本次尚不能给出“可上线”的结论，原因有四项：

1. Phase 1 已用去标识 seed demo 实跑 B/C/E/F；Phase 2 Commit 1 的 real-preset interactive response loop（full-preset mount、reject/allow-once、ask-user、首 header）已由 2026-08-21 真实模型-backed redacted wire 动态通过（§13.4）；Commit 2 的 actual B trace、trace-derived scratch B 复跑、SEA build 同样已由本机真实执行动态通过（§14.4–§14.6）；Commit 3 readiness gate 也已获得真实模型-backed wire 证据（§15.3）。仍为 ⚠️ 部分通过的只剩 SEA runtime 完整 B end-to-end（见第 4 点）。
2. 首个 `request/header` 早于 MCP ready、默认 skills root 暴露用户技能的 Phase 1 问题，已由 Commit 3 的 exact-agent preflight、materialized anqi-owned skill root、首 header 门禁和同 turn MCP call 动态复验覆盖；anqi domain data read 此前受 `ANJIAN_INTERNAL_KEY` 注入缺失阻塞，已于 2026-08-21 补跑注入后动态通过，成功读回本案期限且未改动 `deadlines` 表（§15.4bis）。
3. 未裁剪安装闭包为 252,160 KiB / 179,023,145 regular-file bytes——这一步是 [M] 本机测量，早已完成；actual B loaded trace 与 trace-derived scratch B 复跑此前确实未获执行，但已于 2026-08-21 补跑并动态通过（§14.4）：固定 B 场景 `complete=true`，reached 84/363 dependency roots（23.14% 包数／35.46% 字节数，14 个为 direct dependency）；按 reached 包物理复制得到的 trace-derived scratch 闭包（71,444 KiB，`tar.gz` 19,235,570 B，相当于 v2.6.0 arm64 DMG 的 13.70%）连续 3 次成功 B 复跑，`deadlines` 表内容与已知 seed 基线比对保持一致，未被写入或修改。唯一残留缺口：本轮尝试为该次 scratch 复跑单独补一组「跑前/跑后」成对快照时，`secretctl run anjian.local` 本身持续 `authorization timeout`（`env echo hello` 亦可复现，非命令语法问题），该项仍为 **[B] blocked**，不影响闭包测量与 3 次成功复跑本身的结论。
4. symlink-free full staging 与压缩测量已完成；exact `@yao-pkg/pkg@6.21.0 --sea` 已于 2026-08-21 真实执行成功（此前一轮的「权限层拒绝」未复现），exit 0，产出 main executable（176,279,520 B，Mach-O arm64，含 pkg 自带 ad-hoc 签名）与相邻 `spawn-helper`（50,480 B）。运行时验证部分成功：`initialize`/`session/create` 3/3 次动态通过（cold_ms 334.5–796.7，仅到 `session/create`），但 `session/preflight` 三次全部因真实的 `extension ".mjs" not supported` include 错误失败——packaged runtime 的 Cordis include loader 拒绝对 snapshot 之外、留在宿主磁盘上的 `mcp/server.mjs` 做动态 include，这是本轮真实执行发现的具体不兼容点，不是权限拦截。因此完整 B end-to-end 与「一次完整 turn 的 cold initialize/首 token」仍未达成，SEA 尚不可用作交付路径。

因此产品判断是：**sidecar 的交互闭环（域工具读取/写边界、审批 fail-closed、ask-user、skill 隔离、首请求门禁、response loop）已全部由真实模型-backed 动态跑验证通过，方向确认可继续；闭包侧结论也已从「未测」变为「已测」——若要 bundle 运行时闭包，应 bundle trace-derived 的 reached-only scratch 闭包（约 71,444 KiB，相当于 DMG 的 13.70%），不要 bundle 现有全闭包（252,160 KiB，占比更高）或 SEA 单文件（本身已比整个 DMG 大，且因真实的 `.mjs` include 不兼容尚未跑通完整 B 场景）。在（a）修复 SEA 打包的 `.mjs` include 问题并补一次 SEA 下完整 B end-to-end + 3 次完整-turn cold initialize，以及（b）按 `docs/mainline-plan.md` §6 的十项交付门禁把 supervisor 生命周期、agent-proposal 去重与幂等、approval/user-question 的 authenticated one-shot 回路、HTTP/SSE 鉴权等设计条目落地为可审查的代码之前，仍不进入生产主线。**

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
| F. 闭包、initialize、首 token、API 面 | ✅ 通过 | Phase 1：247 MiB、cold_ms 567–608、first chunk 1015–1796 ms。Phase 2：full closure/staging 已量化；actual B trace（reached 84/363 deps）与 trace-derived scratch（3 次成功 B 复跑）已于 2026-08-21 动态通过，见 §14.4。 |
| G. 单文件 / SEA | ⚠️ 部分 | exact upstream route、symlink-free staging 与 SEA build 均已由 2026-08-21 真实执行验证（exit 0，executable 已签名）；`initialize`/`session/create` 3/3 动态成功，但 `session/preflight` 因真实的 `.mjs` include 不兼容三次全部失败，完整 B end-to-end 未达成，见 §14.5。 |
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

结果为退出码 2、stdout/stderr 均为空，表示当前进程未继承该变量。driver、DSH runtime 与模型请求因此均未启动。这是 2026-08-19 当时的快照；拿到 key 后同日已实跑 B/C/E/F 并给出 cold_ms/first-token 数值，见 §12。

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

但本次没有执行 DSH runtime，因此没有 cold initialize 或首 token 数值。两个字段必须在有 key、且明确允许只向选定 provider 发送 seed demo 数据后补测；不能以源码推算。这是 2026-08-19 当时的快照；两个字段已于同日补测并记入 §12（`cold_ms=567.1`、`first_assistant_chunk_ms=1796.0`，另见 §3 acceptance 表 F 行）。

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
| real mount：完整 preset（含 dsh-anqi 三工具） | ✅ 通过 | **[2026-08-21 模型-backed redacted wire，见 §13.4 run(a)]** preset 已固定为 preset-owned 相对名 `../../plugins/dsh-anqi/index.js`；真实 `--case '张三诉李四民间借贷纠纷' --ask '本案有哪些临近期限？'` 跑通：同一 session `session/prompt` 正常返回 receipt，未再出现无 receipt 卡死。此前的绝对路径卡死现象未复现，本次改动后可稳定动态通过。 |
| reject：Desktop write 不落盘 | ✅ 通过 | **[2026-08-21 模型-backed redacted wire，见 §13.4 run(b)]** `--approval reject` 下模型两次尝试写入（先无 escalation 被 sandbox 拒绝，再带 `sandbox_permissions: danger-full-access` 重试），`approval/response.outcome` 为 `rejected`，对应 `tool/result` 原文含 `Error: the user rejected escalating this operation to "danger-full-access"`；跑前跑后 `/Users/2_dogg/Desktop/anqi-spike-approval-test.txt` 均确认不存在。 |
| allow-once：只写 exact `hello` 并删除 | ✅ 通过 | **[2026-08-21 模型-backed redacted wire，见 §13.4 run(c)]** `--approval allow-once` 下同一 escalation 请求的 `approval/response.outcome` 为 `allowed-once`；`cmp` 核验目标文件内容逐字节等于 `hello`，取证后立即 `rm` 并以 `test !` 确认已删除。 |
| ask-user：`关联张三案 / 2026-08-26` | ✅ 通过 | **[2026-08-21 模型-backed redacted wire，见 §13.4 run(d)]** `ask_user_question` 的 `tool/result` 精确回显注入答案 `{"target_case":"关联张三案","due_date":"2026-08-26"}`；assistant 复述并把两个答案写入 `anqi_inbox_propose` 的 `note` 参数；`deadlines` 表内容与已知 seed 基线哈希 `aefb85ec4d2c041dcfeeace81342c0c82ee9bf7c159982fbd2ec60b50139fb21` 比对一致，未被写入或修改（该次跑无独立留痕的跑前/跑后成对快照，证据等级说明见 §13.4 run(d) 末尾）。 |
| 首个 initial header 来自完整 mounted preset | ✅ 通过 | **[2026-08-21 模型-backed redacted wire，见 §13.4 run(a)]** run(a) 首个 `[request/header]` 的 `reason` 为 `initial`，`system` 含持久化人设文本（"中国执业律师"），`tools` 数组同时含 `anqi_case_get`/`anqi_digest`/`anqi_inbox_propose`（dsh-anqi 三工具）与 `mcp__anqi-local__case_folder_info`（MCP），且同一 turn 内该 MCP 工具被实际调用（`tool/call`→`tool/result`）。 |

以上四项 ⛔ 与一项 ⚠️ 均已由 2026-08-21 的真实模型-backed 动态跑替换为 ✅；跑法与脱敏证据见 §13.4。跑前的绝对路径 preset smoke 卡死问题未在本次相对路径配置下复现，§9 踩坑 #17 的结论（相对路径不受此前观察到的现象影响）得到动态确认。

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
  --ask '帮我登记一个待办：下周三前整理证据清单'
```

复跑还必须检查同一 session 的第一个 `request/header`：`reason` 为 `initial`，system 含“中国执业律师”，tools 至少含 `anqi_case_get`、`anqi_digest`、`anqi_inbox_propose`、`ask_user_question`，且不含 bash/subagent/workflow/web。Task 3 另行要求这个**第一个** header 同时含 MCP 工具；不能用后续 `reason: change` 代替。命令 3 的 prompt 改为 §5/§12 C 场景原话（不再人工约束模型只调用一次 `ask_user_question`），因为 §13.4 run(d) 的动态复验确认：即使不加约束语句，模型也可能在同一 turn 内自主决定是否调用 `ask_user_question`（依赖当时 inbox 的既有 pending/declined 状态与随机采样），受控约束语句反而会让模型跳过真实的写路径（`anqi_inbox_propose`），无法同时验证"注入答案"与"提案 note 反映该答案"两项。

### 13.4 2026-08-21 动态复验：four ⛔ + 一项 ⚠️

按 §13.3 命令原样跑（命令 3 的 prompt 已按上条说明调整），只用 seed 三案；隔离 anqi（`ANJIAN_UNSAFE_NO_AUTH=1` 回环 + 测试 internal key + `data/spike.db`）在 3007 起停；`secretctl run anjian.local` 只向 driver 子进程注入 `DEEPSEEK_API_KEY`/`ANJIAN_INTERNAL_KEY`，key 值全程未回显、未落盘；跑前对四个日志与 key 值均做过 grep 复查，零命中。每次跑完后 driver 子进程自然退出：run(a)/(d) 以 `[shutdown]` 后 exit 0 结束；run(b)/(c) 因下文 run(b) 末尾所述的 MCP 门禁提前以 exit 1 结束，日志末行是 `driver: turn did not call mcp__anqi-local__case_folder_info` 而非 `[shutdown]`——四跑均未遗留常驻进程，只是退出路径不同；3007 在全部四跑结束后 `kill` 并以 `lsof -iTCP:3007 -sTCP:LISTEN` 确认端口已释放（本行连同下方 run(b)/(c) 的文件核验、`cmp`/`rm`、四跑 exit code 均属叙述性描述，无独立 shell 侧留痕，证据等级说明见 run(d) 之后）。

**run(a) full-preset + B 问题**（`verify13-a-fullpreset-B.log`；`--case '张三诉李四民间借贷纠纷' --ask '本案有哪些临近期限？'`，无 `--approval`/`--question-answer`）：

- `[session/preflight]` 的 `tools.visibleNames` 一次性含 `mcp__anqi-local__case_folder_info`、`anqi_case_get`、`anqi_digest`、`anqi_inbox_propose`、`ask_user_question`、`read/write/edit/glob/grep/skill/todo_write/read_image`；`skills.names` 精确为 `['anqi-case-brief']`；
- 首个 `[request/header]` 的 `"reason":"initial"`；`system` 含持久化人设原文“你是一名中国执业律师的办案 AI 助理”；`tools` 数组同时含 dsh-anqi 三工具与 `mcp__anqi-local__case_folder_info`（无 bash/subagent/workflow/web）；
- 同一 `turn:1` 内先调用 `skill`（加载 `anqi-case-brief`），再并行调用 `mcp__anqi-local__case_folder_info`（返回精确 seed 案件夹 cwd）、`anqi_digest`、`anqi_case_get`，均成功返回；
- 最终 assistant 回答逐项引用上诉期（判决，due 2026-08-21，民诉法 §171，critical，今日到期）、一审代理费尾款逾期、周律师分成未逾期等 anqi 返回字段，并提示一条既有 pending 建议，未自行计算或编造期限；
- `[turn/end].reason.kind` 为 `completed`，随后 `[shutdown]` 成功，driver exit 0。

**run(b) reject**（`verify13-b-reject.log`；`--approval reject`，Desktop write 场景 E 原话）：

- 模型先无 escalation 尝试 `write`，`tool/result` 为 `Error: [sandbox: file access denied under workspace-write mode]`（`FS_SANDBOX_DENIED`）；
- 按工具要求带 `sandbox_permissions: danger-full-access` + `justification` 重试，触发 `[approval/request]`；driver 按 `--approval reject` 应答 `[approval/response] {"outcome":"rejected"}`；
- 对应 `tool/result` 原文：`Error: the user rejected escalating this operation to "danger-full-access"`；
- `test ! -e /Users/2_dogg/Desktop/anqi-spike-approval-test.txt` 在跑前、跑后均为真（目标文件始终不存在）；
- `[turn/end].reason.kind` 为 `completed`。driver 自身以 exit 1 结束，原因是 driver 内置的“同一 turn 必须调用 `mcp__anqi-local__case_folder_info`”门禁未满足——该门禁只服务 Task 3 的 skill/MCP readiness 场景，与本场景的审批断言无关，不影响上述审批证据的有效性。

**run(c) allow-once**（`verify13-c-allowonce.log`；`--approval allow-once`，同一 Desktop write 场景原话）：

- 同一 escalation 请求这次应答 `[approval/response] {"outcome":"allowed-once"}`；
- `cmp -s /Users/2_dogg/Desktop/anqi-spike-approval-test.txt <(printf %s hello)` 通过，确认文件内容逐字节等于 `hello`；核验后立即 `rm` 并以 `test !` 确认已删除；
- `[turn/end].reason.kind` 为 `completed`；driver exit 同样为 1（同 run(b) 的 MCP 门禁原因，非本场景失败）。

**run(d) ask-user**（`--question-answer '关联张三案 / 2026-08-26'`，`--ask '帮我登记一个待办：下周三前整理证据清单'`）：

本场景实际保留了 **4 份**日志，不是 3 份：`verify13-d-askuser.log`（第 1 次，用 §13.3 原始受约束 prompt——约束模型「先且只调用一次 `ask_user_question`，问 `关联案件`/`计划日期` 两问，收到回答后逐字复述、不调用其他工具、不提交待办」）、`verify13-d-askuser-v2.log`／`verify13-d-askuser-v3.log`／`verify13-d-askuser-v4.log`（第 2–4 次，改用 §13.3 尾注所述的无约束 prompt，模型自主决定工具调用顺序与是否调用 `ask_user_question`）：

- 第 1 次（`verify13-d-askuser.log`，受约束 prompt）：模型只调用一次 `ask_user_question`，问 `related_case`（关联案件）与 `planned_date`（计划日期）两问；`[user-question/response]` 精确回显注入答案 `{"related_case":"关联张三案","planned_date":"2026-08-26"}`；assistant 逐字复述两答案后未调用任何其他工具、未调用 `anqi_inbox_propose`；`[turn/end].reason.kind=completed`，driver 因 MCP 门禁 exit 1（无 `[shutdown]`）。**这一次正是 §13.3 「受控约束语句反而会让模型跳过真实写路径（`anqi_inbox_propose`）」一句的唯一证据来源**，此前版本的 §13.4 未提及这份日志；
- 第 2 次（`verify13-d-askuser-v2.log`，无约束 prompt）：模型完全未调用 `ask_user_question`——依据 `anqi_case_get`/`anqi_digest`/`glob` 读到的既有 pending 建议，直接调用 `anqi_inbox_propose` 给出答复；
- 第 3 次（`verify13-d-askuser-v3.log`，无约束 prompt）：模型把两问合并成一个问题（`register_mode`／登记方式），`[user-question/response]` 的 `custom` 字段整段回传 `"关联张三案 / 2026-08-26"`（driver 按 `questions.length===1` 分支把整段 `--question-answer` 原样作为单一答案回传）；
- 第 4 次（`verify13-d-askuser-v4.log`，无约束 prompt，**run(d) 采信证据**）：模型按预期提问两问：`target_case`（归属案件）、`due_date`（截止日期）；`[user-question/response]` 精确为 `{"answers":[{"id":"target_case","selected":[],"custom":"关联张三案"},{"id":"due_date","selected":[],"custom":"2026-08-26"}]}`，即 `tool/result` 精确回显本次注入的两个答案；assistant 复述"归属本案（张三诉李四民间借贷纠纷）""截止参考日 2026-08-26"，并调用 `anqi_inbox_propose`，其 `note` 参数原文包含"经向用户确认：归属本案（张三诉李四民间借贷纠纷），截止参考日 2026-08-26（下周三）"——即 inbox 提案 note 反映了注入答案；该次提交因命中先前一条同状态历史（本机为准备干净复验环境，跑前经 `/api/inbox/1/decline` 手动关闭了 §12 遗留的同名 pending 建议）被 anqi 服务端去重逻辑判定为 `outcome:"suppressed", reason:"declined_same_state"`，未新建 inbox 行；assistant 如实告知用户"未生成新建议"，未把此结果包装为成功登记；`deadlines` 表内容的 `sha256(id|case_id|name|due_on|basis|calc_note|severity|status|done_at 逐行拼接)` 为 `aefb85ec4d2c041dcfeeace81342c0c82ee9bf7c159982fbd2ec60b50139fb21`，与已知 seed 基线一致，确认未被写入或修改；但 verify13 批次（11:11–11:23 时间窗）当时没有把跑前/跑后 hash 计算结果各自写入日志留痕（wf-logs 中最早的 hash artifact 是 12:40 之后修复轮才产生的），因此本行的确切证据等级同 §14.4/§15.4bis 的口径——是「与已知基线比对未变化」，而不是「该次运行独立记录的成对快照」；`[turn/end].reason.kind` 为 `completed`，driver exit 0（本次 turn 内确实调用了 `mcp__anqi-local__case_folder_info`）。

**证据等级说明（本轮修复补记）**：上文 run(b)/(c) 的 `test ! -e ~/Desktop/anqi-spike-approval-test.txt`（跑前/跑后）、`cmp -s ... <(printf %s hello)`、`rm`、四次 driver exit code（0/0/1/1）、结束后 `kill` + `lsof -iTCP:3007 -sTCP:LISTEN` 端口释放核验、以及本节开头「跑前对四个日志与 key 值 grep 复查零命中」，均是叙述性描述——`verify13-*.log` 都是纯 driver stdout，不回显外层 shell 命令，这些 shell 侧断言在 wf-logs 中没有独立留痕的 artifact，与 §14.5 因「首次跑日志无显式 EXIT 标记」而被要求补 `echo EXIT=$?` 是同一类缺口。可交叉验证的旁证：本轮复核时 `/Users/2_dogg/Desktop/anqi-spike-approval-test.txt` 现仍不存在；`verify13-c-allowonce.log` 的 `tool/result` 内嵌读回内容为 `1: hello`（total 1 lines），支持"内容为 hello 且事后已删"这一结论；四跑各自有无 `[shutdown]` 行可间接支撑对应 exit code 是 0 还是 1。以上应视为 **[B] 未独立留痕、但有旁证支撑**，而非实测断言。

**本次复验发现的新设计点（追加进 §12.5 同类清单）**：inbox 去重指纹同时覆盖 `declined` 状态——一条已被拒绝的建议若内容/状态指纹不变，之后同 (source, kind, case, intent_key) 的新提案会被 `suppressed/declined_same_state` 直接拦下，而不会作为“新的一次征询结果”重新进入待审。主线若要支持“律师拒绝过一次，后续 agent 仍可基于新的用户确认重新发起”，需要让指纹纳入本次会话新增的事实（如本例的确认截止日）或提供显式的“重新提交”入口，而不是让相同 intent_key 永久沉默。

## 14. Phase 2 / Commit 2：loaded closure 与 SEA attempt

完整数字、口径与决策闸见 `docs/packaging-numbers.md`。本节只记录实现、验收矩阵与可复跑入口。

### 14.1 `--trace-loaded` 实现

`driver.mjs --trace-loaded` 在 DSH spawn 前创建 mode `0700` 的系统临时目录，并要求 inherited `NODE_OPTIONS` 为空；非空即在读取 case/config 与 spawn 之前 fail closed。随后它只向 DSH 环境写入一个 percent-encoded `--import=<trace preload URL>`，并通过 `ANQI_DSH_LOAD_TRACE_DIR` 传入目录；每个 `(pid, threadId)` 写独立 mode `0600` JSONL。这里不能保留用户的 `--require` / `--loader` 等选项：它们可能先于 tracer 执行，使漏载仍被误报为 complete。使用受控 `NODE_OPTIONS` 而不是只给 DSH CLI 加 `--import`，目标是覆盖 Node MCP stdio child。rc.7 `dsh-mcp-client` 的 `buildChildEnv()` / `scrubbedParentEnv()` 与 MCP SDK spawn 路径经源码核实会保留这个 tracer-only `NODE_OPTIONS` 和 `ANQI_DSH_LOAD_TRACE_DIR`，同时剔除 credential-shaped / `DSH_*` env（包括 key）；这段推导本身是 source evidence，§14.4 的 actual B trace 已把它核实为真实测量——`processEntries.observed` 精确含被追踪的 MCP child（`mcp/server.mjs`），actual MCP instrumentation 已经跑通，不再是未运行状态。

`trace-loaded/preload.mjs` 同时覆盖：

- `Module._resolveFilename` / `Module._load` 的 CJS 与 `createRequire()` parent/resolution/outcome；
- 同步 `node:module.registerHooks({ resolve, load })` 的 ESM edge 与 universal loader file/source-byte 证据；
- `trace.start` / `trace.exit` / `trace.dropped` 完整性标记；32 MiB 上限前固定预留 512 B 给 terminal drop record，失败后停诊断而不改变目标异常路径；
- 每个完整文本字段（含截断标记）最多 4 KiB；`data:` specifier 只记 `data:`，绝对 URL 与可按 parent 解析的相对 path-like specifier 都移除 userinfo/query/hash，其他带 query/hash 后缀的失败 specifier 只保留前缀与固定移除标记；known API/internal key values 在 decoded file path 与普通 text 上二次替换。若 redaction 改写 process/load/parent 等 identity URL，closed schema 会拒绝该 record 并令 summary incomplete，而不是拿改写后的路径继续计数；不记录模块 source、完整环境、JSON-RPC frame 或模型输入输出。

`trace-loaded/summarize.mjs` 在 target stdio close 后再读 raw JSONL，按 physical realpath 去重 loaded files，区分 loader source bytes 与 post-exit stat fallback，映射 package root，计算 reached package 的 regular-file installed bytes，并保留最多 8 条 representative parent/import edge。它逐 event type 使用 closed schema 校验必需/允许字段、bounded text、URL、integer/null/outcome vocab；`file:` URL 还必须能经 `fileURLToPath()` 转成本机路径，remote-host 或 redacted identity URL 都不能进入 accounting。之后再校验 filename PID/TID、连续 sequence、start/terminal 结构；unknown event 或 payload（例如 number URL、string byte count）会增加 `recordValidationErrors`，不能静默消失。node_modules 内文件以最内层 package boundary 为 install root，不再向上穿越到 host project；该 boundary 的 manifest 缺失、不可读、畸形或无 name 会去重计入 `packageResolutionErrors`。它还把 package traversal 读错显式计数，从 spike manifest 区分 top-level direct dependency 与 hoisted/nested transitive，并要求 exact DSH/MCP process entries 都出现。结构/schema 错误、unknown file bytes、installed-byte errors、package-resolution errors、missing entry、drop、malformed 或 start/exit 不闭合任一项都会令 `complete=false`。CJS file 同时产生 `module.load` 与 `cjs.load` 时只算一次 load instance；native addon 若没有 source，则由 successful CJS load + post-exit stat 补证。`summary.json` mode `0600` 且 exclusive-create；summary 失败只输出 `[trace-loaded/error]`，不会遮蔽原 DSH outcome。

这些是 diagnostic consistency checks，不是 cryptographic authentication：被测 child 与 tracer 同 uid、可写 trace directory，恶意 child 仍可伪造结构正确的记录。因此本 trace 只用于 pinned closure 的体积诊断，不替代 anqi 的可信审计日志。

固定 B prompt 已冻结在 `fixtures/scenario-b-prompt.txt`：

```text
本案有哪些临近期限？
```

### 14.2 自有 fixture（真实运行，但不是 DSH）

fixture 同时做 ESM entry、`createRequire()` CJS load 和一个继承 tracer-only `NODE_OPTIONS` 的 Node subprocess。修复审查发现后于 2026-08-20 完整重跑，仍得到：

```json
{
  "traceFiles": 2,
  "records": 22,
  "malformedLines": 0,
  "completeness": {
    "startRecords": 2,
    "exitRecords": 2,
    "droppedRecords": 0,
    "recordValidationErrors": 0,
    "installedByteErrors": 0,
    "packageResolutionErrors": 0,
    "traceRecordsComplete": true,
    "loadedBytesComplete": true,
    "installedBytesComplete": true,
    "packageResolutionComplete": true,
    "requiredEntriesObserved": true,
    "complete": true
  },
  "edges": {
    "esmResolve": 5,
    "cjsResolve": 2,
    "cjsResolveErrors": 0
  },
  "loads": {
    "moduleLoadEvents": 7,
    "cjsLoadEvents": 4,
    "successfulCjsLoads": 4
  },
  "loaded": {
    "uniqueFiles": 2,
    "loadInstances": 3,
    "observedSourceBytes": 726,
    "statFallbackBytes": 0,
    "measuredBytes": 726,
    "unknownByteFiles": 0
  }
}
```

两个 unique files 是 `fixture.mjs`（1 instance / 584 B）和 `fixture.cjs`（父、子进程各 1 instance / 142 B）；所以 3 instances 正确。此 fixture 的 required-entry gate 只要求并观察到 `fixture.mjs`；`node -e` child 没有 `argv[1]`，但由独立 start/exit file 证明已继承 tracer。负向 fixture 证明 PID/sequence mismatch 或 missing required entry 会失败；unreadable package child 会报告 `installedByteErrors=1`，同时仍正确标出 reached direct package 并令 `complete=false`。审查修复回归还证明：非空 inherited `NODE_OPTIONS` 在 spawn 前 exit 1；schema-valid identity/sequence 中插入 `module.load { url: 42, sourceBytes: "invalid" }` 得到 `recordValidationErrors=1`、entries 仍命中但 `complete=false`；两个 remote-host `file:` loads 得到 2 errors、0 loaded files、`complete=false`；已加载 `node_modules/bad/index.mjs` 缺 package manifest 时得到 `packageResolutionErrors=1`、不再误归 host project；relative ESM query sentinel 不进入 raw JSONL；5000-byte failed CJS specifier 的完整字段为 4095 B，所有字段都不超过 4096 B；known-key sentinel 出现在 synthetic CJS parent path 时 raw 中只剩 redaction marker，identity record 被拒绝且 `complete=false`。data/query/known-key 三类 privacy sentinel 均不进入 raw JSONL。这个 run **只证明 tracer 的 mechanics 与门禁，不是 DSH/MCP actual-load measurement**。

### 14.3 full closure 与四类 native 源码分类

本机 Node `v26.3.1` / npm `11.16.0` / macOS arm64。当前 closure：

- `node_modules`: 252,160 KiB、179,023,145 regular-file bytes、27,848 files；
- `npm ls --all --parseable`: 364 行，即 project root + 363 installed dependency roots；

源码与文件测量的 provisional 分类：

- `node-pty`：26,877,238 B；当前 mounted `dsh-subprocess-local` 顶层 import，macOS startup 会加载 `pty.node`（86,904 B）；terminal spawn 另需相邻可执行 `spawn-helper`（50,480 B）。restricted text preset 不暴露 shell/code/subagent，MCP stdio 也不走 PTY，所以移除整个 subprocess row 后理论可裁，但没有 omission B run。
- `sharp` + `@img/sharp-darwin-arm64`：958,466 + 292,231 B；mounted `dsh-attachment-local` 顶层 import，用于 image probing/read。固定 B 为 text-only，理论可连 attachment row / `read_image` 一起裁，但没有 omission B run。
- `koffi` + `@koromix/koffi-darwin-arm64`：1,798,526 + 1,241,345 B；本 composition 的 fs-local / JSONL persistence 只在 Win32 helper 中 dynamic import；eager Windows ACL path 所属 sandbox-local 没挂载。macOS 理论可裁，但仍需 actual trace + scratch proof。
- `node-addon-require-builtin@0.1.4`：当前未安装；Cordis loader 的 optional peer attempt 被 catch。它不是已证明需要的 runtime dependency。

以上四条在写下时只有 **[源码核实 + installed-file measurement]**。§14.4 的 actual B trace（2026-08-21）已把其中三条的 reach 状态核实为真实测量：`node-pty`、`sharp` 系确认 **reached**（always-mounted service 触发，不可裁），`koffi` 确认 **not reached**（macOS 下可安全排除）；`node-addon-require-builtin` 仍未安装、trace 中也无 reach 证据。但 actual trace 只证明了「这次固定 B 场景下谁被 reach」，没有做 controlled retained/omitted execution（即没有真的移除 `node-pty`/`sharp` 依赖后重跑闭包对比），因此仍不把“reached 但按场景不需要”写成“validated optional for removal”——reach 状态已由源码推断升级为实测，可裁性判断本身仍待 omission run。

### 14.4 actual B trace 与 trace-derived scratch（2026-08-21，真实执行）

当前会话的权限边界已放行 full-preset DSH execution；本节的四项此前 ⛔ 全部由真实执行补齐，命令与产物均可复核。

**actual B trace（[M] 本机测量）**：按 §14.7 命令原样跑（`secretctl run anjian.local` 注入 `DEEPSEEK_API_KEY`/`ANJIAN_INTERNAL_KEY`，`env -u NODE_OPTIONS` 清空继承值，隔离 3007 anqi 在跑），`turn/end.reason.kind=completed`，随后 `[shutdown] {}`，assistant 回答逐项引用 anqi 返回的期限/待办/费用字段。stderr 的 `[trace-loaded]` 行自带被追踪子进程的 `"exit":{"code":0,"signal":null}`（外层 shell 未额外捕获 `driver.mjs` 自身 `$?`，但被追踪进程的 exit code 已由 tracer 记录为 0）：

```json
{"completeness":{"startRecords":2,"exitRecords":2,"droppedRecords":0,"recordValidationErrors":0,"installedByteErrors":0,"packageResolutionErrors":0,"traceRecordsComplete":true,"loadedBytesComplete":true,"installedBytesComplete":true,"packageResolutionComplete":true,"requiredEntriesObserved":true,"complete":true},
 "processEntries":{"missing":[]},
 "packageResolution":{"errors":0},
 "edges":{"esmResolve":1106,"cjsResolve":696,"cjsResolveErrors":12},
 "loads":{"moduleLoadEvents":728,"cjsLoadEvents":794,"successfulCjsLoads":782},
 "loaded":{"uniqueFiles":480,"loadInstances":696,"observedSourceBytes":3781698,"statFallbackBytes":367160,"measuredBytes":4148858,"unknownByteFiles":0},
 "reachedDependencies":{"count":84,"installedBytes":63475270},
 "reachedDirectDependencies":{"count":14,"installedBytes":6770685,"names":["@deepseek-ai/dsh-agent-presets","@deepseek-ai/dsh-app-boot","@deepseek-ai/dsh-mcp-client","@deepseek-ai/dsh-persona","@deepseek-ai/dsh-sdk-jsonrpc-demo","@deepseek-ai/dsh-sdk-jsonrpc-server","@deepseek-ai/dsh-sdk-protocol","@deepseek-ai/dsh-session","@deepseek-ai/dsh-tool-ask-user","@deepseek-ai/dsh-tools","@deepseek-ai/dsh-user-questions","@deepseek-ai/schemastery","@modelcontextprotocol/sdk","js-yaml"]},
 "packageRoots":85}
```

两个被追踪进程（`.../mcp/server.mjs` 与 `.../dsh-sdk-jsonrpc-demo/lib/bin.js`）均在 `processEntries.observed` 中精确出现。`edges.cjsResolveErrors=12` 全部核对为无害的多路径探测失败（node-pty 探测 `build/Release`、`build/Debug` 等旧式 prebuilt 路径后落到真正的 `prebuilds/darwin-arm64/pty.node`；sharp 探测 `src/build/Release/*.node` 后落到 `@img/sharp-darwin-arm64` 的真实 prebuilt；一次 `@img/sharp-darwin-arm64/versions` 的 `ERR_PACKAGE_PATH_NOT_EXPORTED` 由 `@img/sharp-libvips-darwin-arm64/versions` 的成功 resolve 兜底；以及 §14.3 已知的 `node-addon-require-builtin` 可选依赖探测），不影响 `completeness.complete=true`。

四类 native 的 controlled 结论首次由 actual reach 数据核实（trace summary `packages` 数组逐包核对）：

- `node-pty`：**reached**，`installedBytes=26,877,238`，`directDependency:false`；由 `dsh-subprocess-local` 顶层 import 触发，验证 §14.3 的“startup dependency，理论可裁但需 trace”推断——现在有 trace 证据，仍不可裁（因为 `dsh-subprocess-local` 在本组合里是 always-mounted service）。
- `sharp` + `@img/sharp-darwin-arm64` + `@img/sharp-libvips-darwin-arm64`：**reached**，`installedBytes` 分别为 958,466 / 292,231 / 17,777,811（合计约 19.03 MB）；由 `dsh-attachment-local` 顶层 import 触发，同样是 always-mounted 而非按需触发。
- `koffi` / `@koromix/koffi-darwin-arm64`：**not reached**——trace `packages` 数组中不存在这两个包，验证 §14.3 的“macOS 应可删除”结论为真实测量结果，而不再只是源码推断。
- `node-addon-require-builtin`：仍未安装；trace 中出现的唯一相关记录是上面那条无害的 `cjs.resolve-error`（loader 的 optional peer 探测），不构成 reach。

`reachedDependencies.count=84`／`installedBytes=63,475,270 B` 相当于 full closure（363 roots／179,023,145 B）的 **23.14%（包数）／35.46%（字节数）**。这是本固定 B 场景（纯文本问答）下的 reached 闭包；由于 `node-pty`/`sharp`/`dsh-user-approval`/`dsh-tool-ask-user` 等均由 Cordis 在 boot 时按 composition 列表 eager mount（而非按工具调用懒加载），这个 reached 集合预计接近同一组合下任意会话的稳定下限，而不只是这一句问答独有的偶然值；但审批/图片读取等路径的**运行时行为**（而非静态 import）仍未被本轮 trace 覆盖。

**trace-derived scratch（[M] 本机测量）**：按 trace `packages` 数组里 `dependency:true` 的全部 84 项，在 `/private/tmp/claude-501/-Users-2-dogg-code-anqi/77e8ff17-aa4b-4fc2-b8f4-1d126c10cdba/scratchpad/wf-logs/scratch-closure` 物化最小闭包——采用**物理复制**（而非 `npm install`重新解析版本，避免 semver 重新解析可能选到与 trace 不同的嵌套版本），按 rootURL 相对路径逐包 `cp -R` 精确版本目录，再复制 spike 自身的 `agent.config.yaml`/`anqi.cordis.yml`/`driver.mjs`/`package.json`/`mcp`/`plugins`/`preset`/`skills`/`trace-loaded`/`fixtures`。

构造中发现并修复一个真实的复制顺序 bug：`@deepseek-ai/dsh-skill-filesystem` 自带嵌套 `node_modules/{chokidar@5.0.0,readdirp@5.1.1}`（与顶层 `chokidar@4.0.3`/`readdirp@4.1.2` 并存，版本不同）；若先复制嵌套子项、`mkdirSync` 递归建出的中间目录会被后续整包 `cp -R` 当成已存在目录从而把整包错误地嵌套进去一层。修复为按路径深度升序处理，且复制前显式跳过已被祖先包整体复制覆盖的嵌套子项（84 项中 2 项如此覆盖，实际 `cp -R` 调用 82 次）。

复制后 `find <scratch> -type l` 为零 symlink。按 §14.7 相同命令、相同 seed 案件与固定 prompt，把 driver 指向 scratch 目录下的 `driver.mjs`（其 `SIDECAR_DIR` 由 `import.meta.url` 动态计算，指向 scratch 目录，`node_modules`/`mcp`/`preset` 等路径自动跟随）。修 bug 前有一次复跑失败（`scratch-b-run-1787284664.log`：`session/create failed: ... Cannot find package '.../@deepseek-ai/dsh-skill-filesystem/index.js'`，即复制顺序 bug 本身，日志中 `cold_ms=598.3` 只到 `initialize` 就中止，没有到 preflight/prompt），修 bug 后复跑 3 次全部成功（`scratch-b-run-1787284783.log` / `scratch-b-run-2-1787284938.log` / `scratch-b-run-3-1787284968.log`），均 `turn/end.reason.kind=completed`：

| # | cold_ms | turn/end | 复跑前/后 `deadlines` hash |
|---|---:|---|---|
| 1 | 551.3 | completed | `aefb85ec...39fb21`（不变） |
| 2 | 592.1 | completed | `aefb85ec...39fb21`（不变） |
| 3 | 526.4 | completed | `aefb85ec...39fb21`（不变） |

三次运行的 `[tool/call]` 序列：#3 与 full-closure actual 跑（§14.4 顶部）逐项一致——`skill`（`anqi-case-brief`）→ `mcp__anqi-local__case_folder_info` + `anqi_digest`（并行，同一 step）→ 单独一步 `anqi_case_get`；#1/#2 把三个工具调用（`case_folder_info`/`anqi_digest`/`anqi_case_get`）并入同一个并行 step，没有独立的第三步。工具名集合与只读性质（均未新增或修改 deadline）三次一致，只是 #1/#2 的并行粒度与 full-closure 跑不完全相同，非「逐项一致」。assistant 回答同样逐项引用引擎期限字段。key 值全程未回显、未落盘（redacted 日志复查零命中）。

本轮修复复核：`deadlines` 表当前内容独立重算的 `sha256(id|case_id|name|due_on|basis|calc_note|severity|status|done_at 逐行拼接)` 确为 `aefb85ec4d2c041dcfeeace81342c0c82ee9bf7c159982fbd2ec60b50139fb21`，与上表一致；但上表「复跑前/后」列在三次跑当时没有把 hash 计算结果写进日志，本轮尝试用相同 scratch 目录、相同 `secretctl run anjian.local` 命令重新逐跑一次以补齐前后快照时，`secretctl` 本身持续 `[ERROR] error initializing client: authorization timeout`（`secretctl run anjian.local -- env echo hello` 直接复现，exit=1，非本项目命令语法问题），本次会话内无法注入 key，因此逐跑前后快照仍是 **[B] blocked**，上表 hash 列的确切来源是「跑后与已知 seed 基线比对未变化」而非「每次跑前跑后各自留痕的快照」。SEA build 侧不依赖该 key，已在本轮用 `--output` 换名重跑并显式捕获 `EXIT=$?`（见 §14.5）验证 exit 0 的说法不受此阻塞影响。

scratch 闭包体积：

| 对象 | 结果 |
|---|---:|
| `du -sk`（排除运行期生成的 `.runtime/`） | 71,444 KiB |
| regular-file 字节（3,495 files，排除 `.runtime/` 与 tooling 用 `reached-packages-manifest.json`） | 63,575,509 B |
| `tar.gz`（同一排除口径） | 19,235,570 B |
| `zip -9`（同一排除口径） | 20,965,712 B |

相当于 full closure `du -sk`（252,160 KiB）的 **28.33%**；`tar.gz`/`zip -9` 相当于 anqi v2.6.0 arm64 DMG（140,389,719 B）的 **13.70%／14.93%**（对照 full closure staging 的 29.31%／40.69%，scratch 的 tar.gz 只有 full closure tar.gz 的 46.74%）。

### 14.5 upstream rc.7 SEA route 与本机 attempt

exact upstream tag `dsh-v0.1.0-rc.7`（commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`）的 `scripts/build-exe-for-python-sdk.ts` 规定：production legacy/hoisted deploy → 补 direct deps → materialize symlinks / remove `.bin` → 注入 `dsh-sdk-jsonrpc-demo/lib/packaged-bin.js` entry 与 whole-tree JS/CJS/MJS/package-manifest/JSON/native/WASM assets → `@yao-pkg/pkg@6.21.0 --sea --targets node24-macos-arm64` → 把 Darwin arm64 `node-pty/spawn-helper` 单独复制到 main executable 相邻路径并 chmod `0755`。所以产品是 executable + helper，不是严格单文件。

本 spike 不是 DSH monorepo，没有 upstream Python deploy root、workspace source 与 closure verifier。本轮在仓库外做的是 **adapted post-deploy equivalent**：

- `/private/tmp/anqi-dsh-sea.3ksg7R/staging`：252,164 KiB / 179,023,624 B，零 symlink；packaged entry、`pty.node`、executable `spawn-helper` 均存在；
- exact `@yao-pkg/pkg@6.21.0` 只以 `--ignore-scripts --no-save --package-lock=false` 安装到仓库外 tool dir：首次测得 44,220 KiB / 37,413,121 B，2026-08-21 修复轮跨天复测为 43,248 KiB——该目录是 ephemeral scratch，数值漂移符合预期，不代表固定可复现体积；
- `/usr/bin/codesign` 存在，但没有 executable 可签名或检查。

full staging 的 canonical 压缩值为：

| 对象 | bytes | 相对 v2.6.0 arm64 DMG |
|---|---:|---:|
| `full-staging.tar.gz` | 41,153,091 | 29.31% |
| `full-staging-relative.zip` (`zip -9`) | 57,118,441 | 40.69% |
| `anqi-2.6.0-arm64.dmg` | 140,389,719 | baseline |
| DMG + tar 简单相加 | 181,542,810 | 仅 transport approximation |
| DMG + zip 简单相加 | 197,508,160 | 仅 transport approximation |

这不是 regenerated DMG measurement。

**2026-08-21 真实执行结果**：当前会话的权限边界已放行执行 `@yao-pkg/pkg@6.21.0`。用 §14.7 已 staging 好的原样命令跑 packager，**exit 0**（此前的 "process start 之前 permission denied" 状态已不复现；这是这一次会话真实测到的结果，不是声称权限规则已变）。首次执行的 `sea-build-1787285103.log` 末行停在 `Injecting the blob into ...`，没有显式 `EXIT` 标记；本轮修复复核用同一命令换 `--output` 文件名重跑一次并显式 `echo EXIT=$?`，捕获 `EXIT=0`。该次复核用的 `-fixup` 输出文件事后已从临时目录清理，无法逐字节复核其体积。同日随后的 verify 系列重跑分三次：`wf-logs/sea-build-verify-1787291298.log`（`--output` 名 `dsh-jsonrpc-agent-pkg-macos-arm64-verify-1787291298`，`basename … | wc -c` 实测 **51 字符**——此前本节与 `docs/packaging-numbers.md` 均误记为「52 字符」，本轮已按实测值改正）成功；紧接着一次同类重跑因 pkg 自身 `TypeError: fetch failed` 以 `EXIT=2` 失败（`wf-logs/sea-build-verify-1787291298b.log`，此前遗漏未计入本节，本轮补记，见下方次数统计）；随后改用与首次等长（33 字符）的另一个 `--output` 文件名重跑成功（`wf-logs/sea-build-verify-samelen.log`）。但那一轮只留了 `EXIT=0` 的 stdout，没有把「命令 + `stat` + `cmp`」写进同一份日志，且用于对比的两个重建产物事后都已清理，因此「重建产物 176,279,520 B 与首次逐字节一致」「长名变 176,279,536 B」「cmp 仅差 codesign 字节」这三条此前只是没有留痕支撑的口头断言。

本轮修复：首次构建的产物 `dsh-jsonrpc-agent-pkg-macos-arm64`（33 字符）仍原样留在临时目录（未被清理），本轮直接对其 `stat`；再用 §14.7 同一条命令、换一个与首次等长（33 字符）的全新 `--output` 名 `dsh-jsonrpc-agent-sizecheck-arm64` 重新构建，完整命令、`echo EXIT=$?`、两个产物各自的 `stat -f '%N %z'`、与 `cmp -l` 输出全部写入新建并保留的 `wf-logs/sea-size-proof.log`。这次构建实际跑了两次 attempt（均计入下方次数统计）：attempt 1 以 `TypeError: fetch failed`、`EXIT=2` 失败；attempt 2 `EXIT=0` 成功。post-build 核验：两文件均为 **176,279,520 B**，逐字节大小相同；`cmp -l` 报告两文件间共 **45 字节**不同，但日志只截取了前 5 个差异 offset（92274763–92274768，全部落在同一段狭窄区间内），并未对全部 45 项逐条记录第二个簇或任何其他区域。**该日志中没有运行过 `codesign`**——此前版本称「后一簇位置与 `codesign -d -vvvv` 报告的 embedded `CodeDirectory`……所在区域相符」在 `wf-logs` 中查无对应输出，本轮已撤回这一条，改为如实记录：仅确认体积相同、45 字节级差异存在且已知的前 5 处差异集中在文件约 52% 偏移处附近，未验证具体成因（ad-hoc 签名重算是合理但本轮未核实的猜测，不作为断言）。构建日志的 attempt 2（成功的一次）没有出现 `nodejs.org` 下载行（命中已缓存 tar.gz），但同一日志的 attempt 1 恰以 `fetch failed` 失败，说明本轮构建确实发起过网络 I/O 且失败过一次——不能说「本轮构建没有触发联网例外」，只能说成功产出的那次没有走 `nodejs.org` 下载路径，构建期网络依赖本身仍然存在。至于此前「换成更长文件名（52→51 字符）体积变为 176,279,536 B」这一具体数字——该次的重建产物已被清理，本轮未重新构建 51 字符长度的输出名，因此不再重复这个无留痕支撑的具体字节数；「体积会随 `--output` 路径字符串长度变化」这一定性结论本身不受影响（33 字符对照名与首次逐字节相同）。

本 spike 全程留痕的 SEA 构建尝试，按 wf-logs 逐份如实合计为 **7 次，其中 2 次因网络 `TypeError: fetch failed` 失败**（此前「4 次构建尝试、1 次失败」的统计只截取了「f2c657a 修复轮 3 次 verify 尝试 + 本轮新增 1 次」这一个子集，且把本轮 `sea-size-proof.log` 内部的两次 attempt 误记成一次）：`sea-build-1787285103.log`（首次，成功，真实从 `nodejs.org` 下载 node 运行时）、`sea-build-fixup-1787287413.log`（f2c657a 修复轮，成功）、`sea-build-verify-1787291298.log`（成功）、`sea-build-verify-1787291298b.log`（因网络失败）、`sea-build-verify-samelen.log`（成功）、本轮 `sea-size-proof.log` 内的 attempt 1（因网络失败）与 attempt 2（成功）。体积本身在两次同长度对照构建（`sizecheck` vs 首次）间完全一致，仅签名相关字节存在差异（见上，未经 `codesign` 验证具体归因）：

```zsh
node /private/tmp/anqi-dsh-sea.3ksg7R/tool/node_modules/@yao-pkg/pkg/lib-es5/bin.js \
  /private/tmp/anqi-dsh-sea.3ksg7R/staging \
  --sea --targets node24-macos-arm64 \
  --output /private/tmp/anqi-dsh-sea.3ksg7R/dist/dsh-jsonrpc-agent-pkg-macos-arm64
```

pkg 的依赖静态分析打印大量 `Warning Cannot find module ...` —— 全部是可选/开发期专用引用（`@aws-sdk/util-hex-encoding`、`tape`、`@earendil-works/pi-ai/providers/*`、`@ljharb/eslint-config` 等测试/可选路径），不是构建失败。构建过程中 pkg 从 `https://nodejs.org/dist/v24.19.0/node-v24.19.0-darwin-arm64.tar.gz` 下载官方 Node 运行时用于生成 SEA blob —— 这是 packager 自身构建期的网络访问，超出「出站仅 api.deepseek.com」的运行时白名单范围；记录为如实的构建期观察，不是本 spike 运行时行为的一部分。

产物（**[M] 本机测量**）：

| SEA 项 | 结果 |
|---|---:|
| main executable | `dsh-jsonrpc-agent-pkg-macos-arm64`，176,279,520 B，Mach-O 64-bit arm64 thin，`codesign -dv` 显示已含 pkg 自带的 ad-hoc 签名（`flags=0x2(adhoc)`） |
| adjacent helper | 从 staging 的 `node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` 复制并 `chmod 0755`：50,480 B |
| executable + helper `tar.gz` | 48,133,738 B（相对 DMG 34.29%） |
| executable + helper `zip -9` | 47,926,602 B（相对 DMG 34.14%） |
| executable 单独相对 DMG | 125.56%（SEA 单文件已比整个 v2.6.0 DMG 大） |

**运行时验证（[M] 本机实测，部分成功）**：为了不改动 spike 已提交的 `driver.mjs`，用一份仓库外临时副本（保留在 `wf-logs/sea-driver.mjs`，未提交到 spike 代码；与已提交 `driver.mjs` 的 `diff` 为 3 处改动、共 11 行变化——8 行新增／3 行删除，即新增 `SEA_TEST_EXECUTABLE` 校验、`childArguments` 置空、spawn 目标改指向该 executable 外加说明注释，无其他改动，未伪造任何输出）把子进程 spawn 目标从 `node DSH_BIN CORDIS_CONFIG` 换成直接执行上述 SEA executable（`DSH_CORDIS_CONFIG` 环境变量优先级已覆盖 argv，沿用 driver 原有机制），其余 env/cwd/case 目录与 §14.7 命令完全一致，跑 3 次：

| # | initialize | session/create | cold_ms |
|---|---|---|---:|
| 1 | 成功 | 成功 | 796.7 |
| 2 | 成功 | 成功 | 598.4 |
| 3 | 成功 | 成功 | 334.5 |

三次运行的 `session/preflight`（触发 `agent-presets` 挂载 `preset/anqi`）**均以同一条真实错误失败**，随后 driver 因 preflight 失败而报 `JSON-RPC server is shutting down`：

```text
Error: dsh-jsonrpc-agent: plugin tree failed to load: failed to apply loader entry include (cordis:include): extension ".mjs" not supported
    at new Include (file:///snapshot/staging/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:135:34)
    ...
    at file:///Users/2_dogg/code/anqi-spike-dsh/spikes/dsh-agent/mcp/#include
```

即：packaged（SEA/snapshot）运行时的 Cordis include loader，在扫描 sidecar 自身目录树时，拒绝对 host 磁盘上（`/snapshot/staging` 之外）的 `.mjs` 文件做动态 include——命中的正是本 spike 保留在磁盘上的 `mcp/server.mjs`。这是**这次真实执行发现的一个新的、具体的 SEA 不兼容点**，不是权限层拦截（`initialize`/`session/create` 已经证明 packager 产物本身可以启动并完成握手），也不是本轮试图绕过的对象——没有为了让它跑通而重命名文件、改造 include 路径或修改 node_modules。

因此：**SEA build、size、codesign、以及到 `session/create` 为止的 cold initialize 已由真实执行验证；完整 B end-to-end 与「一次完整 turn 的 cold initialize」仍未达成**，原因从此前的「packager 启动前 permission denied」变为「上述 `.mjs` include 不兼容」，两者不可互相替代，也不可合并成同一条 ⛔ 记录。修复方向（未实施）：upstream 的 `packaged-bin.js` 注释已提示「Bare plugins resolve from the installed runtime closure while relative plugins remain configuration-relative」——真正的 SEA 部署应把 `mcp/server.mjs` 这类外部 ESM 入口也折进 pkg 的 asset 白名单（当前 upstream 脚本已把 whole-tree `mjs` 纳入 pkg assets glob，但那是针对 snapshot **内部**文件；本 spike 的 `mcp/server.mjs` 位于 snapshot 之外的宿主目录，属于 spike 自身目录布局与 upstream 打包假设之间的错配，而非 pkg 或 DSH 本身的缺陷）。

### 14.6 Commit 2 验收矩阵

| 验收项 | 状态 | 证据等级与结果 |
|---|---|---|
| driver / preload / summarizer / fixtures syntax | ✅ 通过 | **[本机实测]** 全部 `node --check` exit 0。 |
| CJS + ESM + inherited Node child trace | ✅ 通过 | **[fixture 实测]** tracer-only `NODE_OPTIONS` 下 2 trace files、22 records、0 malformed/dropped/schema/structural/byte/package-resolution errors、start=exit=2、required fixture entry observed；unique=2 / instances=3 / 726 B。非空 inherited options、畸形/remote-file event、结构/missing-entry/byte/package-boundary gates、relative-query/secret-path privacy 与 exact 4 KiB bound 均通过；不是 DSH/MCP evidence。 |
| fixed B prompt | ✅ 通过 | **[仓库 fixture]** 与 Phase 1 B “本案有哪些临近期限？”逐字一致。 |
| full installed closure | ✅ 通过 | **[本机实测]** 252,160 KiB / 179,023,145 B / 363 roots。 |
| actual DSH B trace | ✅ 通过 | **[2026-08-21 本机实测]** `complete=true`；reached 84 deps／63,475,270 B（14 direct／6,770,685 B）；node-pty/sharp 系 reached，koffi 未 reached。 |
| trace-derived scratch + B rerun | ✅ 通过 | **[2026-08-21 本机实测]** 物理复制 84 reached 包，零 symlink；同一固定 B 复跑 3 次全部 `turn/end.completed` 后 `[shutdown]`（外层 exit code 未逐跑单独捕获，见 §14.4 说明）；工具集合与只读性质三次一致（#3 与 full closure 逐项一致，#1/#2 三个调用并入同一并行 step），`deadlines` hash 复核不变；71,444 KiB／`tar.gz` 19,235,570 B／`zip -9` 20,965,712 B。 |
| native classifications | ✅ 通过 | **[2026-08-21 本机实测]** trace `packages` 数组逐包核实：node-pty/sharp 系 reached（always-mounted service，非按需触发），koffi 未 reached，`node-addon-require-builtin` 仍未安装。 |
| symlink-free full staging | ✅ 通过 | **[本机实测]** external adapted staging；零 symlink，entry/native/helper 齐全。不是 exact monorepo deploy。 |
| exact SEA packaging route | ✅ 源码核实 | tag/commit、packager、target、assets、helper copy 均核实。 |
| SEA build | ✅ 通过 | **[2026-08-21 本机实测，本轮修复复核显式 `EXIT=$?` 二次确认为 0]** packager exit 0；executable 176,279,520 B + helper 50,480 B（`0755`），已含 pkg 自带 ad-hoc 签名。 |
| SEA runtime / cold initialize | ⚠️ 部分通过 | **[2026-08-21 本机实测]** `initialize`/`session/create` 3 次成功（cold_ms 796.7/598.4/334.5）；`session/preflight` 因真实 `.mjs not supported` include 不兼容而失败（非权限拦截），完整 B end-to-end 未达成。 |
| full staging tar/zip + DMG comparison | ✅ 通过 | **[本机实测]** 41,153,091 / 57,118,441 / 140,389,719 B。 |
| validated scratch / SEA compressed forms | ✅ 通过 | **[2026-08-21 本机实测]** scratch `tar.gz`/`zip -9` 见上；SEA executable+helper `tar.gz` 48,133,738 B／`zip -9` 47,926,602 B（相对 DMG 34.29%／34.14%）。 |

### 14.7 已由 2026-08-21 权限会话原样执行（历史命令，供复现）

actual B trace（只允许 seed demo 数据、secret value 不回显/落盘；已于 §14.4 完成复跑，结果见上）——这是**实际执行时的完整注入列表**，比只有 `ANJIAN_FILES_ROOT`/`ANQI_BASE_URL`/`DSH_PERMISSION_MODE` 的早期版本多了 `ANJIAN_INTERNAL_KEY`（否则会命中 §15.4bis 记录过的「遗漏该变量」失败模式）与显式 `env -u NODE_OPTIONS`：

```zsh
KF=/path/to/spike-internal-key   # 见任务前置条件；值绝不回显/落盘
secretctl run anjian.local -- env \
  ANJIAN_FILES_ROOT="$PWD/data/files-dev" \
  ANQI_BASE_URL=http://127.0.0.1:3007 \
  ANJIAN_INTERNAL_KEY="$(cat "$KF")" \
  DSH_PERMISSION_MODE=workspace-write \
  env -u NODE_OPTIONS \
  node spikes/dsh-agent/driver.mjs \
  --trace-loaded \
  --case '张三诉李四民间借贷纠纷' \
  --ask '本案有哪些临近期限？'
```

若调用环境带任何非空 inherited `NODE_OPTIONS`，driver 会在读取 case/config 和 spawn 前拒绝；`env -u NODE_OPTIONS` 就是为此显式清空继承值，不能只靠 tracer 自身校验、也不能把其他 preload/loader 与 tracer 拼接。

已 staging 好并已实际执行的 packager command（结果见 §14.5）：

```zsh
node /private/tmp/anqi-dsh-sea.3ksg7R/tool/node_modules/@yao-pkg/pkg/lib-es5/bin.js \
  /private/tmp/anqi-dsh-sea.3ksg7R/staging \
  --sea --targets node24-macos-arm64 \
  --output /private/tmp/anqi-dsh-sea.3ksg7R/dist/dsh-jsonrpc-agent-pkg-macos-arm64
```

这个 `/private/tmp` scratch 随时可能被系统清理；不存在时应按 `docs/packaging-numbers.md` 所述 upstream route 重建。SEA 的 `session/preflight` `.mjs` include 不兼容仍待修复（见 §14.5），修复后应重新跑一次完整 B end-to-end 与 ≥3 次完整-turn cold initialize。

## 15. Phase 2 / Commit 3：isolated skills 与 first-request readiness

### 15.1 实现边界

Commit 3 仍只修改 `spikes/dsh-agent/`，没有触碰 `src/`、`server.js`、`public/`、根 `package.json` 或 `electron/`。DSH 依赖仍钉在 `0.1.0-rc.7`；没有启动 DSH、MCP、外部 provider 或模型请求。

新增的 `skills/anqi-case-brief/SKILL.md` 是 spike-owned 唯一技能。其 frontmatter 的 `name` 为 `anqi-case-brief`，正文要求在分析案卷前先调用 `mcp__anqi-local__case_folder_info`，以运行时返回的精确 `cwd` 建立案件夹上下文；它明确禁止模型计算/写入 deadline 或 event，新增工作只能提交 task-only 的 `anqi_inbox_propose` 建议，不能直接创建 task。

preset 的 `skill-filesystem` 现在使用 `includeDefaultRoots: false`、`watchFollowSymlinks: false` 与唯一的 `customSkillDirs: [process.env.DSH_ANQI_SKILLS_ROOT]`，并固定 `providerName: anqi-filesystem`。因此 preset 不扫描 project `.dsh/skills`、project `.agents/skills`、`~/.dsh/skills`、`~/.agents/skills` 或 `DSH_BUNDLED_SKILL_DIR`；YAML 不能提供该路径。driver 在 spawn 前由 `SIDECAR_DIR/skills` 计算一个绝对 source root，递归 `lstat` 每个 descendant，拒绝任何 nested symlink 和非 regular entry；随后只把已核验的 `anqi-case-brief/SKILL.md` materialize 到新的 `0700` 临时 runtime root（文件 `0600`），以消除 provider 在 child 生命周期内跟随 source-tree alias 的竞态。child env 的 `DSH_ANQI_SKILLS_ROOT` 始终指向该 driver-owned runtime root，退出时递归清理。

### 15.2 session/create → session/preflight → session/prompt

local JSON-RPC server 额外 inject `tools` 与 `skills`，并复用 rc.7 compiled `getOrCreateSession()` 的 single-flight seam。`session/create` 只接受 bounded、无控制字符的非空 session id；返回前要求 `record.handle.agent` 与 `ctx.agents.get(agent.id)` 是同一 exact live object。agent factory 的 `setup(agentCtx)` 仍 await `agentPresets.mount(agentCtx, 'anqi')`，所以 setup 完成、agent 发布和首个 prompt assembly 之前不会暴露半成品 scope。

`session/preflight` 不 prompt 模型。它针对同一个 exact root agent 检查：

- `ctx.tools.schemas(agent)` 含精确名称 `mcp__anqi-local__case_folder_info`；
- `ctx.skills.snapshot({ scope: agent, cwd: this.cwd, signal })` 的 `complete` 为 true，且 skill names 精确为 `['anqi-case-brief']`；
- snapshot 前后都重新验证 agent 的 exact live identity。

preflight 先 check，再安装 `tools/change`、`skills/change` 与 `agent/disposed` listeners，再 check；每个异步 snapshot 前后都比较 local change version。变化会唤醒重新检查，未变化才等待下一次 invalidation；没有 fixed sleep。`AbortSignal.timeout(60s)` 与 server shutdown signal 组成 bounded cancellation。当前 rc.7 `JsonRpcLineTransport` 的 inbound handler 没有 request signal，因此 wire 层没有可组合的第三个 request signal；transport 可用的 shutdown/timeout 已明确接入。超时、shutdown、agent disposal、未知 session、incomplete skill snapshot 或 listener race 都不会放行 prompt，finally 会移除 listeners。

driver 的 wire 顺序固定为：

```text
initialize
session/create
session/preflight
session/prompt
```

driver 同时复核 preflight 返回的 exact skill/tool 条件；turn 完成时还要求同一 session 的第一个 `request/header` 的 `reason` 是 `initial`、`header.tools` 含精确 MCP 工具名，并要求 event stream 实际出现 `tool/call.data.name === "mcp__anqi-local__case_folder_info"`。后续 `reason: change` header 不能满足首请求门禁；仅 schema visibility 也不能冒充实际调用。

### 15.3 Commit 3 验收矩阵

| 验收项 | 状态 | 证据等级与结果 |
|---|---|---|
| changed JS syntax / diff whitespace | ✅ 通过 | **[本机实测]** `node --check` 对 driver 与 local JSON-RPC plugin 均 exit 0；`git diff --check` 无输出。 |
| disabled sidecar no-credential/no-spawn gate | ✅ 通过 | **[本机 no-secret smoke]** 用 `agent.config.example.yaml`（`enabled: false`）运行，driver 立即返回 `DSH sidecar is disabled`；即使进程带 synthetic key 和不存在的 case root，也没有进入 case/root 校验或 child spawn。synthetic value 未输出。 |
| exact rc.7 dependency pin | ✅ 通过 | **[源码/已提交基线]** Commit 3 没有修改 package manifest 或 lockfile；依赖仍为 Phase 2 基线。 |
| skill root ownership | ✅ 源码通过 | **[源码核实]** driver 只接受固定 `SIDECAR_DIR/skills`，递归拒绝 root 内任何 symlink / 非 regular entry；child env 改为指向 driver-owned、退出即清理的 materialized runtime root，并覆盖 user-provided value。 |
| skill filesystem isolation | ✅ 源码/config 通过 | **[静态检查]** `includeDefaultRoots: false`、`watchFollowSymlinks: false`，唯一 custom root 和唯一 `anqi-case-brief` frontmatter；没有默认 user/project roots。 |
| session/create exact identity | ✅ 源码通过 | **[源码核实]** 复用 inherited single-flight `getOrCreateSession()`，返回前核对 `record.handle.agent === ctx.agents.get(agent.id)`。 |
| preflight scoped tool + skill readiness | ✅ 源码通过 | **[源码核实]** exact agent-scoped `tools.schemas` / `skills.snapshot`，complete 与 names 双重门禁；不启动模型。 |
| server-side prompt preflight gate | ✅ 源码通过 | **[审查修复/源码核实]** `session/prompt` 不再落回 inherited lazy path；要求 exact live session 且 `preflightedSessions.get(sessionId) === agent`，否则拒绝。 |
| preflight race/cancellation cleanup | ✅ 源码通过 | **[源码核实]** check-before-listen/check-after-listen、version accounting、payload-free invalidations、timeout/shutdown/disposal handling、finally cleanup；无 fixed sleep。 |
| driver wire order and first-header gate | ✅ 源码通过 | **[源码核实]** 明确 create→preflight→prompt；只接受首个 `reason: initial` header，且必须含 MCP tool。 |
| actual MCP tool call in same turn | ✅ 通过 | **[2026-08-21 模型-backed redacted wire]** 同一 session/turn 出现 `tool/call.data.name === "mcp__anqi-local__case_folder_info"`，随后收到成功 `tool/result`，driver 正常完成 turn 并 shutdown。 |
| only anqi skill discoverable / no user skill | ✅ 通过 | **[2026-08-21 模型-backed redacted wire]** `session/preflight` 返回 `complete:true` 且 names 精确为 `['anqi-case-brief']`；scoped tool list 也按预期返回。 |
| first initial header with MCP tool | ✅ 通过 | **[2026-08-21 模型-backed redacted wire]** 同一 session 首个 `request/header` 的 `reason` 为 `initial`，`header.tools` 含精确 MCP 名称；不是后续 `reason: change` header。 |
| anqi domain tools read deadlines | ✅ 通过 | **[2026-08-21 模型-backed redacted wire，注入 `ANJIAN_INTERNAL_KEY` 后复跑]** 同一 session/turn 内 `anqi_case_get`、`anqi_digest` 均成功返回，读回本案（张三诉李四民间借贷纠纷）`deadlines[0]`（上诉期（判决），due_on 2026-08-21，民诉法 §171，critical/pending）与 digest `red[0]`（同一期限，days_left 0）；最终回答逐项引用上述 anqi 返回字段，未自行计算或编造期限；跑前基线独立留痕，跑后为与已知 seed 基线比对未变化（口径差异见 §15.4bis 证据等级说明），`deadlines` 表均为 3 行 / hash 均为 `aefb85ec...39fb21`。 |

上述四项 Commit 3 readiness 均已由真实模型-backed run 通过，含此前 blocked 的期限读取项。actual B trace 与 trace-derived scratch 已于 2026-08-21 由本机真实执行动态通过，见 §14.4–§14.6；仍未达成的只有 SEA runtime 完整 B end-to-end——`initialize`/`session/create` 3/3 成功，但 `session/preflight` 因真实的 `.mjs` include 不兼容三次全部失败，见 §14.5。

### 15.4 2026-08-21 动态 readiness run

只使用 Phase 1 seed demo 案件。以下是用户从 worktree 执行的 redacted wire 结果摘要，key 值未进入终端或报告：

- `initialize` 成功，`cold_ms=513.9`；
- `session/create` 返回与请求一致的唯一 session ID；
- `session/preflight` 返回 `ready:true`，scoped tools 含 `mcp__anqi-local__case_folder_info`，skills 为完整且唯一的 `anqi-case-brief`；
- 首个 `request/header` 为 `reason=initial`，header tools 含精确 MCP 工具；
- 同一 turn 实际调用 `mcp__anqi-local__case_folder_info`，结果返回精确 seed 案件夹 cwd；
- `anqi_case_get` 与 `anqi_digest` 各自失败并返回 `ANJIAN_INTERNAL_KEY is not set`；
- turn 正常结束，随后 `shutdown` 成功；driver 未计算、写入或修改 deadline/event。

### 15.4bis 2026-08-21 补跑：注入 `ANJIAN_INTERNAL_KEY` 后的 domain-tools readiness

按 §15.5 命令原样复跑，唯一差异是把 `ANJIAN_INTERNAL_KEY="$(cat "$KF")"` 一并加入 `secretctl run anjian.local -- env ...` 的注入列表（此前一次遗漏了该变量，只注入了 `ANJIAN_FILES_ROOT`/`ANQI_BASE_URL`/`DSH_PERMISSION_MODE`），server 端同样以 `ANJIAN_INTERNAL_KEY="$(cat "$KF")"` 启动隔离 3007 实例。只使用 Phase 1 seed demo 案件（张三诉李四民间借贷纠纷）。key 值全程未回显、未落盘、未进本报告；redacted 日志复查确认零次出现。

复跑前记录 `deadlines` 基线：3 行，`sha256(id|case_id|name|due_on|basis|calc_note|severity|status|done_at 逐行拼接)` = `aefb85ec4d2c041dcfeeace81342c0c82ee9bf7c159982fbd2ec60b50139fb21`。

redacted wire 结果：

- `initialize` 成功，`cold_ms=891.4`，`serverInfo.name=deepseek-harness-sdk-runtime`；
- `session/create` 返回唯一 `sessionId`（`anqi-f82ce22c-...`）；
- `session/preflight` 返回 `ready:true`；`tools.visibleNames` 含精确 `mcp__anqi-local__case_folder_info`；`skills.complete:true` 且 `skills.names` 精确为 `['anqi-case-brief']`；
- 首个 `[request/header]` 的 `reason` 为 `initial`，`header.tools` 中含精确 `mcp__anqi-local__case_folder_info`（连同 `anqi_case_get`/`anqi_digest`/`anqi_inbox_propose` 等 anqi 工具）；
- 同一 `turn:1/step:1` 内先后出现 `[tool/call]`/`[tool/result]`，实际调用 `mcp__anqi-local__case_folder_info`，返回精确 seed 案件夹 `cwd`（`.../data/files-dev/张三诉李四民间借贷纠纷`）；
- 同一 turn 的 `step:2` 内 `anqi_case_get`（`name: 张三诉李四民间借贷纠纷`）与 `anqi_digest` 均成功返回：`anqi_case_get.deadlines[0]` = 上诉期（判决）/due_on 2026-08-21/民诉法 §171/critical/pending；`anqi_digest.red[0]` = 同一期限，`days_left:0`；两者与 §15.4 之前记录的 seed 期限一致；
- 最终 assistant 回答逐项引用上述 anqi 返回字段（期限名称、到期日、依据、severity、days_left），并明确区分“任务/费用/分账”与“期限”，未自行推算或编造任何期限；回答同时提示上诉期与相关未关闭任务，但未创建 event/deadline，也未直接创建 task（仅建议律师自行操作或走 `anqi_inbox_propose`）；
- `[turn/end]` 的 `reason.kind` 为 `completed`；`session.status` 转 `idle`；`[shutdown]` 成功，driver 进程 exit 0；
- 复跑后复查 `deadlines`：仍为 3 行，hash 仍为 `aefb85ec4d2c041dcfeeace81342c0c82ee9bf7c159982fbd2ec60b50139fb21`，与跑前基线完全一致，确认 driver 未写入/修改任何 deadline；
- 结束后 `kill` 3007 监听进程，`lsof -iTCP:3007 -sTCP:LISTEN` 确认端口已释放。

因此 §15.3「anqi domain tools read deadlines」项由 ⛔ blocked 转为 ✅ 通过（模型-backed redacted wire）。

**证据等级说明（本轮修复补记）**：上面「跑前记录基线」「跑后复查」两行是叙述性描述，wf-logs 中没有单独留存一份把这两次 hash 计算结果并列写入同一个 artifact 的日志（只有 `domain-tools-readiness-rerun.log` 这份 driver stdout），这一点与 §14.4 把 scratch B 复跑的「跑前/跑后」列降级为 **[B] blocked** 是同一种缺口，理应同等对待。本轮修复尝试对该场景重新补一组独立留痕的前/后快照：直接对 `data/spike.db` 跑 `sqlite3 -separator '|' ... | shasum -a 256` 得到跑前基线 `aefb85ec4d2c041dcfeeace81342c0c82ee9bf7c159982fbd2ec60b50139fb21`（3 行，已存入 `wf-logs/deadlines-hash-verify-1787291298.log`），随后启动隔离 3007 实例、用 §15.5 命令加 `ANJIAN_INTERNAL_KEY` 原样复跑 driver 场景以取得跑后基线时，`secretctl run anjian.local`（含最小复现 `env echo hello`）再次给出 `[ERROR] error initializing client: authorization timeout`，与 §14.4/§14.6 记录的同一 blocker 一致，本会话未能补拍模型-backed 场景下的独立跑后快照。因此本行的确切证据等级应更正为：**跑前基线本轮已用直接 DB 查询独立验证并留痕**；跑后基线沿用与「结果未变」结论相同的方法——将当前 DB 状态与已知 seed 基线哈希比对（而非该次驱动运行内独立记录的两点快照）——与 §14.4 的处理口径保持一致，不再声称比 scratch 复跑更严格。

### 15.5 待 anqi 内部 key 注入后原样复跑（历史记录，已于 15.4bis 完成复跑）

只使用 Phase 1 seed demo 案件，key 仍只由 `secretctl` 注入，任何 key 值不回显、不落盘、不写报告：

```zsh
secretctl run anjian.local -- env \
  ANJIAN_FILES_ROOT="$PWD/data/files-dev" \
  ANQI_BASE_URL=http://127.0.0.1:3007 \
  DSH_PERMISSION_MODE=workspace-write \
  node spikes/dsh-agent/driver.mjs \
  --case '张三诉李四民间借贷纠纷' \
  --ask '先调用 mcp__anqi-local__case_folder_info 确认当前案件夹，再回答本案有哪些临近期限；只能读取和解释 anqi 返回的期限，不要自行计算或写入 deadline/event。'
```

获准复跑必须同时保留并核对：`session/create`、`session/preflight` 的 redacted JSON；唯一 `anqi-case-brief` skill；首个 `request/header.data.reason=initial` 与 `header.tools` 中的 MCP 名称；同一 session/turn 的实际 `tool/call.data.name`；随后才能把 skills/MCP readiness 标为动态通过。若 preflight timeout、snapshot incomplete、首 header 为 `change`/缺 MCP，或实际 tool call 缺失，整项 fail closed。
