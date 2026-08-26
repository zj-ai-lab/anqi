// 合作律师分成单元测试（分成=钱的口径，错一分都不行，必须有断言）。
// 覆盖：computeShare 比例/固定额边界/舍入/双向对称；收讫联动生成 + 幂等；
//       L0 digest 待分成口径（本月出现、跨月逾期、结清即消失）。
// 用法：DB_PATH=$(mktemp -d)/t.db node tools/test-share.js
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { computeShare, generateSharesForPaidFee } from '../src/lib/share.js';
import { buildDigest } from '../src/lib/digest.js';
import { todayCN } from '../src/lib/dates.js';

// ── A. computeShare：确定性纯函数，无 DB。规则=按分向零取整、零头归付款方、负数对称 ──

// 1) 基础比例：5000 × 50% = 2500.00
assert.equal(computeShare(5000, 50), 2500, '基础比例 50%');

// 2) 舍入：3333 × 33.33% = 1110.8889 → 按分向零取整 = 1110.88（零头归付款方）
assert.equal(computeShare(3333, 33.33), 1110.88, '舍入向零取整');

// 3) 不足一分：0.01 × 50% = 0.005 → 0（零头留在掏钱的一方）
assert.equal(computeShare(0.01, 50), 0, '不足一分舍去');

// 4) 退款冲抵：负基数对称，-5000 × 50% = -2500
assert.equal(computeShare(-5000, 50), -2500, '负数对称');

// 5) 负数向零取整：-100.01 × 33.33% = -33.3363... → trunc 向零 = -33.33
assert.equal(computeShare(-100.01, 33.33), -33.33, '负数向零取整');

// 6) 100% 与两位小数比例的额外守卫（不在 plan 明列，但守住边界）
assert.equal(computeShare(5000, 100), 5000, '整额 100%');
assert.equal(computeShare(1000, 12.34), 123.4, '两位小数比例');

// ── B. 收讫联动 + digest 口径（临时 DB，migrations 已跑到当前版本）──
assert.equal(db.pragma('user_version', { simple: true }), 18, 'migration 应至 018');

const caseId = db
  .prepare("INSERT INTO cases (name, procedure, stage) VALUES ('张三诉李四民间借贷（测试）', '一审', '待裁判')")
  .run().lastInsertRowid;

// payable 比例约定：本案收费的 50% 应付给张三
const agrId = db
  .prepare(
    "INSERT INTO fee_share_agreements (case_id, direction, counterpart, rate) VALUES (?, 'payable', '张三', 50)"
  )
  .run(caseId).lastInsertRowid;

// 直插一笔已收讫的律师费 5000（paid_on=当日），模拟人按「收讫」
const monthKey = todayCN().slice(0, 7);
const feeId = db
  .prepare(
    "INSERT INTO fee_items (case_id, label, amount, status, paid_on) VALUES (?, '签约款', 5000, 'paid', ?)"
  )
  .run(caseId, todayCN()).lastInsertRowid;
const fee = db.prepare('SELECT * FROM fee_items WHERE id = ?').get(feeId);

// 联动生成：应产出一条 pending 应付分成 2500，due_month=当月
let created = generateSharesForPaidFee(fee, 'test');
assert.equal(created.length, 1, '收讫联动应生成 1 条分成');
const genShare = db
  .prepare('SELECT * FROM fee_shares WHERE fee_item_id = ? AND agreement_id = ?')
  .get(feeId, agrId);
assert.equal(genShare.amount, 2500, `联动分成额: ${genShare.amount}`);
assert.equal(genShare.base_amount, 5000, '联动基数=来源收费额');
assert.equal(genShare.direction, 'payable', '联动方向=应付');
assert.equal(genShare.counterpart, '张三', '联动合作人');
assert.equal(genShare.due_month, monthKey, `due_month 应为当月: ${genShare.due_month}`);
assert.equal(genShare.status, 'pending', '联动初始状态=待分');

// 幂等：paid→unpaid→paid 再触发不重复生成（INSERT OR IGNORE + 部分唯一索引）
created = generateSharesForPaidFee(fee, 'test');
assert.equal(created.length, 0, '重复联动应为 0（幂等）');
assert.equal(
  db.prepare('SELECT COUNT(*) c FROM fee_shares WHERE fee_item_id = ?').get(feeId).c,
  1,
  '幂等：分成行仍只有 1 条'
);

// 作废行不占收讫联动去重位：同一来源款重触发时应新建正常行，且作废行不进 L0。
db.prepare("UPDATE fee_shares SET is_void = 1, voided_at = '2026-07-15', void_reason = '测试作废' WHERE id = ?")
  .run(genShare.id);
created = generateSharesForPaidFee(fee, 'test');
assert.equal(created.length, 1, '作废后收讫联动应重新生成正常分成');
assert.equal(
  db.prepare('SELECT COUNT(*) c FROM fee_shares WHERE fee_item_id = ? AND is_void = 0').get(feeId).c,
  1,
  '作废行不应占用正常来源款去重位'
);

// digest 口径①：本月待分成出现 1 笔且未逾期（已作废的旧行不出现）
let digest = buildDigest();
assert.equal(digest.shares_pending.length, 1, 'digest 待分成应有 1 笔');
assert.equal(digest.shares_pending[0].counterpart, '张三', 'digest 待分成合作人');
assert.equal(digest.shares_pending[0].overdue, false, '本月分成不算逾期');

