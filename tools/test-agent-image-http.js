import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import express from 'express';
import { Context } from '../src/agent/runtime/node_modules/@deepseek-ai/cordis/lib/index.js';
import { LocalAttachmentStore } from '../src/agent/runtime/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-image-http-'));
process.env.DB_PATH = path.join(scratch, 'image-http.db');
process.env.IMAGE_HTTP_PROVIDER_KEY = 'not-a-real-provider-key';
process.env.ANJIAN_INTERNAL_KEY = 'not-a-real-internal-key';

const { db } = await import('../src/db.js');
const { AGENT_SETTINGS_KEYS } = await import('../src/agent/config.js');
const { createAgentRouter } = await import('../src/routes/agent.js');
const { AgentSupervisor, AGENT_RUNTIME_PATHS } = await import('../src/agent/supervisor.js');
const { AnqiJsonRpcServer } = await import('../src/agent/assets/plugins/dsh-anqi-jsonrpc/index.js');

const IMAGE_JSON_TYPE = 'application/vnd.anqi.agent-attachments+json';
const FIXTURE_IMAGE_DATA = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAYAAAA/xl1SAAAAvklEQVR42u3SMQ0AAAjAMIyhELM4AAe8PD1qYFlk9cCXEAEDYkAwIAYEA2JAMCAGBANiQDAgBgQDYkAwIAYEA2JAMCAGBANiQDAgBgQDYkAwIAYEA2JAMCAGxIBCYEAMCAbEgGBADAgGxIBgQAwIBsSAYEAMCAbEgGBADAgGxIBgQAwIBsSAYEAMCAbEgGBADAgGxIAYEAyIAcGAGBAMiAHBgBgQDIgBwYAYEAyIAcGAGBAMiAHBgBgQDIgB4bYWLb6pnOb1xAAAAABJRU5ErkJggg==';
const FIXTURE_GIF_DATA = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const VALID_PREFLIGHT_RESULT = {
  ready: true,
  tools: {
    required: AGENT_RUNTIME_PATHS.requiredMcpTool,
    ready: true,
    visibleNames: [AGENT_RUNTIME_PATHS.requiredMcpTool],
  },
  skills: {
    complete: true,
    names: [AGENT_RUNTIME_PATHS.requiredSkillName],
    required: [AGENT_RUNTIME_PATHS.requiredSkillName],
    ready: true,
  },
};

function upsertSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

function setModel(model) {
  upsertSetting(AGENT_SETTINGS_KEYS.model, model);
}

function image(mediaType = 'image/png', data = FIXTURE_IMAGE_DATA, name = '截图.png') {
  return { mediaType, data, name };
}

class FakeChild extends EventEmitter {
  constructor(onFrame) {
    super();
    this.pid = 454545;
    this.exitCode = null;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) onFrame(JSON.parse(line), this);
      }
    });
  }

  sendLine(frame) {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  emitExit(code = 0, signal = null) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code, signal);
  }

  kill(signal) {
    setImmediate(() => this.emitExit(0, signal));
    return true;
  }
}

function finishTurn(child, sessionId) {
  child.sendLine({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'running' } });
  child.sendLine({
    jsonrpc: '2.0', method: 'session.event',
    params: {
      sessionId,
      event: {
        type: 'request/header',
        data: { reason: 'initial', header: { tools: [{ name: AGENT_RUNTIME_PATHS.requiredMcpTool }] } },
      },
    },
  });
  child.sendLine({
    jsonrpc: '2.0', method: 'session.event',
    params: {
      sessionId,
      event: { type: 'tool/call', data: { name: AGENT_RUNTIME_PATHS.requiredMcpTool } },
    },
  });
  child.sendLine({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } });
  child.sendLine({
    jsonrpc: '2.0', method: 'session.event',
    params: { sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  });
}

async function waitUntil(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('等待 JSON-RPC wire 证据超时');
}

const filesRoot = path.join(scratch, 'files');
const caseName = '图片输入 HTTP 自检案';
const caseRoot = path.join(filesRoot, caseName);
fs.mkdirSync(caseRoot, { recursive: true });
const caseId = Number(db.prepare(
  `INSERT INTO cases (name, procedure, stage, status, folder_path)
   VALUES (?, '一审', '图片自检', 'active', ?)`
).run(caseName, caseName).lastInsertRowid);

upsertSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
upsertSetting(AGENT_SETTINGS_KEYS.capabilityMode, 'project');
upsertSetting(AGENT_SETTINGS_KEYS.approvalTier, '1');
upsertSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
upsertSetting(AGENT_SETTINGS_KEYS.baseURL, 'https://api.deepseek.com');
upsertSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'IMAGE_HTTP_PROVIDER_KEY');
upsertSetting(AGENT_SETTINGS_KEYS.pluginPatch, '');
setModel('deepseek-vision-pro');

const attachmentContext = new Context();
const attachmentStore = new LocalAttachmentStore(attachmentContext, {
  dshHome: path.join(scratch, 'dsh-home'),
});
const wirePrompts = [];
const admittedBatches = [];
const readRequests = [];
let currentChild;

const supervisor = new AgentSupervisor({
  filesRoot,
  sessionRoot: path.join(scratch, 'sessions'),
  turnTimeoutMs: 5_000,
  preflightTimeoutMs: 5_000,
  spawnFn: () => {
    currentChild = new FakeChild((frame, child) => {
      if (frame.method === 'initialize') {
        child.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
      } else if (frame.method === 'session/create') {
        child.sendLine({ jsonrpc: '2.0', id: frame.id, result: { sessionId: frame.params.sessionId } });
      } else if (frame.method === 'session/preflight') {
        child.sendLine({ jsonrpc: '2.0', id: frame.id, result: VALID_PREFLIGHT_RESULT });
      } else if (frame.method === 'attachment/admit') {
        const receiver = {
          ctx: { attachments: attachmentStore },
          assertLiveSession(sessionId) {
            assert.equal(sessionId, frame.params.sessionId);
            return { agent: {} };
          },
        };
        void AnqiJsonRpcServer.prototype.admitAttachments.call(receiver, frame.params).then((result) => {
          admittedBatches.push(result.attachments);
          child.sendLine({ jsonrpc: '2.0', id: frame.id, result });
        }, (error) => {
          child.sendLine({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: error.message } });
        });
      } else if (frame.method === 'session/prompt') {
        wirePrompts.push(frame);
        child.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
        setImmediate(() => finishTurn(child, frame.params.sessionId));
      } else if (frame.method === 'attachment/read') {
        readRequests.push(frame.params);
        const receiver = {
          ctx: { attachments: attachmentStore },
          assertLiveSession(sessionId) {
            assert.equal(sessionId, frame.params.sessionId);
            return { agent: {} };
          },
        };
        void AnqiJsonRpcServer.prototype.readAttachment.call(receiver, frame.params).then((read) => {
          child.sendLine({ jsonrpc: '2.0', id: frame.id, result: read });
        }, (error) => {
          child.sendLine({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: error.message } });
        });
      } else if (frame.method === 'shutdown') {
        child.sendLine({ jsonrpc: '2.0', id: frame.id, result: {} });
        setImmediate(() => child.emitExit());
      }
    });
    return currentChild;
  },
});

