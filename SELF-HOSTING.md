# 自托管案齐

本文面向在自己控制的主机上运行案齐的部署者。案齐不是多租户 SaaS；推荐把它作为单管理员应用部署在 HTTPS 反向代理后，并只向确有需要的网络开放。

> 案齐可能保存敏感案件数据。开始前请先阅读 [SECURITY.md](SECURITY.md) 和 [LEGAL-NOTICE.md](LEGAL-NOTICE.md)。不要用真实数据测试尚未验证的部署。

## 运行方式

推荐顺序：

1. Docker 固定版本镜像；
2. macOS 桌面版；
3. Node.js 源码运行。

Docker 与 Node.js 服务端使用同一套 SQLite migration。应用启动时会自动升级数据库，因此每次升级前必须先做可恢复备份。

## Docker 部署

### 1. 准备目录

```sh
mkdir -p anqi/data
cd anqi
```

`data/` 保存 SQLite 数据库。若启用案件文件功能，再准备一个独立案件夹目录；它可以位于本地磁盘或由你自行管理的同步盘中。

### 2. 生成密码 hash

从仓库取得 `tools/hash-password.js` 后，用 Node.js 运行：

```sh
read -s -p "Password: " P
printf '\n'
ANJIAN_PASSWORD="$P" node tools/hash-password.js
unset P
```

输出格式为 `scrypt-v1$N$r$p$dkLen$salt$hash`。明文不应写入 `.env`、命令历史、数据库或日志。默认 scrypt 成本适配低内存容器；只在确认内存余量后，才用 `ANJIAN_SCRYPT_N` 提高**新 hash 的生成成本**。

### 3. 创建环境文件

创建仅部署账号可读的 `.env`：

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
DB_PATH=/app/data/anjian.db

ANJIAN_USER=replace-me
ANJIAN_PASS_HASH=scrypt-v1$...
ANJIAN_INTERNAL_KEY=replace-with-a-separate-random-secret
# 容器里看到的反向代理来源通常是 Docker 网桥地址（如 172.17.0.1）而不是回环，
# 所以这里不要写 loopback；uniquelocal 覆盖全部 RFC1918 私网段。见 §可信代理。
ANJIAN_TRUST_PROXY=uniquelocal

ANJIAN_FILES_ROOT=
DEEPSEEK_API_KEY=
ANJIAN_DISCORD_WEBHOOK=
```

生成独立内部接口 key：

```sh
openssl rand -hex 32
chmod 600 .env
```

不要复用管理员密码、密码 hash、会话 token 或 `ANJIAN_STATIC_TOKEN`。镜像显式监听 `0.0.0.0`，因此即使暂时不用 `/internal`，容器部署也必须配置高熵 `ANJIAN_INTERNAL_KEY`，否则服务拒绝启动；反向代理仍须阻止公网访问该路径。应用会把 static token 与 internal key 摘要到固定长度后恒时比较，未知用户名也会执行完整 scrypt 校验；这些措施降低时序侧信道，不会把短 key 或弱密码变安全。

### 4. 启动固定版本

把 `<version>` 替换为明确版本号：

```sh
docker pull ghcr.io/zj-ai-lab/anqi:<version>
docker run -d \
  --name anqi \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:3000:3000 \
  -v "$PWD/data:/app/data" \
  ghcr.io/zj-ai-lab/anqi:<version>
