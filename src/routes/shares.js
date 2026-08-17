import { Router } from 'express';
import { db, audit, withImmediateTransaction } from '../db.js';
import { DEFAULT_ACTOR } from '../middleware/auth.js';
import { todayCN, isDate } from '../lib/dates.js';
import { computeShare } from '../lib/share.js';
import { fenToYuan, normalizeSettlementFormula } from '../lib/settlement.js';
import { enrichShareAgreementForRead } from '../lib/settlement-service.js';
import {
  findActiveAgreementConflict,
  findShareWriteConflict,
} from '../lib/share-overlap.js';

// 合作律师分成只挂 /api（apiAuth 人工面）。分成没有任何 LLM 通道：
// src/lib/llm.js 不持有 db 且输出 kind 只有 task|log；/api/quick 只写 worklog/tasks；
// /internal/inbox 的 event|task|note 新写白名单与历史 accept 分支均不扩 share；deadline 新写已关闭。
// 人工台账写入口在本文件；calculated/adjustment 只能由结算服务确认事务生成。
const r = Router();
const DIRECTIONS = ['payable', 'receivable'];
const STATUSES = ['pending', 'settled', 'waived'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const AGREEMENT_FIELDS = ['counterpart', 'note', 'contact_id', 'status', 'settlement_term'];
const SHARE_FIELDS = ['counterpart', 'amount', 'base_amount', 'due_month', 'status', 'settled_on', 'note', 'external_case'];
const REPAIR_STATUSES = ['open', 'claimed', 'retained_unlinked', 'voided_duplicate'];
const AGREEMENT_STATUSES = ['active', 'retired'];
const FORMULA_FIELDS = [
  'result_kind', 'result_basis', 'result_rate_bps', 'result_fixed_fen', 'deductions',
];
const REVISION_META_FIELDS = [
  'effective_on', 'label', 'change_note', 'rounding_mode', 'is_provisional', 'pending_deductions',
];
const CREATE_AGREEMENT_FIELDS = new Set([
  'direction', 'counterpart', 'contact_id', 'note', 'settlement_term',
  ...REVISION_META_FIELDS, ...FORMULA_FIELDS,
]);
const CREATE_REVISION_FIELDS = new Set(['settlement_term', ...REVISION_META_FIELDS, ...FORMULA_FIELDS]);
const PATCH_AGREEMENT_FIELDS = new Set(AGREEMENT_FIELDS);
const FORMULA_PATCH_FIELDS = new Set(['rate', 'flat_amount', ...REVISION_META_FIELDS, ...FORMULA_FIELDS]);
const ENGINE_SOURCE_FIELDS = new Set([
  'entry_kind', 'amount_fen', 'base_amount_fen', 'assignment_id', 'settlement_snapshot_id',
  'cancelled_at', 'cancel_reason', 'cancelled_by_run_id', 'is_void', 'voided_at', 'void_reason',
]);
const ENGINE_LIFECYCLE_FIELDS = new Set(['due_month', 'note', 'status', 'settled_on']);

const blank = (v) => v === undefined || v === null || v === '';
const actorOf = (req) => String(req.actor || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;

function repairVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : null;
}

function resolutionNote(value) {
  const note = String(value ?? '').trim();
  return note || null;
}

function openRepair(id, version) {
  const repair = db.prepare(
    `SELECT q.*, s.id AS source_share_id, s.case_id AS share_case_id, s.is_void
       FROM share_repair_queue q JOIN fee_shares s ON s.id = q.fee_share_id
      WHERE q.id = ?`
  ).get(id);
  if (!repair) return { error: '修复单不存在', code: 'repair_not_found', http: 404 };
  if (repair.status !== 'open') return { error: '修复单已裁决', code: 'repair_not_open', http: 409 };
  if (repair.version !== version) return { error: '修复单版本已变化，请刷新后重试', code: 'repair_version_conflict', http: 409 };
  if (repair.is_void) return { error: '作废分成不可再裁决', code: 'voided_share_read_only', http: 409 };
  return { repair };
}

function matchingShares(share) {
  return db.prepare(
    `SELECT s.id, s.fee_item_id, s.direction, s.counterpart, s.amount, s.due_month, s.status,
            fi.label AS fee_label
       FROM fee_shares s LEFT JOIN fee_items fi ON fi.id = s.fee_item_id
      WHERE s.case_id = ? AND s.direction = ? AND s.counterpart = ?
        AND s.amount = ? AND s.due_month = ? AND s.id <> ?
        AND s.is_void = 0 AND s.cancelled_at = ''
      ORDER BY s.id`
  ).all(share.case_id, share.direction, share.counterpart, share.amount, share.due_month, share.id);
}

function repairDetail(id) {
  const repair = db.prepare(
    `SELECT q.*, s.case_id AS share_case_id, s.fee_item_id AS share_fee_item_id,
            s.agreement_id AS share_agreement_id, s.direction AS share_direction,
            s.counterpart AS share_counterpart, s.base_amount AS share_base_amount,
            s.amount AS share_amount, s.due_month AS share_due_month,
            s.status AS share_status, s.is_void AS share_is_void,
            c.name AS case_name, fi.label AS source_fee_label
       FROM share_repair_queue q
       JOIN fee_shares s ON s.id = q.fee_share_id
       JOIN cases c ON c.id = s.case_id
       LEFT JOIN fee_items fi ON fi.id = s.fee_item_id
      WHERE q.id = ?`
  ).get(id);
  if (!repair) return null;

  const share = {
    id: repair.fee_share_id,
    case_id: repair.share_case_id,
    case_name: repair.case_name,
    fee_item_id: repair.share_fee_item_id,
    fee_label: repair.source_fee_label || '',
    agreement_id: repair.share_agreement_id,
    direction: repair.share_direction,
    counterpart: repair.share_counterpart,
    base_amount: repair.share_base_amount,
    amount: repair.share_amount,
    due_month: repair.share_due_month,
    status: repair.share_status,
    is_void: repair.share_is_void,
  };
  const feeCandidates = db.prepare(
    `SELECT id, label, amount, paid_on
       FROM fee_items WHERE case_id = ? AND status = 'paid'
       ORDER BY paid_on, id`
  ).all(share.case_id);
  return {
    id: repair.id,
    fee_share_id: repair.fee_share_id,
    issue_code: repair.issue_code,
    status: repair.status,
    proposed_fee_item_id: repair.proposed_fee_item_id,
    resolution_note: repair.resolution_note,
    exception_reason: repair.exception_reason,
    created_at: repair.created_at,
    resolved_at: repair.resolved_at,
    version: repair.version,
    share,
    fee_candidates: feeCandidates,
    soft_duplicates: matchingShares(share),
  };
}

function directionOf(v) {
  return DIRECTIONS.includes(v) ? v : null;
}

function rateOf(v) {
  if (blank(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return undefined;
  const rounded = Math.round(n * 100) / 100;
  return rounded > 0 && rounded <= 100 ? rounded : undefined;
}

function amountOf(v, nullable = false) {
  if (blank(v)) return nullable ? null : undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function unknownFields(body, allowed) {
  return Object.keys(body).filter((key) => !allowed.has(key));
}

function revisionDefinition(body) {
  const effectiveOn = String(body.effective_on || '').trim();
  const label = String(body.label || '').trim();
  const changeNote = String(body.change_note || '').trim();
  if (!isDate(effectiveOn)) return { error: 'effective_on 须为 YYYY-MM-DD' };
  if (!label) return { error: 'label 必填' };
  if (!changeNote) return { error: 'change_note 必填' };
  if (body.rounding_mode !== undefined && body.rounding_mode !== 'toward_zero') {
    return { error: 'rounding_mode 只允许 toward_zero' };
  }

  try {
    const formula = normalizeSettlementFormula({
      result_kind: body.result_kind,
      result_basis: body.result_basis,
      result_rate_bps: body.result_rate_bps,
      result_fixed_fen: body.result_fixed_fen,
      deductions: body.deductions,
    });
    const provisional = body.is_provisional === undefined
      ? false
      : (body.is_provisional === true || body.is_provisional === 1);
    if (body.is_provisional !== undefined
        && ![true, false, 0, 1].includes(body.is_provisional)) {
      return { error: 'is_provisional 须为布尔值' };
    }
    if (provisional && formula.result_kind !== 'rate') {
      return { error: '只有比例约定可标为暂定方案' };
    }
    const pendingDeductions = provisional ? String(body.pending_deductions || '').trim() : '';
    if (pendingDeductions.length > 200) return { error: 'pending_deductions 过长' };
    return { effectiveOn, label, changeNote, formula, provisional, pendingDeductions };
  } catch (error) {
    return { error: error.message };
  }
}

function compatibilityProjection(formula) {
  return formula.result_kind === 'rate'
    ? { rate: formula.result_rate_bps / 100, flatAmount: null }
    : { rate: null, flatAmount: fenToYuan(formula.result_fixed_fen) };
}

function insertAndSealRevision({ agreementId, caseId, revisionNo, definition, actor }) {
  const formula = definition.formula;
  const revision = db.prepare(
    `INSERT INTO fee_share_formula_revisions
       (agreement_id, case_id, revision_no, effective_on, label, change_note, rounding_mode,
        result_kind, result_basis, result_rate_bps, result_fixed_fen,
        is_provisional, pending_deductions, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'toward_zero', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    agreementId,
    caseId,
    revisionNo,
    definition.effectiveOn,
    definition.label,
    definition.changeNote,
    formula.result_kind,
    formula.result_basis ?? null,
    formula.result_rate_bps ?? null,
    formula.result_fixed_fen ?? null,
    definition.provisional ? 1 : 0,
    definition.pendingDeductions,
    actor
  );

  const insertDeduction = db.prepare(
    `INSERT INTO fee_share_formula_deductions
       (revision_id, sequence, label, kind, basis, fixed_fen, rate_bps)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const deduction of formula.deductions) {
    insertDeduction.run(
      revision.lastInsertRowid,
      deduction.sequence,
      deduction.label,
      deduction.kind,
      deduction.basis ?? null,
      deduction.fixed_fen ?? null,
      deduction.rate_bps ?? null
    );
  }

  const sealed = db.prepare(
    `UPDATE fee_share_formula_revisions
        SET sealed = 1, sealed_at = datetime('now','+8 hours'), sealed_by = ?
      WHERE id = ? AND sealed = 0`
  ).run(actor, revision.lastInsertRowid);
  if (sealed.changes !== 1) throw new Error('公式版本封存失败');
  return revision.lastInsertRowid;
}

function optionalId(v) {
  if (blank(v)) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function contactForCase(value, caseId) {
  const id = optionalId(value);
  if (id === undefined) return { error: 'contact_id 非法' };
  if (id === null) return { id: null };
  const row = db.prepare('SELECT id FROM contacts WHERE id = ? AND case_id = ?').get(id, caseId);
  return row ? { id } : { error: '联系人不存在或不属于本案' };
}

const REFERENCE_QUERIES = Object.freeze({
  fee: db.prepare('SELECT id FROM fee_items WHERE id = ?'),
  agreement: db.prepare('SELECT id FROM fee_share_agreements WHERE id = ?'),
});

function referenceId(value, reference, label) {
  const id = optionalId(value);
  if (id === undefined) return { error: `${label} 非法` };
  if (id === null) return { id: null };
  const query = REFERENCE_QUERIES[reference];
  if (!query) throw new Error(`未知引用类型：${reference}`);
  return query.get(id) ? { id } : { error: `${label} 不存在` };
}

r.get('/cases/:id/shares', (req, res) => {
  const c = db.prepare('SELECT id FROM cases WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '案件不存在' });
  const agreements = db.prepare('SELECT * FROM fee_share_agreements WHERE case_id = ? ORDER BY id')
    .all(c.id).map((agreement) => enrichShareAgreementForRead(agreement));
  const items = db.prepare(
    `SELECT s.*, fi.label AS fee_label FROM fee_shares s
       LEFT JOIN fee_items fi ON fi.id = s.fee_item_id
       WHERE s.case_id = ? AND s.is_void = 0 AND s.cancelled_at = ''
       ORDER BY s.status = 'pending' DESC, s.due_month, s.id`
  ).all(c.id);
  const pending = items.filter((x) => x.status === 'pending');
  res.json({
    agreements,
    items,
    totals: {
      payable_pending: pending.filter((x) => x.direction === 'payable').reduce((a, x) => a + x.amount, 0),
      receivable_pending: pending.filter((x) => x.direction === 'receivable').reduce((a, x) => a + x.amount, 0),
    },
  });
});

// 历史孤儿/重复分成的唯一裁决面。只读原行，候选款项仅限同案已收；
// 不读 contacts，也没有 /internal、inbox、quick 或 LLM 路径。
r.get('/share-repairs', (req, res) => {
  const status = String(req.query.status || 'open');
  if (status !== 'all' && !REPAIR_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'status 非法', code: 'repair_status_invalid' });
  }
  const ids = db.prepare(
    `SELECT id FROM share_repair_queue ${status === 'all' ? '' : 'WHERE status = ?'} ORDER BY created_at, id`
  ).all(...(status === 'all' ? [] : [status]));
  res.json(ids.map(({ id }) => repairDetail(id)));
});

r.post('/share-repairs/:id/claim', (req, res) => {
  const body = req.body || {};
  const version = repairVersion(body.version);
  const feeItemId = optionalId(body.fee_item_id);
  const note = resolutionNote(body.resolution_note);
  if (!version) return res.status(400).json({ error: 'version 非法', code: 'repair_version_invalid' });
  if (feeItemId === undefined || feeItemId === null) {
    return res.status(400).json({ error: 'fee_item_id 必填且须为正整数', code: 'fee_item_invalid' });
  }
  if (!note) return res.status(400).json({ error: 'resolution_note 必填', code: 'resolution_note_required' });

  const result = withImmediateTransaction(() => {
    const current = openRepair(req.params.id, version);
    if (current.error) return current;
    const share = db.prepare('SELECT * FROM fee_shares WHERE id = ?').get(current.repair.fee_share_id);
    const fee = db.prepare('SELECT id, case_id, status FROM fee_items WHERE id = ?').get(feeItemId);
    if (!fee) return { error: '款项不存在', code: 'fee_item_not_found', http: 404 };
    if (fee.case_id !== share.case_id) {
      return { error: '款项不属于该案件', code: 'fee_item_case_mismatch', http: 400 };
    }
    if (fee.status !== 'paid') {
      return { error: '只能认领已收款项', code: 'fee_item_not_paid', http: 400 };
    }

    const hardConflict = findShareWriteConflict({
      caseId: share.case_id,
      feeItemId,
      agreementId: share.agreement_id,
      direction: share.direction,
      counterpart: share.counterpart,
      excludeShareId: share.id,
    });
    if (hardConflict) {
      return {
        error: '目标款项已有同一分成义务，不能作为独立历史行认领',
        code: 'fee_share_overlap_conflict',
        http: 409,
        conflict: hardConflict,
      };
    }

    const duplicates = matchingShares(share);
    const independent = body.confirm_independent === true;
    const exception = resolutionNote(body.exception_reason);
    if (duplicates.length && !(independent && exception)) {
      return {
        error: '存在可能重复的分成，确认独立性并说明例外理由后才能认领',
        code: 'source_claim_conflict',
        http: 409,
        soft_duplicates: duplicates,
      };
    }

    const updated = db.prepare(
      `UPDATE share_repair_queue
          SET status = 'claimed', proposed_fee_item_id = ?, resolution_note = ?, exception_reason = ?,
              resolved_at = datetime('now','+8 hours'), version = version + 1
        WHERE id = ? AND status = 'open' AND version = ?`
    ).run(feeItemId, note, exception || '', current.repair.id, version);
    if (!updated.changes) return { error: '修复单已变化，请刷新后重试', code: 'repair_version_conflict', http: 409 };
    const linked = db.prepare('UPDATE fee_shares SET fee_item_id = ? WHERE id = ? AND is_void = 0')
      .run(feeItemId, share.id);
    if (!linked.changes) throw new Error('认领来源款失败：原分成已作废');
    audit(req.actor, 'repair_claim', 'share_repair', current.repair.id,
      `share:${share.id};fee:${feeItemId};version:${version}`);
    return { repair: repairDetail(current.repair.id) };
  });
  if (result.error) return res.status(result.http).json(result);
  res.json(result);
});

r.post('/share-repairs/:id/retain', (req, res) => {
  const body = req.body || {};
  const version = repairVersion(body.version);
  const note = resolutionNote(body.resolution_note);
  if (!version) return res.status(400).json({ error: 'version 非法', code: 'repair_version_invalid' });
  if (!note) return res.status(400).json({ error: 'resolution_note 必填', code: 'resolution_note_required' });

  const result = withImmediateTransaction(() => {
    const current = openRepair(req.params.id, version);
    if (current.error) return current;
    const updated = db.prepare(
      `UPDATE share_repair_queue
          SET status = 'retained_unlinked', resolution_note = ?, exception_reason = '',
              resolved_at = datetime('now','+8 hours'), version = version + 1
        WHERE id = ? AND status = 'open' AND version = ?`
    ).run(note, current.repair.id, version);
    if (!updated.changes) return { error: '修复单已变化，请刷新后重试', code: 'repair_version_conflict', http: 409 };
    audit(req.actor, 'repair_retain', 'share_repair', current.repair.id,
      `share:${current.repair.fee_share_id};version:${version}`);
    return { repair: repairDetail(current.repair.id) };
  });
  if (result.error) return res.status(result.http).json(result);
  res.json(result);
});

r.post('/share-repairs/:id/void', (req, res) => {
  const body = req.body || {};
  const version = repairVersion(body.version);
  const note = resolutionNote(body.resolution_note);
  if (!version) return res.status(400).json({ error: 'version 非法', code: 'repair_version_invalid' });
  if (!note) return res.status(400).json({ error: 'resolution_note 必填', code: 'resolution_note_required' });

  const result = withImmediateTransaction(() => {
    const current = openRepair(req.params.id, version);
    if (current.error) return current;
    const updated = db.prepare(
      `UPDATE share_repair_queue
          SET status = 'voided_duplicate', resolution_note = ?, exception_reason = '',
              resolved_at = datetime('now','+8 hours'), version = version + 1
        WHERE id = ? AND status = 'open' AND version = ?`
    ).run(note, current.repair.id, version);
    if (!updated.changes) return { error: '修复单已变化，请刷新后重试', code: 'repair_version_conflict', http: 409 };
    const voided = db.prepare(
      `UPDATE fee_shares SET is_void = 1, voided_at = datetime('now','+8 hours'), void_reason = ?
        WHERE id = ? AND is_void = 0`
    ).run(note, current.repair.fee_share_id);
    if (!voided.changes) throw new Error('作废分成失败：原分成已作废');
    audit(req.actor, 'repair_void', 'share_repair', current.repair.id,
      `share:${current.repair.fee_share_id};version:${version}`);
    return { repair: repairDetail(current.repair.id) };
  });
  if (result.error) return res.status(result.http).json(result);
  res.json(result);
});

r.post('/cases/:id/share-agreements', (req, res) => {
  const c = db.prepare('SELECT id, name FROM cases WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '案件不存在' });
  const b = req.body || {};
  const unknown = unknownFields(b, CREATE_AGREEMENT_FIELDS);
  if (unknown.length) return res.status(400).json({ error: `含未知字段 ${unknown.join(',')}` });
  const direction = directionOf(b.direction);
  if (!direction) return res.status(400).json({ error: 'direction 非法' });
  const counterpart = String(b.counterpart || '').trim();
  if (!counterpart) return res.status(400).json({ error: '合作律师必填' });
  const contact = contactForCase(b.contact_id, c.id);
  if (contact.error) return res.status(400).json({ error: contact.error });
  const definition = revisionDefinition(b);
  if (definition.error) return res.status(400).json({ error: definition.error });
  const projection = compatibilityProjection(definition.formula);
  const actor = actorOf(req);
  const settlementTerm = String(b.settlement_term || '').trim()
    || (direction === 'receivable' ? '待确定' : '收到律师费当月');
  if (settlementTerm.length > 200) return res.status(400).json({ error: 'settlement_term 过长' });

  const result = withImmediateTransaction(() => {
    const conflict = findActiveAgreementConflict({ caseId: c.id, direction, counterpart });
    if (conflict) {
      return {
        error: '本案已有同方向、同合作对象的有效约定，请追加公式版本',
        code: 'active_agreement_conflict',
        http: 409,
        agreement_id: conflict.id,
      };
    }
    const agreement = db.prepare(
      `INSERT INTO fee_share_agreements
         (case_id, direction, counterpart, contact_id, rate, flat_amount, note,
          settlement_term, status, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, datetime('now','+8 hours'))`
    ).run(
      c.id, direction, counterpart, contact.id, projection.rate, projection.flatAmount,
      String(b.note ?? ''), settlementTerm
    );
    const revisionId = insertAndSealRevision({
      agreementId: agreement.lastInsertRowid,
      caseId: c.id,
      revisionNo: 1,
      definition,
      actor,
    });
    audit(actor, 'create', 'share_agreement', agreement.lastInsertRowid,
      `${c.name} ${direction} ${counterpart};revision:${revisionId}`);
    return { id: agreement.lastInsertRowid };
  });
  if (result.error) return res.status(result.http).json(result);

  // 固定额也只是约定公式；未经过款项方案与确认结算，绝不先造 fee_shares。
  res.json(enrichShareAgreementForRead(
    db.prepare('SELECT * FROM fee_share_agreements WHERE id = ?').get(result.id)
  ));
});

r.post('/share-agreements/:id/revisions', (req, res) => {
  const row = db.prepare('SELECT * FROM fee_share_agreements WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '分成约定不存在' });
  if (row.status !== 'active') {
    return res.status(409).json({ error: '已退役约定不能追加公式版本', code: 'agreement_retired' });
  }
  const b = req.body || {};
  const unknown = unknownFields(b, CREATE_REVISION_FIELDS);
  if (unknown.length) return res.status(400).json({ error: `含未知字段 ${unknown.join(',')}` });
  const definition = revisionDefinition(b);
  if (definition.error) return res.status(400).json({ error: definition.error });
  const projection = compatibilityProjection(definition.formula);
  const actor = actorOf(req);
  const settlementTerm = 'settlement_term' in b ? String(b.settlement_term || '').trim() : row.settlement_term;
  if (!settlementTerm) return res.status(400).json({ error: '结算时间不能为空' });
  if (settlementTerm.length > 200) return res.status(400).json({ error: 'settlement_term 过长' });

  const result = withImmediateTransaction(() => {
    const current = db.prepare('SELECT * FROM fee_share_agreements WHERE id = ?').get(row.id);
    if (!current || current.status !== 'active') {
      return { error: '已退役约定不能追加公式版本', code: 'agreement_retired', http: 409 };
    }
    const revisionNo = db.prepare(
      'SELECT COALESCE(MAX(revision_no), 0) + 1 AS next_no FROM fee_share_formula_revisions WHERE agreement_id = ?'
    ).get(current.id).next_no;
    const id = insertAndSealRevision({
      agreementId: current.id,
      caseId: current.case_id,
      revisionNo,
      definition,
      actor,
    });
    db.prepare(
      `UPDATE fee_share_agreements
          SET rate = ?, flat_amount = ?, settlement_term = ?, version = version + 1,
              updated_at = datetime('now','+8 hours')
        WHERE id = ?`
    ).run(projection.rate, projection.flatAmount, settlementTerm, current.id);
    audit(actor, 'create', 'share_formula_revision', id,
      `agreement:${current.id};revision:${revisionNo}`);
    return { revisionId: id };
  });
  if (result.error) return res.status(result.http).json(result);
  const agreement = enrichShareAgreementForRead(
    db.prepare('SELECT * FROM fee_share_agreements WHERE id = ?').get(row.id)
  );
  res.json(agreement.latest_revision);
});

r.patch('/share-agreements/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM fee_share_agreements WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '分成约定不存在' });
  const b = req.body || {};
  const formulaAttempt = Object.keys(b).find((key) => FORMULA_PATCH_FIELDS.has(key));
  if (formulaAttempt) {
    return res.status(409).json({ error: '公式只能通过追加 revision 修改', code: 'formula_revision_required' });
  }
  const unknown = unknownFields(b, PATCH_AGREEMENT_FIELDS);
  if (unknown.length) return res.status(400).json({ error: `含未知字段 ${unknown.join(',')}` });
  const sets = [];
  const args = [];

  for (const f of AGREEMENT_FIELDS) {
    if (!(f in b)) continue;
    if (f === 'counterpart') {
      const v = String(b[f] || '').trim();
      if (!v) return res.status(400).json({ error: '合作律师必填' });
      sets.push('counterpart = ?'); args.push(v);
    } else if (f === 'contact_id') {
      const contact = contactForCase(b[f], row.case_id);
      if (contact.error) return res.status(400).json({ error: contact.error });
      sets.push('contact_id = ?'); args.push(contact.id);
    } else if (f === 'status') {
      if (!AGREEMENT_STATUSES.includes(b[f])) return res.status(400).json({ error: 'status 非法' });
      sets.push('status = ?'); args.push(b[f]);
    } else if (f === 'settlement_term') {
      const term = String(b[f] || '').trim();
      if (!term) return res.status(400).json({ error: '结算时间不能为空' });
      if (term.length > 200) return res.status(400).json({ error: 'settlement_term 过长' });
      sets.push('settlement_term = ?'); args.push(term);
    } else {
      sets.push('note = ?'); args.push(String(b[f] ?? ''));
    }
  }
  if (!sets.length) return res.status(400).json({ error: '无可更新字段' });
  sets.push("version = version + 1", "updated_at = datetime('now','+8 hours')");
  const result = withImmediateTransaction(() => {
    const current = db.prepare('SELECT * FROM fee_share_agreements WHERE id = ?').get(row.id);
    if (!current) return { error: '分成约定不存在', http: 404 };
    const nextCounterpart = 'counterpart' in b ? String(b.counterpart || '').trim() : current.counterpart;
    const nextStatus = 'status' in b ? b.status : current.status;
    if (nextStatus === 'active') {
      const conflict = findActiveAgreementConflict({
        caseId: current.case_id,
        direction: current.direction,
        counterpart: nextCounterpart,
        excludeAgreementId: current.id,
      });
      if (conflict) {
        return {
          error: '本案已有同方向、同合作对象的有效约定，请追加公式版本',
          code: 'active_agreement_conflict',
          http: 409,
          agreement_id: conflict.id,
        };
      }
    }
    db.prepare(`UPDATE fee_share_agreements SET ${sets.join(', ')} WHERE id = ?`).run(...args, current.id);
    audit(req.actor, 'update', 'share_agreement', current.id, Object.keys(b).join(','));
    return { agreement: enrichShareAgreementForRead(
      db.prepare('SELECT * FROM fee_share_agreements WHERE id = ?').get(current.id)
    ) };
  });
  if (result.error) return res.status(result.http).json(result);
  res.json(result.agreement);
});

r.delete('/share-agreements/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM fee_share_agreements WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '分成约定不存在' });
  const revisionCount = db.prepare(
    'SELECT COUNT(*) c FROM fee_share_formula_revisions WHERE agreement_id = ?'
  ).get(row.id).c;
  if (revisionCount) {
    if (row.status !== 'retired') {
      db.prepare(
        `UPDATE fee_share_agreements
            SET status = 'retired', version = version + 1, updated_at = datetime('now','+8 hours')
          WHERE id = ?`
      ).run(row.id);
      audit(req.actor, 'retire', 'share_agreement', row.id, row.counterpart);
    }
    return res.json({ ok: true });
  }

  const linked = db.prepare('SELECT COUNT(*) c FROM fee_shares WHERE agreement_id = ?').get(row.id).c;
  if (linked) return res.status(400).json({ error: '已有分成记录，不能删除约定' });
  db.prepare('DELETE FROM fee_share_agreements WHERE id = ?').run(row.id);
  audit(req.actor, 'delete', 'share_agreement', row.id, row.counterpart);
  res.json({ ok: true });
});

r.post('/shares', (req, res) => {
  const b = req.body || {};
  const sourceAttempt = Object.keys(b).find((key) => ENGINE_SOURCE_FIELDS.has(key));
  if (sourceAttempt) {
    return res.status(409).json({ error: '结算引擎台账只能由确认结算生成', code: 'engine_share_crud_forbidden' });
  }
  const direction = directionOf(b.direction);
  if (!direction) return res.status(400).json({ error: 'direction 非法' });
  const counterpart = String(b.counterpart || '').trim();
  if (!counterpart) return res.status(400).json({ error: '合作律师必填' });

  let caseId = optionalId(b.case_id);
  if (caseId === undefined) return res.status(400).json({ error: 'case_id 非法' });
  if (caseId !== null && !db.prepare('SELECT id FROM cases WHERE id = ?').get(caseId)) {
    return res.status(404).json({ error: '案件不存在' });
  }
  const externalCase = String(b.external_case || '').trim();
  if (caseId === null && !externalCase) return res.status(400).json({ error: 'case_id 或 external_case 至少填一项' });

  const direct = !blank(b.amount);
  const hasBase = !blank(b.base_amount);
  const hasRate = !blank(b.rate);
  // Allow agreement case (no amount fields) to fall through to agreement parsing block
  if ((direct && (hasBase || hasRate)) || (!direct && hasBase !== hasRate)) {
    return res.status(400).json({ error: '金额须直接填写 amount，或用 base_amount + rate 计算，二选一' });
  }
  let baseAmount = null;
  let amount;
  if (direct) {
    amount = amountOf(b.amount);
    if (amount === undefined) return res.status(400).json({ error: 'amount 非法' });
  } else if (hasBase || hasRate) {
    baseAmount = amountOf(b.base_amount);
    const rate = rateOf(b.rate);
    if (baseAmount === undefined || rate === undefined || rate === null) {
      return res.status(400).json({ error: 'base_amount 或 rate 非法' });
    }
    amount = computeShare(baseAmount, rate);
  }

  const dueMonth = blank(b.due_month) ? todayCN().slice(0, 7) : String(b.due_month);
  if (!MONTH_RE.test(dueMonth)) return res.status(400).json({ error: 'due_month 须为 YYYY-MM' });
  const fee = referenceId(b.fee_item_id, 'fee', 'fee_item_id');
  if (fee.error) return res.status(400).json({ error: fee.error });
  const agreement = referenceId(b.agreement_id, 'agreement', 'agreement_id');
  if (agreement.error) return res.status(400).json({ error: agreement.error });

  // ── 同案归属校验（既有 referenceId 只查存在，补 case 一致性）──
  const feeItemId = fee.id;
  let attachedFee = null;
  if (feeItemId !== null) {
    attachedFee = db.prepare('SELECT case_id, status, amount, amount_fen FROM fee_items WHERE id = ?').get(feeItemId);
    if (!attachedFee) return res.status(400).json({ error: '款项不存在' });
    const feeCase = attachedFee.case_id;
    if (caseId !== null && feeCase !== caseId) {
      return res.status(400).json({ error: '款项不属于该案件' });
    }
    if (caseId === null) caseId = feeCase; // 挂款即继承款项的案
    if (attachedFee.status === 'unpaid') {
      return res.status(409).json({ error: '未收款项须先配置分成方案', code: 'unpaid_fee_requires_plan' });
    }
  }
  let attachedAgreement = null;
  if (agreement.id !== null) {
    attachedAgreement = db.prepare('SELECT * FROM fee_share_agreements WHERE id = ?').get(agreement.id);
    if (!attachedAgreement) return res.status(400).json({ error: '约定不存在' });
    if (caseId === null || attachedAgreement.case_id !== caseId) {
      return res.status(400).json({ error: '约定不属于该案件' });
    }
    if (attachedAgreement.direction !== direction || attachedAgreement.counterpart.trim() !== counterpart) {
      return res.status(400).json({ error: '分成方向或合作对象与约定不一致', code: 'share_agreement_identity_mismatch' });
    }
  }
  if (feeItemId !== null && agreement.id !== null) {
    const engineExisting = db.prepare(
      `SELECT id FROM fee_shares
        WHERE fee_item_id = ? AND agreement_id = ? AND settlement_snapshot_id IS NOT NULL
        LIMIT 1`
    ).get(feeItemId, agreement.id);
    if (engineExisting) {
      return res.status(409).json({ error: '该款项与约定已有结算引擎台账', code: 'engine_share_crud_forbidden' });
    }
  }

  // ── 旧约定解析路径仅承接 005 历史简单比例。1.4 revision 的 rate/flat_amount
  // 只是展示投影，不能被通用 CRUD 当作新公式真相。 ──
  if (!direct && !hasBase && agreement.id !== null && feeItemId !== null) {
    const a = attachedAgreement;
    if (a.status !== 'active') return res.status(409).json({ error: '约定已退役', code: 'agreement_retired' });
    const latestRevision = db.prepare(
      `SELECT created_by, revision_no, result_kind, result_basis, result_rate_bps
         FROM fee_share_formula_revisions
        WHERE agreement_id = ? AND sealed = 1
        ORDER BY revision_no DESC LIMIT 1`
    ).get(a.id);
    const legacySimpleRate = latestRevision
      && latestRevision.created_by === 'migration-007'
      && latestRevision.revision_no === 1
      && latestRevision.result_kind === 'rate'
      && latestRevision.result_basis === 'gross';
    if (!legacySimpleRate) {
      return res.status(409).json({
        error: '该约定须通过款项方案与确认结算使用',
        code: 'agreement_formula_requires_plan',
      });
    }
    if (attachedFee.amount == null) return res.status(400).json({ error: '款项金额待定，无法按比例计算' });
    baseAmount = attachedFee.amount;
    amount = computeShare(attachedFee.amount, latestRevision.result_rate_bps / 100);
  }

  // 终极兜底：既没给金额、约定解析也没接管（缺 fee_item_id/agreement_id）→ 显式 400，
  // 别让 undefined 写进 amount NOT NULL 列变 500。
  if (amount === undefined) {
    return res.status(400).json({ error: '缺金额：直填 amount、或 base_amount+rate、或 fee_item_id+agreement_id 从约定算' });
  }

  const result = withImmediateTransaction(() => {
    if (feeItemId !== null && agreement.id !== null) {
      const existing = db.prepare(
        `SELECT * FROM fee_shares
          WHERE fee_item_id = ? AND agreement_id = ? AND settlement_snapshot_id IS NULL
            AND is_void = 0 AND cancelled_at = '' AND cancelled_by_run_id IS NULL
          ORDER BY id LIMIT 1`
      ).get(feeItemId, agreement.id);
      if (existing) {
        audit(req.actor, 'create', 'share', existing.id, `幂等跳过（已挂）${counterpart}`);
        return { share: existing };
      }
    }

    const conflict = findShareWriteConflict({
      caseId,
      feeItemId,
      agreementId: agreement.id,
      direction,
      counterpart,
    });
    if (conflict) {
      return {
        error: '该款项已有同一分成义务，请使用方案与结算流程',
        code: 'fee_share_overlap_conflict',
        http: 409,
        conflict,
      };
    }

    const info = db.prepare(
      `INSERT INTO fee_shares
         (case_id, external_case, agreement_id, fee_item_id, direction, counterpart, base_amount, amount, due_month, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(caseId, externalCase, agreement.id, feeItemId, direction, counterpart, baseAmount, amount, dueMonth, b.note || '');
    audit(req.actor, 'create', 'share', info.lastInsertRowid, `${direction} ${counterpart} ${amount} ${dueMonth}`);
    return { share: db.prepare('SELECT * FROM fee_shares WHERE id = ?').get(info.lastInsertRowid) };
  });
  if (result.error) return res.status(result.http).json(result);
  res.json(result.share);
});

r.patch('/shares/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM fee_shares WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '分成记录不存在' });
  if (row.is_void) {
    return res.status(409).json({ error: '作废分成只读，不能通用修改', code: 'voided_share_read_only' });
  }
  const repair = db.prepare("SELECT id FROM share_repair_queue WHERE fee_share_id = ? AND status = 'open'").get(row.id);
  if (repair) {
    return res.status(409).json({ error: '历史分成待修复，请在修复工作台裁决', code: 'legacy_repair_required' });
  }
  const b = req.body || {};
  const sourceAttempt = Object.keys(b).find((key) => ENGINE_SOURCE_FIELDS.has(key));
  if (sourceAttempt) {
    return res.status(409).json({ error: '结算来源字段不能通过通用修改入口变更', code: 'engine_share_crud_forbidden' });
  }
  const engineRow = row.settlement_snapshot_id != null
    || row.assignment_id != null
    || row.entry_kind === 'calculated'
    || row.entry_kind === 'adjustment';
  if (engineRow) {
    const protectedAttempt = Object.keys(b).find((key) => !ENGINE_LIFECYCLE_FIELDS.has(key));
    if (protectedAttempt) {
      return res.status(409).json({
        error: '结算引擎台账的金额、身份与来源事实不可修改',
        code: 'engine_share_facts_immutable',
      });
    }
  }
  const sets = [];
  const args = [];
  let requestedFeeItemId;

  if (row.case_id == null && 'external_case' in b && !String(b.external_case || '').trim()) {
    return res.status(400).json({ error: '外部案件描述必填' });
  }

  if ('fee_item_id' in b) {
    const fee = referenceId(b.fee_item_id, 'fee', 'fee_item_id');
    if (fee.error) return res.status(400).json({ error: fee.error });
    if (fee.id !== null) {
      // 同案校验：share 的 case_id 须与 fee 一致；share.case_id 为 NULL（外部案）时禁止挂款
      if (row.case_id == null) return res.status(400).json({ error: '外部案件分成不能挂款项' });
      const feeRow = db.prepare('SELECT case_id, status FROM fee_items WHERE id=?').get(fee.id);
      if (!feeRow) return res.status(400).json({ error: '款项不存在' });
      const feeCase = feeRow.case_id;
      if (feeCase !== row.case_id) return res.status(400).json({ error: '款项不属于该案件' });
      if (feeRow.status === 'unpaid') {
        return res.status(409).json({ error: '未收款项须先配置分成方案', code: 'unpaid_fee_requires_plan' });
      }
      // dedup 预检：引擎历史不能被手工行覆盖；其余正常行同款同约定也不能重复。
      if (row.agreement_id != null) {
        const engineExisting = db.prepare(
          `SELECT id FROM fee_shares
            WHERE fee_item_id=? AND agreement_id=? AND id<>? AND settlement_snapshot_id IS NOT NULL
            LIMIT 1`
        ).get(fee.id, row.agreement_id, row.id);
        if (engineExisting) {
          return res.status(409).json({ error: '该款项与约定已有结算引擎台账', code: 'engine_share_crud_forbidden' });
        }
        const clash = db.prepare(
          "SELECT id FROM fee_shares WHERE fee_item_id=? AND agreement_id=? AND id<>? AND is_void=0 AND cancelled_at=''"
        ).get(fee.id, row.agreement_id, row.id);
        if (clash) return res.status(409).json({ error: '该款项已挂同一约定，不能重复' });
      }
    }
    requestedFeeItemId = fee.id;
    sets.push('fee_item_id = ?'); args.push(fee.id);
  }

  if (engineRow && 'status' in b && !STATUSES.includes(b.status)) {
    return res.status(400).json({ error: 'status 非法' });
  }
  if (engineRow && 'settled_on' in b) {
    const settledOn = String(b.settled_on || '');
    if (settledOn && !isDate(settledOn)) return res.status(400).json({ error: 'settled_on 须为 YYYY-MM-DD' });
  }
  if (b.status === 'settled' && row.status !== 'settled' && !b.settled_on) {
    b.settled_on = todayCN();
  }
  if (engineRow && ('status' in b || 'settled_on' in b)) {
    const nextStatus = 'status' in b ? b.status : row.status;
    const nextSettledOn = 'settled_on' in b ? String(b.settled_on || '') : row.settled_on;
    const unchanged = nextStatus === row.status && nextSettledOn === row.settled_on;
    const uncancelled = row.cancelled_at === '' && row.cancel_reason === '' && row.cancelled_by_run_id == null;
    const settles = row.status === 'pending' && nextStatus === 'settled' && isDate(nextSettledOn);
    const waives = row.status === 'pending' && nextStatus === 'waived' && nextSettledOn === '';
    if (!unchanged && !(uncancelled && (settles || waives))) {
      return res.status(409).json({ error: '结算台账状态只能从 pending 单向结清或减免', code: 'engine_share_lifecycle_invalid' });
    }
  }

  for (const f of SHARE_FIELDS) {
    if (!(f in b)) continue;
    if (f === 'counterpart') {
      const v = String(b[f] || '').trim();
      if (!v) return res.status(400).json({ error: '合作律师必填' });
      sets.push('counterpart = ?'); args.push(v);
    } else if (f === 'amount') {
      const v = amountOf(b[f]);
      if (v === undefined) return res.status(400).json({ error: 'amount 非法' });
      sets.push('amount = ?'); args.push(v);
    } else if (f === 'base_amount') {
      const v = amountOf(b[f], true);
      if (v === undefined) return res.status(400).json({ error: 'base_amount 非法' });
      sets.push('base_amount = ?'); args.push(v);
    } else if (f === 'due_month') {
      const v = String(b[f] || '');
      if (!MONTH_RE.test(v)) return res.status(400).json({ error: 'due_month 须为 YYYY-MM' });
      sets.push('due_month = ?'); args.push(v);
    } else if (f === 'status') {
      if (!STATUSES.includes(b[f])) return res.status(400).json({ error: 'status 非法' });
      sets.push('status = ?'); args.push(b[f]);
    } else if (f === 'settled_on') {
      const v = String(b[f] || '');
      if (v && !isDate(v)) return res.status(400).json({ error: 'settled_on 须为 YYYY-MM-DD' });
      sets.push('settled_on = ?'); args.push(v);
    } else if (f === 'external_case') {
      sets.push('external_case = ?'); args.push(String(b[f] || '').trim());
    } else {
      sets.push('note = ?'); args.push(String(b[f] ?? ''));
    }
  }
  if (!sets.length) return res.status(400).json({ error: '无可更新字段' });
  const result = withImmediateTransaction(() => {
    const current = db.prepare('SELECT * FROM fee_shares WHERE id = ?').get(row.id);
    if (!current) return { error: '分成记录不存在', http: 404 };
    if (current.is_void) {
      return { error: '作废分成只读，不能通用修改', code: 'voided_share_read_only', http: 409 };
    }
    const currentRepair = db.prepare(
      "SELECT id FROM share_repair_queue WHERE fee_share_id = ? AND status = 'open'"
    ).get(current.id);
    if (currentRepair) {
      return { error: '历史分成待修复，请在修复工作台裁决', code: 'legacy_repair_required', http: 409 };
    }
    const currentEngineRow = current.settlement_snapshot_id != null
      || current.assignment_id != null
      || current.entry_kind === 'calculated'
      || current.entry_kind === 'adjustment';
    if (currentEngineRow) {
      const protectedAttempt = Object.keys(b).find((key) => !ENGINE_LIFECYCLE_FIELDS.has(key));
      if (protectedAttempt) {
        return {
          error: '结算引擎台账的金额、身份与来源事实不可修改',
          code: 'engine_share_facts_immutable',
          http: 409,
        };
      }
      if ('status' in b || 'settled_on' in b) {
        const nextStatus = 'status' in b ? b.status : current.status;
        const nextSettledOn = 'settled_on' in b ? String(b.settled_on || '') : current.settled_on;
        const unchanged = nextStatus === current.status && nextSettledOn === current.settled_on;
        const uncancelled = current.cancelled_at === ''
          && current.cancel_reason === ''
          && current.cancelled_by_run_id == null;
        const settles = current.status === 'pending'
          && nextStatus === 'settled'
          && isDate(nextSettledOn);
        const waives = current.status === 'pending'
          && nextStatus === 'waived'
          && nextSettledOn === '';
        if (!unchanged && !(uncancelled && (settles || waives))) {
          return {
            error: '结算台账状态只能从 pending 单向结清或减免',
            code: 'engine_share_lifecycle_invalid',
            http: 409,
          };
        }
      }
    }
    const targetFeeItemId = 'fee_item_id' in b ? requestedFeeItemId : current.fee_item_id;
    if ('fee_item_id' in b && targetFeeItemId !== null) {
      const targetFee = db.prepare('SELECT case_id,status FROM fee_items WHERE id = ?').get(targetFeeItemId);
      if (!targetFee) return { error: '款项不存在', http: 400 };
      if (current.case_id == null) return { error: '外部案件分成不能挂款项', http: 400 };
      if (targetFee.case_id !== current.case_id) return { error: '款项不属于该案件', http: 400 };
      if (targetFee.status === 'unpaid') {
        return { error: '未收款项须先配置分成方案', code: 'unpaid_fee_requires_plan', http: 409 };
      }
    }
    const nextCounterpart = 'counterpart' in b ? String(b.counterpart || '').trim() : current.counterpart;
    const identityChanged = 'fee_item_id' in b || 'counterpart' in b;
    const conflict = identityChanged && !currentEngineRow
      ? findShareWriteConflict({
        caseId: current.case_id,
        feeItemId: targetFeeItemId,
        agreementId: current.agreement_id,
        direction: current.direction,
        counterpart: nextCounterpart,
        excludeShareId: current.id,
      })
      : null;
    if (conflict) {
      return {
        error: '该款项已有同一分成义务，不能通过通用修改入口制造重叠',
        code: 'fee_share_overlap_conflict',
        http: 409,
        conflict,
      };
    }
    db.prepare(`UPDATE fee_shares SET ${sets.join(', ')} WHERE id = ?`).run(...args, current.id);
    audit(req.actor, 'update', 'share', current.id, Object.keys(b).join(','));
    return { share: db.prepare('SELECT * FROM fee_shares WHERE id = ?').get(current.id) };
  });
  if (result.error) return res.status(result.http).json(result);
  res.json(result.share);
});

r.delete('/shares/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM fee_shares WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '分成记录不存在' });
  if (row.is_void) {
    return res.status(409).json({ error: '作废分成只读，不能删除审计证据', code: 'voided_share_read_only' });
  }
  const repair = db.prepare("SELECT id FROM share_repair_queue WHERE fee_share_id = ? AND status = 'open'").get(row.id);
  if (repair) {
    return res.status(409).json({ error: '历史分成待修复，不能绕过修复工作台删除', code: 'legacy_repair_required' });
  }
  if (row.settlement_snapshot_id != null || row.assignment_id != null
      || row.entry_kind === 'calculated' || row.entry_kind === 'adjustment') {
    return res.status(409).json({ error: '结算引擎台账不能删除', code: 'engine_share_crud_forbidden' });
  }
  db.prepare('DELETE FROM fee_shares WHERE id = ?').run(row.id);
  audit(req.actor, 'delete', 'share', row.id, `${row.counterpart} ${row.amount}`);
  res.json({ ok: true });
});

r.get('/shares/overview', (req, res) => {
  const date = todayCN();
  const year = date.slice(0, 4);
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN direction='payable' AND status='pending' THEN amount ELSE 0 END),0) AS payable_pending,
      COALESCE(SUM(CASE WHEN direction='receivable' AND status='pending' THEN amount ELSE 0 END),0) AS receivable_pending,
      COALESCE(SUM(CASE WHEN direction='payable' AND status='settled' AND substr(settled_on,1,4)=? THEN amount ELSE 0 END),0) AS payable_settled_year,
      COALESCE(SUM(CASE WHEN direction='receivable' AND status='settled' AND substr(settled_on,1,4)=? THEN amount ELSE 0 END),0) AS receivable_settled_year
    FROM fee_shares WHERE is_void = 0 AND cancelled_at = ''
  `).get(year, year);
  const byCounterpart = db.prepare(`
    SELECT counterpart,
      COALESCE(SUM(CASE WHEN direction='payable' AND status='pending' THEN amount ELSE 0 END),0) AS payable_pending,
      COALESCE(SUM(CASE WHEN direction='receivable' AND status='pending' THEN amount ELSE 0 END),0) AS receivable_pending,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_count,
      COALESCE(SUM(CASE WHEN status='settled' AND substr(settled_on,1,4)=? THEN amount ELSE 0 END),0) AS settled_year
    FROM fee_shares WHERE is_void = 0 AND cancelled_at = '' GROUP BY counterpart
    ORDER BY pending_count DESC, counterpart
  `).all(year);
  const items = db.prepare(`
    SELECT s.*, c.name AS case_name, fi.label AS fee_label FROM fee_shares s
      LEFT JOIN cases c ON c.id = s.case_id
      LEFT JOIN fee_items fi ON fi.id = s.fee_item_id
    WHERE s.is_void = 0 AND s.cancelled_at = ''
    ORDER BY s.status = 'pending' DESC, s.due_month, s.id
  `).all();
  const agreements = db.prepare(`
    SELECT a.*, c.name AS case_name, c.status AS case_status
      FROM fee_share_agreements a JOIN cases c ON c.id = a.case_id
     ORDER BY a.status = 'active' DESC, a.direction = 'receivable' DESC, c.name, a.id
  `).all().map((agreement) => enrichShareAgreementForRead(agreement));
  res.json({ date, totals, by_counterpart: byCounterpart, agreements, items });
});

export default r;