let server;
try {
  const started = await supervisor.start(caseId);
  assert.equal(started.status, 'ready', `假 wire worker 应启动为 ready，实际 ${started.status}:${started.error || ''}`);
  assert.equal(supervisor.publicStatus(caseId).supportsImages, true);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => { req.actor = 'image-http-test'; next(); });
  app.use('/api', createAgentRouter(supervisor));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, url, body, contentType = 'application/json') {
    const response = await fetch(base + url, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': contentType },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    return { status: response.status, data, headers: response.headers };
  }

  let result = await request('POST', `/api/cases/${caseId}/agent/attachments`, {
    images: [image(), image('image/png', FIXTURE_IMAGE_DATA, '第二张.png'), image()],
  }, IMAGE_JSON_TYPE);
  assert.equal(result.status, 400);
  assert.match(result.data.error, /最多.*2 张/);

  result = await request('POST', `/api/cases/${caseId}/agent/attachments`, {
    images: [image('image/svg+xml')],
  }, IMAGE_JSON_TYPE);
  assert.equal(result.status, 400);
  assert.match(result.data.error, /PNG.*JPEG.*WebP.*GIF/i);

  const oversized = Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64');
  result = await request('POST', `/api/cases/${caseId}/agent/attachments`, {
    images: [image('image/png', oversized, '过大.png')],
  }, IMAGE_JSON_TYPE);
  assert.equal(result.status, 400);
  assert.match(result.data.error, /8\s*MiB/i);
  assert.equal(admittedBatches.length, 0, '限额/错型必须在调用 DSH admission 之前拒绝');

  result = await request('POST', `/api/cases/${caseId}/agent/attachments`, {
    images: [image()],
  }, IMAGE_JSON_TYPE);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.attachments.length, 1);
  const uploaded = result.data.attachments[0];
  assert.match(uploaded.attachmentId, /^sha256:/);
  assert.equal(uploaded.mediaType, 'image/png');
  assert.equal(admittedBatches.length, 1);
  assert.equal(fs.existsSync(attachmentStore.root), true, '图片字节必须进入 DSH attachment 根');
  assert.deepEqual(fs.readdirSync(caseRoot), [], '图片上传不得在案件夹生成文件');

  result = await request('POST', `/api/cases/${caseId}/agent/prompt`, {
    text: '引用不存在的图片', attachmentIds: ['sha256:not-admitted'],
  });
  assert.equal(result.status, 400);
  assert.match(result.data.error, /重新粘贴|不存在|失效/);

  setModel('deepseek-v4-flash');
  result = await request('POST', `/api/cases/${caseId}/agent/prompt`, {
    text: '这个模型不该收图', attachmentIds: [uploaded.attachmentId],
  });
  assert.equal(result.status, 400);
  assert.match(result.data.error, /当前模型.*不支持图片|切换.*vision/i);
  setModel('deepseek-vision-pro');

  result = await request('POST', `/api/cases/${caseId}/agent/prompt`, {
    text: '请看这张截图回答', attachmentIds: [uploaded.attachmentId],
  });
  assert.equal(result.status, 202, JSON.stringify(result.data));
  await waitUntil(() => wirePrompts.length === 1 && supervisor.status(caseId).status === 'ready');
  const blocks = wirePrompts[0].params.contentBlocks;
  assert.deepEqual(blocks[0], { type: 'text', text: '请看这张截图回答' });
  assert.deepEqual(blocks[1], { type: 'image', attachment: admittedBatches[0][0] });
  assert.equal(JSON.stringify(wirePrompts[0]).includes(FIXTURE_IMAGE_DATA), false, 'prompt wire 只能带 ref，不能重复带 base64');

  const history = supervisor.publicStatus(caseId).history;
  const userHistory = history.find((item) => item.role === 'user' && item.text === '请看这张截图回答');
  assert.equal(userHistory.attachments.length, 1, '刷新历史必须保留这一张图片引用');
  assert.equal(userHistory.attachments[0].attachmentId, uploaded.attachmentId);
  assert.equal('data' in userHistory.attachments[0], false, 'uiHistory 不得保存 base64/二进制');
  assert.equal('bytes' in userHistory.attachments[0], false, 'uiHistory 只保存回显引用，不复制字节长度字段');

  // 再准入一张不同内容的 GIF，但不把它交给 prompt。知道 id 仍然不够：回读路
  // 由必须确认当前案件 session 的 uiHistory 确实引用过它。
  result = await request('POST', `/api/cases/${caseId}/agent/attachments`, {
    images: [image('image/gif', FIXTURE_GIF_DATA, '尚未引用.gif')],
  }, IMAGE_JSON_TYPE);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const unreferenced = result.data.attachments[0];
  assert.notEqual(unreferenced.attachmentId, uploaded.attachmentId);

  let readResponse = await fetch(`${base}/api/cases/${caseId}/agent/attachments/${encodeURIComponent(unreferenced.attachmentId)}`);
  assert.equal(readResponse.status, 404, '已准入但未被本会话消息引用的 attachment 必须 404');
  readResponse = await fetch(`${base}/api/cases/${caseId}/agent/attachments/${encodeURIComponent('sha256:' + 'f'.repeat(64))}`);
  assert.equal(readResponse.status, 404, '未知 attachment 必须 404');

  const otherCaseName = '图片回读越权自检案';
  fs.mkdirSync(path.join(filesRoot, otherCaseName));
  const otherCaseId = Number(db.prepare(
    `INSERT INTO cases (name, procedure, stage, status, folder_path)
     VALUES (?, '一审', '图片越权', 'active', ?)`
  ).run(otherCaseName, otherCaseName).lastInsertRowid);
  readResponse = await fetch(`${base}/api/cases/${otherCaseId}/agent/attachments/${encodeURIComponent(uploaded.attachmentId)}`);
  assert.equal(readResponse.status, 404, '另一个案件即使知道 attachmentId 也必须 404');
  assert.equal(readRequests.length, 0, '三类 404 必须在调用 DSH readImage 前完成引用校验');

  readResponse = await fetch(`${base}/api/cases/${caseId}/agent/attachments/${encodeURIComponent(uploaded.attachmentId)}`);
  assert.equal(readResponse.status, 200);
  assert.equal(readResponse.headers.get('content-type'), 'image/png');
  assert.match(readResponse.headers.get('cache-control') || '', /private/);
  assert.match(readResponse.headers.get('cache-control') || '', /no-store/);
  const readBytes = Buffer.from(await readResponse.arrayBuffer());
  const stored = await attachmentStore.readImage(admittedBatches[0][0]);
  assert.deepEqual(readBytes, Buffer.from(stored.data), '回读 HTTP 必须返回 DSH 校验后的原字节');
  assert.equal(readRequests.length, 1);
  assert.deepEqual(readRequests[0].ref, admittedBatches[0][0]);

  // SSE 首帧会带刷新历史，但只能含 attachment ref；抽样完整首帧，既不能出现
  // 上传 base64，也不能出现任何类似长 base64 块。
  const sseResponse = await fetch(`${base}/api/cases/${caseId}/agent/events`);
  const sseReader = sseResponse.body.getReader();
  const decoder = new TextDecoder();
  let sseSample = '';
  while (!sseSample.includes('\n\n')) {
    const chunk = await sseReader.read();
    if (chunk.done) break;
    sseSample += decoder.decode(chunk.value, { stream: true });
  }
  await sseReader.cancel();
  assert.match(sseSample, new RegExp(uploaded.attachmentId));
  assert.equal(sseSample.includes(FIXTURE_IMAGE_DATA), false, 'SSE 历史不得携带上传 base64');
  const longBase64Chunks = sseSample.match(/[A-Za-z0-9+/]{256,}={0,2}/gu) || [];
  assert.doesNotMatch(sseSample, /[A-Za-z0-9+/]{256,}={0,2}/u, 'SSE 不得出现疑似 base64 长块');

  const audits = db.prepare(
    "SELECT action, detail FROM audit_log WHERE entity = 'agent-worker' AND entity_id = ? ORDER BY id"
  ).all(caseId);
  assert.equal(audits.some((row) => String(row.detail).includes(FIXTURE_IMAGE_DATA)), false, '审计日志不得保存 base64');
  assert.equal(audits.some((row) => row.action === 'agent-attachment-upload' && row.detail === 'count=1'), true);
  assert.equal(audits.some((row) => row.action === 'agent-prompt' && /images=1/.test(row.detail)), true);

  const serverSource = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(
    serverSource,
    /app\.use\(\s*['"]\/api['"],\s*apiAuth,[\s\S]*?agentRouter[\s\S]*?\);/u,
    '附件路由所在 agentRouter 必须挂在登录态 apiAuth 之后',
  );

  console.log(`EVIDENCE_IMAGE_WIRE ${JSON.stringify(blocks)}`);
  console.log(`EVIDENCE_IMAGE_READBACK ${JSON.stringify({ referenced: 200, unreferenced: 404, crossCase: 404, bytes: readBytes.length })}`);
  console.log(`EVIDENCE_IMAGE_SSE_SAMPLE ${sseSample.replace(/\s+/g, ' ').slice(0, 600)}`);
  console.log(`EVIDENCE_IMAGE_SSE_BASE64_GREP long_base64_chunks=${longBase64Chunks.length}`);
  console.log(`EVIDENCE_IMAGE_REJECTIONS ${JSON.stringify({ overCount: '最多 2 张', overBytes: '8MiB', wrongType: 'PNG/JPEG/WebP/GIF', nonVision: '当前模型不支持图片' })}`);
  console.log('agent image HTTP: real admission store + limits + non-vision rejection + image content block passed');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await supervisor.stopAll('image-http-test-finished');
  await attachmentContext.fiber.dispose();
  fs.rmSync(scratch, { recursive: true, force: true });
}
