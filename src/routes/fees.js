import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import { db, audit, withImmediateTransaction } from '../db.js';
import { todayCN, isDate } from '../lib/dates.js';
import {
  openSecureFile,
  removeSecureCreatedFile,
  resolveCaseDirectory,
  sanitizeUploadFileName,
  writeUniqueSecureFile,
} from '../lib/secure-files.js';
import { withdrawAcceptedEntityFacts } from '../lib/candidate-facts.js';
import { fenToYuan, parseMoneyToFen } from '../lib/settlement.js';
import {
  SettlementError,
  confirmSettlement,
  enrichFeeForRead,
  enrichShareAgreementForRead,
  feeSettlementContext,
  getFeeSharePlans,
  previewSettlement,
  putFeeSharePlans,
} from '../lib/settlement-service.js';

const r = Router();
const FILES_ROOT = process.env.ANJIAN_FILES_ROOT || '';
const VOUCHER_DIR = '财务凭证';
const MAX_VOUCHER_SIZE = 60 * 1024 * 1024;
const VOUCHER_KINDS = new Set(['receipt', 'invoice', 'share_sheet', 'other']);

const FEE_STATUS_TRANSITIONS = {
  unpaid: new Set(['unpaid', 'paid', 'waived']),
  paid: new Set(['paid', 'unpaid']),
  waived: new Set(['waived', 'unpaid']),
};

function settlementFailure(res, error) {
  if (!(error instanceof SettlementError)) throw error;
  return res.status(error.http).json({ error: error.message, code: error.code, ...error.extra });
}

function moneyInput(value) {
  if (value === null || value === undefined || value === '') return { amount: null, amount_fen: null };
  const amountFen = parseMoneyToFen(value);
  return { amount: fenToYuan(amountFen), amount_fen: amountFen };
}

function requiredFeeVersion(req, res, fee) {
  const version = Number(req.query.version);
  if (!Number.isInteger(version) || version <= 0) {
    res.status(400).json({ error: 'version 必填且须为正整数', code: 'fee_version_invalid' });
    return false;
  }
  if (version !== fee.version) {
    res.status(409).json({
      error: '款项版本已变化，请刷新后重试',
      code: 'fee_version_conflict',
      expected_version: fee.version,
    });
    return false;
  }
  return true;
}

