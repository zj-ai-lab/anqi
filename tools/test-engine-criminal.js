// 刑事期限规则引擎专项测试。
// 目的：验证 Q2 授权范围内的引擎改造（合并加载 / scope 隔离 / direction:before / applies 多维）
//       在刑事规则上行为正确，且不与民诉规则互相污染。
// 用法：DB_PATH=$(mktemp -d)/t.db node tools/test-engine-criminal.js
//
// ⚠️ 安全闸：本测试会 ALTER TABLE cases 补测试临时列（见第 0 节）。
//    必须在临时库上运行，禁止误改 data/anjian.db 真实数据。
if (!process.env.DB_PATH) {
  console.error('拒绝运行：未设置 DB_PATH。本测试会执行 ALTER TABLE，仅允许在临时库上运行：');
  console.error('  DB_PATH=$(mktemp -d)/t.db node tools/test-engine-criminal.js');
  process.exit(1);
}

import assert from 'node:assert/strict';
// 动态 import：确保上面的安全闸先于 db.js 打开数据库执行。
const { db } = await import('../src/db.js');
const { deriveForEvent, ruleMatches } = await import('../src/lib/engine.js');

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

// ─────────────────────────────────────────────────────────────
// 0. schema 兜底（仅测试副本用）
// 项目 cases 表尚未迁移刑事字段（crime_type / trial_mode / case_nature / custody_status），
// 条件必须明确确认。此处临时补列，以验证「迁移后」applies 过滤行为正确。
// ⚠️ 这只发生在测试副本；项目 schema 迁移（019）须经用户确认后另行执行。
// ─────────────────────────────────────────────────────────────
console.log('0. schema 兜底（测试临时列）');
{
  const cols = new Set(db.prepare('PRAGMA table_info(cases)').all().map((c) => c.name));
  const need = { crime_type: 'TEXT', trial_mode: 'TEXT', case_nature: 'TEXT', custody_status: 'TEXT' };
  const added = [];
  for (const [col, type] of Object.entries(need)) {
    if (!cols.has(col)) { db.exec(`ALTER TABLE cases ADD COLUMN ${col} ${type}`); added.push(col); }
  }
  const after = new Set(db.prepare('PRAGMA table_info(cases)').all().map((c) => c.name));
  assert.ok(Object.keys(need).every((c) => after.has(c)), '四个刑事字段就位');
  ok(added.length
    ? `测试副本已补 ${added.join(' / ')}`
    : '四个刑事字段已由 migration 021 建好（本次无需补列）');
}

// ─────────────────────────────────────────────────────────────
// A. 规则加载：刑事规则已并入、数量正确、scope 齐备
// ─────────────────────────────────────────────────────────────
console.log('A. 规则加载');
{
  const { default: fs } = await import('node:fs');
  const p = new URL('../rules/deadline_rules_criminal.json', import.meta.url);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(raw.rules.length, 40, '刑事规则 40 条');
  assert.ok(raw.rules.every((r) => r.scope === 'criminal'), '每条均带 scope=criminal');
  assert.equal(raw.review, 'approved', '复核状态');
  assert.equal(raw.reviewed_by, 'reviewer', '复核人');
  ok('40 条刑事规则全部加载且 scope 齐备');
}

// ─────────────────────────────────────────────────────────────
// A′. 控告线规则加载（文件头部门牌检查）
// 与 A 段同构。控告线的「计算行为」由 J 段验证（派生 + 闸门 + 反向隔离）、
// 「法条依据」由 M 段验证，但文件头部这四项此前无人核验——条目被误删（13→12）、
// scope 或二级限定丢失、复核状态被改回 draft，都不会有测试报警（J/M 段遍历现有
// 规则，少一条不会失败）。本段补上门牌，防静默收敛。
// ─────────────────────────────────────────────────────────────
console.log('A′. 控告线规则加载');
{
  const { default: fs } = await import('node:fs');
  const p = new URL('../rules/deadline_rules_complaint.json', import.meta.url);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(raw.rules.length, 13, '控告线规则 13 条');
  assert.ok(raw.rules.every((r) => r.scope === 'criminal'), '每条均带 scope=criminal');
  // 二级限定：控告线全部规则只允许在「刑事控告立案前」这一程序段派生，
  // 不得漏标（漏标会渗入侦查及以后，与 40 条主表双触发）。
  assert.ok(
    raw.rules.every((r) => Array.isArray(r.applies_procedure)
      && r.applies_procedure.length === 1
      && r.applies_procedure[0] === '刑事控告立案前'),
    '每条 applies_procedure 均恰为 ["刑事控告立案前"]'
  );
  // id 唯一性：重复 id 会让 ruleMatches 的语义含混且掩盖误粘贴。
  const ids = raw.rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, `规则 id 不得重复，实际 ${ids.length} 条 / ${new Set(ids).size} 个不同 id`);
  assert.equal(raw.review, 'approved', '复核状态');
  assert.equal(raw.reviewed_by, 'reviewer', '复核人');
  assert.ok(raw.reviewed_at, '复核日期非空');
  ok('13 条控告线规则全部加载、scope/二级限定齐备、id 唯一、复核状态已签署');
}

