import { createHash } from 'node:crypto';
import { db, audit, withImmediateTransaction } from '../db.js';
import {
  findActiveAgreementDuplicates,
  findSettlementLegacyConflicts,
} from './share-overlap.js';
import { todayCN, isDate } from './dates.js';
import {
  calculateSettlementFormula,
  fenToYuan,
  serializeSettlementFormula,
  summarizeSettlementFormula,
} from './settlement.js';
import {
  createSettlementMoneyView,
  formatSettlementMoneyFen,
  formatSettlementPercentBps,
} from './settlement-view.js';

const PLAN_STATUSES = new Set(['assigned', 'not_applicable']);
const PLAN_CHOICES = new Set(['initial', 'keep_current', 'adopt_latest', 'not_applicable']);
const RUN_KINDS = new Set(['receipt', 'correction', 'reversal']);
const PREVIEW_KEYS = new Set([
  'run_kind', 'source_run_id', 'request_id', 'base_amount_fen', 'paid_on', 'reason',
  'fee_version', 'preview_hash',
]);

export class SettlementError extends Error {
  constructor(http, code, message, extra = {}) {
    super(message);
    this.http = http;
    this.code = code;
    this.extra = extra;
  }
}

function fail(http, code, message, extra) {
  throw new SettlementError(http, code, message, extra);
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) fail(400, `${label}_invalid`, `${label} 须为正整数`);
  return number;
}

function safeFen(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail(400, `${label}_invalid`, `${label} 须为安全整数分`);
  }
  return value;
}

function text(value, label, { required = false, max = 500 } = {}) {
  const result = String(value ?? '').trim();
  if (required && !result) fail(400, `${label}_required`, `${label} 必填`);
  if (result.length > max) fail(400, `${label}_too_long`, `${label} 过长`);
  return result;
}

function safeAdd(values, label) {
  let total = 0n;
  for (const value of values) total += BigInt(value);
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    fail(409, 'settlement_amount_overflow', `${label} 超出安全整数范围`);
  }
  return Number(total);
}