function vouchersForFees(fees) {
  const byFee = new Map(fees.map((fee) => [fee.id, []]));
  if (!fees.length) return byFee;
  const feeById = new Map(fees.map((fee) => [fee.id, fee]));
  const placeholders = fees.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id,fee_item_id,case_id,rel_path,kind,size,created_at
       FROM fee_item_files
      WHERE fee_item_id IN (${placeholders})
      ORDER BY id`
  ).all(...fees.map((fee) => fee.id));
  for (const row of rows) {
    const fee = feeById.get(row.fee_item_id);
    let missing = false;
    if (FILES_ROOT && fee) {
      try {
        const context = resolveCaseDirectory(FILES_ROOT, fee.case_name || fee.case_name_for_files || '');
        if (!context.exists) {
          missing = true;
        } else {
          const opened = openSecureFile(context, row.rel_path);
          fs.closeSync(opened.fd);
        }
      } catch {
        missing = true;
      }
    }
    byFee.get(row.fee_item_id)?.push({ ...row, missing });
  }
  return byFee;
}

// 全所律师费总览（台账页数据源）
r.get('/fees/overview', (req, res) => {
  const today = todayCN();
  const rows = db.prepare(
    `SELECT f.*, c.name AS case_name, c.status AS case_status FROM fee_items f
     JOIN cases c ON c.id = f.case_id
     ORDER BY c.status = 'active' DESC, c.name, COALESCE(NULLIF(f.due_on,''),'9999'), f.id`
  ).all();
  const voucherMap = vouchersForFees(rows);

  const shareRows = db.prepare(
    `SELECT id,fee_item_id,case_id,agreement_id,direction,status,amount,amount_fen,counterpart,
            due_month,settled_on,entry_kind,settlement_snapshot_id
       FROM fee_shares
      WHERE is_void = 0 AND cancelled_at = '' AND cancelled_by_run_id IS NULL ORDER BY id`
  ).all();
  const byFee = new Map();
  const byCaseShare = new Map();
  const ACC = ['pending', 'settled'];
  let sharePayable = 0;
  let shareReceivable = 0;
  for (const share of shareRows) {
    const counts = ACC.includes(share.status);
    if (counts) {
      if (share.direction === 'payable') sharePayable += share.amount;
      else shareReceivable += share.amount;
    }
    if (share.case_id != null) {
      if (!byCaseShare.has(share.case_id)) byCaseShare.set(share.case_id, { payable: 0, receivable: 0 });
      const group = byCaseShare.get(share.case_id);
      if (counts) {
        if (share.direction === 'payable') group.payable += share.amount;
        else group.receivable += share.amount;
      }
    }
    if (share.fee_item_id != null) {
      if (!byFee.has(share.fee_item_id)) byFee.set(share.fee_item_id, []);
      byFee.get(share.fee_item_id).push(share);
    }
  }

  const agreementRows = db.prepare('SELECT * FROM fee_share_agreements ORDER BY id').all();
  const activePayableCaseIds = new Set(agreementRows
    .filter((agreement) => agreement.direction === 'payable' && agreement.status === 'active')
    .map((agreement) => agreement.case_id));
  const assignmentFeeIds = new Set(db.prepare(
    'SELECT DISTINCT fee_item_id FROM fee_share_assignments'
  ).all().map((row) => row.fee_item_id));
  const settlementFeeIds = new Set(db.prepare(
    'SELECT DISTINCT fee_item_id FROM fee_share_settlement_runs'
  ).all().map((row) => row.fee_item_id));
  const shareContextByFee = new Map(db.prepare(
    `SELECT fee_item_id,
            MAX(CASE WHEN is_void = 0 THEN 1 ELSE 0 END) AS share_history
       FROM fee_shares WHERE fee_item_id IS NOT NULL GROUP BY fee_item_id`
  ).all().map((row) => [row.fee_item_id, row]));
  const byCaseAgreement = new Map();
  for (const rawAgreement of agreementRows) {
    const agreement = enrichShareAgreementForRead(rawAgreement);
    if (!byCaseAgreement.has(agreement.case_id)) byCaseAgreement.set(agreement.case_id, []);
    byCaseAgreement.get(agreement.case_id).push(agreement);
  }

  const byCase = new Map();
  const totals = { paid: 0, unpaid: 0, overdue: 0, waived: 0, tbd: 0 };
  for (const rawFee of rows) {
    if (!byCase.has(rawFee.case_id)) {
      byCase.set(rawFee.case_id, {
        case_id: rawFee.case_id,
        case_name: rawFee.case_name,
        case_status: rawFee.case_status,
        paid: 0,
        unpaid: 0,
        waived: 0,
        tbd: 0,
        items: [],
      });
    }
    const group = byCase.get(rawFee.case_id);
    const shareContext = shareContextByFee.get(rawFee.id);
    const settlementContext = {
      active_payable_agreement: activePayableCaseIds.has(rawFee.case_id),
      assignment: assignmentFeeIds.has(rawFee.id),
      settlement_history: settlementFeeIds.has(rawFee.id),
      share_history: Boolean(shareContext?.share_history),
      linked_share: Boolean(shareContext),
    };
    settlementContext.required = settlementContext.active_payable_agreement
      || settlementContext.assignment || settlementContext.settlement_history || settlementContext.share_history;
    const fee = enrichFeeForRead(rawFee, byFee.get(rawFee.id) || [], settlementContext);
    fee.vouchers = voucherMap.get(rawFee.id) || [];
    group.items.push(fee);
    if (fee.status === 'paid' && fee.amount != null) { group.paid += fee.amount; totals.paid += fee.amount; }
    else if (fee.status === 'unpaid' && fee.amount != null) {
      group.unpaid += fee.amount;
      totals.unpaid += fee.amount;
      if (fee.due_on && fee.due_on < today) totals.overdue += fee.amount;
    } else if (fee.status === 'waived' && fee.amount != null) {
      group.waived += fee.amount;
      totals.waived += fee.amount;
    }
    if (fee.amount == null && fee.status === 'unpaid') { group.tbd++; totals.tbd++; }
  }
  for (const group of byCase.values()) {
    group.shares = byCaseShare.get(group.case_id) || { payable: 0, receivable: 0 };
    group.net_retained = group.paid - group.shares.payable + group.shares.receivable;
    group.agreements = byCaseAgreement.get(group.case_id) || [];
  }
  totals.share_payable = sharePayable;
  totals.share_receivable = shareReceivable;
  totals.net_retained = totals.paid - sharePayable + shareReceivable;
  res.json({ date: today, totals, cases: [...byCase.values()], files_enabled: Boolean(FILES_ROOT) });
});

r.get('/cases/:id/fees', (req, res) => {
  const rows = db.prepare(
    `SELECT f.*, c.name AS case_name_for_files
       FROM fee_items f JOIN cases c ON c.id=f.case_id
      WHERE f.case_id = ? ORDER BY COALESCE(NULLIF(f.due_on,''),'9999'), f.id`
  ).all(req.params.id);
  const voucherMap = vouchersForFees(rows);
  const items = rows.map((fee) => ({
    ...enrichFeeForRead(fee),
    vouchers: voucherMap.get(fee.id) || [],
  }));
  const sum = (status) => rows
    .filter((fee) => fee.status === status && fee.amount != null)
    .reduce((total, fee) => total + fee.amount, 0);
  res.json({
    items,
    total_paid: sum('paid'),
    total_unpaid: sum('unpaid'),
    files_enabled: Boolean(FILES_ROOT),
  });
});

r.post('/cases/:id/fees', (req, res) => {
  const c = db.prepare('SELECT id, name FROM cases WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '案件不存在' });
  const body = req.body || {};
  if (typeof body.label !== 'string' || !body.label.trim()) {
    return res.status(400).json({ error: 'label 必填' });
  }
  if (body.due_on && !isDate(body.due_on)) return res.status(400).json({ error: 'due_on 须为 YYYY-MM-DD' });
  let money;
  try {
    money = moneyInput(body.amount);
  } catch (error) {
    return res.status(400).json({ error: error.message, code: 'amount_invalid' });
  }
  const info = db.prepare(
    `INSERT INTO fee_items (case_id,label,amount,amount_fen,node,due_on,note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    c.id, body.label.trim(), money.amount, money.amount_fen,
    body.node || '', body.due_on || '', body.note || ''
  );
  audit(req.actor, 'create', 'fee', info.lastInsertRowid, `${c.name} ${body.label} ${money.amount ?? '待定'}`);
  res.json(db.prepare('SELECT * FROM fee_items WHERE id = ?').get(info.lastInsertRowid));
});

