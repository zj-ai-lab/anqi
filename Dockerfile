# Debian glibc base — NOT alpine：better-sqlite3 使用 glibc 预编译产物，
# 同时避免低功耗自托管设备上的 musl / Node futex 兼容问题。
# 必须 ≥22：better-sqlite3 v12 的预编译产物从 Node 22 ABI 起覆盖。
# 公开多架构镜像由 docker-release.yml 构建并发布到 GHCR；本地也可直接构建。
FROM node:22-slim

ENV NODE_ENV=production TZ=Asia/Shanghai HOST=0.0.0.0
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public
COPY rules ./rules
COPY tools ./tools

# data/ 由部署者持久化挂载到 /app/data；案件文件根按需另行挂载并配置。
EXPOSE 3000
CMD ["node", "server.js"]
