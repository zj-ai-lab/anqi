# DSH rc.7 闭包与 macOS arm64 打包数字

## 口径与结论

本页只把不同证据等级的数字放在同一张表里，不用源码推断冒充动态测量：

- **[M] 本机测量**：本机命令实际得到；
- **[F] fixture 测量**：只运行 spike 自有 tracing fixture，没有启动 DSH；
- **[S] 源码核实**：来自 `dsh-v0.1.0-rc.7` 或已安装 exact-version 文件；
- **[B] blocked**：本轮未执行，不能填推算值。

**2026-08-21 更新**：actual B trace、trace-derived scratch 的物理复制与 B 复跑、SEA build 均已由本机真实执行补齐（见下文对应小节）。当前建议改为：**不要把 179,023,624 B 的现有全闭包、也不要把 176,279,520 B 的 SEA 单文件直接绑进 anqi DMG；若要 bundle，应 bundle trace-derived 的 reached-only scratch 闭包**（约 71,444 KiB，`tar.gz` 19,235,570 B，相当于 DMG 的 13.70%，远小于全闭包 staging 的 29.31%）。SEA 单文件本身已比整个 v2.6.0 DMG 还大（125.56%），且实测在本 spike 目录布局下 `session/preflight` 因真实的 `.mjs` include 不兼容而失败（见「rc.7 SEA 路线与本机结果」），尚不是可用的交付路径；`initialize`/`session/create` 已验证 SEA 产物本身可以启动，但完整 B 场景仍未跑通。

## 环境与全闭包基线

测量日期为 2026-08-19；主机为 macOS arm64，Node `v26.3.1`、npm `11.16.0`。spike `package.json` 要求 Node `>=22`，但 `--trace-loaded` 进一步要求提供同步 `node:module.registerHooks()` 的 Node 22.15+/23.5+ 或更新版本。

| 对象 | 证据 | 结果 | 说明 |
|---|---:|---:|---|
| `spikes/dsh-agent/node_modules` 磁盘占用 | [M] | 252,160 KiB | `du -sk`；即报告早期四舍五入的 247 MiB。 |
| `node_modules` regular-file 逻辑字节 | [M] | 179,023,145 B | 27,848 个 regular files。 |
| npm package roots | [M] | 363 | `npm ls --all --parseable` 的 364 行减去 workspace root。 |
| upstream-style symlink-free staging | [M] | 252,164 KiB / 179,023,624 B | 仓库外 staging；仅注入 479 B deploy-root `package.json`，复制 `node_modules`，排除 `.bin/`，`find -type l` 为零。 |
| staging `tar.gz` | [M] | 41,153,091 B | 对上述 staging 用默认 gzip 压缩。 |
| staging `zip -9` | [M] | 57,118,441 B | 从 staging 根以相对路径运行 Info-ZIP `zip -9 -r`。 |
| anqi v2.6.0 arm64 DMG | [M] | 140,389,719 B | GitHub release asset `anqi-2.6.0-arm64.dmg` 的实际 size 字段。 |
| DMG + `tar.gz` 简单相加 | [M] | 181,542,810 B | 增量为原 DMG 的 29.31%；不是重打 DMG 结果。 |
| DMG + `zip -9` 简单相加 | [M] | 197,508,160 B | 增量为原 DMG 的 40.69%；不是重打 DMG 结果。 |

Commit 2 开始前另做过一份“整个 sidecar、排除 `.runtime`/local config”的 baseline：`tar.gz` 41,241,112 B、`zip -9` 58,255,174 B。它包含报告和设计文档，不如上表的 deploy staging 口径干净，因此不用于建议计算，但保留用于复核前后口径。

## 实际加载追踪