r.put('/fees/:id/files', express.raw({ type: '*/*', limit: MAX_VOUCHER_SIZE }), (req, res) => {
  const fee = db.prepare(
    `SELECT f.*, c.name AS case_name
       FROM fee_items f JOIN cases c ON c.id=f.case_id
      WHERE f.id=?`
  ).get(req.params.id);
  if (!fee) return res.status(404).json({ error: '款项不存在' });
  if (!FILES_ROOT) return res.status(503).json({ error: '未配置文件根（ANJIAN_FILES_ROOT）' });
  if (!requiredFeeVersion(req, res, fee)) return;

  const kind = String(req.query.kind || 'other');
  if (!VOUCHER_KINDS.has(kind)) {
    return res.status(400).json({ error: 'kind 非法', code: 'voucher_kind_invalid' });
  }
  const name = sanitizeUploadFileName(req.query.name);
  if (!name) return res.status(400).json({ error: '文件名非法' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: '空文件' });

  let context;
  try {
    context = resolveCaseDirectory(FILES_ROOT, fee.case_name);
  } catch (error) {
    const status = ['root_unconfigured', 'root_unavailable', 'root_invalid'].includes(error?.code) ? 503 : 400;
    return res.status(status).json({ error: error.message });
  }
  if (!context.exists) {
    return res.status(404).json({ error: `案件夹不存在：${fee.case_name}（请先核对案件夹名称）` });
  }
  let written;
  try {
    written = writeUniqueSecureFile(context, VOUCHER_DIR, name, req.body);
  } catch (error) {
    const status = error?.code === 'path_changed' ? 409 : error?.code === 'not_found' ? 404 : 400;
    return res.status(status).json({ error: error.message });
  }
  const relPath = written.relativePath;

  let id;
  try {
    id = db.prepare(
      `INSERT INTO fee_item_files (fee_item_id,case_id,rel_path,kind,size)
       VALUES (?, ?, ?, ?, ?)`
    ).run(fee.id, fee.case_id, relPath, kind, req.body.length).lastInsertRowid;
  } catch (error) {
    removeSecureCreatedFile(context, written);
    throw error;
  }
  audit(req.actor, 'link', 'fee_file', id, `${fee.case_name}/${relPath} ${kind} ${req.body.length}B`);
  res.json({
    ok: true,
    file: db.prepare(
      'SELECT id,fee_item_id,case_id,rel_path,kind,size,created_at,0 AS missing FROM fee_item_files WHERE id=?'
    ).get(id),
  });
});

