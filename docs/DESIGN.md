# anjian 设计文档

初版 2026-07-11；持续随实现更新，当前覆盖 v2.6.0（未发布）。设计依据：`docs/RESEARCH.md`（值得借鉴的设计 D1–D8、PM 哲学 P1–P6，编号与 `report.html` 一致）。

## 0. 定位与非目标

**定位**：面向个人律师的案件台账、期限引擎与待办/日志系统；浏览器、CLI 和受信任的自动化客户端使用同一组受控接口。

**非目标**（明确不做，避免在迭代中无意长出）：

- 团队协作、复杂权限体系、客户 portal、计时计费和冲突检索；
- 可配置工作流引擎（阶段流程写在 `stage_templates`，改流程即改数据文件，不做 UI 配置器）；
- 第二套文档仓库（文件仍在部署者配置的案件夹中，系统只存指针）；
- 让 LLM 参与期限计算。

## 1. 架构总览

核心层彼此独立，可按自托管环境替换外围设施：

```
浏览器 ──HTTPS 反向代理──► Node + Express
                              │
                              ├─ PM 骨架：cases / tasks / worklog / inbox / stages
                              ├─ 法律引擎：events → rules → deadlines（确定性纯函数）
                              ├─ 接口：/api（人面）/internal（受信任自动化）
                              ├─ SQLite：业务数据与审计
                              └─ 案件夹：部署者配置的外部文件根

case CLI ─────────────────► /api
受信任自动化 ─────────────► /internal（独立 header key）
可选模型/文书服务 ─────────► 只产生表单建议或待人工裁决候选
```

**栈**：Node.js ESM + Express + better-sqlite3，前端为原生 HTML/CSS/JavaScript，无前端构建步骤。单进程与单文件数据库适合个人自托管和低功耗设备，也减少了部署与故障恢复形态。

## 2. 数据模型

SQLite，migration 走编号 SQL。以下是核心表结构示意；现行字段与约束以 `src/migrations/` 为准：

```sql
-- 案件。name 同时作为配置文件根下的单层案件夹名；兼容既有持久化标识
CREATE TABLE cases (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,          -- 例「张三诉李四民间借贷」（示例）
  case_no TEXT,                       -- 案号，立案前为空
  cause TEXT,                         -- 案由
  court TEXT,                         -- 法院/仲裁机构
  client TEXT, client_role TEXT,      -- 我方当事人 / 地位（原告|被告|申请人…）
  opponent TEXT,
  procedure TEXT NOT NULL,            -- 一审|二审|再审|执行|仲裁|非诉
  stage TEXT NOT NULL,                -- 当前阶段（stage_templates 词表内）
  stage_entered_at TEXT,              -- 进入当前阶段日 → 「停留 N 天」信号（D6）
  status TEXT NOT NULL DEFAULT 'active',  -- active|shelved|closed（shelved 语义同 registry）
  accepted_at TEXT,                   -- 收案日
  folder_path TEXT,                   -- 外部案件夹指针
  note TEXT,
  created_at TEXT, updated_at TEXT
);

-- 程序事件 = 期限触发器（D1）。只录「发生了什么、哪天」，派生交引擎
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  type TEXT NOT NULL,                 -- 词表：signed 签约|filed 立案受理|served_defense 收到应诉材料|
                                      -- evidence_notice 收到举证通知|summons 收到开庭传票|hearing 开庭|
                                      -- judgment_served 收到判决|ruling_served 收到裁定|mediation_served 调解书送达|
                                      -- judgment_effective 判决生效|preservation_order 保全裁定|execution_filed 申请执行…
  occurred_on TEXT NOT NULL,          -- 事件日（触发日期，用户唯一要录的日期）
  service_method TEXT,                -- 直接送达|邮寄|公告…（一等计算参数，D2）
  instrument TEXT,                    -- 文书依据（「(2026)粤0305民初XXXX号判决」）
  note TEXT,
  created_by TEXT NOT NULL DEFAULT 'manual',  -- manual|llm|import（llm 产物必经 inbox 确认后才落此表）
  created_at TEXT
);

-- 期限。engine 派生或手动；「法定死线」与 tasks.plan_date 语义严格分开（P4）
CREATE TABLE deadlines (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  name TEXT NOT NULL,                 -- 「上诉期（判决）」
  due_on TEXT NOT NULL,
  trigger_event_id INTEGER REFERENCES events(id),
  rule_id TEXT,                       -- deadline_rules.json 的 id；NULL=纯手动
  basis TEXT,                         -- 法律依据「民诉法 §171」
  calc_note TEXT,                     -- 算法说明（起算日/顺延轨迹），供人工复核——期限必须可审计
  is_manual_override INTEGER DEFAULT 0,  -- 法官实际指定/人工修正 → 级联重算默认排除（D4）
  severity TEXT NOT NULL DEFAULT 'normal',  -- critical|high|normal（critical=错过权利消灭）
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|done|missed|waived
  done_at TEXT, created_at TEXT
);

-- 待办。计划日 ≠ 死线（P4）：plan_date 是「我打算哪天动手」，法定死线只存 deadlines
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  case_id INTEGER REFERENCES cases(id),   -- NULL=所务/非案件
  title TEXT NOT NULL,
  plan_date TEXT,                     -- 计划开工日（软）
  due_on TEXT,                        -- 任务自身硬到期（外部承诺等；法定期限勿放这里）
  due_time TEXT NOT NULL DEFAULT '',  -- 截止时刻 HH:MM；空串=全天，不是开工时刻
  deadline_id INTEGER REFERENCES deadlines(id),  -- 可选：服务于哪条死线
  stage TEXT, priority TEXT DEFAULT 'normal',
  origin TEXT NOT NULL DEFAULT 'manual',  -- manual|template|llm
  status TEXT NOT NULL DEFAULT 'open',    -- open|done|dropped
  done_at TEXT, note TEXT, created_at TEXT
);

-- 工作日志（已完成工作留痕；worklog≠task：做了什么 vs 要做什么）
CREATE TABLE worklog (
  id INTEGER PRIMARY KEY,
  case_id INTEGER REFERENCES cases(id),
  worked_on TEXT NOT NULL,            -- 日期
  content TEXT NOT NULL,
  minutes INTEGER,                    -- 可选，不做计费只做自我观察
  artifacts TEXT,                     -- 产物指针（案件夹相对路径/URL，JSON 数组）
  created_at TEXT
);

-- 完成留痕由应用层事务保证：task 首次转 done 时，同步新增
-- worked_on=北京时间完成日、content="完成待办：<最终标题>" 的 worklog。
-- 重复提交 done 不重复造日志；重新打开后再次完成视为新的完成事实。
-- 阶段变更留痕同理：cases.stage 真变化时，同步新增
-- worked_on=北京时间当日、content="阶段变更：<旧>→<新>" 的 worklog（首设阶段为"进入阶段：<新>"）。

-- 收件箱（P1 Linear Triage）：一切非人工直录的东西先进这里，裁决后才落正式表
CREATE TABLE inbox (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                 -- event|deadline|task|note
  payload TEXT NOT NULL,              -- JSON：目标表的预填字段
  source TEXT NOT NULL,               -- llm-extract|llm-suggest|quick-capture|import
  source_ref TEXT,                    -- 来源指针（原文书路径/对话 id），供对照确认（AI 安全形态）
  case_id INTEGER REFERENCES cases(id),
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|accepted|declined|snoozed
  snooze_until TEXT, decided_at TEXT, created_at TEXT,
  intent_key TEXT,                    -- v1:case.next_action 等稳定意图；标题改写不改变身份
  state_fingerprint TEXT,             -- 仅由服务端按与意图相关的案件实质状态生成
  state_marker TEXT,                  -- 非敏感状态摘要，用于解释为何再次建议
  seen_count INTEGER DEFAULT 1,       -- 周检重复命中只累加，不新增卡片
  last_seen_at TEXT,
  decision_reason TEXT,
  accepted_entity TEXT, accepted_entity_id INTEGER,
  supersedes_inbox_id INTEGER REFERENCES inbox(id),
  change_summary TEXT
);

-- 节假日/调休表（国务院年度安排；年更脚本或手工）
CREATE TABLE holidays (
  date TEXT PRIMARY KEY,              -- 'YYYY-MM-DD'
  kind TEXT NOT NULL                  -- holiday（放假）|workday（调休补班）
);

-- 系统设置（键值）。当前只服务「用户中心 · 个人设置」六个抬头字段：
-- name/license_no/firm/phone/email/address。纯展示信息，不进期限引擎、不进任何计算。
-- 写入白名单在应用层（src/routes/settings.js），白名单外的键直接丢弃，schema 不约束键名。
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- 审计流水（谁在何时改了什么——单人系统也要，配合 LLM 层排障与期限争议自证）
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL, actor TEXT NOT NULL,  -- web|cli|internal|system（历史记录还可能含兼容值 hermes；登录会话值可由 ANJIAN_DEFAULT_ACTOR 配置）
  action TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER,
  detail TEXT
);
```

**contacts（004）**：案件联系人（当事人/对方/承办法官/法官助理/书记员/对方律师/合作律师），带电话/身份证号/单位/备注——敏感层级最高的表。**接口层硬边界：contacts 只出 `/api`（人面），永不进 `/internal`（自动化面）任何响应**（`internal.js` 有防回归注释）；audit 只记角色+姓名不落号码。

**款项凭证（012）**：`fee_item_files` 只保存款项与案件夹原件之间的指针：`fee_item_id`、`case_id`、案件夹内 `rel_path`、`kind ∈ {receipt, invoice, share_sheet, other}`、`size` 与创建时间。文件本体固定写入 `<案件夹>/财务凭证/`，不进 SQLite；同一案件内 `rel_path` 唯一。挂接与解除均校验款项当前 `version` 并写审计，解除只删关联行，绝不物理删除案件夹原件。夹内文件被移动或改名时，读取投影返回 `missing=true`，不自动重建。凭证不进 OCR、LegalRAG、LLM、inbox 或 `/internal`。

> 历史欠账（不复述 DDL，指向 migration 文件即可）：**002** 新增 `fee_items`（律师费款项）+ `sessions`（30 天滚动登录会话）；**016** 将 `sessions.created_at/last_seen` 统一为 UTC（保留存量 token，识别并保留运行期已写成 UTC 的续期值）；**003** 新增 `attachments`（案件夹文件**引用**表，§8.5）+ `cases.legalrag_url`（每案 LegalRAG 快捷链，§9.6-A）；**009** 新增 LegalRAG 案件映射、文件 revision/任务状态、提取运行与人工候选表（§8.7）；**011** 新增推荐反馈闭环字段与 `legalrag_candidate_facts` 逻辑事实层（§5、§8.7）；**012** 新增款项凭证指针（§8.5）。

**合作分成（005/006 既有台账；007 结算引擎）**：合作律师分成是「财务节律」，与期限引擎正交（不进 `deadlines`，见 §11 A10）。007 在既有数据之上增加「稳定约定 → 不可变公式版本 → 款项级方案 → 确认结算快照 → 已发生台账」五层；各层不可混用：