// ─────────────────────────────────────────────────────────────
// B. scope 隔离：同一 trigger 不双触发（这是改造前的最严重缺陷）
// ─────────────────────────────────────────────────────────────
console.log('B. scope 隔离（防双触发）');
{
  // B1 民诉一审案，判决送达 → 只应有民诉上诉期 1 条
  const cid = db.prepare("INSERT INTO cases (name, procedure, stage) VALUES ('民诉测试案','一审','待裁判')").run().lastInsertRowid;
  const eid = db.prepare("INSERT INTO events (case_id, type, occurred_on) VALUES (?, 'judgment_served', '2026-07-10')").run(cid).lastInsertRowid;
  const c = db.prepare('SELECT * FROM cases WHERE id=?').get(cid);
  const e = db.prepare('SELECT * FROM events WHERE id=?').get(eid);
  const d = deriveForEvent(e, c, 'test');
  assert.equal(d.deadlines.length, 1, `民诉判决送达应派生 1 条，实际 ${d.deadlines.length}`);
  assert.equal(d.deadlines[0].due_on, '2026-07-27', '民诉 15 日 + 周末顺延');
  ok('民诉案件不触发刑事上诉期');

  // B2 刑事一审案，判决送达 → 只应有刑事上诉期 1 条，且不叠加民诉 15 日规则
  const cid2 = db.prepare("INSERT INTO cases (name, procedure, stage) VALUES ('刑事测试案','刑事一审','待裁判')").run().lastInsertRowid;
  const eid2 = db.prepare("INSERT INTO events (case_id, type, occurred_on) VALUES (?, 'judgment_served', '2026-07-08')").run(cid2).lastInsertRowid;
  const c2 = db.prepare('SELECT * FROM cases WHERE id=?').get(cid2);
  const e2 = db.prepare('SELECT * FROM events WHERE id=?').get(eid2);
  const d2 = deriveForEvent(e2, c2, 'test');
  assert.equal(d2.deadlines.length, 2, `刑事判决送达应派生 2 条（上诉期+被害人请求抗诉），实际 ${d2.deadlines.length}`);
  const appeal = d2.deadlines.find((x) => x.name === '上诉/抗诉期（判决）');
  assert.ok(appeal, '应含刑事上诉期（判决）');
  assert.equal(appeal.due_on, '2026-07-18', `刑事上诉期 10 日：${appeal.due_on}`);
  ok('刑事案件不触发民诉上诉期（双触发缺陷已消除）');
}

// ─────────────────────────────────────────────────────────────
// C. roll:none —— 节假日一律不顺延（用户 Q3 裁定）
// ─────────────────────────────────────────────────────────────
console.log('C. roll:none 不顺延');
{
  // 2026-07-08 + 10 自然日 = 2026-07-18（周六）。民诉会顺延到 07-20（周一），刑事必须停在 07-18。
  const r = db.prepare("SELECT * FROM deadlines WHERE rule_id='cr_appeal_judgment_10d'").get();
  assert.equal(r.due_on, '2026-07-18', `周末不得顺延，实际 ${r.due_on}`);
  assert.equal(r.is_manual_override, 0, '非人工覆盖');
  ok('届满日落在周六仍不顺延（严格遵守 Q3 裁定）');

  // 跨春节：2026-02-05 送达刑事判决 + 10 日 = 02-15（春节假期内）→ 必须停在 02-15
  const cid = db.prepare("INSERT INTO cases (name,procedure,stage) VALUES ('春节测试案','刑事一审','待裁判')").run().lastInsertRowid;
  const eid = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?, 'judgment_served','2026-02-05')").run(cid).lastInsertRowid;
  const c = db.prepare('SELECT * FROM cases WHERE id=?').get(cid);
  const e = db.prepare('SELECT * FROM events WHERE id=?').get(eid);
  const d = deriveForEvent(e, c, 'test');
  const a = d.deadlines.find((x) => x.name === '上诉/抗诉期（判决）');
  assert.equal(a.due_on, '2026-02-15', `春节假期内不得顺延，实际 ${a.due_on}`);
  ok('届满日落在春节假期内仍不顺延（在押上诉期不被错误顺延）');
}

// ─────────────────────────────────────────────────────────────
// D. direction:before —— 开庭前 N 日送达（刑诉法 §187）
// ─────────────────────────────────────────────────────────────
console.log('D. direction:before 倒推');
{
  const cid = db.prepare("INSERT INTO cases (name,procedure,stage) VALUES ('开庭送达测试案','刑事一审','待开庭')").run().lastInsertRowid;
  const eid = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?, 'hearing_scheduled','2026-07-20')").run(cid).lastInsertRowid;
  const c = db.prepare('SELECT * FROM cases WHERE id=?').get(cid);
  const e = db.prepare('SELECT * FROM events WHERE id=?').get(eid);
  const d = deriveForEvent(e, c, 'test');
  const byName = Object.fromEntries(d.deadlines.map((x) => [x.name, x.due_on]));
  assert.equal(d.deadlines.length, 3, `开庭排期应派生 3 条，实际 ${d.deadlines.length}`);
  assert.equal(byName['起诉书副本送达（开庭前 10 日）'], '2026-07-10', `起诉书副本：${byName['起诉书副本送达（开庭前 10 日）']}`);
  assert.equal(byName['传票/通知书送达（开庭前 3 日）'], '2026-07-17', `传票：${byName['传票/通知书送达（开庭前 3 日）']}`);
  assert.equal(byName['公开审判先期公布（开庭前 3 日）'], '2026-07-17', `公布：${byName['公开审判先期公布（开庭前 3 日）']}`);
  ok('开庭日 2026-07-20 → 起诉书副本 07-10 / 传票 07-17 / 公布 07-17');
}

