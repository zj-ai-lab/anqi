// 期限引擎「自验证」套件 —— 不依赖任何真实案件，自己造数据、自己推日期、双通道比对。
//
// 用法：DB_PATH=$(mktemp -d)/v.db node tools/verify-engine-e2e.js
//
// ⚠️ 安全闸：本套件会 INSERT 案件与事件，只允许在临时库上运行，禁止触碰 data/anjian.db。
//
// 覆盖五层：
//   L1 独立复算    —— 按法条语义独写一份日期算法，与引擎穷举比对（不看引擎实现）
//   L2 逻辑约束    —— 跨规则恒等式 / 月末钳制 / 闰年 / 不顺延 / 倒推 / 单调性
//   L3 端到端流程  —— 虚构案件走完整程序链，逐节点核对派生结果
//   L4 闸门与隔离  —— 程序段闸门、applies 多维过滤、scope 隔离
//   L5 库层语义    —— 幂等 / 级联重算 / 人工覆盖保护 / 无规则不臆造
if (!process.env.DB_PATH) {
  console.error('拒绝运行：未设置 DB_PATH。本套件会写入数据，仅允许在临时库上运行：');
  console.error('  DB_PATH=$(mktemp -d)/v.db node tools/verify-engine-e2e.js');
  process.exit(1);
}

const { db } = await import('../src/db.js');
const { deriveForEvent, recalcPreview, applyRecalc, computeDue } = await import('../src/lib/engine.js');
const fs = await import('node:fs');

let pass = 0, fail = 0;
const chk = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  OK   ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? '  ' + extra : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

