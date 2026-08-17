// L0 确定性日报（铁律 2：不经任何 LLM 的死代码兜底 + 心跳语义）。
// host cron 每日跑：docker exec anjian node tools/l0-digest.js
// DISCORD_WEBHOOK 未配置时只打日志（依然是心跳，进 l0.log）。
// 汇报纪律（家规）：空跑🟢 / 有事📥 / 失败🔴，绝不静默。
import { buildDigest } from '../src/lib/digest.js';

function fmtDeadline(d) {
  const mark = d.days_left < 0 ? `逾期${-d.days_left}日` : d.days_left === 0 ? '今日截止' : `剩${d.days_left}日`;
  const sev = d.severity === 'critical' ? '🔴' : d.severity === 'high' ? '🟠' : '▪️';
  return `${sev} ${mark}｜${d.case_name}｜${d.name}（${d.due_on}）`;
}

function build() {
  const d = buildDigest();
  const lines = [];
  const urgent = d.red.length + d.hearings.filter((h) => h.is_today).length;
  const head = urgent > 0 ? '📥' : '🟢';
  lines.push(`${head} **案齐日报 · ${d.date}**（在办 ${d.counts.active_cases}｜待办 ${d.counts.open_tasks}｜收件箱 ${d.counts.inbox_pending}）`);

  if (d.red.length) {
    lines.push('**🔴 临期/逾期（≤3日）**');
    for (const x of d.red) lines.push('· ' + fmtDeadline(x));
  }
  const todayHearings = d.hearings.filter((h) => h.is_today);
  if (todayHearings.length) {
    lines.push('**📅 今日开庭**');
    for (const h of todayHearings) lines.push(`· ${h.case_name}${h.note ? '｜' + h.note : ''}`);
  }
  if (d.week.length) {
    lines.push(`**🟠 本周（4–7日）** ${d.week.map((x) => `${x.case_name}·${x.name}(${x.due_on})`).join('；')}`);
  }
  if (d.no_deadline_cases.length) {
    lines.push(`**❓ 无在追期限（查漏录）** ${d.no_deadline_cases.map((c) => c.name).join('、')}`);
  }
  if (d.today_tasks.length) {
    lines.push(`**✅ 今日待办 ${d.today_tasks.length} 条** ${d.today_tasks.slice(0, 6).map((t) => t.title).join('；')}${d.today_tasks.length > 6 ? '…' : ''}`);
  }
  if (d.fees_due.length) {
    lines.push(`**💰 待收款** ${d.fees_due.map((f) => `${f.case_name}·${f.label}${f.amount != null ? '¥' + f.amount : ''}(${f.due_on})`).join('；')}`);
  }
  if (d.shares_pending.length) {
    lines.push(`**🤝 本月待分成 ${d.shares_pending.length} 笔** ` + d.shares_pending.map((s) => {
      const who = s.direction === 'payable' ? `应付 ${s.counterpart}` : `应收 ${s.counterpart}`;
      const tag = s.overdue ? `｜⚠️ 逾期（应于 ${s.due_month} 完成）` : '';
      return `${s.case_name || s.external_case}·${who} ¥${s.amount}${tag}`;
    }).join('；'));
  }
  if (!d.red.length && !todayHearings.length && !d.week.length) {
    lines.push('无临期死线、无今日开庭。');
  }
  return lines.join('\n');
}

async function main() {
  let text;
  try {
    text = build();
  } catch (e) {
    text = `🔴 **案齐日报生成失败**：${e.message}`;
    console.error(text);
    await post(text).catch(() => {});
    process.exit(1);
  }
  console.log(text);
  try {
    await post(text);
  } catch (e) {
    console.error('[l0] 发送失败：' + e.message);
    process.exit(1);
  }
}

async function post(content) {
  // 向后兼容：优先读带前缀的 ANJIAN_DISCORD_WEBHOOK（与 .env.example 一致），
  // 没有则 fallback 到旧名 DISCORD_WEBHOOK，避免既有自托管配置中断。
  const hook = process.env.ANJIAN_DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK;
  if (!hook) {
    console.log('[l0] ANJIAN_DISCORD_WEBHOOK 未配置，仅日志心跳');
    return;
  }
  const res = await fetch(hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 1900) }),
  });
  if (!res.ok) throw new Error(`discord webhook HTTP ${res.status}`);
  console.log('[l0] 已推送 Discord');
}

main();
