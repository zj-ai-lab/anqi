import express from 'express';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './src/db.js';
import { apiAuth, pageAuth, internalAuth } from './src/middleware/auth.js';
import { errorHandler } from './src/middleware/errors.js';
import authRouter from './src/routes/auth.js';
import casesRouter from './src/routes/cases.js';
import recordsRouter from './src/routes/records.js';
import viewsRouter from './src/routes/views.js';
import feesRouter from './src/routes/fees.js';
import sharesRouter from './src/routes/shares.js';
import filesRouter from './src/routes/files.js';
import contactsRouter from './src/routes/contacts.js';
import legalragRouter from './src/routes/legalrag.js';
import { createSettingsRouter } from './src/routes/settings.js';
import internalRouter from './src/routes/internal.js';
import { createAgentRouter } from './src/routes/agent.js';
import { AgentSupervisor } from './src/agent/supervisor.js';
import { startLegalRagBridge } from './src/lib/legalrag-bridge.js';
import { backfillCandidateFacts } from './src/lib/candidate-facts.js';
import { backfillRecommendationMemory } from './src/lib/recommendations.js';
import { resolveTrustProxy } from './src/lib/trust-proxy.js';
import { resolveStartupConfig } from './src/lib/startup-config.js';

const startupConfig = resolveStartupConfig(process.env);

// migration 011 的语义 backfill 必须与运行时使用同一套规范化/状态指纹代码；
// 两函数均幂等，并在任何 bridge tick 或 HTTP 请求之前完成。
backfillCandidateFacts();
backfillRecommendationMemory();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', resolveTrustProxy(process.env.ANJIAN_TRUST_PROXY));
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// DSH sidecar 的进程外 worker 管理器：全进程只 new 一个实例，server.js 与
// agentRouter 共用它——路由层负责把 HTTP/SSE 请求转成 supervisor 调用，
// supervisor 自己管理 spawn/生命周期/turn 串行化（见 src/agent/supervisor.js
// 顶部注释）。同一个实例还要在下面的优雅退出钩子里被 stopAll()。
//
// sessionRoot 显式读一个环境变量而不是吃 supervisor.js 的内置默认值——那个
// 默认值是 __dirname 相对路径（repo-root/data/agent-sessions），只在"裸
// node server.js 跑在仓库里"这一种形态下才落在合理位置。Electron 打包后
// __dirname 解析到 Contents/Resources/app/src/agent，默认值会把 session
// transcript 写进已签名的 app 资源树本体——不但违反"用户数据只进
// dataDir"，反复写入还会撕掉 codesign --deep 的资源封条（同一类问题也发生
// 在 DB_PATH：那里已经是 env 注入模式，这里补齐同一模式）。electron/main.js
// 的 startBackend() 会把 ANJIAN_AGENT_SESSION_ROOT 设成
// path.join(config.dataDir, 'agent-sessions')；未设置时（裸 server.js、
// Docker、tools/check.sh 等）显式传 undefined 让 AgentSupervisor 的构造期
// 默认参数接管，行为与此前完全一致。
const agentSupervisor = new AgentSupervisor({
  sessionRoot: process.env.ANJIAN_AGENT_SESSION_ROOT || undefined,
});
const agentRouter = createAgentRouter(agentSupervisor);
// settingsRouter 同样是工厂函数、同样注入这一个 agentSupervisor 实例——
// 设置页把 agent_enabled 关掉（或把 provider/model/apiKeyEnv 改成失效组合）
// 时，PUT /api/settings 需要能直接调用 agentSupervisor.stopAll() 终止所有
// live worker（见 src/routes/settings.js 顶部注释「设置侧联动」）。不让
// settings.js 自己 import supervisor.js 去 new 一个或引用某个模块级单例，
// 避免出现"两份 supervisor 各管一半 worker"或反向循环依赖——server.js 是
// 唯一同时持有 agentSupervisor 构造权和两个路由挂载权的地方，接线方式与
// agentRouter 完全一致。
const settingsRouter = createSettingsRouter(agentSupervisor);

