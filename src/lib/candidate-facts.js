// LegalRAG 逻辑事实层：fact 记跨文件裁决，candidate 逐份保存来源证据与 revision 生命周期。
import crypto from 'node:crypto';
import { db, audit, withImmediateTransaction } from '../db.js';
import { fenToYuanString, parseMoneyToFen } from './settlement.js';

function normalizedText(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

function amountKey(value) {
  if (value === null || value === undefined || value === '') return null;
  try { return parseMoneyToFen(value); } catch { return `invalid:${normalizedText(value)}`; }
}

const REPEATABLE_EVENT_TYPES = new Set([
  'hearing', 'summons', 'fee_notice', 'ruling_served', 'preservation_order', 'other',
]);

export function candidateFactKey(kind, payload) {
  let identity;
  if (kind === 'event') {
    const type = normalizedText(payload?.type);
    // 一锤定音型事件仍以 type+date 跨文档汇合；只有同日可重复类型才加入文书 hint。
    // service_method 是来源描述而非事件身份，不能让判决书与送达回执分裂成两张卡。
    identity = [
      'event',
      type,
      String(payload?.occurred_on || ''),
      REPEATABLE_EVENT_TYPES.has(type)
        ? normalizedText(payload?.instrument || payload?.note)
        : '',
    ];
  } else if (kind === 'fee') {
    const dueOn = String(payload?.due_on || '');
    // 有明确日期时日期足够稳定；只有 due_on 为空才用 node 区分分期付款条件。
    identity = [
      'fee',
      normalizedText(payload?.label),
      amountKey(payload?.amount),
      dueOn,
      dueOn ? '' : normalizedText(payload?.node),
    ];
  } else {
    throw new Error(`候选 kind 非法：${kind}`);
  }
  return `v2:${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

export function matchExistingFeeItems(caseId, payload) {
  const factKey = candidateFactKey('fee', payload);
  const matches = db.prepare('SELECT * FROM fee_items WHERE case_id=? ORDER BY id').all(caseId)
    .filter((item) => candidateFactKey('fee', {
      ...item,
      // 正式表以整数分为权威；REAL amount 只是展示投影，极值会丢 1 分精度。
      amount: item.amount_fen == null ? null : fenToYuanString(item.amount_fen),
    }) === factKey);
  return {
    state: matches.length === 0 ? 'zero' : matches.length === 1 ? 'unique' : 'ambiguous',
    fact_key: factKey,
    matches,
  };
}

function entityExists(entity, id, caseId) {
  if (!id) return false;
  if (entity === 'fee') return !!db.prepare('SELECT 1 FROM fee_items WHERE id=? AND case_id=?').get(id, caseId);
  if (entity === 'event') return !!db.prepare('SELECT 1 FROM events WHERE id=? AND case_id=?').get(id, caseId);
  return false;
}

function linkError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function linkPendingFeeFact(factId, feeItemId, {
  actor = '',
  mode = 'explicit',
  canonicalPayload,
  auditAction = '',
  auditDetail = '',
} = {}) {
  return withImmediateTransaction(() => {
    const fact = db.prepare('SELECT * FROM legalrag_candidate_facts WHERE id=?').get(factId);
    if (!fact) throw linkError('逻辑事实不存在', 'candidate_fact_not_found');
    if (fact.kind !== 'fee') throw linkError('只有收费候选可以关联收费记录', 'candidate_kind_invalid');
    if (fact.status !== 'pending') throw linkError('该逻辑事实已经裁决', 'candidate_decided');
    const fee = db.prepare('SELECT * FROM fee_items WHERE id=?').get(feeItemId);
    if (!fee) throw linkError('收费记录不存在', 'fee_not_found');
    if (fee.case_id !== fact.case_id) throw linkError('不能关联其他案件的收费记录', 'fee_case_mismatch');

    const sources = db.prepare(
      "SELECT id,file_id FROM legalrag_candidates WHERE fact_id=? AND status='pending'"
    ).all(fact.id);
    const reason = mode === 'exact-auto'
      ? '系统按 strict key 唯一关联既有收费'
      : mode === 'explicit'
        ? '人工关联既有收费'
        : '';
    const canonical = canonicalPayload === undefined
      ? fact.canonical_payload
      : JSON.stringify(canonicalPayload || {});
    const decided = db.prepare(
      `UPDATE legalrag_candidate_facts
          SET status='accepted',canonical_payload=?,accepted_entity='fee',accepted_entity_id=?,
              decision_reason=?,decided_at=datetime('now','+8 hours'),updated_at=datetime('now','+8 hours')
        WHERE id=? AND status='pending'`
    ).run(canonical, fee.id, reason, fact.id);
    if (decided.changes !== 1) throw linkError('该逻辑事实已经裁决', 'candidate_decided');
    db.prepare(
      `UPDATE legalrag_candidates
          SET status='accepted',accepted_entity='fee',accepted_entity_id=?,
              decided_at=datetime('now','+8 hours')
        WHERE fact_id=? AND status='pending'`
    ).run(fee.id, fact.id);
    refreshLegalRagFileStates(sources.map((source) => source.file_id));
    if (auditAction) {
      audit(actor || 'system', auditAction, 'candidate-fact', fact.id,
        auditDetail || JSON.stringify({ fact_key: fact.fact_key, fee_item_id: fee.id, mode, source_count: sources.length }));
    }
    return {
      fact: db.prepare('SELECT * FROM legalrag_candidate_facts WHERE id=?').get(fact.id),
      fee,
      source_count: sources.length,
    };
  });
}

export function withdrawAcceptedEntityFacts(entity, entityId, {
  actor = 'system',
  reason = '已录入的正式记录后来被人工删除',
} = {}) {
  return withImmediateTransaction(() => {
    const facts = db.prepare(
      `SELECT * FROM legalrag_candidate_facts
        WHERE status='accepted' AND accepted_entity=? AND accepted_entity_id=? ORDER BY id`
    ).all(entity, entityId);
    let sourceCount = 0;
    for (const fact of facts) {
      const sources = db.prepare(
        "SELECT file_id FROM legalrag_candidates WHERE fact_id=? AND status IN ('accepted','pending')"
      ).all(fact.id);
      db.prepare(
        `UPDATE legalrag_candidate_facts
            SET status='declined',accepted_entity='',accepted_entity_id=NULL,
                decision_reason=?,decided_at=datetime('now','+8 hours'),updated_at=datetime('now','+8 hours')
          WHERE id=? AND status='accepted'`
      ).run(reason, fact.id);
      db.prepare(
        `UPDATE legalrag_candidates
            SET status=CASE WHEN status IN ('accepted','pending') THEN 'declined' ELSE status END,
                accepted_entity='',accepted_entity_id=NULL,
                decided_at=CASE WHEN status IN ('accepted','pending')
                                THEN datetime('now','+8 hours') ELSE decided_at END
          WHERE fact_id=?`
      ).run(fact.id);
      refreshLegalRagFileStates(sources.map((source) => source.file_id));
      sourceCount += sources.length;
      audit(actor, 'legalrag-entity-withdrawn', 'candidate-fact', fact.id,
        `${entity || 'entity'} #${entityId || ''}`);
    }
    return { fact_count: facts.length, source_count: sourceCount };
  });
}

