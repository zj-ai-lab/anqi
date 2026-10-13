#!/usr/bin/env node
// 案件会话首轮必调的 mcp__anqi-local__case_folder_info：除 cwd 外还要下发北京时间
// today / weekday，否则 DSH 会话不知道今天几号，「下周三」只能停下来问律师
// （2026-10-13 真模型验收抓到）。真起一次 stdio MCP 进程调用，不 mock。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'src/agent/assets');
const sdk = (rel) => path.join(ASSETS, 'node_modules/@modelcontextprotocol/sdk/dist/esm', rel);
const { Client } = await import(sdk('client/index.js'));
const { StdioClientTransport } = await import(sdk('client/stdio.js'));
const { todayCN, weekdayCN } = await import('../src/lib/dates.js');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-mcp-today-'));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ASSETS, 'mcp/server.mjs')],
  cwd,
  env: { PATH: process.env.PATH || '', TZ: 'America/New_York' },
  stderr: 'ignore',
});
const client = new Client({ name: 'anqi-mcp-today-test', version: '0.0.0' });
try {
  await client.connect(transport);
  const result = await client.callTool({ name: 'case_folder_info', arguments: {} });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(fs.realpathSync(payload.cwd), fs.realpathSync(cwd));
  // 子进程故意设成纽约时区：日期仍须按北京时间给出。
  assert.equal(payload.today, todayCN());
  assert.equal(payload.weekday, weekdayCN(todayCN()));
  assert.deepEqual(Object.keys(payload).sort(), ['cwd', 'today', 'weekday']);
  console.log('agent MCP case_folder_info: cwd + Beijing today/weekday (child TZ=America/New_York) passed');
} finally {
  await client.close().catch(() => {});
  fs.rmSync(cwd, { recursive: true, force: true });
}
