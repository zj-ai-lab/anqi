// 变更记录读取面（R7 · migration 022）。
//
// 这张表由触发器写，应用层只读——本路由是它唯一的对外出口。三个刻意的设计：
//   ① 游标分页而不是 OFFSET：底账是追加写的，用 OFFSET 翻页时若有新行插入，
//      第 2 页会重复或漏掉第 1 页边界上的行。以 id 为游标（id < before）不会。
//   ② 只暴露 change_log 自己的列，不外联业务表：案件名等敏感内容不进这个接口，
//      前端拿 entity_id 回它已经在看的那个案件即可。
//   ③ 参数非法一律 400 而不是静默纠正：limit 上限 200 —— 变更记录是审计面，
//      「悄悄给了你 5000 行」比「报错让你把筛选写清楚」更糟。
import { Router } from 'express';
import { db } from '../db.js';

const r = Router();

const ENTITIES = ['case', 'event', 'deadline', 'task', 'worklog'];
const MAX_LIMIT = 200;

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

r.get('/changes', (req, res) => {
  const { entity, entity_id: rawEntityId, case_id: rawCaseId, before: rawBefore, limit: rawLimit } = req.query;

  if (entity !== undefined && entity !== '' && !ENTITIES.includes(String(entity))) {
    return res.status(400).json({ error: `entity 须为：${ENTITIES.join('/')}` });
  }

  let entityId = null;
  if (rawEntityId !== undefined && rawEntityId !== '') {
    entityId = positiveInt(rawEntityId);
    if (entityId === null) return res.status(400).json({ error: 'entity_id 须为正整数' });
  }

  // case_id：案件页的主用筛选。它是触发器在写入时落下的归属列，所以「期限被删掉」这种
  // 记录也留得住——按 entity+entity_id 反查做不到这一点（源行没了，反查就没有结果）。
  let caseId = null;
  if (rawCaseId !== undefined && rawCaseId !== '') {
    caseId = positiveInt(rawCaseId);
    if (caseId === null) return res.status(400).json({ error: 'case_id 须为正整数' });
  }

  const limit = rawLimit === undefined || rawLimit === '' ? 50 : positiveInt(rawLimit);
  if (limit === null || limit > MAX_LIMIT) {
    return res.status(400).json({ error: `limit 须为 1–${MAX_LIMIT} 的整数` });
  }

  // before 语义：上一页最后一条的 id（含），本页从它之后取。前端不需要算 id-1。
  let before = null;
  if (rawBefore !== undefined && rawBefore !== '') {
    before = positiveInt(rawBefore);
    if (before === null) return res.status(400).json({ error: 'before 须为上一页最后一条的 id（正整数）' });
  }

  const cond = [];
  const args = [];
  if (entity !== undefined && entity !== '') { cond.push('entity = ?'); args.push(String(entity)); }
  if (entityId !== null) { cond.push('entity_id = ?'); args.push(entityId); }
  if (caseId !== null) { cond.push('case_id = ?'); args.push(caseId); }
  if (before !== null) { cond.push('id < ?'); args.push(before); }

  // 多取一行来判断「是否真的还有更早的」。若只取 limit 行，那么「恰好取满一页、
  // 后面其实一条都没有」与「后面还有」在返回体里长得一模一样，前端只能多打一次
  // 空请求才能确定——而它已经在用它来判断「加载更早」按钮要不要出现。
  const rows = db.prepare(
    `SELECT id, entity, entity_id, case_id, action, field, old_value, new_value, changed_at, origin, actor, rule_id, synced_at
       FROM change_log
       ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY id DESC
      LIMIT ?`
  ).all(...args, limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  res.json({
    items,
    // before 语义：本页最后一条的 id（含）。null = 确认到底，前端收起「加载更早」。
    next_before: hasMore ? items[items.length - 1].id : null,
  });
});

export default r;