- **稳定约定 `fee_share_agreements`**：表示「本案与这个合作对象存在一项应付/应收安排」的长期身份，承载 `case_id`、`counterpart`、`direction ∈ {payable, receivable}`、可选 `contact_id`、`settlement_term` 与 `status ∈ {active, retired}`；`settlement_term` 用律师能直接理解的话记录“什么时候结算”，不承担金额计算。编辑姓名、联系人、结算约定或状态不等于改公式。005 已有的 `rate` / `flat_amount` 数据按原义保留，007 迁移只为其建立等价初始公式版本，不改既有约定 id，也不重算任何历史台账。
- **应收/应付约定的暂定口径**：`receivable` 与 `payable` 一样可先建立比例公式，不要求当下已有金额、来源款或完整扣费方案。扣税、律所费用等前置扣减尚未确定时，revision 以 `is_provisional=1` 标明暂定，并用 `pending_deductions` 记录尚待确定的扣费类别；方案确定后必须追加新的不可变 revision，不覆盖首版。此时只有约定与公式元数据，**不生成 `fee_shares`、不进入应收/应付金额、净实得、统计或 L0，也不得关联到正式款项方案或参与结算**。待实际分成基数与扣费口径明确后，先追加非暂定 revision；应收再由人工记入应收台账，应付才可关联具体 `fee_item`。应收约定不绑定我方客户的 `fee_item`，也不参与我方律师费收讫 completeness gate。案件页与费用页的约定区必须直接展示这类元数据，并与真正的“待收/待付金额台账”分层，不能因金额未知而把约定隐藏。
- **不可变公式版本 `fee_share_formula_revisions` + `fee_share_formula_deductions`**：每次修改算法都追加 revision。revision 的 schema 名固定为 `revision_no`、`effective_on`、`label`、`change_note`、`rounding_mode='toward_zero'`、`result_kind`、`result_basis`、`result_rate_bps`、`result_fixed_fen`、`is_provisional`、`pending_deductions`、`sealed`；deduction 用 `sequence` 固化顺序，并存 `label`、`kind`、`basis`、`fixed_fen`、`rate_bps`。`is_provisional=1` 只允许比例公式，表示比例可以先记录但前置扣费口径尚未闭合；`pending_deductions` 只保存待确定事项，不是可执行公式。revision 必须先以 `sealed=0` 插入，扣减就绪后只允许一次 `0→1` 封存；封存后 revision 与 deductions 均不可 UPDATE/DELETE。公式不是任意表达式，只允许有序扣减步骤后接一个终值步骤：扣减步骤 `kind ∈ {fixed, rate}`，rate 必须明确 `basis ∈ {gross, remaining}` 且有 label，fixed 必须有 label 且不得带 basis；终值只允许 `rate` 或 `fixed`，rate 同样必须明确 gross/remaining，pure fixed 不得有 deductions。计算从 `remaining_fen = gross_fen` 开始；fixed 扣减取整数 `fixed_fen`，rate 扣减取 `trunc(basis_fen × rate_bps / 10000)`，每步从 remaining 扣除但不得跨过零；轨迹同时保留 `calculated_amount_fen`、实际 `applied_amount_fen` 与 `clamped`。terminal fixed 直接取整数分，terminal rate 按选定 gross/最终 remaining 再作同式计算。金额统一安全整数分（fen），比例统一整数基点（bps，10000=100%），每一步向零取整后才进入下一步。唯一计算实现在服务端确定性纯函数；前端与 LLM 均不得复算、补算或接受任意公式文本。
- **款项级方案/决定 `fee_share_assignments`**：对某一 `fee_item` 与某一 agreement 作出 `status ∈ {assigned, not_applicable}` 决定。`assigned` 必须用 `formula_revision_id` 钉住同案、同 agreement、`sealed=1` 且 `is_provisional=0` 的 revision；暂定 revision 即使已封存也必须拒绝关联。assignment 同时保存 `revision_choice ∈ {initial, keep_current, adopt_latest}` 与 `version`；`not_applicable` 的 revision 必须为 NULL，`revision_choice='not_applicable'`。assignment 允许用于 `unpaid` 或 `paid` 款项，但只允许 active payable agreement；后者用于把 1.4 前已经收讫、尚无 engine run 的款项首次纳管。assignment 更新必须保留 `id/case_id/fee_item_id/agreement_id/created_at`，每次把 `version` **恰好 +1** 并写入新的 `updated_at`，不得原地静默改 plan。款项仍为 `unpaid` 时它只是前瞻 plan，**不产生 `fee_shares`、不进入费用/分成 totals、`/api/stats` 或 L0**。agreement 出现新 revision 后，既有 assignment 仍钉在旧版；界面必须让人明确选「保留已钉版本」或「采用新版」，不得静默漂移。agreement 退役只阻止新建/更新方案和新纳入结算，不删除既有 assignment；已有结算链的 correction 可沿用该款既有 assigned 方案，reversal 则以 source snapshot 为准，均不得要求为修历史而临时重新 active。
- **确认结算 `fee_share_settlement_runs` + `fee_share_settlement_snapshots`**：run 表示一次人工确认收讫/更正/冲销，持久化 `run_kind`、同案同款的 `source_run_id`、canonical `base_amount_fen`、`fee_version`、`target_status`、`paid_on` 与幂等/预览输入。每个 source run 最多一个直接后继，整条历史是单线链；correction 可接 receipt/correction/reversal（后者用于冲销后再次收讫），reversal 只可接目标为 paid 的 receipt/correction，第二个 receipt 永远不允许。snapshot 按本次涉及的 agreement 固化 `formula_revision_id`、`assignment_id`、`plan_version`、`revision_choice`、公式 JSON、逐步轨迹、基数、`desired_amount_fen`、`closed_amount_fen`、`new_amount_fen = desired - closed` 与可选 `source_snapshot_id`。receipt/correction 插入时 current assignment 的 `version` 和 pinned revision 必须分别等于 `plan_version` 与 `formula_revision_id`；assignment 日后升级不改旧 snapshot。reversal 不读取 current pin，而必须把 source snapshot 的 assignment id、plan version、revision/formula/trace/base/due month 原样冻结，避免显式改版或 agreement 退役后无法冲销。pure fixed 的 base 可为 NULL。correction 的 source snapshot 是同案同款同 agreement 的审计/公式沿袭，可指向更早快照而不必属于 immediate source run；新加入的 active agreement 可为 NULL，既有历史的 retired agreement 则继续沿用该款当前已钉 sealed revision。run 与 snapshot 确认后不可变，负责回答「当时按什么算、怎么算出来」；它们不是应收应付余额台账。
- **已发生台账 `fee_shares`**：只有确认结算后才登记实际发生的分成义务/权利，一笔一行；canonical 真相是 `amount_fen`/`base_amount_fen`，`amount`/`base_amount` 对 engine 行只能是 `CAST(fen AS REAL)/100.0` 的确定性兼容投影，绝不从 REAL 回算或覆盖 fen；legacy/manual 才允许从分精确 REAL 派生遗漏的 fen。`entry_kind ∈ {legacy, manual, calculated, adjustment}`。engine 行必须通过 `assignment_id`、`settlement_snapshot_id` 逐字段匹配同一 plan/snapshot/run，且 run kind 与 calculated/adjustment 对应；snapshot-linked 行的金额、来源和身份事实不可更新或删除，`due_month`（仍须 `YYYY-MM`）与 `note` 可作排程/注记维护，`status`/`settled_on` 只作单向生命周期。`new_amount_fen=0` 仍写 run/snapshot/audit 作为本次人工确认与计算证据，但不创建 0 元 `fee_shares`，避免伪造 pending 待办、占用 current-pending 唯一槽或进入 L0。cancellation 只允许作用于**尚未取消的 pending engine 行**，一次写齐 `cancelled_at`/`cancel_reason`/`cancelled_by_run_id`，且 cancelling run 必须是同案同款、含同 agreement snapshot 的 correction/reversal；settled/waived 不可取消。partial unique index 保证同一 `(fee_item_id, agreement_id)` 同时最多一条未取消 pending engine 行，因此更正事务顺序固定为「插 snapshot → 取消旧 pending → 非零时插替代行」。`amount` 仍沿用负数冲抵惯例，`status ∈ {pending, settled, waived}`；`case_id` 与 `fee_item_id` 继续可空（外部应收案可独立存在），挂款仍须同案；006 的 `is_void`、`voided_at`、`void_reason` 语义不变，`waived` 仍是减免而非作废。
- **005/006 历史语义原样保留**：005 已由旧收讫联动或人工入口生成的 share 是既有已发生事实，不因 007 回填 revision 而重算或补造 snapshot。006 的 `share_repair_queue` 仍是一条 `fee_share_id UNIQUE` 对一份修复单，保留 `issue_code`、`status ∈ {open, claimed, retained_unlinked, voided_duplicate}`、`proposed_fee_item_id`、裁决/例外理由、时间与乐观并发 `version`；仅迁移 006 当时满足 `settled AND case_id IS NOT NULL AND fee_item_id IS NULL AND agreement_id IS NULL AND base_amount IS NULL` 的存量行曾被 `INSERT OR IGNORE` 入队。外部案、已有来源款、固定额/比例约定行、已有基数、未结行仍不属于该队列。认领/保留/逻辑作废继续只靠人工裁决；跨款项的同案、方向、合作对象、金额、月份相同仍只是软提示。
- **008 同款分成义务防重**：正常口径下，同一 `fee_item_id` 的 share 若 agreement id 相同即属同一义务；任一侧 `agreement_id IS NULL` 时，以相同 `direction` + `TRIM(counterpart)` 精确相同识别（不作模糊姓名匹配）。`is_void=1` 或已 cancellation 的行不阻断。legacy/manual 与 engine 的同款同义务重叠是不可绕过的硬冲突，receipt/confirm、通用 POST/PATCH 与修复认领均须拒绝；`confirm_independent` 只保留给跨款项软提示。显式属于同 agreement 且已 `settled/waived` 的 legacy/manual 行可作为 correction 的 closed 事实（reversal 只计 settled）；`agreement_id IS NULL` 不得按姓名静默认领，必须先受控修复。008 前若已存在同案、同方向、同对象的重复 active agreement，迁移原样保全，但新 plan、receipt 与 correction 必须先拒绝并要求退役重复项；reversal 继续按 source snapshot 放行，以免无法撤销既有历史。
- **收讫门槛**：某款项首次确认收讫前，系统枚举该案当时所有 active `payable` agreements；每一项都必须已有状态为 `assigned` 的 assignment，或人工明确 `not_applicable`，缺一即拒绝确认。应收约定不构成本次「我方收到律师费」的阻断项。assignment 钉住的 revision 若已不是最新版，还必须先完成人工「保留/采用」选择。后续 correction 继续执行同一 active completeness gate，同时自动带上该款历史链里已经出现但现已 retired 的 payable agreement；这些退役历史项不得被静默丢弃，也不得新增到从未包含它们的结算链。reversal 只按 source run 的 snapshots 冲销。
- **预览与确认分离**：preview 是纯读、零写入，只返回服务端计算结果。confirm 不信任 preview 或前端回传金额，必须重新读款项、active payable agreements、plans 与 pinned revisions，重新按整数分/bps 逐步计算；随后在同一事务内完成 `fee_items: unpaid→paid`、不可变 run/snapshots、对应 `fee_shares` 与 `audit_log`。任一前置状态变化、决策缺失或写入失败，整笔回滚。服务若已处于更大的 `BEGIN IMMEDIATE` 中，内部计划/确认使用 savepoint；即使内层异常被外层捕获，也不得遗留半截 assignment、run、snapshot、share 或 audit。
- **更正与冲销只追加**：已确认 run、snapshot 与 snapshot-linked `fee_shares` 不覆盖、不删除。撤销收讫或更正金额/公式时，追加关联原记录的 cancellation / adjustment run、snapshot 与正负台账行；余额由原行与冲销/调整行合计得出，历史链始终可复核。legacy/manual 行若记录的已发生事实本身有误（例如把实际支付金额录错），允许在独立备份、精确断言、单一受控事务和 `audit_log` before/after 下作事实纠正；不得为了保留错误录入而制造现实中未发生的正负财务调整。
- **正常口径**：总账、统计与 L0 只读已发生且 `is_void=0 AND cancelled_at=''` 的 `fee_shares`；未付款项的 plan、preview、run 草稿（系统不持久化 preview）一律不进入。提醒仍为 `status='pending' AND due_month ≤ 当月`，跨月标逾期，`settled/waived` 消失。
- **接口与隐私边界**：agreement 的公式版本、fee-specific plans、preview/confirm/correction 全部只出 cookie 鉴权的 `/api` 人面；`/internal` 不新增公式、方案、预览或确认接口，digest 仍只投影已发生台账的必要字段。分成继续没有 inbox、quick 或任何 LLM 读写/计算路径；contacts 颗粒字段仍不外泄。