// ─────────────────────────────────────────────────────────────
// E. applies 多维过滤：审理程序
// ─────────────────────────────────────────────────────────────
console.log('E. applies 过滤（审理程序）');
{
  // E1 普通程序：应派生 2 个月审限，不派生简易/速裁
  const cid = db.prepare("INSERT INTO cases (name,procedure,stage,trial_mode) VALUES ('普通程序案','刑事一审','审理中','普通程序')").run().lastInsertRowid;
  const eid = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?, 'court_accepted','2026-03-31')").run(cid).lastInsertRowid;
  const c = db.prepare('SELECT * FROM cases WHERE id=?').get(cid);
  const e = db.prepare('SELECT * FROM events WHERE id=?').get(eid);
  const d = deriveForEvent(e, c, 'test');
  const ids = d.deadlines.map((x) => x.name);
  assert.ok(ids.includes('一审审限（普通程序，2 个月）'), '普通程序应有 2 个月审限');
  assert.ok(ids.includes('一审审限上限（普通程序，3 个月）'), '普通程序应有 3 个月上限');
  assert.ok(!ids.includes('一审审限（简易程序）'), '普通程序不得派生简易程序审限');
  assert.ok(!ids.includes('一审审限（速裁程序）'), '普通程序不得派生速裁审限');
  const d2m = d.deadlines.find((x) => x.name === '一审审限（普通程序，2 个月）');
  // 2026-09-12 裁定「丙」：月数类改法定算法（次日起算）→ 3-31 受案，起算日 4-1，+2 月 = 6-1。
  // 改前为 5-31（含当日口径），晚 1 天。此处期望值随裁定同步更新。
  assert.equal(d2m.due_on, '2026-06-01', `3-31 次日起算 + 2 月：${d2m.due_on}`);
  ok('普通程序 → 2 个月 / 3 个月，未串入简易、速裁规则');

  // E2 简易程序：应派生 20 日，不派生 2 个月
  const cid2 = db.prepare("INSERT INTO cases (name,procedure,stage,trial_mode) VALUES ('简易程序案','刑事一审','审理中','简易程序')").run().lastInsertRowid;
  const eid2 = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?, 'court_accepted','2026-03-31')").run(cid2).lastInsertRowid;
  const c2 = db.prepare('SELECT * FROM cases WHERE id=?').get(cid2);
  const e2 = db.prepare('SELECT * FROM events WHERE id=?').get(eid2);
  const d3 = deriveForEvent(e2, c2, 'test');
  const ids2 = d3.deadlines.map((x) => x.name);
  assert.ok(ids2.includes('一审审限（简易程序）'), '简易程序应有 20 日审限');
  assert.ok(!ids2.includes('一审审限（普通程序，2 个月）'), '简易程序不得派生普通程序 2 个月审限');
  ok('简易程序 → 20 日，未串入普通程序规则');
}

// ─────────────────────────────────────────────────────────────
// F. applies 多维过滤：作案类型
// ─────────────────────────────────────────────────────────────
console.log('F. applies 过滤（作案类型）');
{
  // F1 普通案件拘留 → 提请批捕 3 日
  const cid = db.prepare("INSERT INTO cases (name,procedure,stage,crime_type) VALUES ('普通作案案','刑事侦查','侦查中','普通')").run().lastInsertRowid;
  const eid = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?, 'detained','2026-07-01')").run(cid).lastInsertRowid;
  const c = db.prepare('SELECT * FROM cases WHERE id=?').get(cid);
  const e = db.prepare('SELECT * FROM events WHERE id=?').get(eid);
  const d = deriveForEvent(e, c, 'test');
  const ids = d.deadlines.map((x) => x.name);
  assert.ok(ids.includes('提请批捕（普通案件）'), '普通作案应有 3 日提请批捕');
  assert.ok(!ids.includes('提请批捕（流窜/多次/结伙作案）'), '普通作案不得派生 30 日提请批捕');
  // 2026-09-19 reviewer裁定：拘留最长期限默认按实务常态 37 日出；10/14 改为手动可选口径
  assert.ok(ids.includes('拘留最长期限届满（37 日）'), `普通作案应默认派生 37 日拘留上限，实际 ${ids.join(' / ')}`);
  assert.ok(!ids.includes('拘留最长期限届满（10 日）') && !ids.includes('拘留最长期限届满（14 日）'),
    '10/14 日口径为手动可选，不得自动派生');
  ok('普通作案 → 3 日提请批捕 ＋ 默认 37 日拘留上限（10/14 日不自动派生）');

  // F2 流窜作案拘留 → 30 日提请批捕 + 37 日上限
  const cid2 = db.prepare("INSERT INTO cases (name,procedure,stage,crime_type) VALUES ('流窜作案案','刑事侦查','侦查中','流窜作案')").run().lastInsertRowid;
  const eid2 = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?, 'detained','2026-07-01')").run(cid2).lastInsertRowid;
  const c2 = db.prepare('SELECT * FROM cases WHERE id=?').get(cid2);
  const e2 = db.prepare('SELECT * FROM events WHERE id=?').get(eid2);
  const d2 = deriveForEvent(e2, c2, 'test');
  const ids2 = d2.deadlines.map((x) => x.name);
  assert.ok(ids2.includes('提请批捕（流窜/多次/结伙作案）'), '流窜作案应有 30 日提请批捕');
  assert.ok(ids2.includes('拘留最长期限届满（37 日）'), '流窜作案应有 37 日拘留上限');
  assert.ok(!ids2.includes('提请批捕（普通案件）'), '流窜作案不得派生普通 3 日规则');
  ok('流窜作案 → 30 日提请批捕 + 37 日拘留上限，未串入普通规则');
}