function demoteMissingAcceptedEntity(fact) {
  if (fact.status !== 'accepted' || entityExists(
    fact.accepted_entity, fact.accepted_entity_id, fact.case_id
  )) return fact;
  withdrawAcceptedEntityFacts(fact.accepted_entity, fact.accepted_entity_id);
  return db.prepare('SELECT * FROM legalrag_candidate_facts WHERE id=?').get(fact.id);
}

export function ensureCandidateFact(caseId, kind, payload, {
  prelinkExistingFee = true,
} = {}) {
  const factKey = candidateFactKey(kind, payload);
  db.prepare(
    `INSERT OR IGNORE INTO legalrag_candidate_facts
      (case_id,kind,fact_key,canonical_payload) VALUES (?,?,?,?)`
  ).run(caseId, kind, factKey, JSON.stringify(payload || {}));
  let fact = db.prepare(
    'SELECT * FROM legalrag_candidate_facts WHERE case_id=? AND kind=? AND fact_key=?'
  ).get(caseId, kind, factKey);
  fact = demoteMissingAcceptedEntity(fact);
  if (prelinkExistingFee && kind === 'fee' && fact.status === 'pending') {
    const match = matchExistingFeeItems(caseId, payload);
    if (match.state === 'unique') {
      fact = linkPendingFeeFact(fact.id, match.matches[0].id, {
        actor: 'system',
        mode: 'exact-auto',
        canonicalPayload: payload,
        auditAction: 'legalrag-prelink-exact',
      }).fact;
    }
  }
  return fact;
}