**007 迁移边界（已完成）**：007 只做增量建表/索引与 005 约定的等价初始 revision 回填；不改写 005 已生成的 `fee_shares`，不改变 006 修复队列筛选、状态机、乐观并发或逻辑作废语义。**008 迁移边界**：只新增同款义务冲突索引/触发器并重建 closed 校验触发器，不自动删除、作废、认领或重算既有坏数据；既有冲突必须经人工裁决或仓库外受控修复。**010 迁移边界**：只增加 `settlement_term`、`is_provisional`、`pending_deductions` 三个人类语义字段，并按通用备注语义识别旧暂定版本；不按案件名、合作人或比例特判，不改公式、不生成金额台账。暂定 revision 即使已经 sealed，也不能建立正式款项 assignment。

阶段与规则不是表，是**数据文件**（版本进 git，改动可 review）：`rules/deadline_rules.json`、`rules/stage_templates.json`、`rules/holidays-<year>.json`。

## 3. 期限引擎（法律层核心，确定性纯函数）

### 3.1 规则 schema（吸收 D1–D5）

```jsonc
// rules/deadline_rules.json 单条示例
{
  "id": "appeal_judgment",
  "name": "上诉期（判决）",
  "trigger": "judgment_served",          // 触发事件驱动批量派生（D1）：录一个事件，命中的规则全部出期限
  "kind": "statutory",                   // statutory 法定固定 | court_specified 法院指定（如举证期限→录入不推算，标 ❓ 直到录入）
  "days": 15, "unit": "natural_days",
  "direction": "after",                  // after | before（「开庭前 X 日」类倒排）
  "count_from": "next_day",              // 期间起算日不计入（民诉法 §85）
  "roll": "forward",                     // 届满日撞节假日的顺延方向是每条规则的属性（D3），不是全局常量
  "service_modifiers": {                 // 送达方式一等参数（D2）
    "公告送达": { "note": "自公告期满之日起算", "prepend_days": 30 }
  },
  "extendable": false,                   // 可否申请延长（举证期限 true / 上诉期 false）
  "expiry_becomes_event": "judgment_effective",  // 期限届满可派生新事件：上诉期满未上诉→判决生效→再审 6 月/申请执行 2 年起算链
  "applies_procedure": ["一审"],
  "basis": "民诉法 §171",
  "severity": "critical"
}
```

**首批规则**（≈20–30 条即覆盖中国民诉单辖区——规则库是内容资产（D5），编纂质量按执业事故防线标准，每条带法条依据）：
答辩期 15 日 · 管辖异议 15 日 · 上诉期判决 15/裁定 10 日 · 申请再审 6 个月 · 诉讼时效 3 年/最长 20 年（时效挂 case 级不挂 event，见未决 Q2）· 举证期限（court_specified）· 开庭/缴费（文书载明日）· 保全续封（按财产类型）· 执行申请 2 年 · 二审开庭前置项 · 劳动仲裁类（后补）。

### 3.2 计算规范

```
due_on = roll(count(occurred_on, rule), holidays, rule.roll)
  count: direction=after → occurred_on 次日起算第 N 日（count_from=next_day）；before → 锚日倒推 N 日
  service_modifiers[event.service_method] 先作用于起算点
  roll: 届满日 ∈ holidays(kind=holiday) → 按 rule.roll 顺延/倒退至第一个工作日；调休补班日算工作日
每条派生 deadline 写 calc_note：「2026-07-10 送达，次日起算 15 日至 07-25，届满日非节假日，不顺延。依据：民诉法 §171/§85」
```

### 3.3 关键交互（自建最容易漏的三条，全部来自已验证结论）

1. **级联重算 + 人工覆盖保护（D4）**：改 event.occurred_on → 弹重算预览（改动前后对照）→ 确认后重算派生期限；`is_manual_override=true` 默认排除，想动必须逐条勾选。
2. **court_specified 不推算**：举证期限这类法院指定的，规则只登记「应有此期限」，未录入前在看板标 ❓；任何自动化都不得推算填空。
3. **期限引擎 ⊥ 工作流引擎（D8）**：算期限（事件→日期）与铺任务（阶段→清单）是两个正交子系统，代码/数据文件都分开，不许互相调用内部结构。

## 4. 阶段引擎（PM 层）

- `rules/stage_templates.json`：每 procedure 一条**线性**阶段序列（D6；P2 反自定义——写死）。一审示例：`立案准备→已立案→送达答辩→举证→开庭→待裁判→上诉期→生效|二审→执行→归档`。
- 阶段变迁时按 **When/Then 模板**（D7）铺任务：`when: enter(举证) → then: create tasks[整理证据清单, 核对举证期限✓, 考虑申请调查取证…]`（origin=template）。动作集克制：只有「建任务」一种动作，不做邮件/文书自动化。
- `stage_entered_at` → 案件列表暴露「本阶段停留 N 天」；当前 WebUI 以固定 30 天标记“偏久”，尚未实现 per-stage 阈值配置。
- 事件可建议阶段变迁（judgment_served → 建议进入「上诉期」阶段），但变迁本身人工点确认——阶段是判断不是机械事实。

## 5. 收件箱（P1）

一切**异步**非人工直录的对象先进 `inbox`，三项主裁决：**accept**（落正式表，可先编辑预填字段）/ **decline（不再建议）** / **snooze**（原行在 `snooze_until` 后重新浮出，不创建副本）。来源：L2/L3 的 LLM 产物与未来 import。同步快录整理不进 inbox，只回填当前表单，由屏幕前的人按「记」确认（§8.6）。**accept 一条 kind=event 的收件 = 触发期限引擎派生**（引擎只认正式表）。

**1.7 推荐反馈闭环**：L2 的推荐标题只是文案，不承担身份。受信任自动化必须提交固定意图（如 `case.next_action`、`case.deadline_review`、`fee.collect:<fee_id>`），服务端再结合案件 id 生成稳定 `intent_key`，并按该意图读取阶段、事件、期限、待办、最近日志或指定收费节点的实质状态，生成 `state_fingerprint`。同一意图处于 pending/snoozed、已采纳待办仍 open、或在同一状态下已 accepted/declined 时，重复 POST 只增加 `seen_count`，不新增收件。只有相关状态真的变化且没有未裁决项时，才新增一条并通过 `supersedes_inbox_id + change_summary` 解释为何重提。日期自然流逝、标题换写、模型换措辞都不得制造新建议。

`decline` 是当前状态下的持久负反馈，不是删除；`snooze` 是暂缓。accept/decline/snooze 均只允许从 pending 出发，并在事务中比较状态，防止双击或乱序请求重复造正式记录。新异步 LLM 写入口用途与来源由服务端固定，只接受字段白名单为 `title/priority/basis` 的 `task` 建议；日期、event、note 和伪造 source 均拒绝。历史 `deadline` 收件可继续人工裁决，但 `/internal/inbox` 不再允许新建 deadline，法院文书日期只能先形成 event，再由期限引擎或人工期限入口处理。

状态指纹仍由完整相关状态在内存中计算，但 `state_marker` 只持久化每个组件的数量与不可逆 hash，不复制任务标题、收费金额或期限名称。1.6 以前没有 intent/state 的弃置记录进入独立 `llm_legacy_suppressions`：它们长期抑制旧契约下的 `case.next_action`，但不伪造“裁决时状态”；同案旧 pending/accepted 仅补稳定 intent，并在下次周检时按当前状态刷新。

## 6. 界面（9 页 + 常驻快录框，vanilla JS）

