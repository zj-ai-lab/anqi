// 案齐 ↔ LegalRAG 文件桥。
// - 案件夹是唯一原件；这里只登记相对路径和派生状态。
// - 上传/手动按钮只排本地持久化队列，不在 HTTP 请求里等待 OCR。
// - LLM 只生成 legalrag_candidates，人工 accept 才写正式表。
import fs from 'node:fs';
import path from 'node:path';
import { db, audit, withImmediateTransaction } from '../db.js';
import { isDate } from './dates.js';
import { isEventType } from './vocab.js';
import { ensureCandidateFact } from './candidate-facts.js';
import {
  normalizeRelativeFilePath,
  openSecureFile,
  resolveCaseDirectoryForCase,
  walkSecureFiles,
} from './secure-files.js';
import {
  DOCUMENT_EXTRACTOR,
  DOCUMENT_MIN_CONFIDENCE,
  DOCUMENT_MODEL,
  DOCUMENT_SCHEMA_VERSION,
  documentExtractorReady,
  extractDocument,
} from './document-extractor.js';

const SUPPORTED = new Set([
  '.pdf', '.docx', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff',
  '.txt', '.md', '.csv', '.json', '.xlsx',
]);
const MAX_FILE_SIZE = 60 * 1024 * 1024;
const REGISTER_TIMEOUT = 30000;
const STATUS_TIMEOUT = 12000;
const DEFAULT_RECONCILE_MS = 2 * 60 * 1000;
const DEFAULT_TICK_MS = 3000;

let tickRunning = false;
let started = false;

export function legalRagBridgeConfigured() {
  return !!(process.env.LEGALRAG_URL && process.env.LEGALRAG_INTERNAL_KEY && process.env.ANJIAN_FILES_ROOT);
}

function nowCN(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toLocaleString('sv-SE', {
    timeZone: 'Asia/Shanghai', hour12: false,
  });
}

function caseAndFile(caseId, relPath) {
  const row = db.prepare('SELECT id,name,folder_path,status FROM cases WHERE id=?').get(caseId);
  if (!row) throw new Error('案件不存在');
  if (!process.env.ANJIAN_FILES_ROOT) throw new Error('未配置 ANJIAN_FILES_ROOT');
  const context = resolveCaseDirectoryForCase(process.env.ANJIAN_FILES_ROOT, row);
  if (!context.exists) throw new Error('文件不存在');
  const rel = normalizeRelativeFilePath(relPath);
  const opened = openSecureFile(context, rel);
  fs.closeSync(opened.fd);
  const ext = path.extname(opened.absolute).toLowerCase();
  if (!SUPPORTED.has(ext)) throw new Error('该文件类型暂不支持 LegalRAG 解析');
  if (opened.stat.size <= 0) throw new Error('空文件不能解析');
  if (opened.stat.size > MAX_FILE_SIZE) throw new Error('文件超过 60MB 上限');
  return {
    caseRow: row,
    relPath: rel,
    absolute: opened.absolute,
    filename: path.basename(opened.absolute),
    size: opened.stat.size,
    mtimeMs: Math.round(opened.stat.mtimeMs),
  };
}

function latestFile(caseId, relPath) {
  return db.prepare(
    'SELECT * FROM legalrag_files WHERE case_id=? AND rel_path=? ORDER BY revision DESC LIMIT 1'
  ).get(caseId, relPath);
}

function currentFiles(caseId) {
  return db.prepare(
    `SELECT f.* FROM legalrag_files f
      JOIN (
        SELECT rel_path,MAX(revision) AS revision
          FROM legalrag_files WHERE case_id=? GROUP BY rel_path
      ) latest ON latest.rel_path=f.rel_path AND latest.revision=f.revision
     WHERE f.case_id=?`
  ).all(caseId, caseId);
}

