// /internal/agent-case-view 与 /internal/agent-digest 路由层回归（R1）：这两条
// 是 DSH agent worker 专用的 session 绑定只读面，取代插件此前直接打
// /internal/cases/byname/:name（自由 name 参数）与 /internal/digest（全所口径）
// ——一个单案 worker 不该也不能读到绑定案之外的任何案件。
//
// 与 tools/test-agent-proposals-http.js 同样的黑盒 HTTP 风格：同进程 http
// server + bindSession()/unbindSession() 直接模拟 supervisor 侧的登记动作，
// 不真正 spawn DSH 子进程。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-session-read-http-'));
process.env.DB_PATH = path.join(scratch, 'agent-session-read-http.db');
process.env.ANJIAN_INTERNAL_KEY = 'agent-session-read-http-key';
delete process.env.ANJIAN_UNSAFE_NO_AUTH;

const { db } = await import('../src/db.js');
const { internalAuth } = await import('../src/middleware/auth.js');
const internalRouter = (await import('../src/routes/internal.js')).default;
const { bindSession, unbindSession, _resetSessionRegistryForTest } = await import('../src/agent/session-registry.js');
// 与 buildDigest() 用同一份日期口径（CN +8），不用 SQLite 的 date('now')（UTC）——
// 否则跨 UTC 午夜时插入的行会落到与断言预期不同的分桶里，产生只在特定时段复现
// 的假红。
const { todayCN, addDays } = await import('../src/lib/dates.js');

_resetSessionRegistryForTest();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/internal', internalAuth, internalRouter);

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function get(pathname, { sessionId, useQuery = false } = {}) {
  const headers = { 'X-Anjian-Key': process.env.ANJIAN_INTERNAL_KEY };
  let url = base + pathname;
  if (sessionId !== undefined) {
    if (useQuery) url += `${pathname.includes('?') ? '&' : '?'}session_id=${encodeURIComponent(sessionId)}`;
    else headers['X-Anjian-Session-Id'] = sessionId;
  }
  const response = await fetch(url, { headers });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  return { status: response.status, data };
}

// 两个案件——一个是"自己案"（session 绑定的目标），一个是"他案"（绝不应该
// 出现在任何响应里,哪怕是名字本身）。
const ownCaseId = db.prepare(
  "INSERT INTO cases (name, procedure, stage, status) VALUES ('自己案·张三诉李四','一审','审理中','active')"
).run().lastInsertRowid;
const otherCaseId = db.prepare(
  "INSERT INTO cases (name, procedure, stage, status) VALUES ('他案·王五诉赵六','一审','审理中','active')"
).run().lastInsertRowid;

db.prepare(
  "INSERT INTO deadlines (case_id, name, due_on, severity, status) VALUES (?, '举证期限', date('now','+1 day'), 'critical', 'pending')"
).run(ownCaseId);
db.prepare(
  "INSERT INTO deadlines (case_id, name, due_on, severity, status) VALUES (?, '答辩期限', date('now','+1 day'), 'critical', 'pending')"
).run(otherCaseId);

const sessionId = 'anqi-session-read-http-1';
bindSession(sessionId, ownCaseId);