1. **今日看板**（首页）——🔴 ≤3 日必办 / 🟠 本周 / 🟡 关注（时效临界 + ❓待补）/ 📅 今日开庭，每条带下一步动作。P4 克制：只放今天与临期。1.8 起按“先处理这个 / 还在追的期限 / 今天要做的 / 等你裁决”分组：最近死线脱离普通白卡成为全页唯一焦点区，右栏五张等权卡合并为一张分区仪表。顶部信号仍为收件箱待裁决数（P1）+ 活跃案件数（P6 WIP，只提示不硬卡）。推荐卡明确提供「采纳 / 稍后 / 不再建议」；状态变化后重提时必须展示变化原因。期限跑道与案件页使用同一“改期 / 完成”动作语义：手动改期仍标记人工设定，不被级联重算覆盖；手机端头条动作不得隐藏。「今天要做的」分三层待办：今日（effective ≤ 今天，强调）/ 本周（今天 < effective ≤ today+7，与今日互斥）/ 全部（兜底，含所有 open task 与无日期「未排期」项），effective = due_on 优先否则 plan_date；无日期项标「未排期」chip 沉底。
2. **案件列表**——按程序分组 + 停留天数信号（D6）+ status 过滤。关键词搜索覆盖案件名、案号、双方当事人、案由与法院；非输入状态按 `/` 直接聚焦本页搜索框。
3. **案件详情**——1.8 起改为 1400px 双栏工作台，但九个 section 与既有写入口全部留在同页：粘性案件抬头持续显示案名、身份摘要、下一个死线和“概览 / 期限与待办 / 资金 / 文件 / 留痕”锚点；左栏放期限、待办、资金与时间线，右栏放纵向阶段、案件文件、联系人、案件信息与低频录入。≤1180px 回到单列，锚点只滚动定位，不隐藏内容、不新增路由。未结待办与时间线栏头分别常驻“记待办 / 记日志”，点击后展开同页录入器、定位并聚焦首字段；空态复用同一动作。资金区按“律师费款项 / 分成约定 / 已经形成的应收 / 应付”三级阅读，记款项默认展开，低频直记保持收起。时间线仍将 events+deadlines+worklog 全局合流倒序，增加“全部 / 事件 / 期限 / 日志”纯前端过滤；默认只构建当前过滤结果最近 20 条 DOM，总数超过 20 才显示原生按钮展开全部，站内刷新保留当前展开态、硬刷新恢复 20 条。
4. **日历**——月视图铺 deadlines+开庭+待办（待办与期限同口径：全状态返回，已处理项灰显划线，不在 SQL 层剔除）。底部图例即筛选开关：致命/重要·一般死线/开庭/待办按类型显隐，「已处理」单独控制 done/dropped 项是否上历，偏好存 localStorage 跨月保留。待办支持 `due_time`（仅截止时刻，`HH:MM`；空串为全天）：有计划日与截止日且两日不同才画跨日长条，单日或只有截止日仍画 chip；长条在当前月只画可见段，中间段不重复标题，月内可见端点可在桌面拖拽，越过另一端由服务端夹到同日，触屏不做端点拖拽而由任务弹层修改。未排期托盘仍收 `status=open && due_on=''`，与月格之间的拖拽只接受真实日期格。P3 加只读 .ics 订阅（Mac/手机日历直接看，token 化 URL）。
5. **费用台账**——以律师能直接阅读的“案件资金卡”呈现律师费、扣费、分成比例、应收/应付、结算状态与下一步；案件页与费用页复用同一结算组件和款项凭证组件。1.8 起粘性总账抬头只保留全页唯一 56px 净额，并把“要追的钱”作为相邻焦点；分区锚点直达按案款项、待处理分成、分成约定与历史修复。主体为双栏：左栏一案一卡，右栏为经营信号、待处理分成与低频附属区。页首不得把所有金额平铺成同权 KPI：第一层只突出“总账净额”，并直接展示 `律师费已收 − 已发生应付分成 + 已发生应收分成` 的全期权责等式；待收、已到期、放弃/减免与金额待定属于第二层经营信号。律师费 `paid` 是收款毛额，不得标作“已收（净）”。每案面板同样展示 `本案净额 = 本案律师费已收 − 本案应付分成 + 本案应收分成`；无 `case_id` 的外部应收只进入全局总账，不摊入任一案件。
6. **历史分成修复**——仅人工认领、保留或逻辑作废升级前孤儿台账。
7. **统计**——期限履约、案件分布、收结案趋势、应收账龄与分成后净口径。
8. **用户中心**——皮肤偏好、个人设置、账户与安全、关于。**只保留真能用的功能**：个人设置的六个抬头字段（姓名／执业证号／律所／电话／邮箱／办公地址）经 `/api/settings` 落 `settings` 表，读写都在本机，不进期限引擎、不进任何计算、无 LLM 通道；白名单在 `src/routes/settings.js`，白名单外的键直接丢弃。原「通知偏好」面板已整块删除——那两个阈值（期限预警 3 天／开庭提醒 7 天）硬编码在前后端多处，做成可配置是独立的一件事；留一块全禁用的假控件只会让人以为能改。**沿用的原则不变：不得提供「可改但不保存」的假交互**——接不通就别摆控件，而不是摆出来再禁用。
9. **登录**——账号密码登录，成功后进入 30 天滚动会话。

**1.3.1 历史分成修复工作台**（`share-repairs.html`）：从费用页、顶栏和案件内已结历史分成的「待修复」标识进入。默认仅展示 `open` 修复单与同案已收款候选；候选、相同方向/合作对象/金额/月份的参照均只是人工核对信息，不展示 contacts 颗粒字段。认领先要求裁决说明；存在软重复时再明确确认「独立」并填写例外理由，才会携带 `confirm_independent=true` 调用 API。保留未认领与逻辑作废同样强制填写理由；工作台不提供自动匹配、合并、删除或重算，且不接 LLM、inbox、quick 或 `/internal` 路径。

**1.4 结算流（案件页与费用页同一套组件/接口）**：两处都从款项进入「方案 → 公式 → 预览 → 确认」，不得各写一套算法或出现不同口径。
1. 未收款时列出本案全部 active payable agreements；每项必须选择一个 revision（显示版本号与结构化步骤）或明确「本款不适用」。新 revision 出现时，原 assignment 标「有新版」，只给「保留当前版 / 采用新版」两个明确动作，不自动切换。
2. 「预览结算」调用服务端只读 preview，展示 gross、每一步扣减的 kind/basis/输入/向零取整结果、terminal 与最终各方金额；页面只渲染轨迹，不在 JS 中算钱。未收款方案即使预览过，也不进入任何汇总或提醒。
3. 「确认收讫」再次由服务端重读并重算；成功后才把款项变为已收、落不可变 snapshot 与 `fee_shares`。若 preview 后金额、agreement 状态、plan 或 revision 有变化，确认失败并要求重新预览。
4. 已确认记录只展示历史快照；「撤销/更正」进入追加式 cancellation / adjustment 流，不提供编辑快照、覆盖台账或物理删除按钮。

**1.6 律师视角交互契约（不改变 1.4 的审计与计算模型）**：后台仍保留 agreement / revision / assignment / run / snapshot / ledger 五层，但普通页面不得要求律师先理解这五层。默认界面只回答六个问题：

1. **这笔律师费是多少**：金额未知就直写“金额待定”，不以 0 代替；已收、待收、减免状态紧贴金额。
2. **谁给谁分**：只说“刘律师应给我”或“我应给刘律师”，不以 payable / receivable 作为主文案。
3. **怎么算**：用纵向自然语言算式表达“本笔律师费 → 扣什么 → 扣费后金额 → 乘多少比例 → 我应收/应付多少”。页面只把后端公式与 trace 翻译成人话，绝不在浏览器复算金额。
4. **现在能确定多少**：比例已定但律师费或扣费方案未定时，明确显示“最终金额待基数/扣费方案确定后计算”；约定可先保存，不能伪造 0 元应收台账。
5. **什么时候结算**：真实金额形成后以 `fee_shares.due_month` 为结算月份；未形成金额的约定把结算约定写在备注并在卡片直接展示，不把它藏进版本历史。应付结算引擎默认收到律师费当月形成待分台账，日后可在台账改月份。
6. **下一步是什么**：每张资金卡最多一个主动作，例如“确认收到律师费”“先确认怎么分”“完善扣费”“标记已收/已分”；更正、撤销、停用、历史修复等低频动作降到次级或“历史与高级”。

默认阅读层禁止出现：`gross`、`remaining`、assignment、revision、snapshot、preview hash、fee version、“方案已闭合”“纳管已收”。对应人话固定为：

- gross → 本笔律师费；remaining → 扣费后金额；assignment → 这笔律师费是否参与分成；
- preview → 算一算；confirm → 确认收款并记账；correction → 修改这笔结算；
- reversal → 撤销这次收款；retire → 停用这条分成约定。

**录入规则**：新建分成约定采用渐进表单，只先问方向、合作对象、按比例还是固定额、扣什么、比例/金额及补充说明。首次建立时的生效日、版本标签、变更说明由系统自动生成；只有调整既有分法时才要求一句“为什么改”。扣费比例基数默认按业务语义自动选择（第一项按本笔律师费、后续项按扣费后金额，最终比例有扣费时按扣费后金额），少见口径放进“高级计算设置”。

**高级层**：公式版本号、生效日、逐步取整轨迹、批次/快照身份、preview hash 与 fee version 仍保留，可在“历史与高级”展开核查；高级层不能抢占默认主动作，也不能改变后端重读、重算、不可变快照与追加式更正的安全约束。

**1.7.2 费用台账写入与查账契约**：费用页不是只读报表，而是资金工作的第一入口；但收款确认仍只在具体案件款项上走 1.4 的共享结算组件，不在总览页另造第二套流程。

1. 页头常驻一个主动作“记款项”，只列在办案件，提交单位为元的原始字符串给服务端转换为整数分；金额可留空，款项名称必填。所有案名入口统一落到案件详情 `#case-money`。
2. 在办案件资金面板默认展开；搁置/已结案件使用原生 disclosure 默认折叠，并保留明确的展开/收起文案。合作人的本年已结分成同样可展开为只读明细，即使该合作人同时还有待处理分成也不得隐藏。
3. 有未决应付约定时，款项主动作直接写“先确认分成办法（N 条）”，点击仍打开带当前收款/更正动作的同一结算弹层；不得让人点到“算一算”后才第一次得知先决条件。
4. 律师费减免只允许 `unpaid ↔ waived`：减免后退出待收/逾期，不生成 settlement run 或 `fee_shares`；恢复后回到待收。只有前瞻 assignment、尚无 run/真实 share 时可保留方案并切换；一旦已有结算或未作废分成历史，通用 PATCH 继续拒绝，必须沿追加式更正边界另行处理。`paid ↔ waived` 不属于通用状态转换。
5. 只有带 `settlement_snapshot_id` 的引擎分成结果显示“怎么算的”；点击打开共享结算弹层，自动展开外层历史与命中该 snapshot 的 run，并把对应计算证据滚入视野。人工/legacy 直记不得伪装成有公式轨迹。
6. “按案收款规模”的条长表示跨案同尺度金额，不称“进度”；总账构成只以 1px 弱规则线分区，应付/应收色落在数值上，不能画成三枚不可点击 tab。

**1.7.5 分成台账动作一致性**：费用页的"例外直记"仍只服务某笔已收律师费下的历史/特殊应付事实，不开放方向选择，也不伪装成公式结算；但必须显式填写 `due_month` 并可留 `note`，避免后端默认当前月导致历史台账进入错误年度统计与 L0。费用页和案件页的 pending 台账都可修改月份；物理删除仍只放在案件上下文，并且只对普通 `manual|legacy`、非作废、非待修复行展示。`calculated|adjustment` 或带 assignment/snapshot 来源的引擎行不得展示后端必然拒绝的删除按钮，金额与来源事实继续只追加、不覆盖。

**2.2.4 案件详情·律师费款项——每笔款独立折叠（默认关）**：`#case-money > #fee-list` 内每一笔款包成 `<details class="fee-row-fold" data-fold-id="fee-row-{fee_id}">`；默认折叠、本机记忆在 `anjian-fold`（与全站原生折叠同池）。summary 仅展示 **chevron + 标签 + 状态徽章 + 警示 chip（"需配置分成"/"X 条分成待定"）+ 金额**，body 才挂 contract clause 原文、所有动作按钮、分成子行与凭证行。设计动机：3 笔款全展开时屏幕一屏装不下，律师一眼看不到全案资金总貌；折叠后一眼能扫完整案，单击才付出阅读代价。所有按钮依旧在 body 内可点击；summary 故意不放任何可点击控件，避免点动作同时切换折叠。

