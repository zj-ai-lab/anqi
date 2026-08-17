import { Router } from 'express';
import { db, audit, withImmediateTransaction } from '../db.js';
import { isDate } from '../lib/dates.js';
import { deriveForEvent } from '../lib/engine.js';
import {
  declinedLegalRagCandidateFacts,
  kickLegalRagBridge,
  legalRagBridgeConfigured,
  pendingLegalRagCandidates,
  queueCaseFile,
  reconcileLegalRagFiles,
} from '../lib/legalrag-bridge.js';
import { fenToYuan, parseMoneyToFen } from '../lib/settlement.js';
import { isEventType } from '../lib/vocab.js';
import {
  candidateFactKey,
  linkPendingFeeFact,
  matchExistingFeeItems,
  mergeFactForAcceptedPayload,
  refreshLegalRagFileStates,
} from '../lib/candidate-facts.js';

const r = Router();

function mustCase(id, res) {
  const row = db.prepare('SELECT * FROM cases WHERE id=?').get(id);
  if (!row) res.status(404).json({ error: '案件不存在' });
  return row;
}

function candidateRow(id, res) {
  const row = db.prepare(
    `SELECT c.*,f.rel_path,f.filename,e.document_type,
            fact.status AS fact_status,fact.fact_key,fact.canonical_payload
       FROM legalrag_candidates c
       LEFT JOIN legalrag_candidate_facts fact ON fact.id=c.fact_id
       JOIN legalrag_files f ON f.id=c.file_id
       JOIN legalrag_extractions e ON e.id=c.extraction_id
      WHERE c.id=?`
  ).get(id);
  if (!row) res.status(404).json({ error: '提取候选不存在' });
  return row;
}

function sourceRef(row) {
  return `${row.rel_path}${row.source_page ? `#第${row.source_page}页` : ''}`;
}

function moneyInput(value) {
  if (value === null || value === undefined || value === '') return { amount: null, amount_fen: null };
  const amountFen = parseMoneyToFen(value);
  return { amount: fenToYuan(amountFen), amount_fen: amountFen };
}

function feeMatchView(caseId, payload) {
  const match = matchExistingFeeItems(caseId, payload);
  return {
    state: match.state,
    matches: match.matches.map((fee) => ({
      id: fee.id,
      label: fee.label,
      amount: fee.amount,
      node: fee.node,
      due_on: fee.due_on,
      status: fee.status,
      paid_on: fee.paid_on,
    })),
  };
}

function matchingEvent(caseId, payload) {
  const wanted = candidateFactKey('event', payload);
  return db.prepare(
    'SELECT * FROM events WHERE case_id=? AND type=? AND occurred_on=? ORDER BY id'
  ).all(caseId, payload.type, payload.occurred_on).find((event) =>
    candidateFactKey('event', event) === wanted
  );
}

r.get('/cases/:id/legalrag/status', (req, res) => {
  const c = mustCase(req.params.id, res);
  if (!c) return;
  const link = db.prepare('SELECT * FROM legalrag_case_links WHERE case_id=?').get(c.id) || null;
  const counts = db.prepare(
    `SELECT
       COUNT(*) AS files,
       SUM(sync_status IN ('queued','registering','processing','extracting')) AS processing,
       SUM(sync_status='review') AS review,
       SUM(sync_status='failed') AS failed
     FROM legalrag_files f WHERE case_id=? AND revision=(
       SELECT MAX(x.revision) FROM legalrag_files x
        WHERE x.case_id=f.case_id AND x.rel_path=f.rel_path
     )`
  ).get(c.id);
  res.json({ configured: legalRagBridgeConfigured(), link, counts });
});

r.post('/cases/:id/files/process', (req, res) => {
  const c = mustCase(req.params.id, res);
  if (!c) return;
  if (!legalRagBridgeConfigured()) {
    return res.status(503).json({ error: 'LegalRAG 文件桥尚未配置', code: 'legalrag_bridge_unconfigured' });
  }
  try {
    const row = queueCaseFile(c.id, req.body?.rel_path, {
      priority: 100,
      force: true,
      actor: req.actor,
    });
    res.json({ ok: true, file: row });
  } catch (error) {
    res.status(400).json({ error: error.message, code: 'legalrag_file_invalid' });
  }
});

r.post('/cases/:id/legalrag/reconcile', (req, res) => {
  const c = mustCase(req.params.id, res);
  if (!c) return;
  if (!legalRagBridgeConfigured()) {
    return res.status(503).json({ error: 'LegalRAG 文件桥尚未配置', code: 'legalrag_bridge_unconfigured' });
  }
  const result = reconcileLegalRagFiles();
  kickLegalRagBridge();
  audit(req.actor, 'legalrag-reconcile', 'case', c.id, JSON.stringify(result));
  res.json(result);
});

