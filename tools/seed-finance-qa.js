// 只用于本地真实 Chrome 视觉验收的脱敏资金场景。
// 必须在全新临时库运行；拒绝默认库、既有库和任何名为 anjian.db 的目标。
// 用法：
//   DB_PATH=/private/tmp/.../finance-qa.db \
//   QA_FIXTURE_PATH=/private/tmp/.../fixture.json \
//   node tools/seed-finance-qa.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const requestedDbPath = String(process.env.DB_PATH || '').trim();
const defaultDbPath = fileURLToPath(new URL('../data/anjian.db', import.meta.url));

if (!requestedDbPath) {
  console.error('拒绝运行：finance QA fixture 必须显式设置 DB_PATH，并指向全新临时库。');
  process.exit(2);
}

const resolvedDbPath = path.resolve(requestedDbPath);
if (resolvedDbPath === path.resolve(defaultDbPath) || path.basename(resolvedDbPath) === 'anjian.db') {
  console.error(`拒绝运行：finance QA fixture 不得写默认/疑似正式库 ${resolvedDbPath}`);
  process.exit(2);
}
if (fs.existsSync(resolvedDbPath)) {
  console.error(`拒绝运行：finance QA fixture 只接受不存在的全新库路径 ${resolvedDbPath}`);
  process.exit(2);
}

fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });

// DB 模块必须在上述保护之后动态加载；静态 import 会先打开默认库，令保护失效。
const [{ db }, { todayCN, addDays }, { calculateSettlementFormula }, settlementService] = await Promise.all([
  import('../src/db.js'),
  import('../src/lib/dates.js'),
  import('../src/lib/settlement.js'),
  import('../src/lib/settlement-service.js'),
]);
const { previewSettlement, confirmSettlement } = settlementService;

const today = todayCN();
const currentMonth = today.slice(0, 7);
const currentYear = Number(today.slice(0, 4));
const priorYear = currentYear - 1;
const pastDue = addDays(today, -7);
const futureDue = addDays(today, 21);
const qaToken = randomUUID();

function addCase(name, status = 'active') {
  return Number(db.prepare(
    `INSERT INTO cases (name,procedure,stage,client,status,stage_entered_at)
     VALUES (?,'一审','审理中','张三',?,?)`
  ).run(name, status, addDays(today, -30)).lastInsertRowid);
}