r.delete('/fees/:id/files/:fileId', (req, res) => {
  const fee = db.prepare('SELECT * FROM fee_items WHERE id=?').get(req.params.id);
  if (!fee) return res.status(404).json({ error: '款项不存在' });
  if (!requiredFeeVersion(req, res, fee)) return;
  const file = db.prepare(
    'SELECT * FROM fee_item_files WHERE id=? AND fee_item_id=? AND case_id=?'
  ).get(req.params.fileId, fee.id, fee.case_id);
  if (!file) return res.status(404).json({ error: '凭证关联不存在' });
  db.prepare('DELETE FROM fee_item_files WHERE id=?').run(file.id);
  audit(req.actor, 'unlink', 'fee_file', file.id, file.rel_path);
  res.json({ ok: true, note: '仅解除关联，文件本体仍在案件夹' });
});

r.get('/fees/:id/share-plans', (req, res) => {
  try {
    res.json(getFeeSharePlans(req.params.id));
  } catch (error) {
    return settlementFailure(res, error);
  }
});

r.put('/fees/:id/share-plans', (req, res) => {
  try {
    res.json(putFeeSharePlans(req.params.id, req.body || {}, req.actor));
  } catch (error) {
    return settlementFailure(res, error);
  }
});

r.post('/fees/:id/settlements/preview', (req, res) => {
  try {
    res.json(previewSettlement(req.params.id, req.body || {}));
  } catch (error) {
    return settlementFailure(res, error);
  }
});

r.post('/fees/:id/settlements/confirm', (req, res) => {
  try {
    res.json(confirmSettlement(req.params.id, req.body || {}, req.actor));
  } catch (error) {
    return settlementFailure(res, error);
  }
});