// 人工核对可以修正 LLM 的身份字段。接受前必须把整组来源移动到“修正后的事实”，
// 否则 canonical_payload 已变、fact_key 仍旧，会让正确事实下次再次浮出。
// 调用方必须位于 IMMEDIATE transaction 内。
export function mergeFactForAcceptedPayload(factId, kind, payload) {
  const source = db.prepare('SELECT * FROM legalrag_candidate_facts WHERE id=?').get(factId);
  if (!source) throw new Error('逻辑事实不存在');
  if (source.kind !== kind) throw new Error('候选类型与逻辑事实不一致');
  if (source.status !== 'pending') throw new Error('逻辑事实已经裁决');
  const factKey = candidateFactKey(kind, payload);
  const canonical = JSON.stringify(payload || {});
  if (source.fact_key === factKey) {
    db.prepare(
      "UPDATE legalrag_candidate_facts SET canonical_payload=?,updated_at=datetime('now','+8 hours') WHERE id=?"
    ).run(canonical, source.id);
    return { fact: db.prepare('SELECT * FROM legalrag_candidate_facts WHERE id=?').get(source.id), merged: false };
  }

  db.prepare(
    `INSERT OR IGNORE INTO legalrag_candidate_facts
      (case_id,kind,fact_key,canonical_payload) VALUES (?,?,?,?)`
  ).run(source.case_id, kind, factKey, canonical);
  let target = db.prepare(
    'SELECT * FROM legalrag_candidate_facts WHERE case_id=? AND kind=? AND fact_key=?'
  ).get(source.case_id, kind, factKey);
  target = demoteMissingAcceptedEntity(target);

  // 这次是用户明确“核对并录入”，因此可以覆盖目标事实以前的 declined 负反馈；
  // 已 accepted 且实体仍存在时则直接认领，绝不再建一条正式记录。
  if (target.status === 'declined') {
    db.prepare(
      `UPDATE legalrag_candidate_facts
          SET status='pending',canonical_payload=?,accepted_entity='',accepted_entity_id=NULL,
              decision_reason='',decided_at='',updated_at=datetime('now','+8 hours')
        WHERE id=?`
    ).run(canonical, target.id);
  } else if (target.status === 'pending') {
    db.prepare(
      "UPDATE legalrag_candidate_facts SET canonical_payload=?,updated_at=datetime('now','+8 hours') WHERE id=?"
    ).run(canonical, target.id);
  }
  db.prepare('UPDATE legalrag_candidates SET fact_id=? WHERE fact_id=?').run(target.id, source.id);
  // 原 OCR identity 必须留下负反馈 alias；否则下一份材料再次提取同一个错误值时会重新浮出。
  db.prepare(
    `UPDATE legalrag_candidate_facts
        SET status='declined',accepted_entity='',accepted_entity_id=NULL,
            decision_reason='人工已修正为另一事实',decided_at=datetime('now','+8 hours'),
            updated_at=datetime('now','+8 hours')
      WHERE id=?`
  ).run(source.id);
  return { fact: db.prepare('SELECT * FROM legalrag_candidate_facts WHERE id=?').get(target.id), merged: true };
}

function representative(candidates) {
  return [...candidates].sort((a, b) => Number(b.confidence) - Number(a.confidence) || b.id - a.id)[0];
}