`driver.mjs --trace-loaded` 在 spawn 前创建 mode `0700` 的系统临时目录，并要求 inherited `NODE_OPTIONS` 为空；非空即在读取 case/config 与 spawn 前 fail closed。随后它只向子环境写入一个 URL 编码的 `--import=<preload URL>`，每个 `(pid, worker threadId)` 写独立 mode `0600` JSONL。不能保留用户 `--require` / `--loader`：这些模块可先于 tracer 执行，让漏载的 summary 仍显示 complete。rc.7 源码还证明 `dsh-mcp-client` 的 `buildChildEnv()` 会合并 `scrubbedParentEnv()`，再把显式 env 交给 MCP SDK `StdioClientTransport`：credential-shaped 与 `DSH_*` 名称（包括模型 key）被剔除，受控 tracer-only `NODE_OPTIONS` 和 `ANQI_DSH_LOAD_TRACE_DIR` 保留。因此 MCP Node child 应在 boot 前装同一 tracer；这段推导本身是 **[S] source evidence**。下文「2026-08-21 actual B trace」已实跑核实：`processEntries.observed` 精确含被追踪的 MCP child（`mcp/server.mjs`），把这条 source-evidence 推导确认为 **[M] 本机测量**，不再需要拿自有 subprocess fixture 代替。

追踪与 fail-closed 汇总面如下：

- `Module._resolveFilename` + `Module._load`：成功/失败 CJS resolution、调用方 `parent.filename`、resolved file、成功返回；覆盖 `createRequire()`；
- 同步 `registerHooks({ resolve, load })`：ESM parent/import edge、resolved URL、format，以及进入 loader 的 JS/CJS/MJS/JSON/native/WASM URL；成功文件按物理 realpath 去重，loader source bytes 与退出后 `stat` fallback 分栏；
- node_modules 内 loaded file 以最内层 `node_modules/<name>` 或 `node_modules/@scope/<name>` boundary 为 install root，绝不向上穿越到 host project；该 boundary 的 `package.json` 缺失、不可读、畸形或无 `name` 会去重计入 `packageResolutionErrors`；非依赖文件才向上找最近具名 manifest；package 自身 regular-file bytes 不递归重复计算嵌套 `node_modules`；同时读取 spike `package.json` 的 direct dependencies，只把位于顶层且名称在该集合中的 reached root 标为 direct；
- installed-byte traversal 的 `readdir` / `lstat` 错误逐 package 与聚合计数；任一 traversal error、package-resolution error 或 loaded-file byte unknown 都让 `completeness.complete=false`，不允许作为 scratch manifest 输入；
- raw edge 留在 JSONL，`summary.json` 为每个 reached package 保留最多 8 条 `specifier → parentURL → resolvedURL` 证据；summary 以 exclusive-create mode `0600` 写入，拒绝覆盖 child 预先放置的同名对象；
- 每个 trace 文件校验 `<pid>-<tid>.jsonl` 与 record identity、从 1 连续递增的 `seq`、唯一首条 `trace.start` 及 terminal marker 位置；每种 event 另有 closed schema，unknown event、number URL、string byte count、越界 text 或未知字段都会成为 structural error；`file:` identity 还必须经 `fileURLToPath()` 变成本机路径，remote-host/redacted identity 均 fail closed；driver 还要求同一 summary 同时观察到 exact DSH entry 与 exact MCP entry，且所有 start 都有 exit，才可得到 `complete=true`；
- 每文件最多 32 MiB、每个完整文本字段（含 omission marker）最多 4 KiB；预留 512 B 后再写固定 `trace.dropped`，超过上限即停追踪且 summary 必为 incomplete，不影响目标进程；
- `data:` 只记协议名；绝对 URL、相对 path-like specifier 及其他失败 specifier 的 URL-like 后缀均不会保留 userinfo/query/hash；已知 API/internal key 值会在 decoded file path 与普通 text 上二次替换；若替换改写 identity URL，该 record 被 schema 拒绝并令 summary incomplete；不记录模块源码、完整环境、JSON-RPC 内容或模型请求。

这些校验用于发现截断、缺进程和普通损坏，**不是 cryptographic authenticity**：被测 child 与 tracer 同 uid、可写该临时目录，恶意代码仍可伪造结构正确的记录。它只能作为受信 pinned closure 的诊断证据，不能当安全审计日志。

自有 fixture 的真实结果：

