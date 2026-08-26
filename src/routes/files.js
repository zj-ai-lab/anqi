// 案件文件桥：浏览、上传、取流与附件引用。
// 案件夹是唯一文件真相源；数据库只存相对路径，解除引用不删除原件。
// 文件根由 ANJIAN_FILES_ROOT 配置；上传使用 PUT 原始字节流，文件名走 query。
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { db, audit } from '../db.js';
import {
  legalRagBridgeConfigured,
  legalRagStateMap,
  queueCaseFile,
} from '../lib/legalrag-bridge.js';
import {
  listSecureDirectory,
  normalizeRelativeFilePath,
  openSecureFile,
  resolveCaseDirectoryForCase,
  sanitizeUploadFileName,
  writeUniqueSecureFile,
} from '../lib/secure-files.js';

const r = Router();
const ROOT = process.env.ANJIAN_FILES_ROOT || '';

// 允许写入的子目录白名单（§9.3 物理归档维度；上传默认落 法院文书/）
const WRITE_DIRS = ['法院文书', '立案材料', '证据整理', '客户沟通', '办案过程', '人工终稿', '财务凭证'];
const MAX_UPLOAD = 60 * 1024 * 1024; // 60MB

const PATH_BOUNDARY_ERRORS = new Set([
  'not_found',
  'path_changed',
  'invalid_case_name',
  'invalid_path',
  'symlink',
  'escape',
  'not_directory',
  'not_file',
]);

function securePathFailure(
  res,
  error,
  notFoundMessage = '文件或目录不存在',
  { concealPathBoundary = false } = {}
) {
  if (['root_unconfigured', 'root_unavailable', 'root_invalid'].includes(error?.code)) {
    return res.status(503).json({ error: error.message });
  }
  if (error?.code === 'not_found' || (concealPathBoundary && PATH_BOUNDARY_ERRORS.has(error?.code))) {
    return res.status(404).json({ error: notFoundMessage });
  }
  if (error?.code === 'path_changed') return res.status(409).json({ error: error.message });
  if (['invalid_case_name', 'invalid_path', 'invalid_filename', 'symlink', 'escape', 'not_directory', 'not_file'].includes(error?.code)) {
    return res.status(400).json({ error: error.message });
  }
  throw error;
}

// 返回案件行和经过真实路径、目录类型及符号链接检查的案件夹上下文。
function mustCase(req, res) {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (!c) { res.status(404).json({ error: '案件不存在' }); return null; }
  try {
    const context = resolveCaseDirectoryForCase(ROOT, c);
    return { c, context };
  } catch (error) {
    securePathFailure(res, error, '文件或目录不存在', {
      concealPathBoundary: req.method === 'GET' || req.method === 'HEAD',
    });
    return null;
  }
}

const MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.html': 'text/plain; charset=utf-8', // html 以纯文本回，防存储型 XSS
};

// 列一层目录（供 GET /files 与目录指纹复用）；符号链接不进入结果。
function listDir(context, rawRelativePath) {
  const rel = normalizeRelativeFilePath(rawRelativePath, { allowEmpty: true });
  return { rel, ...listSecureDirectory(context, rel) };
}