function safeSubtract(left, right, label) {
  return safeAdd([left, -right], label);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashCanonical(json) {
  return createHash('sha256').update(json).digest('hex');
}

function getFee(feeId) {
  const fee = db.prepare('SELECT * FROM fee_items WHERE id = ?').get(feeId);
  if (!fee) fail(404, 'fee_not_found', '款项不存在');
  return fee;
}

function deductionRowsForRevision(revisionId) {
  return db.prepare(
    `SELECT sequence,label,kind,basis,fixed_fen,rate_bps
       FROM fee_share_formula_deductions WHERE revision_id = ? ORDER BY sequence`
  ).all(revisionId);
}

function formulaFromRevision(row, deductionRows = deductionRowsForRevision(row.id)) {
  const deductions = deductionRows.map((step) => (
    step.kind === 'fixed'
      ? { sequence: step.sequence, label: step.label, kind: step.kind, fixed_fen: step.fixed_fen }
      : { sequence: step.sequence, label: step.label, kind: step.kind, basis: step.basis, rate_bps: step.rate_bps }
  ));
  return JSON.parse(serializeSettlementFormula({
    result_kind: row.result_kind,
    ...(row.result_kind === 'fixed'
      ? { result_fixed_fen: row.result_fixed_fen }
      : { result_basis: row.result_basis, result_rate_bps: row.result_rate_bps }),
    deductions,
  }));
}

function projectionFor(formula, baseFen) {
  try {
    const calculated = calculateSettlementFormula({ base_fen: baseFen, ...formula });
    return {
      projected_amount_fen: calculated.amount_fen,
      projected_amount: fenToYuan(calculated.amount_fen),
      projected_trace: calculated.trace,
    };
  } catch (error) {
    if (baseFen === null && formula.result_kind !== 'fixed') {
      return { projected_amount_fen: null, projected_amount: null, projected_trace: null };
    }
    throw error;
  }
}

function revisionView(row, baseFen, agreement = null) {
  if (!row) return null;
  const deductions = deductionRowsForRevision(row.id);
  const formula = formulaFromRevision(row, deductions);
  const projection = projectionFor(formula, baseFen);
  return {
    ...row,
    deductions,
    formula,
    formula_json: serializeSettlementFormula(formula),
    formula_summary: summarizeSettlementFormula(formula),
    human_formula_summary: formula.result_kind === 'fixed'
      ? `固定分成 ${formatSettlementMoneyFen(formula.result_fixed_fen)}`
      : (row.is_provisional === 1
        ? `${row.pending_deductions || '前置扣费'}待确定，暂按本笔律师费的 ${formatSettlementPercentBps(formula.result_rate_bps)} 记录`
        : null),
    ...projection,
    money_view: createSettlementMoneyView({
      direction: agreement?.direction,
      counterpart: agreement?.counterpart,
      formula,
      trace: projection.projected_trace,
      baseFen,
      amountFen: projection.projected_amount_fen,
      provisional: row.is_provisional === 1,
      pendingDeductions: row.pending_deductions,
      settlementTerm: agreement?.settlement_term,
    }),
  };
}

export function enrichShareAgreementForRead(agreement, { baseFen = null } = {}) {
  if (!agreement) return null;
  const revisions = db.prepare(
    `SELECT * FROM fee_share_formula_revisions
      WHERE agreement_id = ? AND sealed = 1 ORDER BY revision_no`
  ).all(agreement.id).map((revision) => revisionView(revision, baseFen, agreement));
  return {
    ...agreement,
    revisions,
    latest_revision: revisions.at(-1) || null,
  };
}

function loadPlanBundle(fee) {
  const agreements = db.prepare(
    `SELECT * FROM fee_share_agreements
      WHERE case_id = ? AND direction = 'payable' AND status = 'active' ORDER BY id`
  ).all(fee.case_id);
  const assignments = db.prepare(
    'SELECT * FROM fee_share_assignments WHERE fee_item_id = ? ORDER BY agreement_id'
  ).all(fee.id);
  const assignmentByAgreement = new Map(assignments.map((row) => [row.agreement_id, row]));
  const unresolved = [];

  const views = agreements.map((rawAgreement) => {
    const agreement = enrichShareAgreementForRead(rawAgreement, { baseFen: fee.amount_fen });
    const revisions = agreement.revisions;
    const latestRevision = agreement.latest_revision;
    const assignment = assignmentByAgreement.get(agreement.id) || null;
    const selectedRevision = assignment?.formula_revision_id
      ? revisions.find((revision) => revision.id === assignment.formula_revision_id)
        || revisionView(db.prepare(
          'SELECT * FROM fee_share_formula_revisions WHERE id = ? AND sealed = 1'
        ).get(assignment.formula_revision_id), fee.amount_fen, agreement)
      : null;

    let issue = null;
    if (!assignment) {
      issue = { code: 'plan_missing', message: '尚未决定本款是否适用该约定' };
    } else if (assignment.status === 'assigned' && !selectedRevision) {
      issue = { code: 'pinned_revision_missing', message: '已钉公式版本不可用' };
    } else if (
      assignment.status === 'assigned'
      && latestRevision
      && selectedRevision.id !== latestRevision.id
      && assignment.updated_at <= latestRevision.sealed_at
    ) {
      issue = { code: 'revision_decision_required', message: '公式已有新版，须明确保留当前版或采用新版' };
    } else if (assignment.status === 'assigned' && selectedRevision.is_provisional === 1) {
      issue = { code: 'provisional_formula', message: '扣费方案还没确定，请先完善分成约定' };
    }

    if (issue) {
      unresolved.push({
        agreement_id: agreement.id,
        counterpart: agreement.counterpart,
        ...issue,
      });
    }

    return {
      ...agreement,
      revisions,
      latest_revision: latestRevision,
      plan: assignment ? {
        ...assignment,
        revision: selectedRevision,
        projected_amount_fen: selectedRevision?.projected_amount_fen ?? null,
        projected_amount: selectedRevision?.projected_amount ?? null,
        formula_summary: selectedRevision?.formula_summary ?? null,
      } : null,
      has_newer_revision: Boolean(
        assignment?.status === 'assigned'
        && selectedRevision
        && latestRevision
        && selectedRevision.id !== latestRevision.id
      ),
      unresolved: issue,
    };
  });

  return {
    fee,
    agreements: views,
    unresolved_active_payable_agreements: unresolved,
    write_allowed: fee.status === 'unpaid' || fee.status === 'paid',
  };
}

export function getFeeSharePlans(feeId) {
  const fee = getFee(feeId);
  if (!['unpaid', 'paid'].includes(fee.status)) {
    fail(409, 'fee_not_plannable', '只有未收或已收款项可设置分成方案');
  }
  return {
    ...loadPlanBundle(fee),
    settlement_runs: settlementHistory(fee.id),
  };
}

function decisionTimestamp(floors) {
  const floor = floors.filter(Boolean).sort().at(-1) || '';
  return db.prepare(
    `SELECT CASE
       WHEN ? <> '' AND datetime('now','+8 hours') <= ? THEN datetime(?, '+1 second')
       ELSE datetime('now','+8 hours')
     END AS value`
  ).get(floor, floor, floor).value;
}

function normalizePlanInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(400, 'share_plan_invalid', '方案须为对象');
  }
  const agreementId = positiveInteger(value.agreement_id, 'agreement_id');
  if (!PLAN_STATUSES.has(value.status)) fail(400, 'share_plan_status_invalid', 'status 只允许 assigned 或 not_applicable');
  const version = value.version === undefined || value.version === null ? null : Number(value.version);
  if (version !== null && (!Number.isInteger(version) || version < 0)) {
    fail(400, 'assignment_version_invalid', 'version 须为非负整数');
  }
  const decisionNote = text(value.decision_note, 'decision_note', { required: true });
  let revisionId = null;
  let choice = value.revision_choice;
  if (value.status === 'assigned') {
    revisionId = positiveInteger(value.formula_revision_id, 'formula_revision_id');
    if (choice !== undefined && !PLAN_CHOICES.has(choice)) {
      fail(400, 'revision_choice_invalid', 'revision_choice 非法');
    }
  } else {
    if (value.formula_revision_id !== undefined && value.formula_revision_id !== null) {
      fail(400, 'not_applicable_revision_forbidden', 'not_applicable 不得携带公式版本');
    }
    if (choice !== undefined && choice !== 'not_applicable') {
      fail(400, 'revision_choice_invalid', 'not_applicable 只能使用同名 revision_choice');
    }
    choice = 'not_applicable';
  }
  return { agreementId, status: value.status, version, decisionNote, revisionId, choice };
}

function assertNoDuplicateActivePayableAgreements(caseId) {
  const duplicates = findActiveAgreementDuplicates({ caseId, direction: 'payable' });
  if (duplicates.length) {
    fail(409, 'active_agreement_identity_conflict', '本案存在重复的有效应付约定，请先退役重复项', {
      duplicate_agreements: duplicates,
    });
  }
}