try {
  // ---- agent-case-view：缺 session_id → 400 ----
  {
    const { status, data } = await get('/internal/agent-case-view');
    assert.equal(status, 400);
    assert.equal(data.code, 'session_id_invalid');
  }

  // ---- agent-case-view：未绑定 session → 403，不是 404（不暴露"案件是否存在"信息） ----
  {
    const { status, data } = await get('/internal/agent-case-view', { sessionId: 'no-such-session' });
    assert.equal(status, 403);
    assert.equal(data.code, 'session_not_bound');
  }

  // ---- agent-case-view：绑定 session（header 传）→ 只返回绑定案，不含 name 参数入口 ----
  {
    const { status, data } = await get('/internal/agent-case-view', { sessionId });
    assert.equal(status, 200);
    assert.equal(data.case.id, ownCaseId);
    assert.equal(data.case.name, '自己案·张三诉李四');
    assert.ok(!JSON.stringify(data).includes('他案'), 'agent-case-view 响应中不得出现绑定案之外的案件名');
  }

  // ---- agent-case-view：query 传 session_id 同样有效（header/query 二选一）----
  {
    const { status, data } = await get('/internal/agent-case-view', { sessionId, useQuery: true });
    assert.equal(status, 200);
    assert.equal(data.case.id, ownCaseId);
  }

  // ---- agent-digest：缺 session_id → 400；未绑定 → 403 ----
  {
    const missing = await get('/internal/agent-digest');
    assert.equal(missing.status, 400);
    const unbound = await get('/internal/agent-digest', { sessionId: 'no-such-session' });
    assert.equal(unbound.status, 403);
    assert.equal(unbound.data.code, 'session_not_bound');
  }

  // ---- agent-digest：绑定 session → 只含绑定案的分桶行，他案期限/名字绝不出现 ----
  {
    const { status, data } = await get('/internal/agent-digest', { sessionId });
    assert.equal(status, 200);
    assert.ok(data.red.some((row) => row.case_id === ownCaseId), '绑定案自己的临期期限必须出现');
    assert.ok(!data.red.some((row) => row.case_id === otherCaseId), 'digest 不得混入他案的分桶行');
    assert.ok(!JSON.stringify(data).includes('他案'), 'agent-digest 响应中不得出现绑定案之外的案件名');
  }

  // ---- agent-digest：逐分桶核对，既不漏出他案、也不把本案的行静默丢空 ----
  // 上面那组断言只覆盖 red 一个桶，而且"响应里不出现他案名字"这条对**空桶**永远
  // 成立——一个把整桶过滤成空的 bug 完全能骗过它。真实复现过的例子：shares_pending
  // 是整个 buildDigest() 里唯一一处逐列点名的 SELECT，恰好漏了 s.case_id，于是单案
  // 投影里 row.case_id 恒为 undefined、整桶恒空；方向上 fail-closed（不漏别案），但
  // 绑定案自己的待分成永远到不了 agent，且上面那两条断言一条都不会红。
  //
  // 这里换一种不依赖手写日期算术的形式：先给两个案件都铺满每一个分桶的数据，再拿
  // 全所口径的 /internal/digest 当真值来源，逐桶断言 scoped[桶] 恰好等于
  // full[桶] 里属于绑定案的那些行。任何一个方向出错——漏出他案、或把本案行丢掉——
  // 都会在这条 deepEqual 上红；同时对本案确实有行的桶额外断言"expected 非空"，
  // 免得两边一起变空还算通过。
  {
    const today = todayCN();
    const monthKey = today.slice(0, 7);
    // 每个案件都铺一遍：week/watch 期限、7 日内开庭、今日/本周待办、待收款、待分成。
    // （red 桶的临期期限在文件上方已经插过。）
    for (const cid of [ownCaseId, otherCaseId]) {
      const tag = cid === ownCaseId ? '自己案' : '他案';
      db.prepare("INSERT INTO deadlines (case_id, name, due_on, severity, status) VALUES (?,?,?,'normal','pending')")
        .run(cid, `${tag}·本周期限`, addDays(today, 5));
      db.prepare("INSERT INTO deadlines (case_id, name, due_on, severity, status) VALUES (?,?,?,'normal','pending')")
        .run(cid, `${tag}·观察期期限`, addDays(today, 20));
      db.prepare("INSERT INTO events (case_id, type, occurred_on, note) VALUES (?,'hearing',?,?)")
        .run(cid, addDays(today, 2), `${tag}·开庭`);
      db.prepare("INSERT INTO tasks (case_id, title, plan_date, status) VALUES (?,?,?,'open')")
        .run(cid, `${tag}·今日待办`, today);
      db.prepare("INSERT INTO tasks (case_id, title, due_on, status) VALUES (?,?,?,'open')")
        .run(cid, `${tag}·本周待办`, addDays(today, 5));
      db.prepare("INSERT INTO fee_items (case_id, label, amount, due_on, status) VALUES (?,?,?,?,'unpaid')")
        .run(cid, `${tag}·待收款`, 10000, addDays(today, 10));
      db.prepare(
        `INSERT INTO fee_shares (case_id, direction, counterpart, amount, due_month, status)
         VALUES (?,'receivable',?,?,?,'pending')`
      ).run(cid, `${tag}·分成对手方`, 5000, monthKey);
    }
    // 第三个案件：没有任何 pending 期限、也没有将来的开庭，因此只会出现在全所口径
    // 的 no_deadline_cases 里——用来验证那个桶（按 row.id 而不是 row.case_id 过滤）
    // 同样不会把别案漏给 agent。
    db.prepare("INSERT INTO cases (name, procedure, stage, status) VALUES ('他案二·无期限','一审','审理中','active')").run();

    const full = await get('/internal/digest');
    assert.equal(full.status, 200);
    const scoped = await get('/internal/agent-digest', { sessionId });
    assert.equal(scoped.status, 200);

    // no_deadline_cases 的行本身就是 case 行，主键叫 id；其余分桶都带 case_id。
    const ownKeyOf = (bucket) => (bucket === 'no_deadline_cases' ? 'id' : 'case_id');
    // 本案确实铺了数据、因此 expected 必须非空的桶——防止"两边一起空"蒙混过关。
    const mustBeNonEmpty = new Set([
      'red', 'week', 'watch', 'hearings', 'today_tasks', 'week_tasks', 'all_tasks', 'fees_due', 'shares_pending',
    ]);

    const arrayBuckets = Object.keys(full.data).filter((k) => Array.isArray(full.data[k]));
    assert.ok(arrayBuckets.length >= 10, `全所 digest 的数组分桶数异常地少（${arrayBuckets.length}）——本断言可能已经和 buildDigest() 的形状脱节`);
    for (const bucket of arrayBuckets) {
      const key = ownKeyOf(bucket);
      const expected = full.data[bucket].filter((row) => row[key] === ownCaseId);
      if (mustBeNonEmpty.has(bucket)) {
        assert.ok(
          expected.length > 0,
          `分桶 ${bucket} 在全所口径里按 ${key} 找不到绑定案的行：要么该桶的 SELECT 没有把 ${key} 投影出来（单案过滤会因此恒空，正是 shares_pending 复现过的那个 bug），要么本探针的铺数据步骤已经和 buildDigest() 的分桶口径脱节`
        );
      }
      assert.deepEqual(
        scoped.data[bucket], expected,
        `分桶 ${bucket} 的单案投影必须恰好等于全所口径里属于绑定案的那些行：多了是越权读到他案，少了是把本案的行静默丢掉（例如该桶的 SELECT 漏了 ${key}）`
      );
    }
    // no_deadline_cases 那个桶在本案有期限时天然为空，上面的 deepEqual 已经覆盖；
    // 这里再单独确认第三个案件（全所口径里确实在该桶）没有漏给 agent。
    assert.ok(
      full.data.no_deadline_cases.some((row) => row.name === '他案二·无期限'),
      '全所口径的 no_deadline_cases 里应该能看到那个没有期限的第三案（否则本条断言没有实际约束力）'
    );
    assert.equal(
      scoped.data.no_deadline_cases.length, 0,
      'agent 的 no_deadline_cases 不得出现绑定案之外的案件（该桶按 row.id 过滤，漏改这一处同样是一次越权读）'
    );
    assert.ok(!JSON.stringify(scoped.data).includes('他案'), '铺满全部分桶之后，agent-digest 里仍不得出现任何他案名字');

    // counts 是按 caseId 单独重新聚合的，不从全所 counts 派生——确认它确实是单案口径。
    assert.equal(scoped.data.counts.active_cases, 1, 'counts.active_cases 在单案投影下只应算绑定案自己');
    assert.ok(scoped.data.counts.open_tasks < full.data.counts.open_tasks, 'counts.open_tasks 必须是单案口径，不能是全所数字');
  }

  // ---- worker 收尾（unbindSession）后，同一个 session_id 不能再读 ----
  unbindSession(sessionId);
  {
    const { status, data } = await get('/internal/agent-case-view', { sessionId });
    assert.equal(status, 403);
    assert.equal(data.code, 'session_not_bound');
  }
  {
    const { status } = await get('/internal/agent-digest', { sessionId });
    assert.equal(status, 403);
  }

  // ---- 旧的、面向外部自动化的 /internal/cases/byname/:name 与 /internal/digest
  //      不受影响：这两条不是 agent worker 的读面，继续保留给 DESIGN.md 描述
  //      的外部自动化使用 ----
  {
    const response = await fetch(`${base}/internal/cases/byname/${encodeURIComponent('自己案·张三诉李四')}`, {
      headers: { 'X-Anjian-Key': process.env.ANJIAN_INTERNAL_KEY },
    });
    assert.equal(response.status, 200);
  }
  {
    const response = await fetch(`${base}/internal/digest`, {
      headers: { 'X-Anjian-Key': process.env.ANJIAN_INTERNAL_KEY },
    });
    assert.equal(response.status, 200);
  }

  // ---- ANJIAN_INTERNAL_KEY_SOURCE=electron-auto 的收窄规则必须在真实挂载栈上
  //      成立，不只是在直接调用 internalAuth() 的单测里成立 ----
  // tools/test-auth-security.js 里那组断言是直接调用 internalAuth()、自己捏一个
  // req.path 传进去的，证明不了"Express 把路由挂在 /internal 之下时 req.path 到底
  // 是什么"。而这条收窄规则整个建立在 req.path 是去掉挂载前缀之后的 '/agent-*' 上：
  // 若哪天挂载方式改了（换成 app.use('/internal/xxx', ...)、或在 router 内部再套一
  // 层前缀），白名单会一条都匹配不上，桌面版的 AI 助理会对**所有** /internal 调用
  // 拿到 403——功能整体失效，且失效方向是 fail-closed，不会有任何安全告警提醒。
  // 这里用与生产同一条 app.use('/internal', internalAuth, internalRouter) 链路跑一遍。
  process.env.ANJIAN_INTERNAL_KEY_SOURCE = 'electron-auto';
  try {
    // agent 端点：仍走各自的业务判断（未绑定 session → 400/403），而不是被这条
    // 收窄规则一律拦成 electron_auto_key_scoped。
    for (const agentPath of ['/internal/agent-case-view', '/internal/agent-digest']) {
      const { status, data } = await get(agentPath);
      assert.equal(status, 400, `${agentPath} 在 electron-auto key 下应放行到业务层（缺 session_id → 400）`);
      assert.equal(data.code, 'session_id_invalid', `${agentPath} 不应被 electron-auto 收窄规则拦下`);
    }
    // 面向外部自动化的读面：同一份 key 一律 403。
    for (const blockedPath of ['/internal/digest', '/internal/cases']) {
      const { status, data } = await get(blockedPath);
      assert.equal(status, 403, `${blockedPath} 在 electron-auto key 下必须 403`);
      assert.equal(data.code, 'electron_auto_key_scoped');
    }
  } finally {
    delete process.env.ANJIAN_INTERNAL_KEY_SOURCE;
  }
  // 去掉来源标记之后，同一份 key 立刻恢复整个 /internal 面（用户显式配置的语义）。
  {
    const { status } = await get('/internal/digest');
    assert.equal(status, 200, '去掉 electron-auto 来源标记后，显式配置语义的 key 必须恢复放行整个 /internal');
  }

  console.log('agent session-bound read HTTP tests: agent-case-view/agent-digest 绑定信任边界 + 逐分桶零泄漏且不丢本案行 + electron-auto key 真实挂载栈收窄 + 旧全所端点不受影响 passed');
} finally {
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
