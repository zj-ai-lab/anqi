#!/usr/bin/env node
// 本地 stdio MCP server：只暴露一个只读工具 case_folder_info，用来在
// session/preflight 门禁里证明"模型确实拿到了 supervisor 钉死的那个案件夹
// cwd"（设计稿 §6 交付门禁第 4 条）。由 supervisor 通过 anqi.cordis.yml 的
// mcp-anqi-local 行以 `process.execPath <本文件>` 方式拉起，cwd 固定为
// DSH_CWD（真实案件夹，已由 supervisor 用 secure-files.js 的
// resolveCaseDirectory 校验过）。移植自 anqi-spike-dsh，逻辑未改动。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({
  name: 'anqi-local',
  version: '0.0.0',
});

server.registerTool('case_folder_info', {
  description: 'Return the case-folder working directory exposed to this local MCP process.',
  inputSchema: {},
}, async () => ({
  content: [{
    type: 'text',
    text: JSON.stringify({ cwd: process.cwd() }),
  }],
}));

await server.connect(new StdioServerTransport());
console.error('anqi local MCP server ready on stdio');