export function putFeeSharePlans(feeId, body, actor) {
  const source = Array.isArray(body?.plans) ? body.plans : [body];
  if (!source.length) fail(400, 'share_plans_empty', 'plans 不能为空');
  const inputs = source.map(normalizePlanInput);
  if (new Set(inputs.map((input) => input.agreementId)).size !== inputs.length) {
    fail(400, 'share_plan_duplicate', '同一 agreement 不能在一次请求中重复');
  }

  withImmediateTransaction(() => {
    const fee = getFee(feeId);
    if (!['unpaid', 'paid'].includes(fee.status)) {
      fail(409, 'fee_not_plannable', '只有未收或已收款项可设置分成方案');
    }
    assertNoDuplicateActivePayableAgreements(fee.case_id);

    for (const input of inputs) {
      const agreement = db.prepare(
        `SELECT * FROM fee_share_agreements
          WHERE id = ? AND case_id = ? AND direction = 'payable' AND status = 'active'`
      ).get(input.agreementId, fee.case_id);
      if (!agreement) fail(400, 'agreement_not_active_payable', '方案只允许本案 active payable 约定');
      const current = db.prepare(
        'SELECT * FROM fee_share_assignments WHERE fee_item_id = ? AND agreement_id = ?'
      ).get(fee.id, agreement.id);
      const latest = db.prepare(
        `SELECT * FROM fee_share_formula_revisions
          WHERE agreement_id = ? AND sealed = 1 ORDER BY revision_no DESC LIMIT 1`
      ).get(agreement.id);
      let selected = null;
      let choice = input.choice;

      if (input.status === 'assigned') {
        selected = db.prepare(
          `SELECT * FROM fee_share_formula_revisions
            WHERE id = ? AND agreement_id = ? AND case_id = ? AND sealed = 1`
        ).get(input.revisionId, agreement.id, fee.case_id);
        if (!selected) fail(400, 'pinned_revision_invalid', 'assigned 必须钉住同案同约定的 sealed revision');
        if (selected.is_provisional === 1) {
          fail(409, 'provisional_formula_not_assignable', '扣费方案尚未确定，暂不能用于这笔律师费结算');
        }

        if (!current || current.status === 'not_applicable') {
          choice = choice || 'initial';
          if (choice !== 'initial') fail(400, 'revision_choice_invalid', '首次 assigned 决定须使用 initial');
        } else {
          if (!choice || !['keep_current', 'adopt_latest'].includes(choice)) {
            fail(400, 'revision_choice_required', '更新 assigned 方案须明确 keep_current 或 adopt_latest');
          }
          if (choice === 'keep_current' && selected.id !== current.formula_revision_id) {
            fail(400, 'keep_current_revision_mismatch', 'keep_current 必须保留当前已钉版本');
          }
          if (choice === 'adopt_latest' && (!latest || selected.id !== latest.id)) {
            fail(400, 'adopt_latest_revision_mismatch', 'adopt_latest 必须采用最新 sealed revision');
          }
        }
      }

      if (!current) {
        if (input.version !== null && input.version !== 0) {
          fail(409, 'assignment_version_conflict', '方案尚不存在，创建版本须为 0');
        }
        const decidedAt = decisionTimestamp([latest?.sealed_at]);
        const info = db.prepare(
          `INSERT INTO fee_share_assignments
             (case_id,fee_item_id,agreement_id,status,formula_revision_id,revision_choice,
              decision_note,decided_by,created_at,updated_at,version)
           VALUES (?,?,?,?,?,?,?,?,?,?,1)`
        ).run(
          fee.case_id, fee.id, agreement.id, input.status, selected?.id ?? null, choice,
          input.decisionNote, actor, decidedAt, decidedAt
        );
        audit(actor, 'plan_create', 'share_assignment', info.lastInsertRowid,
          `fee:${fee.id};agreement:${agreement.id};choice:${choice};version:1`);
        continue;
      }

      if (input.version === null) fail(400, 'assignment_version_required', '更新方案必须提供当前 version');
      if (input.version !== current.version) {
        fail(409, 'assignment_version_conflict', '方案版本已变化，请刷新后重试', {
          expected_version: current.version,
        });
      }
      if (current.status === 'assigned' && input.status === 'not_applicable') {
        const history = db.prepare(
          'SELECT 1 FROM fee_share_settlement_snapshots WHERE fee_item_id = ? AND agreement_id = ? LIMIT 1'
        ).get(fee.id, agreement.id);
        if (history) {
          fail(409, 'settled_assignment_cannot_become_not_applicable', '已有结算历史的 assigned 方案不能改为 not_applicable');
        }
      }

      const decidedAt = decisionTimestamp([current.updated_at, latest?.sealed_at]);
      const updated = db.prepare(
        `UPDATE fee_share_assignments
            SET status = ?, formula_revision_id = ?, revision_choice = ?, decision_note = ?,
                decided_by = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND version = ?`
      ).run(
        input.status, selected?.id ?? null, choice, input.decisionNote,
        actor, decidedAt, current.id, current.version
      );
      if (!updated.changes) fail(409, 'assignment_version_conflict', '方案版本已变化，请刷新后重试');
      audit(actor, 'plan_update', 'share_assignment', current.id,
        `fee:${fee.id};agreement:${agreement.id};choice:${choice};version:${current.version + 1}`);
    }
  });

  return getFeeSharePlans(feeId);
}

function currentHead(feeId) {
  return db.prepare(
    `SELECT run.* FROM fee_share_settlement_runs run
       LEFT JOIN fee_share_settlement_runs child ON child.source_run_id = run.id
      WHERE run.fee_item_id = ? AND child.id IS NULL
      ORDER BY run.id DESC LIMIT 1`
  ).get(feeId) || null;
}

function allRuns(feeId) {
  return db.prepare(
    `SELECT id,run_kind,source_run_id,request_id,preview_hash,base_amount_fen,fee_version,
            target_status,paid_on,reason,confirmed_at
       FROM fee_share_settlement_runs WHERE fee_item_id = ? ORDER BY id`
  ).all(feeId);
}

function latestSnapshots(feeId) {
  const rows = db.prepare(
    `SELECT snapshot.* FROM fee_share_settlement_snapshots snapshot
       JOIN fee_share_settlement_runs run ON run.id = snapshot.settlement_run_id
      WHERE snapshot.fee_item_id = ? ORDER BY run.id DESC, snapshot.id DESC`
  ).all(feeId);
  const byAgreement = new Map();
  for (const row of rows) if (!byAgreement.has(row.agreement_id)) byAgreement.set(row.agreement_id, row);
  return byAgreement;
}

function ledgerState(feeId) {
  return db.prepare(
    `SELECT id,agreement_id,status,amount_fen,is_void,cancelled_at,cancelled_by_run_id,
            settlement_snapshot_id,entry_kind
       FROM fee_shares WHERE fee_item_id = ? AND settlement_snapshot_id IS NOT NULL ORDER BY id`
  ).all(feeId);
}

