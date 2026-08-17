import { db } from '../db.js';

export function normalizeCounterpart(value) {
  return String(value ?? '').trim();
}

function overlapSql({ excludeShareId = null, legacyOnly = false } = {}) {
  return `
    SELECT id,case_id,fee_item_id,agreement_id,direction,counterpart,status,entry_kind,
           settlement_snapshot_id,is_void,cancelled_at,cancelled_by_run_id
      FROM fee_shares
     WHERE fee_item_id = ?
       AND is_void = 0 AND cancelled_at = '' AND cancelled_by_run_id IS NULL
       ${excludeShareId === null ? '' : 'AND id <> ?'}
       ${legacyOnly ? "AND settlement_snapshot_id IS NULL AND entry_kind IN ('legacy','manual')" : ''}
       AND (
         (? IS NOT NULL AND agreement_id = ?)
         OR ((? IS NULL OR agreement_id IS NULL)
             AND direction = ? AND trim(counterpart) = ?)
       )
     ORDER BY id`;
}

export function findActiveShareOverlaps({
  feeItemId,
  agreementId = null,
  direction,
  counterpart,
  excludeShareId = null,
  legacyOnly = false,
}) {
  if (feeItemId === null || feeItemId === undefined) return [];
  const args = [feeItemId];
  if (excludeShareId !== null) args.push(excludeShareId);
  args.push(
    agreementId,
    agreementId,
    agreementId,
    direction,
    normalizeCounterpart(counterpart),
  );
  return db.prepare(overlapSql({ excludeShareId, legacyOnly })).all(...args);
}

export function findActiveAgreementConflict({
  caseId,
  direction,
  counterpart,
  excludeAgreementId = null,
}) {
  const args = [caseId, direction, normalizeCounterpart(counterpart)];
  const exclude = excludeAgreementId === null ? '' : 'AND id <> ?';
  if (excludeAgreementId !== null) args.push(excludeAgreementId);
  return db.prepare(
    `SELECT id,case_id,direction,counterpart,status
       FROM fee_share_agreements
      WHERE case_id = ? AND direction = ? AND trim(counterpart) = ?
        AND status = 'active' ${exclude}
      ORDER BY id LIMIT 1`
  ).get(...args) || null;
}

export function findActiveAgreementDuplicates({ caseId, direction = null }) {
  const args = [caseId];
  const directionFilter = direction === null ? '' : 'AND direction = ?';
  if (direction !== null) args.push(direction);
  const rows = db.prepare(
    `SELECT id,direction,trim(counterpart) AS counterpart
       FROM fee_share_agreements
      WHERE case_id = ? AND status = 'active' ${directionFilter}
      ORDER BY direction,trim(counterpart),id`
  ).all(...args);
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.direction}\u0000${row.counterpart}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row.id);
  }
  return [...grouped.values()]
    .filter((agreementIds) => agreementIds.length > 1)
    .map((agreementIds) => ({ agreement_ids: agreementIds }));
}

function matchingAgreementIds({ caseId, agreementId, direction, counterpart }) {
  if (agreementId !== null && agreementId !== undefined) {
    const agreement = db.prepare(
      `SELECT id FROM fee_share_agreements
        WHERE id = ? AND case_id = ? AND direction = ? AND trim(counterpart) = ?`
    ).get(agreementId, caseId, direction, normalizeCounterpart(counterpart));
    return agreement ? [agreement.id] : [];
  }
  return db.prepare(
    `SELECT id FROM fee_share_agreements
      WHERE case_id = ? AND direction = ? AND trim(counterpart) = ? AND status = 'active'
      ORDER BY id`
  ).all(caseId, direction, normalizeCounterpart(counterpart)).map((row) => row.id);
}

export function findShareWriteConflict({
  caseId,
  feeItemId,
  agreementId = null,
  direction,
  counterpart,
  excludeShareId = null,
}) {
  const explicitAgreementIds = agreementId === null || agreementId === undefined
    ? null
    : matchingAgreementIds({ caseId, agreementId, direction, counterpart });
  if (explicitAgreementIds && !explicitAgreementIds.length) {
    return { kind: 'agreement_identity', agreement_id: agreementId };
  }
  if (feeItemId === null || feeItemId === undefined) return null;
  const shares = findActiveShareOverlaps({
    feeItemId,
    agreementId,
    direction,
    counterpart,
    excludeShareId,
  });
  if (shares.length) return { kind: 'active_share', shares };

  const agreementIds = explicitAgreementIds
    || matchingAgreementIds({ caseId, agreementId, direction, counterpart });
  if (agreementId === null && agreementIds.length) {
    return { kind: 'active_agreement', agreement_ids: agreementIds };
  }
  if (!agreementIds.length) return null;

  const marks = agreementIds.map(() => '?').join(',');
  const assignments = db.prepare(
    `SELECT id,agreement_id FROM fee_share_assignments
      WHERE fee_item_id = ? AND agreement_id IN (${marks}) ORDER BY id`
  ).all(feeItemId, ...agreementIds);
  if (assignments.length) return { kind: 'assignment', assignments };

  const snapshots = db.prepare(
    `SELECT id,agreement_id FROM fee_share_settlement_snapshots
      WHERE fee_item_id = ? AND agreement_id IN (${marks}) ORDER BY id`
  ).all(feeItemId, ...agreementIds);
  if (snapshots.length) return { kind: 'settlement_history', snapshots };
  return null;
}

export function findSettlementLegacyConflicts({ feeItemId, runKind, settlements }) {
  const found = new Map();
  for (const spec of settlements) {
    const rows = findActiveShareOverlaps({
      feeItemId,
      agreementId: spec.agreement_id,
      direction: spec.direction,
      counterpart: spec.counterpart,
      legacyOnly: true,
    });
    for (const row of rows) {
      const explicit = row.agreement_id === spec.agreement_id;
      const closed = runKind === 'correction'
        ? ['settled', 'waived'].includes(row.status)
        : runKind === 'reversal' && row.status === 'settled';
      if (runKind === 'receipt' || !explicit || !closed) {
        found.set(row.id, { ...row, target_agreement_id: spec.agreement_id });
      }
    }
  }
  return [...found.values()].sort((left, right) => left.id - right.id);
}