| 项 | 证据 | 结果 |
|---|---:|---:|
| trace processes | [F] | 2（父 ESM + 继承 `NODE_OPTIONS` 的 Node child） |
| completeness | [F] | 2026-08-20 重跑：2 start / 2 exit / 0 dropped / 0 malformed / 0 schema/structural errors / 0 byte / package-resolution errors；required fixture entry observed，`complete=true` |
| negative gates | [F] | non-empty inherited `NODE_OPTIONS` 在 spawn 前 exit 1；synthetic PID/sequence mismatch + missing required entry 得到 `complete=false`；invalid `module.load` 与 remote-host `file:` loads 均形成 validation errors；unreadable package child 得到 `installedByteErrors=1`、direct package 仍正确识别；loaded package 缺 manifest 得到 `packageResolutionErrors=1`、不再误归 project；各项均 `complete=false` |
| privacy / field bound | [F] | `data:` source、relative URL query 与 known-key-value sentinel 均未出现在 raw JSONL；known-key synthetic parent path 只留 marker 且令 summary incomplete；5000-byte failed specifier 的完整字段为 4095 B，所有字段 ≤4096 B |
| resolution edges | [F] | ESM 5、CJS 2、CJS error 0 |
| load events | [F] | universal loader 7、CJS calls 4（4 successful） |
| unique loaded files | [F] | 2 |
| actual load instances | [F] | 3；同一 CJS 的 `module.load` + `cjs.load` 双证据只计一次实际 instance |
| unique source bytes | [F] | 726 B；stat fallback 0、unknown 0 |

固定 B prompt 位于 `fixtures/scenario-b-prompt.txt`，内容逐字为“本案有哪些临近期限？”。

**2026-08-21 actual B trace（[M] 本机测量，真实执行）**：按下方命令原样跑，`turn/end.reason.kind=completed`（`[shutdown]` 随后输出，外层 shell 未额外捕获 `driver.mjs` 自身 `$?`），`[trace-loaded]` 行自带被追踪子进程的 `"exit":{"code":0}`、`completeness.complete=true`、`processEntries.missing=[]`、`packageResolution.errors=0`：

| B trace 指标 | 结果 |
|---|---:|
| unique loaded files | 480（`loadInstances=696`，`measuredBytes=4,148,858` 含 `statFallbackBytes=367,160`，`unknownByteFiles=0`） |
| reached dependency roots / installed bytes | 84 / 63,475,270 B（其中 14 个 direct dependency roots，6,770,685 B） |
| package parent/import evidence | `summary.json` 的 `packages[].reachEvidence` 逐包保留最多 8 条 `specifier → parentURL → resolvedURL`；两个被追踪进程（`mcp/server.mjs`、`dsh-sdk-jsonrpc-demo/lib/bin.js`）均在 `processEntries.observed` 中精确出现 |
| full closure 对实际 reached closure 的缩减率 | 包数 84/363 = 23.14%；字节数 63,475,270/179,023,145 = 35.46% |
| `edges.cjsResolveErrors` | 12，逐条核实为 node-pty/sharp 的多路径 prebuilt 探测失败（最终仍成功 resolve 到真实 prebuilt）与 §「四类 native」已知的 `node-addon-require-builtin` 可选探测，均不影响 `complete=true` |

四类 native 的 reach 结论（逐包核对 `summary.json` 的 `packages` 数组）：`node-pty`（26,877,238 B）与 `sharp` 系（`sharp` 958,466 B + `@img/sharp-darwin-arm64` 292,231 B + `@img/sharp-libvips-darwin-arm64` 17,777,811 B）均 **reached**（`dsh-subprocess-local`/`dsh-attachment-local` 是 always-mounted service，非按需触发）；`koffi`/`@koromix/koffi-darwin-arm64` **未 reached**（`packages` 数组中不存在），验证「四类 native」表原有的源码推断为真实测量结果。

原样命令（已按此真实执行，seed-only 数据、secret value 未回显/落盘；比早期只写 `ANJIAN_FILES_ROOT`/`ANQI_BASE_URL`/`DSH_PERMISSION_MODE` 的版本多了 `ANJIAN_INTERNAL_KEY` 与显式 `env -u NODE_OPTIONS`，这才是实际注入列表）：