function pendingEngineRows(feeId, agreementId) {
  return db.prepare(
    `SELECT id,amount_fen,status FROM fee_shares
      WHERE fee_item_id = ? AND agreement_id = ? AND settlement_snapshot_id IS NOT NULL
        AND is_void = 0 AND status = 'pending' AND cancelled_at = ''
        AND cancelled_by_run_id IS NULL ORDER BY id`
  ).all(feeId, agreementId);
}

function closedAmount(feeId, agreementId, runKind) {
  const statuses = runKind === 'reversal' ? "('settled')" : "('settled','waived')";
  return db.prepare(
    `SELECT COALESCE(SUM(amount_fen), 0) AS amount_fen FROM fee_shares
      WHERE fee_item_id = ? AND agreement_id = ?
        AND (settlement_snapshot_id IS NOT NULL OR entry_kind IN ('legacy','manual'))
        AND is_void = 0 AND cancelled_at = '' AND cancelled_by_run_id IS NULL
        AND status IN ${statuses}`
  ).get(feeId, agreementId).amount_fen;
}

function normalizeSettlementRequest(fee, body, head) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  for (const key of Object.keys(input)) {
    if (!PREVIEW_KEYS.has(key)) fail(400, 'settlement_input_invalid', `不接受字段 ${key}`);
  }
  if (!RUN_KINDS.has(input.run_kind)) fail(400, 'run_kind_invalid', 'run_kind 非法');
  if (input.fee_version !== undefined && Number(input.fee_version) !== fee.version) {
    fail(409, 'fee_version_conflict', '款项版本已变化，请重新预览', { expected_version: fee.version });
  }

  const requestId = text(input.request_id, 'request_id', { max: 200 });
  const reason = text(input.reason, 'reason');
  const suppliedSource = input.source_run_id === undefined || input.source_run_id === null
    ? null
    : positiveInteger(input.source_run_id, 'source_run_id');
  let sourceRunId = null;
  let targetStatus;
  let paidOn = '';
  let baseAmountFen;

  if (input.run_kind === 'receipt') {
    if (head) fail(409, 'receipt_already_exists', '已有结算历史，不能创建第二个 receipt');
    if (!['unpaid', 'paid'].includes(fee.status)) fail(409, 'fee_status_conflict', '当前款项状态不能确认收讫');
    if (suppliedSource !== null) fail(400, 'receipt_source_forbidden', 'receipt 不得携带 source_run_id');
    targetStatus = 'paid';
    paidOn = input.paid_on === undefined ? (fee.paid_on || todayCN()) : String(input.paid_on || '');
    baseAmountFen = input.base_amount_fen === undefined
      ? fee.amount_fen
      : safeFen(input.base_amount_fen, 'base_amount_fen', true);
  } else {
    if (!head) fail(409, 'settlement_source_missing', '尚无可更正或冲销的结算记录');
    sourceRunId = suppliedSource ?? head.id;
    if (sourceRunId !== head.id) {
      fail(409, 'settlement_source_stale', 'source_run_id 不是当前历史链末端', { expected_source_run_id: head.id });
    }

    if (input.run_kind === 'correction') {
      if (!reason) fail(400, 'reason_required', 'correction 必须填写 reason');
      if (!requestId) fail(400, 'request_id_required', 'correction 必须填写 request_id');
      const expectedStatus = head.target_status;
      if (fee.status !== expectedStatus) fail(409, 'fee_status_conflict', '款项状态与结算历史链不一致');
      targetStatus = 'paid';
      paidOn = input.paid_on === undefined ? (fee.paid_on || todayCN()) : String(input.paid_on || '');
      baseAmountFen = input.base_amount_fen === undefined
        ? fee.amount_fen
        : safeFen(input.base_amount_fen, 'base_amount_fen', true);
    } else {
      if (!reason) fail(400, 'reason_required', 'reversal 必须填写 reason');
      if (!requestId) fail(400, 'request_id_required', 'reversal 必须填写 request_id');
      if (head.target_status !== 'paid' || !['receipt', 'correction'].includes(head.run_kind)) {
        fail(409, 'reversal_source_invalid', 'reversal 只能接在 paid receipt/correction 后');
      }
      if (fee.status !== 'paid') fail(409, 'fee_status_conflict', '只有已收款项可冲销');
      if (input.base_amount_fen !== undefined) {
        const suppliedBase = safeFen(input.base_amount_fen, 'base_amount_fen', true);
        if (suppliedBase !== head.base_amount_fen) {
          fail(400, 'reversal_base_forbidden', 'reversal 必须沿用 source base');
        }
      }
      if (input.paid_on !== undefined && input.paid_on !== '') fail(400, 'reversal_paid_on_forbidden', 'reversal 的 paid_on 必须为空');
      targetStatus = 'unpaid';
      baseAmountFen = head.base_amount_fen;
    }
  }

  if (targetStatus === 'paid' && !isDate(paidOn)) fail(400, 'paid_on_invalid', 'paid_on 须为 YYYY-MM-DD');
  if (baseAmountFen !== null) safeFen(baseAmountFen, 'base_amount_fen');
  return {
    run_kind: input.run_kind,
    source_run_id: sourceRunId,
    request_id: requestId,
    base_amount_fen: baseAmountFen,
    target_status: targetStatus,
    paid_on: paidOn,
    reason,
  };
}

