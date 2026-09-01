import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';

function runStaticSmoke() {
  const drawer = fs.readFileSync(new URL('../public/js/agent-drawer.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
  const routes = fs.readFileSync(new URL('../src/routes/agent.js', import.meta.url), 'utf8');
  const supervisor = fs.readFileSync(new URL('../src/agent/supervisor.js', import.meta.url), 'utf8');

// 白名单不允许改既有 smoke-agent-frontend.js；本文件作为图片专项 smoke，使用
// 同一种源码不变量审查，并在 tools/check.sh 尾部独立执行。
  assert.match(drawer, /type:\s*'file'[\s\S]*?accept:\s*'image\/png,image\/jpeg,image\/webp,image\/gif'[\s\S]*?multiple/u,
    '贴图入口必须使用只接受四种图片的多选 file input');
  assert.match(drawer, /supportsImages[\s\S]*?attachBtn\.hidden\s*=\s*!state\.supportsImages/u,
    '贴图按钮必须严格由状态快照 supportsImages 控制显隐');
  assert.match(drawer, /textarea\.addEventListener\('paste'[\s\S]*?clipboardData[\s\S]*?addDraft/u,
    '输入框必须能从剪贴板接收图片');
  assert.match(drawer, /MAX_IMAGES_PER_MESSAGE\s*=\s*2/u);
  assert.match(drawer, /MAX_IMAGE_BYTES\s*=\s*8\s*\*\s*1024\s*\*\s*1024/u);
  assert.match(drawer, /application\/vnd\.anqi\.agent-attachments\+json/u,
    '大图 JSON 上传必须使用路由专用 media type，不能撞全局 1MiB parser');
  assert.match(drawer, /agent\/attachments`[\s\S]*?images:\s*encodedImages/u,
    '发送前必须先把草稿图片交给附件准入路由');
  assert.match(drawer, /agent\/prompt`[\s\S]*?attachmentIds/u,
    'prompt 只提交 attachmentIds，不得重复提交 base64');
  assert.match(drawer, /renderHistory[\s\S]*?appendUser\(item\.text[^)]*item\.attachments/u,
    '刷新历史必须把 attachment refs 交给用户气泡渲染');
  assert.match(drawer, /encodeURIComponent\(attachment\.attachmentId\)/u,
    '缩略图 src 必须指向按 attachmentId 编码的登录态回读路由');
  assert.doesNotMatch(drawer, /img\.src\s*=\s*attachment\.data/u,
    '历史缩略图不得从内联 base64/data 字段取图');

  for (const selector of [
    '.agent-image-drafts', '.agent-image-draft', '.agent-msg-attachments',
    '.agent-msg-attachment', '.agent-attach-btn',
  ]) {
    assert.ok(css.includes(selector), `图片交互样式缺少 ${selector}`);
  }

  assert.match(routes, /get\('\/cases\/:id\/agent\/attachments\/:attachmentId'/u,
    '后端必须提供登录态回读路由');
  assert.match(supervisor, /uiHistory[\s\S]*?attachments/u,
    'supervisor 的刷新历史必须保存 attachment 引用');
  assert.doesNotMatch(supervisor, /uiHistory[^\n]*base64/u,
    'uiHistory 代码不得把 base64 写入历史');

  console.log('agent image frontend smoke: vision-only entry + paste/upload + immediate/refresh thumbnails passed');
}

async function serveBrowserFixture() {
  const root = path.resolve(new URL('..', import.meta.url).pathname);
  const app = express();
  const state = { supportsImages: true, history: [], attachments: new Map(), prompts: [] };
  app.use('/js', express.static(path.join(root, 'public/js')));
  app.use('/css', express.static(path.join(root, 'public/css')));
  app.use(express.json({ limit: '1mb' }));
  app.get('/', (_req, res) => res.type('html').send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/style.css"><title>Agent image browser fixture</title></head>
<body><main style="padding:24px"><span id="agent-entry-slot"></span></main>
<script type="module">import { mountAgentDrawer } from '/js/agent-drawer.js'; await mountAgentDrawer(1);</script></body></html>`));
  app.get('/api/counts', (_req, res) => res.json({ agent: true }));
  app.get('/api/cases/1/agent/commands', (_req, res) => res.status(404).json({ error: 'fixture has no commands' }));
  const snapshot = () => ({
    status: 'ready', caseId: 1, caseName: '图片浏览器自检案', model: state.supportsImages ? 'fixture-vision' : 'fixture-text',
    supportsImages: state.supportsImages, approvalTier: '1', error: null,
    pendingInteractions: [], history: state.history,
  });
  app.get('/api/cases/1/agent/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: status\ndata: ${JSON.stringify(snapshot())}\n\n`);
    req.on('close', () => res.end());
  });
  app.post('/api/cases/1/agent/start', (_req, res) => res.json(snapshot()));
  app.post(
    '/api/cases/1/agent/attachments',
    express.json({ type: 'application/vnd.anqi.agent-attachments+json', limit: '24mb' }),
    (req, res) => {
      const attachments = (req.body?.images || []).map((image, index) => {
        const data = Buffer.from(image.data, 'base64');
        const attachmentId = `sha256:${createHash('sha256').update(data).digest('hex')}`;
        const ref = { attachmentId, mediaType: image.mediaType, width: 160, height: 90, name: image.name || `图片 ${index + 1}` };
        state.attachments.set(attachmentId, { ref, data });
        return ref;
      });
      res.status(201).json({ attachments });
    },
  );
  app.post('/api/cases/1/agent/prompt', (req, res) => {
    const attachmentIds = Array.isArray(req.body?.attachmentIds) ? req.body.attachmentIds : [];
    const attachments = attachmentIds.map((id) => state.attachments.get(id)?.ref).filter(Boolean);
    state.prompts.push({ text: String(req.body?.text || ''), attachmentIds: [...attachmentIds] });
    state.history.push({ role: 'user', text: String(req.body?.text || ''), attachments });
    res.status(202).json({ accepted: true });
  });
  app.get('/api/cases/1/agent/attachments/:attachmentId', (req, res) => {
    const stored = state.attachments.get(req.params.attachmentId);
    const referenced = state.history.some((item) => item.attachments?.some((ref) => ref.attachmentId === req.params.attachmentId));
    if (!stored || !referenced) return res.status(404).end();
    res.type(stored.ref.mediaType).send(stored.data);
  });
  app.post('/fixture/model', (req, res) => {
    state.supportsImages = req.body?.supportsImages === true;
    res.json({ supportsImages: state.supportsImages });
  });
  app.post('/fixture/reset', (_req, res) => {
    state.history = [];
    state.attachments.clear();
    state.prompts = [];
    res.json({ ok: true });
  });
  app.get('/fixture/state', (_req, res) => res.json({
    supportsImages: state.supportsImages,
    history: state.history,
    prompts: state.prompts,
    attachmentCount: state.attachments.size,
  }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  console.log(`IMAGE_FRONTEND_FIXTURE http://127.0.0.1:${server.address().port}/`);
  const close = () => server.close(() => process.exit(0));
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}

if (process.argv.includes('--fixture')) await serveBrowserFixture();
else runStaticSmoke();
