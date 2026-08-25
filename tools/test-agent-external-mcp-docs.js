import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const changelog = read('docs/CHANGES.md');
const profile = read('public/profile.html');
const config = read('src/agent/config.js');
const composition = read('src/agent/assets/anqi.cordis.yml');
const check = read('tools/check.sh');

// Phase 6 不新增第三方插件或权限；它把已经存在的、可审计的 Cordis/MCP
// 接入面写成产品契约，并让设置页在用户填写 patch 前就能看到风险与边界。
assert.match(composition, /- id: mcp-anqi-local\s+name: '@deepseek-ai\/dsh-mcp-client'[\s\S]*?serverName: anqi-local/);
assert.match(config, /if \(capabilityMode === 'full'\) \{[\s\S]*?validateAgentPluginPatch/);
assert.match(check, /node tools\/test-dsh-base-parity\.js/);

assert.match(changelog, /### 外部 DSH\/MCP 插件安全接入/);
assert.match(changelog, /mcp__<server>__<tool>/);
assert.match(changelog, /仅在 `full` 完整档加载/);
assert.match(changelog, /默认 `project` 案件项目档不启用 `bash` 或 `web_search`/);
assert.match(changelog, /npm run check/);

assert.match(profile, /id="agent-plugin-safety-note"/);
assert.match(profile, /mcp__&lt;server&gt;__&lt;tool&gt;/);
assert.match(profile, /案件项目档不加载第三方 patch，也不启用 bash\/联网/);
assert.match(profile, /新增或更新后必须通过 npm run check/);

console.log('agent Phase 6 external MCP docs: built-in client + full-only reviewed patch + tool naming + parity/default boundary passed');
