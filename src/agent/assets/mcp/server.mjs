#!/usr/bin/env node
// 本地 stdio MCP server：只暴露一个只读工具 case_folder_info，用来在
// session/preflight 门禁里证明"模型确实拿到了 supervisor 钉死的那个案件夹
// cwd"（设计稿 §6 交付门禁第 4 条）。由 supervisor 通过 anqi.cordis.yml 的
// mcp-anqi-local 行以 `process.execPath <本文件>` 方式拉起，cwd 固定为
// DSH_CWD（真实案件夹，已由 supervisor 用 secure-files.js 的
// resolveCaseDirectory 校验过）。移植自 anqi-spike-dsh，逻辑未改动。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// DSH 会话本身不知道「今天」；案件会话首轮必调本工具，顺带下发北京时间日期与星期，
// 让「下周三」「明天」这类相对日期能被换算，而不是停下来问律师。
function beijingToday() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][new Date(`${today}T12:00:00Z`).getUTCDay()];
  return { today, weekday: `星期${weekday}` };
}

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
    text: JSON.stringify({ cwd: process.cwd(), ...beijingToday() }),
  }],
}));

await server.connect(new StdioServerTransport());
console.error('anqi local MCP server ready on stdio');