// migration 011 后的幂等数据升级：为既有 evidence 建 fact，并把历史 accept/decline
// 收敛成跨文档裁决。superseded 只表示来源版本，不参与人工裁决优先级。
export function backfillCandidateFacts() {
  return withImmediateTransaction(() => {
    let changed = 0;
    const candidates = db.prepare('SELECT * FROM legalrag_candidates ORDER BY id').all();
    for (const candidate of candidates) {
      if (candidate.fact_id) continue;
      let payload;
      try { payload = JSON.parse(candidate.payload); } catch {
        payload = candidate.kind === 'fee'
          ? { label: `invalid-candidate-${candidate.id}`, amount: null, due_on: '' }
          : { type: `invalid-candidate-${candidate.id}`, occurred_on: '' };
      }
      // 先把历史来源聚合到事实层，再按 accepted/declined 优先级收敛；
      // 此处若提前 strict-prelink，会把旧版人工 declined 误提升成 accepted。
      const fact = ensureCandidateFact(candidate.case_id, candidate.kind, payload, {
        prelinkExistingFee: false,
      });
      db.prepare('UPDATE legalrag_candidates SET fact_id=? WHERE id=?').run(fact.id, candidate.id);
      changed++;
    }

    const facts = db.prepare('SELECT * FROM legalrag_candidate_facts ORDER BY id').all();
    for (const originalFact of facts) {
      let fact = demoteMissingAcceptedEntity(originalFact);
      let rows = db.prepare(
        'SELECT * FROM legalrag_candidates WHERE fact_id=? ORDER BY id'
      ).all(fact.id);
      if (!rows.length) continue;
      for (const row of rows) {
        if (row.status !== 'accepted' || entityExists(
          row.accepted_entity, row.accepted_entity_id, row.case_id
        )) continue;
        changed += db.prepare(
          `UPDATE legalrag_candidates
              SET status='declined',accepted_entity='',accepted_entity_id=NULL,
                  decided_at=CASE WHEN decided_at='' THEN datetime('now','+8 hours') ELSE decided_at END
            WHERE id=?`
        ).run(row.id).changes;
      }
      rows = db.prepare('SELECT * FROM legalrag_candidates WHERE fact_id=? ORDER BY id').all(fact.id);
      const best = representative(rows);
      let nextStatus = fact.status;
      let entity = fact.accepted_entity;
      let entityId = fact.accepted_entity_id;
      if (fact.status === 'pending') {
        const accepted = rows.find(
          (row) => row.status === 'accepted' && entityExists(
            row.accepted_entity, row.accepted_entity_id, row.case_id
          )
        );
        if (accepted) {
          nextStatus = 'accepted';
          entity = accepted.accepted_entity;
          entityId = accepted.accepted_entity_id;
        } else if (rows.some((row) => row.status === 'declined')) {
          nextStatus = 'declined';
          entity = '';
          entityId = null;
        }
      } else if (fact.status === 'accepted' && !entityExists(entity, entityId, fact.case_id)) {
        nextStatus = 'declined';
        entity = '';
        entityId = null;
      }
      db.prepare(
        `UPDATE legalrag_candidate_facts
            SET canonical_payload=?,status=?,accepted_entity=?,accepted_entity_id=?,
                decided_at=CASE WHEN ?='pending' THEN decided_at
                                WHEN decided_at='' THEN datetime('now','+8 hours') ELSE decided_at END,
                updated_at=datetime('now','+8 hours')
          WHERE id=?`
      ).run(best.payload, nextStatus, entity, entityId, nextStatus, fact.id);
      if (nextStatus === 'accepted') {
        changed += db.prepare(
          `UPDATE legalrag_candidates
              SET status='accepted',accepted_entity=?,accepted_entity_id=?,
                  decided_at=CASE WHEN decided_at='' THEN datetime('now','+8 hours') ELSE decided_at END
            WHERE fact_id=? AND status='pending'`
        ).run(entity, entityId, fact.id).changes;
      } else if (nextStatus === 'declined') {
        changed += db.prepare(
          `UPDATE legalrag_candidates
              SET status='declined',decided_at=CASE WHEN decided_at='' THEN datetime('now','+8 hours') ELSE decided_at END
            WHERE fact_id=? AND status='pending'`
        ).run(fact.id).changes;
      }
      if (nextStatus === 'pending' && fact.kind === 'fee') {
        let payload;
        try { payload = JSON.parse(best.payload); } catch { payload = null; }
        if (payload) {
          const match = matchExistingFeeItems(fact.case_id, payload);
          if (match.state === 'unique') {
            linkPendingFeeFact(fact.id, match.matches[0].id, {
              actor: 'system',
              mode: 'exact-auto',
              canonicalPayload: payload,
              auditAction: 'legalrag-prelink-exact',
            });
            changed++;
          }
        }
      }
    }
    changed += refreshLegalRagFileStates(candidates.map((candidate) => candidate.file_id));
    if (changed) audit('system', 'legalrag-fact-backfill', 'candidate-fact', null, `${changed} changes`);
    return changed;
  });
}

export function refreshLegalRagFileStates(fileIds) {
  const unique = [...new Set(fileIds.map(Number).filter(Number.isInteger))];
  const countPending = db.prepare(
    `SELECT COUNT(DISTINCT c.fact_id) AS c
       FROM legalrag_candidates c
       JOIN legalrag_candidate_facts f ON f.id=c.fact_id
      WHERE c.file_id=? AND c.status='pending' AND f.status='pending'`
  );
  const update = db.prepare(
    `UPDATE legalrag_files SET sync_status=?,updated_at=datetime('now','+8 hours')
      WHERE id=? AND sync_status IN ('ready','review') AND sync_status<>?`
  );
  let changed = 0;
  for (const fileId of unique) {
    const status = countPending.get(fileId).c ? 'review' : 'ready';
    changed += update.run(status, fileId, status).changes;
  }
  return changed;
}