```zsh
KF=/path/to/spike-internal-key   # 值绝不回显/落盘
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

该命令若继承任何非空 `NODE_OPTIONS` 会在 spawn 前拒绝；`env -u NODE_OPTIONS` 显式清空继承值，不能只靠 tracer 校验，也不能靠 tracer 继续追加。只有 stderr 的 `[trace-loaded]` 行中 `completeness.complete=true`（其中 `processEntries.missing=[]`、`packageResolution.errors=0`，exact DSH/MCP entries 都已观察、event schema/结构/字节/package mapping 均完整），且同一 run 的 B 有 completed `turn/end`，该 summary 才能作为 scratch 输入。

## trace-derived scratch

**2026-08-21 已完成（[M] 本机测量，真实执行）**：在 `/private/tmp/claude-501/-Users-2-dogg-code-anqi/77e8ff17-aa4b-4fc2-b8f4-1d126c10cdba/scratchpad/wf-logs/scratch-closure` 按上表 actual B trace 的 84 个 reached dependency（`summary.json` 的 `packages[].dependency===true`）**物理复制**（而非重新 `npm install` 解析版本——避免 semver 重新解析选到与 trace 不同的嵌套版本，例如 `@deepseek-ai/dsh-skill-filesystem` 自带的嵌套 `chokidar@5.0.0`/`readdirp@5.1.1` 与顶层 `chokidar@4.0.3`/`readdirp@4.1.2` 并存），再复制 spike-owned `agent.config.yaml`/`anqi.cordis.yml`/`driver.mjs`/`package.json`/`mcp`/`plugins`/`preset`/`skills`/`trace-loaded`/`fixtures`。

构造中发现并修复一个真实的复制顺序 bug：按 rootURL 逐包 `cp -R` 时若先处理某包再处理其自带的嵌套 `node_modules` 子项，`mkdirSync` 递归建出的中间目录会让后续整包复制把源目录误嵌套进已存在的目标目录里一层；修复为按路径深度升序处理，并显式跳过已被祖先包整体复制覆盖的嵌套子项（84 项中 2 项如此覆盖，实际 `cp -R` 调用 82 次）。复制后 `find <scratch> -type l` 为零 symlink。修 bug 前有一次复跑因该 bug 在 `session/create` 就失败（`scratch-b-run-1787284664.log`），其 `cold_ms=598.3` 只到 `initialize`，不是成功跑的样本；下表 3 个 cold_ms 均取自修 bug 后的 3 次成功跑。

| 对象 | 安装体积 | `tar.gz` | `zip -9` | B cold initialize（3 次） | B end-to-end |
|---|---:|---:|---:|---:|---:|
| trace-derived scratch | 71,444 KiB（regular-file 63,575,509 B，3,495 files，排除运行期生成的 `.runtime/` 与 tooling 用 manifest） | 19,235,570 B | 20,965,712 B | 551.3 / 592.1 / 526.4 ms | 3/3 次 `turn/end.completed` 后 `[shutdown]`（外层 exit code 未逐跑单独捕获）；工具集合与只读性质三次一致，其中第 3 次与 full closure 实测逐项一致（第 1/2 次把三个调用并入同一并行 step），`deadlines` hash 复核不变 |
| 相当于 full closure | 28.33%（KiB） | 46.74%（相对 full staging tar.gz） | — | — | — |
| 相当于 anqi v2.6.0 arm64 DMG | — | 13.70% | 14.93% | — | — |

复跑命令：把 §「实际加载追踪」的 driver 命令中 `node spikes/dsh-agent/driver.mjs` 换成 scratch 目录下的 `driver.mjs`（其 `SIDECAR_DIR` 由 `import.meta.url` 动态计算，`node_modules`/`mcp`/`preset` 等路径自动跟随 scratch 目录），去掉 `--trace-loaded`，其余 env/case/prompt 不变。

## 四类 native / loader helper

| 依赖 | 安装体积与原生文件 | import / parent 源码证据 | 当前 composition | actual trace reach（2026-08-21） |
|---|---|---|---|---|
| `node-pty@1.2.0-beta.15` | 26,877,238 B regular files；darwin-arm64 `pty.node` 86,904 B，`spawn-helper` 50,480 B (`0755`) | `dsh-subprocess-local/lib/index.js` 顶层 import；`node-pty/lib/index.js` 在非 Windows 顶层加载 native `pty` | `anqi.cordis.yml` 显式挂 `dsh-subprocess-local`，所以即使 B 不开 terminal，它也是 startup dependency；helper 只在真正 terminal spawn 时使用 | **reached**（`installedBytes=26,877,238`，`loadedFiles=6`）；固定 B（纯文本）下即被 startup import 触发，与「按需触发」推断一致但**不可裁**——`dsh-subprocess-local` 是本组合的 always-mounted service |
| `sharp@0.35.3` + darwin binary | 958,466 B + 292,231 B；`sharp-darwin-arm64.node` 280,256 B | `dsh-attachment-local/lib/index.js` 顶层 import；只在 image admission/read 路径调用 | host 显式挂 attachment-local，故 startup 会 reach；`tool-fs` 仅在 attachment service 存在时附加 `read_image` | **reached**（`sharp` 958,466 + `@img/sharp-darwin-arm64` 292,231 + `@img/sharp-libvips-darwin-arm64` 17,777,811 = 19,028,508 B）；同样是 always-mounted service 触发，不是本次问答内容触发 |
| `koffi@3.1.5` + darwin binary | 1,798,526 B + 1,241,345 B；`koffi.node` 1,240,360 B | `dsh-fs-local` 与 JSONL persistence 都只在 Win32 helper 中 dynamic import；`dsh-sandbox-windows-acl` 则顶层 import | 当前 macOS composition 会 import fs-local/persistence，但按源码不应由这两条路径加载 Koffi；`dsh-sandbox-local`/Windows ACL 没有挂载 | **未 reached**——`summary.json` 的 `packages` 数组中不存在 `koffi`/`@koromix/koffi-darwin-arm64`，源码推断得到真实验证；对 macOS 可安全排除 |
| `node-addon-require-builtin@0.1.4` | 当前未安装；registry unpacked size 4,356 B | `@deepseek-ai/cordis-plugin-loader` 在未带 `--expose-internals` 时尝试 require，并 catch 缺失；peer 标为 optional | `npm ls` 中不存在，现有 rc.7 运行证据已说明 loader 不依赖它成功启动 | 仍未安装；trace 中唯一相关记录是一条无害的 `cjs.resolve-error`（loader 的可选 peer 探测），不构成 reach |

`node-pty`/`sharp` 系“reached 但不可裁”的结论现在有真实 trace 支撑：Cordis 在 boot 时按 composition 列表 eager mount 这些 service，不依赖某次问答是否真的触发 terminal/图片读取；`koffi` 未 reached 也已由同一次真实 trace 验证，不再只是源码分类。

## rc.7 SEA 路线与本机结果

上游 exact tag `dsh-v0.1.0-rc.7` 的 `scripts/build-exe-for-python-sdk.ts` 定义：

1. `pnpm run verify-runtime-closure` 与 build；
2. 从 `python/sdk-runtime` deploy root 做 `--prod --legacy --config.node-linker=hoisted` staging；
3. 补回 legacy deploy 遗漏的 direct deps，物化所有 symlink，移除 `.bin` symlink；
4. 把 bin 设为 `node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js`；
5. pkg assets 包含 whole-tree `js/cjs/mjs/package.json/json/node/wasm`；
6. 对单一 target 运行：

```text
pnpm dlx @yao-pkg/pkg@6.21.0 <staging> \
  --sea --targets node24-macos-arm64 \
  --output <dist>/dsh-jsonrpc-agent-pkg-macos-arm64