// ─────────────────────────────────────────────────────────────
// G. 未知维度保守拒绝（防误派生）
// ─────────────────────────────────────────────────────────────
console.log('G. 未知维度保守拒绝');
{
  const bad = { id: 'x', scope: 'criminal', applies: { 不存在维度: ['A'] } };
  assert.equal(ruleMatches(bad, { procedure: '刑事一审' }), false, '未知维度应拒绝');
  const good = { id: 'y', scope: 'criminal', applies: { 作案类型: ['普通'] } };
  assert.equal(ruleMatches(good, { procedure: '刑事一审', crime_type: null }), false, '条件未确认时不得猜测');
  assert.equal(ruleMatches(good, { procedure: '刑事一审', crime_type: '' }), false, '数据库空字符串不得猜测');
  assert.equal(ruleMatches(good, { procedure: '刑事一审', crime_type: '普通' }), true, '显式确认普通应命中');
  assert.equal(ruleMatches(good, { procedure: '刑事一审', crime_type: '流窜作案' }), false, '不匹配应拒绝');
  ok('未知维度拒绝 / 空列拒绝 / 显式条件 / 不匹配拒绝');
}

// ─────────────────────────────────────────────────────────────
// H. 月/年数法定算法（Q10 裁定「丙」）：次日起算 + 月末钳制
// ─────────────────────────────────────────────────────────────
console.log('H. 月数法定算法（次日起算）');
{
  const { computeDue } = await import('../src/lib/engine.js');
  const rule = { id: 't_month', unit: 'months', days: 2, count_from: 'next_day', roll: 'none', basis: '测试' };

  // H1 常规日：3-1 逮捕 + 2 月，次日起算 → 起算日 3-2 → 5-2（改前含当日口径为 5-1，早 1 天）
  const h1 = computeDue(rule, { occurred_on: '2026-03-01' });
  assert.equal(h1.due_on, '2026-05-02', `3-1 + 2 月（次日起算）= 5-2，实际 ${h1.due_on}`);
  assert.ok(h1.calc_note.includes('次日起算（起算日 2026-03-02）'), 'calc_note 须写明起算日，浮层据此提示差异');
  ok('3-1 逮捕 + 2 月 → 2026-05-02（法定次日起算）');

  // H2 月末钳制：1-30 + 1 月，起算日 1-31 → 2-28（不得被钳成 3-1）
  const h2 = computeDue({ ...rule, days: 1 }, { occurred_on: '2026-01-30' });
  assert.equal(h2.due_on, '2026-02-28', `1-30 + 1 月 = 2-28，实际 ${h2.due_on}`);
  ok('1-30 + 1 月 → 2026-02-28（月末钳制正确）');

  // H3 年数类同样尊重 count_from：2026-03-01 + 1 年 → 起算日 3-2 → 2027-03-02
  const h3 = computeDue({ ...rule, unit: 'years', days: 1 }, { occurred_on: '2026-03-01' });
  assert.equal(h3.due_on, '2027-03-02', `3-1 + 1 年 = 2027-03-02，实际 ${h3.due_on}`);
  ok('年数类同走次日起算');

  // H4 收紧口径：自然日类仍为 next_day（与 40 条基本表一致），不得回退成含当日
  const h4 = computeDue({ id: 't_day', unit: 'natural_days', days: 10, count_from: 'next_day', roll: 'none', basis: '测试' }, { occurred_on: '2026-07-08' });
  assert.equal(h4.due_on, '2026-07-18', `7-8 + 10 日 = 7-18，实际 ${h4.due_on}`);
  ok('自然日类次日起算口径未被月数改造波及');
}

// ─────────────────────────────────────────────────────────────
// I. 倒推类（direction:before）不受起算方式影响
// ─────────────────────────────────────────────────────────────
console.log('I. 倒推类 count_from=not_applicable');
{
  const { default: fs } = await import('node:fs');
  const raw = JSON.parse(fs.readFileSync(new URL('../rules/deadline_rules_criminal.json', import.meta.url), 'utf8'));
  const backs = raw.rules.filter((r) => r.direction === 'before');
  assert.equal(backs.length, 3, `倒推类应 3 条，实际 ${backs.length}`);
  assert.ok(backs.every((r) => r.count_from === 'not_applicable'),
    `倒推类 count_from 应全为 not_applicable，实际 ${backs.map((r) => r.id + ':' + r.count_from).join(',')}`);
  ok('3 条开庭前倒推规则均标注 not_applicable（不存在期间起算问题）');
}

