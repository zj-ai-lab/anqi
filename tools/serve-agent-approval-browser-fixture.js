// Phase 1-5 浏览器人工/自动自测夹具：只服务真实 agent-drawer.js + style.css。
// 当前形态模拟 stopped → 首次发送自动 start → prompt → 刷新回显历史；它不接
// 数据库、不启动模型、不执行命令，安全策略本身由真实 supervisor 回归验证。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'public');
const port = Number(process.env.PORT || 3088);
let lastAnswer = null;
let currentTier = '1';
let workerStatus = 'stopped';
let startCount = 0;
let promptCount = 0;
const history = [];

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phase 5 自动启动与历史浏览器夹具</title><link rel="stylesheet" href="/css/style.css"></head>
<body><main class="page" style="padding:32px"><h1>Phase 5 自动启动与历史</h1><p>真实 agent-drawer.js，隔离 SSE/API 假件。</p><span id="agent-entry-slot"></span></main><div id="toast"></div>
<script type="module">import { mountAgentDrawer } from '/js/agent-drawer.js'; await mountAgentDrawer(1);</script></body></html>`;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function file(res, absolute, type) {
  try {
    const body = fs.readFileSync(absolute);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/counts') return json(res, 200, { agent: true });
  if (req.method === 'GET' && url.pathname === '/fixture-state') {
    return json(res, 200, { lastAnswer, currentTier, workerStatus, startCount, promptCount, history });
  }
  if (req.method === 'GET' && url.pathname === '/api/cases/1/agent/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('event: status\n');
    res.write(`data: ${JSON.stringify({
      status: workerStatus, caseId: 1, approvalTier: currentTier,
      pendingInteractions: [], history,
    })}\n\n`);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/interactions/phase2-browser-approval/answer') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { lastAnswer = JSON.parse(raw); } catch { lastAnswer = null; }
      json(res, 200, { ok: true });
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/cases/1/agent/approval-tier') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
      if (!['1', '2', '3'].includes(body.approvalTier)) return json(res, 400, { error: 'bad tier' });
      currentTier = body.approvalTier;
      return json(res, 200, { ok: true, approvalTier: currentTier });
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/cases/1/agent/start') {
    startCount += 1;
    workerStatus = 'ready';
    return json(res, 200, {
      status: workerStatus, caseId: 1, approvalTier: currentTier,
      pendingInteractions: [], history,
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/cases/1/agent/prompt') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
      const text = String(body.text || '').trim();
      if (!text) return json(res, 400, { error: 'empty text' });
      promptCount += 1;
      history.push(
        { role: 'user', text },
        { role: 'assistant', text: `已恢复的回答：${text}` },
      );
      return json(res, 202, { accepted: true });
    });
    return;
  }
  if (url.pathname.startsWith('/js/')) return file(res, path.join(publicRoot, url.pathname), 'text/javascript; charset=utf-8');
  if (url.pathname.startsWith('/css/')) return file(res, path.join(publicRoot, url.pathname), 'text/css; charset=utf-8');
  json(res, 404, { error: 'not found' });
});

server.listen(port, '127.0.0.1', () => console.log(`agent approval browser fixture listening on :${port}`));