const rules = [];
for (const f of ['deadline_rules_criminal.json', 'deadline_rules_complaint.json']) {
  rules.push(...JSON.parse(fs.readFileSync(new URL('../rules/' + f, import.meta.url), 'utf8')).rules);
}
const R = (id) => rules.find((r) => r.id === id);
const G = (id, d) => computeDue(R(id), { occurred_on: d, service_method: null }).due_on;
const addD = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ════════════════════════════════════════════════════════════════
// L1. 独立复算（按法条语义独写，不 import computeDue 的实现）
// ════════════════════════════════════════════════════════════════
section('L1. 独立复算：与引擎穷举比对（2025-06 ~ 2028-12 每一天）');
{
  function addM(s, n) {
    const [y, m, d] = s.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1 + n, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(d, last));
    return t.toISOString().slice(0, 10);
  }
  function indep(r, anchor) {
    const back = r.direction === 'before';
    const cf = r.count_from;
    if (r.unit === 'months') { const st = cf === 'next_day' ? addD(anchor, 1) : anchor; return addM(st, back ? -r.days : r.days); }
    if (r.unit === 'years') { const st = cf === 'next_day' ? addD(anchor, 1) : anchor; return addM(st, (back ? -1 : 1) * r.days * 12); }
    if (back) return addD(anchor, -r.days);
    return cf === 'next_day' ? addD(anchor, r.days) : addD(anchor, r.days - 1);
  }
  const auto = rules.filter((r) => r.kind !== 'court_specified' && r.days != null);
  const dates = [];
  for (let d = new Date('2025-06-01T00:00:00Z'); d <= new Date('2028-12-31T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));
  const mm = [];
  for (const r of auto) for (const a of dates) {
    const e = computeDue(r, { occurred_on: a, service_method: null }).due_on;
    if (e !== indep(r, a)) mm.push(`${r.id} @${a} 引擎=${e} 独立=${indep(r, a)}`);
  }
  chk(`自动计算规则 ${auto.length} 条 × ${dates.length} 天 = ${(auto.length * dates.length).toLocaleString()} 次比对，零差异`, mm.length === 0, mm.length ? mm.slice(0, 8).join(' | ') : '');
}

// ════════════════════════════════════════════════════════════════
// L2. 逻辑约束（独立于任何实现）
// ════════════════════════════════════════════════════════════════
section('L2. 逻辑约束');
{
  // 2.1 跨规则恒等式：拘留最长期限 = 提请批捕届满 + 检察院审查 7 日
  let ok1 = true;
  for (const d of ['2026-01-05', '2026-03-30', '2026-09-11', '2026-12-28', '2027-01-04']) {
    if (addD(G('cr_detention_report_normal', d), 7) !== G('cr_detention_cap_10', d)) ok1 = false;
  }
  for (const d of ['2026-01-05', '2026-09-11', '2026-12-28']) {
    if (addD(G('cr_detention_report_three', d), 7) !== G('cr_detention_cap_37', d)) ok1 = false;
  }
  chk('跨规则恒等式 3+7=10 / 30+7=37（8 组）', ok1);

  // 2.2 月末钳制：次日起算后起算日落在月末
  const clamp = [
    ['cr_prosecution_1m', '2027-01-30', '2027-02-28'],
    ['cr_prosecution_1m', '2028-01-30', '2028-02-29'],
    ['cr_prosecution_1m', '2026-03-30', '2026-04-30'],
    ['cr_prosecution_1m', '2026-05-30', '2026-06-30'],
    ['cr_confiscation_notice_6m', '2026-08-30', '2027-02-28'],
    ['cr_retrial_3m', '2026-03-30', '2026-06-30'],
  ];
  let ok2 = true;
  for (const [id, a, want] of clamp) if (G(id, a) !== want) { ok2 = false; console.log(`       差异 ${id} @${a} 实际=${G(id, a)} 应为=${want}`); }
  chk('月末钳制（含平年/闰年 2 月）6 组', ok2);

  // 2.3 次日起算语义（法定算法）
  const next = [
    ['cr_prosecution_1m', '2027-01-31', '2027-03-01'],
    ['cr_trial1_2m', '2026-12-31', '2027-03-01'],
    ['cr_prosecution_1m', '2028-02-29', '2028-04-01'],
    ['cr_invest_detention_2m', '2026-03-01', '2026-05-02'],
  ];
  let ok3 = true;
  for (const [id, a, want] of next) if (G(id, a) !== want) { ok3 = false; console.log(`       差异 ${id} @${a} 实际=${G(id, a)} 应为=${want}`); }
  chk('次日起算语义 4 组', ok3);

  // 2.4 刑事一律不顺延
  let ok4 = G('cr_appeal_ruling_5d', '2026-09-15') === '2026-09-20'
    && G('cr_appeal_ruling_5d', '2026-09-14') === '2026-09-19'
    && G('cr_appeal_ruling_5d', '2026-02-13') === '2026-02-18';
  chk('roll=none 遇周末/春节均不顺延（3 组）', ok4);

  // 2.5 开庭前倒推
  let ok5 = G('cr_indictment_before_10d', '2026-09-15') === '2026-09-05'
    && G('cr_summons_before_3d', '2026-09-15') === '2026-09-12'
    && G('cr_summons_before_3d', '2026-03-05') === '2026-03-02';
  chk('direction=before 开庭前倒推（3 组）', ok5);

  // 2.6 非递减性（月数类钳制会产生平台，故不要求严格递增）
  let mono = 0, bad = 0;
  for (const rid of ['cr_appeal_judgment_10d', 'cr_trial1_2m', 'cr_indictment_before_10d', 'cr_confiscation_notice_6m', 'cr_prosecution_1m']) {
    for (let i = 0; i < 1200; i++) {
      if (G(rid, addD('2026-01-01', i + 1)) < G(rid, addD('2026-01-01', i))) bad++;
      else mono++;
    }
  }
  chk(`非递减性 ${mono.toLocaleString()} 对无倒退`, bad === 0);

  // 2.7 自然日类严格 +1
  let st = 0, stbad = 0;
  for (const rid of ['cr_appeal_judgment_10d', 'cr_detention_cap_10', 'cp_reconsideration_decide_30d']) {
    for (let i = 0; i < 800; i++) {
      if (G(rid, addD('2026-01-01', i + 1)) !== addD(G(rid, addD('2026-01-01', i)), 1)) stbad++;
      else st++;
    }
  }
  chk(`自然日类严格递增 ${st.toLocaleString()} 对`, stbad === 0);
}

// ════════════════════════════════════════════════════════════════
// L3+L4. 端到端流程（虚构案件）与闸门隔离
// ════════════════════════════════════════════════════════════════
const now = '2026-01-01T00:00:00Z';
function mkCase(id, name, extra = {}) {
  const f = {
    name, case_no: '（虚构）' + id, cause: '盗窃罪', court: '某法院', client: '某甲',
    client_role: '被告人', opponent: '某检察院', procedure: '刑事侦查', stage: '侦查',
    stage_entered_at: '2026-03-05', status: 'active', accepted_at: '2026-03-02',
    folder_path: '/tmp', sol_starts_on: '2026-03-02', note: '虚构验证案件',
    created_at: now, updated_at: now, legalrag_url: '', crime_type: '普通',
    trial_mode: '普通程序', case_nature: '公诉', custody_status: '在押', case_side: '辩护',
    entrust_stage: '', co_counsel: '', contract_no: '', custody_place: '', handling_agency: '',
    ...extra,
  };
  const cols = Object.keys(f);
  db.prepare(`INSERT INTO cases (id,${cols.join(',')}) VALUES (?,${cols.map(() => '?').join(',')})`).run(id, ...cols.map((c) => f[c]));
}
const caseOf = (id) => db.prepare('SELECT * FROM cases WHERE id=?').get(id);
const setProc = (id, p, s) => db.prepare('UPDATE cases SET procedure=?,stage=? WHERE id=?').run(p, s, id);
function addEvent(caseId, type, date) {
  const i = db.prepare("INSERT INTO events (case_id,type,occurred_on,service_method,instrument,note,created_by,created_at) VALUES (?,?,?,'','','','manual',?)").run(caseId, type, date, now);
  return { id: Number(i.lastInsertRowid), type, occurred_on: date };
}
function step(caseId, type, date, expect) {
  const e = addEvent(caseId, type, date);
  const out = deriveForEvent(e, caseOf(caseId), 'verify');
  const got = {};
  for (const d of out.deadlines) got[d.name] = db.prepare('SELECT due_on FROM deadlines WHERE id=?').get(d.id).due_on;
  for (const [name, want] of Object.entries(expect)) {
    chk(`${date} ${type} → ${name}`, got[name] === want, got[name] ? `= ${got[name]}` : '（未派生）');
  }
  return { out, got };
}

section('L3. 端到端：辩护线完整链路（虚构案件，日期为手下推得）');
mkCase(9001, '（虚构）张某某盗窃案');
step(9001, 'detained', '2026-03-05', { '提请批捕（普通案件）': '2026-03-08', '拘留最长期限届满（37 日）': '2026-04-11' });
step(9001, 'approval_requested', '2026-03-07', { '检察院审查批捕决定期限': '2026-03-14' });
step(9001, 'arrested', '2026-03-13', { '侦查羁押期限届满': '2026-05-14' });
setProc(9001, '刑事审查起诉', '审查起诉');
step(9001, 'transferred_prosecution', '2026-05-10', { '审查起诉期限届满': '2026-06-11' });
step(9001, 'returned_investigation', '2026-06-05', { '退回补充侦查期限届满': '2026-07-06' });
setProc(9001, '刑事一审', '一审');
step(9001, 'court_accepted', '2026-07-03', { '一审审限（普通程序，2 个月）': '2026-09-04', '一审审限上限（普通程序，3 个月）': '2026-10-04' });
step(9001, 'hearing_scheduled', '2026-09-20', { '起诉书副本送达（开庭前 10 日）': '2026-09-10', '传票/通知书送达（开庭前 3 日）': '2026-09-17' });
step(9001, 'judgment_announced', '2026-09-30', { '当庭宣判后送达判决书（5 日）': '2026-10-05' });
step(9001, 'judgment_served', '2026-10-08', { '上诉/抗诉期（判决）': '2026-10-18', '被害人请求抗诉期限': '2026-10-13' });
setProc(9001, '刑事二审', '二审');
step(9001, 'second_instance_accepted', '2026-10-20', { '二审审限（2 个月）': '2026-12-21' });

section('L4. 闸门与隔离');
{
  mkCase(9002, '（虚构）李某某控告诈骗案', { procedure: '刑事控告立案前', stage: '控告立案前', case_side: '控告', client_role: '控告人' });
  step(9002, 'accepted', '2026-09-11', { '立案审查期限届满（一般，3 日）': '2026-09-14' });
  const r = step(9002, 'arrested', '2026-09-12', {});
  chk('程序段闸门：立案前记「逮捕」不派生侦查羁押期限', r.out.deadlines.length === 0 && r.out.tasks.length === 0);
  step(9002, 'file_refused', '2026-09-20', { '不予立案通知书送达（公安机关，3 日）': '2026-09-23', '申请复议期限届满（控告人，7 日）': '2026-09-27' });

  mkCase(9003, '（虚构）王某某流窜盗窃案', { crime_type: '流窜作案' });
  const ra = step(9003, 'detained', '2026-03-05', { '提请批捕（流窜/多次/结伙作案）': '2026-04-04', '拘留最长期限届满（37 日）': '2026-04-11' });
  chk('applies 过滤：流窜案不派生「普通案件 3 日」', !('提请批捕（普通案件）' in ra.got));

  mkCase(9004, '（虚构）赵某某简易程序案', { procedure: '刑事一审', trial_mode: '简易程序' });
  const rb = step(9004, 'court_accepted', '2026-07-03', { '一审审限（简易程序）': '2026-07-23' });
  chk('applies 过滤：简易程序不派生普通程序审限', !('一审审限（普通程序，2 个月）' in rb.got));

  // 拘留口径（2026-09-19 reviewer裁定）：默认 37 日；10/14 为手动可选，不得自动派生
  mkCase(9005, '（虚构）钱某某普通盗窃案');
  const rc = step(9005, 'detained', '2026-03-05', { '拘留最长期限届满（37 日）': '2026-04-11' });
  chk('拘留口径：普通案件默认 37 日，10/14 日档不自动派生',
    !('拘留最长期限届满（10 日）' in rc.got) && !('拘留最长期限届满（14 日）' in rc.got));
  chk('拘留口径：一拘留只出 1 条拘留上限（不重影）',
    Object.keys(rc.got).filter((k) => k.includes('拘留最长期限届满')).length === 1);
}

// ════════════════════════════════════════════════════════════════
// L5. 库层语义
// ════════════════════════════════════════════════════════════════
section('L5. 库层语义（幂等 / 级联 / 保护 / 不臆造）');
{
  const n1 = db.prepare('SELECT COUNT(*) c FROM deadlines WHERE trigger_event_id=? AND case_id=9001').get(db.prepare('SELECT id FROM events WHERE case_id=9001 AND type=?').get('detained').id).c;
  const e = db.prepare('SELECT * FROM events WHERE case_id=9001 AND type=?').get('detained');
  const again = deriveForEvent(e, caseOf(9001), 'verify');
  chk(`幂等：重复派生 0 条（该事件已 ${n1} 条）`, again.deadlines.length === 0);

  const before = db.prepare('SELECT name,due_on FROM deadlines WHERE trigger_event_id=? ORDER BY name').all(e.id);
  const pv = recalcPreview(e, '2026-03-20');
  const shiftOk = before.every((b) => {
    const m = pv.recalc.find((r) => r.name === b.name);
    return m && m.new_due === addD(b.due_on, 15);
  });
  chk(`级联重算：改锚点 +15 天，${pv.recalc.length} 条同步后移`, shiftOk);
  applyRecalc(pv, 'verify');
  // 按 name 匹配比对，不依赖两边的行序
  const landed = new Map(db.prepare('SELECT name,due_on FROM deadlines WHERE trigger_event_id=?').all(e.id).map((x) => [x.name, x.due_on]));
  chk('级联落库与预览一致', pv.recalc.every((r) => landed.get(r.name) === r.new_due));

  const dl = db.prepare('SELECT id FROM deadlines WHERE trigger_event_id=? LIMIT 1').get(e.id);
  db.prepare('UPDATE deadlines SET is_manual_override=1 WHERE id=?').run(dl.id);
  chk('人工覆盖保护：手工改过的条不参与级联', recalcPreview(e, '2026-04-01').excluded.some((x) => x.id === dl.id));

  const r9 = deriveForEvent(addEvent(9001, 'meeting_requested', '2026-03-06'), caseOf(9001), 'verify');
  chk('不臆造：申请会见 → 48 小时会见安排 = 3/8', r9.deadlines.length === 1 && r9.deadlines[0].due_on === '2026-03-08');
}

console.log(`\n══════ 自验证结果：通过 ${pass} / 失败 ${fail} ══════`);
console.log(`派生期限总数 ${db.prepare('SELECT COUNT(*) c FROM deadlines').get().c}｜人工录入任务 ${db.prepare('SELECT COUNT(*) c FROM tasks').get().c}`);
process.exit(fail ? 1 : 0);
