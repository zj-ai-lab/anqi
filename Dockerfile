# Debian glibc base — NOT alpine：better-sqlite3 使用 glibc 预编译产物，
# 同时避免低功耗自托管设备上的 musl / Node futex 兼容问题。
# 必须 ≥22：better-sqlite3 v13 要求 Node ≥22；其 N-API 预编译产物随包自带（linux-x64 / arm64），构建阶段无需编译工具链。
# 安装时必须 --ignore-scripts：node:22 自带的 npm 10 不认 better-sqlite3 v13 的 "gypfile": false，
# 见到 binding.gyp 就会跑 node-gyp rebuild，而 slim 镜像没有 Python / 编译器（npm ≥11.7 才认该字段）。
# 三个运行时依赖（better-sqlite3 / express / electron-updater）都不需要安装脚本；docker-release.yml 的冒烟会验证二进制能加载。
# 公开多架构镜像由 docker-release.yml 构建并发布到 GHCR；本地也可直接构建。
FROM node:22-slim

ENV NODE_ENV=production TZ=Asia/Shanghai HOST=0.0.0.0
WORKDIR /app

# DSH bash 的 Linux 首选沙箱后端。安装成功不等于可用：运行期仍由
# dsh-anqi-sandbox 做功能探测；容器策略若不允许 user namespace，会继续尝试
# 随 runtime npm 包分发的 Landlock launcher，两者都不能兑现读写隔离时严格
# fail closed，绝不裸跑 bash。
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

# ---- AI 助理（DSH sidecar）运行时依赖 ----
# src/agent/runtime 是一个独立的 npm 包根（@anqi/agent-runtime），根
# package.json 没有 workspaces，上面那条根 npm install 永远装不到它——桌面版
# 靠 electron-builder 的 build.extraResources 把这整棵目录（含 node_modules）
# 随包分发解决；Docker 这条路径此前完全没处理过，COPY src ./src 只会把
# src/agent 的源码带进镜像，supervisor.js 实际 spawn 的 DSH 子进程
# （node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/bin.js）在干净镜像里
# 从不存在，AI 助理必然启动失败。
#
# 单独成一层且放在 COPY src 之前：这棵依赖树（DeepSeek Agent SDK 全家桶，见
# src/agent/runtime/package.json）只随 rc 版本号变化，比 src/**、public/** 稳定
# 得多——分层缓存下，日常改业务代码不会使这层失效、不必每次都重新
# npm ci 这 250MB+ 的依赖。
#
# --ignore-scripts：与 release.yml「Install AI 助理 runtime 依赖」步骤同一条
# 命令、同一条理由——这棵依赖树里没有任何脚本是加载所必需的（koffi/node-pty
# 等原生模块的 install 脚本只是"没有匹配预编译产物时的兜底重新构建"，实测
# 桌面版三个平台的 DMG 用同一条 --ignore-scripts 装出来的 node_modules 均已
# 真实跑通 AI 助理，见 docs/CHANGES.md 与 docs/RELEASING.md）；镜像不需要
# Python / 编译器工具链正是靠跳过这些脚本换来的。不加 --omit=dev：这棵
# package.json 本就没有 devDependencies，写不写效果一样，跟随 release.yml
# 的原样写法，避免两处出现"看似不同、实则等价"的命令徒增读者疑惑。
COPY src/agent/runtime/package.json src/agent/runtime/package-lock.json* ./src/agent/runtime/
RUN cd src/agent/runtime && npm ci --ignore-scripts && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public
COPY rules ./rules
COPY tools ./tools

# ---- assets/node_modules 符号链接：无需在此处理 ----
# cordis 插件 / mcp/server.mjs 用 ESM `import '@deepseek-ai/...'`，解析靠
# src/agent/assets 目录下一条指向 ../runtime/node_modules 的符号链接。桌面版
# 打包后是"已签名资源树"，链接必须在构建期建好（见
# build/afterpack-agent-runtime-link.cjs）；但 Docker 里 __dirname 解析走的
# 是仓库相对路径这条"dev 模式"分支（process.resourcesPath 只在 Electron
# 进程里存在，裸 `node server.js` 下始终是 undefined）——src/agent/
# supervisor.js 的 ensureAssetsNodeModulesLink() 在这条分支下本来就会在每次
# agent start() 之前运行时自建/自纠这条链接（镜像可写层，不涉及签名封存问
# 题），跟本机裸 `node server.js` 开发时的行为完全一致，不需要在 Dockerfile
# 里额外建软链或设 NODE_PATH（NODE_PATH 对 ESM import 说明符解析也确实不
# 生效，即便想用也代替不了这条链接）。
#
# ---- AI 助理会话记录默认落点：同理不需要额外处理 ----
# server.js 只在设了 ANJIAN_AGENT_SESSION_ROOT 时才覆盖 supervisor 的默认
# sessionRoot（electron/main.js 专门为打包路径设置这个变量，见 server.js 该
# 处注释）；Docker 下不设置，落回 supervisor.js 的内置默认值
# path.join(__dirname, '..', '..', 'data', 'agent-sessions')——__dirname 是
# /app/src/agent，与本 Dockerfile 的 WORKDIR /app + COPY src ./src 布局完全
# 对应，算出来正是 /app/data/agent-sessions，天然落在部署者已经持久化挂载
# 的 /app/data 卷下面，不写进容器可写层的临时空间。真机冒烟只实测验证了子
# 进程环境变量 DSH_SESSION_ROOT=/app/data/agent-sessions 这一步；transcript
# 文件本身要等第一条真实 turn 才落盘，dummy key 冒烟发不出模型请求，这条
# 验不了，docker-release.yml 的冒烟步骤也没有 agent-sessions 目录的断言
# （该步骤只断言 healthz、版本号、runtime/node_modules 存在、
# require('@deepseek-ai/dsh-base') 成功这四条，见该 workflow 文件）。
#
# ---- 镜像体积代价 ----
# 真机实测（amd64 镜像，在 jackie 原生 amd64 硬件上运行验证，2026-08-22）：
# 加这一层之前 275MB，加了之后 467MB，增加 192MB（+69.8%）——DeepSeek Agent
# SDK 全家桶 + 其原生模块的预编译产物，构成与桌面版 extraResources 复制的
# 同一棵 node_modules。
# AI 助理默认关闭（agent_enabled 设置项默认 false，src/agent/supervisor.js
# 不会自行拉起任何子进程）——不启用的部署，这些文件只占磁盘、完全不参与
# 运行、不影响启动时间或内存占用；只有显式在设置里打开 AI 助理、且案件配
# 置了对应文件夹时，这层依赖才会被真正 spawn 使用。
EXPOSE 3000
CMD ["node", "server.js"]