```

如果启用案件文件功能，再加只指向预期根目录的挂载：

```sh
-v "/absolute/path/to/case-files:/app/files"
```

并在 `.env` 中设置：

```dotenv
ANJIAN_FILES_ROOT=/app/files
```

不要把宿主机根目录、用户主目录或包含无关隐私文件的上级目录挂入容器。

文件边界采用 fail-closed：配置根会先解析为真实路径；其下的案件夹、中间目录和文件若是符号链接，会在列表中被忽略或在直接访问时拒绝。`cases.folder_path` 必须是单一、非隐藏的目录名称，不能含 `/`、`\\` 或控制字符，也不能是 `.`/`..`；`cases.name` 只是人读的案件标题。不要用符号链接把案件夹或子目录接到根外；确需迁移存储位置时，在案件页重新绑定工作区，或改挂载 / `ANJIAN_FILES_ROOT` 后重启并重新验收。正常上传使用独占创建，重名会写成 `(2)`，不会覆盖原件。

### 5. 验证

```sh
curl -fsS http://127.0.0.1:3000/healthz
docker logs anqi
```

确认 health check 成功、migration 无错误、登录页可访问后，再配置反向代理。不要把容器的 3000 端口直接绑定到公网地址。

## HTTPS 反向代理

以下 Nginx 片段只展示必要边界，请按你的证书、主机名和网络调整：

```nginx
server {
    listen 443 ssl http2;
    server_name anqi.example.com;

    client_max_body_size 32m;

    location /internal/ {
        return 404;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }
}
```

应用通过 Express 的 `trust proxy` 策略决定 `req.ip` 和 HTTPS cookie。`ANJIAN_TRUST_PROXY` 支持：

- `false` 或 `0`：不信任代理；
- `1`–`10`：明确代理 hop 数；
- 逗号分隔的命名范围或 CIDR，例如 `loopback,10.0.0.0/8`。

不配置时的默认值是 `loopback,linklocal,uniquelocal`——已覆盖回环与全部 RFC1918 私网段，对「反向代理与应用同机或同私网」的常见部署可直接使用。生产建议显式写出实际链路而不是依赖默认。

**容器化部署的坑**：应用跑在 Docker 里时，反向代理打进来的源地址是 Docker 网桥（如 `172.17.0.1`），**不是回环**。此时写 `loopback` 会让 Express 不信任代理，`req.ip` 对所有访客都坍缩成网桥地址——登录限速会把所有人当成同一来源互相误锁，Cookie 也不会带 `Secure`。裸 Node 与反向代理同机直连时才用 `loopback`；容器化用 `uniquelocal` 或具体网桥 CIDR（如 `172.17.0.0/16`）。

不要设置为笼统的 `true`，也不要信任攻击者可以直接连接的地址段；多层代理应根据真实链路从应用一侧逐跳核对。

如果合法的内部集成确实需要 `/internal`，只在私网或单独受控入口转发，并始终要求 `X-Anjian-Key`。不要因为已有应用登录页就把内部接口暴露到公网。

## Node.js 源码运行

要求：

- Node.js 22 LTS 推荐，最低版本见 `package.json`；
- 能安装 better-sqlite3 的系统环境（v13 起随包自带 glibc / musl 预编译产物；用 `npm ci` 不会触发编译。Node 22 自带的 npm 10 若用 `npm install`，会尝试 node-gyp 编译，需 python3 / make / g++ 或加 `--ignore-scripts`）；
- 持久、受限权限的本地目录。

```sh
git clone https://github.com/zj-ai-lab/anqi.git
cd anqi
npm ci
cp .env.example .env
```

配置 `.env` 后运行：

```sh
npm run check
npm run dev
```

本机单用户调试应显式绑定回环地址：

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
```

不要依赖“没配账号就是开发模式”之类的隐式行为。管理员账号和密码 hash 应完整配置；仅供空测试库使用的无鉴权模式，必须同时满足非 production、明确回环 IP，并显式设置 `ANJIAN_UNSAFE_NO_AUTH=1`。production、非回环监听或其他开关值都会拒绝启动。

## Android 连接自托管实例

Android 壳不预置任何服务器。首次启动时输入你自己部署的案齐根地址，例如 `https://anqi.example.com`；之后可点壳顶部的“服务器”修改。地址只能是根 origin：允许可选端口，但不能包含账号密码、query、fragment 或 `/anqi` 一类子路径。

