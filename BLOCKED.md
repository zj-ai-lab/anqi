# BLOCKED（待裁决清单）

## P0-Docker — 本机 Docker Desktop engine 无响应（2026-08-25，待领导裁决/环境恢复）

- `docker desktop status` 显示应用 `running`，但 daemon socket 不可用：首次 `docker version` / `docker build` 返回 API 500；随后两次 `curl --max-time 5 --unix-socket ~/.docker/run/docker.sock http://localhost/_ping` 均超时、0 bytes。
- 同一 Docker 真机验收已连续失败 3 次，按任务书止损并跳过，不重启 Docker Desktop（可能影响用户现有容器），不改用 jackie 生产容器。
- Phase 6 与终局桌面验收完成后只读复查一次：沙箱外 `docker desktop status` 仍报 `running`，但 `docker version` 等待 10 秒仍无任何 Server 段；中止后只输出 Client `29.1.3`。daemon 未恢复，因此没有误把 UI 进程存活当成容器引擎可用。
- 已完成且不受影响：Dockerfile 安装 bubblewrap；macOS Seatbelt 真沙箱当前案 rw、他案/contacts read/write 拒绝；supervisor DB/workspace overlap spawn 前 fail-closed；DSH project/full 真组合通过。
- 待裁决/恢复后续跑：本地构建 `anqi-agent-phase0:local`，在容器内执行 `tools/test-agent-sandbox-boundary.js`，记录实际选中 `bwrap` 或严格 Landlock 及越界拒绝输出。Phase 0 的桌面隔离实例浏览器自测已独立完成，不再欠账。
- 工作会话 2 / 连续 goal turn 2 只读复核：当前 context=`desktop-linux`，其 endpoint 与 `/var/run/docker.sock` 均指向 `/Users/2_dogg/.docker/run/docker.sock`；直接 `_ping` 5 秒仍为 0 bytes、退出码 28。PATH 内没有 podman/colima/nerdctl/finch/container 等替代运行时。同一外部阻塞尚未恢复。
- 工作会话 3 / 连续 goal turn 3：同一 socket 再次 `_ping`，实际为 `curl: (28) Operation timed out after 5002 milliseconds with 0 bytes received`、退出码 28。已满足持续 goal 的 blocked 门槛；除等待 Docker daemon 恢复，或由领导明确授权重启 Desktop 外，没有不扩大任务权限的继续路径。

## P3-Classifier-Policy — 2 档判据/阈值/便宜模型未获 Hermes 对齐（2026-08-25，待领导确认）

- 按任务书拍板，Phase 3 只建设结构化分类器机制并默认关闭；执行者不自行决定哪些命令/查询可 `auto-allow`、哪些必须 `needs-approval`、哪些直接 `block`，也不自行设置信心阈值。
- 还需领导与 Hermes 判官对齐并明确：分类器模型/独立凭据来源、三类判据、阈值、超时预算、是否允许把完整命令/查询发送给该模型。未裁决前 2 档一律 fail closed 为人工审批卡，且写分类器裁决审计。
- 该待裁决不阻塞 Phase 3 的接口/结构校验/超时与畸形输出回归，也不阻塞后续 Phase；不得因为 2 档默认关闭而放宽 1 档或 3 档沙箱边界。
