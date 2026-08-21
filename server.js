import express from 'express';
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
import settingsRouter from './src/routes/settings.js';
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
const agentSupervisor = new AgentSupervisor();
const agentRouter = createAgentRouter(agentSupervisor);

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
const httpServer = app.listen(port, host, () => {
  console.log(`anjian listening on :${port}`);
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
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`anjian received ${signal}, stopping agent workers...`);
  try {
    await agentSupervisor.stopAll(`server shutdown (${signal})`);
  } catch (error) {
    console.error('agent supervisor stopAll failed during shutdown:', error.message);
  }
  httpServer.close(() => process.exit(0));
  // httpServer.close() 等待现有连接排空；给一个兜底上限，避免一个挂住的
  // keep-alive/SSE 连接让进程永远不退出。
  setTimeout(() => process.exit(0), 5000).unref?.();
}
process.on('SIGTERM', () => { gracefulShutdown('SIGTERM').catch(() => process.exit(1)); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT').catch(() => process.exit(1)); });
