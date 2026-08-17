# 发版手册（RELEASING）

> **这是公开发行的唯一权威流程。** 本文件只描述 `zj-ai-lab/anqi` 的 GitHub Releases、GHCR 与 Android 发行；任何维护者私有部署、镜像同步或下载镜像操作都不属于公开发版流程，也不得写入本文件。

## 0. 三条发行线

案齐有三条彼此独立的发行线：

| 发行线 | tag | 产物 | 公开位置 | workflow |
|---|---|---|---|---|
| macOS 桌面版 | `vX.Y.Z` | `anqi-X.Y.Z-{arm64,x64}.dmg`、校验文件、更新元数据 | GitHub Release | `release.yml` |
| Docker | `vX.Y.Z` | multi-arch OCI image | `ghcr.io/zj-ai-lab/anqi` | `docker-release.yml` |
| Android 壳 | `android-vX.Y.Z` | 签名 APK 与校验文件 | GitHub Release | `android.yml` |

`vX.Y.Z` 会同时触发 macOS 与 Docker 两条线。`android-vX.Y.Z` 只触发 Android，不要求与服务端版本同步。

所有真实发布步骤必须只在对应 tag 上运行。三份 workflow 均可提供手动 `workflow_dispatch`，但手动运行固定为**演练**：只构建、校验并上传 Actions artifact 与 `.sha256`，不得创建或修改 GitHub Release，不得推送 GHCR，也不得连接任何外部主机。

## 1. 发版前门禁

```sh
npm ci
npm run check
```

必须满足：

- `npm run check` 显示 `ALL GREEN`，不得用 skip、删除测试或放松断言换取通过。
- `package.json` 的 `version` 是应用版本唯一事实源；`vX.Y.Z` 必须与其一致。
- `docs/CHANGES.md` 顶部速查表与文件末尾均有本版记录。
- README 的能力、下载方式、兼容性或安全说明如受本版影响，已经同步。
- 数据模型变更已同步 `docs/DESIGN.md §2`，UI 体系变更已同步 `docs/DESIGN-TOKENS.md`。
- 新 migration 有带存量 fixture 的独立测试，并已接入 `tools/check.sh`。
- 前端变更已在 `pro`、`paper`、`jade` 三种皮肤、桌面宽度和 390px 窄屏下目测；拖拽必须使用真实输入事件验收。
- 仓库中不含 `.env`、数据库、案件夹、日志、真实当事人信息、签名材料或发布密钥。
- `LEGAL-NOTICE.md` 中仍待确认的法律事项已经由有权决定的人处理；未确认时不得把草稿状态误写成最终法律结论。

先运行手动演练，验证本次代码在 GitHub 托管 runner 上能够完整构建：

```sh
gh workflow run release.yml -f dry_run=true
gh workflow run docker-release.yml -f dry_run=true
# Android 有改动时再运行：
gh workflow run android.yml -f dry_run=true
```

演练产物必须包含对应安装包或镜像归档的 SHA-256 文件。演练成功不等于已发布。

## 2. 提交与 tag

本项目的外部 PR 会按维护政策关闭；正式发布由有仓库权限的维护者从受保护分支执行。

```sh
git status --short
git push origin main
git tag -s vX.Y.Z -m "ANQI vX.Y.Z"
git push origin vX.Y.Z
```

Android 使用：

```sh
git tag -s android-vX.Y.Z -m "ANQI Android vX.Y.Z"
git push origin android-vX.Y.Z
```

`-s` 需要本机已配置 git 签名密钥（GPG 或 SSH）。尚未配置时用注解 tag `git tag -a ... -m ...` 代替，不要用轻量 tag；配好签名后再切回 `-s`。

发布 tag 应视为不可变。tag、Release 或镜像内容有误时，修复后发布更高的补丁版本；不要强制覆盖已公开 tag。连续失败三次应停止重跑，先记录根因并修复。

## 3. macOS：GitHub Release

`.github/workflows/release.yml` 在 `v*` tag 上完成：

1. 校验 tag 与 `package.json.version` 一致。
2. `npm ci`，按 Electron ABI 重建 `better-sqlite3`。
3. 分别构建 arm64 与 x64 DMG。
4. 无 Developer ID 时运行 `build/adhoc-sign.cjs`，确保应用获得本项目自己的 ad-hoc 签名而非 Electron 出厂 linker 签名；配置正式证书时钩子自动跳过。
5. 为每个 DMG 生成独立 `.sha256`，并校验名称、架构和版本。
6. 先把 DMG、校验文件和必要的更新元数据上传为 workflow artifact。
7. 仅当 `github.ref` 以 `refs/tags/` 开头时，创建同名 GitHub Release 并上传产物。

桌面版 `electron-updater` 使用 GitHub provider 查版本。当前发行物若未做 Developer ID 签名和公证，只能提示使用者到 GitHub Release 手动下载 DMG；不得承诺静默自动安装。下载后应核对 Release 附带的 SHA-256。

发布后检查：

```sh
gh release view vX.Y.Z
gh release download vX.Y.Z --pattern 'anqi-*.dmg*' --dir /tmp/anqi-release-check
```

对下载结果重新计算 SHA-256，确认与同名 `.sha256` 一致，并在对应架构的 macOS 上完成首次启动、引导页、登录和版本检查冒烟。

## 4. Docker：GHCR