app.use('/api', authRouter); // /api/login /api/logout（自带限速，不过会话门）
app.use(
  '/api', apiAuth,
  casesRouter, recordsRouter, viewsRouter, feesRouter, sharesRouter,
  filesRouter, contactsRouter, legalragRouter, settingsRouter, agentRouter
);
app.use('/internal', internalAuth, internalRouter);
app.use(pageAuth, express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
app.use(errorHandler);

const port = process.env.PORT || 3000;
const host = startupConfig.host;
if (startupConfig.unsafeNoAuth) {
  console.warn('⚠ ANJIAN_UNSAFE_NO_AUTH=1：当前实例无鉴权，仅允许本机回环开发/测试，严禁承载真实数据');
}
// DSH 子进程回调用的 host：startupConfig.host 是这个进程实际监听的地址，但
// 通配地址（0.0.0.0 / ::，"监听所有本机接口"）本身不是一个可连接的目标——
// 子进程必须改连回环地址，回环在通配监听下必然也在接受连接。host 是具体地址
// （无论回环还是某个 LAN/公网 IP）时，直接用它：如果监听地址是一个具体的非
// 回环地址，操作系统不保证同时也在监听 127.0.0.1，硬编码回环在这种部署形态
// 下会让子进程的每一次内部调用都 ECONNREFUSED（此前的实现无条件写死
// 127.0.0.1，只是恰好大多数部署都用通配或回环监听才没暴露）。IPv6 字面量需要
// 方括号包裹才是合法的 URL host。
function internalCallbackHost(bindHost) {
  const value = String(bindHost || '').trim();
  if (!value || value === '0.0.0.0' || value === '::' || value === '::0') return '127.0.0.1';
  return net.isIP(value) === 6 ? `[${value}]` : value;
}

const httpServer = app.listen(port, host, () => {
  // 构造 AgentSupervisor 时它对 internalBaseURL 的默认值只能是一个兜底猜测
  // （字面量硬编码 127.0.0.1:3007），与这里真正监听的端口（PORT 环境变量、或
  // Electron 传入的随机空闲端口）、以及真正监听的 host（见 internalCallbackHost()
  // 注释）大概率不一致——DSH 子进程的每一次 anqi MCP 工具调用都以这个 base URL
  // 为准，猜错端口/host 等于子进程的每一次内部调用都 ECONNREFUSED。这里用
  // httpServer.address().port 拿到刚绑定成功的真实端口、用 startupConfig.host
  // 换算出真正可回连的 host 去纠正它；此刻服务器才刚开始 accept 连接，不存在
  // "纠正前已经有请求进来"的竞态。
  const actualPort = httpServer.address().port;
  agentSupervisor.setInternalBaseURL(`http://${internalCallbackHost(startupConfig.host)}:${actualPort}`);
  console.log(`anjian listening on :${actualPort}`);
  if (startLegalRagBridge()) console.log('anjian LegalRAG bridge started');
});

// 优雅退出：设计稿 §3.2「server shutdown」是取消当前 turn、终止 worker 的
// 触发源之一。SIGTERM 覆盖两条真实路径——裸 `node server.js` 被 systemd/
// Docker/tools/check.sh 的 `kill $SRV` 终止，以及 Electron 侧
// electron/main.js 的 `before-quit` 用 `backendProc.kill()`（默认信号也是
// SIGTERM）杀掉 fork 出来的这个后端子进程；SIGINT 覆盖开发时 Ctrl-C。
// stopAll() 对每个存活 worker 都走一次 graceful shutdown RPC + 强杀兜底
// （见 supervisor.js 的 stop()），避免子进程成为脱离 supervisor 掌控的孤儿；
// 没有任何 worker 时 stopAll() 近乎立即 resolve，不拖慢正常退出。
// 只装一次：signal handler 本身不是幂等的（重复 exit 竞态），用 once 保证
// 第二个信号如果在关闭窗口内又打进来，也不会重入整套关闭逻辑。
// stopAll() 内部单个 worker 最坏情况是 30s shutdown RPC 往返 + 10s 强杀等待
// ≈ 40s；这段时间里 httpServer.close() 完全没被调用、端口一直占着——之前的
// 实现是 5 秒兜底在 stopAll 落定之后才起算，等于兜底形同虚设（Docker 默认
// 10s SIGTERM 宽限期会在中途被 SIGKILL，Electron before-quit 后主进程已退
// 出、后端还可能再跑 40 秒）。这里给 stopAll 套一个总时限的 Promise.race：
// 跑满时不再等，直接 forceKillAll() 兜底强杀所有仍存活的子进程，再继续走
// httpServer.close()，让"兜底"真正在总时间预算内起作用。
const STOP_ALL_TIMEOUT_MS = 8000;
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`anjian received ${signal}, stopping agent workers...`);
  let timedOut = false;
  let timer;
  const timeoutGuard = new Promise((resolve) => {
    timer = setTimeout(() => { timedOut = true; resolve(); }, STOP_ALL_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([
      agentSupervisor.stopAll(`server shutdown (${signal})`).then(() => clearTimeout(timer)),
      timeoutGuard,
    ]);
  } catch (error) {
    console.error('agent supervisor stopAll failed during shutdown:', error.message);
  }
  if (timedOut) {
    console.warn(`agent supervisor stopAll exceeded ${STOP_ALL_TIMEOUT_MS}ms, force-killing remaining workers`);
    agentSupervisor.forceKillAll();
  }
  httpServer.close(() => process.exit(0));
  // httpServer.close() 等待现有连接排空；给一个兜底上限，避免一个挂住的
  // keep-alive/SSE 连接让进程永远不退出。
  setTimeout(() => process.exit(0), 5000).unref?.();
}
process.on('SIGTERM', () => { gracefulShutdown('SIGTERM').catch(() => process.exit(1)); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT').catch(() => process.exit(1)); });
