# DSH rc.7 闭包与 macOS arm64 打包数字

## 口径与结论

本页只把不同证据等级的数字放在同一张表里，不用源码推断冒充动态测量：

- **[M] 本机测量**：本机命令实际得到；
- **[F] fixture 测量**：只运行 spike 自有 tracing fixture，没有启动 DSH；
- **[S] 源码核实**：来自 `dsh-v0.1.0-rc.7` 或已安装 exact-version 文件；
- **[B] blocked**：本轮未执行，不能填推算值。

当前建议是：**不要把 179,023,624 B 的现有全闭包直接绑进 anqi DMG；若按当前闭包交付，采用首次启用下载。** symlink-free 全闭包的 `tar.gz` 已相当于 v2.6.0 arm64 DMG 的 29.31%，`zip -9` 相当于 40.69%。这只是压缩包相加近似，不是 Electron DMG 重打包后的实测增量。真正的 bundle/download 决策仍应在一次获准的 B trace、trace-derived scratch B 复跑和 SEA runtime 复跑后重审。

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

`driver.mjs --trace-loaded` 在 spawn 前创建 mode `0700` 的系统临时目录，并要求 inherited `NODE_OPTIONS` 为空；非空即在读取 case/config 与 spawn 前 fail closed。随后它只向子环境写入一个 URL 编码的 `--import=<preload URL>`，每个 `(pid, worker threadId)` 写独立 mode `0600` JSONL。不能保留用户 `--require` / `--loader`：这些模块可先于 tracer 执行，让漏载的 summary 仍显示 complete。rc.7 源码还证明 `dsh-mcp-client` 的 `buildChildEnv()` 会合并 `scrubbedParentEnv()`，再把显式 env 交给 MCP SDK `StdioClientTransport`：credential-shaped 与 `DSH_*` 名称（包括模型 key）被剔除，受控 tracer-only `NODE_OPTIONS` 和 `ANQI_DSH_LOAD_TRACE_DIR` 保留。因此 MCP Node child 应在 boot 前装同一 tracer；这是 **[S] source evidence**，actual MCP child trace 仍是下表的 **[B]**，不能拿自有 subprocess fixture 代替。

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

固定 B prompt 位于 `fixtures/scenario-b-prompt.txt`，内容逐字为“本案有哪些临近期限？”。本会话没有借 tracing 重启 DSH：此前 full-preset DSH execution 被权限层拒绝，因此实际 B trace 保持 [B]，下列字段不能填数：

| B trace 指标 | 状态 |
|---|---:|
| unique loaded files / bytes | [B] 未运行 |
| reached dependency roots / installed bytes | [B] 未运行 |
| package parent/import evidence | [B] 未运行 |
| full closure 对实际 reached closure 的缩减率 | [B] 未运行 |

获准会话应按既有 seed-only / secret injection 边界运行：

```zsh
secretctl run anjian.local -- env \
  ANJIAN_FILES_ROOT="$PWD/data/files-dev" \
  ANQI_BASE_URL=http://127.0.0.1:3007 \
  DSH_PERMISSION_MODE=workspace-write \
  node spikes/dsh-agent/driver.mjs \
  --trace-loaded \
  --case '张三诉李四民间借贷纠纷' \
  --ask '本案有哪些临近期限？'
```

该命令若继承任何非空 `NODE_OPTIONS` 会在 spawn 前拒绝；先清理调用环境，不能靠 tracer 继续追加。只有 stderr 的 `[trace-loaded]` 行中 `completeness.complete=true`（其中 `processEntries.missing=[]`、`packageResolution.errors=0`，exact DSH/MCP entries 都已观察、event schema/结构/字节/package mapping 均完整），且同一 run 的 B 有 completed `turn/end`，该 summary 才能作为 scratch 输入。

## trace-derived scratch

本轮没有创建所谓“裁剪 runtime”。任务边界要求 scratch manifest 只能从真实 B trace 的 reached direct packages 加 required transitive closure生成；实际 trace 被阻塞后，若改用静态 `npm ls` 猜一个清单再称作 measured closure，会把“可安装”误写成“B 已覆盖”。因此以下数字保持空白：

| 对象 | 安装体积 | `tar.gz` | `zip -9` | B cold initialize | B end-to-end |
|---|---:|---:|---:|---:|---:|
| loaded/theoretical floor | [B] | [B] | [B] | n/a | n/a |
| trace-derived scratch | [B] | [B] | [B] | [B] | [B] |

后续步骤必须是：读取完整 trace summary → 只选 reached 的 direct packages（额外保留 driver 自己在 child trace 外使用的 `js-yaml`）→ 在仓库外写 manifest → `npm install --ignore-scripts` → 复制 spike-owned config/preset/plugins/MCP/driver → 用同一个固定 B prompt 复跑。只有复跑完成，才能称“validated scratch runtime”。

## 四类 native / loader helper