r.get('/cases/:id/legalrag/candidates', (req, res) => {
  const c = mustCase(req.params.id, res);
  if (!c) return;
  const rows = req.query.status === 'declined'
    ? declinedLegalRagCandidateFacts(c.id)
    : pendingLegalRagCandidates(c.id);
  res.json(rows.map((row) => {
    const payload = JSON.parse(row.payload);
    return {
      ...row,
      payload,
      formal_fee_match: row.kind === 'fee' ? feeMatchView(row.case_id, payload) : undefined,
      source_ref: sourceRef(row),
      sources: (row.sources || []).map((source) => ({
        ...source,
        payload: JSON.parse(source.payload),
        source_ref: sourceRef(source),
      })),
    };
  }));
});

r.post('/legalrag/candidates/:id/accept', (req, res) => {
  const row = candidateRow(req.params.id, res);
  if (!row) return;
  if (row.status !== 'pending' || row.fact_status !== 'pending') return res.status(409).json({ error: '该候选已经裁决' });
  let stored;
  try { stored = JSON.parse(row.payload); } catch { return res.status(400).json({ error: '候选 payload 损坏' }); }
  const payload = { ...stored, ...(req.body?.payload || {}) };

  try {
    const result = withImmediateTransaction(() => {
      const fresh = db.prepare(
        `SELECT c.status,f.status AS fact_status FROM legalrag_candidates c
          JOIN legalrag_candidate_facts f ON f.id=c.fact_id WHERE c.id=?`
      ).get(row.id);
      if (fresh?.status !== 'pending' || fresh.fact_status !== 'pending') {
        const error = new Error('该候选已经裁决或已被新版本取代');
        error.code = 'candidate_decided';
        throw error;
      }
      let entity;
      let entityId;
      let linkedExisting = false;
      let resolution;
      let normalizedPayload;
      let feeLinkResult = null;

      if (row.kind === 'fee') {
        const label = String(payload.label || '').trim();
        const node = String(payload.node || '').trim();
        const dueOn = String(payload.due_on || '');
        if (!label) throw new Error('收费节点名称不能为空');
        if (dueOn && !isDate(dueOn)) throw new Error('收费节点日期非法');
        const money = moneyInput(payload.amount);
        normalizedPayload = { ...payload, label, node, due_on: dueOn, amount: money.amount };
        resolution = mergeFactForAcceptedPayload(row.fact_id, row.kind, normalizedPayload);
        entity = 'fee';
        if (resolution.fact.status === 'accepted') {
          entityId = resolution.fact.accepted_entity_id;
          linkedExisting = true;
        } else {
          const match = matchExistingFeeItems(row.case_id, normalizedPayload);
          if (match.state === 'ambiguous') {
            const error = new Error('存在多笔完全相同的正式收费，请明确选择要关联的记录');
            error.code = 'fee_exact_match_ambiguous';
            error.matches = feeMatchView(row.case_id, normalizedPayload).matches;
            throw error;
          }
          if (match.state === 'unique') {
            entityId = match.matches[0].id;
            linkedExisting = true;
          } else {
            const note = [String(payload.note || '').trim(), `来源：${sourceRef(row)}`].filter(Boolean).join('；');
            entityId = db.prepare(
              `INSERT INTO fee_items (case_id,label,amount,amount_fen,node,due_on,note)
               VALUES (?,?,?,?,?,?,?)`
            ).run(row.case_id, label, money.amount, money.amount_fen, node, dueOn, note).lastInsertRowid;
            audit(req.actor, 'create', 'fee', entityId, `文书候选：${label}`);
          }
          feeLinkResult = linkPendingFeeFact(resolution.fact.id, entityId, {
            actor: req.actor,
            mode: linkedExisting ? 'exact-on-accept' : 'accept-new',
            canonicalPayload: normalizedPayload,
          });
        }
      } else if (row.kind === 'event') {
        const type = String(payload.type || '');
        const occurredOn = String(payload.occurred_on || '');
        if (!isEventType(type)) throw new Error('程序事件类型非法');
        if (!isDate(occurredOn)) throw new Error('程序事件日期非法');
        normalizedPayload = {
          ...payload,
          type,
          occurred_on: occurredOn,
          service_method: String(payload.service_method || ''),
          instrument: String(payload.instrument || ''),
        };
        resolution = mergeFactForAcceptedPayload(row.fact_id, row.kind, normalizedPayload);
        entity = 'event';
        if (resolution.fact.status === 'accepted') {
          entityId = resolution.fact.accepted_entity_id;
          linkedExisting = true;
        } else {
          const existing = matchingEvent(row.case_id, normalizedPayload);
          if (existing) {
            entityId = existing.id;
            linkedExisting = true;
          } else {
            entityId = db.prepare(
              `INSERT INTO events
                (case_id,type,occurred_on,service_method,instrument,note,created_by)
               VALUES (?,?,?,?,?,?,'llm')`
            ).run(
              row.case_id, type, occurredOn, normalizedPayload.service_method,
              normalizedPayload.instrument,
              [String(payload.note || '').trim(), `来源：${sourceRef(row)}`].filter(Boolean).join('；')
            ).lastInsertRowid;
            const event = db.prepare('SELECT * FROM events WHERE id=?').get(entityId);
            const caseRow = db.prepare('SELECT * FROM cases WHERE id=?').get(row.case_id);
            deriveForEvent(event, caseRow, req.actor);
            audit(req.actor, 'create', 'event', entityId, `文书候选：${type} ${occurredOn}`);
          }
        }
      } else {
        throw new Error('该候选类型不允许写入正式表');
      }

      const factId = resolution.fact.id;
      const sourceRows = feeLinkResult ? [] : db.prepare(
        "SELECT id,file_id FROM legalrag_candidates WHERE fact_id=? AND status='pending'"
      ).all(factId);
      if (!feeLinkResult) {
        if (resolution.fact.status === 'pending') {
          const decided = db.prepare(
            `UPDATE legalrag_candidate_facts
                SET status='accepted',canonical_payload=?,accepted_entity=?,accepted_entity_id=?,
                    decision_reason='',decided_at=datetime('now','+8 hours'),updated_at=datetime('now','+8 hours')
              WHERE id=? AND status='pending'`
          ).run(JSON.stringify(normalizedPayload), entity, entityId, factId);
          if (decided.changes !== 1) {
            const error = new Error('该逻辑事实已经裁决');
            error.code = 'candidate_decided';
            throw error;
          }
        }
        db.prepare(
          `UPDATE legalrag_candidates SET status='accepted',accepted_entity=?,accepted_entity_id=?,
             decided_at=datetime('now','+8 hours') WHERE fact_id=? AND status='pending'`
        ).run(entity, entityId, factId);
        refreshLegalRagFileStates(sourceRows.map((source) => source.file_id));
      }
      const sourceCount = feeLinkResult?.source_count ?? sourceRows.length;
      audit(req.actor, linkedExisting ? 'legalrag-link-existing' : 'legalrag-accept', entity, entityId,
        `${sourceRef(row)}（${sourceCount} 份来源）`);
      return { entity, id: entityId, fact_id: factId, linked_existing: linkedExisting, source_count: sourceCount };
    });
    res.json({ ok: true, created: result });
  } catch (error) {
    const status = ['candidate_decided', 'fee_exact_match_ambiguous'].includes(error.code) ? 409 : 400;
    res.status(status).json({
      error: error.message,
      code: error.code || 'legalrag_candidate_invalid',
      ...(error.matches ? { matches: error.matches } : {}),
    });
  }
});