function insertObserved(file, status = 'observed', priority = 0) {
  return withImmediateTransaction(() => {
    const revision = (db.prepare(
      'SELECT COALESCE(MAX(revision),0)+1 AS next FROM legalrag_files WHERE case_id=? AND rel_path=?'
    ).get(file.caseRow.id, file.relPath).next || 1);
    const info = db.prepare(
      `INSERT INTO legalrag_files
        (case_id,rel_path,filename,file_size,mtime_ms,revision,sync_status,priority,last_seen_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,datetime('now','+8 hours'),datetime('now','+8 hours'))`
    ).run(
      file.caseRow.id, file.relPath, file.filename, file.size, file.mtimeMs,
      revision, status, priority
    );
    const newId = info.lastInsertRowid;
    db.prepare(
      `UPDATE legalrag_files SET sync_status='ignored',
         last_error=?,updated_at=datetime('now','+8 hours')
       WHERE case_id=? AND rel_path=? AND id!=?`
    ).run(`已由 revision ${revision} 取代`, file.caseRow.id, file.relPath, newId);
    db.prepare(
      `UPDATE legalrag_candidates SET status='superseded',decided_at=datetime('now','+8 hours')
       WHERE status='pending' AND file_id IN (
         SELECT id FROM legalrag_files WHERE case_id=? AND rel_path=? AND id!=?
       )`
    ).run(file.caseRow.id, file.relPath, newId);
    db.prepare('INSERT OR IGNORE INTO legalrag_case_links (case_id) VALUES (?)').run(file.caseRow.id);
    return db.prepare('SELECT * FROM legalrag_files WHERE id=?').get(newId);
  });
}

export function queueCaseFile(caseId, relPath, { priority = 50, force = false, actor = '' } = {}) {
  const file = caseAndFile(caseId, relPath);
  const latest = latestFile(file.caseRow.id, file.relPath);
  let row;
  if (latest && latest.file_size === file.size && latest.mtime_ms === file.mtimeMs) {
    const terminal = ['processing', 'registering', 'extracting'].includes(latest.sync_status);
    const nextStatus = force && !terminal ? 'queued' : latest.sync_status === 'missing'
      ? (latest.legalrag_document_id ? 'ready' : 'queued')
      : latest.sync_status;
    db.prepare(
      `UPDATE legalrag_files
          SET filename=?,file_size=?,mtime_ms=?,last_seen_at=datetime('now','+8 hours'),
              missing_since='',sync_status=?,priority=MAX(priority,?),
              next_attempt_at=CASE WHEN ? THEN '' ELSE next_attempt_at END,
              last_error=CASE WHEN ? THEN '' ELSE last_error END,
              attempts=CASE WHEN ? THEN 0 ELSE attempts END,
              updated_at=datetime('now','+8 hours')
        WHERE id=?`
    ).run(
      file.filename, file.size, file.mtimeMs, nextStatus, priority,
      force ? 1 : 0, force ? 1 : 0, force ? 1 : 0, latest.id
    );
    row = db.prepare('SELECT * FROM legalrag_files WHERE id=?').get(latest.id);
  } else {
    row = insertObserved(file, 'queued', priority);
  }
  if (actor) audit(actor, 'legalrag-queue', 'file', row.id, `${file.caseRow.name}/${file.relPath}`);
  kickLegalRagBridge();
  return row;
}