```

7. 从 staging 单独复制 `node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` 为 executable 旁边的 `dsh-jsonrpc-agent-pkg-macos-arm64-spawn-helper`，并 chmod `0755`。

因此 macOS 产物不是严格单文件，而是“一个主 runtime executable + 一个相邻 helper”。`pty.node` 由 `node_modules/**/*.node` 进入 SEA VFS；helper 没有匹配该 glob，必须单独放置。upstream architecture note 报告约 174 MB executable，但那是上游文档值，不是本机测量。

当前仓库不是完整 DSH monorepo，没有 `python/sdk-runtime` deploy root、workspace packages 和 builder。为了尽量贴近其 post-deploy 输入，本轮在 `/private/tmp/anqi-dsh-sea.3ksg7R/staging` 物化了当前 production closure：零 symlink、packaged entry 存在、darwin-arm64 native/helper 存在；另在仓库外以 `--ignore-scripts` 安装 exact `@yao-pkg/pkg@6.21.0`。本机 `/usr/bin/codesign` 存在。

此前一轮执行 packager 的命令在真正启动外部 package code **之前**被权限层拒绝。**2026-08-21，同一台机器、同一份 staging，权限边界已放行**，用同一条命令原样重跑，**exit 0**：

```zsh
node /private/tmp/anqi-dsh-sea.3ksg7R/tool/node_modules/@yao-pkg/pkg/lib-es5/bin.js \
  /private/tmp/anqi-dsh-sea.3ksg7R/staging \
  --sea --targets node24-macos-arm64 \
  --output /private/tmp/anqi-dsh-sea.3ksg7R/dist/dsh-jsonrpc-agent-pkg-macos-arm64
