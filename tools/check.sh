#!/usr/bin/env bash
# anjian 自检：syntax → 规则 JSON → migrations → 引擎单测 → API 冒烟
set -euo pipefail
cd "$(dirname "$0")/.."
# Codex/CI shells may export FORCE_COLOR globally.  Several smoke-test IDs are
# intentionally captured from `node -e`; ANSI wrappers would turn them into
# invalid URL segments and make a green suite fail for a terminal-only reason.
unset FORCE_COLOR
export NO_COLOR=1

echo "[1/45] node --check"
for f in server.js src/db.js src/lib/*.js src/lib/*.cjs src/middleware/*.js src/routes/*.js src/agent/*.js src/agent/assets/plugins/*/index.js src/agent/assets/mcp/server.mjs public/js/*.js cli/case tools/seed-demo.js tools/seed-finance-qa.js tools/qa-finance-ui.js tools/hash-password.js tools/backup.cjs tools/test-engine.js tools/test-settlement.js tools/test-settlement-view.js tools/test-settlement-transaction.js tools/test-settlement-http.js tools/test-share.js tools/test-migration-006.js tools/test-migration-007.js tools/test-migration-008.js tools/test-migration-009.js tools/test-migration-010.js tools/test-migration-011.js tools/test-migration-012.js tools/test-migration-013.js tools/test-migration-014.js tools/test-migration-015.js tools/test-migration-016.js tools/test-password-hash.js tools/test-startup-config.js tools/test-trust-proxy.js tools/test-auth-security.js tools/test-secure-files.js tools/test-files-http.js tools/test-error-handler.js tools/test-document-extractor.js tools/test-legalrag-bridge.js tools/test-legalrag-http.js tools/test-inbox-http.js tools/test-agent-config.js tools/test-agent-supervisor.js tools/test-agent-proposals.js tools/test-agent-proposals-http.js tools/test-agent-settings.js tools/test-agent-http.js tools/test-agent-session-read-http.js tools/test-secret-box.js tools/test-agent-models-client.js tools/test-agent-models-http.js tools/test-agent-model-options.js tools/test-pack-manifest.js electron/main.js electron/backend-env.js tools/test-electron-backend-env.js tools/smoke-agent-frontend.js tools/smoke-agent-profile-frontend.js build/adhoc-sign.cjs build/afterpack-agent-runtime-link.cjs build/ensure-cross-arch-optional-deps.mjs; do
  node --check "$f"
done
# 原生 DOM 的 append()/prepend() 会把 null 转成字符串 "null" 塞进页面（api.js 的 el() 才会跳过）。
# 1.0.1 实测踩过：零已到期期限时统计页真的印出一个「null」。条件渲染一律用 if，别写 ? : null。
if grep -rnE '\.(append|prepend)\(.*\?.*:[[:space:]]*null[[:space:]]*\)' public/js/ ; then
  echo "  ❌ 上面这些地方会把 null 印成字符串——改成 if (cond) x.append(y)"
  exit 1
fi
echo "  ok"

echo "[2/45] rules JSON 合法性"
node -e "
const fs = require('fs');
for (const f of ['rules/event_types.json','rules/stage_templates.json','rules/deadline_rules.json','rules/holidays-2026.json']) {
  JSON.parse(fs.readFileSync(f, 'utf8'));
}
console.log('  ok');
"

echo "[3/45] migration 干跑（临时库）"
TMPDIR_CHECK=$(mktemp -d)
DB_PATH="$TMPDIR_CHECK/check.db" node -e "import('./src/db.js').then(() => console.log('  ok'))"

echo "[4/45] migration 005 → 006 fixture + 原子性测试"
DB_PATH="$TMPDIR_CHECK/migration-006.db" node tools/test-migration-006.js

echo "[5/45] migration 006 → 007 fixture + 原子性测试"
DB_PATH="$TMPDIR_CHECK/migration-007.db" node tools/test-migration-007.js

echo "[6/45] migration 007 → 008 fixture + 原子性测试"
DB_PATH="$TMPDIR_CHECK/migration-008.db" node tools/test-migration-008.js

echo "[7/45] migration 008 → 009 文件桥 + 原子性测试"
DB_PATH="$TMPDIR_CHECK/migration-009.db" node tools/test-migration-009.js

echo "[8/45] migration 009 → 010 人类语义字段 + 原子性测试"
DB_PATH="$TMPDIR_CHECK/migration-010-bootstrap.db" node tools/test-migration-010.js

echo "[9/45] migration 010 → 011 推荐反馈 + 候选事实层"
DB_PATH="$TMPDIR_CHECK/migration-011-bootstrap.db" node tools/test-migration-011.js

echo "[10/45] migration 011 → 012 款项凭证指针"
DB_PATH="$TMPDIR_CHECK/migration-012-bootstrap.db" node tools/test-migration-012.js

echo "[11/45] migration 012 → 013 去个人化 actor（带存量数据的 fixture）"
DB_PATH="$TMPDIR_CHECK/migration-013-bootstrap.db" node tools/test-migration-013.js

echo "[12/45] migration 013 → 014 settings 键值表（带存量数据的 fixture）"
DB_PATH="$TMPDIR_CHECK/migration-014-bootstrap.db" node tools/test-migration-014.js

echo "[13/45] migration 014 → 015 tasks 截止时刻（带存量数据的 fixture）"
DB_PATH="$TMPDIR_CHECK/migration-015-bootstrap.db" node tools/test-migration-015.js

echo "[14/45] migration 015 → 016 sessions UTC（带存量数据的 fixture）"
DB_PATH="$TMPDIR_CHECK/migration-016-bootstrap.db" node tools/test-migration-016.js

echo "[15/45] 密码 hash 版本与 legacy 兼容"
node tools/test-password-hash.js

echo "[16/45] 启动 fail-closed + trusted proxy 解析"
node tools/test-startup-config.js
node tools/test-trust-proxy.js

echo "[17/45] 会话、恒时凭据比较与案件文件安全边界"
node tools/test-auth-security.js
node tools/test-secure-files.js
node tools/test-files-http.js

echo "[18/45] production 500 脱敏"
node tools/test-error-handler.js

echo "[19/45] 结算整数公式单元测试"
node tools/test-settlement.js

echo "[20/45] 律师资金卡 view model 测试"
node tools/test-settlement-view.js

echo "[21/45] 期限引擎单元测试"
DB_PATH="$TMPDIR_CHECK/engine.db" node tools/test-engine.js

echo "[22/45] 分成兼容 + 提醒单元测试（1.2.0/1.3.0 语义）"
DB_PATH="$TMPDIR_CHECK/share.db" node tools/test-share.js

echo "[23/45] 外层结算事务组合回归"
DB_PATH="$TMPDIR_CHECK/settlement-transaction.db" node tools/test-settlement-transaction.js

echo "[24/45] 结算 HTTP 回归（临时库 + 临时端口）"
node tools/test-settlement-http.js

echo "[25/45] LegalRAG 语义筛选 + 文件桥队列 + 提取候选单元回归"
node tools/test-document-extractor.js
DB_PATH="$TMPDIR_CHECK/legalrag-bridge.db" node tools/test-legalrag-bridge.js

echo "[26/45] LegalRAG 候选人工确认 HTTP 回归"
DB_PATH="$TMPDIR_CHECK/legalrag-http.db" node tools/test-legalrag-http.js

echo "[27/45] L2 推荐去重与裁决记忆 HTTP 回归"
node tools/test-inbox-http.js

echo "[28/45] API 冒烟（临时库 + 临时端口）"
PORT=39770
DB_PATH="$TMPDIR_CHECK/smoke.db" PORT=$PORT NODE_ENV=test HOST=127.0.0.1 ANJIAN_UNSAFE_NO_AUTH=1 node server.js >"$TMPDIR_CHECK/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true; rm -rf "$TMPDIR_CHECK"' EXIT
for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.2; done

curl -fsS "http://127.0.0.1:$PORT/healthz" | grep -q '"ok":true'
CID=$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/cases" -H 'Content-Type: application/json' \
  -d '{"name":"冒烟测试案（张三）","procedure":"一审","client":"张三","cause":"冒烟案由","court":"示例法院"}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
curl -fsSG "http://127.0.0.1:$PORT/api/cases" --data-urlencode 'q=冒烟案由' | grep -q "\"id\":$CID"
curl -fsSG "http://127.0.0.1:$PORT/api/cases" --data-urlencode 'q=示例法院' | grep -q "\"id\":$CID"
curl -fsS -X POST "http://127.0.0.1:$PORT/api/cases/$CID/events" -H 'Content-Type: application/json' \
  -d '{"type":"filed","occurred_on":"2026-01-05"}' >/dev/null
curl -fsS -X POST "http://127.0.0.1:$PORT/api/cases/$CID/deadlines" -H 'Content-Type: application/json' \
  -d '{"name":"冒烟期限","due_on":"2099-01-01","severity":"high"}' >/dev/null
curl -fsS "http://127.0.0.1:$PORT/api/digest" | grep -q '"fees_due"'
curl -fsS "http://127.0.0.1:$PORT/api/cases/$CID" | grep -q '冒烟期限'
curl -fsS -X POST "http://127.0.0.1:$PORT/api/cases/$CID/fees" -H 'Content-Type: application/json' \
  -d '{"label":"签约款","amount":5000,"due_on":"2099-01-02"}' >/dev/null
curl -fsS "http://127.0.0.1:$PORT/api/cases/$CID/fees" | node -e "process.stdin.on('data',d=>{const r=JSON.parse(d);if(r.total_unpaid!==5000||r.files_enabled!==false)process.exit(1)})"
# 完成待办自动写工作日志：状态和留痕同事务；重复 PATCH 不重复造日志。
TID=$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/tasks" -H 'Content-Type: application/json' \
  -d "{\"case_id\":$CID,\"title\":\"整理冒烟证据清单\",\"plan_date\":\"2026-07-29\"}" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
curl -fsS -X PATCH "http://127.0.0.1:$PORT/api/tasks/$TID" -H 'Content-Type: application/json' \
  -d '{"status":"done"}' | node -e "process.stdin.on('data',d=>{const r=JSON.parse(d);if(r.status!=='done'||!r.done_at||r.completion_worklog?.content!=='完成待办：整理冒烟证据清单')process.exit(1)})"
curl -fsS -X PATCH "http://127.0.0.1:$PORT/api/tasks/$TID" -H 'Content-Type: application/json' \
  -d '{"status":"done"}' | node -e "process.stdin.on('data',d=>{const r=JSON.parse(d);if(r.completion_worklog!==null)process.exit(1)})"
curl -fsS "http://127.0.0.1:$PORT/api/cases/$CID" | node -e "process.stdin.on('data',d=>{const r=JSON.parse(d),logs=r.worklog.filter(x=>x.content==='完成待办：整理冒烟证据清单');if(logs.length!==1)process.exit(1)})"
# 快录整理（1.1.0）：**LLM 不可用时绝不能挡住录入**——这条比整理本身重要
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"text":"x"}' "http://127.0.0.1:$PORT/api/quick/parse")" = "503" ]   # 没配 key → 503，不是 500
curl -fsS "http://127.0.0.1:$PORT/api/counts" | grep -q '"llm":false'      # 前端据此不渲染按钮
curl -fsS -X POST "http://127.0.0.1:$PORT/api/quick" -H 'Content-Type: application/json' \
  -d '{"kind":"task","text":"没有 LLM 也要能手动记"}' | grep -q '"kind":"task"'
# /api/stats（1.0.1）：口径断言，不是「有响应就算过」
curl -fsS "http://127.0.0.1:$PORT/api/stats" | grep -q '"due_total"'
curl -fsS "http://127.0.0.1:$PORT/api/stats" | grep -q '"aging"'
# 无已到期期限时 compliance 必须是 null，不许是 0 或 100——假的满分比没有数字更糟
curl -fsS "http://127.0.0.1:$PORT/api/stats" | grep -q '"compliance":null'
# 刚录的 5000 未付款要出现在应收里（口径：unpaid 且有金额）
curl -fsS "http://127.0.0.1:$PORT/api/stats" | grep -q '"unpaid_total":5000'
# 分成（1.2.0）：约定 → 收讫联动生成 → 结清后从提醒消失（铁律②：digest 死代码可测）
# 位置刻意在 unpaid_total 断言之后——下面要把这笔 5000 标 paid，提前会把 unpaid_total 打成 0
curl -fsS "http://127.0.0.1:$PORT/api/digest" | grep -q '"shares_pending"'
# 无 active payable/assignment/history 的旧款项仍可安全直改 paid；有结算上下文时 fees.js 会强制走 preview/confirm。
FID=$(curl -fsS "http://127.0.0.1:$PORT/api/cases/$CID/fees" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).items[0].id))")
curl -fsS -X PATCH "http://127.0.0.1:$PORT/api/fees/$FID" -H 'Content-Type: application/json' -d '{"status":"paid"}' >/dev/null
AGR1=$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/cases/$CID/share-agreements" -H 'Content-Type: application/json' \
  -d '{"direction":"payable","counterpart":"李四","effective_on":"2026-01-01","label":"五成初始公式","change_note":"冒烟初始化","result_kind":"rate","result_basis":"gross","result_rate_bps":5000,"deductions":[]}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
curl -fsS -X POST "http://127.0.0.1:$PORT/api/shares" -H 'Content-Type: application/json' \
  -d "{\"fee_item_id\":$FID,\"agreement_id\":$AGR1,\"case_id\":$CID,\"direction\":\"payable\",\"counterpart\":\"李四\",\"amount\":2500}" >/dev/null
curl -fsS "http://127.0.0.1:$PORT/api/cases/$CID/shares" | grep -q '"amount":2500'
curl -fsS "http://127.0.0.1:$PORT/api/digest" | grep -q '"counterpart":"李四"'
curl -fsS "http://127.0.0.1:$PORT/api/stats" | grep -q '"share_payable_year":2500'
SID=$(curl -fsS "http://127.0.0.1:$PORT/api/cases/$CID/shares" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).items[0].id))")
curl -fsS -X PATCH "http://127.0.0.1:$PORT/api/shares/$SID" -H 'Content-Type: application/json' -d '{"status":"settled"}' >/dev/null
curl -fsS "http://127.0.0.1:$PORT/api/digest" | grep -q '"shares_pending":\[\]'
# ── 1.3.0：总账净口径 ── 收讫联动后 /fees/overview 带净字段，且 fee item 带其分成
curl -fsS "http://127.0.0.1:$PORT/api/fees/overview" | grep -q '"net_retained"'
curl -fsS "http://127.0.0.1:$PORT/api/fees/overview" | grep -q '"share_payable"'
# 联动出的 2500 应付进全局 share_payable，且挂在那笔 fee item 上
curl -fsS "http://127.0.0.1:$PORT/api/fees/overview" | grep -q '"shares":\[{'
curl -fsS "http://127.0.0.1:$PORT/api/fees/overview" | node -e "process.stdin.on('data',d=>{const o=JSON.parse(d),c=o.cases.find(x=>x.case_id===Number(process.argv[1]));if(o.totals.net_retained!==o.totals.paid-o.totals.share_payable+o.totals.share_receivable)throw Error('全局总账未计入分成');if(!c||c.net_retained!==c.paid-c.shares.payable+c.shares.receivable)throw Error('案件净额未计入分成')})" "$CID"
# ── 手动挂账 ── 给既有 share 挂款（同案 fee_item）成功
SID2=$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/shares" -H 'Content-Type: application/json' \
  -d "{\"case_id\":$CID,\"direction\":\"payable\",\"counterpart\":\"王五\",\"amount\":300,\"due_month\":\"2026-02\",\"note\":\"历史特殊分成\"}" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
curl -fsS "http://127.0.0.1:$PORT/api/cases/$CID/shares" | node -e "process.stdin.on('data',d=>{const x=JSON.parse(d).items.find(s=>s.id===Number(process.argv[1]));if(!x||x.due_month!=='2026-02'||x.note!=='历史特殊分成')throw Error('案件分成未保留月份/备注')})" "$SID2"
curl -fsS "http://127.0.0.1:$PORT/api/shares/overview" | node -e "process.stdin.on('data',d=>{const x=JSON.parse(d).items.find(s=>s.id===Number(process.argv[1]));if(!x||x.due_month!=='2026-02'||x.note!=='历史特殊分成')throw Error('总账分成未保留月份/备注')})" "$SID2"
curl -fsS -X PATCH "http://127.0.0.1:$PORT/api/shares/$SID2" -H 'Content-Type: application/json' -d '{"due_month":"2026-03"}' \
  | node -e "process.stdin.on('data',d=>{const x=JSON.parse(d);if(x.due_month!=='2026-03'||x.note!=='历史特殊分成')throw Error('改月份不得丢失既有备注')})"
BAD_MONTH_RC=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/shares" -H 'Content-Type: application/json' \
  -d "{\"case_id\":$CID,\"direction\":\"payable\",\"counterpart\":\"赵六\",\"amount\":100,\"due_month\":\"2026-13\"}")
[ "$BAD_MONTH_RC" = "400" ] || { echo "  非法分成月份应 400，实际 $BAD_MONTH_RC"; exit 1; }
curl -fsS -X PATCH "http://127.0.0.1:$PORT/api/shares/$SID2" -H 'Content-Type: application/json' -d "{\"fee_item_id\":$FID}" | grep -q "\"fee_item_id\":$FID"
# ── 1.4 公式约定不得再由通用 /shares 入口暗算 ──
AGR2=$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/cases/$CID/share-agreements" -H 'Content-Type: application/json' \
  -d '{"direction":"payable","counterpart":"孙七","effective_on":"2026-01-01","label":"一成初始公式","change_note":"冒烟初始化","result_kind":"rate","result_basis":"gross","result_rate_bps":1000,"deductions":[]}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
PLAN_RC=$(curl -s -o "$TMPDIR_CHECK/formula-plan-required.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/shares" -H 'Content-Type: application/json' \
  -d "{\"fee_item_id\":$FID,\"agreement_id\":$AGR2,\"case_id\":$CID,\"direction\":\"payable\",\"counterpart\":\"孙七\"}")
[ "$PLAN_RC" = "409" ] || { echo "  新公式约定绕过 plan 应 409，实际 $PLAN_RC"; exit 1; }
[ "$(node -e "console.log(require('$TMPDIR_CHECK/formula-plan-required.json').code)")" = "agreement_formula_requires_plan" ]
# pure fixed 同样只建公式，不先造台账；通用挂款入口必须拒绝。
AGRF=$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/cases/$CID/share-agreements" -H 'Content-Type: application/json' \
  -d '{"direction":"payable","counterpart":"周八","effective_on":"2026-01-01","label":"固定额初始公式","change_note":"冒烟初始化","result_kind":"fixed","result_fixed_fen":20000,"deductions":[]}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
FLAT_RC=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/shares" -H 'Content-Type: application/json' -d "{\"fee_item_id\":$FID,\"agreement_id\":$AGRF,\"case_id\":$CID,\"direction\":\"payable\",\"counterpart\":\"周八\"}")
[ "$FLAT_RC" = "409" ] || { echo "  固定额公式绕过 plan 应 409，实际 $FLAT_RC"; exit 1; }
# ── 1.5.1 应收可先记暂定比例，但只形成约定，不提前造金额台账或进入 payable plan ──
AGRR=$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/cases/$CID/share-agreements" -H 'Content-Type: application/json' \
  -d '{"direction":"receivable","counterpart":"刘律师","note":"暂按30%记录，扣税与律所费用待确定","settlement_term":"对方收到律师费当月","effective_on":"2026-01-01","label":"暂定三成","change_note":"先记录暂定比例","is_provisional":true,"pending_deductions":"税费、律所费用","result_kind":"rate","result_basis":"gross","result_rate_bps":3000,"deductions":[]}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
curl -fsS "http://127.0.0.1:$PORT/api/cases/$CID/shares" | node -e "process.stdin.on('data',d=>{const o=JSON.parse(d);const a=o.agreements.find(x=>x.id===Number(process.argv[1]));if(!a||a.direction!=='receivable'||a.latest_revision.result_rate_bps!==3000||a.latest_revision.is_provisional!==1||a.latest_revision.money_view.pending_deductions!=='税费、律所费用'||a.settlement_term!=='对方收到律师费当月'||o.items.some(s=>s.agreement_id===a.id))process.exit(1)})" "$AGRR"
curl -fsS "http://127.0.0.1:$PORT/api/fees/$FID/share-plans" | node -e "process.stdin.on('data',d=>{const o=JSON.parse(d);if(o.agreements.some(a=>a.direction==='receivable'))process.exit(1)})"
curl -fsS "http://127.0.0.1:$PORT/api/shares/overview" | node -e "process.stdin.on('data',d=>{const o=JSON.parse(d);const a=o.agreements.find(x=>x.id===Number(process.argv[1]));if(!a||a.direction!=='receivable'||o.items.some(s=>s.agreement_id===a.id))process.exit(1)})" "$AGRR"
# 跨案挂款被拒（另建一案，拿它的 fee_item 往本案 share 挂 → 400）
CID2=$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/cases" -H 'Content-Type: application/json' \
  -d '{"name":"跨案（赵六）","procedure":"一审","client":"赵六"}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
FID2=$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/cases/$CID2/fees" -H 'Content-Type: application/json' \
  -d '{"label":"签约款","amount":9999,"due_on":"2099-01-01"}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
[ "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "http://127.0.0.1:$PORT/api/shares/$SID2" -H 'Content-Type: application/json' -d "{\"fee_item_id\":$FID2}")" = "400" ]
# ── 应收不对称：外部应收进全局 share_receivable，但不进任何 case 面板 ──
curl -fsS -X POST "http://127.0.0.1:$PORT/api/shares" -H 'Content-Type: application/json' \
  -d '{"direction":"receivable","counterpart":"外部李四","amount":777,"external_case":"李四律师·某案"}' >/dev/null
curl -fsS "http://127.0.0.1:$PORT/api/fees/overview" | grep -q '"share_receivable":777'
# （可选强约束：外部案 case_id=NULL，不应在任何 cases[].shares.receivable 里——用 node 断言）
curl -fsS "http://127.0.0.1:$PORT/api/fees/overview" | node -e "process.stdin.on('data',d=>{const o=JSON.parse(d);const leak=o.cases.some(c=>c.shares.receivable>=777);if(leak){console.error('外部应收泄漏进面板');process.exit(1)}console.log('  外部应收仅进全局 ✓')})"
# ── 1.3.1 历史分成修复：真 HTTP 认领/保留/作废 + 409 + is_void 全链过滤 ──
RCID=$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/cases" -H 'Content-Type: application/json' \
  -d '{"name":"修复测试案（张三）","procedure":"一审","client":"张三"}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
RFID=$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/cases/$RCID/fees" -H 'Content-Type: application/json' \
  -d '{"label":"已收候选款","amount":1000}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
curl -fsS -X PATCH "http://127.0.0.1:$PORT/api/fees/$RFID" -H 'Content-Type: application/json' -d '{"status":"paid"}' >/dev/null
RSOFT_FID=$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/cases/$RCID/fees" -H 'Content-Type: application/json' \
  -d '{"label":"软重复参照款","amount":1000}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
curl -fsS -X PATCH "http://127.0.0.1:$PORT/api/fees/$RSOFT_FID" -H 'Content-Type: application/json' -d '{"status":"paid"}' >/dev/null
XCID=$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/cases" -H 'Content-Type: application/json' \
  -d '{"name":"跨案修复测试（李四）","procedure":"一审","client":"李四"}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
XFID=$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/cases/$XCID/fees" -H 'Content-Type: application/json' \
  -d '{"label":"跨案已收款","amount":1000}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
curl -fsS -X PATCH "http://127.0.0.1:$PORT/api/fees/$XFID" -H 'Content-Type: application/json' -d '{"status":"paid"}' >/dev/null
REPAIR_FIXTURE=$(DB_PATH="$TMPDIR_CHECK/smoke.db" RCID="$RCID" RFID="$RFID" RSOFT_FID="$RSOFT_FID" DUE_MONTH="$(date +%Y-%m)" node --input-type=module - <<'NODE'
import { db } from './src/db.js';
const caseId = Number(process.env.RCID);
const feeId = Number(process.env.RFID);
const softFeeId = Number(process.env.RSOFT_FID);
const dueMonth = process.env.DUE_MONTH;
const insertShare = db.prepare(`INSERT INTO fee_shares
  (case_id, fee_item_id, direction, counterpart, amount, due_month, status)
  VALUES (?, ?, 'payable', ?, ?, ?, ?)`);
const insertRepair = db.prepare("INSERT INTO share_repair_queue (fee_share_id, issue_code) VALUES (?, 'legacy_settled_unlinked')");
const duplicateId = insertShare.run(caseId, softFeeId, '王五', 300, dueMonth, 'settled').lastInsertRowid;
const claimShareId = insertShare.run(caseId, null, '王五', 300, dueMonth, 'settled').lastInsertRowid;
const protectedShareId = insertShare.run(caseId, null, '孙七', 400, dueMonth, 'settled').lastInsertRowid;
const voidShareId = insertShare.run(caseId, feeId, '周八', 888, dueMonth, 'pending').lastInsertRowid;
const claimRepairId = insertRepair.run(claimShareId).lastInsertRowid;
const protectedRepairId = insertRepair.run(protectedShareId).lastInsertRowid;
const voidRepairId = insertRepair.run(voidShareId).lastInsertRowid;
console.log(JSON.stringify({ duplicateId, claimShareId, protectedShareId, voidShareId, claimRepairId, protectedRepairId, voidRepairId }));
db.close();
NODE
)
export REPAIR_FIXTURE RCID RFID XFID
CLAIM_REPAIR_ID=$(node -e "console.log(JSON.parse(process.env.REPAIR_FIXTURE).claimRepairId)")
PROTECTED_REPAIR_ID=$(node -e "console.log(JSON.parse(process.env.REPAIR_FIXTURE).protectedRepairId)")
PROTECTED_SHARE_ID=$(node -e "console.log(JSON.parse(process.env.REPAIR_FIXTURE).protectedShareId)")
CLAIM_CONFLICT_BODY=$(node -e 'console.log(JSON.stringify({fee_item_id:Number(process.env.RFID),resolution_note:"人工核对来源",version:1}))')
CLAIM_MISSING_REASON_BODY=$(node -e 'console.log(JSON.stringify({fee_item_id:Number(process.env.RFID),resolution_note:"人工确认但未说明",version:1,confirm_independent:true,exception_reason:""}))')
CLAIM_SUCCESS_BODY=$(node -e 'console.log(JSON.stringify({fee_item_id:Number(process.env.RFID),resolution_note:"人工确认独立分成",version:1,confirm_independent:true,exception_reason:"同款含两项独立约定"}))')
CROSS_CLAIM_BODY=$(node -e 'console.log(JSON.stringify({fee_item_id:Number(process.env.XFID),resolution_note:"不应跨案",version:1}))')
PATCH_PROTECTED_BODY=$(node -e 'console.log(JSON.stringify({fee_item_id:Number(process.env.RFID)}))')
curl -fsS "http://127.0.0.1:$PORT/api/share-repairs?status=open" | node -e "const assert=require('assert');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const rows=JSON.parse(s), f=JSON.parse(process.env.REPAIR_FIXTURE), r=rows.find(x=>x.id===f.claimRepairId);assert(r&&r.fee_candidates.some(x=>x.id===Number(process.env.RFID)),'修复单须给同案已收候选');assert(r.soft_duplicates.some(x=>x.id===f.duplicateId),'相同字段只作软重复提示');assert(!JSON.stringify(r).includes('contact_id'),'修复面不得泄漏 contacts 字段')})"
# 同案已收认领遇软重复，默认 409；确认独立性但没有例外理由也不得绕过。
[ "$(curl -sS -o "$TMPDIR_CHECK/repair-conflict.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/share-repairs/$CLAIM_REPAIR_ID/claim" -H 'Content-Type: application/json' -d "$CLAIM_CONFLICT_BODY")" = "409" ]
node -e "const r=require('$TMPDIR_CHECK/repair-conflict.json');if(r.code!=='source_claim_conflict'||!r.soft_duplicates?.length)process.exit(1)"
[ "$(curl -sS -o "$TMPDIR_CHECK/repair-missing-reason.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/share-repairs/$CLAIM_REPAIR_ID/claim" -H 'Content-Type: application/json' -d "$CLAIM_MISSING_REASON_BODY")" = "409" ]
node -e "if(require('$TMPDIR_CHECK/repair-missing-reason.json').code!=='source_claim_conflict')process.exit(1)"
curl -fsS -X POST "http://127.0.0.1:$PORT/api/share-repairs/$CLAIM_REPAIR_ID/claim" -H 'Content-Type: application/json' \
  -d "$CLAIM_SUCCESS_BODY" | node -e "process.stdin.on('data',d=>{const r=JSON.parse(d).repair;if(r.status!=='claimed'||r.share.fee_item_id!==Number(process.env.RFID)||r.version!==2)process.exit(1)})"
# 跨案来源拒绝；open 修复单也不能靠普通 PATCH/DELETE 绕过。
[ "$(curl -sS -o "$TMPDIR_CHECK/repair-cross.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/share-repairs/$PROTECTED_REPAIR_ID/claim" -H 'Content-Type: application/json' -d "$CROSS_CLAIM_BODY")" = "400" ]
node -e "if(require('$TMPDIR_CHECK/repair-cross.json').code!=='fee_item_case_mismatch')process.exit(1)"
[ "$(curl -sS -o "$TMPDIR_CHECK/repair-patch.json" -w '%{http_code}' -X PATCH "http://127.0.0.1:$PORT/api/shares/$PROTECTED_SHARE_ID" -H 'Content-Type: application/json' -d "$PATCH_PROTECTED_BODY")" = "409" ]
[ "$(node -e "console.log(require('$TMPDIR_CHECK/repair-patch.json').code)")" = "legacy_repair_required" ]
[ "$(curl -sS -o "$TMPDIR_CHECK/repair-delete.json" -w '%{http_code}' -X DELETE "http://127.0.0.1:$PORT/api/shares/$PROTECTED_SHARE_ID")" = "409" ]
[ "$(node -e "console.log(require('$TMPDIR_CHECK/repair-delete.json').code)")" = "legacy_repair_required" ]
curl -fsS -X POST "http://127.0.0.1:$PORT/api/share-repairs/$PROTECTED_REPAIR_ID/retain" -H 'Content-Type: application/json' \
  -d '{"resolution_note":"暂无可核对来源，人工保留","version":1}' | grep -q '"status":"retained_unlinked"'
# 作废前后比对正常读/总账/统计/L0；作废入口不能经普通 PATCH/DELETE 回写。
VOID_ID=$(node -e "console.log(JSON.parse(process.env.REPAIR_FIXTURE).voidShareId)")
VOID_REPAIR_ID=$(node -e "console.log(JSON.parse(process.env.REPAIR_FIXTURE).voidRepairId)")
export VOID_ID
curl -fsS "http://127.0.0.1:$PORT/api/stats" > "$TMPDIR_CHECK/stats-before-void.json"
curl -fsS "http://127.0.0.1:$PORT/api/shares/overview" > "$TMPDIR_CHECK/shares-before-void.json"
curl -fsS "http://127.0.0.1:$PORT/api/fees/overview" > "$TMPDIR_CHECK/fees-before-void.json"
curl -fsS "http://127.0.0.1:$PORT/api/digest" > "$TMPDIR_CHECK/digest-before-void.json"
curl -fsS -X POST "http://127.0.0.1:$PORT/api/share-repairs/$VOID_REPAIR_ID/void" -H 'Content-Type: application/json' \
  -d '{"resolution_note":"人工确认重复录入，作废","version":1}' | node -e "process.stdin.on('data',d=>{const r=JSON.parse(d).repair;if(r.status!=='voided_duplicate'||r.share.is_void!==1)process.exit(1)})"
[ "$(curl -sS -o "$TMPDIR_CHECK/void-patch.json" -w '%{http_code}' -X PATCH "http://127.0.0.1:$PORT/api/shares/$VOID_ID" -H 'Content-Type: application/json' -d '{"amount":1}')" = "409" ]
[ "$(node -e "console.log(require('$TMPDIR_CHECK/void-patch.json').code)")" = "voided_share_read_only" ]
[ "$(curl -sS -o "$TMPDIR_CHECK/void-delete.json" -w '%{http_code}' -X DELETE "http://127.0.0.1:$PORT/api/shares/$VOID_ID")" = "409" ]
[ "$(node -e "console.log(require('$TMPDIR_CHECK/void-delete.json').code)")" = "voided_share_read_only" ]
curl -fsS "http://127.0.0.1:$PORT/api/cases/$RCID/shares" > "$TMPDIR_CHECK/case-shares-after-void.json"
curl -fsS "http://127.0.0.1:$PORT/api/shares/overview" > "$TMPDIR_CHECK/shares-after-void.json"
curl -fsS "http://127.0.0.1:$PORT/api/fees/overview" > "$TMPDIR_CHECK/fees-after-void.json"
curl -fsS "http://127.0.0.1:$PORT/api/stats" > "$TMPDIR_CHECK/stats-after-void.json"
curl -fsS "http://127.0.0.1:$PORT/api/digest" > "$TMPDIR_CHECK/digest-after-void.json"
node -e "const assert=require('assert'),fs=require('fs'),id=Number(process.env.VOID_ID),caseId=Number(process.env.RCID),feeId=Number(process.env.RFID),read=n=>JSON.parse(fs.readFileSync('$TMPDIR_CHECK/'+n));const beforeShares=read('shares-before-void.json'),afterShares=read('shares-after-void.json'),beforeFees=read('fees-before-void.json'),afterFees=read('fees-after-void.json'),beforeStats=read('stats-before-void.json'),afterStats=read('stats-after-void.json'),beforeDigest=read('digest-before-void.json'),afterDigest=read('digest-after-void.json'),caseShares=read('case-shares-after-void.json'),beforeFee=beforeFees.cases.find(x=>x.case_id===caseId).items.find(x=>x.id===feeId),afterFee=afterFees.cases.find(x=>x.case_id===caseId).items.find(x=>x.id===feeId);assert(!caseShares.items.some(x=>x.id===id),'作废行不得进案件正常分成列表');assert(!afterShares.items.some(x=>x.id===id),'作废行不得进分成总览');assert(beforeFee.shares.some(x=>x.id===id),'作废前行必须在来源款的分成明细中');assert(!afterFee.shares.some(x=>x.id===id),'作废行不得进来源款的分成明细');assert.equal(beforeShares.totals.payable_pending-afterShares.totals.payable_pending,888,'作废行不得进分成总账');assert.equal(beforeFees.totals.share_payable-afterFees.totals.share_payable,888,'作废行不得进律师费总览净额');assert.equal(beforeStats.fees.share_payable_year-afterStats.fees.share_payable_year,888,'作废行不得进统计');assert(beforeDigest.shares_pending.some(x=>x.id===id),'作废前 L0 应可见待分成');assert(!afterDigest.shares_pending.some(x=>x.id===id),'作废行不得进 L0');assert(!afterFees.cases.find(x=>x.case_id===caseId).shares.payable.toString().includes('NaN'),'案件聚合必须保持合法')"
DB_PATH="$TMPDIR_CHECK/smoke.db" node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { db } from './src/db.js';
const actions = db.prepare("SELECT action FROM audit_log WHERE entity='share_repair' ORDER BY id DESC LIMIT 3").all().map((r) => r.action).sort();
assert.deepEqual(actions, ['repair_claim', 'repair_retain', 'repair_void'], '三种人工裁决均须审计');
db.close();
NODE
# /internal：显式回环开发开关下可供隔离测试直达；正常模式无 key 恒 503。
curl -fsS "http://127.0.0.1:$PORT/internal/digest" >/dev/null
# 文件桥冒烟（临时文件根）：上传→列目录→取流→防穿越
FROOT="$TMPDIR_CHECK/files"
mkdir -p "$FROOT/冒烟测试案（张三）"
kill $SRV 2>/dev/null || true; sleep 0.3
DB_PATH="$TMPDIR_CHECK/smoke.db" PORT=$PORT NODE_ENV=test HOST=127.0.0.1 ANJIAN_UNSAFE_NO_AUTH=1 ANJIAN_FILES_ROOT="$FROOT" node server.js >>"$TMPDIR_CHECK/server.log" 2>&1 &
SRV=$!
for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.2; done
printf 'PDFBYTES' | curl -fsS -X PUT --data-binary @- "http://127.0.0.1:$PORT/api/cases/$CID/files?dir=%E6%B3%95%E9%99%A2%E6%96%87%E4%B9%A6&name=smoke.pdf" >/dev/null
curl -fsS "http://127.0.0.1:$PORT/api/cases/$CID/files?dir=%E6%B3%95%E9%99%A2%E6%96%87%E4%B9%A6" | grep -q smoke.pdf
curl -fsS "http://127.0.0.1:$PORT/api/cases/$CID/file?path=%E6%B3%95%E9%99%A2%E6%96%87%E4%B9%A6/smoke.pdf" | grep -q PDFBYTES
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/cases/$CID/file?path=../../etc/passwd")" = "404" ]
# 款项凭证（1.8.0）：原始字节上传→两处读取投影→删除被阻止→只解绑、原件保留
export FID
FVERSION=$(curl -fsS "http://127.0.0.1:$PORT/api/cases/$CID/fees" | node -e "process.stdin.on('data',d=>{const f=JSON.parse(d).items.find(x=>x.id===Number(process.env.FID));console.log(f.version)})")
VOUCHER_JSON=$(printf 'RECEIPTBYTES' | curl -fsS -X PUT --data-binary @- \
  "http://127.0.0.1:$PORT/api/fees/$FID/files?name=%E6%94%B6%E6%AC%BE%E5%87%AD%E8%AF%81.pdf&kind=receipt&version=$FVERSION")
export VOUCHER_JSON
VOUCHER_ID=$(node -e "console.log(JSON.parse(process.env.VOUCHER_JSON).file.id)")
VOUCHER_REL=$(node -e "console.log(JSON.parse(process.env.VOUCHER_JSON).file.rel_path)")
curl -fsS "http://127.0.0.1:$PORT/api/cases/$CID/fees" | node -e "process.stdin.on('data',d=>{const r=JSON.parse(d),f=r.items.find(x=>x.id===Number(process.env.FID));if(!r.files_enabled||f.vouchers.length!==1||f.vouchers[0].missing)process.exit(1)})"
curl -fsS "http://127.0.0.1:$PORT/api/fees/overview" | node -e "process.stdin.on('data',d=>{const r=JSON.parse(d),f=r.cases.flatMap(x=>x.items).find(x=>x.id===Number(process.env.FID));if(!r.files_enabled||f.vouchers.length!==1)process.exit(1)})"
[ -f "$FROOT/冒烟测试案（张三）/$VOUCHER_REL" ]
[ "$(curl -sS -o "$TMPDIR_CHECK/fee-delete-voucher.json" -w '%{http_code}' -X DELETE "http://127.0.0.1:$PORT/api/fees/$FID")" = "409" ]
[ "$(node -e "console.log(require('$TMPDIR_CHECK/fee-delete-voucher.json').code)")" = "fee_delete_blocked_by_vouchers" ]
curl -fsS -X DELETE "http://127.0.0.1:$PORT/api/fees/$FID/files/$VOUCHER_ID?version=$FVERSION" | grep -q '文件本体仍在案件夹'
[ -f "$FROOT/冒烟测试案（张三）/$VOUCHER_REL" ]
curl -fsS "http://127.0.0.1:$PORT/api/cases/$CID/fees" | node -e "process.stdin.on('data',d=>{const f=JSON.parse(d).items.find(x=>x.id===Number(process.env.FID));if(f.vouchers.length)process.exit(1)})"
# 案件夹→WebUI 回流（0.6.0）：外部往案件夹丢文件，SSE 必须推 change；否则「及时看到」就是空话
SSE_OUT="$TMPDIR_CHECK/sse.txt"
( curl -sN --max-time 6 "http://127.0.0.1:$PORT/api/cases/$CID/files/events" > "$SSE_OUT" & )
sleep 1
grep -q '"watching":true' "$SSE_OUT"   # fs.watch 挂上了（挂不上会退化成 degraded，前端走轮询）
printf 'EXTERNAL' > "$FROOT/冒烟测试案（张三）/法院文书/外部丢入.txt"
sleep 2
grep -q '^event: change' "$SSE_OUT"
# 指纹端点（SSE 不可用时的轮询降级路径）
curl -fsS "http://127.0.0.1:$PORT/api/cases/$CID/files/sig?dir=%E6%B3%95%E9%99%A2%E6%96%87%E4%B9%A6" | grep -q '外部丢入.txt'
echo "  ok"

echo "[29/45] 登录门冒烟（带 ANJIAN_USER 的实例）"
PORT2=39771
HASH=$(DB_PATH="$TMPDIR_CHECK/hash.db" node -e "import('./src/middleware/auth.js').then(m=>console.log(m.hashPassword('smoke-pass-123')))")
DB_PATH="$TMPDIR_CHECK/auth.db" PORT=$PORT2 NODE_ENV=test HOST=127.0.0.1 ANJIAN_UNSAFE_NO_AUTH= ANJIAN_USER=smokeuser ANJIAN_PASS_HASH="$HASH" node server.js >"$TMPDIR_CHECK/auth.log" 2>&1 &
SRV2=$!
trap 'kill $SRV $SRV2 2>/dev/null || true; rm -rf "$TMPDIR_CHECK"' EXIT
for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT2/healthz" >/dev/null 2>&1 && break; sleep 0.2; done
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT2/api/digest)" = "401" ]
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT2/)" = "302" ]
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:$PORT2/api/login -H 'Content-Type: application/json' -d '{"username":"smokeuser","password":"wrong"}')" = "401" ]
COOKIE=$(curl -s -D - -o /dev/null -X POST "http://127.0.0.1:$PORT2/api/login" -H 'Content-Type: application/json' \
  -d '{"username":"smokeuser","password":"smoke-pass-123"}' | grep -i '^set-cookie' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)
[ -n "$COOKIE" ]
curl -fsS -H "Cookie: $COOKIE" "http://127.0.0.1:$PORT2/api/digest" >/dev/null
echo "  ok"

echo "[30/45] DSH sidecar 设置白名单（enabled 门 + baseURL 允许域策略 + apiKeyEnv 保留名）"
node tools/test-agent-config.js

echo "[31/45] DSH sidecar supervisor（门禁红线 + turn/worker 生命周期回归）"
node tools/test-agent-supervisor.js

echo "[32/45] agent 提案闭环（proposal_id 幂等 + 同题异 ID 并存 + decline 记忆 + 与 L2 互不覆盖）"
node tools/test-agent-proposals.js

echo "[33/45] agent-proposals 路由回归（session 绑定信任边界 + kind/source/payload/source_ref 白名单 + 幂等状态码）"
node tools/test-agent-proposals-http.js

echo "[34/45] agent session 绑定只读面路由回归（agent-case-view/agent-digest 按 session 反查 case + 他案零泄漏 + 旧全所端点不受影响）"
node tools/test-agent-session-read-http.js

echo "[35/45] agent 设置白名单 HTTP 回归（enabled 布尔 + provider 枚举 + apiKeyEnv 保留名 + baseURL 协议/内网/官方域 + provider 联动 + 事务原子性）"
node tools/test-agent-settings.js

echo "[36/45] /api/agent* 路由回归（状态映射 + 输入校验 + interactions 信任边界 + SSE 建立/转发/反订阅）"
node tools/test-agent-http.js

echo "[37/45] 打包清单守卫（build.files 不得排除 server.js 静态 import 图里的任何 src/** 文件）"
node tools/test-pack-manifest.js

echo "[38/45] electron backend-env（dataDir 路径拼接 + ANJIAN_TEST_USERDATA 的 env+argv 双门）"
node tools/test-electron-backend-env.js

# 红线「agent_enabled=false 时整块 UI 不渲染」此前只有源码可读性背书，没有任何
# 可复跑的自动化：tools/smoke-agent-frontend.js 早就写好，却从未被 check.sh
# （或任何别的入口）调用过——终审时发现它是个孤儿文件。挂进来之后，case.html
# 提前硬编码助理入口、agent-drawer.js 把 counts.agent 特性探测门挪到挂载入口
# 按钮之后、前端监听的 SSE 事件名与后端真实广播源漂移，这三类回归都会在自检里
# 当场变红。该脚本自带固定端口 3009（与本文件其余步骤的 39770/39771 不冲突）
# 与临时库，跑完自行收尾。
echo "[39/45] 前端行为冒烟（counts.agent 特性探测门 + agent_* 五键往返 + SSE 帧到 DOM 映射静态审查）"
node tools/smoke-agent-frontend.js

# beta.2 易用性改造的「用户中心 · AI 助理」设置面重做（供应商联动自动带出
# baseURL、界面填 key + 掩码展示三态、拉取可用模型下拉、apiKeyEnv 退居高级
# 折叠项）：静态审查新控件/联动逻辑是否存在，并起真实 server.js 固定端口
# 3013 验证 agent_api_key 明文入参→加密落库→GET/PUT 只回掩码这条链路，
# 外加 apiKeyEnv 环境变量优先级、显式清空信号，在真实进程里都成立；本地假
# /models 服务器（node:http，OpenAI 兼容格式）验证 fetchProviderModels()
# 解析出的形状与前端期待一致，并确认 POST /api/agent/models 对回环地址仍然
# 400 拒绝（即使显式带 apiKey，配置期工具也不豁免 SSRF 校验）。固定端口
# 3013/该假服务器随机端口，与本文件其余步骤不冲突。
echo "[40/45] AI 助理设置面前端冒烟（新控件静态审查 + agent_api_key 掩码往返 + apiKeyEnv 优先级 + 本地假模型服务器）"
node tools/smoke-agent-profile-frontend.js

# 2026-08-23 复审修复：拉取模型成功后下拉框的默认选中项曾经可能是一个供应商
# 这次压根没返回的旧模型名（unshift 进渲染列表之后又用同一个列表判断"是否
# 命中"，判断恒为真）。把这条选项计算规则拆成不依赖 DOM 的纯函数
# buildModelOptions()（public/js/agent-model-options.js），这里单独跑它的
# Node 单测，不需要真实浏览器。
echo "[41/45] agent 模型下拉默认选中项纯逻辑自检（命中/未命中/空列表四类场景）"
node tools/test-agent-model-options.js

# 产品决策（2026-08-22，见 docs/agent-gates.md 门禁 1/3「已知限制」§3）：门禁
# 取证发现 rc.7 的 dsh-fs-sandbox 只对 write/edit 做 containment，read 对绝对
# 路径完全没有围栏；beta 因此把 dsh-tool-fs/dsh-tool-fs-search 整体从 preset
# 里拿掉，收口到「工具不存在」级别。这一步是纯文本机械守卫，防止未来有人
# 为了"方便模型读文件"又把这两行加回 preset/anqi/agent.cordis.yml，却没有
# 人重新评估这条围栏缺口——加回来的第一时间就在这里变红，逼这条评估发生。
echo "[42/45] preset 工具面机械守卫（不得再挂载模型侧文件读取工具）"
node -e "
const fs = require('fs');
const p = 'src/agent/assets/preset/anqi/agent.cordis.yml';
const text = fs.readFileSync(p, 'utf8');
const forbidden = [\"'@deepseek-ai/dsh-tool-fs'\", \"'@deepseek-ai/dsh-tool-fs-search'\"];
for (const name of forbidden) {
  if (text.includes(name)) {
    console.error('  ❌ preset 仍挂载 ' + name + '——beta 决策是模型侧不提供文件读取工具' +
      '（read/read_image/glob/grep），见 docs/agent-gates.md 门禁 1/3「已知限制」§3。' +
      '如确需恢复，必须先给 read 路径补上显式 containment，再回到这条守卫里放行。');
    process.exit(1);
  }
}
const required = [
  \"'@deepseek-ai/dsh-skill-filesystem'\", \"'@deepseek-ai/dsh-tool-skill'\",
  \"'@deepseek-ai/dsh-tool-todo'\", \"'@deepseek-ai/dsh-tool-ask-user'\",
  \"'../../plugins/dsh-anqi/index.js'\",
];
for (const name of required) {
  if (!text.includes(name)) {
    console.error('  ❌ preset 缺少必需行 ' + name + '——skill 加载依赖 dsh-skill-filesystem，' +
      '不是模型 fs 工具，误删会连带断掉 skill 内容加载。');
    process.exit(1);
  }
}
console.log('  ok（未发现 dsh-tool-fs / dsh-tool-fs-search；skill-filesystem/tool-skill/tool-todo/tool-ask-user/dsh-anqi 齐全）');
"

echo "[43/45] secret-box 静态加密自检（AES-256-GCM 往返 + 错误密钥/畸形密文安全失败 + secret.key 0o600 + ANJIAN_SECRET 熵校验）"
node tools/test-secret-box.js

echo "[44/45] agent models-client 网络层自检（本地假 /models 服务器：OpenAI 兼容格式解析 + 超时/大小上限/401/404/畸形 JSON/未知形状/3xx 重定向拦截全部映射成安全失败 + modelsErrorToHttpStatus() 映射表纯函数回归：上游认证失败不再映射到 401）"
node tools/test-agent-models-client.js

echo "[45/45] POST /api/agent/models 路由回归（provider/baseURL 与保存设置同一套 SSRF 字符串校验 + apiKey 取值优先级 请求体>仅 deepseek-official 允许的已保存 + 错误码映射(上游认证失败改回 502,不再误判为 anqi 会话过期) + 审计/响应体不含明文 key + public/js/api.js 401 判断分支静态回归）"
node tools/test-agent-models-http.js

echo "ALL GREEN ✅"