**2.2.5 案件详情·律师费款项 body——动作独立成行**：`.fee-row-body` 不再把 `.tl-actions` 塞在 `.pay-row` 末尾。`mainRow` 只留 `p1（标签+条款）+ 状态徽章 + 金额`，3 个动作按钮拆到独立的 `.fee-row-actions` 行（`justify-content: flex-end`、`border-top: 1px solid var(--line)`、`padding: 6px 14px 10px`）。设计动机：3 个按钮占 ~280px 列宽，把 `.p1` 挤到 92px 极窄列，合同条款被迫在"V2 合同第八"处强 wrap；拆开后 `.p1` 回到 ~370px，整段条款回到一行。同样适用于费用页和今日页的 `.pay-row` 复用——`.fee-row-actions` 只挂在 `.fee-row-body` 内，不污染其他 `.pay-row` 上下文。

**2.2.5 费用页·案件条——80px 横边距兜底**：`.fee-case-head { padding: 16px }`（不再是 `padding-block: 16px`），兜底横边距避免文字撞绿色 inset 阴影。同步给 `.fee-case-panel > summary.fee-case-head` 补 `padding-block: 16px`——因为 `.fold > summary` 比 `.fee-case-head` 选择器更具体，必须挂在更高层级才能生效，否则案件条还是 0 纵边距。`min-height: 80px` 同样必须挂在 `.fee-case-panel > summary.fee-case-head`（否则被同名规则的 52px 覆盖）。

**2.2.6 案件详情面板栏头——横边距 16→20px**：`.case-main > .p-head, .case-side > .p-head { padding: 0 20px }`。`.p-head` 默认仍是 `padding: 0 16px`，但 DOM 实测首字左侧 bearing 收缩后视觉仅 ≈12px；20px 后视觉间隙稳定在 16px 上下。**不动 `.p-head` 默认值、不动 `.fold > summary`**，因为其他页面（包括分享页、合同页）的面板栏头 16px 视觉正常；只针对案件详情页的两条选择器加宽。

快录框（1.1.0/P5）：每页常驻。自然语言解析只返回 `task|log` 的表单建议，不写库、不产 deadline；人按「记」后才落 tasks/worklog。异步 LLM 产物仍走收件箱。案件详情页的快录默认挂当前案件（人在本案页记的东西几乎一定是本案的），可手动改回「不挂案件」。

## 7. API 面

- `/api/*`（webUI 用，cookie 鉴权）：cases/events/deadlines/tasks/worklog/inbox/fees/shares CRUD + `/api/digest?window=7d` + `/api/shares/overview`（分成按合作人汇总）。
  - **待办完成留痕（1.8.0）**：`PATCH /api/tasks/:id {status:"done"}` 在状态首次转为完成时，原子创建一条 `worklog` 并随响应返回 `completion_worklog`；重复请求返回 `completion_worklog:null`。有关联案件的日志直接进入该案时间线，无案件待办仍落所务工作日志。案件页与今日页据此明确提示留痕去向。
  - **阶段变更留痕（2.2.4）**：`PATCH /api/cases/:id` 当 `stage` 真变化时，同步创建一条 `worklog`（`content="阶段变更：<旧>→<新>"`，首设为 `"进入阶段：<新>"`）并随响应返回 `stage_change_log`；该日志直接进入案件时间线，与待办完成留痕同口径。
  - **`GET /api/fees/overview`**（1.3.0；1.7.2/1.8.0 扩展）：返回 `totals.share_payable/share_receivable/net_retained`（全期净口径）、per-case `shares:{payable,receivable}` 与 per-fee-item `shares:[{id,direction,counterpart,amount,status}]`。1.7.2 为每笔款项增加只读 `settlement_context`：`active_payable_agreement`、`assignment`、`settlement_history`、`share_history`（未作废）、`linked_share`（含作废证据）及合成的 `required`；两页据此只隐藏必然失败的减免/删除动作，服务端状态门仍是最终权限边界。1.8.0 在配置案件夹时增加 `files_enabled=true` 与每笔款项的 `vouchers[]` 投影；未配置时为 false，前端整行隐藏。全部正常分成读取只返回 `is_void=0`。
  - **款项凭证（1.8.0，仅 `/api` 人面）**：`PUT /api/fees/:id/files?name=&kind=&version=` 接收原始字节流，防穿越与 60MB 上限沿用案件文件桥，重名自动加序号且不覆盖，写入 `<案件夹>/财务凭证/` 后登记 `fee_item_files`；`DELETE /api/fees/:id/files/:fileId?version=` 只解除关联。两者都校验款项归属和当前版本、追加审计，不修改款项金额/状态/结算版本，不触发 OCR、LegalRAG、inbox 或任何 LLM 路径。
  - **`POST /api/shares`**（1.3.0）：支持 `{fee_item_id, agreement_id}` 约定解析自动算额；幂等（同 `{fee_item_id, agreement_id}` 二次 POST 返回既有行）；同案校验（fee_item.case_id 须与 share 一致）。
  - **`PATCH /api/shares/:id`**（1.3.1）：支持改 `fee_item_id` 的既有能力仍保留，但若对应修复单仍为 `open`，一律 `409 {code:'legacy_repair_required'}`，只能在修复工作台裁决；`is_void=1` 的行拒绝通用 PATCH 与 DELETE，避免绕过作废审计。
  - **历史分成修复（1.3.1，纯人工 `/api` 面）**：`GET /api/share-repairs?status=open` 返回修复单、原分成行、同案已收 `fee_items` 候选及软重复参照；不带 contacts 颗粒字段。`POST /api/share-repairs/:id/claim` 接收 `{fee_item_id, resolution_note, version, confirm_independent?, exception_reason?}`，只允许修复单仍为 `open`，且目标款项同案并已 `paid`。软重复默认 `409 {code:'source_claim_conflict'}`；只有 `confirm_independent=true` 且 `exception_reason` 非空才可继续。`POST /api/share-repairs/:id/retain` 接收 `{resolution_note, version}`，保留未认领；`POST /api/share-repairs/:id/void` 接收 `{resolution_note, version}`，将原行标为 `is_void=1`，不是物理删除。
  - **修复写入原子性**：每个 claim/retain/void 在同一 `BEGIN IMMEDIATE` 事务中以 `status='open' AND version=?` 比较交换，完成 queue 的状态/version/resolved_at、必要的 share `fee_item_id` 或 `is_void`、以及 audit_log；陈旧版本或已裁决均返回冲突，不能双记。修复工作台是唯一历史裁决写口，没有 `/internal`、inbox、quick 或 LLM 路径。
  - **1.4 agreement/revision（仅 `/api`）**：稳定 agreement 的 CRUD 与公式 revision 的只增不改接口分离；创建新 revision 只接受闭合 schema（ordered deductions + terminal、fen/bps、gross/remaining），拒绝任意表达式、浮点金额/比例与修改/删除旧 revision。005 的原 `rate/flat_amount` 只作兼容读取，不再作为新收讫的可变计算真相。
  - **1.4 fee plans（仅 `/api`）**：`GET/PUT /api/fees/:id/share-plans` 读取/写入每个 active payable agreement 的 `assigned|not_applicable` 决定。assigned 必须带 revision id；采用新版是一次显式 PUT，保留旧版也要留下人工确认与 audit，不能因 agreement 最新版本变化自动改 plan。plan 允许用于 `unpaid`，也允许把 1.4 前已 `paid` 且尚无 engine run 的历史款首次纳管；两者都不返回到 totals/stats 结构，只有确认结算才产生财务行。
  - **1.4 preview/confirm（仅 `/api`）**：`POST /api/fees/:id/settlements/preview` 只读重算并返回逐步轨迹，不写 plan、fee、run、snapshot、share 或 audit；`POST /api/fees/:id/settlements/confirm` 忽略客户端金额，重新读库并按同一服务端函数计算，在单一 `BEGIN IMMEDIATE` 中完成 fee 状态/金额、run、snapshots、非零 `fee_shares` 与 audit。1.4 起通用 `PATCH /api/fees/:id` 不得绕过 completeness gate 或修改已有 plan/run/share 所保护的结算事实。
  - **1.4 corrections/reversals（仅 `/api`）**：同一 preview/confirm 接口以 `run_kind=correction|reversal` 追加关联原 run/snapshot/share 的冲销或调整记录；原记录不可 PATCH/DELETE。退役 agreement 的历史 correction 沿用该款既有 assigned 方案，reversal 原样沿用 source snapshot。重复提交须以 request id / preview hash 幂等，任何部分失败整笔回滚。
  - **1.7.2 款项减免状态门**：`PATCH /api/fees/:id` 只把 `unpaid ↔ waived` 视为可逆减免转换，且建议携带当前 `version`。仅有 assignment、没有 settlement run 与未作废 share 时允许切换并原样保留 plan；不得生成 run/snapshot/share。已有结算或真实分成历史仍返回冲突；`paid ↔ waived` 一律拒绝。服务端必须校验转换矩阵，不能只靠前端隐藏按钮。
  - **款项删除保护**：`DELETE /api/fees/:id` 遇到 assignment、任意关联 `fee_shares`（包括逻辑作废证据）或 settlement run 时返回 `409 fee_delete_blocked_by_settlement_context`；不能把 SQLite 外键冲突暴露成 500。只有真正无分成依赖的款项可物理删除，案件存在 active agreement 本身不构成该款删除阻断。
  - **旧入口不越权**：`POST /api/shares`、`PATCH /api/shares/:id` 与 006 repair 路径继续服务既有台账/人工修复，但不得替代 1.4 收讫确认、补造 settlement snapshot，亦不得反向修改已确认快照。
- `/internal/*`（受信任自动化使用，`X-Anjian-Key`）：`GET /internal/digest`（结构化 JSON：临期/❓缺口/停滞案件/今日开庭）· `GET /internal/cases/byname/:name`（单案全景 + 最近已结待办 + L2 推荐裁决摘要，供自动化避免重复建议）· `POST /internal/inbox`（异步 LLM 任务建议只能投这里，不能直写正式表；服务端按 intent + state 幂等，响应中的 `created=true` 才计入“新增”）。`deadline` 不在新写入白名单。**1.4 不扩张此面：公式 revision、fee plan、preview/confirm、snapshot 与 correction 均无 `/internal` 路由，也不进入 inbox/quick。**
- **`case` CLI**（Mac/容器通用，薄封装 REST；legal CLI 同款分发模式）：
  `case list` · `case due` · `case show <案件名>` · `case event/deadline/task/log` · `case task-done <id>` · `case inbox` / `case inbox-accept|inbox-decline <id>` · `case fees` / `case fee-paid <id>` · `case shares` / `case share-done <id>` · `case types`。

## 8. LLM 集成（三层，可靠性递减、智能递增）