export function reconcileLegalRagFiles({ bootstrap = false } = {}) {
  if (!process.env.ANJIAN_FILES_ROOT) return { cases: 0, files: 0, queued: 0 };
  const alreadyBootstrapped = !!db.prepare(
    "SELECT 1 FROM legalrag_bridge_meta WHERE key='reconcile_bootstrapped'"
  ).get();
  const establishBaseline = bootstrap || !alreadyBootstrapped;
  const cases = db.prepare(
    `SELECT c.id,c.name,c.folder_path FROM cases c
      LEFT JOIN legalrag_case_links l ON l.case_id=c.id
     WHERE c.status!='closed' AND COALESCE(l.sync_enabled,1)=1`
  ).all();
  let files = 0;
  let queued = 0;
  for (const caseRow of cases) {
    let context;
    try { context = resolveCaseDirectoryForCase(process.env.ANJIAN_FILES_ROOT, caseRow); } catch { continue; }
    if (!context.exists) continue;
    const current = currentFiles(caseRow.id);
    const byPath = new Map(current.map((row) => [row.rel_path, row]));
    const seen = new Set();
    for (const rel of walkSecureFiles(
      context,
      (name) => SUPPORTED.has(path.extname(name).toLowerCase())
    )) {
      files++;
      seen.add(rel);
      let file;
      try { file = caseAndFile(caseRow.id, rel); } catch { continue; }
      const latest = byPath.get(rel);
      if (!latest) {
        if (establishBaseline) insertObserved(file, 'observed', 0);
        else { insertObserved(file, 'queued', 10); queued++; }
        continue;
      }
      if (latest.file_size !== file.size || latest.mtime_ms !== file.mtimeMs) {
        insertObserved(file, 'queued', 20); queued++;
      } else if (latest.sync_status === 'missing') {
        const restore = latest.legalrag_document_id ? 'ready' : 'queued';
        db.prepare(
          `UPDATE legalrag_files SET sync_status=?,missing_since='',
             last_seen_at=datetime('now','+8 hours'),updated_at=datetime('now','+8 hours') WHERE id=?`
        ).run(restore, latest.id);
      }
    }
    for (const row of current) {
      if (!seen.has(row.rel_path) && !['missing', 'ignored'].includes(row.sync_status)) {
        db.prepare(
          `UPDATE legalrag_files SET sync_status='missing',
             missing_since=datetime('now','+8 hours'),updated_at=datetime('now','+8 hours') WHERE id=?`
        ).run(row.id);
      }
    }
  }
  if (establishBaseline) {
    db.prepare(
      `INSERT INTO legalrag_bridge_meta (key,value) VALUES ('reconcile_bootstrapped',datetime('now','+8 hours'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now','+8 hours')`
    ).run();
  }
  if (queued) kickLegalRagBridge();
  return { cases: cases.length, files, queued, baseline: establishBaseline };
}

