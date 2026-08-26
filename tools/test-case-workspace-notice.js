// T2-Visible-Fallback-Notice · 前端渲染回归（静态结构审查，先例 tools/smoke-agent-frontend.js）：
//   a) loadFiles 必须消费 API 的 workspace_notice 字段，且只在非空时渲染；
//   b) 提示文本只经 textContent（整个 case.js 禁 innerHTML），防存储型 XSS；
//   c) 提示节点插在 #file-list 之前（文件列表上方），空值时移除、不占位；
//   d) 样式走三皮肤既有类（.money-notice，amber 族 token），不引入新 CSS。
// 真实 DOM 行为由隔离实例浏览器自测取证（PROGRESS 工作会话 8）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'public/js/case.js'), 'utf8');

try {
  assert.ok(src.includes('d.workspace_notice'), 'loadFiles 必须消费 GET /cases/:id/files 的 workspace_notice 字段');
  assert.ok(src.includes("'file-workspace-notice'"), '提示节点必须有稳定 id file-workspace-notice，便于幂等更新与移除');
  assert.ok(src.includes('prev?.remove()') || src.includes('prev.remove()'), 'workspace_notice 为空时必须移除旧提示，不显示、不占位');
  assert.ok(/renderWorkspaceNotice\((?:d\.workspace_notice \|\| null|d\.workspace_notice)\)/.test(src), 'loadFiles 成功路径必须把 workspace_notice 交给渲染助手');
  assert.ok(src.includes('renderWorkspaceNotice(null)'), 'loadFiles 失败/无案件夹的早退路径也必须清掉陈旧提示');
  assert.ok(src.includes('textContent = text') || src.includes(".textContent = '⚠ ' + notice"), '提示文本必须经 textContent 写入');
  assert.ok(!src.includes('innerHTML'), 'case.js 全文件禁 innerHTML（含本提示），防存储型 XSS');
  assert.ok(src.includes("class: 'money-notice'"), '提示样式必须复用三皮肤既有 amber 类 money-notice，走皮肤 token');
  assert.ok(src.includes('box.before(node)'), '提示节点必须插在 #file-list 之前（文件列表上方）');

  console.log('case workspace notice frontend: textContent-only + tri-skin class + above file list + empty-removal passed');
} catch (error) {
  console.error(`CASE_NOTICE_STATIC_FAIL: ${error.message}`);
  throw error;
}