| 依赖 | 安装体积与原生文件 | import / parent 源码证据 | 当前 composition | text-only 最小 composition 结论 |
|---|---|---|---|---|
| `node-pty@1.2.0-beta.15` | 26,877,238 B regular files；darwin-arm64 `pty.node` 86,904 B，`spawn-helper` 50,480 B (`0755`) | `dsh-subprocess-local/lib/index.js` 顶层 import；`node-pty/lib/index.js` 在非 Windows 顶层加载 native `pty` | `anqi.cordis.yml` 显式挂 `dsh-subprocess-local`，所以即使 B 不开 terminal，它也是 startup dependency；helper 只在真正 terminal spawn 时使用 | restricted preset 没有 shell/code/subagent 工具，MCP stdio 由 MCP SDK 自己 spawn；语义上可随 subprocess row 一起裁掉，但本轮无 B scratch omission run，不能标 validated optional |
| `sharp@0.35.3` + darwin binary | 958,466 B + 292,231 B；`sharp-darwin-arm64.node` 280,256 B | `dsh-attachment-local/lib/index.js` 顶层 import；只在 image admission/read 路径调用 | host 显式挂 attachment-local，故 startup 会 reach；`tool-fs` 仅在 attachment service 存在时附加 `read_image` | 固定 B 是纯文本；可连 attachment row / `read_image` 一起裁，但未做 omission run |
| `koffi@3.1.5` + darwin binary | 1,798,526 B + 1,241,345 B；`koffi.node` 1,240,360 B | `dsh-fs-local` 与 JSONL persistence 都只在 Win32 helper 中 dynamic import；`dsh-sandbox-windows-acl` 则顶层 import | 当前 macOS composition 会 import fs-local/persistence，但按源码不应由这两条路径加载 Koffi；`dsh-sandbox-local`/Windows ACL 没有挂载 | 对 macOS text-only 应是可删除的 platform-only closure；仍需真实 trace + omission scratch 证明 npm 可在保持所需 peers 时不装它 |
| `node-addon-require-builtin@0.1.4` | 当前未安装；registry unpacked size 4,356 B | `@deepseek-ai/cordis-plugin-loader` 在未带 `--expose-internals` 时尝试 require，并 catch 缺失；peer 标为 optional | `npm ls` 中不存在，现有 rc.7 运行证据已说明 loader 不依赖它成功启动 | 保持不安装；它是可选 internal-loader fallback，不属于最小闭包 |

这里的“语义上可裁”是源码分类，不是实际-loaded 结论。最终分类必须同时具备 trace reachability、上表 parent/import path、以及 scratch retained/omitted B execution 三个信号。

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

执行 packager 的命令在真正启动外部 package code **之前**被当前权限层拒绝，理由是缺少直接点名 `@yao-pkg/pkg@6.21.0` 的执行授权。本会话没有换工具绕过。因此结果是：

| SEA 项 | 结果 |
|---|---:|
| symlink-free full staging | [M] 成功 |
| exact packager install (`--ignore-scripts`) | [M] 成功，工具目录 44,220 KiB / 37,413,121 B |
| `pkg --sea` build | [B] 未执行（permission denied before process start） |
| main executable size | [B] 无产物 |
| adjacent helper product | [B] 未复制；staged source 为 50,480 B / `0755` |
| codesign / Mach-O deployment target | [B] 无 executable 可验 |
| cold initialize | [B] 无 executable 可运行 |
| SEA B end-to-end | [B] 未运行 |
| SEA product+helper `tar.gz` / `zip -9` | [B] 无完整 product set，不生成虚假压缩数字 |

获准后应原样运行下列已经 staging 好、但本轮没有执行的命令；build 成功后仍需把 helper 复制到相邻路径、验证 executable permissions/codesign，再单独取得 runtime evidence：

```zsh
node /private/tmp/anqi-dsh-sea.3ksg7R/tool/node_modules/@yao-pkg/pkg/lib-es5/bin.js \
  /private/tmp/anqi-dsh-sea.3ksg7R/staging \
  --sea --targets node24-macos-arm64 \
  --output /private/tmp/anqi-dsh-sea.3ksg7R/dist/dsh-jsonrpc-agent-pkg-macos-arm64
```

外部 scratch 路径不是可长期依赖的交付物；若系统临时目录已清理，应按上述 route 重建，而不是把路径写进产品代码。

## 决策闸

基于已经测到的数据，可以做一个窄决定：**现有全闭包不随 DMG bundled，采用 first-enable download。** 不能做的决定是“最终永远下载”或“裁剪后仍不可 bundling”。解除闸门需要同一机器、同一固定 B 场景补齐：

1. complete actual-load trace；
2. trace-derived scratch 的安装字节、`tar.gz`、`zip -9` 和至少 3 次 cold initialize；
3. scratch B end-to-end；
4. SEA build、签名/启动、B end-to-end、至少 3 次 cold initialize；
5. SEA executable + helper product set 的两种压缩值。

在这些数字出现前，任何“理论最小闭包”“validated scratch”“SEA 可运行”都应保持 [B]，不得从 full install 的文件数或上游约 174 MB 说明反推。
