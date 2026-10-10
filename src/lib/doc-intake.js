// 传票/文书识别的纯解析层：不 import db，不写库。
// 文件进入 quick-staging 后，在路由层负责案件匹配、附件与事务。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractText, getDocumentProxy } from 'unpdf';
import { llmReady } from './llm.js';
import { isDate } from './dates.js';

const execFileAsync = promisify(execFile);
export const MAX_STAGING_BYTES = 20 * 1024 * 1024;
export const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
export const STAGING_DIR = path.join(path.dirname(process.env.DB_PATH || path.join(process.cwd(), 'data', 'anjian.db')), 'quick-staging');
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const API_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '') + '/chat/completions';
const VISION_MODEL = process.env.ANJIAN_VISION_MODEL || 'deepseek-flash';
const TEXT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

export function cleanupStaging(now = Date.now()) {
  fs.mkdirSync(STAGING_DIR, { recursive: true });
  for (const entry of fs.readdirSync(STAGING_DIR, { withFileTypes: true })) {
    const target = path.join(STAGING_DIR, entry.name);
    try {
      const stat = fs.statSync(target);
      if (now - stat.mtimeMs > STAGING_TTL_MS) fs.rmSync(target, { recursive: true, force: true });
    } catch { /* race with another cleanup */ }
  }
}
cleanupStaging();

export function detectMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function unescapePdfText(value) {
  return value.replace(/\\([\\()])/g, '$1').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function extractPdfTextFallback(buffer) {
  const raw = Buffer.from(buffer).subarray(0, 12 * 1024 * 1024).toString('latin1');
  const chunks = [];
  for (const match of raw.matchAll(/\(([^()]*)\)\s*T[Jj]/g)) chunks.push(unescapePdfText(match[1]));
  const text = chunks.join('\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ').trim();
  return text;
}

// unpdf 使用纯 JS PDF.js serverless build，不需要 canvas/poppler 等原生依赖。
// 只读取前 5 页；正则只作为极简/损坏 fixture 在 unpdf 抛错时的兼容兜底。
export async function extractPdfText(buffer) {
  let pdf = null;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer));
    const extracted = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(extracted.text) ? extracted.text.slice(0, 5) : [extracted.text];
    return pages.join('\n').normalize('NFKC').trim();
  } catch {
    return extractPdfTextFallback(buffer).normalize('NFKC').trim();
  } finally {
    try { await pdf?.destroy?.(); } catch { /* PDF.js cleanup is best effort */ }
  }
}

function helperCandidates() {
  return [
    process.env.ANJIAN_OCR_HELPER,
    process.resourcesPath && path.join(process.resourcesPath, 'bin', 'anqi-ocr'),
    path.join(process.cwd(), 'build', 'bin', 'anqi-ocr'),
  ].filter(Boolean);
}

async function runOcrHelper(filePath) {
  // env 指定的假辅助程序允许 Linux 回归测试；正式 macOS 路径仍按任务书查找。
  if (process.platform !== 'darwin' && !process.env.ANJIAN_OCR_HELPER) return null;
  const helper = helperCandidates().find((candidate) => fs.existsSync(candidate));
  if (!helper) return null;
  try {
    const { stdout } = await execFileAsync(helper, [filePath], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    const value = JSON.parse(String(stdout).trim());
    if (!value?.ok || typeof value.text !== 'string' || value.text.trim().length < 30) return null;
    return { text: value.text.trim(), source: 'system-ocr', engine: value.engine || 'vision' };
  } catch {
    return null;
  }
}

function parseModelJson(value) {
  const raw = value?.choices?.[0]?.message?.content;
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('模型未返回内容');
  const clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}

async function callModel({ model, messages, timeout = 30_000 }) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('未配置模型密钥');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const response = await fetch(API_URL, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, temperature: 0, max_tokens: 800 }),
    });
    if (!response.ok) throw new Error(`模型 HTTP ${response.status}`);
    return parseModelJson(await response.json());
  } finally { clearTimeout(timer); }
}

function extractionPrompt(text) {
  return `从以下法院传票或文书文字中提取结构化字段，只输出 JSON：{"doc_kind":"summons","date":"","time":"","location":"","court":"","case_no":"","parties":[],"summary":""}。没有明确写出的字段留空，不推算日期或期限。\n${text.slice(0, 8000)}`;
}