r.patch('/fees/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM fee_items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '款项不存在' });
  const body = req.body || {};
  if ('version' in body) {
    const version = Number(body.version);
    if (!Number.isInteger(version) || version <= 0) return res.status(400).json({ error: 'version 非法', code: 'fee_version_invalid' });
    if (version !== row.version) {
      return res.status(409).json({
        error: '款项版本已变化，请刷新后重试',
        code: 'fee_version_conflict',
        expected_version: row.version,
      });
    }
  }

  let nextAmount = { amount: row.amount, amount_fen: row.amount_fen };
  if ('amount' in body) {
    try {
      nextAmount = moneyInput(body.amount);
    } catch (error) {
      return res.status(400).json({ error: error.message, code: 'amount_invalid' });
    }
  }
  if ('due_on' in body && body.due_on && !isDate(body.due_on)) return res.status(400).json({ error: '日期非法' });
  if ('paid_on' in body && body.paid_on && !isDate(body.paid_on)) return res.status(400).json({ error: 'paid_on 须为 YYYY-MM-DD' });
  if ('status' in body && !['unpaid', 'paid', 'waived'].includes(body.status)) {
    return res.status(400).json({ error: 'status 非法' });
  }

  const nextStatus = 'status' in body ? body.status : row.status;
  const statusChanged = nextStatus !== row.status;
  if (statusChanged && !FEE_STATUS_TRANSITIONS[row.status]?.has(nextStatus)) {
    return res.status(409).json({
      error: `款项状态不能从 ${row.status} 直接变为 ${nextStatus}`,
      code: 'fee_status_transition_invalid',
      current_status: row.status,
      requested_status: nextStatus,
    });
  }
  let nextPaidOn = 'paid_on' in body ? String(body.paid_on ?? '') : row.paid_on;
  if (nextStatus === 'paid' && row.status !== 'paid' && !('paid_on' in body)) nextPaidOn = todayCN();
  if (nextStatus !== 'paid') nextPaidOn = '';
  const amountChanged = nextAmount.amount_fen !== row.amount_fen;
  const paidOnChanged = nextPaidOn !== row.paid_on;
  const settlementFactsChanged = amountChanged || statusChanged || paidOnChanged;
  const context = feeSettlementContext(row);
  const paidTransition = row.status !== 'paid' && nextStatus === 'paid';
  const waiverTransition = statusChanged
    && ((row.status === 'unpaid' && nextStatus === 'waived')
      || (row.status === 'waived' && nextStatus === 'unpaid'));
  // 仅有前瞻 assignment 时，纯减免/恢复保留原方案即可；金额等其他事实仍受方案保护。
  const assignmentProtectedChange = context.assignment
    && (!waiverTransition || amountChanged);
  const protectedHistory = assignmentProtectedChange || context.settlement_history || context.share_history;
  const paidContextChange = settlementFactsChanged
    && context.active_payable_agreement
    && (row.status === 'paid' || nextStatus === 'paid');
  if ((paidTransition && context.required) || (settlementFactsChanged && protectedHistory) || paidContextChange) {
    return res.status(409).json({
      error: '该变更必须先走结算预览并确认',
      code: 'settlement_preview_required',
      settlement_context: context,
    });
  }

  const sets = [];
  const args = [];
  for (const field of ['label', 'node', 'due_on', 'note']) {
    if (!(field in body)) continue;
    sets.push(`${field} = ?`);
    args.push(body[field] ?? '');
  }
  if ('amount' in body) {
    sets.push('amount = ?', 'amount_fen = ?');
    args.push(nextAmount.amount, nextAmount.amount_fen);
  }
  if ('status' in body) { sets.push('status = ?'); args.push(nextStatus); }
  if ('paid_on' in body || paidOnChanged || (nextStatus === 'paid' && row.status !== 'paid')) {
    sets.push('paid_on = ?');
    args.push(nextPaidOn);
  }
  if (!sets.length) return res.status(400).json({ error: '无可更新字段' });
  if (settlementFactsChanged) sets.push('version = version + 1');

  db.prepare(`UPDATE fee_items SET ${sets.join(', ')} WHERE id = ?`).run(...args, row.id);
  audit(req.actor, 'update', 'fee', row.id, Object.keys(body).join(','));
  res.json(db.prepare('SELECT * FROM fee_items WHERE id = ?').get(row.id));
});

r.delete('/fees/:id', (req, res) => {
  const fail = (http, message, extra = {}) => {
    const error = new Error(message);
    error.http = http;
    error.extra = extra;
    throw error;
  };
  try {
    withImmediateTransaction(() => {
      const row = db.prepare('SELECT * FROM fee_items WHERE id = ?').get(req.params.id);
      if (!row) fail(404, '款项不存在');
      const voucherCount = db.prepare(
        'SELECT COUNT(*) AS count FROM fee_item_files WHERE fee_item_id=?'
      ).get(row.id).count;
      if (voucherCount) {
        fail(409, '款项仍挂有凭证，请先解除关联；案件夹原件不会被删除', {
          code: 'fee_delete_blocked_by_vouchers',
          voucher_count: voucherCount,
        });
      }
      const context = feeSettlementContext(row);
      if (context.assignment || context.settlement_history || context.linked_share) {
        fail(409, '款项已有分成方案、台账或结算历史，不能删除', {
          code: 'fee_delete_blocked_by_settlement_context',
          settlement_context: context,
        });
      }
      db.prepare('DELETE FROM fee_items WHERE id = ?').run(row.id);
      withdrawAcceptedEntityFacts('fee', row.id, {
        actor: req.actor,
        reason: '关联的正式收费后来被人工删除',
      });
      audit(req.actor, 'delete', 'fee', row.id, row.label);
    });
    res.json({ ok: true });
  } catch (error) {
    if (!error.http) throw error;
    res.status(error.http).json({ error: error.message, ...error.extra });
  }
});

export default r;