| 层 | 触发 | 做什么 | 红线 |
|---|---|---|---|
| **L0 确定性 digest** | 部署者配置的定时任务 | 固定代码查库并格式化基础提醒，可选发送到 webhook；只读取已发生且未作废的正式记录 | 不经任何模型；未付款项 plan、preview 与公式 revision 永不进入 L0 |
| **L1 提醒解读** | 可选外部自动化 | 读取 `/internal/digest`，生成排序或摘要 | 故障不影响 L0；没有正式写入口 |
| **L2 周期检视** | 可选外部自动化 | 根据停滞案件、期限缺口和既有裁决提出下一步建议，以固定 intent 投入 inbox | 建议不自动执行；只有人工裁决后才进入正式表 |
| **L3 文书提取** | 人工触发 | 文书 PDF/照片经可选解析服务形成 `fee | event` 候选，在对照确认页展示原文出处 | 不产生 deadline/share；accept 后事件才交给确定性期限引擎 |

**上下文纪律**：模型只接收当前功能所需的最小输入，不应批量发送案件列表、联系人、备注、费用、分成或工作日志。财务公式、fee plan、preview 轨迹与 settlement snapshot 不进入 LLM 上下文；LLM 看不到公式/方案写接口，也不计算或建议分成金额。

## 8.5 案件文件桥（0.5.0；双向同步 1.0.0）

**铁律：案件夹是唯一文件真相源，本系统不建第二文件仓。**

- 部署者将本地磁盘或同步软件管理的目录挂载为 `ANJIAN_FILES_ROOT`；`cases.name` 是该根目录下的单层案件夹名。案件创建与改名共用同一 validator：去掉首尾空白后必须非空、非 `.`/`..`、非隐藏名，不含 `/`、`\\`、NUL/控制字符，且 UTF-8 文件名不超过 255 bytes。
- 能力：网页浏览案件夹（面包屑单层列目录）/ 上传（PUT 原始字节流，零依赖；白名单子目录：法院文书/立案材料/证据整理/客户沟通/办案过程/人工终稿；重名自动 (2) 不覆盖）/ 取流预览（PDF/图片 inline，html 以纯文本回防存储 XSS，nosniff）。
- `attachments` 表只存**引用**（case_id + entity/entity_id + rel_path）：事件可挂多份文书，时间线出 📎 签；删除仅解除引用，永不删文件本体（不可逆操作留给人）。
- 文件 API、款项凭证和 LegalRAG reconciliation/排队必须共用 `src/lib/secure-files.js`，禁止各自复制词法 `safeJoin`。配置根先 `realpath` 成可信锚；案件夹、每级中间目录和目标均以 `lstat` 拒绝符号链接，真实路径须留在案件夹内，并在操作前后复核 `dev/ino` 身份。读取用 `O_NOFOLLOW` 打开已验证文件描述符并绑定 inode；新文件用 `O_CREAT|O_EXCL|O_NOFOLLOW` 原子抢占名称，冲突才尝试 `(2)`，绝不先 `exists` 后覆盖。目录列表和 LegalRAG 扫描忽略符号链接。读取类端点把穿越、绝对路径、符号链接、越界真实路径和路径竞态统一回成 404，不向探测者区分安全拒绝与文件不存在；案件名、上传名等写入类非法输入仍回 400，供界面明确纠正。另有 60MB 上限、文件名清洗和会话/静态 token 鉴权。

### 双向同步（1.0.0）——两个方向都不经中间层，案件夹即真相

**WebUI → 案件夹**：`PUT /api/cases/:id/files` 直写部署者配置的案件夹（网页还支持拖拽入夹）。案件页文件区常驻 1px 虚线上传框，拖入只改变令牌色和 inset 高亮、不改变几何；仅文件类型 drag 可激活，子控件间移动用 drag depth 防闪烁，移动端上传控件单列且触控高度不低于 44px。程序事件里的“附文书”与该文件面板写入同一案件夹并在两处互相说明。若部署者另行配置文件同步软件，写入会按其策略传播；案齐不承担云同步本身。

**款项凭证 → 案件夹（1.8.0）**：案件详情资金区与费用页在每笔 `fee_item` 下复用同一 `.fee-item-vouchers` 组件；拖入或选择文件后走原始字节流接口写入固定子目录 `财务凭证/`，数据库只登记 `fee_item_files` 指针。chip 点击仍复用案件文件取流接口；解除关联后原件继续留在案件夹。读取时实时核对文件是否仍存在，手工移走或改名显示“文件已移出案件夹”。未配置 `ANJIAN_FILES_ROOT` 时后端明确返回 `files_enabled=false`，两页不渲染凭证行，禁止摆出会 500 的残废控件。凭证只服务查账，不做在线预览器、齐全度校验、OCR 金额提取或自动收讫。

**案件夹 → WebUI**：读路径本就无缓存（每次请求实时 `readdirSync`），但页面只在加载时拉一次，外部文件管理器或同步软件写入的文件不会自动出现。1.0.0 补上变更推送：

- `GET /api/cases/:id/files/events`（SSE）：服务端 `fs.watch` 案件夹（recursive；平台不支持时退化为「根 + 一级子目录」并在变更时补挂新子目录），300ms 去抖合并连续写入，推 `change` 事件；25s 心跳穿代理，`X-Accel-Buffering: no` 防 nginx 缓冲。正常路径不轮询，适配低功耗自托管设备。
- 前端收到 `change` 即重拉当前目录，新冒出来的文件标「新」；切回标签页时也对一次。
- **降级链不断**：`fs.watch` 起不来（网络盘/平台不支持）→ 服务端发 `degraded` → 前端回落到「仅在标签页可见时」每 12s 拉一次 `GET /files/sig`（目录指纹，一次 readdir）→ 变了才重拉列表。SSE 断线由 EventSource 自动重连。
- 案件夹尚未创建时 watch 挂在 `ROOT` 上——夹子一建出来就能推第一条。
- 冒烟锁死（`tools/check.sh`）：外部写文件 → SSE 必须推 `change`；`/files/sig` 必须含该文件。

### LegalRAG 派生桥（1.5.0）——同一原件，不再重复上传

- 案齐与可选的 LegalRAG 服务挂载同一棵部署者配置的案件夹树；案齐只把 `cases.name + rel_path` 送到受信任接口，LegalRAG 验证真实路径仍在共享案件根后才登记原件。案件名精确匹配优先；没有精确项时，只允许唯一候选且仅差末尾“案”字的兼容映射。不会经 HTTP 再复制一份文件。
- 案齐上传成功后立即写持久化队列；外部新增或覆盖由每 2 分钟一次的轻量 reconciliation 补漏。扫描按案件一次性载入当前 revision 后在内存比对，未变化文件零 DB 写入，避免大案件夹制造 WAL 写放大。首次启用只为存量文件建立 `observed` 基线，**不自动把历史全量送去 OCR**；旧文件可逐个点「立即处理」。
- LegalRAG 用 `case + checksum` 识别与手动上传相同的内容：已有解析直接认领共享路径，不重复 OCR。同一路径内容变化追加 `source_revision`，旧 revision 保留但退出正常列表和检索；任何清理函数都不得删除共享案件根下的原件。
- 状态机固定为 `observed → queued → registering → processing → ready → extracting → review`；网络/解析失败最多自动重试三次，之后显示 `failed` 供人工重试。文件消失只标 `missing`，不删 LegalRAG 解析结果或案齐正式记录。

## 8.6 LLM 层（1.1.0）：快录整理

**背景**：快录条的立身之本是「捕捉零摩擦：先记下，晚点再整理」，但它实际要求四个动作——选类型、选案件、填日期、打字。这不叫零摩擦。1.1.0 让它回到该有的样子：**张嘴就记，剩下的交给机器**。

### 铁律①的落地：同步/异步两条确认路

原文「LLM 产物一律先进收件箱」的**目的**是「绝不让 LLM 悄悄写进正式表」；收件箱是**手段**，不是目的。手段要分场景：

| | 场景 | 路径 | 人在哪 |
|---|---|---|---|
| **异步** | 后台文书提取、语音转写、导入等受信任自动化 | → **收件箱** 排队 → 事后裁决 → 入表 | 不在场，所以要排队 |
| **同步** | 快录条「整理」按钮 | → **只回填表单**（不写库）→ 人按「记」→ 入表 | 就在屏幕前，当场确认 |

**共同不变量：LLM 碰不到写库入口。** 同步路的确认动作就是那个本来就要按的「记」——**摩擦不增反减**（省掉三次手动选择）。

### 结构性防线（不靠提示词，靠类型闭合）

- `src/lib/llm.js` **不 import db**——拿不到任何写入口，是纯解析器。
- `POST /api/quick/parse` 的输出白名单只有 `task | log` 两种，**结构上不可能产出 deadline**（铁律①）。提示词里也明写禁止推算法定期限，但真正的防线是这里的类型闭合。
- LLM 的每个字段都过白名单校验：`kind` 非法 → 落回 `task`；`date` 不过 `isDate()`（格式 + 真实日期双验）→ 直接丢弃留空；`title` 空 → 退回用户原文；**案件绝不由 LLM 指定**——它只给「线索字符串」，本地 `matchCase()` 对着库匹配，**且只认唯一命中**（多个案件沾边时宁可留空让人选：挂错案件比没挂更糟）。

### 隐私尺度

**只把用户亲手打的那句话发给已配置的模型服务。** 不发案件列表、不发当事人名单、不发案号库；案件匹配全程在本地。当前实现通过原生 `fetch` 调用 OpenAI 兼容接口，不增加 SDK 依赖。部署者必须自行审查所选服务的地域、保留、训练使用和保密条款；未配置模型密钥时保持纯本地手工录入。

### 降级（LLM 挂了不许挡录入）

未配 `DEEPSEEK_API_KEY` → `/api/counts` 的 `llm:false` → 前端**不渲染「整理」按钮**（不摆残废控件）；上游超时/报错 → 502 + 原文原样留在框里，照样能手动「记」。**LLM 是可选增强，不是录入的必经之路。**

## 8.7 LegalRAG 文书提取与确认（1.5.0）

流程固定为：`共享文件登记 → LegalRAG OCR/分块/向量 → 本案最小身份锚点 + LLM 来源语义筛选 → 本地 fail-closed 准入 → legalrag_candidates → 人工核对 → 正式表`。