`.github/workflows/docker-release.yml` 在 `v*` tag 上完成：

1. 校验 tag 与应用版本一致。
2. 使用 BuildKit 构建支持的 Linux 架构。
3. 以临时凭据启动镜像，验证 `/healthz`、镜像内版本、空库全部 migration 和鉴权 fail-closed。
4. 生成构建摘要与不可变 digest。
5. 手动演练只上传 OCI 归档及 `.sha256` workflow artifact。
6. 仅 tag 运行登录 GHCR，并推送：
   - `ghcr.io/zj-ai-lab/anqi:X.Y.Z`
   - `ghcr.io/zj-ai-lab/anqi:X.Y`
   - `ghcr.io/zj-ai-lab/anqi:latest`

部署者应优先固定完整版本或 digest；`latest` 只用于主动跟随最新版的环境。

发布后检查公开 manifest 与 digest：

```sh
docker buildx imagetools inspect ghcr.io/zj-ai-lab/anqi:X.Y.Z
```

再在隔离的临时数据卷中启动该公开镜像，确认版本、健康检查、登录门、migration 版本、`PRAGMA integrity_check` 与外键检查均符合预期。公开发版 workflow 不负责更新任何生产实例。

## 5. Android：GitHub Release

`.github/workflows/android.yml` 只在 `android-v*` tag 上发布：

1. 校验 tag 格式与 Android `versionName`。
2. 从 GitHub Actions secret 临时还原签名材料；签名材料不得写入仓库或 artifact。
3. 构建 release APK，运行 `apksigner verify`。
4. 生成 APK 的 `.sha256`。
5. 手动演练只上传 APK 与校验文件为 workflow artifact。
6. 仅 tag 运行创建同名 GitHub Release 并上传 APK 与校验文件。

发布后从 Release 重新下载 APK，复核签名、包名、版本号与 SHA-256，并在受支持的 Android 版本上验登录、深链、上传、下载和返回键行为。

## 6. migration 版本的额外要求

migration 是自托管升级中风险最高的部分：

- 每个 `0NN_*.sql` 必须有 `tools/test-migration-0NN.js`，fixture 必须带存量数据。空库 migration 干跑不能证明 `UPDATE`、触发器或约束在升级路径上可用。
- SQL 与 `PRAGMA user_version` 必须在同一事务内成功或回滚。
- 发布前用备份副本演练升级，检查目标 `user_version`、`PRAGMA integrity_check`、`PRAGMA foreign_key_check` 及本次变更涉及的数据不变量。
- SQLite WAL 模式下不能用主 `.db` 文件 SHA 判断数据库是否发生写入；一致备份应使用 SQLite backup API 或停写后的完整数据库状态。
- 回退前必须确认旧版本是否能读取新 schema。若 migration 不可逆，应恢复发版前备份，而不是让旧二进制直接打开已升级数据库。

## 7. 成品自查

- [ ] `npm ci` 与 `npm run check` 全绿，skipped 0
- [ ] `package.json.version`、tag、CHANGES 与应用自报版本一致
- [ ] 手动演练成功，workflow artifact 与 `.sha256` 可下载并复核
- [ ] 公开发布步骤均有 `startsWith(github.ref, 'refs/tags/')` 门
- [ ] workflow 没有 `pull_request` 或 `pull_request_target` 发布触发器
- [ ] 手动演练没有创建 Release、推送 GHCR 或连接外部主机
- [ ] macOS：双架构 DMG、签名状态、首次启动与版本检查通过
- [ ] Docker：公开 manifest、版本 tag、digest 与隔离启动冒烟通过
- [ ] Android（如发布）：APK 签名、包名、版本、深链与文件交互通过
- [ ] Release 说明包含主要变更、升级注意、已知限制与校验方法
- [ ] 没有上传 source map、`.env`、数据库、日志、签名材料或其他私密文件

## 8. 图标变更

- `build/icon.png` 使用 1024×1024 画布，macOS 图形本体 824×824 居中，四周各 100px 透明边，圆角 185px。
- 修改后运行 `npm run icon:build` 重建 `build/icon.icns`。
- `public/assets/anjian-icon.png` 等网页图标使用适合网页显示的裁切，不应直接沿用带 100px 透明边的 macOS 母版。
- Android adaptive icon 应在常见遮罩下保留足够安全区。
- 图标可能具有独立的品牌或商标属性；源码许可证不当然授予冒充官方发行物的权利。

## 9. 回退与撤回

| 场景 | 处理 |
|---|---|
| 演练失败 | 不打 tag；修复后重新演练 |
| tag workflow 构建失败且尚未发布 | 修复后发更高补丁版本；不覆盖公开 tag |
| Release 产物错误 | 将 Release 标为有问题并发布补丁版；必要时删除明显危险的二进制附件，但保留透明说明 |
| GHCR 镜像错误 | 发布补丁镜像并在公告中给出安全 digest；不要复用旧 tag 指向新内容 |
| migration 有问题 | 停止升级建议；按部署者自己的发版前一致备份恢复，并发布修复版 |
| 签名材料疑似泄露 | 立即撤销/轮换凭据，停止发布，按 `SECURITY.md` 处理并评估已发布产物 |

公开发行与某个具体实例的上线是两件事。GitHub Release 或 GHCR 推送成功，只能说明发行物已公开，不能说明任何部署已经升级。