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

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public
COPY rules ./rules
COPY tools ./tools

# data/ 由部署者持久化挂载到 /app/data；案件文件根按需另行挂载并配置。
EXPOSE 3000
CMD ["node", "server.js"]