```

pkg 的依赖静态分析打印大量 `Warning Cannot find module ...`（`@aws-sdk/util-hex-encoding`、`tape`、`@earendil-works/pi-ai/providers/*`、`@ljharb/eslint-config` 等测试/可选路径），均为正常的可选/开发期引用，不是构建失败。构建过程中 pkg 从 `https://nodejs.org/dist/v24.19.0/node-v24.19.0-darwin-arm64.tar.gz` 下载官方 Node 运行时以生成 SEA blob——这是 packager 自身构建期的网络访问，超出「出站仅 api.deepseek.com」的运行时白名单范围，如实记录为构建期观察，不属于本 spike 运行时行为。

| SEA 项 | 结果 |
|---|---:|
| symlink-free full staging | [M] 成功，252,164 KiB / 179,023,624 B |
| exact packager install (`--ignore-scripts`) | [M] 成功，工具目录首次测得 44,220 KiB / 37,413,121 B；2026-08-21 修复轮复核重测为 43,248 KiB——工具目录是仓库外 ephemeral scratch（`--no-save --package-lock=false`），两次测量间隔跨天，数值漂移符合预期，不代表可复现的固定安装体积 |
| `pkg --sea` build | **[M] 2026-08-21 成功**，exit 0（首次跑日志无显式 `EXIT` 标记，同日修复复核用相同命令换 `--output` 名重跑并显式 `echo EXIT=$?` 捕获为 0）。同日 verify 系列另跑 3 次：等长（33 字符）对照名成功（`wf-logs/sea-build-verify-samelen.log`）、长名（`...-verify-1787291298`，`wc -c` 实测 **51 字符**，此前误记「52 字符」）成功、其间一次同类重跑因 pkg 自身 `TypeError: fetch failed` 以 `EXIT=2` 失败（`wf-logs/sea-build-verify-1787291298b.log`，此前遗漏未计入，本轮补记）——但当时只留了 `EXIT=0` 的 stdout，没有把 `stat`/`cmp` 结果写进日志，且两个重建产物事后都已清理，「产物体积与首次一致」这一结论当时缺留痕支撑。本轮修复：首次构建产物仍留存于临时目录，直接 `stat`；另用与首次等长（33 字符）的全新对照名 `dsh-jsonrpc-agent-sizecheck-arm64` 重新构建，命令、`EXIT=$?`、两产物 `stat`、`cmp -l` 全部写入新建并保留的 `wf-logs/sea-size-proof.log`。这次构建实际跑了两次 attempt：attempt 1 因 `TypeError: fetch failed` 以 `EXIT=2` 失败，attempt 2 `EXIT=0` 成功（均计入下方次数统计）。两文件均为 176,279,520 B，逐字节大小相同；`cmp -l` 报告 45 字节不同，但日志只截取了前 5 个差异 offset（92274763–92274768，同一段狭窄区间内），**`sea-size-proof.log` 本身没有运行过 `codesign`**（该日志只记录 `stat`/`cmp`）——此前「与 `codesign -d -vvvv` 报告的 embedded `CodeDirectory`……所在区域相符」一句在 wf-logs 中查无对应输出，已于此前一轮撤回，改为如实记录：仅确认体积相同、45 字节级差异存在，未验证具体成因。第四次修复轮已对同一份仍留存的产物单独补跑 `codesign -dv`（不复用 size-proof 流程），完整输出写入 `wf-logs/sea-codesign-proof.log`：`CodeDirectory v=20400 size=343875 flags=0x2(adhoc) hashes=10739+2 location=embedded`、`TeamIdentifier=not set`，与下表「main executable size」「codesign / Mach-O deployment target」两行一致；45 字节 `cmp` 差异的具体成因仍未核实，不作断言。此次构建 attempt 2（成功的一次）按 `sea-size-proof.log` 的 `downloaded-runtime-check` 一节实测为「未见 nodejs.org 下载行，疑似命中缓存」（日志原文 `cache hit likely`），但同一日志 attempt 1 恰以 `fetch failed` 失败，本轮构建确实发起过网络 I/O 且失败过一次，不能说本轮「未触发构建期联网例外」。此前「长名体积变为 176,279,536 B」这一具体数字对应的产物已被清理，本轮未重新验证该数字，不再重复无留痕支撑的断言；「体积随 `--output` 字符串长度变化」这一定性结论不受影响。按 wf-logs 逐份如实合计，本 spike 全程共 **8 次构建尝试，其中 1 次仅见于 `sea-size-proof` 前言自述、无独立 EXIT 留痕（不计入成功/失败口径）、2 次因网络 `fetch failed` 失败**：`sea-build-1787285103`（首次，成功）、`sea-build-fixup-1787287413`（f2c657a 修复轮，成功）、`verify-1787291298`（成功）、`verify-1787291298b`（网络失败）、`verify-samelen`（成功）、`sea-size-proof` 前言自述的一次早前构建（zsh 下误用 `${PIPESTATUS[0]}`，构建完成、产物 176,279,520 B，但无独立 EXIT 留痕）、同一份日志内正式捕获的 attempt 1（网络失败）与 attempt 2（成功）——此前「4 次构建尝试、1 次失败」只统计了其中一个子集且把 `sea-size-proof` 的两次 attempt 记成一次 |
| main executable size | **[M]** 176,279,520 B，Mach-O 64-bit arm64 thin；`codesign -dv` 已于第四次修复轮补测（`wf-logs/sea-codesign-proof.log`）：`flags=0x2(adhoc)` |
| adjacent helper product | **[M]** 从 staging 复制并 `chmod 0755`：50,480 B |
| codesign / Mach-O deployment target | **[M] 第四次修复轮补测**（`wf-logs/sea-codesign-proof.log`）：`CodeDirectory v=20400 size=343875 flags=0x2(adhoc) hashes=10739+2`；`TeamIdentifier=not set`（本机自签，非分发签名） |
| cold initialize（3 次，仅到 `session/create`） | **[M]** 796.7 / 598.4 / 334.5 ms |
| SEA B end-to-end | **[M] 部分失败**：`initialize`/`session/create` 3/3 成功；`session/preflight` 3/3 因真实的 `extension ".mjs" not supported` include 错误失败（见下），非权限拦截 |
| SEA product+helper `tar.gz` / `zip -9` | **[M]** 48,133,738 B / 47,926,602 B（相对 DMG 34.29% / 34.14%） |

**运行时验证**：用一份仓库外临时副本（保留在 `wf-logs/sea-driver.mjs`，未提交到 spike 代码；与已提交 `driver.mjs` 的 `diff` 为 3 处改动、共 11 行变化——8 行新增／3 行删除，即新增 `SEA_TEST_EXECUTABLE` 校验、`childArguments` 置空、spawn 目标改指向该 executable 外加说明注释，无其他改动）把子进程 spawn 目标从 `node DSH_BIN CORDIS_CONFIG` 换成直接执行上述 SEA executable（沿用 driver 已有的 `DSH_CORDIS_CONFIG` 环境变量优先机制，其余 env/cwd/case 与 actual B trace 命令一致），跑 3 次，`initialize`/`session/create` 均成功，随后 `session/preflight`（触发 `agent-presets` 挂载 `preset/anqi`）三次均以同一条真实错误失败：

```text
Error: dsh-jsonrpc-agent: plugin tree failed to load: failed to apply loader entry include (cordis:include): extension ".mjs" not supported
    at new Include (file:///snapshot/staging/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:135:34)
    ...
    at file:///Users/2_dogg/code/anqi-spike-dsh/spikes/dsh-agent/mcp/#include
```

即 packaged（SEA/snapshot）运行时的 Cordis include loader，在扫描 sidecar 自身目录树时拒绝对 host 磁盘（`/snapshot/staging` 之外）的 `.mjs` 文件做动态 include，命中的正是本 spike 保留在磁盘上的 `mcp/server.mjs`。这是一个**真实执行发现的具体 SEA 不兼容点**，不是权限拦截（`initialize`/`session/create` 已证明产物本身可以启动并完成握手），本轮没有为了跑通而重命名文件、改造 include 路径或修改 node_modules 来绕过它。修复方向（未实施）：upstream 的 `packaged-bin.js` 注释提示「Bare plugins resolve from the installed runtime closure while relative plugins remain configuration-relative」——真正的 SEA 部署需要把 `mcp/server.mjs` 这类外部 ESM 入口也折进 pkg 的 snapshot 资产，而不是留在 snapshot 之外的宿主目录；这是 spike 自身目录布局与 upstream 打包假设之间的错配，不是 pkg 或 DSH 本身的缺陷。

外部 scratch 路径（`/private/tmp/anqi-dsh-sea.3ksg7R`）不是可长期依赖的交付物；若系统临时目录已清理，应按上述 route 重建。

## 决策闸

**2026-08-21 更新**：解除闸门所需的五项已全部由真实执行补齐（见上文对应小节），闸门状态由此改变：

1. ✅ complete actual-load trace——`complete=true`，reached 84 deps / 63,475,270 B；
2. ✅ trace-derived scratch 的安装字节（71,444 KiB）、`tar.gz`（19,235,570 B）、`zip -9`（20,965,712 B）和 3 次 cold initialize（551.3 / 592.1 / 526.4 ms）；
3. ✅ scratch B end-to-end——3/3 次 `turn/end.completed`（外层 exit code 未逐跑单独捕获）、工具集合与只读性质一致（第 3 次与 full closure 逐项一致，第 1/2 次并行粒度不同）、`deadlines` 不变；
4. ⚠️ SEA build、签名、启动均成功（cold initialize 3 次：796.7 / 598.4 / 334.5 ms，但只到 `session/create`）；**B end-to-end 未达成**——`session/preflight` 因真实的 `.mjs` include 不兼容失败（非权限拦截，见「rc.7 SEA 路线与本机结果」）；
5. ✅ SEA executable + helper product set 的两种压缩值：`tar.gz` 48,133,738 B、`zip -9` 47,926,602 B。

基于这些数字可以做的决定：**若要 bundle，bundle trace-derived scratch 闭包（tar.gz 19,235,570 B，相当于 DMG 的 13.70%），不要 bundle 现有全闭包（29.31%），也不要用 SEA 单文件（本身已比整个 DMG 大，且完整 B 场景在本 spike 目录布局下尚未跑通）。** 不能做的决定是“SEA 已验证可用”——`session/preflight` 之后的行为仍未验证；也不能做“scratch 闭包对所有 anqi 交互都是最终下限”的决定——`node-pty`/`sharp` 系是 always-mounted service 触发的，其余工具（write/edit、审批、ask-user 等）在这次固定 B 场景下的运行时代码路径未必被完全练到，仍只覆盖到「reach 出新的顶层 package」这一层，不覆盖“同一批已 reached 包内部还有多少额外代码路径”。修复 SEA 的 `.mjs` include 问题、并补一次 SEA 下的完整 B end-to-end + 3 次完整-turn cold initialize，是重新评估 SEA 路径可行性的前提。