r.post('/legalrag/candidates/:id/link-fee', (req, res) => {
  const row = candidateRow(req.params.id, res);
  if (!row) return;
  if (row.kind !== 'fee') return res.status(400).json({ error: '只有收费候选可以关联收费记录' });
  if (row.status !== 'pending' || row.fact_status !== 'pending') {
    return res.status(409).json({ error: '该候选已经裁决', code: 'candidate_decided' });
  }
  const feeItemId = Number(req.body?.fee_item_id);
  if (!Number.isInteger(feeItemId) || feeItemId <= 0) {
    return res.status(400).json({ error: 'fee_item_id 非法', code: 'fee_id_invalid' });
  }
  try {
    const linked = withImmediateTransaction(() => {
      const fresh = db.prepare(
        `SELECT c.status,f.status AS fact_status FROM legalrag_candidates c
          JOIN legalrag_candidate_facts f ON f.id=c.fact_id WHERE c.id=?`
      ).get(row.id);
      if (fresh?.status !== 'pending' || fresh.fact_status !== 'pending') {
        const error = new Error('该候选已经裁决或已被新版本取代');
        error.code = 'candidate_decided';
        throw error;
      }
      return linkPendingFeeFact(row.fact_id, feeItemId, {
        actor: req.actor,
        mode: 'explicit',
        auditAction: 'legalrag-link-explicit',
        auditDetail: `${sourceRef(row)} → fee #${feeItemId}`,
      });
    });
    res.json({
      ok: true,
      linked: {
        entity: 'fee',
        id: linked.fee.id,
        fact_id: linked.fact.id,
        source_count: linked.source_count,
        link_mode: 'explicit',
      },
    });
  } catch (error) {
    const status = error.code === 'candidate_decided' ? 409 : 400;
    res.status(status).json({ error: error.message, code: error.code || 'legalrag_candidate_invalid' });
  }
});