- 公网主机名或公网 IP 必须使用 `https://`；
- `localhost`、IPv4 loopback、RFC1918 私网段（`10/8`、`172.16/12`、`192.168/16`）和 `.local` 主机可使用 `http://`；
- HTTP 是明文传输，仅限你确认可信的局域网。不要把这一例外用于公网、访客 Wi-Fi 或其他不受控网络。

壳会严格比较 URL 的 scheme、host 与实际端口，外部 Intent 只有与已配置服务器同源才会在壳内打开；形似同一域名的前缀地址不会被接受。切换到另一服务器会清除壳内 Cookie、Web Storage、缓存和网页历史，因此需要重新登录。服务端的非回环部署要求不变：即使 Android 在可信局域网内允许 HTTP，面向公网的实例仍必须置于 HTTPS 反向代理后。

## 配置参考

| 变量 | 说明 |
|---|---|
| `HOST` / `PORT` | 监听地址和端口；本机调试使用 `127.0.0.1` |
| `DB_PATH` | SQLite 文件路径，默认位于仓库 `data/` |
| `ANJIAN_USER` | 单一管理员账号 |
| `ANJIAN_PASS_HASH` | 由 `tools/hash-password.js` 生成的版本化 hash |
| `ANJIAN_SCRYPT_N` | 仅影响新 hash 生成；须为允许范围内的 2 的幂 |
| `ANJIAN_INTERNAL_KEY` | `/internal` 独立认证 key |
| `ANJIAN_TRUST_PROXY` | Express 可信代理范围或 hop 数 |
| `ANJIAN_STATIC_TOKEN` | CLI/agent 兼容 token；非必要不要启用 |
| `ANJIAN_DEFAULT_ACTOR` | 默认审计 actor，未配置时为 `web` |
| `ANJIAN_FILES_ROOT` | 案件夹根；不配置时文件模块不可用 |
| `ANJIAN_SECRET` | AI 助理设置页里填的 API key 用它派生静态加密主密钥（须至少 32 字节、不能是单一/少量重复字符）；不配置时自动改用数据目录下的 `secret.key` 文件——两种方式二选一，见下方「AI 助理（可选）」 |
| `DEEPSEEK_API_KEY` | 可选快录与提取模型 key |
| `DEEPSEEK_BASE_URL` | 可选 OpenAI 兼容服务地址 |
| `DEEPSEEK_MODEL` | 可选模型名 |
| `ANJIAN_DISCORD_WEBHOOK` | 可选 L0 日报 webhook |

`.env.example` 是当前版本的完整起点。密钥一律放在部署环境或权限受控的 secret 文件中，不要提交到仓库。

## 数据、案件夹与备份

案齐的持久数据至少包括：

- `DB_PATH` 指向的 SQLite 数据库；
- 若启用了 AI 助理的「界面填 key」（未设置 `ANJIAN_SECRET` 时）：`DB_PATH` 同目录下自动生成的 `secret.key`——它是解密 settings 表里加密存储的 API key 的唯一凭据，丢了它，库里那份密文永久解不开（不会报错、不会提示，`GET /api/settings` 只会显示「未配置」）；
- `ANJIAN_FILES_ROOT` 指向的案件夹；
- 若使用 AI 助理图片输入：DSH 实际 home 下的 `attachments/v1/` 内容寻址库（通常为运行账户的 `~/.dsh/attachments/v1/`）；图片字节不在案件夹、`anjian.db` 或会话 transcript 中，迁移或备份时必须单独包含该目录；
- 部署环境文件和必要的集成配置（含 `ANJIAN_SECRET`，若使用）；
- macOS 桌面版所选的数据目录与应用配置。

最简单的一致性备份方式是短暂停止应用，再复制整个数据目录（`secret.key` 与 `anjian.db` 同目录，随这一步自动一起备份，不需要单独处理）：