async function extractTextFields(text) {
  if (!llmReady()) return null;
  return callModel({ model: TEXT_MODEL, messages: [
    { role: 'system', content: '你是法律文书字段抽取器。严格只输出 JSON，不计算期限，不创造事实。' },
    { role: 'user', content: extractionPrompt(text) },
  ] });
}

async function extractVisionFields(buffer, mime) {
  const image = `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`;
  return callModel({ model: VISION_MODEL, messages: [
    { role: 'system', content: '你是法院传票识别器。看图后严格只输出 JSON：{"doc_kind":"summons","date":"","time":"","location":"","court":"","case_no":"","parties":[],"summary":""}。没有明确字段留空，不计算期限。' },
    { role: 'user', content: [{ type: 'text', text: '读取这张传票并提取字段。' }, { type: 'image_url', image_url: { url: image } }] },
  ] });
}

export function sanitizeFields(value = {}) {
  const date = isDate(value.date) ? value.date : '';
  const time = TIME_RE.test(String(value.time || '')) ? String(value.time) : '';
  const parties = Array.isArray(value.parties) ? value.parties.map((x) => String(x || '').trim().slice(0, 30)).filter(Boolean).slice(0, 6) : [];
  return {
    doc_kind: String(value.doc_kind || '').slice(0, 40), date, time,
    location: String(value.location || '').trim().slice(0, 120),
    court: String(value.court || '').trim().slice(0, 120),
    case_no: String(value.case_no || '').trim().slice(0, 60),
    parties,
    summary: String(value.summary || '').trim().slice(0, 1000),
  };
}

export function stageBuffer(buffer, filename) {
  cleanupStaging();
  const token = crypto.randomBytes(64).toString('hex');
  const safeName = String(filename || '上传文件').replace(/[\\/\0]/g, '_').slice(0, 255) || '上传文件';
  const filePath = path.join(STAGING_DIR, token);
  const metaPath = `${filePath}.json`;
  fs.writeFileSync(filePath, buffer, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(metaPath, JSON.stringify({ token, filename: safeName, size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), staged_at: new Date().toISOString() }), { mode: 0o600 });
  return { token, filename: safeName, size: buffer.length, filePath, metaPath };
}

export function readStaged(token) {
  if (!/^[a-f0-9]{128}$/.test(String(token || ''))) return null;
  const filePath = path.join(STAGING_DIR, token);
  const metaPath = `${filePath}.json`;
  if (!fs.existsSync(filePath) || !fs.existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const buffer = fs.readFileSync(filePath);
    if (meta.sha256 !== crypto.createHash('sha256').update(buffer).digest('hex')) return null;
    return { ...meta, filePath, metaPath, buffer };
  } catch { return null; }
}

export async function extractDocument({ buffer, filename, staged }) {
  cleanupStaging();
  const mime = detectMime(buffer);
  if (!mime) throw Object.assign(new Error('仅支持 PDF/JPG/PNG/WebP（iPhone 照片请选 JPG）'), { status: 415, code: 'unsupported_type' });
  let source = '';
  let fields = null;
  let text = '';
  if (mime === 'application/pdf') {
    text = await extractPdfText(buffer);
    if (text.replace(/\s/g, '').length >= 30) { source = 'pdf-text'; fields = await extractTextFields(text).catch(() => null); }
  }
  if (!fields && (mime !== 'application/pdf' || !source)) {
    const helper = await runOcrHelper(staged?.filePath || '');
    if (helper) { source = helper.source; text = helper.text; fields = await extractTextFields(text).catch(() => null); }
  }
  if (!fields && mime !== 'application/pdf' && llmReady()) {
    try { fields = await extractVisionFields(buffer, mime); source = 'vision-llm'; }
    catch (error) { return { source: 'vision-llm', needs_manual: true, reason: `AI 看图失败：${error.message}` }; }
  }
  const stagedInfo = staged ? { token: staged.token, filename: staged.filename, size: staged.size } : null;
  if (!fields) return { source: source || 'manual', needs_manual: true, reason: llmReady() ? '未能从文件提取足够文字' : '未配置识别模型，请手填', staged: stagedInfo };
  const clean = sanitizeFields(fields);
  return { ...clean, source: source || 'vision-llm', ...(clean.date ? { kind: 'hearing' } : { kind: 'task' }), staged: stagedInfo };
}