- `src/lib/document-extractor.js` 是无 DB 纯解析器；输入只含当前文件路径、LegalRAG OCR 原文，以及当前单案的最小身份锚点（案件名、案号、案由、法院、双方当事人、程序，空值省略）。不发送其他案件、联系人、备注、费用、分成、期限或工作日志。类型继续闭合为 `fee | event`，结构上不能产出 deadline 或 share。
- 1.7.3 的 contextual schema v3 不再把“抽到了合法字段”等同于“可以进候选”。模型必须先给出闭合的 `document_role + case_relation + evidence_mode`，每条来源再给 `evidence_relation`。只有本案 `direct`、直接原始材料 `primary_source`，且角色为本案委托合同、法院/仲裁原始文书或直接送达凭证时才有准入资格；检索报告、类案汇编、法律分析、草稿、当事人提交材料、证据目录与引用/举例/顺带提及均为零候选。v3 进一步把完整 `rel_path` 当作来源证据：检索报告目录及名称含材料事实摘录、事实摘要、转写、分析、笔记、汇编、备忘录或草稿等派生标记的载体，即使模型因正文逐字复制而误判为原始合同/法院文书，本地门禁仍强制清零。
- 模型裁决之后仍有代码级硬门：候选须为 `evidence_relation=direct`、置信度位于 `[0.75, 1]`、引文经 NFKC/空白归一后能在 OCR 正文定位，并继续通过事件词表、真实日期和字段白名单。分类缺失、矛盾、超出协议范围、上游失败或无法确认本案归属时 fail closed，不回退到 v1 宽松提取。
- PDF OCR 正文保留 `--- 第 N 页 ---` 标记；每条候选必须带最短原文摘录、页码（可确定时）、模型与 schema version。页面把候选与出处连续展示，点击「核对并录入」后仍可修改字段。
- `fee` 只提取委托代理合同明确的律师费节点，不提取诉讼费/代垫费或合作分成；条件未发生时 `due_on` 留空。既有正式款项按同案 strict typed key 做 `zero / unique / ambiguous` 三态匹配：节点名规范化、金额转整数分、明确日期相同；仅日期为空时再要求付款条件规范化后相同。`unique` 可由本地确定性代码把候选事实关联到唯一既有款项并退出 review，但不得新增、修改正式款项；`zero` 与 `ambiguous` 必须留给人工，严禁任选第一条或做模糊自动合并。
- `event` 只接受词表内事件和原文明示日期；确认后走既有 `deriveForEvent()`，法定期限仍由确定性引擎计算。相同事件/日期已有记录时只关联。
- 提取运行以 `(file revision, extractor, schema_version)` 幂等；重新解析不会重复生成候选，已接受的正式记录不随模型或 OCR 重跑而更新。
- 同一路径出现新 revision 时，旧 revision 的后台状态转为 `ignored`，尚未裁决的旧候选转为 `superseded` 并退出人工队列；已经接受的正式事实与审计记录不回滚、不覆盖。
- 旧 schema → v3 重筛只自动处理已经进过 LegalRAG、且仍有未裁决来源的当前文件（正常状态为 `review`，同时容忍旧数据误停在 `ready`）；旧版无候选 `ready` 与数千份 `observed` 存量均不重跑，避免无收益的 OCR/模型调用风暴。新排队文件仍在首次处理时直接走 v3。v3 成功后在同一事务中把该文件旧 extractor 的 pending 来源标为 `superseded` 再写新结果；v3 失败则保留旧来源，accepted/declined 与正式记录永不被模型重筛改写。模型筛掉的文件状态回到 ready，界面标“智能筛除”并保留简短理由；状态投影读取最近一次成功的 contextual 结果，未被 v3 重跑的 v2 筛除材料仍可显示理由。模型未配置时不得把含 pending 来源的文件改成 ready、隐藏“查看候选”入口。
- 1.7 起增加 `legalrag_candidate_facts`：逻辑事实按同案稳定 typed key 聚合，`legalrag_candidates` 继续逐份保存文件、revision、页码、引文、置信度等来源证据。去重采取保守分型口径：一锤定音型 event 使用类型+事件日期跨文档汇合；`hearing / summons / fee_notice / ruling_served / preservation_order / other` 等同日可重复类型再加入文书依据（空时用 note）作 discriminator，送达方式不作身份。fee 使用规范化节点名+金额分+明确日期；仅日期为空时再加入付款条件。宁可少合并，也不把同日不同事件或无日期的不同分期节点误作同一事实。页面每个事实只显示一张卡，但展开全部当前来源。
- 裁决落在逻辑事实层并批量作用于当前来源：declined 后，新文件或新 revision 只增加一份已处理证据，不再浮回；accepted 后，新来源自动关联既有正式实体，不重复建账。人工在接受弹层修正身份字段时，事实先按修正后的 key 重新归并再落正式表，不能出现 payload 已改而 key 仍旧的分叉。旧 revision 仍保留 `superseded` 的来源生命周期，不与事实裁决状态混用。
- strict key 不同但人工确认是同一既有收费时，走显式「关联已有收费」：保留本次提取的原始 fact key，直接建立 `fact → fee_item_id` 的 accepted alias，不改候选 payload、不改正式款项。以后任何来源再次产生该 key 都继承该关联；同一正式款项允许对应多个经过确定性唯一匹配或人工确认的 fact key。正式款项后续编辑不重算、改绑既有 alias；删除则在同一事务中把所链接事实转为可撤销的 declined 并清理软链接，绝不自动改绑其他款项。
- 系统 strict-unique 关联、人工接受命中既有款项、人工显式关联和正式实体撤回必须使用同一事实层状态转换，并以 `system` / 当前 actor 分别写审计；任何转换都以 `status='pending'` 条件更新作并发闸门。既有 accepted/declined 裁决优先，系统匹配不得覆盖；生产中已 declined 的历史事实不因本规则上线而批量改写。
- 「不再提示」必须明确说明它会作用于当前与未来来源、保存原因，并可从案件页「已忽略」列表恢复待确认。候选裁决刷新只允许在 `ready ↔ review` 间切换，不覆盖 `missing / failed / ignored` 等文件生命周期。
- 接口：`POST /api/cases/:id/files/process` 排高优先级任务；`GET /api/cases/:id/legalrag/candidates[?status=declined]` 读待确认或已忽略事实；`POST /api/legalrag/candidates/:id/accept|decline` 裁决；`POST /api/legalrag/candidates/:id/link-fee` 显式关联同案既有收费；`POST /api/legalrag/candidate-facts/:id/reopen` 撤销忽略。LLM 永远没有这些正式写入口的调用权。
- 文件行“查看候选”必须按完整 `rel_path` 精确定位到包含该来源的候选卡；同文件多条候选同时高亮并聚焦第一张，跨文件合并事实可由任一来源定位，同名不同目录不得串位。连续点击时只允许最后一次请求取得滚动/焦点控制权；候选已被处理时只刷新并提示，不得跳去其他文件的卡片。

## 9. 外部集成边界

1. `cases.name` 是配置文件根下的单层案件夹名，也是可选外部服务的稳定案件键；`status=shelved` 表示搁置。
2. 外部自动化优先使用 `/internal/digest` 与 `/internal/cases/byname/:name` 读取结构化状态，并只通过 `/internal/inbox` 投递固定白名单内的异步建议。API 不可达时是否降级由外部工具自行决定，不属于本仓运行时。
3. CLI 或其他受信任工具可在人工确认事实后调用公开的人面 API；不得绕过事件入口直接制造派生期限。
4. **LegalRAG 衔接**（1.5.0）：
   - **A 快捷入口**：`cases.legalrag_url` 每案一链，详情页可跳转到部署者配置的案件检索页。
   - **B 共享文件桥**：案齐上传立即排队；案件夹新增/改版由持久化 reconciliation 补漏；手动「立即处理」可提升单文件优先级。LegalRAG 手动上传与自动登记按 checksum 汇合。
   - **C 结构化回填**：LegalRAG 返回 OCR 原文，案齐生成带页码/引文的收费与事件候选；人确认后才写正式表，期限继续走引擎。
   - **D 后续方向**：检索答案可反链案齐案件页；案齐详情页可内嵌 search chunks，但不改变两边数据库边界。
   - **边界共识**：案齐是结构化程序台账与裁决层；LegalRAG 是可选的非结构化解析/检索派生层；案件夹是唯一文件真相源。两库不共库，机器写入只进队列/候选，正式事实仍由人确认。

## 附：SQLite 与备份决策

- **SQLite 活库不放网络文件系统**（决策 A8）：SMB/NFS 文件锁不可靠，WAL 不适合网络盘；活库应放在应用所在设备的本地文件系统，再通过 SQLite backup API 生成一致备份并复制到其他故障域。
- **增长控制**（决策 A9）：附件不进库，文件留在案件夹，数据库只存引用。部署者应至少保留一份离机备份，并按自己的敏感数据政策选择是否使用加密外部介质或云存储。

## 10. 备份与安全

- **备份**：使用 SQLite backup API 生成一致备份，按部署者设定的保留周期轮转，并复制到至少一个独立故障域；不要在 WAL 活跃时只复制主 `.db` 文件。恢复流程必须定期在隔离环境演练。
- **网络面**：对非回环监听应放在 HTTPS 反向代理后；应用内账号密码使用 30 天滚动会话；静态 token 只供 CLI/受信任客户端走兼容 cookie；`/internal/` 应在反向代理层限制为受信任网络，并另用 header key。Express 只在明确的 `trust proxy` 策略（默认 loopback/link-local/unique-local，可由 `ANJIAN_TRUST_PROXY` 收窄）下解释转发链，客户端来源与 HTTPS 状态统一取 `req.ip` / `req.secure`，不直接信任 `X-Real-IP` 或裸 `X-Forwarded-Proto`。production 的未捕获异常只返回稳定错误码与 correlation ID，完整异常仅进服务端日志。
- **Android 服务器 origin**：壳不内置默认站点；首次启动由用户输入，规范化后保存在 app-private `SharedPreferences`，并可从常显原生控件修改。配置值只允许 `http` / `https`、有效 host、可选 port、无 userinfo/query/fragment，且 base path 只能为空或 `/`；公网主机名与公网 IP 必须 HTTPS，HTTP 仅允许 `localhost`、IPv4 loopback、RFC1918（`10/8`、`172.16/12`、`192.168/16`）和 `.local`，界面固定明示“明文传输，仅限可信局域网”。此判断只按输入的 host/IP 字节完成，不做 DNS 解析。manifest 为动态私网地址开放 WebView cleartext 能力，但目的地边界由 Activity validator 强制；第三方 Cookie 关闭、mixed content 继续拒绝。Intent 深链与 WebView 导航按 scheme、host、effective port 严格同源，拒绝字符串前缀伪同源；切换 origin 时清除 Cookie、Web Storage、缓存和历史，防止跨实例沿用会话。
- **启动 fail-closed**：`HOST` 默认 `127.0.0.1`；正常模式下 `ANJIAN_USER` 与 `ANJIAN_PASS_HASH` 必须成对且不得同时缺失，非回环监听还必须配置独立 `ANJIAN_INTERNAL_KEY`，否则在监听端口前拒绝启动。唯一无鉴权路径是显式 `ANJIAN_UNSAFE_NO_AUTH=1`，且只在非 production、明确回环 IP（`127.0.0.0/8` 或 `::1`）下成立并打印醒目 WARN；production、非回环或拼错开关值均拒绝启动。正常模式未配 internal key 时 `/internal` 恒 503，不再按开发环境隐式放行。Dockerfile 显式写 `HOST=0.0.0.0`，因此容器必须带完整账号/hash/internal key；Electron 显式回环并带账号/hash，可不启用 internal 面。
- **数据敏感度**：数据库中的案号、当事人姓名、日期和阶段本身就是敏感执业数据；案件夹还可能包含完整文书与证据。HTTPS、账号会话、`/internal` 网络隔离与独立 header key 是底线。部署者负责按适用法律、职业保密义务与供应商条款决定存储地域、加密和备份位置。
- **登录凭据与会话**：`ANJIAN_PASS_HASH` 是唯一凭据真相源，不写 SQLite、也不随数据库备份扩散。新 hash 格式为 `scrypt-v1$N$r$p$dkLen$salt$hash`，16-byte 随机盐，默认 `N=16384,r=8,p=1,dkLen=32` 且显式钉住 `maxmem`；`ANJIAN_SCRYPT_N` 可让内存宽裕的自托管者提高生成成本。服务端继续兼容旧 `salt:hash`，旧凭据登录成功仅打印迁移 WARN，不自动写库或回传新 hash。登录无论用户名是否存在都执行配置 hash 的完整 scrypt 验证；用户名、`ANJIAN_STATIC_TOKEN` 与 `X-Anjian-Key` 均先做固定长度 SHA-256 摘要，再以 `timingSafeEqual` 比较，配置缺失即使空摘要相同也不能放行。会话 token 为 32-byte CSPRNG；服务端每隔一天延长数据库 expiry 时同步重发 30 天 cookie，时间一律 UTC，`Secure` 只取可信代理解析后的 `req.secure`。
- **登录防爆破**：进程内限速桶按 `req.ip + username` 隔离，15 分钟窗口内 5 次失败锁 15 分钟；桶有 TTL、2048 固定容量、请求时清理，429 附 `Retry-After`。未知用户名同样付出 scrypt 成本并计入自己的来源+账号桶。这是单管理员低内存部署的保护层，不替代强密码或高熵内部 key。
- **audit_log**：所有写操作留痕。登录会话使用 `ANJIAN_DEFAULT_ACTOR || 'web'`，静态 token 走 CLI 路径写 `cli`，`/internal` 新请求未显式携带 `X-Anjian-Actor` 时写 `internal`。升级前已持久化的 `hermes` 是历史兼容值，与 `web`、`cli`、`internal`、`system` 一样可继续读取；不得为改名批量重写历史审计证据。公开标识不应硬编码维护者姓名。
- **007 三张分成表的存量 actor 不做全量改写**：`fee_share_formula_revisions.created_by` 与 `fee_share_settlement_runs.confirmed_by` 受 007 的不可变写守卫保护（封存修订只允许一次性 seal，人工确认的 run 完全禁止 UPDATE），升级前的值按设计**保留为历史证据**；migration 013 只清洗 `fee_share_assignments.decided_by`，并按其乐观锁契约递增 `version`。来龙去脉见 CHANGES §三十。