// ─────────────────────────────────────────────────────────────
// J. 控告线立案前：规则派生 + 程序段闸门
// ─────────────────────────────────────────────────────────────
console.log('J. 控告线立案前');
{
  const cid = db.prepare("INSERT INTO cases (name,procedure,stage) VALUES ('控告线测试案','刑事控告立案前','立案审查')").run().lastInsertRowid;
  const eid = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?, 'accepted','2026-09-11')").run(cid).lastInsertRowid;
  const c = db.prepare('SELECT * FROM cases WHERE id=?').get(cid);
  const e = db.prepare('SELECT * FROM events WHERE id=?').get(eid);
  const d = deriveForEvent(e, c, 'test');
  const names = d.deadlines.map((x) => x.name);
  assert.ok(d.deadlines.length >= 1, '受案事件应派生立案审查期限');
  const review = d.deadlines.find((x) => x.name.includes('立案审查'));
  assert.ok(review, `应含立案审查期限，实际 ${names.join(' / ')}`);
  // 9-11 收到 + 3 日，次日起算 → 9-12 起算 → 9-14（周一）。规则 roll 视配置而定，此处只验口径。
  assert.ok(['2026-09-14', '2026-09-15'].includes(review.due_on), `立案审查届满日异常：${review.due_on}`);
  ok(`受案 → 立案审查期限 ${review.due_on}（法定次日起算）`);

  // J2 程序段闸门：立案前案件即使记了「逮捕」，也不得派生侦查羁押期限
  const cid2 = db.prepare("INSERT INTO cases (name,procedure,stage) VALUES ('闸门测试案','刑事控告立案前','立案审查')").run().lastInsertRowid;
  const eid2 = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?, 'arrested','2026-09-11')").run(cid2).lastInsertRowid;
  const c2 = db.prepare('SELECT * FROM cases WHERE id=?').get(cid2);
  const e2 = db.prepare('SELECT * FROM events WHERE id=?').get(eid2);
  const d2 = deriveForEvent(e2, c2, 'test');
  assert.equal(d2.deadlines.length, 0,
    `立案前不得派生侦查线期限，实际派生 ${d2.deadlines.map((x) => x.name).join(' / ')}`);
  ok('程序段闸门生效：立案前阶段不派生侦查羁押期限');

  // J3 反向闸门：立案前规则不得渗入已立案的侦查案件
  const cid3 = db.prepare("INSERT INTO cases (name,procedure,stage) VALUES ('侦查测试案','刑事侦查','侦查中')").run().lastInsertRowid;
  const eid3 = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?, 'accepted','2026-09-11')").run(cid3).lastInsertRowid;
  const c3 = db.prepare('SELECT * FROM cases WHERE id=?').get(cid3);
  const e3 = db.prepare('SELECT * FROM events WHERE id=?').get(eid3);
  const d3 = deriveForEvent(e3, c3, 'test');
  assert.ok(!d3.deadlines.some((x) => x.name.includes('立案审查')),
    '侦查阶段不得派生立案前审查期限');
  ok('反向隔离：控告线规则不渗入侦查阶段');
}

