// 演示种子（全脱敏：张三/李四/王五/示例格式）。只用于 dev/演示库，禁对生产库跑。
// 用法：DB_PATH=data/demo.db node tools/seed-demo.js
import { db } from '../src/db.js';
import { todayCN, addDays } from '../src/lib/dates.js';

if ((process.env.DB_PATH || '').includes('anjian.db')) {
  console.error('拒绝对疑似生产库跑种子。请用 DB_PATH=data/demo.db');
  process.exit(1);
}

const today = todayCN();
const D = (n) => addDays(today, n);

const insCase = db.prepare(`INSERT INTO cases (name, case_no, cause, court, client, client_role, opponent, procedure, stage, stage_entered_at, accepted_at)
  VALUES (@name, @case_no, @cause, @court, @client, @client_role, @opponent, @procedure, @stage, @stage_entered_at, @accepted_at)`);
const insEvent = db.prepare(`INSERT INTO events (case_id, type, occurred_on, service_method, instrument, note) VALUES (?, ?, ?, ?, ?, ?)`);
const insDl = db.prepare(`INSERT INTO deadlines (case_id, name, due_on, basis, calc_note, is_manual_override, severity) VALUES (?, ?, ?, ?, ?, 1, ?)`);
const insTask = db.prepare(`INSERT INTO tasks (case_id, title, plan_date, due_on, priority) VALUES (?, ?, ?, ?, ?)`);
const insLog = db.prepare(`INSERT INTO worklog (case_id, worked_on, content, minutes) VALUES (?, ?, ?, ?)`);
const insInbox = db.prepare(`INSERT INTO inbox (kind, payload, source, source_ref, case_id) VALUES (?, ?, ?, ?, ?)`);
const insFee = db.prepare(`INSERT INTO fee_items (case_id, label, amount, node, due_on, status, paid_on, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const insAgreement = db.prepare(`INSERT INTO fee_share_agreements
  (case_id, direction, counterpart, rate, settlement_term, note) VALUES (?, ?, ?, ?, ?, ?)`);
const insShare = db.prepare(`INSERT INTO fee_shares
  (case_id, fee_item_id, agreement_id, direction, counterpart, base_amount, amount, due_month, status, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const c1 = insCase.run({
  name: '张三诉李四民间借贷纠纷', case_no: '(2026)粤0305民初10001号', cause: '民间借贷纠纷',
  court: '深圳市南山区人民法院', client: '张三', client_role: '原告', opponent: '李四',
  procedure: '一审', stage: '待裁判', stage_entered_at: D(-12), accepted_at: D(-90),
}).lastInsertRowid;
insEvent.run(c1, 'filed', D(-75), '', '', '网上立案通过');
insEvent.run(c1, 'evidence_notice', D(-60), '直接送达', '', '');
insEvent.run(c1, 'hearing', D(-12), '', '', '第一次开庭，已质证');
insEvent.run(c1, 'judgment_served', D(-13), '邮寄送达', '(2026)粤0305民初10001号民事判决书', '部分胜诉');
insDl.run(c1, '上诉期（判决）', D(2), '民诉法 §171', `${D(-13)} 邮寄送达，次日起算 15 日（演示数据，非引擎推算）`, 'critical');
insTask.run(c1, '与张三确认是否上诉', D(0), D(1), 'high');
insLog.run(c1, D(-1), '研读一审判决，梳理上诉利弊备忘', 90);
const c1PaidFee = insFee.run(c1, '签约首款', 30000, '签订委托合同', D(-88), 'paid', D(-86), '演示：已开具收款凭证').lastInsertRowid;
insFee.run(c1, '一审代理费尾款', 20000, '第一次开庭后', D(-8), 'unpaid', '', '演示：已到期待收');
insFee.run(c1, '执行回款奖励', null, '实际执行回款后', '', 'unpaid', '', '演示：金额待确定');
const c1Agreement = insAgreement.run(c1, 'payable', '周律师', 15, '收到律师费当月', '演示合作分成').lastInsertRowid;
insShare.run(c1, c1PaidFee, c1Agreement, 'payable', '周律师', 30000, 4500, today.slice(0, 7), 'pending', '演示：待结算分成');

const c2 = insCase.run({
  name: '王五诉赵六买卖合同纠纷', case_no: '(2026)粤0304民初20002号', cause: '买卖合同纠纷',
  court: '深圳市福田区人民法院', client: '王五', client_role: '被告代理', opponent: '赵六',
  procedure: '一审', stage: '举证', stage_entered_at: D(-40), accepted_at: D(-55),
}).lastInsertRowid;
insEvent.run(c2, 'served', D(-20), '直接送达', '', '收到起诉状副本及应诉通知');
insEvent.run(c2, 'evidence_notice', D(-20), '直接送达', '', '举证期限 30 日');
insEvent.run(c2, 'hearing', D(3), '', '(2026)粤0304民初20002号传票', '第一次开庭');
insDl.run(c2, '举证期限届满', D(6), '法院指定', '举证通知载明 30 日（演示数据）', 'high');
insTask.run(c2, '整理反驳证据清单', D(-2), '', 'high');
insTask.run(c2, '拟质证意见', '', D(5), 'normal');
insLog.run(c2, D(-3), '会见王五核对交易流水', 120);
insFee.run(c2, '受理后首款', 15000, '法院受理', D(-45), 'paid', D(-44), '演示：已收');
insFee.run(c2, '开庭前代理费', 25000, '第一次开庭前', D(2), 'unpaid', '', '演示：即将到期');

const c3 = insCase.run({
  name: '陈七申请执行案', case_no: '(2026)粤0305执30003号', cause: '合同纠纷执行',
  court: '深圳市南山区人民法院', client: '陈七', client_role: '申请执行人', opponent: '孙八',
  procedure: '执行', stage: '财产调查', stage_entered_at: D(-50), accepted_at: D(-70),
}).lastInsertRowid;
insEvent.run(c3, 'execution_filed', D(-65), '', '', '');
insDl.run(c3, '银行账户续冻申请', D(20), '', '冻结一年期届满前办理（演示数据）', 'high');
insLog.run(c3, D(-7), '网络查控反馈：发现可供执行存款线索', 30);
insFee.run(c3, '执行代理费', 12000, '首次网络查控反馈', D(12), 'unpaid', '', '演示：未到期');

// 所务待办 + 收件箱演示（AI 建议形态）
insTask.run(null, '所内月度案件台账汇报', '', D(4), 'low');
insInbox.run('task', JSON.stringify({ title: '张三案：若决定上诉，需在上诉期内一并考虑二审证据组织', priority: 'high' }),
  'llm-suggest', 'demo：L2 周检视演示建议', c1);

console.log(`种子完成：3 案 + 事件/期限/待办/日志/费用/分成 + 1 条收件箱演示（今天=${today}）`);