async function bridgeFetch(route, { method = 'GET', body, timeout = STATUS_TIMEOUT } = {}) {
  const base = String(process.env.LEGALRAG_URL || '').replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(base + route, {
      method,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-LegalRAG-Key': process.env.LEGALRAG_INTERNAL_KEY || '',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw Object.assign(new Error(payload.detail || `LegalRAG HTTP ${response.status}`), { status: response.status });
    }
    return response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('LegalRAG 请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function updateCaseLink(fileId, externalCaseId, error = '') {
  const file = db.prepare('SELECT case_id FROM legalrag_files WHERE id=?').get(fileId);
  if (!file) return;
  db.prepare(
    `INSERT INTO legalrag_case_links
      (case_id,legalrag_case_id,status,last_error,last_synced_at,updated_at)
     VALUES (?,?,?, ?,datetime('now','+8 hours'),datetime('now','+8 hours'))
     ON CONFLICT(case_id) DO UPDATE SET
       legalrag_case_id=CASE WHEN excluded.legalrag_case_id!='' THEN excluded.legalrag_case_id
                            ELSE legalrag_case_links.legalrag_case_id END,
       status=excluded.status,last_error=excluded.last_error,
       last_synced_at=excluded.last_synced_at,updated_at=excluded.updated_at`
  ).run(file.case_id, externalCaseId || '', error ? 'error' : 'linked', error);
}

function retryOrFail(row, error) {
  const message = String(error?.message || error).slice(0, 1000);
  if (row.attempts < 3) {
    db.prepare(
      `UPDATE legalrag_files SET sync_status='queued',last_error=?,
         next_attempt_at=?,updated_at=datetime('now','+8 hours') WHERE id=?`
    ).run(message, nowCN(Math.max(15, row.attempts * 30) * 1000), row.id);
  } else {
    db.prepare(
      `UPDATE legalrag_files SET sync_status='failed',last_error=?,
         updated_at=datetime('now','+8 hours') WHERE id=?`
    ).run(message, row.id);
  }
}

function validCandidate(candidate) {
  const p = candidate.payload || {};
  if (candidate.evidence_relation !== 'direct') return false;
  if (Number(candidate.confidence) < DOCUMENT_MIN_CONFIDENCE) return false;
  if (!candidate.source_quote) return false;
  if (candidate.kind === 'fee') {
    return !!String(p.label || '').trim() && (!p.due_on || isDate(String(p.due_on)));
  }
  if (candidate.kind === 'event') {
    return isEventType(p.type) && isDate(String(p.occurred_on || ''));
  }
  return false;
}

function extractionCaseContext(caseId) {
  return db.prepare(
    `SELECT name,case_no,cause,court,client,opponent,procedure
       FROM cases WHERE id=?`
  ).get(caseId) || {};
}

function supersedePriorPendingSources(fileId, extractionId) {
  return db.prepare(
    `UPDATE legalrag_candidates
        SET status='superseded',decided_at=datetime('now','+8 hours')
      WHERE file_id=? AND extraction_id<>? AND status='pending'`
  ).run(fileId, extractionId).changes;
}

function pendingFactCount(fileId) {
  return db.prepare(
    `SELECT COUNT(DISTINCT c.fact_id) AS c
       FROM legalrag_candidates c
       JOIN legalrag_candidate_facts f ON f.id=c.fact_id
      WHERE c.file_id=? AND c.status='pending' AND f.status='pending'`
  ).get(fileId).c;
}

async function extractReadyFile(fileId) {
  const file = db.prepare('SELECT * FROM legalrag_files WHERE id=?').get(fileId);
  if (!file?.legalrag_document_id) return;
  const existing = db.prepare(
    'SELECT * FROM legalrag_extractions WHERE file_id=? AND extractor=? AND schema_version=?'
  ).get(file.id, DOCUMENT_EXTRACTOR, DOCUMENT_SCHEMA_VERSION);
  if (existing?.status === 'done') {
    withImmediateTransaction(() => {
      supersedePriorPendingSources(file.id, existing.id);
      const pending = pendingFactCount(file.id);
      db.prepare("UPDATE legalrag_files SET sync_status=?,updated_at=datetime('now','+8 hours') WHERE id=?")
        .run(pending ? 'review' : 'ready', file.id);
    });
    return;
  }
  if (!documentExtractorReady()) {
    const pending = pendingFactCount(file.id);
    db.prepare(
      `UPDATE legalrag_files SET sync_status=?,last_error='未配置文书提取模型',
         updated_at=datetime('now','+8 hours') WHERE id=?`
    ).run(pending ? 'review' : 'ready', file.id);
    return;
  }

  let extractionId = existing?.id;
  if (existing) {
    db.prepare(
      `UPDATE legalrag_extractions SET status='processing',last_error='',raw_json='',finished_at='' WHERE id=?`
    ).run(existing.id);
  } else {
    extractionId = db.prepare(
      `INSERT INTO legalrag_extractions (file_id,extractor,schema_version,model)
       VALUES (?,?,?,?)`
    ).run(file.id, DOCUMENT_EXTRACTOR, DOCUMENT_SCHEMA_VERSION, DOCUMENT_MODEL).lastInsertRowid;
  }
  db.prepare("UPDATE legalrag_files SET sync_status='extracting',last_error='',updated_at=datetime('now','+8 hours') WHERE id=?")
    .run(file.id);

  try {
    const document = await bridgeFetch(`/api/v1/integrations/documents/${encodeURIComponent(file.legalrag_document_id)}`);
    if (document.ocr_status !== 'done' || !document.ocr_text) throw new Error('LegalRAG 正文尚未就绪');
    const result = await extractDocument({
      fileName: document.file_name,
      relativePath: file.rel_path,
      caseContext: extractionCaseContext(file.case_id),
      text: document.ocr_text,
    });
    const candidates = result.candidates.filter(validCandidate);
    let pendingCount = 0;
    withImmediateTransaction(() => {
      // v2 的本案归属闸门成功后，以本次结果替换旧 extractor 的未裁决来源。
      // 人工 accepted/declined 仍是事实层记忆，绝不由重筛覆盖。
      supersedePriorPendingSources(file.id, extractionId);
      // 失败重试只清未裁决/过时证据；accepted/declined 是跨版本人工记忆，绝不能删除。
      db.prepare(
        "DELETE FROM legalrag_candidates WHERE extraction_id=? AND status IN ('pending','superseded')"
      ).run(extractionId);
      const insert = db.prepare(
        `INSERT OR IGNORE INTO legalrag_candidates
          (extraction_id,file_id,case_id,kind,payload,confidence,source_page,source_quote,
           fact_id,status,accepted_entity,accepted_entity_id,decided_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const candidate of candidates) {
        const fact = ensureCandidateFact(file.case_id, candidate.kind, candidate.payload);
        const inherited = fact.status;
        insert.run(
          extractionId, file.id, file.case_id, candidate.kind, JSON.stringify(candidate.payload),
          candidate.confidence, candidate.source_page, candidate.source_quote, fact.id, inherited,
          inherited === 'accepted' ? fact.accepted_entity : '',
          inherited === 'accepted' ? fact.accepted_entity_id : null,
          inherited === 'pending' ? '' : nowCN()
        );
      }
      pendingCount = pendingFactCount(file.id);
      db.prepare(
        `UPDATE legalrag_extractions SET status='done',document_type=?,raw_json=?,last_error='',
           finished_at=datetime('now','+8 hours') WHERE id=?`
      ).run(result.document_type, JSON.stringify(result), extractionId);
      db.prepare(
        `UPDATE legalrag_files SET sync_status=?,last_error='',updated_at=datetime('now','+8 hours') WHERE id=?`
      ).run(pendingCount ? 'review' : 'ready', file.id);
    });
    audit('system', 'legalrag-extract', 'file', file.id,
      `${file.rel_path} → ${result.document_role}/${result.case_relation}/${result.evidence_mode}; ` +
      `${candidates.length} sources / ${pendingCount} pending facts`);
  } catch (error) {
    db.prepare(
      `UPDATE legalrag_extractions SET status='failed',last_error=?,finished_at=datetime('now','+8 hours') WHERE id=?`
    ).run(String(error.message || error).slice(0, 1000), extractionId);
    db.prepare(
      `UPDATE legalrag_files SET sync_status='failed',last_error=?,updated_at=datetime('now','+8 hours') WHERE id=?`
    ).run(String(error.message || error).slice(0, 1000), file.id);
  }
}

async function pollProcessing() {
  const rows = db.prepare(
    "SELECT * FROM legalrag_files WHERE sync_status='processing' AND legalrag_job_id!='' ORDER BY id LIMIT 8"
  ).all();
  for (const row of rows) {
    try {
      const job = await bridgeFetch(`/api/v1/integrations/jobs/${encodeURIComponent(row.legalrag_job_id)}`);
      if (job.status === 'done') {
        db.prepare(
          `UPDATE legalrag_files SET sync_status='ready',legalrag_document_id=COALESCE(NULLIF(?,''),legalrag_document_id),
             last_error='',updated_at=datetime('now','+8 hours') WHERE id=?`
        ).run(job.document_id || '', row.id);
        await extractReadyFile(row.id);
      } else if (job.status === 'failed') {
        retryOrFail(row, new Error(job.error || 'LegalRAG 解析失败'));
      }
    } catch (error) {
      db.prepare(
        "UPDATE legalrag_files SET last_error=?,updated_at=datetime('now','+8 hours') WHERE id=?"
      ).run(String(error.message || error).slice(0, 1000), row.id);
    }
  }
}

async function registerNext() {
  const row = db.prepare(
    `SELECT f.*,COALESCE(NULLIF(TRIM(c.folder_path),''),c.name) AS case_name
       FROM legalrag_files f JOIN cases c ON c.id=f.case_id
      WHERE f.sync_status='queued' AND (f.next_attempt_at='' OR f.next_attempt_at<=?)
      ORDER BY f.priority DESC,f.id LIMIT 1`
  ).get(nowCN());
  if (!row) return;
  db.prepare(
    `UPDATE legalrag_files SET sync_status='registering',attempts=attempts+1,
       last_error='',updated_at=datetime('now','+8 hours') WHERE id=?`
  ).run(row.id);
  const current = db.prepare('SELECT * FROM legalrag_files WHERE id=?').get(row.id);
  try {
    const response = await bridgeFetch('/api/v1/integrations/documents/register', {
      method: 'POST', timeout: REGISTER_TIMEOUT,
      body: {
        case_name: row.case_name,
        relative_path: row.rel_path,
        request_id: `anjian-file-${row.id}-r${row.revision}-a${current.attempts}`,
        force: false,
      },
    });
    const job = response.job || null;
    const documentId = response.document_id || job?.document_id || '';
    const externalCaseId = response.case_id || '';
    updateCaseLink(row.id, externalCaseId);
    db.prepare(
      `UPDATE legalrag_files SET legalrag_case_id=?,legalrag_document_id=?,legalrag_job_id=?,
         content_checksum=?,sync_status=?,last_error='',next_attempt_at='',
         updated_at=datetime('now','+8 hours') WHERE id=?`
    ).run(
      externalCaseId, documentId, job?.job_id || '', response.checksum || '',
      response.status === 'ready' ? 'ready' : 'processing', row.id
    );
    if (response.status === 'ready') await extractReadyFile(row.id);
  } catch (error) {
    retryOrFail(current, error);
    updateCaseLink(row.id, '', String(error.message || error).slice(0, 1000));
  }
}

async function extractOneReady() {
  const row = db.prepare(
    `SELECT f.id FROM legalrag_files f
      LEFT JOIN legalrag_extractions e
        ON e.file_id=f.id AND e.extractor=? AND e.schema_version=?
     WHERE f.sync_status IN ('ready','review') AND f.legalrag_document_id!=''
       AND (
         e.status='failed'
         OR (e.id IS NULL AND EXISTS (
           SELECT 1 FROM legalrag_candidates c
             JOIN legalrag_candidate_facts fact ON fact.id=c.fact_id
            WHERE c.file_id=f.id AND c.status='pending' AND fact.status='pending'
         ))
       )
     ORDER BY f.priority DESC,f.id LIMIT 1`
  ).get(DOCUMENT_EXTRACTOR, DOCUMENT_SCHEMA_VERSION);
  if (row) await extractReadyFile(row.id);
}

export async function processLegalRagBridgeTick() {
  if (!legalRagBridgeConfigured() || tickRunning) return;
  tickRunning = true;
  try {
    await pollProcessing();
    await extractOneReady();
    await registerNext();
  } finally {
    tickRunning = false;
  }
}

export function kickLegalRagBridge() {
  if (!legalRagBridgeConfigured()) return;
  const timer = setTimeout(() => processLegalRagBridgeTick().catch((error) => console.error('legalrag bridge tick', error)), 0);
  timer.unref?.();
}

export function startLegalRagBridge() {
  if (started || !legalRagBridgeConfigured()) return false;
  started = true;
  db.prepare("UPDATE legalrag_files SET sync_status='queued' WHERE sync_status='registering'").run();
  db.prepare("UPDATE legalrag_files SET sync_status='ready' WHERE sync_status='extracting'").run();
  db.prepare("UPDATE legalrag_extractions SET status='failed',last_error='服务重启，等待重试' WHERE status='processing'").run();

  const boot = setTimeout(() => {
    try { reconcileLegalRagFiles(); } catch (error) { console.error('legalrag reconcile', error); }
    kickLegalRagBridge();
  }, 5000);
  boot.unref?.();

  const tick = setInterval(() => processLegalRagBridgeTick().catch((error) => console.error('legalrag bridge tick', error)),
    Number(process.env.LEGALRAG_TICK_MS || DEFAULT_TICK_MS));
  tick.unref?.();
  const reconcile = setInterval(() => {
    try { reconcileLegalRagFiles(); } catch (error) { console.error('legalrag reconcile', error); }
  }, Number(process.env.LEGALRAG_RECONCILE_MS || DEFAULT_RECONCILE_MS));
  reconcile.unref?.();
  return true;
}

export function legalRagStateMap(caseId) {
  const rows = db.prepare(
    `SELECT f.*,
       COALESCE(e.document_type,'') AS document_type,
       CASE WHEN json_valid(e.raw_json) THEN COALESCE(json_extract(e.raw_json,'$.case_relation'),'') ELSE '' END AS case_relation,
       CASE WHEN json_valid(e.raw_json) THEN COALESCE(json_extract(e.raw_json,'$.evidence_mode'),'') ELSE '' END AS evidence_mode,
       CASE WHEN json_valid(e.raw_json) THEN COALESCE(json_extract(e.raw_json,'$.screening_decision'),'') ELSE '' END AS screening_decision,
       CASE WHEN json_valid(e.raw_json) THEN COALESCE(json_extract(e.raw_json,'$.screening_reason'),'') ELSE '' END AS screening_reason,
       (SELECT COUNT(DISTINCT c.fact_id)
          FROM legalrag_candidates c
          JOIN legalrag_candidate_facts fact ON fact.id=c.fact_id
         WHERE c.file_id=f.id AND c.status='pending' AND fact.status='pending') AS candidate_count
     FROM legalrag_files f
     LEFT JOIN legalrag_extractions e ON e.id=(
       SELECT x.id FROM legalrag_extractions x
        WHERE x.file_id=f.id AND x.status='done' AND x.extractor LIKE 'legalrag-contextual-%'
        ORDER BY x.schema_version DESC,x.id DESC LIMIT 1
     )
     WHERE f.case_id=? AND f.revision=(
       SELECT MAX(x.revision) FROM legalrag_files x WHERE x.case_id=f.case_id AND x.rel_path=f.rel_path
     )`
  ).all(caseId);
  return new Map(rows.map((row) => [row.rel_path, row]));
}

export function pendingLegalRagCandidates(caseId) {
  const rows = db.prepare(
    `SELECT c.*,f.rel_path,f.filename,e.document_type,e.model,fact.canonical_payload
       FROM legalrag_candidates c
       JOIN legalrag_candidate_facts fact ON fact.id=c.fact_id
       JOIN legalrag_files f ON f.id=c.file_id
       JOIN legalrag_extractions e ON e.id=c.extraction_id
      WHERE c.case_id=? AND c.status='pending' AND fact.status='pending'
        AND f.revision=(
          SELECT MAX(x.revision) FROM legalrag_files x
           WHERE x.case_id=f.case_id AND x.rel_path=f.rel_path
        )
      ORDER BY f.rel_path,c.id`
  ).all(caseId);
  const grouped = new Map();
  for (const row of rows) {
    const list = grouped.get(row.fact_id) || [];
    list.push(row);
    grouped.set(row.fact_id, list);
  }
  return [...grouped.values()].map((sources) => {
    const representative = [...sources].sort(
      (a, b) => Number(b.confidence) - Number(a.confidence) || b.id - a.id
    )[0];
    return {
      ...representative,
      source_count: sources.length,
      file_count: new Set(sources.map((source) => source.file_id)).size,
      sources: sources.map((source) => ({
        id: source.id,
        file_id: source.file_id,
        rel_path: source.rel_path,
        filename: source.filename,
        source_page: source.source_page,
        source_quote: source.source_quote,
        confidence: source.confidence,
        payload: source.payload,
        model: source.model,
      })),
    };
  });
}

export function declinedLegalRagCandidateFacts(caseId) {
  const rows = db.prepare(
    `SELECT c.*,f.rel_path,f.filename,f.revision,e.document_type,e.model,
            fact.canonical_payload,fact.decision_reason,
            f.revision=(
              SELECT MAX(x.revision) FROM legalrag_files x
               WHERE x.case_id=f.case_id AND x.rel_path=f.rel_path
            ) AS is_current
       FROM legalrag_candidates c
       JOIN legalrag_candidate_facts fact ON fact.id=c.fact_id
       JOIN legalrag_files f ON f.id=c.file_id
       JOIN legalrag_extractions e ON e.id=c.extraction_id
      WHERE c.case_id=? AND c.status='declined' AND fact.status='declined'
      ORDER BY fact.id,f.rel_path,c.id`
  ).all(caseId);
  const grouped = new Map();
  for (const row of rows) {
    const list = grouped.get(row.fact_id) || [];
    list.push(row);
    grouped.set(row.fact_id, list);
  }
  return [...grouped.values()].map((allSources) => {
    const current = allSources.filter((source) => source.is_current);
    const sources = current.length ? current : allSources;
    const representative = [...sources].sort(
      (a, b) => Number(b.confidence) - Number(a.confidence) || b.id - a.id
    )[0];
    return {
      ...representative,
      payload: representative.canonical_payload || representative.payload,
      source_count: sources.length,
      file_count: new Set(sources.map((source) => source.file_id)).size,
      sources: sources.map((source) => ({
        id: source.id,
        file_id: source.file_id,
        rel_path: source.rel_path,
        filename: source.filename,
        source_page: source.source_page,
        source_quote: source.source_quote,
        confidence: source.confidence,
        payload: source.payload,
        model: source.model,
      })),
    };
  });
}