// ─────────────────────────────────────────────────────────────
// K. 17 值阶段标签表（展示层）
// ─────────────────────────────────────────────────────────────
console.log('K. 17 值阶段标签');
{
  const { stageLabels, stageLabelMap, procedures, stageTemplates, eventTypes } = await import('../src/lib/vocab.js');
  assert.equal(stageLabels.length, 17, `17 值标签应为 17 条，实际 ${stageLabels.length}`);
  assert.ok(stageLabels.every((l) => l.label), '每条标签须有 label');

  // 非终态标签必须给出 procedure（供 UI 切换标签时同步写入 cases.procedure）；
  // 终态标签（已结案）按设计留空 procedure —— 保留案件原程序，避免影响既有期限的规则归属。
  const nonTerminal = stageLabels.filter((l) => !l.terminal);
  const terminal = stageLabels.filter((l) => l.terminal);
  assert.equal(terminal.length, 1, `终态标签应 1 条，实际 ${terminal.length}`);
  assert.ok(nonTerminal.every((l) => l.procedure), '非终态标签必须给出 procedure');
  assert.ok(terminal.every((l) => !l.procedure), '终态标签 procedure 须留空');
  const bad = nonTerminal.filter((l) => !procedures.includes(l.procedure));
  assert.equal(bad.length, 0, `标签 procedure 必须存在于程序词表，越界：${bad.map((l) => l.label + '→' + l.procedure).join(',')}`);

  // 17→7 映射：17 个标签（含终态「已结案」归入「终态」桶）须且仅归属一个桶
  const { default: fs } = await import('node:fs');
  const raw = JSON.parse(fs.readFileSync(new URL('../rules/stage_labels_criminal.json', import.meta.url), 'utf8'));
  const mapping = raw.map_17_to_7;
  const buckets = Object.entries(mapping).filter(([k]) => !k.startsWith('_'));
  const listed = buckets.flatMap(([, arr]) => arr);
  for (const l of stageLabels) {
    assert.ok(listed.includes(l.label), `标签未进 17→7 映射：${l.label}`);
  }
  assert.equal(listed.length, new Set(listed).size, '映射内标签不得重复归属两个程序');
  assert.equal(listed.length, stageLabels.length, `映射标签数应与标签表一致（${listed.length} vs ${stageLabels.length}）`);
  // 桶名（除「终态」）须是真实程序，且桶内标签的 procedure 与桶名自洽
  for (const [proc, arr] of buckets) {
    if (proc === '终态') continue;
    assert.ok(procedures.includes(proc), `映射桶名不是有效程序：${proc}`);
    for (const name of arr) {
      const l = stageLabels.find((x) => x.label === name);
      assert.equal(l.procedure, proc, `标签「${name}」的 procedure(${l.procedure}) 与桶名(${proc}) 不一致`);
    }
  }
  assert.ok(Array.isArray(mapping._unused_procedures) && mapping._unused_procedures.length === 3,
    '应标注 3 个飞书没有、案齐保留的程序（死刑复核/再审/执行）');

  assert.ok(procedures.includes('刑事控告立案前'), '程序词表应含「刑事控告立案前」');
  assert.ok(Array.isArray(stageTemplates['刑事控告立案前']) && stageTemplates['刑事控告立案前'].length === 7,
    '控告立案前阶段链应 7 个环节');
  assert.equal(eventTypes.length, 62, `事件词表应为 62（民诉 39 + 刑事 8 + 行政 15），实际 ${eventTypes.length}`);
  assert.ok(eventTypes.some((t) => t.id === 'admin_act_known'), '事件词表应含行政事件');
  assert.ok(procedures.includes('行政一审'), '程序词表应含行政一审');
  assert.equal(Object.keys(stageLabelMap).length, 17, 'stageLabelMap 索引完整');
  ok('17 值标签 → procedure 全部落位（终态留空）；17→7 映射无重复无遗漏；阶段链 7 环；事件 55 个（含行政）');
}

// ─────────────────────────────────────────────────────────────
// L. 手动调参（第一层）：manual_* 优先于规则默认值
// ─────────────────────────────────────────────────────────────
console.log('L. 手动调参优先级');
{
  const { hasManualParams, applyManualParams, recomputeForDeadline, computeDue } = await import('../src/lib/engine.js');
  // recomputeForDeadline 依赖真实事件行（按 trigger_event_id 回查锚点日），故此处落库驱动。
  const cid = db.prepare("INSERT INTO cases (name,procedure,stage) VALUES ('手动调参案','刑事一审','待裁判')").run().lastInsertRowid;
  const eid = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?, 'judgment_served','2026-07-08')").run(cid).lastInsertRowid;
  const base = { rule_id: 'cr_appeal_judgment_10d', trigger_event_id: eid };

  // L1 改天数：规则默认 10 日 → 手动 20 日，届满日随动
  const dl1 = { ...base, manual_days: 20, manual_unit: 'natural_days', manual_count_from: 'next_day', manual_roll: 'none' };
  assert.equal(hasManualParams(dl1), true, '四字段有值应判为手动调参');
  const r1 = recomputeForDeadline(dl1);
  assert.ok(r1, 'recomputeForDeadline 应返回结果');
  assert.equal(r1.due_on, '2026-07-28', `7-8 + 20 日 = 7-28，实际 ${r1.due_on}`);
  assert.ok(r1.calc_note.includes('【引擎 · 手动参数】'), 'calc_note 须标记手动参数，保留可审计');
  ok('manual_days=20 覆盖规则默认 10 日 → 届满日随动为 2026-07-28（calc_note 标注手动参数）');

  // L2 改单位：天 → 月，届满日重算（不是停留在原日期）
  const r2 = recomputeForDeadline({ ...base, manual_days: 1, manual_unit: 'months', manual_count_from: 'next_day', manual_roll: 'none' });
  assert.equal(r2.due_on, '2026-08-09', `7-8 次日起算 + 1 月 = 8-9，实际 ${r2.due_on}`);
  ok('manual_unit=months → 届满日重算为 2026-08-09');

  // L3 改顺延：7-18 为周六，roll=forward → 顺延至 7-20（周一）
  const r3 = recomputeForDeadline({ ...base, manual_days: 10, manual_unit: 'natural_days', manual_count_from: 'next_day', manual_roll: 'forward' });
  assert.equal(r3.due_on, '2026-07-20', `7-18 周六顺延 → 7-20，实际 ${r3.due_on}`);
  assert.ok(r3.calc_note.includes('顺延'), 'calc_note 须记录顺延过程');
  ok('manual_roll=forward → 周六届满顺延至 2026-07-20');

  // L4 清空全部参数 → 回落规则默认（可逆），且 calc_note 不再带「手动参数」标记
  const dl4 = { ...base, manual_days: null, manual_unit: null, manual_count_from: null, manual_roll: null };
  assert.equal(hasManualParams(dl4), false, '参数全空应判为非手动调参');
  const r4 = recomputeForDeadline(dl4);
  assert.equal(r4.due_on, '2026-07-18', `清空后应回落规则默认 10 日 → 7-18，实际 ${r4.due_on}`);
  assert.ok(!r4.calc_note.includes('手动参数'), '回落默认后 calc_note 不得残留手动标记');
  ok('清空 manual_* → 回落规则默认值（可逆，审计标记同时清除）');

  // L5 非引擎派生期限（court_specified 无 trigger_event_id）→ 返回 null，不得臆造日期
  assert.equal(recomputeForDeadline({ rule_id: 'cr_appeal_judgment_10d' }), null, '无 trigger_event_id 应返回 null');
  assert.equal(recomputeForDeadline({ trigger_event_id: eid }), null, '无 rule_id 应返回 null');
  ok('缺 rule_id / trigger_event_id 时返回 null（不臆造日期）');
}