function historicalCorrectionAgreements(fee, request, bundle, priorSnapshots) {
  if (request.run_kind !== 'correction') return [];
  const activeIds = new Set(bundle.agreements.map((agreement) => agreement.id));
  return [...priorSnapshots.keys()]
    .filter((agreementId) => !activeIds.has(agreementId))
    .map((agreementId) => {
      const rawAgreement = db.prepare(
        `SELECT * FROM fee_share_agreements
          WHERE id = ? AND case_id = ? AND direction = 'payable' AND status = 'retired'`
      ).get(agreementId, fee.case_id);
      const assignment = db.prepare(
        `SELECT * FROM fee_share_assignments
          WHERE fee_item_id = ? AND agreement_id = ? AND status = 'assigned'`
      ).get(fee.id, agreementId);
      if (!rawAgreement || !assignment) {
        fail(409, 'settlement_history_plan_conflict', '历史结算约定缺少可沿用的退役 assigned 方案', {
          agreement_ids: [agreementId],
        });
      }
      const agreement = enrichShareAgreementForRead(rawAgreement, { baseFen: request.base_amount_fen });
      const revision = agreement.revisions.find((item) => item.id === assignment.formula_revision_id)
        || revisionView(db.prepare(
          `SELECT * FROM fee_share_formula_revisions
            WHERE id = ? AND agreement_id = ? AND case_id = ? AND sealed = 1`
        ).get(assignment.formula_revision_id, agreement.id, fee.case_id), request.base_amount_fen, agreement);
      if (!revision) fail(409, 'pinned_revision_missing', '退役历史约定的已钉公式版本不可用');
      return {
        ...agreement,
        plan: {
          ...assignment,
          revision,
          projected_amount_fen: revision.projected_amount_fen,
          projected_amount: revision.projected_amount,
          formula_summary: revision.formula_summary,
        },
        historical_retired: true,
      };
    });
}

function assignedSettlementSpecs(fee, request, bundle) {
  if (bundle.unresolved_active_payable_agreements.length) {
    fail(409, 'settlement_plan_unresolved', '尚有 active payable 约定未完成方案决定', {
      unresolved_active_payable_agreements: bundle.unresolved_active_payable_agreements,
    });
  }
  const priorSnapshots = latestSnapshots(fee.id);
  const settlementAgreements = [
    ...bundle.agreements,
    ...historicalCorrectionAgreements(fee, request, bundle, priorSnapshots),
  ];

  return settlementAgreements.flatMap((agreement) => {
    const plan = agreement.plan;
    if (!plan || plan.status === 'not_applicable') return [];
    const revision = plan.revision;
    if (!revision) fail(409, 'pinned_revision_missing', '已钉公式版本不可用');
    let calculation;
    try {
      calculation = calculateSettlementFormula({ base_fen: request.base_amount_fen, ...revision.formula });
    } catch (error) {
      if (request.base_amount_fen === null) {
        fail(409, 'settlement_base_required', '比例公式需要确定的款项金额');
      }
      throw error;
    }
    const closedFen = request.run_kind === 'receipt' ? 0 : closedAmount(fee.id, agreement.id, 'correction');
    const source = request.run_kind === 'receipt' ? null : (priorSnapshots.get(agreement.id) || null);
    const pendingRows = request.run_kind === 'receipt' ? [] : pendingEngineRows(fee.id, agreement.id);
    return [{
      agreement_id: agreement.id,
      agreement_version: agreement.version,
      agreement_status: agreement.status,
      assignment_id: plan.id,
      plan_version: plan.version,
      revision_choice: plan.revision_choice,
      formula_revision_id: revision.id,
      revision_no: revision.revision_no,
      direction: 'payable',
      counterpart: agreement.counterpart,
      formula: revision.formula,
      formula_json: revision.formula_json,
      formula_summary: revision.formula_summary,
      trace: calculation.trace,
      trace_json: JSON.stringify(calculation.trace),
      base_amount_fen: request.base_amount_fen,
      desired_amount_fen: calculation.amount_fen,
      closed_amount_fen: closedFen,
      new_amount_fen: safeSubtract(calculation.amount_fen, closedFen, '结算调整金额'),
      entry_kind: request.run_kind === 'receipt' ? 'calculated' : 'adjustment',
      due_month: request.paid_on.slice(0, 7),
      source_snapshot_id: source?.id ?? null,
      pending_share_ids: pendingRows.map((row) => row.id),
    }];
  });
}

function reversalSettlementSpecs(fee, request, head) {
  const sourceSnapshots = db.prepare(
    'SELECT * FROM fee_share_settlement_snapshots WHERE settlement_run_id = ? ORDER BY agreement_id'
  ).all(head.id);
  return sourceSnapshots.map((source) => {
    const assignment = db.prepare(
      'SELECT id FROM fee_share_assignments WHERE id = ? AND fee_item_id = ? AND agreement_id = ?'
    ).get(source.assignment_id, fee.id, source.agreement_id);
    if (!assignment) {
      fail(409, 'settlement_source_plan_conflict', 'source snapshot 的方案身份不可用，不能冲销');
    }
    if (source.base_amount_fen !== request.base_amount_fen) {
      fail(409, 'settlement_source_base_conflict', 'source snapshots 的基数与 source run 不一致');
    }
    const closedFen = closedAmount(fee.id, source.agreement_id, 'reversal');
    const pendingRows = pendingEngineRows(fee.id, source.agreement_id);
    const formula = JSON.parse(source.formula_json);
    const trace = JSON.parse(source.trace_json);
    return {
      agreement_id: source.agreement_id,
      assignment_id: source.assignment_id,
      plan_version: source.plan_version,
      revision_choice: 'source',
      formula_revision_id: source.formula_revision_id,
      revision_no: db.prepare('SELECT revision_no FROM fee_share_formula_revisions WHERE id = ?')
        .get(source.formula_revision_id).revision_no,
      direction: source.direction,
      counterpart: source.counterpart,
      formula,
      formula_json: source.formula_json,
      formula_summary: summarizeSettlementFormula(formula),
      trace,
      trace_json: source.trace_json,
      base_amount_fen: source.base_amount_fen,
      desired_amount_fen: 0,
      closed_amount_fen: closedFen,
      new_amount_fen: safeSubtract(0, closedFen, '冲销调整金额'),
      entry_kind: 'adjustment',
      due_month: source.due_month,
      source_snapshot_id: source.id,
      pending_share_ids: pendingRows.map((row) => row.id),
    };
  });
}

