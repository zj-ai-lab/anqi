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

app.use('/api', authRouter); // /api/login /api/logout（自带限速，不过会话门）
app.use('/api', apiAuth, casesRouter, recordsRouter, viewsRouter, feesRouter, sharesRouter, filesRouter, contactsRouter, legalragRouter, settingsRouter);
app.use('/internal', internalAuth, internalRouter);
app.use(pageAuth, express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
app.use(errorHandler);

const port = process.env.PORT || 3000;
const host = startupConfig.host;
if (startupConfig.unsafeNoAuth) {
  console.warn('⚠ ANJIAN_UNSAFE_NO_AUTH=1：当前实例无鉴权，仅允许本机回环开发/测试，严禁承载真实数据');
}
app.listen(port, host, () => {
  console.log(`anjian listening on :${port}`);
  if (startLegalRagBridge()) console.log('anjian LegalRAG bridge started');
});