// 浏览案件夹（单层；dir 相对案件根）
r.get('/cases/:id/files', (req, res) => {
  const m = mustCase(req, res);
  if (!m) return;
  const { context } = m;
  if (!context.exists) return res.json({ exists: false, dir: '', dirs: [], files: [] });
  let listing;
  try {
    listing = listDir(context, String(req.query.dir || ''));
  } catch (error) {
    return securePathFailure(res, error, '目录不存在', { concealPathBoundary: true });
  }
  const states = legalRagStateMap(m.c.id);
  const files = listing.files.map((file) => {
    const relPath = listing.rel ? path.posix.join(listing.rel, file.name) : file.name;
    const state = states.get(relPath);
    return {
      ...file,
      legalrag: state ? {
        id: state.id,
        status: state.sync_status,
        revision: state.revision,
        document_id: state.legalrag_document_id,
        candidate_count: state.candidate_count,
        document_type: state.document_type,
        case_relation: state.case_relation,
        evidence_mode: state.evidence_mode,
        screening_decision: state.screening_decision,
        screening_reason: state.screening_reason,
        error: state.last_error,
      } : null,
    };
  });
  res.json({
    exists: true, dir: listing.rel, dirs: listing.dirs, files,
    write_dirs: WRITE_DIRS, legalrag_enabled: legalRagBridgeConfigured(),
    // 只读透传：secure-files 判定回落到同名目录时提示前端；正常案件整个省略该字段
    ...(context.fallbackNotice ? { workspace_notice: context.fallbackNotice } : {}),
  });
});

// 取文件流（inline 预览）
r.get('/cases/:id/file', (req, res) => {
  const m = mustCase(req, res);
  if (!m) return;
  if (!m.context.exists) return res.status(404).json({ error: '文件不存在' });
  let opened;
  try {
    opened = openSecureFile(m.context, String(req.query.path || ''));
  } catch (error) {
    return securePathFailure(res, error, '文件不存在', { concealPathBoundary: true });
  }
  const ext = path.extname(opened.absolute).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(opened.absolute))}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(opened.absolute, { fd: opened.fd, autoClose: true }).pipe(res);
});