function settlementPublic(spec) {
  return {
    agreement_id: spec.agreement_id,
    agreement_version: spec.agreement_version ?? null,
    agreement_status: spec.agreement_status ?? null,
    assignment_id: spec.assignment_id,
    plan_version: spec.plan_version,
    revision_choice: spec.revision_choice,
    formula_revision_id: spec.formula_revision_id,
    revision_no: spec.revision_no,
    counterpart: spec.counterpart,
    formula: spec.formula,
    formula_summary: spec.formula_summary,
    trace: spec.trace,
    base_amount_fen: spec.base_amount_fen,
    base_amount: spec.base_amount_fen === null ? null : fenToYuan(spec.base_amount_fen),
    desired_amount_fen: spec.desired_amount_fen,
    desired_amount: fenToYuan(spec.desired_amount_fen),
    closed_amount_fen: spec.closed_amount_fen,
    closed_amount: fenToYuan(spec.closed_amount_fen),
    new_amount_fen: spec.new_amount_fen,
    new_amount: fenToYuan(spec.new_amount_fen),
    entry_kind: spec.entry_kind,
    due_month: spec.due_month,
    source_snapshot_id: spec.source_snapshot_id,
    money_view: createSettlementMoneyView({
      direction: spec.direction,
      counterpart: spec.counterpart,
      formula: spec.formula,
      trace: spec.trace,
      baseFen: spec.base_amount_fen,
      amountFen: spec.desired_amount_fen,
      settlementTerm: `收到律师费的 ${spec.due_month}`,
    }),
  };
}

function buildPreview(feeId, body) {
  const fee = getFee(feeId);
  const head = currentHead(fee.id);
  const request = normalizeSettlementRequest(fee, body, head);
  if (request.run_kind !== 'reversal') {
    assertNoDuplicateActivePayableAgreements(fee.case_id);
  }
  const bundle = loadPlanBundle(fee);
  const settlements = request.run_kind === 'reversal'
    ? reversalSettlementSpecs(fee, request, head)
    : assignedSettlementSpecs(fee, request, bundle);

  if (request.run_kind !== 'reversal' || settlements.length) {
    const legacyConflicts = findSettlementLegacyConflicts({
      feeItemId: fee.id,
      runKind: request.run_kind,
      settlements,
    });
    if (legacyConflicts.length) {
      fail(409, 'legacy_share_adoption_conflict', '该款已有重叠的 legacy/manual 分成，须先完成人工修复', {
        shares: legacyConflicts,
      });
    }
  }

  const canonical = {
    schema: 'fee-settlement-preview-v1',
    fee: {
      id: fee.id,
      case_id: fee.case_id,
      version: fee.version,
      status: fee.status,
      amount_fen: fee.amount_fen,
      paid_on: fee.paid_on,
    },
    request,
    agreements: bundle.agreements.map((agreement) => ({
      id: agreement.id,
      version: agreement.version,
      status: agreement.status,
      direction: agreement.direction,
      counterpart: agreement.counterpart,
      latest_revision: agreement.latest_revision ? {
        id: agreement.latest_revision.id,
        revision_no: agreement.latest_revision.revision_no,
        sealed_at: agreement.latest_revision.sealed_at,
      } : null,
      plan: agreement.plan ? {
        id: agreement.plan.id,
        status: agreement.plan.status,
        version: agreement.plan.version,
        formula_revision_id: agreement.plan.formula_revision_id,
        revision_choice: agreement.plan.revision_choice,
        updated_at: agreement.plan.updated_at,
        formula: agreement.plan.revision?.formula ?? null,
      } : null,
    })),
    history: allRuns(fee.id),
    ledger: ledgerState(fee.id),
    settlements: settlements.map((spec) => ({
      agreement_id: spec.agreement_id,
      agreement_version: spec.agreement_version ?? null,
      agreement_status: spec.agreement_status ?? null,
      assignment_id: spec.assignment_id,
      plan_version: spec.plan_version,
      formula_revision_id: spec.formula_revision_id,
      revision_choice: spec.revision_choice,
      source_snapshot_id: spec.source_snapshot_id,
      direction: spec.direction,
      counterpart: spec.counterpart,
      formula: spec.formula,
      trace: spec.trace,
      base_amount_fen: spec.base_amount_fen,
      desired_amount_fen: spec.desired_amount_fen,
      closed_amount_fen: spec.closed_amount_fen,
      new_amount_fen: spec.new_amount_fen,
      pending_share_ids: spec.pending_share_ids,
      due_month: spec.due_month,
    })),
  };
  const previewInputsJson = canonicalJson(canonical);
  const previewHash = hashCanonical(previewInputsJson);
  const publicSettlements = settlements.map(settlementPublic);
  const publicRequest = {
    run_kind: request.run_kind,
    source_run_id: request.source_run_id,
    request_id: request.request_id,
    base_amount_fen: request.base_amount_fen,
    paid_on: request.paid_on,
    reason: request.reason,
  };
  const totals = {
    desired_amount_fen: safeAdd(settlements.map((spec) => spec.desired_amount_fen), '目标分成合计'),
    closed_amount_fen: safeAdd(settlements.map((spec) => spec.closed_amount_fen), '已关闭分成合计'),
    new_amount_fen: safeAdd(settlements.map((spec) => spec.new_amount_fen), '新增分成合计'),
  };

  return {
    fee,
    request,
    settlements,
    preview_inputs_json: previewInputsJson,
    response: {
      preview_hash: previewHash,
      fee_version: fee.version,
      fee: {
        ...fee,
        target_status: request.target_status,
        target_amount_fen: request.base_amount_fen,
        target_amount: request.base_amount_fen === null ? null : fenToYuan(request.base_amount_fen),
        target_paid_on: request.paid_on,
      },
      request: publicRequest,
      settlements: publicSettlements,
      totals: {
        ...totals,
        desired_amount: fenToYuan(totals.desired_amount_fen),
        closed_amount: fenToYuan(totals.closed_amount_fen),
        new_amount: fenToYuan(totals.new_amount_fen),
      },
    },
  };
}

export function previewSettlement(feeId, body) {
  return buildPreview(feeId, body).response;
}