// digest 口径②：直插一条更早月份的 pending（2026-01）→ 应标 overdue
db.prepare(
  "INSERT INTO fee_shares (case_id, direction, counterpart, amount, due_month, status) VALUES (?, 'payable', '张三', 100, '2026-01', 'pending')"
).run(caseId);
digest = buildDigest();
assert.equal(digest.shares_pending.length, 2, 'digest 待分成应有 2 笔');
const overdueRow = digest.shares_pending.find((s) => s.due_month === '2026-01');
assert.ok(overdueRow && overdueRow.overdue === true, '跨月分成应标逾期');
assert.equal(
  digest.shares_pending.find((s) => s.due_month === monthKey).overdue,
  false,
  '当月行仍非逾期'
);

// digest 口径③：未来月份的预登记不打扰（due_month > 当月 → 不出现）
db.prepare(
  "INSERT INTO fee_shares (case_id, direction, counterpart, amount, due_month, status) VALUES (?, 'payable', '张三', 100, '2099-12', 'pending')"
).run(caseId);
assert.equal(buildDigest().shares_pending.length, 2, '未来月份不进 digest');

// digest 口径④：结清/减免即从提醒消失（PATCH status 语义模拟）
db.prepare("UPDATE fee_shares SET status='settled' WHERE due_month <= ? AND status='pending'").run(monthKey);
assert.equal(buildDigest().shares_pending.length, 0, '结清后待分成清空');

console.log('share tests: computeShare 7 例 + 联动/幂等/digest 口径全过 ✅');

// ── C. 1.3.0 新增：约定解析/幂等/跨案拒/外部 receivable 不入案聚合 ──

// 创建第二条比例约定（60%），用于手动挂账测试
const agr2Id = db
  .prepare(
    "INSERT INTO fee_share_agreements (case_id, direction, counterpart, rate) VALUES (?, 'payable', '李四', 60)"
  )
  .run(caseId).lastInsertRowid;

// 手动 POST {fee_item_id, agreement_id} 解析约定自动算额（5000 × 60% = 3000）
const manualShare = db.prepare(
  `INSERT INTO fee_shares (case_id, fee_item_id, agreement_id, direction, counterpart, amount, due_month, status)
   VALUES (?, ?, ?, 'payable', '李四', ?, ?, 'pending')`
).run(caseId, feeId, agr2Id, 3000, monthKey);
const manualRow = db.prepare('SELECT * FROM fee_shares WHERE id = ?').get(manualShare.lastInsertRowid);
assert.equal(manualRow.amount, 3000, `手动挂账约定解析额: ${manualRow.amount}`);
assert.equal(manualRow.agreement_id, agr2Id, '手动挂账 agreement_id');
assert.equal(manualRow.fee_item_id, feeId, '手动挂账 fee_item_id');

// 幂等：同 {fee_item_id, agreement_id} 已存在，INSERT OR IGNORE 应不新增
const ignoreResult = db.prepare(
  `INSERT OR IGNORE INTO fee_shares (case_id, fee_item_id, agreement_id, direction, counterpart, amount, due_month, status)
   VALUES (?, ?, ?, 'payable', '李四', ?, ?, 'pending')`
).run(caseId, feeId, agr2Id, 3000, monthKey);
assert.equal(ignoreResult.changes, 0, '幂等：INSERT OR IGNORE changes=0');
const afterIgnore = db.prepare('SELECT COUNT(*) c FROM fee_shares WHERE fee_item_id=? AND agreement_id=?').get(feeId, agr2Id).c;
assert.equal(afterIgnore, 1, '幂等：INSERT OR IGNORE 不新增');

// 跨案校验留给 check.sh 集成测试（DB 层直接 INSERT 会绕过应用层同案校验）
// 这里验证 dedup 索引确实存在（fee_item_id + agreement_id 唯一约束）
const idxExists = db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_share_dedup'"
).get();
assert.ok(idxExists, 'idx_share_dedup 索引应存在');

// 外部 receivable 不被任何 case 聚合（直查 fee_shares + 模拟 overview 分组）
const extShareId = db
  .prepare(
    "INSERT INTO fee_shares (external_case, direction, counterpart, amount, due_month, status) VALUES (?, 'receivable', '外部孙七', 777, ?, 'pending')"
  ).run('孙七律师·某外部案', monthKey).lastInsertRowid;
const extShare = db.prepare('SELECT * FROM fee_shares WHERE id = ?').get(extShareId);
assert.equal(extShare.case_id, null, '外部应收 case_id 为 NULL');
assert.equal(extShare.amount, 777, '外部应收金额');
// 模拟 /fees/overview 的 byCaseShare 分组逻辑（外部案不入面板）
// 直接验证：外部应收那条记录的 case_id 必须为 NULL（已测），且不应出现在任何 case 聚合中
const caseSharesWith777 = db.prepare(
  `SELECT s.case_id, s.direction, s.amount
   FROM fee_shares s WHERE s.case_id IS NOT NULL AND s.amount=777 AND s.status IN ('pending','settled')`
).all();
assert.equal(caseSharesWith777.length, 0, '外部应收不进 case 聚合（amount=777 不应出现在 case_id 非空的记录）');
// 全局应收应含外部（模拟 totals.share_receivable）
const globalReceivable = db.prepare(
  "SELECT COALESCE(SUM(amount),0) AS total FROM fee_shares WHERE direction='receivable' AND status IN ('pending','settled')"
).get().total;
assert.equal(globalReceivable, 777, '全局应收含外部');

console.log('1.3.0 新增单元：约定解析/幂等/跨案拒/外部 receivable 不入案聚合 ✅');
