#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({
  name: 'anqi-spike-local',
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
console.error('anqi spike MCP server ready on stdio');