function runResult(runId, idempotent = false) {
  const run = db.prepare('SELECT * FROM fee_share_settlement_runs WHERE id = ?').get(runId);
  if (!run) fail(404, 'settlement_run_not_found', '结算记录不存在');
  const snapshots = db.prepare(
    'SELECT * FROM fee_share_settlement_snapshots WHERE settlement_run_id = ? ORDER BY agreement_id'
  ).all(run.id).map((snapshot) => {
    const formula = JSON.parse(snapshot.formula_json);
    return {
      ...snapshot,
      formula,
      formula_summary: summarizeSettlementFormula(formula),
      trace: JSON.parse(snapshot.trace_json),
      base_amount: snapshot.base_amount_fen === null ? null : fenToYuan(snapshot.base_amount_fen),
      desired_amount: fenToYuan(snapshot.desired_amount_fen),
      closed_amount: fenToYuan(snapshot.closed_amount_fen),
      new_amount: fenToYuan(snapshot.new_amount_fen),
    };
  });
  const shares = db.prepare(
    `SELECT share.* FROM fee_shares share
       JOIN fee_share_settlement_snapshots snapshot ON snapshot.id = share.settlement_snapshot_id
      WHERE snapshot.settlement_run_id = ? ORDER BY share.id`
  ).all(run.id);
  return {
    idempotent,
    fee: db.prepare('SELECT * FROM fee_items WHERE id = ?').get(run.fee_item_id),
    run: { ...run, preview_inputs: JSON.parse(run.preview_inputs_json) },
    snapshots,
    shares,
  };
}

function idempotentInputMatches(run, body) {
  const stored = JSON.parse(run.preview_inputs_json);
  const request = stored.request || {};
  const supplied = body || {};
  if (supplied.run_kind !== run.run_kind) return false;
  for (const key of ['source_run_id', 'request_id', 'base_amount_fen', 'paid_on', 'reason']) {
    if (key in supplied && supplied[key] !== request[key]) return false;
  }
  if ('fee_version' in supplied && Number(supplied.fee_version) !== stored.fee?.version) return false;
  return true;
}

