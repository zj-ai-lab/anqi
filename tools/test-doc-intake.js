// 传票识别回归：文字层 / 辅助 OCR / 视觉模型 / 手填降级 / 暂存与附件事务。
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-doc-intake-'));
const filesRoot = path.join(scratch, 'files'); fs.mkdirSync(filesRoot);
const helper = path.join(scratch, 'fake-ocr.cjs');
const helperState = path.join(scratch, 'ocr-count');
fs.writeFileSync(helperState, '0');
fs.writeFileSync(helper, `#!/usr/bin/env node\nconst fs=require('fs'); const p=${JSON.stringify(helperState)}; const n=Number(fs.readFileSync(p,'utf8')||0)+1; fs.writeFileSync(p,String(n)); if(n>1) process.exit(1); console.log(JSON.stringify({ok:true,text:'张三 李四 2099年11月3日 09:30 第五法庭 这是一段足够长的测试文字内容',pages:1,engine:'vision'}));`);
await chmod(helper, 0o755);

function compressedPdf(text) {
  const stream = deflateSync(Buffer.from(`BT /F1 12 Tf 20 250 Td (${text}) Tj ET`, 'ascii'));
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  let length = chunks[0].length;
  const addObject = (id, body) => {
    offsets[id] = length;
    const head = Buffer.from(`${id} 0 obj\n`);
    const tail = Buffer.from('\nendobj\n');
    chunks.push(head, body, tail);
    length += head.length + body.length + tail.length;
  };
  addObject(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
  addObject(2, Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  addObject(3, Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'));
  addObject(4, Buffer.concat([
    Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`),
    stream,
    Buffer.from('\nendstream'),
  ]));
  addObject(5, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
  const xrefOffset = length;
  const xref = [`xref\n0 6\n0000000000 65535 f \n`];
  for (let id = 1; id <= 5; id++) xref.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  xref.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  chunks.push(Buffer.from(xref.join('')));
  return Buffer.concat(chunks);
}
let modelCalls = 0; let imageCalls = 0; let returnChineseFields = false;
const upstream = http.createServer((req, res) => {
  let body = ''; req.on('data', (chunk) => { body += chunk; }); req.on('end', () => {
    modelCalls++;
    const parsed = JSON.parse(body); const user = parsed.messages?.at(-1)?.content;
    const image = Array.isArray(user);
    if (image) imageCalls++;
    const fields = returnChineseFields
      ? { doc_kind: 'summons', date: '2099年11月3日', time: '上午9时30分', location: '本院第五法庭', court: '示例法院', case_no: '(2099)测0000民初1号', parties: ['张三', '李四'], summary: '张三案开庭' }
      : { doc_kind: 'summons', date: '2099-11-03', time: '09:30', location: '第五法庭', court: '示例法院', case_no: '(2099)测0000民初1号', parties: ['张三', '李四'], summary: '张三案开庭' };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fields) } }] }));
  });
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const envBase = `http://127.0.0.1:${upstream.address().port}`;
const port = 39893;
const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, DB_PATH: path.join(scratch, 'db.sqlite'), ANJIAN_FILES_ROOT: filesRoot, ANJIAN_OCR_HELPER: helper, DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: envBase, ANJIAN_VISION_MODEL: 'deepseek-flash', PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', ANJIAN_UNSAFE_NO_AUTH: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
const request = async (url, options = {}) => { const response = await fetch(`http://127.0.0.1:${port}${url}`, options); const text = await response.text(); let json; try { json = JSON.parse(text); } catch { json = { raw: text }; } return { response, json }; };
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
const postExtract = (body, name = '传票.png') => request('/api/quick/extract?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body });
try {
  const created = await request('/api/cases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '张三案（传票）', procedure: '一审', client: '张三', opponent: '李四', court: '示例法院', case_no: '(2099)测0000民初1号' }) });
  const cid = created.json.id; const folder = path.join(filesRoot, created.json.folder_path); assert.ok(fs.existsSync(folder));
  const pdf = Buffer.from('%PDF-1.4\nBT\n(张三 李四 2099-11-03 这是一段超过三十个字符的文字层测试内容) Tj\nET\n%%EOF');
  const compressed = compressedPdf('Zhang San Li Si 2099-11-03 compressed text layer has more than thirty chars');
  const compressedResult = await postExtract(compressed, '压缩通知.pdf');
  assert.equal(compressedResult.response.status, 200); assert.equal(compressedResult.json.source, 'pdf-text');
  const pdfResult = await postExtract(pdf, '通知.pdf'); assert.equal(pdfResult.response.status, 200); assert.equal(pdfResult.json.source, 'pdf-text'); assert.equal(pdfResult.json.staged.size, pdf.length);
  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]);
  const beforeImageCalls = imageCalls; const ocrResult = await postExtract(png); assert.equal(ocrResult.json.source, 'system-ocr'); assert.equal(imageCalls, beforeImageCalls);
  process.env.OCR_MODE = 'fail';
  const visionResult = await postExtract(png, 'fail.png'); assert.equal(visionResult.json.source, 'vision-llm'); assert.ok(imageCalls > beforeImageCalls);
  // macOS 12/错误架构的 helper 会在 execFile 启动阶段失败；必须继续走视觉模型而不是 500。
  fs.writeFileSync(helper, Buffer.from([0, 1, 2, 3])); await chmod(helper, 0o755);
  const startupFallback = await postExtract(png, 'startup-error.png'); assert.equal(startupFallback.response.status, 200); assert.equal(startupFallback.json.source, 'vision-llm'); assert.ok(imageCalls > beforeImageCalls + 1);
  returnChineseFields = true;
  const chineseFields = await postExtract(png, '中文日期.png');
  returnChineseFields = false;
  assert.equal(chineseFields.json.kind, 'hearing'); assert.equal(chineseFields.json.date, '2099-11-03');
  assert.equal(chineseFields.json.time, '09:30'); assert.equal(chineseFields.json.location, '示例法院第五法庭');
  const unknown = await postExtract(Buffer.from('nope')); assert.equal(unknown.response.status, 415);
  const tooBig = await postExtract(Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(20 * 1024 * 1024)])); assert.equal(tooBig.response.status, 413);
  const manual = await request('/api/quick/extract?name=x.png', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: png }); assert.equal(manual.response.status, 200);
  const stagedToken = visionResult.json.staged.token;
  const invalidQuick = await request('/api/quick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'hearing', text: '传票原文', date: '2099-99-99', case_id: cid, staged_token: stagedToken }) });
  assert.equal(invalidQuick.response.status, 400); assert.ok(fs.existsSync(path.join(scratch, 'quick-staging', stagedToken)), '第一次失败后暂存必须保留');
  const quick = await request('/api/quick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'hearing', text: '传票原文', date: '2099-11-03', time: '09:30', case_id: cid, staged_token: stagedToken }) });
  if (quick.response.status !== 200) console.error('quick failed', quick.response.status, quick.json);
  assert.equal(quick.response.status, 200); assert.equal(quick.json.attachment.entity, 'event'); assert.ok(fs.existsSync(path.join(folder, quick.json.attachment.rel_path)));
  const noFolder = await request('/api/cases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '无夹案（传票）', folder_path: 'will-be-created', procedure: '一审' }) });
  const noFolderPath = path.join(filesRoot, noFolder.json.folder_path); fs.rmSync(noFolderPath, { recursive: true, force: true });
  const noFolderQuick = await request('/api/quick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'hearing', text: '传票', date: '2099-11-03', case_id: noFolder.json.id, staged_token: manual.json.staged.token }) });
  assert.equal(noFolderQuick.response.status, 409);
  console.log(`doc intake ok (${modelCalls} model calls)`);
} finally {
  child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); await new Promise((resolve) => upstream.close(resolve));
}