// ─────────────────────────────────────────────────────────────
// M. 本地法条库与规则依据的匹配覆盖度
// ─────────────────────────────────────────────────────────────
console.log('M. 法条库覆盖度');
{
  const { laws: civil } = JSON.parse(
    (await import('node:fs')).default.readFileSync(new URL('../rules/law_texts.json', import.meta.url), 'utf8'));
  const { laws: criminal } = JSON.parse(
    (await import('node:fs')).default.readFileSync(new URL('../rules/law_texts_criminal.json', import.meta.url), 'utf8'));
  const all = [...civil, ...criminal];
  assert.ok(all.every((l) => l.cite && l.law && l.article && l.text), '每条须含 cite/law/article/text');
  assert.ok(all.every((l) => Array.isArray(l.match) && l.match.length), '每条须含 match 数组（前端按此匹配）');

  // 每条规则的 basis 必须至少能匹到一条法条原文，否则浮层会退化为「未匹配」。
  //
  // 白名单（2026-09-12 已清空）：原 2 条例外的民诉规则已按裁定补齐条号——
  //   · execution_application → 补引民诉法（2023修正）§250（申请执行的期间为二年）
  //   · preservation_renewal_entry → 补引《财产保全规定》（法释〔2020〕21号）§18（届满七日前申请续行）
  // 机制保留而非删除：将来若新增规则漏引条号，本测试仍会失败（防覆盖率静默下滑）。
  const BASIS_NO_ARTICLE = new Set([]);

  const { default: fs } = await import('node:fs');
  const files = ['deadline_rules.json', 'deadline_rules_criminal.json', 'deadline_rules_complaint.json'];
  const uncovered = [];
  let checked = 0;
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(new URL('../rules/' + f, import.meta.url), 'utf8'));
    for (const r of raw.rules) {
      if (!r.basis) continue;
      checked++;
      const hit = all.some((l) => l.match.some((k) => r.basis.includes(k)));
      if (!hit && !BASIS_NO_ARTICLE.has(`${f}:${r.id}`)) uncovered.push(`${f}:${r.id}`);
    }
  }
  assert.equal(uncovered.length, 0, `以下规则的依据匹不到法条原文：${uncovered.join(', ')}`);
  // 白名单条目必须仍然存在且仍然未覆盖（防白名单变成掩盖问题的垃圾桶）
  for (const key of BASIS_NO_ARTICLE) {
    const [f, rid] = key.split(':');
    const raw = JSON.parse(fs.readFileSync(new URL('../rules/' + f, import.meta.url), 'utf8'));
    const r = raw.rules.find((x) => x.id === rid);
    assert.ok(r, `白名单规则不存在：${key}`);
    const hit = all.some((l) => l.match.some((k) => (r.basis || '').includes(k)));
    assert.equal(hit, false, `白名单规则 ${key} 已能被匹配，应从白名单移除`);
  }
  ok(`民诉 ${civil.length} 条 + 刑事 ${criminal.length} 条法条原文；${checked} 条规则的 basis 全部覆盖（白名单 ${BASIS_NO_ARTICLE.size} 条）`);
}