export function confirmSettlement(feeId, body, actor) {
  const expectedHash = text(body?.preview_hash, 'preview_hash', { required: true, max: 128 });
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) fail(400, 'preview_hash_invalid', 'preview_hash 非法');
  if (!Number.isInteger(body?.fee_version) || body.fee_version <= 0) {
    fail(400, 'fee_version_required', '确认结算必须提供 preview 返回的 fee_version');
  }
  const runKind = body?.run_kind;
  if (!RUN_KINDS.has(runKind)) fail(400, 'run_kind_invalid', 'run_kind 非法');
  const requestId = text(body?.request_id, 'request_id', { max: 200 });

  return withImmediateTransaction(() => {
    if (requestId) {
      const byRequest = db.prepare(
        'SELECT * FROM fee_share_settlement_runs WHERE request_id = ?'
      ).get(requestId);
      if (byRequest) {
        if (
          byRequest.fee_item_id !== Number(feeId)
          || byRequest.run_kind !== runKind
          || byRequest.preview_hash !== expectedHash
          || !idempotentInputMatches(byRequest, body)
        ) {
          fail(409, 'settlement_idempotency_conflict', 'request_id 已用于不同结算请求');
        }
        return runResult(byRequest.id, true);
      }
    }
    const byHash = db.prepare(
      `SELECT * FROM fee_share_settlement_runs
        WHERE fee_item_id = ? AND run_kind = ? AND preview_hash = ?`
    ).get(feeId, runKind, expectedHash);
    if (byHash) {
      if (!idempotentInputMatches(byHash, body)) {
        fail(409, 'settlement_idempotency_conflict', 'preview_hash 对应不同结算请求');
      }
      return runResult(byHash.id, true);
    }

    const preview = buildPreview(feeId, body);
    if (preview.response.preview_hash !== expectedHash) {
      fail(409, 'settlement_preview_stale', '结算事实已变化，请重新预览', {
        current_preview_hash: preview.response.preview_hash,
        fee_version: preview.fee.version,
      });
    }

    const fee = preview.fee;
    const request = preview.request;
    const projectedAmount = request.base_amount_fen === null ? null : fenToYuan(request.base_amount_fen);
    const updated = db.prepare(
      `UPDATE fee_items
          SET amount = ?, amount_fen = ?, status = ?, paid_on = ?, version = version + 1
        WHERE id = ? AND version = ?`
    ).run(
      projectedAmount, request.base_amount_fen, request.target_status, request.paid_on,
      fee.id, fee.version
    );
    if (!updated.changes) fail(409, 'fee_version_conflict', '款项版本已变化，请重新预览');

    const runInfo = db.prepare(
      `INSERT INTO fee_share_settlement_runs
         (case_id,fee_item_id,run_kind,source_run_id,request_id,preview_hash,
          preview_inputs_json,base_amount_fen,fee_version,target_status,paid_on,reason,confirmed_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      fee.case_id, fee.id, request.run_kind, request.source_run_id, request.request_id,
      expectedHash, preview.preview_inputs_json, request.base_amount_fen, fee.version,
      request.target_status, request.paid_on, request.reason, actor
    );
    const runId = Number(runInfo.lastInsertRowid);
    const snapshotIds = new Map();

    for (const spec of preview.settlements) {
      const info = db.prepare(
        `INSERT INTO fee_share_settlement_snapshots
           (settlement_run_id,case_id,fee_item_id,agreement_id,formula_revision_id,
            assignment_id,plan_version,revision_choice,source_snapshot_id,direction,counterpart,
            formula_json,trace_json,base_amount_fen,desired_amount_fen,closed_amount_fen,
            new_amount_fen,entry_kind,due_month)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        runId, fee.case_id, fee.id, spec.agreement_id, spec.formula_revision_id,
        spec.assignment_id, spec.plan_version, spec.revision_choice, spec.source_snapshot_id,
        spec.direction, spec.counterpart, spec.formula_json, spec.trace_json,
        spec.base_amount_fen, spec.desired_amount_fen, spec.closed_amount_fen,
        spec.new_amount_fen, spec.entry_kind, spec.due_month
      );
      snapshotIds.set(spec.agreement_id, Number(info.lastInsertRowid));
    }

    if (request.run_kind !== 'receipt') {
      for (const spec of preview.settlements) {
        const cancelled = db.prepare(
          `UPDATE fee_shares
              SET cancelled_at = datetime('now','+8 hours'),
                  cancel_reason = ?, cancelled_by_run_id = ?
            WHERE fee_item_id = ? AND agreement_id = ? AND settlement_snapshot_id IS NOT NULL
              AND status = 'pending' AND is_void = 0 AND cancelled_at = ''
              AND cancelled_by_run_id IS NULL`
        ).run(`由 settlement run ${runId} 取代：${request.reason}`, runId, fee.id, spec.agreement_id);
        if (cancelled.changes !== spec.pending_share_ids.length) {
          fail(409, 'settlement_ledger_stale', '待处理分成台账已变化，请重新预览');
        }
      }
    }

    for (const spec of preview.settlements) {
      if (spec.new_amount_fen === 0) continue;
      db.prepare(
        `INSERT INTO fee_shares
           (case_id,agreement_id,fee_item_id,assignment_id,settlement_snapshot_id,entry_kind,
            direction,counterpart,base_amount,base_amount_fen,amount,amount_fen,due_month,note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        fee.case_id, spec.agreement_id, fee.id, spec.assignment_id,
        snapshotIds.get(spec.agreement_id), spec.entry_kind, spec.direction, spec.counterpart,
        spec.base_amount_fen === null ? null : fenToYuan(spec.base_amount_fen), spec.base_amount_fen,
        fenToYuan(spec.new_amount_fen), spec.new_amount_fen, spec.due_month,
        `settlement run ${runId}`
      );
    }

    audit(actor, 'settlement_confirm', 'fee_settlement', runId,
      `fee:${fee.id};kind:${request.run_kind};source:${request.source_run_id ?? ''};fee_version:${fee.version};snapshots:${preview.settlements.length}`);
    return runResult(runId, false);
  });
}

function actualShares(feeId) {
  return db.prepare(
    `SELECT id,fee_item_id,agreement_id,direction,counterpart,amount,amount_fen,status,
            due_month,settled_on,entry_kind,settlement_snapshot_id
       FROM fee_shares
      WHERE fee_item_id = ? AND is_void = 0 AND cancelled_at = ''
        AND cancelled_by_run_id IS NULL ORDER BY id`
  ).all(feeId);
}

function settlementHistory(feeId) {
  return db.prepare(
    `SELECT id,run_kind,source_run_id,request_id,base_amount_fen,fee_version,target_status,
            paid_on,reason,confirmed_by,confirmed_at
       FROM fee_share_settlement_runs WHERE fee_item_id = ? ORDER BY id`
  ).all(feeId).map((run) => ({
    ...run,
    base_amount: run.base_amount_fen === null ? null : fenToYuan(run.base_amount_fen),
    snapshots: db.prepare(
      `SELECT snapshot.id,snapshot.agreement_id,snapshot.assignment_id,snapshot.formula_revision_id,
              revision.revision_no,snapshot.plan_version,snapshot.revision_choice,
              snapshot.direction,snapshot.counterpart,snapshot.formula_json,snapshot.trace_json,
              snapshot.base_amount_fen,snapshot.desired_amount_fen,snapshot.closed_amount_fen,
              snapshot.new_amount_fen,snapshot.entry_kind,snapshot.due_month
         FROM fee_share_settlement_snapshots snapshot
         JOIN fee_share_formula_revisions revision ON revision.id = snapshot.formula_revision_id
        WHERE snapshot.settlement_run_id = ? ORDER BY snapshot.agreement_id`
    ).all(run.id).map((snapshot) => {
      const formula = JSON.parse(snapshot.formula_json);
      return {
        ...snapshot,
        formula,
        formula_summary: summarizeSettlementFormula(formula),
        trace: JSON.parse(snapshot.trace_json),
        base_amount: snapshot.base_amount_fen === null ? null : fenToYuan(snapshot.base_amount_fen),
        desired_amount: fenToYuan(snapshot.desired_amount_fen),
        closed_amount: fenToYuan(snapshot.closed_amount_fen),
        new_amount: fenToYuan(snapshot.new_amount_fen),
        money_view: createSettlementMoneyView({
          direction: snapshot.direction,
          counterpart: snapshot.counterpart,
          formula,
          trace: JSON.parse(snapshot.trace_json),
          baseFen: snapshot.base_amount_fen,
          amountFen: snapshot.desired_amount_fen,
          settlementTerm: `结算月份 ${snapshot.due_month}`,
        }),
      };
    }),
  }));
}

export function enrichFeeForRead(fee, shares = null, settlementContext = null) {
  const bundle = loadPlanBundle(fee);
  return {
    ...fee,
    shares: shares || actualShares(fee.id),
    share_plans: bundle.agreements,
    unresolved_active_payable_agreements: bundle.unresolved_active_payable_agreements,
    settlement_runs: settlementHistory(fee.id),
    settlement_context: settlementContext || feeSettlementContext(fee),
  };
}

export function feeSettlementContext(fee) {
  const facts = db.prepare(
    `SELECT
       EXISTS(SELECT 1 FROM fee_share_agreements
               WHERE case_id = ? AND direction = 'payable' AND status = 'active') AS active_payable,
       EXISTS(SELECT 1 FROM fee_share_assignments WHERE fee_item_id = ?) AS assignment,
       EXISTS(SELECT 1 FROM fee_share_settlement_runs WHERE fee_item_id = ?) AS settlement_history,
       EXISTS(SELECT 1 FROM fee_shares WHERE fee_item_id = ? AND is_void = 0) AS share_history,
       EXISTS(SELECT 1 FROM fee_shares WHERE fee_item_id = ?) AS linked_share`
  ).get(fee.case_id, fee.id, fee.id, fee.id, fee.id);
  return {
    active_payable_agreement: Boolean(facts.active_payable),
    assignment: Boolean(facts.assignment),
    settlement_history: Boolean(facts.settlement_history),
    share_history: Boolean(facts.share_history),
    linked_share: Boolean(facts.linked_share),
    required: Boolean(facts.active_payable || facts.assignment || facts.settlement_history || facts.share_history),
  };
}
