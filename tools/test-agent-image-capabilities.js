import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import * as yaml from '../src/agent/runtime/node_modules/js-yaml/index.js';
import { interpolate, isJsExpr } from '../src/agent/runtime/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-image-capabilities-'));
process.env.DB_PATH = path.join(scratch, 'image-capabilities.db');

const { db } = await import('../src/db.js');
const {
  AGENT_SETTINGS_KEYS,
  loadAgentConfig,
  modelSupportsImages,
} = await import('../src/agent/config.js');
const { createAgentRouter } = await import('../src/routes/agent.js');

function upsertSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

function configure(model) {
  upsertSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
  upsertSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
  upsertSetting(AGENT_SETTINGS_KEYS.model, model);
  upsertSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'IMAGE_TEST_PROVIDER_KEY');
  upsertSetting(AGENT_SETTINGS_KEYS.baseURL, 'https://api.deepseek.com');
  upsertSetting(AGENT_SETTINGS_KEYS.capabilityMode, 'project');
}

const configPath = new URL('../src/agent/assets/anqi.cordis.yml', import.meta.url);
const configSource = fs.readFileSync(configPath, 'utf8');
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data) => data.__jsExpr,
});
const configSchema = yaml.JSON_SCHEMA.extend(JsExpr);

function resolveLlmRows(model) {
  const previous = process.env.DSH_MODEL;
  process.env.DSH_MODEL = model;
  try {
    const entries = yaml.load(configSource, { schema: configSchema });
    return {
      deepseek: interpolate({}, entries.find((entry) => entry.id === 'llm-deepseek').config),
      openai: interpolate({}, entries.find((entry) => entry.id === 'llm-pi-ai').config),
    };
  } finally {
    if (previous === undefined) delete process.env.DSH_MODEL;
    else process.env.DSH_MODEL = previous;
  }
}

let server;
try {
  assert.equal(modelSupportsImages('deepseek-vl2-vision'), true, '模型 id 含 vision 时必须声明图片输入');
  assert.equal(modelSupportsImages('DEEPSEEK-VISION-PRO'), true, 'vision 判定必须忽略大小写');
  assert.equal(modelSupportsImages('deepseek-v4-flash'), false, '默认文本模型不得声明图片输入');
  assert.equal(modelSupportsImages('deepseek-version-only'), false, '不含 vision 的相近模型名不得误判成视觉模型');

  configure('deepseek-v4-flash');
  assert.equal(loadAgentConfig().supportsImages, false, '默认模型配置必须暴露 supportsImages=false');
  configure('deepseek-vision-pro');
  assert.equal(loadAgentConfig().supportsImages, true, '视觉模型配置必须暴露 supportsImages=true');

  const textRows = resolveLlmRows('deepseek-v4-flash');
  assert.deepEqual(textRows.deepseek.models[0].inputModalities, ['text'], 'DeepSeek 默认模型声明只能含 text');
  assert.deepEqual(textRows.openai.providers['anqi-openai'].models[0].input, ['text'], 'OpenAI-compatible 默认模型声明只能含 text');
  const visionRows = resolveLlmRows('deepseek-vision-pro');
  assert.deepEqual(visionRows.deepseek.models[0].inputModalities, ['text', 'image'], 'DeepSeek vision 模型声明必须含 image');
  assert.deepEqual(visionRows.openai.providers['anqi-openai'].models[0].input, ['text', 'image'], 'OpenAI-compatible vision 模型声明必须含 image');

  const caseId = Number(db.prepare(
    "INSERT INTO cases (name, procedure, stage) VALUES ('图片能力状态自检案', '一审', '自检')"
  ).run().lastInsertRowid);
  let workerSupportsImages = false;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', createAgentRouter({
    publicStatus(requestedCaseId) {
      assert.equal(requestedCaseId, caseId);
      return { status: 'ready', caseId, supportsImages: workerSupportsImages };
    },
  }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  configure('deepseek-v4-flash');
  let response = await fetch(`${base}/api/agent/status`);
  let body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.supportsImages, false, '状态接口必须对默认模型返回 supportsImages=false');

  configure('deepseek-vision-pro');
  response = await fetch(`${base}/api/agent/status`);
  body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.supportsImages, true, '状态接口必须对 vision 模型返回 supportsImages=true');

  configure('deepseek-v4-flash');
  workerSupportsImages = true;
  response = await fetch(`${base}/api/agent/status?case_id=${caseId}`);
  body = await response.json();
  assert.equal(body.supportsImages, true, '案件状态必须以当前 live worker 的 vision 能力为准');
  configure('deepseek-vision-pro');
  workerSupportsImages = false;
  response = await fetch(`${base}/api/agent/status?case_id=${caseId}`);
  body = await response.json();
  assert.equal(body.supportsImages, false, '设置已改但旧 worker 未重启时不得误报图片能力');

  console.log('agent image capabilities: model id → Cordis modalities → HTTP status boolean passed');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}