```sh
docker stop anqi
cp -a data "data.backup-$(date +%Y%m%d-%H%M%S)"
docker start anqi
```

若改用 `tools/backup.cjs` 做在线增量备份（SQLite backup API，无需停机）：脚本会把 `secret.key` 与当天的数据库备份一并同步到 `/app/data/backup/secret.key.bak`，不需要额外配置；但若这次部署改用 `ANJIAN_SECRET` 环境变量而不是 `secret.key` 文件，该脚本无法替你备份一个环境变量，必须自行把它存进独立的 secret 管理系统（见下方「AI 助理（可选）」）。**警示**：`backup` 目录因此同时含有 `secret.key`（主密钥）与加密后的数据库副本——拿到这两者就能解出 settings 表里存储的 AI 助理 API key 明文，该目录必须与主密钥本身同等级别保护（访问控制、传输加密、不落入未受控存储），切勿把这份备份目录与其它数据库备份一起明文外发或上传到通用网盘/协作工具。

案件夹很大时，应使用支持版本历史、完整性校验和静态加密的备份方案。仅“同步”不等于备份：误删、加密勒索和损坏也可能被同步。

至少定期执行一次隔离恢复演练，确认数据库能启动、附件可读、关键期限和费用记录存在。备份介质与云端副本应遵守你所在法域及职业保密要求。

## 升级与回退

1. 阅读目标版本的 Release Notes；
2. 停止写入并备份数据库、案件夹和配置；
3. 拉取固定版本镜像或 tag；
4. 先用备份副本验证 migration 与登录；
5. 再切换正式实例并检查 `/healthz`、登录、案件列表和关键记录。

数据库 migration 通常是向前的。回退旧镜像时，不要假设新 schema 一定向后兼容；可靠回退应同时恢复升级前数据库备份。

## 可选 LLM 的隐私边界

不配置 `DEEPSEEK_API_KEY` 时，手动案件管理、期限引擎和提醒仍应工作，LLM 按钮会隐藏或返回不可用。

启用后，部署者必须自行审查供应商条款。不要把整库、案件名单或无关个人信息发送给模型。模型只允许提取和建议：

- 快录结果只回填表单，由人点击保存；
- 后台提取结果先进入收件箱，由人裁决；
- 期限始终由确定性引擎计算；
- 模型没有正式表的写入口。

## AI 助理（可选）