function addFee(caseId, label, amountFen, {
  status = 'unpaid', dueOn = futureDue, paidOn = '', node = '', note = '',
} = {}) {
  const amount = amountFen === null ? null : amountFen / 100;
  return Number(db.prepare(
    `INSERT INTO fee_items
       (case_id,label,amount,amount_fen,status,due_on,paid_on,node,note)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(caseId, label, amount, amountFen, status, dueOn, paidOn, node, note).lastInsertRowid);
}

function addAgreement(caseId, {
  direction = 'payable', counterpart, rateBps, deductions = [], provisional = false,
  pending = '', term = '收到律师费当月',
}) {
  const agreementId = Number(db.prepare(
    `INSERT INTO fee_share_agreements
       (case_id,direction,counterpart,rate,note,status,settlement_term)
     VALUES (?,?,?,?,?,'active',?)`
  ).run(
    caseId, direction, counterpart, rateBps / 100,
    provisional ? '扣费方案明确后再完善' : '', term
  ).lastInsertRowid);
  const revisionId = Number(db.prepare(
    `INSERT INTO fee_share_formula_revisions
       (agreement_id,case_id,revision_no,effective_on,label,change_note,result_kind,
        result_basis,result_rate_bps,is_provisional,pending_deductions,created_by)
     VALUES (?,?,1,?, ?,?,'rate',?,?,?,?,'qa')`
  ).run(
    agreementId, caseId, addDays(today, -19), provisional ? '暂定方案' : '当前分法',
    provisional ? '先记录比例' : '脱敏真实 Chrome 验收公式',
    deductions.length ? 'remaining' : 'gross', rateBps, provisional ? 1 : 0, pending
  ).lastInsertRowid);
  for (const [index, step] of deductions.entries()) {
    db.prepare(
      `INSERT INTO fee_share_formula_deductions
         (revision_id,sequence,label,kind,basis,rate_bps)
       VALUES (?,?,?,'rate',?,?)`
    ).run(revisionId, index + 1, step.label, step.basis, step.rate_bps);
  }
  db.prepare(
    'UPDATE fee_share_formula_revisions SET sealed=1,sealed_at=?,sealed_by=\'qa\' WHERE id=?'
  ).run(`${addDays(today, -18)} 09:00:00`, revisionId);
  return { agreementId, revisionId };
}

function assignFee(caseId, feeId, agreementId, revisionId, note = '本笔律师费参与分成') {
  return Number(db.prepare(
    `INSERT INTO fee_share_assignments
       (case_id,fee_item_id,agreement_id,status,formula_revision_id,revision_choice,decision_note)
     VALUES (?,?,?,'assigned',?,'initial',?)`
  ).run(caseId, feeId, agreementId, revisionId, note).lastInsertRowid);
}

function addManualShare({
  caseId = null, feeId = null, counterpart, amountFen, dueMonth = currentMonth,
  status = 'pending', settledOn = '', note = '', externalCase = '', entryKind = 'manual',
}) {
  return Number(db.prepare(
    `INSERT INTO fee_shares
       (case_id,external_case,fee_item_id,direction,counterpart,amount,amount_fen,
        due_month,status,settled_on,note,entry_kind)
     VALUES (?,?,?,'payable',?,?,?,?,?,?,?,?)`
  ).run(
    caseId, externalCase, feeId, counterpart, amountFen / 100, amountFen,
    dueMonth, status, settledOn, note, entryKind
  ).lastInsertRowid);
}

// 既有 v1.6 QA：暂定应收与扣费后分成，继续保留作案件页回归。
const provisionalCase = addCase('张三合同纠纷（暂定分成）');
const provisionalFee = addFee(provisionalCase, '一审代理费', 3000000, {
  node: '收到对方律师费后结算',
});
const provisionalAgreement = addAgreement(provisionalCase, {
  direction: 'receivable', counterpart: '李律师', rateBps: 3000,
  provisional: true, pending: '税费、律所费用', term: '对方收到律师费当月',
});

const assignmentCase = addCase('李四服务合同纠纷（已确认方案）');
const assignmentFee = addFee(assignmentCase, '签约代理费', 500000, {
  node: '签约后七日内支付',
});
const assignmentAgreement = addAgreement(assignmentCase, {
  counterpart: '王律师', rateBps: 5000,
  deductions: [{ label: '律所费用', basis: 'gross', rate_bps: 1800 }],
});
const assignmentId = assignFee(
  assignmentCase, assignmentFee, assignmentAgreement.agreementId, assignmentAgreement.revisionId
);
const assignmentCalculation = calculateSettlementFormula({
  base_fen: 500000,
  result_kind: 'rate', result_basis: 'remaining', result_rate_bps: 5000,
  deductions: [{ sequence: 1, label: '律所费用', kind: 'rate', basis: 'gross', rate_bps: 1800 }],
});
if (assignmentCalculation.amount_fen !== 205000) throw new Error('QA fixture calculation mismatch');

// 2.1：在办但没有任何款项的案件，必须仍出现在“记款项”案件下拉。
const emptyActiveCase = addCase('赵六买卖合同纠纷（空白在办）');

// 金额恰为 0 仍是一条真实款项，不得被误判成“从未记过款项”。
const zeroCase = addCase('郑十一零元确认案（零额非空）');
const zeroFee = addFee(zeroCase, '零元登记款', 0, {
  node: '金额经双方确认暂为零',
});

// 2.3：两条 active payable 约定均未逐款决定，主按钮应直接成为路标。
const unresolvedCase = addCase('王五委托合同纠纷（待确认分成）');
const unresolvedFee = addFee(unresolvedCase, '阶段成果款', 660000, {
  dueOn: pastDue, node: '提交代理意见后支付',
});
const unresolvedAgreementA = addAgreement(unresolvedCase, {
  counterpart: '甲律师', rateBps: 3000,
});
const unresolvedAgreementB = addAgreement(unresolvedCase, {
  counterpart: '乙律师', rateBps: 1000,
});

// 2.4：完全没有 agreement/assignment/run/share 的干净款项，用于减免→恢复闭环。
const cleanCase = addCase('赵六承揽合同纠纷（可减免）');
const cleanFee = addFee(cleanCase, '尾款', 123456, {
  dueOn: pastDue, node: '案件办结后支付', note: `finance-qa:${qaToken}`,
});

// 2.5：走正式 preview/confirm 生成不可变 snapshot + trace，再把台账正常结清。
const traceCase = addCase('孙七执行异议案（正式结算轨迹）');
const traceFee = addFee(traceCase, '执行代理费', 880000, {
  dueOn: pastDue, node: '执行立案后支付',
});
const traceAgreement = addAgreement(traceCase, {
  counterpart: '轨迹合作律师', rateBps: 5000,
  deductions: [{ label: '平台费用', basis: 'gross', rate_bps: 1000 }],
});
const traceAssignment = assignFee(
  traceCase, traceFee, traceAgreement.agreementId, traceAgreement.revisionId,
  '正式结算轨迹验收'
);
const tracePreview = previewSettlement(traceFee, {
  run_kind: 'receipt', request_id: 'qa-formal-receipt', paid_on: today,
  base_amount_fen: 880000,
});
const traceResult = confirmSettlement(traceFee, {
  ...tracePreview.request,
  fee_version: tracePreview.fee_version,
  preview_hash: tracePreview.preview_hash,
}, 'qa');
const traceShare = traceResult.shares[0];
const traceSnapshot = traceResult.snapshots[0];
db.prepare("UPDATE fee_shares SET status='settled',settled_on=? WHERE id=?").run(today, traceShare.id);

// manual/legacy 明确没有计算轨迹；费用结果带不得给出误导性的“怎么算的”。
const manualCase = addCase('周八历史款项案（人工直记）');
const manualFee = addFee(manualCase, '历史已收款', 420000, {
  status: 'paid', dueOn: addDays(today, -60), paidOn: addDays(today, -45),
  node: '历史数据补录',
});
const manualShare = addManualShare({
  caseId: manualCase, feeId: manualFee, counterpart: '人工合作律师', amountFen: 84000,
  note: '人工核对后直记，不含系统计算轨迹', entryKind: 'manual',
});

// 2.2：非 active 案件有真实款项，详情面板默认折叠。
const closedCase = addCase('钱九已结示例案（旧案折叠）', 'closed');
const closedFee = addFee(closedCase, '已结代理费', 260000, {
  status: 'paid', dueOn: addDays(today, -120), paidOn: addDays(today, -100),
});
const shelvedCase = addCase('吴十搁置示例案（旧案折叠）', 'shelved');
const shelvedFee = addFee(shelvedCase, '搁置案件首款', 180000, {
  dueOn: futureDue,
});

// 同一合作人：pending + 本年 settled 正负冲抵为 0 + 往年 settled。
// disclosure 必须按 settled.length 判断，不能因 settled_year=0 或 pending_count>0 隐身。
const historyCounterpart = '历史合作律师';
const historyPendingShare = addManualShare({
  caseId: traceCase, counterpart: historyCounterpart, amountFen: 15000,
  note: '本月仍待处理',
});
const historySettledPositive = addManualShare({
  caseId: traceCase, counterpart: historyCounterpart, amountFen: 30000,
  status: 'settled', settledOn: today, note: '本年已分正项',
});
const historySettledNegative = addManualShare({
  caseId: traceCase, counterpart: historyCounterpart, amountFen: -30000,
  status: 'settled', settledOn: today, note: '本年冲抵负项',
});
const historyPriorYear = addManualShare({
  caseId: traceCase, counterpart: historyCounterpart, amountFen: 7500,
  dueMonth: `${priorYear}-12`, status: 'settled', settledOn: `${priorYear}-12-20`,
  note: '往年已结，不应进入本年 disclosure',
});

const fixture = {
  schema_version: 1,
  qa_token: qaToken,
  generated_on: today,
  db_path: resolvedDbPath,
  cases: {
    provisional: { id: provisionalCase, name: '张三合同纠纷（暂定分成）' },
    assignment_only: { id: assignmentCase, name: '李四服务合同纠纷（已确认方案）' },
    empty_active: { id: emptyActiveCase, name: '赵六买卖合同纠纷（空白在办）' },
    zero: { id: zeroCase, name: '郑十一零元确认案（零额非空）' },
    unresolved: { id: unresolvedCase, name: '王五委托合同纠纷（待确认分成）' },
    clean: { id: cleanCase, name: '赵六承揽合同纠纷（可减免）' },
    trace: { id: traceCase, name: '孙七执行异议案（正式结算轨迹）' },
    manual: { id: manualCase, name: '周八历史款项案（人工直记）' },
    closed: { id: closedCase, name: '钱九已结示例案（旧案折叠）' },
    shelved: { id: shelvedCase, name: '吴十搁置示例案（旧案折叠）' },
  },
  fees: {
    provisional: { id: provisionalFee, label: '一审代理费' },
    assignment_only: { id: assignmentFee, label: '签约代理费', assignment_id: assignmentId },
    zero: { id: zeroFee, label: '零元登记款', amount_fen: 0 },
    unresolved: { id: unresolvedFee, label: '阶段成果款', unresolved_count: 2 },
    clean: { id: cleanFee, label: '尾款', amount_fen: 123456 },
    trace: { id: traceFee, label: '执行代理费' },
    manual: { id: manualFee, label: '历史已收款' },
    closed: { id: closedFee, label: '已结代理费' },
    shelved: { id: shelvedFee, label: '搁置案件首款' },
  },
  agreements: {
    provisional: provisionalAgreement,
    assignment_only: assignmentAgreement,
    unresolved: [unresolvedAgreementA, unresolvedAgreementB],
    trace: traceAgreement,
  },
  settlement: {
    run_id: traceResult.run.id,
    snapshot_id: traceSnapshot.id,
    share_id: traceShare.id,
    assignment_id: traceAssignment,
    counterpart: '轨迹合作律师',
  },
  manual_share: { id: manualShare, counterpart: '人工合作律师' },
  counterpart_history: {
    counterpart: historyCounterpart,
    pending_id: historyPendingShare,
    settled_ids: [historySettledPositive, historySettledNegative],
    prior_year_id: historyPriorYear,
    settled_year_fen: 0,
  },
};

const fixtureJson = JSON.stringify(fixture, null, 2) + '\n';
const fixturePath = String(process.env.QA_FIXTURE_PATH || '').trim();
if (fixturePath) {
  const resolvedFixturePath = path.resolve(fixturePath);
  fs.mkdirSync(path.dirname(resolvedFixturePath), { recursive: true });
  fs.writeFileSync(resolvedFixturePath, fixtureJson, 'utf8');
}
process.stdout.write(fixtureJson);
db.close();