## 11. 设计决策记录

| # | 决策 | 依据 |
|---|---|---|
| A1 | Node + Express + better-sqlite3 保持单一运行形态，不另开 FastAPI 服务 | 无前端构建步骤、依赖少，适合个人自托管与低功耗设备 |
| A2 | 期限规则/阶段模板是 git 内数据文件，不是库表不是代码 | D5 规则库=内容资产，改动要可 review |
| A3 | 异步 LLM 只能投 inbox；同步解析器无 DB 写入口 | 铁律 1 的工程化，不靠自觉；两条路径都必须经人工确认 |
| A4 | plan_date 与 deadline 分表分语义 | P4，假死线稀释 🔴 警觉 |
| A5 | 阶段线性写死、变迁人工确认 | P2 + D6；solo 无自定义需求 |
| A6 | 通知以确定性 digest 为主，critical 实时为例外 | P6；提醒主链不能依赖模型或特定消息平台 |
| A7 | 部署拓扑由自托管者决定，应用保持单进程、SQLite 本地盘与反向代理兼容 | 避免把某台主机、域名或云供应商写成产品前提 |
| A10 | 合作分成不进期限引擎、不开 LLM 通道 | 分成是**财务节律**不是诉讼期限（无法条依据、无 events.type，不进 deadlines 表、不参与级联重算，提醒走独立 digest 段）；公式、方案、预览、确认与更正只在 `/api` 人面，`/internal`、inbox、quick 与同步/异步 LLM 均不扩张（铁律 1/2）。（A8/A9 见「附：SQLite 与备份决策」）|
| A11 | 历史孤儿分成（006）进人工修复队列，不自动处置 | 仅将严格条件的既有 settled 案件内未挂款、无约定、无基数行入队；认领、保留、作废都是带审计的人工决定。相同方向/合作人/金额/月仅软提示，不能自动合并、挂款、删除或重算；007 的公式引擎也不得倒灌到这批历史修复数据。|
| A12 | `voided` 是 `is_void=1` 的逻辑作废，不占用 `status` 词表 | 保持 005 的 `pending|settled|waived` CHECK 兼容；`waived` 仍是减免，不可挪作重复/录错。作废财务行不物理删除，并从总账、统计、L0 和正常列表统一排除。|
| A13 | 每份 migration 的 DDL/DML 与 `PRAGMA user_version` 同一事务 | SQLite DDL 可事务化；runner 对每个编号文件显式 transaction，成功才推进版本，失败则 SQL 和版本号一并回滚，migration 文件本身不得写 `BEGIN/COMMIT`。|
| A14 | 007 采用 agreement / revision / plan / settlement snapshot / ledger 五层 | 稳定约定身份与算法版本解耦；revision 不可变，plan 是未收款前瞻决定，snapshot 固化确认时事实，`fee_shares` 才是已发生总账。这样改公式不改历史、预案不污染 totals/stats/L0；007 只增量承接，005/006 的既有数据与修复语义保持不变。|
| A15 | 分成公式是闭合的整数确定性 DSL，不是表达式 | 只允许有序 fixed/rate 扣减（gross/remaining）+ terminal rate/fixed；金额 fen、比例 bps，每一步向零取整。唯一实现放服务端纯函数，前端只展示轨迹，LLM 不读不算，避免浮点、执行顺序与多端实现漂移。|
| A16 | 收讫是 completeness gate + 事务性重新计算 | 每个 active payable agreement 必须 assigned 或显式 not_applicable；assignment 钉 revision，新版只可人工 keep/adopt。preview 零写入，confirm 重新读库/重算并原子写 fee 状态、不可变快照、shares、audit，客户端预览结果不是写入依据。|
| A17 | 财务更正采用追加式 cancellation / adjustment | 已确认 run/snapshot/share 是审计事实，不 UPDATE/DELETE；撤销或改错追加关联行并以正负合计反映净额。案件页与费用页复用同一方案/公式/预览/确认流，防止入口不同导致口径分叉。|
| A18 | 密码 hash 只以 env/Electron config 为真相源，不为透明 rehash 建库表 | 本系统只有单管理员；手工重生成只需一次，而 hash 入 SQLite 会随每日备份扩散并制造 env/DB 双源。格式从 `scrypt-v1` 起版本化、验证兼容 legacy，未来升成本不需要改持久层；默认 N=16384 是 128 MiB 容器并发 OOM 边界下的明确取舍。|
| A18 | 案件夹为原件、LegalRAG 为可重建派生层，文书回填只进候选 | 同一文件不在两系统重复管理；checksum/revision 统一手动与自动入口；OCR/LLM 可重跑但不能覆盖正式事实，期限和分成仍保持原有确定性/人工边界。|
| A19 | L2 推荐身份由固定 intent + 服务端状态指纹确定，标题不参与去重 | 模型换写不等于新建议；pending/snoozed/accepted-open 与同状态 declined 都由服务端幂等抑制，只有相关案件状态实质变化才可解释性重提。|
| A20 | LegalRAG 逻辑事实与来源证据分表 | `candidate_facts` 保存跨文件裁决记忆，`candidates` 保存逐份引文和 revision 生命周期；既能永久记住弃置，又不会为了去重丢失证据。|
| A21 | 文书候选采用“LLM 语义筛选 + 本地 fail-closed”双闸门 | 模型负责判断材料角色、本案关系及直接/引用证据；代码只准入本案直接原始材料的高置信、可回指引文。检索报告中的他案裁判即使字段完整也不得污染人工候选，模型失败不回退宽松规则。|
| A22 | 款项凭证仍以案件夹为唯一原件源 | `fee_item_files` 只存指针；上传沿用零依赖原始字节流，固定落 `财务凭证/`，重名不覆盖。解除关联不删文件，夹内移动只标 missing。凭证不改变收讫状态，也不进入 LegalRAG、LLM、inbox 或 `/internal`，避免财务原件再生第二套真相源。|
| A23 | 缺鉴权配置必须拒绝启动；开发无鉴权只留显式回环逃生口 | 隐式“没配账号就是 dev”会把配置遗漏变成裸奔，且与监听地址组合后可扩散到局域网。`ANJIAN_UNSAFE_NO_AUTH=1` 只在非 production + 明确回环 IP 生效并告警，让测试仍可零凭据运行，同时把生产默认改为 fail-closed。|
| A24 | 文件 API、凭证与 LegalRAG 共用一套真实路径边界 | 只做 `path.resolve` 前缀比较会跟随案件根、中间目录或目标符号链接，`exists→write` 还会产生覆盖竞态。共享 helper 把案件名单一分量、root realpath、逐级 lstat、真实路径 containment、inode 复核、no-follow 读取与 exclusive create 钉成同一契约；新文件仍保留重名 `(2)` 的用户语义。|
| A25 | Android 壳由用户配置唯一服务器 origin，不内置项目部署坐标 | 自托管客户端不能把维护者实例当产品默认；严格 origin 比较阻断伪同源深链，切换清会话阻断跨实例凭据串用。动态局域网地址无法用 manifest 静态枚举，因此 cleartext 能力在壳层开放、目的地由 Activity 确定性白名单收窄；公网仍强制 HTTPS。|

## 12. 初始未决问题（现状）

- **Q1 公开入口（已解决）**：应用不绑定固定域名；自托管者在 HTTPS 反向代理中配置入口。
- **Q2 诉讼时效建模（仍待专门设计）**：3 年时效倾向挂 case 级（起算日=知道或应当知道之日，手动录）而非普通 event 派生。
- **Q3 保全续封（仍待规则扩充时定稿）**：不同财产类型期限不同，需在多条规则与参数化单规则之间取舍。
- **Q4 地方法院实践差异（持续校准）**：现按单一规则集 + `court_specified` 兜底处理，只使用虚构 fixture 与经维护者独立法律复核的法源调整规则。
- **Q5 历史案件迁移（已解决）**：既有部署可通过 UI/API 或自建导入工具迁移，产品不依赖私有 registry。

## 13. 分期

> 本表保留初始路线图。当前 P0、P1 已完成；P2 的 L0/L1/L2 主链已上线；P3 已完成 NL 快录，L3 文书提取与 `.ics` 仍按需推进。外部自动化工具不属于本仓发行边界。

| 期 | 内容 | 量 |
|---|---|---|
| **P0 电子台账** | 8 表 migration + REST + 4 页 UI（手动 CRUD）+ case CLI + Docker 自托管 + 一致备份 | 初始可用闭环 |
| **P1 期限引擎** | 规则表编纂 + 引擎 + 节假日表 + 级联重算预览 + 阶段 When/Then + L0 digest | 确定性期限闭环 |
| **P2 自动化边界** | L1/L2 可选自动化 + `/internal` 读面与 inbox 单一异步写入口 | 人工裁决闭环 |
| **P3 按需增强** | L3 文书提取（对照确认页）+ NL 快录 + `.ics` | 可选能力 |