r.post('/legalrag/candidates/:id/decline', (req, res) => {
  const row = candidateRow(req.params.id, res);
  if (!row) return;
  if (row.status !== 'pending' || row.fact_status !== 'pending') return res.status(409).json({ error: '该候选已经裁决' });
  const reason = String(req.body?.reason || '当前材料不应录入该事实').trim().slice(0, 300);
  try {
    withImmediateTransaction(() => {
      const fresh = db.prepare(
        `SELECT c.status,f.status AS fact_status FROM legalrag_candidates c
          JOIN legalrag_candidate_facts f ON f.id=c.fact_id WHERE c.id=?`
      ).get(row.id);
      if (fresh?.status !== 'pending' || fresh.fact_status !== 'pending') {
        const error = new Error('该候选已经裁决或已被新版本取代');
        error.code = 'candidate_decided';
        throw error;
      }
      const sourceRows = db.prepare(
        "SELECT id,file_id FROM legalrag_candidates WHERE fact_id=? AND status='pending'"
      ).all(row.fact_id);
      db.prepare(
        `UPDATE legalrag_candidate_facts
            SET status='declined',accepted_entity='',accepted_entity_id=NULL,
                decision_reason=?,
                decided_at=datetime('now','+8 hours'),updated_at=datetime('now','+8 hours')
          WHERE id=? AND status='pending'`
      ).run(reason, row.fact_id);
      db.prepare(
        "UPDATE legalrag_candidates SET status='declined',decided_at=datetime('now','+8 hours') WHERE fact_id=? AND status='pending'"
      ).run(row.fact_id);
      refreshLegalRagFileStates(sourceRows.map((source) => source.file_id));
      audit(req.actor, 'legalrag-decline', 'candidate-fact', row.fact_id,
        `${sourceRef(row)}（${sourceRows.length} 份来源）`);
    });
    res.json({ ok: true });
  } catch (error) {
    const status = ['candidate_decided', 'fee_exact_match_ambiguous'].includes(error.code) ? 409 : 400;
    res.status(status).json({
      error: error.message,
      code: error.code || 'legalrag_candidate_invalid',
      ...(error.matches ? { matches: error.matches } : {}),
    });
  }
});

r.post('/legalrag/candidate-facts/:id/reopen', (req, res) => {
  const fact = db.prepare('SELECT * FROM legalrag_candidate_facts WHERE id=?').get(req.params.id);
  if (!fact) return res.status(404).json({ error: '逻辑事实不存在' });
  if (fact.status !== 'declined') return res.status(409).json({ error: '只有已忽略事实可以恢复待确认' });
  try {
    const result = withImmediateTransaction(() => {
      const fresh = db.prepare('SELECT status FROM legalrag_candidate_facts WHERE id=?').get(fact.id);
      if (fresh?.status !== 'declined') {
        const error = new Error('该逻辑事实状态已经变化');
        error.code = 'candidate_decided';
        throw error;
      }
      const currentSources = db.prepare(
        `SELECT c.id,c.file_id FROM legalrag_candidates c
          JOIN legalrag_files f ON f.id=c.file_id
         WHERE c.fact_id=? AND c.status='declined'
           AND f.revision=(
             SELECT MAX(x.revision) FROM legalrag_files x
              WHERE x.case_id=f.case_id AND x.rel_path=f.rel_path
           )`
      ).all(fact.id);
      const reopened = db.prepare(
        `UPDATE legalrag_candidate_facts
            SET status='pending',accepted_entity='',accepted_entity_id=NULL,
                decision_reason='',decided_at='',updated_at=datetime('now','+8 hours')
          WHERE id=? AND status='declined'`
      ).run(fact.id);
      if (reopened.changes !== 1) {
        const error = new Error('该逻辑事实状态已经变化');
        error.code = 'candidate_decided';
        throw error;
      }
      const reopenSource = db.prepare(
        `UPDATE legalrag_candidates
            SET status='pending',accepted_entity='',accepted_entity_id=NULL,decided_at=''
          WHERE id=? AND status='declined'`
      );
      for (const source of currentSources) reopenSource.run(source.id);
      refreshLegalRagFileStates(currentSources.map((source) => source.file_id));
      audit(req.actor, 'legalrag-reopen', 'candidate-fact', fact.id,
        `${currentSources.length} current sources`);
      return { fact_id: fact.id, source_count: currentSources.length };
    });
    res.json({ ok: true, reopened: result });
  } catch (error) {
    const status = ['candidate_decided', 'fee_exact_match_ambiguous'].includes(error.code) ? 409 : 400;
    res.status(status).json({
      error: error.message,
      code: error.code || 'legalrag_candidate_invalid',
      ...(error.matches ? { matches: error.matches } : {}),
    });
  }
});

export default r;