// 上传（原始字节流）。query: dir(白名单)、name、entity/entity_id（可选，同时建引用）
r.put('/cases/:id/files', express.raw({ type: '*/*', limit: MAX_UPLOAD }), (req, res) => {
  const m = mustCase(req, res);
  if (!m) return;
  const { c, context } = m;
  const dir = String(req.query.dir || '法院文书');
  if (!WRITE_DIRS.includes(dir)) return res.status(400).json({ error: `dir 须为：${WRITE_DIRS.join('/')}` });
  const name = sanitizeUploadFileName(req.query.name);
  if (!name) return res.status(400).json({ error: '文件名非法' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: '空文件' });
  if (!context.exists) return res.status(404).json({ error: `案件夹不存在：${c.name}（请先建立或核对案件夹名称）` });

  let written;
  try {
    written = writeUniqueSecureFile(context, dir, name, req.body);
  } catch (error) {
    return securePathFailure(res, error);
  }
  const final = written.filename;
  const relPath = written.relativePath;

  let attachment = null;
  const entity = String(req.query.entity || '');
  const entityId = req.query.entity_id ? Number(req.query.entity_id) : null;
  if (['event', 'deadline', 'fee', 'worklog', ''].includes(entity)) {
    const info = db.prepare(
      'INSERT INTO attachments (case_id, entity, entity_id, rel_path, filename, size, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(c.id, entity, entityId, relPath, final, req.body.length, 'upload');
    attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(info.lastInsertRowid);
  }
  audit(req.actor, 'upload', 'file', attachment?.id || null, `${c.name}/${relPath} ${req.body.length}B`);
  let legalrag = null;
  if (legalRagBridgeConfigured()) {
    try {
      legalrag = queueCaseFile(c.id, relPath, { priority: 90, actor: req.actor });
    } catch (error) {
      legalrag = { status: 'failed', error: error.message };
    }
  }
  res.json({ ok: true, rel_path: relPath, filename: final, attachment, legalrag });
});

// 把案件夹里已有文件挂到记录上（引用，不复制）
r.post('/cases/:id/attachments', (req, res) => {
  const m = mustCase(req, res);
  if (!m) return;
  const { c, context } = m;
  const b = req.body || {};
  if (!context.exists) return res.status(404).json({ error: '文件不存在' });
  let opened;
  try {
    opened = openSecureFile(context, String(b.rel_path || ''));
  } catch (error) {
    return securePathFailure(res, error, '文件不存在');
  }
  fs.closeSync(opened.fd);
  if (!['event', 'deadline', 'fee', 'worklog', ''].includes(b.entity || '')) return res.status(400).json({ error: 'entity 非法' });
  const info = db.prepare(
    'INSERT INTO attachments (case_id, entity, entity_id, rel_path, filename, size, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(c.id, b.entity || '', b.entity_id || null, opened.relativePath, path.basename(opened.absolute), opened.stat.size, 'link');
  audit(req.actor, 'link', 'attachment', info.lastInsertRowid, `${c.name}/${opened.relativePath}`);
  res.json(db.prepare('SELECT * FROM attachments WHERE id = ?').get(info.lastInsertRowid));
});

// ---- 案件夹变更推送（0.6.0）----
// SSE + fs.watch；平台或文件系统不支持 watch 时，前端在页面可见期间轻量轮询目录指纹。
const WATCH_DEBOUNCE = 300;   // 合并同步软件的写入风暴
const SSE_HEARTBEAT = 25000;  // 穿过反向代理的空闲超时

// 递归 watch；平台不支持 recursive 时退化为「根 + 一级子目录」并在变更时补挂新子目录
function watchTree(root, onChange) {
  const watchers = [];
  const watched = new Set();
  const add = (p) => {
    if (watched.has(p)) return;
    try { watchers.push(fs.watch(p, onChange)); watched.add(p); } catch { /* 单个子目录挂不上不致命 */ }
  };
  try {
    watchers.push(fs.watch(root, { recursive: true }, onChange));
    return { watchers, rearm: () => {} };
  } catch {
    add(root);
    const rearm = () => {
      if (!fs.existsSync(root)) return;
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (ent.isDirectory() && !ent.name.startsWith('.')) add(path.join(root, ent.name));
      }
    };
    rearm();
    return { watchers, rearm };
  }
}

r.get('/cases/:id/files/events', (req, res) => {
  const m = mustCase(req, res);
  if (!m) return;
  const { context } = m;
  const watchRoot = context.exists ? context.caseRoot : context.filesRoot;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 提示支持该响应头的反向代理不要缓冲事件流
  });

  let watch = null;
  let timer = null;
  const queue = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      watch?.rearm();
      res.write(`event: change\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    }, WATCH_DEBOUNCE);
  };

  try {
    // 案件夹还没建时盯已解析的文件根——它一出现就能推第一条。
    watch = watchTree(watchRoot, queue);
  } catch {
    res.write('event: degraded\ndata: {"reason":"watch-unavailable"}\n\n');
  }

  res.write(`event: ready\ndata: ${JSON.stringify({ watching: !!watch })}\n\n`);
  const hb = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT);

  req.on('close', () => {
    clearInterval(hb);
    clearTimeout(timer);
    for (const w of watch?.watchers || []) { try { w.close(); } catch { /* 已关 */ } }
    res.end();
  });
});

// 目录指纹（SSE 不可用时的轮询降级路径；一次 readdir，够便宜）
r.get('/cases/:id/files/sig', (req, res) => {
  const m = mustCase(req, res);
  if (!m) return;
  const { context } = m;
  if (!context.exists) return res.json({ exists: false, sig: '' });
  let listing;
  try {
    listing = listDir(context, String(req.query.dir || ''));
  } catch (error) {
    return securePathFailure(res, error, '目录不存在', { concealPathBoundary: true });
  }
  const sig = [
    ...listing.dirs,
    ...listing.files.map((f) => `${f.name}:${f.size}:${Math.round(f.mtime_ms)}`),
  ].join('|');
  res.json({ exists: true, sig });
});

// 解除引用（不动文件本体）
r.delete('/attachments/:aid', (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.aid);
  if (!row) return res.status(404).json({ error: '附件引用不存在' });
  db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
  audit(req.actor, 'unlink', 'attachment', row.id, row.rel_path);
  res.json({ ok: true, note: '仅解除引用，文件本体仍在案件夹' });
});

export default r;