案齐还包含一个可选的 AI 助理（进程外 sidecar，基于 [DSH · DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 运行时），能在案件范围内多轮对话、读取案卷并给出建议；它与上面「可选 LLM」的快录/提取按钮是两套独立功能。每个案件的 `folder_path` 对应目录就是该案 Agent 项目：在案件页打开助理会自动把该目录设为 `cwd`，无需再选路径。标准 read/read_image/write/edit/glob/grep 都会解析真实路径并拒绝越出本案目录；指向外部的符号链接同样拒绝。

**默认关闭**。不启用时，AI 助理相关的依赖只以文件形式存在于镜像/安装目录中，不会被加载、不占用内存，也不会发起任何网络请求；对绝大多数只用手动案件管理的部署没有任何影响。

开启方式：在设置页把「AI 助理」开关打开，选择能力档位，并按需填写 provider / baseURL / model。默认「案件项目」档只开放本案文件、skill/todo/ask-user 与案齐领域工具；「完整 DSH」档另行开放 shell、后台 jobs、goal、subagent、workflow、Ralph 和 web search。完整档的 shell 进程可能读取当前 OS 用户可读的案件夹外路径，联网查询会把内容发给相应服务，启用前应按执业保密要求判断。API key 的值有两种来源，取值时环境变量优先：

- **环境变量（`apiKeyEnv`，兼容既有部署）**：设置页里只填一个环境变量**名**，真正的 key 值必须由部署者在部署环境里单独设置，不写进设置页、不进数据库。默认 provider 是 `deepseek-official` 时，常见做法是把 `apiKeyEnv` 填成 `DEEPSEEK_API_KEY`，并在部署环境里配置该变量的真实 key。
- **界面直接填（推荐，设置页「用户中心 · AI 助理」直接填写）**：选好供应商后 baseURL 会自动带出，填一次 key 就能点「拉取可用模型」从下拉框选模型，不需要碰任何环境变量。key 落库前用 AES-256-GCM 静态加密，解密用的主密钥由 `ANJIAN_SECRET` 环境变量派生（若配置），否则自动在数据目录下生成 `secret.key` 文件（首次生成、权限 0600）。**这把主密钥本身就是敏感数据**：`secret.key` 丢失或损坏，或 `ANJIAN_SECRET` 变更，都会让库里已加密存储的 key 永久解不开（不报错，只是「未配置」）——见上方「数据、案件夹与备份」；换主机/换容器卷时，`secret.key` 必须和 `anjian.db` 一起搬过去，`ANJIAN_SECRET` 则必须和其它部署环境变量一起搬过去。

其余必需的环境变量：

- `ANJIAN_INTERNAL_KEY`——AI 助理通过内置的 `case_folder_info` 工具回调案齐自身 `/internal` API 时用于认证，不配置则助理无法启动。

数据去向：AI 助理的会话记录（transcript）落在与 `DB_PATH` 同一持久化范围内——Docker 部署下默认写入 `data/agent-sessions/`（与 `data/` 卷同一挂载点，跟随你的备份策略一起保存）；macOS 桌面版写入应用数据目录下的等价位置。图片输入的字节另存于 DSH home 的 `attachments/v1/`，transcript、SSE 与 UI 历史只保留 attachment 引用；备份/迁移时须把该目录与 session 数据一起带走。启动助理要求案件绑定的 `folder_path` 在 `ANJIAN_FILES_ROOT` 下真实存在；案件标题可以与目录名不同，改标题不会切换目录。

第三方 DSH 插件：只在「完整 DSH」档的高级选项填写一个你已审查的绝对路径 `cordis.patch.yml`。该 patch 使用上游 Cordis 格式，文件变化会对现有 worker 热重载；插件本身是与当前本机用户等权执行的 Node 代码，不是数据文件，切勿加载来源不明的插件。依赖 DSH Web Client 专用 UI 插槽的插件不会自动出现在案齐抽屉里。项目维护者升级上游 runtime 时使用 `npm run agent:update-runtime -- <exact-version>`；它会跑真实启动/隔离/parity 门禁，App 用户仍通过经过验收的案齐版本获得 runtime 更新。

镜像体积代价：Docker 镜像因此增大约 192MB（275MB → 467MB，x86_64 实测，DeepSeek Agent SDK 及其原生模块的预编译产物），无论是否启用都会打进同一份镜像——这是为了让「先部署、后按需开启」不需要重新拉镜像；如果确定完全不需要这项功能，可以自行裁剪 Dockerfile 中对应的一层。

已知边界：发行 workflow 的冒烟测试只对 `linux/amd64` 镜像跑上述启动/回归断言，`linux/arm64` 那条腿（用户在树莓派等 arm64 设备上拉到的镜像）目前没有等价门禁覆盖——lock 文件里 AI 助理依赖树的 `linux-arm64` 预编译产物齐全，理论上能装、能跑，但未经真机验证；arm64 平台部署 AI 助理前建议自行按上面这套步骤跑一次冒烟。

## macOS 桌面版

桌面版把同一服务端绑定到本机随机回环端口，并将配置写入应用 userData 目录。首次启动时选择数据目录并设置密码。升级或迁移设备前，先备份所选数据目录和案件夹。

只从 [GitHub Releases](https://github.com/zj-ai-lab/anqi/releases) 获取发行物并核对说明。若版本尚未签名或公证，macOS 可能显示 Gatekeeper 警告；不要为来源不明的 DMG 关闭系统安全功能。