// ─────────────────────────────────────────────────────────────
// N. 拘留最长期限口径可切换（2026-09-19 reviewer裁定：默认 37 日，可手动选 10/14）
// 背景：改前普通案件一记「拘留」会同时蹦出 10 日（3+7）与 14 日（顶格 7+7）两条，
//       实务中 37 日是常态，故 37 日改为主口径、10/14 降为人工切换档。
// ─────────────────────────────────────────────────────────────
console.log('N. 拘留最长期限口径：默认 37 日 / 10·14 手动可选');
{
  const { rulesSummary, recomputeForDeadline } = await import('../src/lib/engine.js');
  const { default: fs } = await import('node:fs');
  const raw = JSON.parse(fs.readFileSync(new URL('../rules/deadline_rules_criminal.json', import.meta.url), 'utf8')).rules;

  // N1 规则层：37 日去掉 applies（否则普通案件不派生）+ 声明三档；10/14 标 manual_only
  const cap37 = raw.find((r) => r.id === 'cr_detention_cap_37');
  const cap14 = raw.find((r) => r.id === 'cr_detention_cap_14');
  const cap10 = raw.find((r) => r.id === 'cr_detention_cap_10');
  assert.ok(cap37 && cap14 && cap10, '三条拘留口径规则均须存在');
  assert.ok(!cap37.applies, '37 日口径不得再限制作案类型（否则普通案件不派生）');
  assert.equal(cap37.variants.length, 3, `37 日口径应声明 3 档，实际 ${cap37.variants?.length}`);
  assert.deepEqual(cap37.variants.map((v) => v.rule_id),
    ['cr_detention_cap_37', 'cr_detention_cap_14', 'cr_detention_cap_10'], '档位含义不得错位（首档＝默认）');
  assert.equal(cap10.manual_only, true, '10 日档须 manual_only');
  assert.equal(cap14.manual_only, true, '14 日档须 manual_only');
  ok('规则层：37 日为默认口径（无 applies）＋ 三档 variants；10/14 标 manual_only');

  // N2 口径元数据只定义一处：variants 引用的兄弟规则必须真实存在且带 name/basis
  for (const v of cap37.variants) {
    const s = raw.find((r) => r.id === v.rule_id);
    assert.ok(s, `variants 引用了不存在的规则：${v.rule_id}`);
    assert.ok(Number.isInteger(s.days) && s.days > 0, `口径天数异常：${v.rule_id}`);
    assert.ok(s.basis && s.name, `口径 ${v.rule_id} 缺 name/basis（前端下拉要显示）`);
  }
  ok('三档口径均能在规则文件中解析出 days/name/basis（不靠前端硬编码）');

  // N3 引擎 meta：rulesSummary 已把 variants 就地解析成前端可直接渲染的选项
  const sum = rulesSummary();
  const s37 = sum.find((r) => r.id === 'cr_detention_cap_37');
  assert.deepEqual(s37.variants.map((v) => v.days), [37, 14, 10],
    `前端拿到的档位应为 37/14/10，实际 ${s37.variants.map((v) => v.days)}`);
  assert.ok(s37.variants.every((v) => v.name && v.basis && v.label), '每档须带 name/basis/label');
  assert.equal(sum.find((r) => r.id === 'cr_detention_cap_10').manual_only, true, 'rulesSummary 须透出 manual_only');
  ok('rulesSummary：三档已解析为 {days,name,basis,severity,label}，前端零查表');

  // N4 派生层：普通案件一拘留只出 37 日一条；10/14 不可自动冒出
  const cid = db.prepare("INSERT INTO cases (name,procedure,stage,crime_type) VALUES ('口径测试案','刑事侦查','侦查中','普通')").run().lastInsertRowid;
  const eid = db.prepare("INSERT INTO events (case_id,type,occurred_on) VALUES (?, 'detained','2026-07-01')").run(cid).lastInsertRowid;
  const c = db.prepare('SELECT * FROM cases WHERE id=?').get(cid);
  const e = db.prepare('SELECT * FROM events WHERE id=?').get(eid);
  const out = deriveForEvent(e, c, 'test');
  const caps = out.deadlines.filter((x) => x.name.includes('拘留最长期限届满'));
  assert.equal(caps.length, 1,
    `拘留最长期限只应派生 1 条，实际 ${caps.length}：${caps.map((x) => x.name).join(' / ')}`);
  assert.equal(caps[0].name, '拘留最长期限届满（37 日）', '默认口径应为 37 日');
  // 7-1 拘留，次日起算第 37 日 → 8-7（addDays(base,37)）
  assert.equal(caps[0].due_on, '2026-08-07', `7-1 次日起算 + 37 日 = 8-7，实际 ${caps[0].due_on}`);
  ok('派生层：普通案件一拘留只出「37 日」一条（不再同时蹦 10 日与 14 日）');

  // N5 切档：只改 manual_days，届满日仍由引擎重算（不是前端算），并留可审计标记。
  // 走 recomputeForDeadline —— 这正是 PATCH /deadlines/:id 收到 manual_days 后调用的那条路径，
  // 用 computeDue 直接测会漏掉「【引擎 · 手动参数】」标记（那个替换发生在 recomputeForDeadline 内）。
  const dlId = out.deadlines.find((x) => x.name.includes('拘留最长期限届满')).id;
  const row = db.prepare('SELECT * FROM deadlines WHERE id=?').get(dlId);
  const r10 = recomputeForDeadline({ ...row, manual_days: 10 });
  const r14 = recomputeForDeadline({ ...row, manual_days: 14 });
  assert.equal(r10.due_on, '2026-07-11', `7-1 次日起算 + 10 日 = 7-11，实际 ${r10.due_on}`);
  assert.equal(r14.due_on, '2026-07-15', `7-1 次日起算 + 14 日 = 7-15，实际 ${r14.due_on}`);
  assert.ok(r10.calc_note.includes('手动参数'), `切换口径后 calc_note 须留可审计标记，实际 ${r10.calc_note}`);
  ok('切档：37 → 10 日为 7-11、→ 14 日为 7-15（引擎按 manual_days 重算并留审计标记）');
}

console.log(`\nengine tests (criminal): ${n} 组断言全过 ✅`);
