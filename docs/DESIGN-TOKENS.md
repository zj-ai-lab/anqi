# 案齐 anjian · 设计令牌文档 v5「三皮肤」

> **一个骨架 · 三种材质。** 母题 = 期限本身（日期刻度 / 倒计时 / 跑道透视），不再是「品牌色的氛围化」。
>
> - **本文件是 UI 的唯一规范源**；**实现的唯一事实源是 `public/css/style.css`**（两段式；行数会随功能增长）。
>   两者冲突时：先改本文件再改码，同 commit（CLAUDE.md 铁律⑤）。本文所有色值均逐条抄自实现，未经记忆改写。
> - 架构条文源自 `docs/design-directions/ARCHITECTURE.md`，已全文吸收进 §1，该文件退居历史决策记录。
> - 骨架与材质的可运行原型：`docs/design-directions/D-merged.html`。
> - 版本沿革：v3「翡翠」→ v4「翡翠·增强」（玻璃拟态 + 弥散光 + light/dark 双主题）→ **v5「三皮肤」**。
>
> vanilla CSS，无构建步骤、无前端框架、无 CDN（低功耗自托管设备是硬约束）。
> v5.5 起字体**自托管**思源家族（切片 woff2，同源静态文件，非 CDN webfont）——见 v5.5 节；「零 webfont」旧约就此作废。

## v5.1 原生折叠与渐进披露（2026-08-05）

折叠统一使用原生 `<details>`，不另造 open 状态机。`.fold` 的状态由 `public/js/fold.js` 以 `anjian-fold` 写入本机 `localStorage`；读写失败只退化为本次页面状态，不影响业务数据。`<summary>` 采用「箭头 · 标题 · 收起摘要」骨架，`.fold-summary` 只在收起时承担摘要；展开后的内容保持原 DOM 顺序。打印前所有 `details` 展开，打印后恢复用户状态。

新增骨架类：

- `.fold` / `.fold-summary` / `.fold-title`：全站低频区原生折叠；summary 的边框恒为 1px，粗线使用 `inset box-shadow`。
- `.metric-note`：统计页 `.p-foot` 的「口径」小开关，默认收起。
- `.fee-case-panel` / `.fee-section-head` / `.fee-toolbar` / `.fee-case-count`：费用页按案折叠、只看待收、全收起/全展开与「N 案 · 展开 M」计数。
- `.fees-agreement-fold`：费用页分成约定总览，默认收起；逾期款项与待确认方案的注意区优先展开。
- `.case-money-fold` / `.case-share-list-fold` / `.case-contacts-fold` / `.case-aux-fold`：案件页分成约定、已形成应收应付、联系人与录入区；期限跑道、未结待办、案件进程保持首屏可见。
- `.file-review.fold`：已忽略提取事实默认收起；待确认提取结果有内容时不折叠。
- `.case-filter-fold` / `.case-procedure-group`：案件列表窄屏筛选与程序组；已结/搁置组默认收起，组内数量常显。
- `.stats-fold` / `.profile-fold` / `.repair-history-fold`：统计低频图表、用户中心账户/关于、已完成修复记录默认收起。
- `.cal-tray`：月格与图例之间的未排期托盘；桌面常开，窄屏收为一行「未排期 N 条」，手机仍只点开条目与弹窗，不启用拖拽。

所有这些类只复用既有语义令牌，不新增颜色；三皮肤共享同一 DOM、尺寸与断点，`.cal-cell` 继续禁止 `backdrop-filter`，边框宽度继续恒为 1px。

## v5.2 折叠再优化·三手法（2026-08-06）

v5.1 的 `.fold` 把每个低频块都做成 48px 的门，密度省了但认知没省。v5.2 立一条硬规矩：**一页的视线主轴上最多留一个归档箭头**，其余内容归到三种手法之一。`.fold` 机制与 `fold.js` 不动，只改「哪些内容该用门」。像素规格见交接包 `04-像素规格.md`。

### 三种手法

1. **事实条 `.factstrip`**：填一次就固定、一行装得下的事实（分成约定、当事人、送达地址、口径）。不给箭头，点「改/设置」就地展开同一条内的录入区 `.factstrip-more`（不是新折叠块）。行网格 `52px minmax(0,1fr) 58px`；第三列 58px + `white-space:nowrap` 是实测值（46px 时「收起」两字竖排）。可换行长事实变体 `.factstrip.is-wrap`（统计口径用）。
2. **账本行 `.ledger`**：同构重复集合（费用按案、每笔款）。收起态本身是可读的数据行，数字列右对齐等宽字体；一组共用一张连续表，无卡间空隙。需要处理的那条自己展开（费用：`over>0`），展开态从表面抬起：`border-top/bottom` + 白底 + `inset 3px 0 0` 状态色条。⚠ 网格里每项写死 `grid-column`；空单元格用 `visibility:hidden` 不 `display:none`（后者让列塌陷错位）。
3. **归档门 `.archive-door`**：已完结/已忽略/已归档的整段。**一页只留一道，永远放最后**。虚线框（`1px dashed var(--border)`）与在办内容分层；复用 `<details>` + `fold.js` 持久化，但不依赖 `.fold` 母题。费用页表底实底变体 `.archive-door.is-solid`。

### 落地范围（v5.2 标杆批次）

- **费用页**（门 9 → 1）：每案从 `details.fee-case-panel` 改 `.ledger-table` 连续表（列 `18px minmax(200px,1fr) 108px 108px 108px 108px 62px`）；款项行 `.fee-ledger-item` 6 列；右栏分成约定 `.fees-agreement-fold` → `.factstrip`；已结无未结案收进表底 `.archive-door.is-solid`。工具条「全部收起/展开」→「只留逾期展开」（清 fold 记忆回默认）。
- **案件详情**（门 11 → 1）：2.2.4 每笔款 `.fee-row-fold` 折叠全部取消，改 `.case-fee-ledger` 款项表（列 `minmax(150px,1.1fr) 90px minmax(150px,1.15fr) 92px minmax(130px,.9fr) 52px 148px`）；低频的合同条款/收款记录/凭证走行内「明细」按钮，同一时间只展开一笔（`.ledger-detail` + 左侧状态色 `inset 3px 0 0`）。录入/联系人/分成约定三处 `.case-aux-fold`/`.case-contacts-fold`/`.case-money-fold` → 三条 `.factstrip`。已结清款项收进本页唯一 `.case-archive-door`（`#case-archive`，nav 锚点，`openTarget` 会自动展开）。

### 落地范围（v5.2 阶段二·其余六页）

- **今日**（门 2 → 1）：期限缺口 `.today-gap-fold` → 事实条（0 处隐藏「去补」）；全部待办 `.today-alltasks-fold` → `.archive-door`（标题「更远的待办」）。
- **案件列表**（门 3 → 1）：筛选条 `.case-filter-fold` → 常显 `section.panel`（删响应式开合）；程序组 `.case-procedure-group.fold` → 平铺不折叠；已结/搁置 → `.cases-archive` 归档门（只在全部/在办视图叠）。
- **统计**（门 3 → 0）：4 处口径 `.metric-note.fold` → `.factstrip.is-wrap`（长文本换行脚注）；案由/阶段分布 `.stats-fold` → 常显。
- **日历**（门 1 → 0）：窄屏托盘加 `.is-tray-strip`（始终 open、summary 去折叠箭头与 cursor）→ 事实条形态，待办直接可见可点选排期。
- **我的**（门 2 → 0）：账户/关于 `.profile-fold` → 两条事实条。
- **分成修复**（门 1 → 1）：已完成修复 `.repair-history-fold` → `.archive-door`；默认视图拉「全部」本地分拆，待修复主体 + 已修复归档门。

### 新增令牌

- `--fill-danger-soft`：逾期 chip 软底（比 `--red-bg` 更浅）。pro `#FCECEC` / paper `rgba(180,35,24,.07)` / jade `rgba(228,104,92,.16)`。与既有 `--fill-ok-soft` / `--fill-warn-soft` 配套，三皮肤各一份。

### 仍守的铁律

border 恒 1px（浮起走 inset box-shadow）；`.cal-cell` 不上 `backdrop-filter`；纯前端（0 请求 0 落库，状态进 `localStorage`）；有逾期/待裁决/冲突的内容强制可见，不许被折叠或归档掩盖。

## v5.3 费用页展开态层次修正（2026-08-11）

v5.2 的展开态（白底 + border-top/bottom + 组级 inset 栏杆）实测两处失效：① 组级 inset 栏杆被行级不透明底（`.ledger-item`/`.p-foot` 的 `--surface-2`）盖住，只在无底色的备注行漏出红色残条；② 展开细节全是白/浅灰细线行，案头与明细、相邻两案无法一眼区分。修正只动费用页（`.fee-ledger-*` / `.fee-item-*` 前缀），案件详情页 `.case-fee-ledger` 不动：

- **展开案 = 独立模块**：`.fee-ledger-group[open]` 抬离连续表（`margin 12px 0` + `1px var(--border-h)` + `--r-panel` 圆角 + `overflow:hidden`），组底改 `--surface-2` 井色。
- **案头带**：`[open] > .ledger-row` 白底（`--surface-solid`）、min-height 54px、案件名升 `700 14.5px`；数字列不动。
- **栏杆全高连续**：井里各层（`.fee-items`、`.p-foot`）保持透明底让组级 `inset 3px` 状态条从头画到底；案头带不透明，栏杆在带内以同规格重画一次（`.is-over[open]`/`.is-ok[open]` 行级 inset）。
- **款项卡**：`.fee-item-block` 从细线分隔改为白卡（`1px var(--border)` + `--r-btn` 圆角），主行/备注/分成/凭证四层同卡，卡间 10px gap；`.fee-item-note` 补齐 `7px 14px` 内边距（修复贴边）；新增 `.fee-item-voucher-line` 骨架样式。
- **小计条**：`.fee-ledger-group > .p-foot` 透明底走井色，`本案净额`（`.fee-case-net`）升 `13.5px/700` 为第一强调；「打开本案资金区」并入小计条尾部，删除独立 `.fee-case-open` 条。
- **状态列 116px**：`FEE_ITEM_GRID` 与案件页 `CASE_FEE_GRID` 的 chip 列 92/90px 装不下「逾期 · 2026-04-27」（600 11px 实测 ~111px，溢出压触发节点列），统一放宽到 116px。⚠ 放宽后两张表的**列最小值合计必须重新对账**（fees 卡内 ~888px / case 面板内 ~918px，1440 视口实测），超了末列动作按钮被 `overflow:hidden` 裁掉——本次已把其余列最小值相应收回。
- **粘性抬头下滑收缩**：费用页 `.context-header` 的 sticky `top` 由 fees.js 设为 `calc(var(--h-top) − 导航行 offsetTop)`（ResizeObserver 量取，总账高度随数据/断点变）——标题与 56px 总账随滚动自然滚走（藏进 z-60 顶栏后面），只钉住锚点导航行（~51px）。关键数字 `.fee-context-mini`（净额/要追）是导航行右侧的 absolute overlay，不占布局高度，完全收起（`scrollY ≥ 收缩量`，class `is-condensed`）后淡入——全程零内容跳动、无阈值抖动循环。<900px 隐藏 mini；`prefers-reduced-motion` 下无过渡。

只复用既有语义令牌，零新增颜色；三皮肤仍共享同一 DOM 与断点，border 恒 1px、粗线仍走 inset box-shadow。

## v5.4 费用页案卡堆与案头色带（2026-08-11）

v5.3 上线当天二审反馈：案与案区分仍不够、字重层级不可辨、「明细」文字错位。v5.4 在 v5.3 基础上再推一档（只动费用页 `.fee-ledger-*`；**案件页 `.case-fee-ledger` 仍守 v5.2 连续表**，本节是费用页按案层对 v5.2「一组连续表无卡间空隙」的显式偏离）：

- **连续表 → 案卡堆**：`.fee-ledger-table` 拆壳（透明、无边框、`gap 12px`），每案 `.fee-ledger-group` 自成一张独立卡（1px `--border` + `--r-panel` 圆角）；列标签行水平 padding 19px（多 1px 补卡边框）保持跨卡列对齐。收起 = 卡片行（案名 600），展开 = 边框升 `--border-h`。
- **案头色带**：展开案的 summary 行按状态着色——`is-over` → `--red-bg` 带 + `inset 4px` 红栏杆，`is-ok` → `--green-bg` 带 + 绿栏杆；hover 不变色（带色即状态语义）。栏杆由 3px 升 4px，收起/展开全高连续。
- **井底换 `--bg-base`**：v5.3 的 `--surface-2` 在 pro 下与白卡几乎不可辨；页面底色作井，白色款项卡浮在其上，「案头大卡 → 附属明细」的从属关系三皮肤可辨。
- **字级层级改由字号+颜色承担**（CJK 系统字体真实字重上限是 Semibold/Bold，550/650/700 渲染无差别，光调字重不可辨）：展开案头 16px > 款项名 13.5px/650 > 备注正文 12.5px `--muted` > 触发节点 12px `--meta` > 附属 kicker（备注/分成结果/凭证）统一 `700 10.5px/1.7 + .1em` `--meta`。金额：款项行 15px、本案净额 15px/700。
- 🔴 **字重恒 ≤700**：Songti 在 >700 合成字重下「¥」玻璃字（占 7.5px 宽不出墨，jade 实测）——数字字重一律钉 700 以内。**（v5.5 自托管思源后此律解除，只余回退链警示）**
- **`.ledger-btn` 补 `inline-flex` 居中**：「明细」是 `<a>` 不是 `<button>`，定高 28px 盒里 `line-height 1` 的锚点文字贴顶（v5.2 起的错位），button 靠 UA 居中掩盖了同病。

仍零新增令牌；红/绿带只取既有 `--red-bg`/`--green-bg` 语义槽位。

## v5.5 自托管思源字体（2026-08-11）

方律拍板：字重层级要真实可辨、所有设备渲染一致，字体不再赌设备系统字库——v5.4 才发现的「CJK 系统字重上限 Bold、550/650/700 不可辨」由此根治。

- **家族**：思源黑体 = `Noto Sans SC`（可变字重 100–900）、思源宋体 = `Noto Serif SC`（200–900），OFL 开源协议。取 Google Fonts 切片发行版自托管：`public/assets/fonts/` 202 个 unicode-range 切片 woff2（sans 101 片 + serif 101 片，共 ~10MB 落库），`public/css/fonts.css` 声明（`font-display: swap`），9 页在 style.css 之前引入。
- **切片按需加载**：浏览器只取页面实际用到的字块（pro 首屏实测 19 片；serif 只在 paper/jade 激活时开始拉取，pro 下 0 片）。服务端只增加静态文件服务，低功耗约束不受影响；同源加载，无 CDN、无公网第三方依赖。
- **字重阶梯从此可用真字重设计**：费用页落地为 案头 800 > 款项名 700 > 收起案名 600 > 正文 400，kicker 700（小号大字距）。系统回退链仅存在于切片加载间隙，其间 >700 有 ¥ 玻璃字风险（v5.4 教训），可接受。
- **更新办法**（一次性工具步骤，不引入构建）：Chrome UA 重抓 `fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@100..900&display=swap`（serif 同理），下载全部切片、URL 重写为 `/assets/fonts/`，覆盖 fonts.css 并升其 `?v=`。
- 皮肤材质不变：pro 数字仍 SF Mono 等宽（--mono 链未动），paper/jade 的衬线气质由 Songti 换为思源宋体（同类宋体，字重反而更全）。

## v1.8 阅读层级与款项凭证

1.8 不改三皮肤材质方向，只重排层 A 的视觉权重。设计签名是“持续可见的案件 / 总账抬头”：它像卷宗侧签一样，在长页滚动时始终回答“我在哪、最急的是什么”。

- **三级表面**：`.focus-surface` 是每页唯一焦点区，无普通卡边框，直接坐在 `--bg-base` 上并用 `inset 3px 0 0 0` 栏杆编码紧急度；`.panel` 是需要动手的工作面；`.aux-panel` / `.aux-disclosure` 使用 `--surface-2`、无普通卡边框，承载低频只读与折叠内容。
- **标题反超正文**：`.p-title` 统一为 `650 14px/1.4`、零字距、`--ink`；`.p-head` 最小高度桌面 48px、移动 56px。`.group-title` 为 14px 冠字，后接吃满余宽的 1px `--border` 规则线。
- **留白分级**：组内 12px，组间桌面 32px / 移动 28px；`.panel-body` 为 `14px 16px`，通用列表行统一到 `13px 16px`。
- **一页一个最大数字**：今日最近死线与费用总账净额可用 56px；案件粘性抬头中的下一个死线只用 30px。第二梯队数字为 22px，第三梯队为 16px。
- **长页工作台**：案件详情和费用页改用 `.page`（1400px）与 `.case-layout` / `.fee-layout`（`minmax(0,1fr) 380px`，24px gap）；`.context-header` 粘在 `top: var(--h-top)`，内部 `.section-nav` 是纯锚点并允许窄屏横滑，不是 tab，不隐藏内容。≤1180px 工作台回单列。
- **今日仪表**：`.today-workbench` 的右栏固定 360px、栏间 32px；五张等权卡合并成 `.today-dashboard`，内部 `.dashboard-section` 只用 1px `--line` 分区。
- **跑道修正**：紧凑行列为 `92px | minmax(0,1fr) | 200px | 84px | auto`；`.rw-trk` 钉死 178px，轨道内容盒 176px，16 格按 `background-size: 11px 100%` 绘制，今日原点 22px 精确压在第 3 条刻度上。字号梯度收为 24 / 20 / 16。
- **费用案件辨识**：`.fee-case-head` 以 `inset 4px 0 0 0` 案件栏杆、两行案头和右端小计区分案件；按案 `.feebar` 仅 5px 高，使用新增 `--fill-ok-soft` / `--fill-warn-soft`。
- **款项凭证**：`.fee-item-vouchers` 是 `.fee-item-block` 的第四层，复用于案件详情和费用页；附件 `.voucher-chip`、新增区 `.voucher-add` 与 missing 状态只取语义令牌。拖入只改 `background` / inset shadow，几何不变。移动端 chip 与新增区均至少 44px。

以上全部属于层 A；层 B 本批次只新增两个 soft 填充槽位。三皮肤 DOM、断点、组件顺序与边框宽度必须一致。

---

## v1.6 资金卡信息层级

分成管理新增的 `.money-*` / `.settlement-equation-*` 组件属于**层 A 共享骨架**，三皮肤只通过既有语义令牌提供材质，禁止在层 B 为某一皮肤改尺寸、顺序或间距。

- `.money-card`：一笔律师费或一条分成约定的默认阅读容器；先读关系与金额，再读自然语言算式，最后只留一个主动作。
- `.money-relation`：只写“谁应给谁”，不放数据库方向枚举。
- `.money-headline`：金额已知显示金额，只有比例已知显示比例；金额待定必须有相邻解释，不能单独显示破折号或 0。
- `.settlement-equation`：纵向算式。运算符、说明、金额三列在桌面展开，手机收为两列；任何金额均来自后端 trace，不允许 CSS/JS 通过百分比宽度暗示或复算金额。
- `.money-next`：主动作区；同一卡片只能有一个 `.primary`。修改、撤销、停用与版本历史放入 `.money-advanced`。
- `.money-advanced`：使用原生 `<details>`；summary 固定写“历史与高级”，默认收起。

金额继续使用 `--f-num`，关系与说明使用 `--sans`；状态只使用既有 green/amber/red/blue 语义槽位，不新增“财务专用皮肤色”。资金卡在三皮肤下的 DOM、总高、断点与按钮顺序必须一致。

---

## v1.7.4 案件详情渐进披露

案件详情继续使用同一纵向工作台，不新增导航层或弹层。高频动作从数据所在面板就地进入录入器，密集内容按业务层级披露：

- `.p-head-actions` 只负责在栏头右侧并排数量/说明与轻量动作；其中 `.p-meta` 必须取消自身的自动左边距。`.panel-quick-action` 使用既有 green 语义槽位，不升级为实心主按钮；手机仍继承 `.btn.small` 的 44px 触控高度。
- `.money-section-title` 是资金面板的三级小标题，必须作为 `#case-money` 直接子元素；`.money-entry` 只承载相邻录入器，禁止再嵌套 `.panel-body`。律师费“记款项”默认展开，分成约定与历史特殊直记默认收起。
- 时间线折叠控制复用 `.p-foot`，不另造浮动控件；默认只挂载最近 20 条 `.tl-item`，展开按钮保持原生 button、`aria-controls`、`aria-expanded` 与焦点，不允许用隐藏全量 DOM 冒充截断。
- `.file-upload-zone` 常态就是 1px 虚线可发现区；`.dropping` 只允许改变 `border-color`、`background` 与 inset shadow，前后 margin/padding/border-width/rect 必须一致。窄屏 `.file-upload-controls` 改为单列，select/file/button 均至少 44px；`prefers-reduced-motion` 下 transition 为 `none`。

上述组件全部属于层 A 共享骨架。三皮肤只能借既有变量改变材质，桌面与 390px 下的关键容器宽高差不得超过 2px，且不得产生横向滚动。

---

## v1.7.5 第四梯队一致性收口

- 今日页与案件页的期限跑道共用“改期 / 完成”双动作骨架：紧凑行使用 `.rw-acts`，头条使用 `.rw-key`；桌面纵排，手机头条动作移到正文下方横排，任何断点都不得隐藏最紧急期限的操作。
- 未接线设置使用原生 `disabled` 表达不可修改，并由邻近说明给出原因；不得仅靠页脚小字解释一个仍可拖动或勾选的控件。
- 案件搜索的 `/` 快捷键只在焦点不处于 input / textarea / select / contenteditable 时接管，并通过 `aria-keyshortcuts` 暴露给辅助技术。
- `.btn.danger` 静止态即使用 `--red` 文本传达危险语义，边框仍保持普通次级按钮权重；hover 再以既有 `--red-bg` / `--red` 加强，不用常驻红底争抢主动作。
- 以上变化继续只用既有按钮、焦点环、状态色和 44px 移动触控尺度，不新增皮肤专属布局。

---

## 0. v4 → v5 变更摘要

### 0.1 为什么改

v4 被评审判为 **5.6/10**（`docs/design-directions/CRITIQUE-v4.md`）——执行分 7–8，输在概念：

| v4 的病 | v5 的药 |
|---|---|
| 母题 = 翡翠光雾（品牌色的氛围化），与「期限管理」无关；盖住文字认不出是法律工具 | 母题 = **期限跑道**（今日为原点、死线为端点的时间轴），信息本身即形式 |
| 最近死线 30px 埋在 KPI 瓷片里，与卡片标题竞争 | **头条 56px**（`.hd-num .n`）+ 28px 衬线案由 deck，首屏第一眼 |
| 背景 11 层装饰（orb×4 + ring×5 + halo + vignette）持续抢注意力 | 弥散光**只剩 jade 皮肤**，且降到 orb×2 + ring×1 + vignette |
| 每个卡片标题配一枚 icon（icon slop） | 面板标题纯文字，icon 降到 15px 且仅语义必需处 |
| KPI 0 值恒占首屏黄金位 | 0 值降权（`.tile.is-zero`），KPI 收为右栏紧凑清单（`.kpi-row`） |

### 0.2 废弃清单（v4 → v5，本文不再维护）

| v4 机制 | 状态 | 取代者 |
|---|---|---|
| `[data-theme="light"\|"dark"\|"auto"]` 三态主题 | **已废弃** | `[data-skin="pro"\|"paper"\|"jade"]`，无属性 = auto |
| 独立的明暗开关（皮肤 × 明暗 = 3×2 = 6 组合） | **已否决** | **三选一即主题选择**：jade 就是暗色主题本体 |
| `js/theme.js` 三态状态机 | **已删除** | `js/skin.js`（`anjian-skin` 键；旧 `anjian-theme` 键读到即迁移并删除） |
| localStorage 键 `anjian-theme` | **已迁移** | `anjian-skin` |
| 玻璃拟态令牌（`--glass` / `--glass-card` / `--glass-strong` / `--edge` / `--sheen`） | **已删除** | `--surface` / `--surface-solid` / `--surface-bar` / `--surface-pop` 语义槽位 |
| 5 层复合阴影栈 `--shadow` / `--shadow-up` | **已删除** | `--sh-panel` / `--sh-top` / `--sh-qb` / `--sh-pop` / `--sh-hover`，且 **pro/paper 全为 `none`** |
| 弥散光 13 层 + 缩放系数 `--k` | **已删除** | jade 专属 `--atmo`（4 层，尺寸写死不缩放） |
| 数字渐变文字 `--num-grad` | **已删除** | 数字用实色 `--ink` + `--f-num` 字体角色（渐变文字在暗色下对比度打折，v4 扣分项） |
| 宽屏字号放大（`--fs-body` 随断点升到 16/16.5px） | **已删除** | 字号恒定，**只有 `--page-pad` 随断点缩放**（16/20/24/32） |
| 主按钮渐变 `--btn-grad` | **降级为皮肤自决** | `--cta-bg`：pro/paper 是实色，仅 jade 是渐变 |

### 0.3 三皮肤一览

`<html data-skin="pro | paper | jade">`，无属性 = auto。

| 皮肤 | 明暗 | 一句话 | 表面 | 边框 | 阴影 | 圆角 | 数字字体 | 绿的用量 |
|---|---|---|---|---|---|---|---|---|
| **pro**「专业」**（默认）** | 亮 | 扁平灰阶工具 | 纯白 `#FFFFFF` | 1px 灰 `#E4E6EA` | 无（仅弹层） | 8/6/4px | SF Mono 等宽 | 仅作 accent |
| **paper**「纸感」 | 亮 | 铅字排印纸面 | 暖白 `#FBF9F4` | hairline 墨线 | **零** | **0px** | Songti 衬线 | **仅两处签名位** |
| **jade**「翡翠」 | **暗** | 墨绿毛玻璃 | 半透明 `rgba(16,30,24,.55)` + blur | 玉色微光线 | 深黑弥散 | 16/10/6px | Songti 衬线 | 主色（`#4FD6A4`） |
| `auto` | 跟随 OS | 第四个可选值，不占顶栏键位 | OS 亮 → **pro** / OS 暗 → **jade** | | | | | |

> **jade 是暗色主题本体。** 本系统不再有独立的 light/dark 开关。
> paper 不出暗色版——纸不发光；需要暗色请用 jade。

---

## 1. 皮肤架构（铁律，违反即返工）

### 1.1 为什么只有一套骨架

三个方向稿的差异分两层，成本差一个数量级：

| 层 | 内容 | 换一套的成本 | 对未来开发的影响 |
|---|---|---|---|
| **材质** | 颜色、表面、边框、阴影、圆角、字体家族、底噪 | 一套约 50–90 行 CSS | 零。加新功能不需要关心皮肤 |
| **骨架** | 信息架构、grid、元素顺序、间距刻度、字号层级 | 一套约 370+ 行 CSS **＋一套 HTML** | **每加一个功能要在 N 套布局里各实现一遍，永远 N×** |

anjian 是 solo 自用工具，N× 的长期税不划算。故：**骨架唯一（源自方向 B 双栏工作台），材质三选一。**

### 1.2 两段式 CSS（`public/css/style.css` 的组织法，禁止混写）

**层 A · 共享布局层**（文件上半，`A-0` ~ `A-27`）
写死骨架尺度：`grid-template` / `flex` / 元素顺序 / 间距刻度 / **字号层级** / 响应式断点。
**层内不写死任何颜色、表面、边框色、阴影、圆角，一律 `var()`。**

> 层 A 的三处**合法**例外（都是「信息表达」不是「材质」，故属骨架）：
> 1. `.p-title` / `.card > h2` / `.group-title` / `.chart-title` 等 UI chrome 恒 `var(--sans)`——皮肤不得改。
> 2. `.hd-deck`（头条案由）恒 `var(--serif)`——它是头条表达本体，三皮肤共用。
> 3. `.brand .ver` 与 `.sk` 恒 `var(--sans)`——**字体锁**：若走 `--f-num`，pro 的 SF Mono 与 paper/jade 的 Songti 字宽差 9.4px，会把整条 `.links` 和右侧按钮推走（实测这是本体系唯一一处 >2px 的跨皮肤容器位移，锁死后 9 页零位移）。
>
> 另有一处层 A 硬编码色：`.sw-pro` / `.sw-paper` / `.sw-jade` / `.sw-auto`（profile 皮肤卡的色卡小样）。
> 它们是**内容（皮肤的缩略图）**，必须固定为各皮肤自身的颜色——否则在 jade 里预览 paper 会显示成暗色，预览就失去意义。

**层 B · 皮肤材质层**（文件下半，`[data-skin=x]`）
每个皮肤只重定义变量 + 「不推动包围盒」的表面规则。

### 1.3 属性白名单（层 B 只准出现这些）

```
background · border-color · box-shadow · border-radius ·
backdrop-filter · font-family · 绝对定位装饰层（position:absolute + inset:0 + pointer-events:none）
```

### 1.4 铁律：`border-width` 永远 1px

**需要粗规则线一律用 `inset box-shadow` 画。**
`border-width` 会推动内容，`box-shadow` 不会——**这是整个架构能成立的地基。**

实现中的三个用例（全部是「看起来像粗边」但零位移）：

| 场景 | 令牌 | 值 |
|---|---|---|
| paper 面板栏头的牛津粗线 | `--head-rule` | `inset 0 2px 0 0 rgba(28,26,23,.82)` |
| paper / jade 头条的左栏杆（3px） | `--hd-edge` | `inset 3px 0 0 0 #B42318` / `inset 3px 0 0 0 rgba(228,104,92,.85)` |
| paper 月历今日格的 2px 墨框 | `--today-sh` | `inset 0 0 0 2px var(--ink)` |

### 1.5 禁改清单（层 B 绝不出现）

```
padding · margin · gap · width · height · min/max-width · min/max-height ·
grid-template · grid-column · flex · order · display ·
font-size · letter-spacing · line-height · border-width
```

理由：全都会推动包围盒。**字号是信息层级，属骨架不属材质**——皮肤不许碰。

### 1.6 验证标准

| 检查项 | 标准 |
|---|---|
| 布局容器（div/section/table/li 等）跨三皮肤位移 | **零位移**（>2px 的 0 个） |
| 三皮肤页面总高 | **完全一致** |
| 文本级差异 | 仅等宽↔衬线的字宽微差（y 坐标须全同），可接受 |
| jade 玻璃预算 | `backdrop-filter` 元素 **≤12**（面板级）；表格行 / chip / 按钮 / 日历格零 blur |
| 各皮肤自身底色上的最低正文对比度 | **≥4.5:1**（AA） |

**已记录的实测：**
- D-merged 原型（ARCHITECTURE.md，Playwright 2026-07-13）：134 个布局容器零位移，三皮肤页面总高全部 1235px，jade 的 `backdrop-filter` 仅 10 个元素。
- 落地到 9 页时修掉的 3 处位移（均已在 CSS 注释中留档）：`.brand .ver` 字体锁、`.cal-head .page-title` 吃 flex 余量、`.set-ctl` 钉死 `width`。

> **改页/加组件后必须重跑此验证。** 任何一处非零位移都说明层 B 越界了。

---

## 2. 色彩令牌

### 2.1 令牌命名法：语义槽位，不是色名

v5 的令牌是**槽位**（这块表面叫什么用途），皮肤往槽位里填值。写业务 CSS 时只准引用槽位，永不写死色值。

| 槽位组 | 令牌 | 语义 |
|---|---|---|
| **底/表面** | `--bg-base` | 页面底色（`html` 承载） |
| | `--surface` | 面板/卡表面（jade 半透明 + blur） |
| | `--surface-2` | 次级表面（面板脚、图表区、adder） |
| | `--surface-solid` | **不上 blur 的实面**（日历格 / tile / case-card / step-dot） |
| | `--surface-bar` | 顶栏 + 快录条 |
| | `--surface-pop` | 浮层（下拉 / toast / 弹窗） |
| | `--head-bg` | 面板栏头底 |
| | `--hover` | 通用 hover 底 |
| | `--ctl-bg` | 控件底（按钮 / 输入框） |
| | `--we-bg` | 周末格底 |
| | `--sel` / `--scrim` | 文本选中 / 弹窗遮罩 |
| **文本 5 级** | `--ink` | 正文/标题（最强） |
| | `--ink-2` | 次强（到期日、数字副值） |
| | `--muted` | 次要文本 |
| | `--meta` | 元信息——**次级文字下限，勿再调浅** |
| | `--faint` | **仅装饰**（分隔、0 值降权），**非正文** |
| **线** | `--border` / `--border-h` | 容器边框 / hover 态 |
| | `--line` | 内部分隔线（比 border 更弱） |
| | `--rule` | 印刷规则线（paper 的 hairline 主力） |
| **状态色** | `--green` / `--green-deep` / `--green-bg` / `--green-bg-h` / `--green-line` | 品牌绿 = 正常/完成/accent |
| | `--red` / `--red-dot` / `--red-bg` / `--red-line` / `--red-soft-ink` | 逾期/紧急 |
| | `--amber` / `--amber-dot` / `--amber-bg` / `--amber-line` | 临期 |
| | `--blue` / `--blue-dot` / `--blue-bg` / `--blue-line` | 程序事件（开庭/传票） |
| | `--teal` | 工作日志 |
| | `--ok-dot` / `--gray-dot` | 一般死线点 / 中性点 |
| **交互** | `--focus` / `--link` / `--link-h` / `--on-solid` | 焦点环 / 链接 / 实色块上的反白字 |
| **元件** | `--chip-bg` / `--chip-bd` / `--ck-bd` / `--ck-bg` / `--kbd-*` | chip / checkbox / 键帽 |
| **品牌** | `--seal-bg` / `--seal-ink` / `--seal-sh` | 几何案卷对齐 mark（`/assets/anjian-icon.png`，源图自带统一 macOS 圆角）；保留 `.seal` 类名兼容旧骨架 |
| | `--pill-bg` / `--pill-ink` | 顶栏计数角标 |
| | `--nav-on-*` / `--sw-on-*` | 导航激活态 / 皮肤切换器激活态 |
| **头条** | `--hd-bg` / `--hd-bg-h` / `--hd-edge` / `--hd-edge-ok` / `--hd-ink` / `--hd-meta` / `--hd-rule` | 期限跑道头条区 |
| **跑道** | `--trk-bg` / `--trk-bd` / `--trk-tick` | 时间轴条轨道 / 边 / 刻度 |
| | `--fill-over` / `--fill-crit` / `--fill-warn` / `--fill-ok` | 四档填充（over = 红斜纹） |
| | `--fill-ok-soft` / `--fill-warn-soft` | 5px 按案收款条的低饱和填充 |
| | `--dot-ring` / `--dot-sh` | 轴点描边环 / 阴影 |
| **CTA** | `--cta-bg` / `--cta-bg-h` / `--cta-bd` / `--cta-ink` / `--cta-sh` | 主按钮 |
| **今日** | `--today-bg` / `--today-sh` / `--today-ink` | 今日格/今日刻度 |
| **图表** | `--chart-1` … `--chart-6` | 6 序列色板 |
| **材质** | `--atmo` / `--grain` / `--grain-img` | 弥散光 / 噪点（**仅 jade 非空**） |
| | `--bf` | `backdrop-filter`（**仅 jade 非 none**） |
| | `--sh-panel` / `--sh-top` / `--sh-qb` / `--sh-pop` / `--sh-hover` / `--btn-sh` / `--step-sh` / `--head-rule` | 阴影槽位 |
| | `--r-panel` / `--r-btn` / `--r-chip` / `--r-pill` / `--r-seal` | 圆角 |
| | `--f-num` / `--f-case` / `--f-quote` / `--f-display` | 字体角色（见 §3.2） |

### 2.2 皮肤 pro「专业」— 亮色 · 默认

选择器：`:root, [data-skin="pro"]`
**对比度按 `--bg-base` (#F6F7F8) 计——它比 `--surface` (#FFF) 暗，是更严的那个底。**

**底 / 表面**

| 令牌 | 值 |
|---|---|
| `--bg-base` | `#F6F7F8` |
| `--surface` | `#FFFFFF` |
| `--surface-2` | `#FBFBFC` |
| `--surface-solid` | `#FFFFFF` |
| `--surface-bar` | `#FFFFFF` |
| `--surface-pop` | `#FFFFFF` |
| `--head-bg` | `#FBFBFC` |
| `--hover` | `#F5F6F8` |
| `--ctl-bg` | `#FFFFFF` |
| `--we-bg` | `#FAFAFB` |
| `--sel` | `#D3EAE0` |
| `--scrim` | `rgba(23,24,26,.34)` |

**文本 / 线**

| 令牌 | 值 | 对比度 on `--bg-base` |
|---|---|---|
| `--ink` | `#17181A` | **16.6:1** ✓ |
| `--ink-2` | `#3F444C` | **9.1:1** ✓ |
| `--muted` | `#565B62` | **6.4:1** ✓ |
| `--meta` | `#676C72` | **4.9:1** ✓ 次级文字下限，勿再调浅 |
| `--faint` | `#B4B9BF` | 仅装饰（分隔 / 0 值降权），非正文 |
| `--border` / `--border-h` | `#E4E6EA` / `#CFD3D9` | — |
| `--line` / `--rule` | `#EFF0F3` / `#D8DBE0` | — |

**状态色**

| 令牌 | 值 | 对比度 |
|---|---|---|
| `--green` / `--green-deep` | `#0E7A56` / `#0B5F44` | **5.3:1** ✓ 品牌资产，accent 血脉 |
| `--green-bg` / `--green-bg-h` / `--green-line` | `#E9F4EF` / `#DCEDE5` / `#BFDCCE` | — |
| `--red` / `--red-dot` | `#B42318` / `#DC2626` | **6.6:1** ✓ |
| `--red-bg` / `--red-line` / `--red-soft-ink` | `#FCF0EE` / `#F0D2CC` / `#7A4038` | — |
| `--amber` / `--amber-dot` | `#B45309` / `#D97706` | **4.9:1** ✓ 文字可用，也当填充色 |
| `--amber-bg` / `--amber-line` | `#FBF4E4` / `#EAD8AC` | — |
| `--blue` / `--blue-dot` | `#1D4ED8` / `#2563EB` | **7.0:1** ✓ |
| `--blue-bg` / `--blue-line` | `#EEF4FE` / `#CFDEF8` | — |
| `--teal` | `#0F766E` | — |
| `--ok-dot` / `--gray-dot` | `#0E7A56` / `#A8ADB3` | — |
| `--focus` | `#0E7A56` | — |
| `--link` / `--link-h` | `#0E7A56` / `#0B5F44` | — |
| `--on-solid` | `#FFFFFF` | — |

**元件 / 品牌 / 头条 / 跑道 / CTA / 图表**

| 令牌 | 值 |
|---|---|
| `--chip-bg` / `--chip-bd` | `#FAFAFB` / `#EAECEF` |
| `--ck-bd` / `--ck-bg` | `#C6CBD1` / `#FFFFFF` |
| `--kbd-bg` / `--kbd-bd` / `--kbd-ink` / `--kbd-sh` | `#F6F7F8` / `#E1E3E7` / `#565B62` / `none` |
| `--seal-bg` / `--seal-ink` / `--seal-sh` | `#0E7A56` / `#FFFFFF` / `inset 0 0 0 1px rgba(255,255,255,.32)` |
| `--pill-bg` / `--pill-ink` | `#B42318` / `#FFFFFF` |
| `--nav-on-ink` / `--nav-on-bg` / `--nav-on-bar` | `#17181A` / `transparent` / `#0E7A56` |
| `--sw-on-bg` / `--sw-on-ink` | `#0E7A56` / `#FFFFFF` |
| `--hd-bg` / `--hd-bg-h` | `#FCF0EE` / `#FAE9E6` |
| `--hd-edge` / `--hd-edge-ok` | `none` / `none`（pro 本来就是扁平无栏杆） |
| `--hd-ink` / `--hd-meta` / `--hd-rule` | `#4A1D17` / `#5E5450` / `#0E7A56` |
| `--trk-bg` / `--trk-bd` / `--trk-tick` | `#F2F3F5` / `#E6E8EC` / `rgba(23,24,26,.09)` |
| `--fill-over` | `repeating-linear-gradient(135deg, #B42318 0 4px, #EFC5BF 4px 8px)` |
| `--fill-crit` / `--fill-warn` / `--fill-ok` | `#DC2626` / `#D97706` / `#0E7A56` |
| `--fill-ok-soft` / `--fill-warn-soft` | `#8FBCA9` / `#E2C494` |
| `--dot-ring` | `#FFFFFF` |
| `--cta-bg` / `--cta-bg-h` / `--cta-bd` / `--cta-ink` | `#0E7A56` / `#0B5F44` / `#0B5F44` / `#FFFFFF` |
| `--today-bg` / `--today-sh` / `--today-ink` | `#E9F4EF` / `inset 0 0 0 1px #0E7A56` / `#0B5F44` |
| `--chart-1` … `--chart-6` | `#0E7A56` `#0891B2` `#1D4ED8` `#B45309` `#6B7280` `#B42318` |

**材质**

| 令牌 | 值 |
|---|---|
| `--atmo` / `--grain` / `--grain-img` | `none` / `0` / `none` — **pro 无弥散光无噪点** |
| `--bf` | `none` — **pro 零毛玻璃** |
| 阴影全组 | `--sh-panel: none` · `--sh-top: none` · `--sh-qb: none` · `--sh-hover: none` · `--btn-sh: none` · `--cta-sh: none` · `--dot-sh: none` · `--head-rule: none` · `--step-sh: none` |
| `--sh-pop` | `0 8px 28px -10px rgba(23,24,26,.22)` — **唯一的阴影，只给浮层** |
| 圆角 | `--r-panel: 8px` · `--r-btn: 6px` · `--r-chip: 4px` · `--r-pill: 20px` · `--r-seal: 5px` |
| 字体角色 | `--f-num: var(--mono)` · `--f-case: var(--mono)` · `--f-quote: var(--sans)` · `--f-display: var(--sans)` |

### 2.3 皮肤 paper「纸感」— 亮色

选择器：`[data-skin="paper"]`
**暖白纸底 · hairline 实线 · 零阴影零渐变零玻璃 · 衬线主导。**
**对比度按 `--bg-base` (#F4EFE3) 计——比纸面 `--surface` (#FBF9F4) 暗，是更严的那个底。**

> **翡翠绿在 paper 只占两处签名位：**
> 1. 引首印（`--seal-bg` = logo 底）
> 2. 头条下划线（`--hd-rule`）
>
> 其余一切绿的位置在 paper 都退成墨色。这是 paper 的身份，不许加第三处绿。

**底 / 表面**

| 令牌 | 值 |
|---|---|
| `--bg-base` | `#F4EFE3` |
| `--surface` | `#FBF9F4` |
| `--surface-2` | `rgba(28,26,23,.028)` |
| `--surface-solid` | `#FDFCF8` |
| `--surface-bar` | `#FBF9F4` |
| `--surface-pop` | `#FDFCF8` |
| `--head-bg` | `rgba(28,26,23,.030)` |
| `--hover` | `rgba(28,26,23,.045)` |
| `--ctl-bg` | `transparent`（控件走 hairline 下划线，见下） |
| `--we-bg` | `rgba(28,26,23,.035)` |
| `--sel` | `rgba(14,122,86,.16)` |
| `--scrim` | `rgba(28,26,23,.36)` |

**文本 / 线**

| 令牌 | 值 | 对比度 on `--bg-base` |
|---|---|---|
| `--ink` | `#1C1A17` | **14.7:1** ✓ |
| `--ink-2` | `#4A443C` | **8.1:1** ✓ |
| `--muted` | `#6E675E` | **4.9:1** ✓ |
| `--meta` | `#6B6358` | **5.2:1** ✓ 次级文字下限，勿再调浅 |
| `--faint` | `#A79E90` | 仅装饰，非正文 |
| `--border` / `--border-h` | `rgba(28,26,23,.26)` / `rgba(28,26,23,.46)` | — |
| `--line` / `--rule` | `rgba(28,26,23,.16)` / `rgba(28,26,23,.44)` | — |

**状态色**

| 令牌 | 值 | 备注 |
|---|---|---|
| `--green` / `--green-deep` | `#0E7A56` / `#0B6647` | 只用于两处签名位 |
| `--green-bg` / `--green-bg-h` / `--green-line` | `rgba(14,122,86,.10)` / `rgba(14,122,86,.17)` / `rgba(14,122,86,.32)` | — |
| `--red` / `--red-dot` | `#B42318` / `#B42318` | — |
| `--red-bg` / `--red-line` / `--red-soft-ink` | `rgba(180,35,24,.07)` / `rgba(180,35,24,.30)` / `#7A3A31` | — |
| `--amber` / `--amber-dot` | `#A94E09` / `#C2410C` | 印刷朱橙 **4.8:1** on `--bg-base` |
| `--amber-bg` / `--amber-line` | `rgba(194,65,12,.07)` / `rgba(194,65,12,.30)` | — |
| `--blue` / `--blue-dot` | `#23538F` / `#23538F` | — |
| `--blue-bg` / `--blue-line` | `rgba(35,83,143,.07)` / `rgba(35,83,143,.28)` | — |
| `--teal` | `#1F6F78` | — |
| `--ok-dot` | `#4A443C` | **纸皮肤的「正常」= 墨色，不喧宾夺主** |
| `--gray-dot` | `#8C857A` | — |
| `--focus` | `#0E7A56` | 焦点环仍走绿（可访问性 > 纯度） |
| `--link` / `--link-h` | `#1C1A17` / `#000000` | 链接是墨色 + 下划线，不是绿 |
| `--on-solid` | `#FBF9F4` | — |

**元件 / 品牌 / 头条 / 跑道 / CTA / 图表**

| 令牌 | 值 |
|---|---|
| `--chip-bg` / `--chip-bd` | `transparent` / `rgba(28,26,23,.28)` |
| `--ck-bd` / `--ck-bg` | `rgba(28,26,23,.46)` / `#FFFDF8` |
| `--kbd-bg` / `--kbd-bd` / `--kbd-ink` / `--kbd-sh` | `transparent` / `rgba(28,26,23,.34)` / `#4A443C` / `none` |
| `--seal-bg` / `--seal-ink` / `--seal-sh` | `#0E7A56` / `#FBF9F4` / `none` — **签名位 1/2 · 引首印** |
| `--pill-bg` / `--pill-ink` | `#1C1A17` / `#FBF9F4` |
| `--nav-on-ink` / `--nav-on-bg` / `--nav-on-bar` | `#1C1A17` / `transparent` / `#1C1A17` |
| `--sw-on-bg` / `--sw-on-ink` | `#1C1A17` / `#FBF9F4` |
| `--hd-bg` / `--hd-bg-h` | `transparent` / `rgba(28,26,23,.035)` |
| `--hd-edge` | `inset 3px 0 0 0 #B42318` — 头版红栏杆（印刷规则线，不是阴影） |
| `--hd-edge-ok` | `inset 3px 0 0 0 rgba(28,26,23,.82)` — 冷静态墨栏杆（不用绿：绿只占两处签名位） |
| `--hd-ink` / `--hd-meta` | `#1C1A17` / `#6E675E` |
| `--hd-rule` | `#0E7A56` — **签名位 2/2 · 头条下划线** |
| `--trk-bg` / `--trk-bd` / `--trk-tick` | `rgba(28,26,23,.035)` / `rgba(28,26,23,.24)` / `rgba(28,26,23,.16)` |
| `--fill-over` | `repeating-linear-gradient(135deg, #B42318 0 3px, rgba(180,35,24,.12) 3px 7px)` |
| `--fill-crit` / `--fill-warn` / `--fill-ok` | `#B42318` / `#C2410C` / `#4A443C` |
| `--fill-ok-soft` / `--fill-warn-soft` | `rgba(74,68,60,.55)` / `rgba(194,65,12,.48)` |
| `--dot-ring` | `#FBF9F4` |
| `--cta-bg` / `--cta-bg-h` / `--cta-bd` / `--cta-ink` | `#1C1A17` / `#000000` / `#1C1A17` / `#FBF9F4` — **主按钮是墨块反白，不是绿** |
| `--today-bg` / `--today-sh` / `--today-ink` | `#1C1A17` / `none` / `#FBF9F4` — 反白墨块（月历格例外，见下） |
| `--chart-1` … `--chart-6` | `#0E7A56` `#1F6F78` `#23538F` `#C2410C` `#6E675E` `#B42318` |

**材质**

| 令牌 | 值 |
|---|---|
| `--atmo` / `--grain` / `--grain-img` | `none` / `0` / `none` — **paper 无弥散光无噪点** |
| `--bf` | `none` — **paper 零毛玻璃** |
| 阴影全组 | `--sh-panel` · `--sh-top` · `--sh-qb` · `--sh-hover` · `--btn-sh` · `--cta-sh` · `--dot-sh` · `--step-sh` **全为 `none`（零阴影）** |
| `--sh-pop` | `0 10px 30px -14px rgba(28,26,23,.34)` — 唯一例外，只给浮层 |
| `--head-rule` | `inset 0 2px 0 0 rgba(28,26,23,.82)` — **牛津粗线**（§1.4 铁律用例） |
| 圆角 | `--r-panel: 0` · `--r-btn: 0` · `--r-chip: 0` · `--r-pill: 0` · `--r-seal: 2px` — **全直角** |
| 字体角色 | `--f-num: var(--serif)`（衬线数字 = 铅字排印） · `--f-case: var(--sans)` · `--f-quote: var(--serif)` · `--f-display: var(--serif)` |

**paper 的层 B 表面规则**（只动 `background` / `border-color` / `box-shadow`，零位移）

```css
/* 控件 = hairline 下划线，不是框 */
[data-skin="paper"] .btn:not(.primary),
[data-skin="paper"] input:not([type=checkbox]):not([type=range]),
[data-skin="paper"] select,
[data-skin="paper"] textarea {
  background: transparent; border-color: transparent;
  box-shadow: inset 0 -1px 0 0 var(--rule);
}
[data-skin="paper"] .btn:not(.primary):hover { background: rgba(28,26,23,.055); border-color: transparent; }
[data-skin="paper"] .btn.ok       { box-shadow: inset 0 -2px 0 0 #1C1A17; }
[data-skin="paper"] .skins        { background: transparent; }
[data-skin="paper"] .strip,
[data-skin="paper"] .cal-cell     { border-color: var(--rule); }
[data-skin="paper"] .p-foot       { background: transparent; box-shadow: inset 0 1px 0 0 var(--rule); }
```

**月历今日格的令牌重映射（必读，勿删）**

paper 的 `--today-bg` 是近黑反白 `#1C1A17`，本为 `.strip-today`（格里只有一个白数字）设计。
撞上 `.cal-chip { color: var(--ink) }` 在 paper 里同为 `#1C1A17` → **同色不可见，实测对比度 1.03:1**（今日格整块变黑，chip 肉眼消失）。
只在月历格内重映射三个令牌——纸白底 + 2px inset 墨规则线 + 墨字：

```css
[data-skin="paper"] .cal-cell.today,
[data-skin="paper"] .cal-daynum.is-today {   /* 数字已是格子的兄弟节点，须同时点名 */
  --today-bg: var(--surface-solid);
  --today-sh: inset 0 0 0 2px var(--ink);   /* border-width 恒 1px → 粗线走 inset shadow */
  --today-ink: var(--ink);
}
```
`.strip-today` 不受影响，反白块原样保留。pro (15.9:1) / jade (10.6:1) 本来就正常，无需特判。

### 2.4 皮肤 jade「翡翠」— 暗色

选择器：`[data-skin="jade"]`
**墨绿 / 翡冷翠底 · 毛玻璃（面板级 blur）· 翡翠亮绿 `#4FD6A4` · 衬线大数字。**
令牌值承接 v4 已上线验证过的 `[data-theme=dark]` 段。对比度按 `--bg-base` (#050D0A) 计。

> **v5 的关键变更：jade 从「亮玻璃」改为「暗玻璃」。** jade 即暗色主题本体。

**底 / 表面**

| 令牌 | 值 |
|---|---|
| `--bg-base` | `#050D0A` |
| `--surface` | `rgba(16,30,24,.55)` （blur 面） |
| `--surface-2` | `rgba(190,240,214,.035)` |
| `--surface-solid` | `rgba(19,36,29,.90)` — **无 blur 的面**（cal-cell / tile / case-card） |
| `--surface-bar` | `rgba(11,22,17,.68)` |
| `--surface-pop` | `rgba(19,36,29,.90)` |
| `--head-bg` | `rgba(190,240,214,.04)` |
| `--hover` | `rgba(79,214,164,.09)` |
| `--ctl-bg` | `rgba(190,240,214,.06)` |
| `--we-bg` | `rgba(2,10,7,.32)` |
| `--sel` | `rgba(79,214,164,.24)` |
| `--scrim` | `rgba(0,0,0,.56)` |

**文本 / 线**

| 令牌 | 值 | 对比度 on `#050D0A` |
|---|---|---|
| `--ink` | `#E7EFEA` | **15.3:1** ✓ |
| `--ink-2` | `#C3D2CA` | **11.6:1** ✓ |
| `--muted` | `#A7B6AD` | **8.8:1** ✓ |
| `--meta` | `#8FA096` | **6.6:1** ✓ |
| `--faint` | `#5E6F66` | 仅装饰，非正文 |
| `--border` / `--border-h` | `rgba(190,240,214,.14)` / `rgba(190,240,214,.28)` | — |
| `--line` / `--rule` | `rgba(190,240,214,.08)` / `rgba(190,240,214,.30)` | — |

**状态色**

| 令牌 | 值 | 对比度 |
|---|---|---|
| `--green` / `--green-deep` | `#4FD6A4` / `#2FBE8C` | **9.8:1** ✓ 暗色态品牌绿 |
| `--green-bg` / `--green-bg-h` / `--green-line` | `rgba(79,214,164,.14)` / `rgba(79,214,164,.22)` / `rgba(79,214,164,.32)` | — |
| `--red` / `--red-dot` | `#E4685C` / `#E4685C` | **5.5:1** ✓ |
| `--red-bg` / `--red-line` / `--red-soft-ink` | `rgba(228,104,92,.15)` / `rgba(228,104,92,.34)` / `#EFA79F` | — |
| `--amber` / `--amber-dot` | `#E0A45C` / `#E0A45C` | **8.3:1** ✓ |
| `--amber-bg` / `--amber-line` | `rgba(224,164,92,.14)` / `rgba(224,164,92,.32)` | — |
| `--blue` / `--blue-dot` | `#5C88DC` / `#5C88DC` | **5.2:1** ✓ |
| `--blue-bg` / `--blue-line` | `rgba(92,136,220,.14)` / `rgba(92,136,220,.32)` | — |
| `--teal` | `#2FA0B4` | — |
| `--ok-dot` / `--gray-dot` | `#4FA878` / `#7D8F85` | — |
| `--focus` | `#4FD6A4` | — |
| `--link` / `--link-h` | `#83E7C4` / `#4FD6A4` | — |
| `--on-solid` | `#06231B` | 亮绿实色块上用**深色**字 |

**元件 / 品牌 / 头条 / 跑道 / CTA / 图表**

| 令牌 | 值 |
|---|---|
| `--chip-bg` / `--chip-bd` | `rgba(190,240,214,.05)` / `rgba(190,240,214,.12)` |
| `--ck-bd` / `--ck-bg` | `rgba(190,240,214,.28)` / `rgba(190,240,214,.06)` |
| `--kbd-bg` / `--kbd-bd` / `--kbd-ink` | `rgba(190,240,214,.07)` / `rgba(190,240,214,.16)` / `#A7B6AD` |
| `--kbd-sh` | `inset 0 1px 0 rgba(255,255,255,.06)` |
| `--seal-bg` | `linear-gradient(135deg, #65E3B5, #2FBE8C)` |
| `--seal-ink` / `--seal-sh` | `#06231B` / `inset 0 0 0 1px rgba(255,255,255,.20), 0 2px 8px -3px rgba(79,214,164,.5)` |
| `--pill-bg` / `--pill-ink` | `#E4685C` / `#2A0B08` |
| `--nav-on-ink` / `--nav-on-bg` / `--nav-on-bar` | `#83E7C4` / `rgba(79,214,164,.10)` / `#4FD6A4` |
| `--sw-on-bg` / `--sw-on-ink` | `rgba(79,214,164,.90)` / `#06231B` |
| `--hd-bg` / `--hd-bg-h` | `rgba(228,104,92,.10)` / `rgba(228,104,92,.15)` |
| `--hd-edge` | `inset 3px 0 0 0 rgba(228,104,92,.85)` |
| `--hd-edge-ok` | `inset 3px 0 0 0 rgba(79,214,164,.55)` — 冷静态翡翠栏杆 |
| `--hd-ink` / `--hd-meta` | `#F3E4E1` / `#C6ABA6` |
| `--hd-rule` | `linear-gradient(90deg, #4FD6A4, rgba(79,214,164,.06))` |
| `--trk-bg` / `--trk-bd` / `--trk-tick` | `rgba(190,240,214,.05)` / `rgba(190,240,214,.10)` / `rgba(190,240,214,.10)` |
| `--fill-over` | `repeating-linear-gradient(135deg, rgba(228,104,92,.9) 0 4px, rgba(228,104,92,.22) 4px 8px)` |
| `--fill-crit` | `#E4685C` |
| `--fill-warn` | `linear-gradient(90deg, rgba(224,164,92,.35), rgba(224,164,92,.92))` |
| `--fill-ok` | `linear-gradient(90deg, rgba(79,214,164,.30), rgba(79,214,164,.85))` |
| `--fill-ok-soft` / `--fill-warn-soft` | `rgba(79,214,164,.55)` / `rgba(224,164,92,.55)` |
| `--dot-ring` | `#0C1F17` |
| `--cta-bg` | `linear-gradient(135deg, #65E3B5, #2FBE8C)` |
| `--cta-bg-h` | `linear-gradient(135deg, #79EBC0, #3ACD99)` |
| `--cta-bd` / `--cta-ink` | `transparent` / `#06231B` |
| `--today-bg` / `--today-sh` / `--today-ink` | `rgba(79,214,164,.16)` / `inset 0 0 0 1px #4FD6A4` / `#83E7C4` |
| `--chart-1` … `--chart-6` | `#4FD6A4` `#2FA0B4` `#5C88DC` `#E0A45C` `#9AA8A0` `#E4685C` |

**材质**

| 令牌 | 值 |
|---|---|
| `--bf` | `blur(12px) saturate(1.35)` — **全系统唯一非 none 的 backdrop-filter** |
| `--sh-panel` | `0 1px 2px rgba(0,0,0,.45), 0 22px 48px -30px rgba(0,0,0,.72), inset 0 1px 0 rgba(255,255,255,.05)` |
| `--sh-top` | `0 1px 0 rgba(190,240,214,.04)` |
| `--sh-qb` | `0 -16px 42px -26px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.05)` |
| `--sh-pop` | `0 2px 6px rgba(0,0,0,.5), 0 32px 70px -30px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.06)` |
| `--sh-hover` | `0 10px 26px -18px rgba(0,0,0,.7)` |
| `--btn-sh` | `inset 0 1px 0 rgba(255,255,255,.05)` |
| `--cta-sh` | `0 8px 20px -12px rgba(79,214,164,.55)` |
| `--dot-sh` | `0 1px 3px rgba(0,0,0,.5)` |
| `--head-rule` | `inset 0 1px 0 rgba(255,255,255,.04)` |
| `--step-sh` | `none` |
| 圆角 | `--r-panel: 16px` · `--r-btn: 10px` · `--r-chip: 6px` · `--r-pill: 20px` · `--r-seal: 8px` |
| 字体角色 | `--f-num: var(--serif)`（衬线大数字） · `--f-case: var(--sans)` · `--f-quote: var(--serif)` · `--f-display: var(--serif)` |
| `--atmo` / `--grain` / `--grain-img` | 见 §7 |

**jade 的层 B 表面规则**（绝对定位装饰层，零布局影响）

```css
/* 渐变发丝描边：absolute + inset:0 + pointer-events:none 的遮罩伪元素 */
[data-skin="jade"] .panel::before,
[data-skin="jade"] .card::before {
  content: ''; position: absolute; inset: 0; padding: 1px;
  border-radius: inherit; pointer-events: none;
  background: linear-gradient(150deg, rgba(255,255,255,.22), rgba(255,255,255,.04) 42%, rgba(79,214,164,.20));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
}
[data-skin="jade"] .panel:hover,
[data-skin="jade"] .card:hover { border-color: rgba(190,240,214,.20); }
```

### 2.5 auto（跟随 OS）

选择器：`@media (prefers-color-scheme: dark) { :root:not([data-skin="pro"]):not([data-skin="paper"]):not([data-skin="jade"]) { … } }`

| OS 偏好 | 生效皮肤 | 机制 |
|---|---|---|
| 亮 | **pro** | `:root` 的 pro 令牌天然生效（无 media query 命中） |
| 暗 | **jade** | media query 内复制 jade 全套令牌 + 发丝描边伪元素 |

**契约：选 auto 时 JS 必须 `removeAttribute('data-skin')`**，而不是写 `data-skin="auto"`。
`:not()` 三连选择器靠「无属性」命中；写了 `auto` 值反而不命中（那三个 `:not()` 都为真，其实也会命中——但特异性与维护成本不划算，且 `data-skin="auto"` 是非法值，CSS 层没有对应的皮肤定义）。**统一走 removeAttribute。**

> **维护警告：** jade 的令牌在 CSS 里**写了两遍**（`[data-skin="jade"]` 一遍、auto-dark media query 内一遍）。
> 改 jade 任一令牌，**两处都要改**。这是 vanilla CSS 无变量继承机制下的必要冗余（不引入构建步骤的代价）。

### 2.6 已移除的兼容别名（v4 令牌 → v5 槽位）

9 页与业务代码清除旧令牌引用后，CSS 的「层 A-alias」兼容块已删除。下表仅保留迁移对照；运行时代码不得再使用左栏名称。

| v4 令牌 | → v5 |
|---|---|
| `--accent` / `--accent-ink` / `--accent-deep` / `--accent-soft` | `--green` / `--green-deep` / `--green-deep` / `--green-bg` |
| `--st-good` / `--st-warn` / `--st-crit` | `--green` / `--amber` / `--red` |
| `--good-soft` / `--warn-soft` / `--crit-soft` | `--green-bg` / `--amber-bg` / `--red-bg` |
| `--cat-event` / `--cat-log` | `--blue` / `--teal` |
| `--track` | `--trk-bg` |
| `--glass` / `--glass-card` | `--surface` |
| `--glass-strong` | `--surface-solid` |
| `--glass-line` / `--glass-line-soft` | `--border` / `--line` |
| `--blur` | `--bf` |
| `--shadow` / `--shadow-up` | `--sh-panel` / `--sh-pop` |
| `--glow` | `--green-bg` |
| `--btn-grad` / `--btn-grad-hover` / `--btn-text` | `--cta-bg` / `--cta-bg-h` / `--cta-ink` |
| `--num-grad-a` / `--num-grad-b` | `--ink` / `--ink`（渐变数字已废，退化为实色） |
| `--r` / `--r-s` | `--r-panel` / `--r-btn` |

> **运行时已无兼容定义。新代码禁止引用 v4 令牌名。**

---

## 3. 排版令牌

### 3.1 字体栈（三皮肤共用的原料，皮肤禁改）

```css
--sans:  "Noto Sans SC", -apple-system, BlinkMacSystemFont, "PingFang SC", "MiSans",
         "Noto Sans CJK SC", "Helvetica Neue", "Segoe UI", "Microsoft YaHei", sans-serif;
--mono:  "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans SC", "PingFang SC", monospace;
--serif: "Noto Serif SC", "Songti SC", "STSong", "Noto Serif CJK SC", "Times New Roman", "SimSun", serif;
```
v5.5 起思源家族（自托管，见 v5.5 节）打头，系统栈退为切片加载间隙与极端离线的回退；--mono 仍以 SF Mono 链打头（数字等宽，全平台 digits 无缺字）。

### 3.2 字体角色（皮肤唯一能改的排版维度）

皮肤不能改字号，但可以改**哪类内容用哪个字体家族**：

| 角色令牌 | 用在哪 | pro | paper | jade |
|---|---|---|---|---|
| `--f-num` | 一切数字：`.hd-num` `.rw-days` `.tile-v` `.kpi-row .v b` `.hear-when` `.tl-date` `.rw-due` `.num` `.donut-center .v` `.gauge-center .v` `.strip-num` `.cal-daynum` `.badge-dot` `.page-title .date` | **mono** | serif | serif |
| `--f-case` | 案号（`.case` / `.chip.mono` / `.rw-case` / `.hear-no`） | **mono** | sans | sans |
| `--f-quote` | 案由/事项等「引文」（`.inb-q` `.hear-name` `.case-card .cname`） | **sans** | serif | serif |
| `--f-display` | `h1 / h2 / h3` | **sans** | serif | serif |

**全局恒定（皮肤禁改）：**
- `body` → `--sans`
- `font-variant-numeric: tabular-nums`（全局，反 slop 硬约束）
- UI chrome（`.p-title` / `.card > h2` / `.group-title` / `.chart-title` / `.settings-section h2` / `.brand .ver` / `.sk` / `.btn`）→ **恒 `--sans`**
- `.hd-deck`（头条案由）→ **恒 `--serif`**
- `.kbd` → 恒 `--mono`

### 3.3 字号层级（骨架，皮肤禁改）

`--fs-body: 14px`（正文，可访问性硬底线 ≥14px；标签/注释下限 12px）。**字号不随断点放大**（v4 的宽屏字号缩放已删除）。

**跑道字号梯度 = 剩余天数**（1.8 的核心信息层级为 56 → 24 → 20 → 16）：

| 选择器 | 字号 | 字重 | 说明 |
|---|---|---|---|
| `.hd-num .n` | **56px** | 800 | 头条：最近死线的「N」。全页最大的数字（SPEC 要求 ≥48px），56/14 = **4.0× 正文** |
| `.hd-deck` | 28px | 700 | 头条案由 deck（恒衬线） |
| `.hd-num .w` | 20px | 700 | 头条的「逾期 / 剩」字样 |
| `.rw-row.d1 .rw-days .n` | 24px | 700 | 跑道第 1 档 |
| `.rw-row.d2 .rw-days .n` | 20px | 700 | 跑道第 2 档 |
| `.rw-row.d3 .rw-days .n` | 16px | 700 | 跑道第 3 档 |

**其余层级：**

| 选择器 | 字号 / 字重 | 用途 |
|---|---|---|
| `.donut-center .v` | 30 / 700 | 环形图中心数 |
| `.gauge-center .v` | 27 / 700 | 仪表中心数 |
| `.tile-v` | 22 / 650 | KPI 瓷片数字 |
| `.page-title`、`.page-title .date` | 26 / 700、20 / 590 | 今日 / 费用页标题；案件抬头案名为 22 / 700 |
| `.dmodal-title` | 17 / — | 弹窗标题 |
| `.case-card .cname`、`.kpi-row .v b`、`.hear-when` | 16 / 650 | 案名 / KPI 值 / 开庭时间 |
| `.rw-main .m1`、`.inb-q`、`.hear-name` | 15 / 590 | 事项 / 收件箱引文 / 案名 |
| `.brand b` | 15 / 650 | 品牌字 |
| `body`、`.t-text`、`.tile`→`.row` 正文、`input` | **14** / 400–560 | 正文基线 |
| `.page-title .wk`、`.prog-row .t`、`.settings-row .label` | 14 | — |
| `#toast`、`.topnav .links a` | 13.5 / 500 | — |
| `.btn` | 13 / 560 | `.btn.small` = 12.5 |
| `.page-sub`、`.rw-main .m2`、`.tl-note`、`.gap-act` | 13 | — |
| `.card > h2`、`.chart-title`、`.settings-section h2` | 13 / 650 · `letter-spacing: .08em` | 旧骨架卡标题 |
| `.strip-num` | 13 / 590 | — |
| `.navbadge`、`.row .meta`、`.tl-date`、`.rw-case`、`.hear-no`、`.case-card .cmeta` | 12.5 | — |
| `.p-title` | **14 / 650 · `letter-spacing: 0`** | 面板栏头，必须重过正文 |
| `.group-title` | 14 / 650 · `.04em` | 分组标题，尾随 1px 横规则线 |
| `.chip`、`.pill`、`.kbd`、`.tile-l`、`.bar-label`、`.cal-chip`、`.cal-cell` | **12** | **标签字号下限，勿再调小** |
| `.cal-daynum` | 11.5 / 590 | 日期数字（周行第 1 行，不再嵌在 `.cal-cell` 内） |
| `.step-name` | 11.5 | — |
| `.strip-dow`、`.gauge-center .l` | 11 | 仅装饰性图例 |

**移动端（<768px）字号降档：** `.hd-num .n` 56 → **48px**；费用净额 56 → **48px**；`.hd-deck` 28 → **22px**；`.rw-row.d1 .rw-days .n` 24 → **22px**（剩余列只有 72px，两位数逾期会溢出）。其余不变。

---

## 4. 间距 / 尺度令牌（骨架，皮肤禁改）

### 4.1 骨架尺度变量

| 令牌 | 值 | 用途 |
|---|---|---|
| `--h-top` | `48px` | 顶栏高 |
| `--h-qb` | `60px` | 快录条基准高（**三皮肤同高**：高度写在层 A） |
| `--w-page` | `1400px` | 工作台页宽（今日 / 案件 / 日历 / 统计） |
| `--w-read` | `1180px` | 阅读型页宽（用户中心等；案件详情 / 费用 1.8 起改用 `--w-page`） |
| `--w-right` | `404px` | 通用双栏右栏宽（1.8 今日覆写 360px、详情工作台覆写 380px） |
| `--gap` | `16px` | 通用面板间距（1.8 业务组内 12px，组间 32px；<768px 组间 28px） |
| `--gap-s` | `10px` | 密排间距（tiles / case-grid） |
| `--page-pad` | `16 / 20 / 24 / 32px` | 页面左右留白，**唯一随断点缩放的尺度** |

`--page-pad` 断点：`<768: 16px` · `≥768: 20px` · `≥1280: 24px` · `≥1900: 32px`

### 4.2 内边距刻度（层 A 写死）

| 场景 | 值 |
|---|---|
| 面板内容区 `.panel-body` | `14px 16px` |
| 传统卡 `.card` | `14px 16px`（margin `var(--gap) 0`） |
| 面板栏头 `.p-head` | `0 16px`，`min-height: 48px`（<768px：56px） |
| 面板脚 `.p-foot` | `8px 14px` |
| 跑道头条 `.hd-main` | `18px 14px 16px` |
| 跑道行 `.rw-main` | d1 `12px 14px` / d2 `10px 14px` / d3 `9px 14px` |
| 通用行 `.row` / `.todo-row` | `13px 16px` |
| 收件箱行 `.inb-row` / 缺口行 `.gap-row` / 开庭 `.hear` | `13px 16px` |
| 款项行 `.pay-row` / 进度行 `.prog-row` | `13px 16px` |
| KPI 行 `.kpi-row` | `9px 14px` |
| KPI 瓷片 `.tile` | `11px 13px` |
| 案件卡 `.case-card` | `14px 16px` |
| 日历格 `.cal-daynum` | `6px 9px 0`（桌面/移动一致） |
| 日历格 `.cal-day-chips` | `0 3px 3px`（桌面/移动一致） |
| 日历格 `.cal-cell` | `0` — 车道化后格子只当背景与命中面，内边距搬到 `.cal-daynum` / `.cal-day-chips` |
| 弹窗 `.dmodal` | `20px 22px` |
| 登录卡 `.login-card` | `28px 26px` |

### 4.3 快录条净空

`body { padding-bottom: calc(var(--h-qb) + 32px) }` 兜底；`nav.js` 的 `ResizeObserver` 会写内联 `paddingBottom`（基准 128px）覆盖它。两者都 ≥ 快录条高 + 24px，不冲突。
登录页例外：`body:has(.login-wrap) { padding-bottom: 0 }`（无顶栏无快录条）。

---

## 5. 圆角令牌

**圆角是材质，皮肤自决**（属白名单）。层 A 只引用槽位。

| 槽位 | pro | paper | jade | 适用 |
|---|---|---|---|---|
| `--r-panel` | `8px` | **`0`** | `16px` | `.panel` `.card` `.case-card` `.dmodal` `.login-card` `.theme-card` `details.adder` |
| `--r-btn` | `6px` | **`0`** | `10px` | `.btn` `input` `select` `.iconbtn` `.tile` `.cal-cell` `.strip` `.tl-item` `#toast` |
| `--r-chip` | `4px` | **`0`** | `6px` | `.chip` `.kbd` `.trk` `.feebar` `.ck .box` |
| `--r-pill` | `20px` | **`0`** | `20px` | `.pill` `.role-pill` |
| `--r-seal` | `5px` | `2px` | `8px` | 印章 logo |

固定圆角（层 A 写死，非材质）：`.dot` / `.mini-dot` / `.trk-dot` / `.step-dot` / `.tl-node` / `.rw-flag` = `50%`；`.trk-fill` = `5px`（进度条半高）；`.bar` = `4px 4px 0 0`。

---

## 6. 表面 / 阴影 / 毛玻璃

### 6.1 毛玻璃：只有 jade

| 皮肤 | `--bf` |
|---|---|
| pro | `none` |
| paper | `none` |
| **jade** | **`blur(12px) saturate(1.35)`** |

**CSS 中引用 `--bf` 的选择器共 7 条（全部面板级）：**

| # | 选择器 | 运行时元素数（今日看板 1440×900） |
|---|---|---|
| 1 | `.topnav` | 1 |
| 2 | `.card, .panel` | ~8 |
| 3 | `.nav-dropdown` | 1（<768px 才显示） |
| 4 | `.quickbar` | 1 |
| 5 | `#toast` | 1 |
| 6 | `.dmodal` | 0–1（弹层） |
| 7 | `.login-card` | 1（仅登录页） |

**运行时 blur 元素总数 ≤12。** 表格行 / chip / 按钮 / `.tile` / `.case-card` / **`.cal-cell` 一律零 blur**。

### 6.2 阴影：pro/paper 近乎为零

| 槽位 | pro | paper | jade |
|---|---|---|---|
| `--sh-panel`（面板） | `none` | `none` | 三层：`0 1px 2px rgba(0,0,0,.45)` + `0 22px 48px -30px rgba(0,0,0,.72)` + `inset 0 1px 0 rgba(255,255,255,.05)` |
| `--sh-top`（顶栏） | `none` | `none` | `0 1px 0 rgba(190,240,214,.04)` |
| `--sh-qb`（快录条） | `none` | `none` | `0 -16px 42px -26px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.05)` |
| `--sh-pop`（浮层） | `0 8px 28px -10px rgba(23,24,26,.22)` | `0 10px 30px -14px rgba(28,26,23,.34)` | `0 2px 6px rgba(0,0,0,.5), 0 32px 70px -30px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.06)` |
| `--sh-hover` | `none` | `none` | `0 10px 26px -18px rgba(0,0,0,.7)` |
| `--btn-sh` / `--cta-sh` / `--dot-sh` / `--step-sh` | 全 `none` | 全 `none` | `inset 0 1px 0 rgba(255,255,255,.05)` / `0 8px 20px -12px rgba(79,214,164,.55)` / `0 1px 3px rgba(0,0,0,.5)` / `none` |
| `--head-rule` | `none` | **`inset 0 2px 0 0 rgba(28,26,23,.82)`**（牛津粗线） | `inset 0 1px 0 rgba(255,255,255,.04)` |

**规则：** pro 和 paper 的**唯一**阴影是 `--sh-pop`（浮层需要脱离页面）。其余全部为 `none`——这是「扁平」与「纸感」的定义，不是遗漏。

### 6.3 表面不透明度（jade 的 AA 底线）

| 表面 | 值 | 承载文字 | 说明 |
|---|---|---|---|
| `--surface` | `rgba(16,30,24,.55)` | ink / muted | 有 blur 兜底，`--ink` 对比度 >10:1 |
| `--surface-solid` | `rgba(19,36,29,.90)` | ink | **无 blur** 的面必须 ≥.90 |
| `--surface-bar` | `rgba(11,22,17,.68)` | ink / muted | 顶栏 + 快录条，有 blur |
| `--surface-pop` | `rgba(19,36,29,.90)` | ink | 浮层，需高对比 |

**条文：** 任何**不上 blur** 的半透明表面，底色不透明度不得低于 **0.90**。

---

## 7. 弥散光（仅 jade，克制版）

### 7.1 层结构

pro / paper：`--atmo: none; --grain: 0; --grain-img: none`——**亮色皮肤完全无弥散光、无噪点。**

jade 的 `--atmo` 共 **4 层**（v4 是 13 层：bg + wash×2 + orb×4 + ring×5 + halo + vignette）：

| # | 层 | 值 |
|---|---|---|
| 1 | **orb 1** 主翡翠 | `radial-gradient(760px 620px at 16% 6%, rgba(34,178,122,.15), transparent 68%)` |
| 2 | **orb 2** 青瓷 | `radial-gradient(840px 700px at 88% 74%, rgba(15,155,142,.10), transparent 70%)` |
| 3 | **ring 1** 玉环 | `radial-gradient(circle 620px at 72% 30%, transparent 614px, rgba(110,231,183,.09) 620px, transparent 627px)` |
| 4 | **vignette** 暗角 | `radial-gradient(140% 100% at 50% 0%, transparent 62%, rgba(2,10,7,.60) 100%)` |

噪点：`--grain: .05`，`--grain-img` = 180×180 内联 SVG `feTurbulence fractalNoise`（`baseFrequency=0.85`, `numOctaves=2`, `opacity=0.55`），data URI，零外部请求。

### 7.2 挂载点（性能红线，见 §8）

```css
body::before { position: fixed; inset: 0; z-index: -1; pointer-events: none; background: var(--atmo); }
body::after  { position: fixed; inset: 0; z-index: -1; pointer-events: none;
               opacity: var(--grain); background-image: var(--grain-img); background-size: 180px 180px; }
```
`html` 承 `--bg-base`；**`body` 必须 `background: transparent`**——不透明 body 会盖住负 z 的光幕伪元素（0.8.6 露底教训）。

### 7.3 预算上限（不许超）

| 项 | 上限 | 当前 |
|---|---|---|
| orb（径向光斑） | **≤2** | 2 |
| ring（环形渐变） | **≤1** | 1 |
| vignette | ≤1 | 1 |
| 噪点 opacity | ≤.06 | .05 |
| **总层数** | **≤4** | **4** |

**缩放系数 `--k` 已删除**——v5 的光幕尺寸写死（px/%），不随视口放大。

---

## 8. 性能红线（不可违反）

低功耗自托管设备是硬约束。以下每一条都是踩过坑写下来的：

1. **弥散光 / 噪点只挂 `body::before` / `body::after`（fixed 伪元素）** —— 禁 `background-attachment: fixed`（Chromium 重绘炸弹）。
2. **`backdrop-filter` 只准出现在面板级**：CSS 中 7 条选择器，运行时 **≤12 个元素**。
3. **`.cal-cell` 永久禁 blur** —— 单页 42+ 格，`backdrop-filter` 会严重掉帧。走 `--surface-solid`（≥.90 不透明）替代。同理 `.tile` / `.case-card` / 表格行 / chip / 按钮 一律零 blur。
4. **`overscroll-behavior: none`（挂在 `html`）** —— 关根滚动回弹，防露底（0.8.5 教训，勿删）。
5. **`html` 承底色、`body` 透明** —— 见 §7.2。
6. **hover 只做色彩 / 阴影变化，不做 `transform` 位移** —— 位移会触发毛玻璃重绘。
7. **`.panel { overflow: hidden }`** —— 但这意味着任何溢出内容会被裁掉：`.t-chips` / `.todo-row` / `.pay-row` / `.inb-row` 在窄屏必须 `flex-wrap: wrap`，否则按钮点不到（实测）。
8. **亮色皮肤零弥散光零 blur** —— pro / paper 的渲染开销近似静态 HTML。

---

## 9. 动效令牌

### 9.1 皮肤切换过渡

`skin.js` 的 `setSkin()` 给 `<html>` 加 `.skin-transitioning`，**300ms** 后移除：

```css
html.skin-transitioning, html.skin-transitioning * {
  transition: background-color .28s ease, background-image .28s ease, color .28s ease,
              border-color .28s ease, box-shadow .28s ease, fill .28s ease, stroke .28s ease !important;
}
```
**不过渡 `backdrop-filter`**（过渡极耗性能，切换时直接跳变）。

### 9.2 组件微动效

| 交互 | 属性 | 时长 |
|---|---|---|
| 通用 hover（行 / chip / 卡 / 导航） | `background` / `color` / `border-color` | **.12s** |
| `.btn` hover | `background` / `border-color` / `color` | .12s |
| `.case-card` hover | + `box-shadow` | .12s |
| `details.adder` 展开 | `summary::before` 旋转 45°（`+` → `×`） | .18s |
| `#toast` | `opacity` + `visibility` | .2s |
| `focus-visible` | `outline: 2px solid var(--focus); outline-offset: 2px` | 即时 |

**规范：hover 不做 `transform` 位移**（见 §8.6）。

### 9.3 降级（必须放在文件末尾，靠源顺序压住上面的字面量）

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
  html.skin-transitioning, html.skin-transitioning * { transition: none !important; }
}

@media (prefers-reduced-transparency: reduce) {
  :root, [data-skin="pro"], [data-skin="paper"] { --bf: none; }
  [data-skin="jade"] {
    --bf: none;
    --surface: rgba(16,30,24,.97);
    --surface-bar: rgba(11,22,17,.98);
    --surface-pop: rgba(19,36,29,.99);
    --surface-solid: rgba(19,36,29,.99);
    --atmo: none; --grain: 0; --grain-img: none;
  }
  /* auto-dark 同款；并兜底关闭任何走字面量 blur 的浮层 */
  .card, .panel, .topnav, .quickbar, .nav-dropdown, .dmodal, #toast, .login-card {
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
  }
}
```

---

## 10. 组件清单（class inventory）

按 `style.css` 层 A 的分区编号。**改 HTML 骨架前必须逐条对照 JS 的 DOM 钩子**（上一轮 v4 就栽在丢钩子导致白屏）。

### A-2 顶栏（`nav.js` 运行时 `prepend` 到 body）

| class | 说明 |
|---|---|
| `.topnav` | `position: sticky; top: 0; z-index: 60`，高 `--h-top` (48px)，`--surface-bar` + `--bf` |
| `.brand` / `.brand .seal` / `.brand b` / `.brand .ver` | 品牌区。`.seal` = 几何案卷对齐 mark（23×23，登录页放大到 28×28；图像源 `/assets/anjian-icon.png` 自带统一 macOS 圆角）。`.ver` **字体锁 sans** |
| `.topnav .links a` / `.active` | 7 个导航项（今日 / 案件 / 日历 / 费用 / 修复 / 统计 / 用户中心），13.5px 纯文字。激活态：`--nav-on-ink` + 底部 2px `--nav-on-bar` 条 |
| `.topnav .links a .ic` | **`display: none`** —— nav.js 仍注入 svg，CSS 隐藏（省 ~126px 横向预算，768px 平板靠它不溢出） |
| `.spacer` | `flex: 1` |
| `.navbadge` / `.badge-dot` | 「在办 9 · 收件箱 2」计数角标 |
| **`.skins` / `.sk`** | **皮肤切换器 = 顶栏「主题切换」本体。** 三键 `pro / paper / jade`，`data-skin-value` 属性，`aria-pressed` + `.on` 标激活。宽度与字体锁死（`font: 500 12px/1 var(--sans)`）→ 切皮肤时自身零位移。**auto 不占键位**（由「未设置 data-skin」表达，切到 auto 走 profile 页皮肤卡） |
| `.iconbtn` | 32×32（<768px: 44×44），hover 转红——退出按钮 |
| `.theme-toggle` | **兼容位**（旧单键主题按钮），样式不塌即可，新页面不要用 |
| `.hamburger` / `.nav-dropdown` | <768px 显示；下拉每项 `min-height: 44px` |

### A-3 页壳 / 页头

`.page`（`max-width: --w-page`）· `.wrap`（`--w-read`）· `.pagehead` · `.page-title`（`.date` / `.wk` / `.mid`）· `.page-sub`。高频写入口页可加 `.pagehead.with-cta` + `.pagehead-cta`：桌面按“标题 / 说明 / 主动作”一行排，移动端保持标题与主动作在前、说明独占下一行；仍是共享层 A 骨架。

### A-4 双栏工作台

`.workbench`（`grid-template-columns: minmax(0,1fr) var(--w-right)`）· `.col`
≤1180px 塌为单列。

### A-5 面板 / 卡

| class | 说明 |
|---|---|
| `.panel` | **全出血面板**（子块自带 padding，跑道行/列表行贴边），`overflow: hidden` |
| `.card` | 带内边距的传统卡（旧页面沿用；`.card.chart-card` 依赖它） |
| `.panel-body` | 面板内容区 `12px 14px` |
| `.p-head` / `.p-title` / `a.p-title` / `.p-meta` / `.p-foot` | 面板栏头 / 标题（12px, `.09em`, **恒 sans**）/ 右侧元信息 / 脚 |
| `.p-foot b` `.p-foot .num` | 记账层级：标签灰、数字墨 |
| `.fee-case-panel` / `.fee-case-summary` | 费用页非 active 案件的原生 `<details>`；默认折叠，summary 必须保留“展开/收起”文字与可见焦点，不能只剩颜色或无标记热区 |
| `.card > h2` | 旧骨架卡标题（JS 会 prepend 一枚 `svg.ic`，已降权到 15px） |
| `.count` / `.section-empty` | 标题后计数 / 空态 |

### A-6 通用元件

`.chip`（`.mono` / `.c-red` / `.c-amber` / `.c-blue` / `.c-green`；`a.chip` 可点）
`.dot`（`.red` / `.amber` / `.green` / `.blue` / `.gray` + 别名 `.dot-critical` `.dot-high` `.dot-normal` `.dot-event` `.dot-task`）· `.nodot`
`.pill`（`.crit` / `.warn` / `.ok` / `.acc`——JS 用空格分隔复合类写法，**必须写成 `.pill.crit`**）
**`.kbd`** 键盘提示 chip —— **只在真实实现了该快捷键时才用**（当前 JS 无快捷键，默认不要用）

### A-7 期限跑道（v5 的母题）

5 列 grid：`92px | minmax(0,1fr) | 200px | 84px | auto`
**子元素用显式 `grid-column` 定位——源顺序无关。** 这样 `charts.js` 的旧结构（`.rw-label` / `.rw-track` / `.rw-days` / `.rw-due` / `.rw-done`）与新结构（`.rw-days` / `.rw-main` / `.rw-trk` / `.rw-due` / `.rw-key`）落在同一套列里，都不会错位。

| class | 说明 |
|---|---|
| `.runway` / `.rw-colhead` | 容器 / 列头 |
| **`.rw-lead`** | **头条区**（源自方向 C）。`.hd-kick`（12px 字冠）/ `.hd-num`（`.w` 20px + **`.n` 56px**）/ `.hd-deck`（28px **恒衬线**案由）/ `.hd-rule`（64×2px 翡翠下划线）/ `.hd-meta` |
| `.rw-lead.amb` | 琥珀调头条（尚未逾期但最紧的一条） |
| `.rw-lead.ok` | **冷静态**（最近死线 >7 日）：整块脱红，走**令牌重映射**（`--hd-bg` → `--surface-2` 等），`.rw-lead` 的 `background`/`box-shadow` 原式一字不动。`--hd-rule` 不重映射——那条翡翠绿下划线留着，它正是「已清场」的签名 |
| `.rw-row`（`.d1` / `.d2` / `.d3`；`.amb` / `.crit`） | 紧凑跑道行，字号梯度 24/20/16；逾期 / 临期行分别用 `--red-bg` / `--amber-bg` 整行强调 |
| `.rw-days`（`.pre` / `.n` / `.u`） | 剩余天数列 |
| `.rw-main`（`.m1` / `.m2`） | 事项列 |
| **`.rw-trk` / `.trk`**（源自方向 A） | **时间轴条**：外盒 178px、内容盒 176px；16 日刻度（逾期 2 日 + 未来 14 日），`.trk-origin` 今日原点 = `left: 12.5%`，刻度按 11px 固定步长绘制 |
| `.trk-fill`（`.over` / `.crit` / `.warn` / `.ok`） | 四档填充。**基类必须自带底色**（`--fill-ok`）：`today.js bandOf()` 发四档，缺 `.crit` 时红档条整条透明不可见（v2.0 回归，勿删） |
| `.trk-dot`（`.crit` / `.warn` / `.ok`） | 死线端点 |
| `.rw-track` / `.rw-fill` / `.rw-flag` | `charts.js` 旧结构的条（双轨并存） |
| `.rw-due` / `.rw-key` / `.rw-done` / `.rw-acts` | 到期日 / 键位 / 完成勾 / 改期+完成双键位（flex 纵向叠放，断档规则与 `.rw-done` 同列） |
| `.rw-legend` / `.lg`（`.lg-crit` `.lg-warn` `.lg-ok` `.lg-event` `.lg-task`） | 图例（跑道 / 14 日带 / 费用条 / 日历共用） |

### A-8 未来 14 日刻度格

`.strip`（7 列 grid，14 个格自动流成 7×2）· `.strip-day` · `.strip-dow` · `.strip-num` · `.strip-dots` · `.strip-weekend` · `.strip-today`

### A-9 KPI

`.tiles` / `.tile`（`.tile-v` / `.tile-l` / `.tile-crit` / `.tile-warn` / `.tile-good` / **`.is-zero`** 0 值降权）
`.kpi-row`（`.k` / `.v` / `.v b` / `.vn` / `.alert`）—— 右栏紧凑清单版

**A-9a 费用总账抬头：** 费用页不用 `.tiles` 平铺全部金额。`.fee-context-header` 粘在顶栏下方，`.fee-ledger` 左侧只放一个 56px `.fee-ledger-value`（全期总账净额）与单行 `律师费已收 − 应付分成 + 应收分成`；右侧 `.fee-chase` 用 30px 已到期金额与最急案件回答“要追哪笔钱”。`.fee-signals` 退到右栏，只承载待收、已到期、放弃/减免、金额待定四行，0 值走 `--faint`。总账抬头与信号层都只使用现有表面、文字和状态令牌。

### A-10 ~ A-13 列表行族

`.row`（`.grow` / `.meta` / `.days-left`）· `.inb-row`（`.inb-q` / `.inb-src` / `.inb-acts`）· `.todo-row`（`.ck` / `.box` / `.t-text` / `.t-chips` / `.t-key`）· `.hear`（`.hear-when` / `.hear-court` / `.hear-name` / `.hear-no` / `.hear-tags`）· `.pay-row` · `.gap-row`（`.gap-act`）

### A-14 按钮 / 表单

`.btn`（`.small` / `.primary` / `.ok` / `.danger` / `:disabled`）· `input` / `select` / `textarea` / `input[type=file]::file-selector-button`（两个前缀**必须分开写**，合并成选择器列表时任一浏览器不认就整条规则被丢弃）· `label.f` · `.formgrid` · `.formrow`（`.grow`）· `details.adder`

### A-15 ~ A-18

`.group-title`（尾随横规则）· `.case-grid` / `.case-card`（`.cname` / `.cmeta` / `.cmeta .case` / `.cfoot`）· `.ministep` / `.mini-dot`（`.md-done` / `.md-cur` / `.md-todo`）
`.stepper` / `.stepper-vertical` / `.step`（`.step-dot` / `.step-name` / `.step-link` / `.step-done` / `.step-cur` / `.step-todo`）
`.timeline` / `.timeline-filters` / `.timeline-filter` / `.tl-item` / `.tl-node`（`-event` / `-log` / `-crit` / `-warn` / `-ok` / `-muted`）/ `.tl-date` / `.tl-body` / `.tl-note` / `.tl-actions`
`.feebar-wrap` / `.feebar` / `.fee-paid` / `.fee-unpaid` / `.fee-legend`

**A-18a 费用明细信息层级：** `.fee-items` 下每笔款项用 `.fee-item-block` 成组；`.fee-item` 固定按「款项事实 / 收款条件 / 分成与结算」三列阅读，分别使用 `.fee-item-main`、`.fee-item-terms`、`.fee-item-settlement`。标签、金额、条件与备注使用 `.fee-item-label`、`.fee-item-amount`、`.fee-item-kicker`、`.fee-item-node`、`.fee-item-note`；实际台账另起 `.fee-share-result` 结果带，内部为 `.fee-share-kicker`、`.fee-share-main`、`.fee-share-party`、`.fee-share-amount`。结果金额必须与方向、对象、状态连续左排，不得推到行尾，也不得再混回操作按钮行。带 snapshot 的结果可在尾部放 `.fee-share-audit`“怎么算的”文字按钮，必须直接展开命中的历史 run；人工直记只标来源，不伪造入口。结算组件把预案 chip 与动作拆成 `.settlement-plan-chips` / `.settlement-action-buttons` 两组，但仍共享同一业务入口。

**A-18c 费用查账 disclosure：** `.share-settled-group` 把合作人本年已结行收进只读 disclosure，summary 使用 `.share-settled-summary`，内部 `.share-settled-list` 只渲染事实，不得出现改月份、删除或再次结清动作。正负冲抵后合计为 0 时，只要确有 settled 行仍须显示；是否展开不能靠金额非零判断。

**A-18b 文件解析状态与候选：** 文件仍复用 `.row` 骨架，增加 `.file-row` / `.file-name` / `.file-meta` / `.file-actions`；`.file-sync` 用「圆点 + 文案 + 语义色」双编码 `idle | work | review | ready | fail`，处理中圆点可脉冲且必须服从 `prefers-reduced-motion`。候选区 `.file-review` 是文件面板内部的派生层，不另起页面；`.extract-card` 按 `.extract-head → .extract-main/.extract-detail → .extract-quote → .extract-actions` 排列，页码/路径必须紧邻类型，原文引用必须先于确认按钮。三皮肤只通过既有状态/表面令牌变材质，所有 border 仍为 1px。

**A-18d 款项凭证：** `.fee-item-vouchers` 紧跟款项三列与分成结果带，使用 `.voucher-label`、`.voucher-files`、`.voucher-chip`、`.voucher-add`、`.voucher-tail`。chip 内图标必须复用 `icons.js` 的文件类型派发；`share_sheet` 使用琥珀语义描边，missing 同时显示红色文案与不可点击状态。解除关联只移除指针；上传和拖入目标均为案件夹 `财务凭证/`。

### A-19 月历

`.cal-head` / `.cal-hint` / `.cal-sheet` / `.cal-grid`（7 列，星期头 `#dow` 用）/ `.cal-dow` / `.cal-weeks`（月格容器，持 `--cal-lane-h`）/ `.cal-week`（周行，7 列车道舞台）/ `.cal-cell`（`.other` / `.weekend` / `.holiday` / `.workday` / `.today` / `.is-drop-target` / `.edge-drop-target`）/ `.cal-daynum`（`.is-today` / `.other`）/ `.cal-day-chips` / `.cal-chip`（`.cal-chip-label`、`.crit` / `.warn` / `.hearing` / `.task` / `.done` / `.dragging`）/ `.cal-span`（`.task-span` / `.start` / `.end` / `.continued-start` / `.continued-end` / `.done` / `.dragging`）/ `.cal-span-label` / `.cal-span-handle`（`.start` / `.end`）/ `.cal-more`（`.cal-more-collapse`）/ `body.cal-dragging` / `.cal-bottom` / `.cal-legend` / `.cal-tray` / `.unplanned-list` / `.unplanned-item`（`.dragging` / `.is-picked`）/ `.unplanned-dot` / `.task-modal-date-control` / `.task-date-step`

- **`.cal-cell` 禁 blur（性能红线）。**
- `.cal-chip` 是只读虚线胶囊：用 `.cal-chip-label` 包住文字以保证 flex 下仍能省略；期限 / 开庭的 ◆ ▲ ■ 形状分别走 `--red-dot` / `--amber-dot` / `--blue-dot`，不挂 `pointerdown`。单日待办 `.cal-chip.task` 例外复用浮起长条材质；完成态用 ✓、灰显划线。
- 未排期托盘只收 `status=open && due_on=''`；条目桌面端可拖到真实日期格，月外日期格用于 650ms 自动翻月，月格外才不处理 drop；手机端点条目进入 `.is-picked`，再点日期格排到当天。
- `.unplanned-dot` 与 `.cal-chip.task` 左边条共用 `--case-color`：有案件按 `(case_id % 6) + 1` 取 `--chart-1..6`，无案件回退 `--gray-dot`；不增加皮肤专属色。
- **车道布局（长条连贯的根本）**：月格容器 `.cal-sheet` 把星期头与 `.cal-weeks` 收进同一张连续 sheet；`.cal-weeks` 每周一行 `.cal-week`，行模板由 JS 逐周写成 `auto <车道数×--cal-lane-h> 1fr` —— 第 1 行 `.cal-daynum`、中间行车道长条、末行 `.cal-day-chips`；`.cal-cell` 占 `grid-row: 1 / -1` 只当背景、边框与拖拽命中面。同一任务在同一周行内因此恒占同一水平车道，**不再随各格 chip 数量高低错落**（这是前两批「长条断开」的根因）。`--cal-lane-h` = `29px`（桌面/移动一致），无车道行最小高 74px，有车道或 chip 行最小高 68px。桌面每周最多展示 3 条车道，超出折为 `.cal-more`，移动端最多展示 2 条；展开/收起只用已缓存数据重画，不发请求。
- `.cal-span` **同一周行内一段就是一个元素**（`grid-column` 跨列），不再逐格拼接；同周多条按起点贪心分车道，互不叠压。真端点所在段才给 `.start` / `.end`（圆角 + 把手）；被周界/月界切断的那头是 `.continued-start` / `.continued-end`（**方角 = 还没完**）。标题每个周行段各写一次（跨周时后续行不再是空白长条）。案件色走 `--case-color` 的渐变与 `inset box-shadow`，粗线不扩展 border；`.cal-span-handle` 仅桌面且仅当前月可见端点存在，热区 `16px` 宽，静态刻痕常显，hover / focus 只加长刻痕（border 恒 1px 铁律）。浮起阴影只使用皮肤令牌 `--raise` / `--span-sh`，不新增色值。
- **拖拽只有 Pointer Events 一套实现**（🔴 不许再引入 HTML5 原生 DnD）：两套并存时原生 `dragstart` 会让浏览器补发 `pointercancel` 清空 Pointer 状态，`dragover` 随即静默 return、`drop` 根本不触发。所有可拖元素显式 `draggable="false"`。条身 / 单日待办 chip / 托盘条目拖动 = **整体平移排期**（跨度不变）；端点把手 = 缩放起止；期限 / 开庭 chip 与 done/dropped 待办永不可拖；触屏与 <768px 只点选弹窗。拖动中目标格 `.is-drop-target` / `.edge-drop-target`（inset 焦点线），源元素 `.dragging` 半透明，`body.cal-dragging` 全局掐掉文本选中。
- `due_time` 文案前缀为 `HH:MM`；同日待办按有时刻优先、再按时刻排序。`.cal-cell` 仍永久禁用 `backdrop-filter`，长条连接不得引入新色值。

### A-20 图表（stats 页，SVG/DOM 手写）

`.chart-card` / `.chart-title` / `.chart-area` / `.chart-legend`（`.lg.c1`…`.c6`）/ `.chart-side`
`.donut` / `.donut-center` · `.bar-chart` / `.bar-col` / `.bar`（基类自带 `--chart-1` 底色 + `.c1`…`.c6` 修饰符）/ `.bar-label` / `.bar-val` · `.line-chart`（`.axis-label` / `.grid-line`）/ `.chart-axis` · `.gauge` / `.gauge-center` / `.gauge-grad-a|b`（SVG `<stop class>`）· `.progress-track` / `.progress-fill`（`.ok` / `.warn` / `.crit`）/ `.prog-row` / `.num`

**图表色板（6 序列）：**

| # | pro | paper | jade |
|---|---|---|---|
| `--chart-1` | `#0E7A56` | `#0E7A56` | `#4FD6A4` |
| `--chart-2` | `#0891B2` | `#1F6F78` | `#2FA0B4` |
| `--chart-3` | `#1D4ED8` | `#23538F` | `#5C88DC` |
| `--chart-4` | `#B45309` | `#C2410C` | `#E0A45C` |
| `--chart-5` | `#6B7280` | `#6E675E` | `#9AA8A0` |
| `--chart-6` | `#B42318` | `#B42318` | `#E4685C` |

> 第 5 序列是**中性灰**，不是 v4 的紫色（`#7C3AED`）——反 slop 硬约束禁紫渐变。

### A-21 设置 / 用户中心

`.settings-section` / `.settings-row`（`.label` / `.desc`）/ `.set-ctl`（**钉死 `width: min(240px,100%)`**：`.num` 走 `--f-num`，字宽随皮肤变，自适应会造成跨皮肤位移）
**`.theme-cards` / `.theme-card`**（`.selected` + `data-skin-value`，JS 读写；同时兼容旧属性 `data-theme-value`）
`.swatch`（`.sw-pro` / `.sw-paper` / `.sw-jade` / `.sw-auto`）—— 皮肤色卡小样，**层 A 唯一的硬编码色**（它是内容不是主题化 UI，见 §1.2）
`.contact-card` / `.role-pill`

### A-22 ~ A-26

`.quickbar`（产品灵魂，`position: fixed; bottom: 0`，`nav.js` 注入 `> form`）/ `.qbin` / `.hint`（≥1100px 才显示）
`#toast` · `.dmodal-overlay` / `.dmodal`（`dateedit.js`、`calendar-task-modal.js` 与 `fee-settlement.js` 运行时 append）· `.task-modal-case` / `.task-modal-dates`（计划日 / 到期日 / 截止时刻）/ `.task-modal-note` / `.task-modal-actions` · `.login-wrap` / `.login-card` / `.login-err` · 滚动条（`::-webkit-scrollbar`）

**A-24 弹层无障碍契约：** `.dmodal` 必须是有可访问名称的 `role="dialog"` + `aria-modal="true"`；打开时只把本弹层以外、此前未 inert 的 `body` 直属节点设为 `inert`，关闭时精确恢复。Tab / Shift+Tab 在当前最上层弹层内循环；Escape 与点击遮罩关闭；关闭后把焦点归还仍在文档中的触发元素。嵌套弹层按栈处理，内层不得解除外层原本 inert 的页面。移动端弹层里的 input/select/textarea 与 disclosure summary 均以 44px 为最低可操作高度。

**A-24a 分成计划/公式/结算弹层：** `.dmodal.settlement-modal` 只扩展共享弹层宽高与滚动；内部使用 `.settlement-step`、`.settlement-plan-row`、`.settlement-formula-grid`、`.settlement-deduction-row`、`.settlement-trace-row`、`.settlement-history-item` 等层 A 骨架类。案件页约定管理另用 `.settlement-agreement-group` / `.settlement-agreement-group-head` 把“我应收 / 我应付”分组，应收置前；分组仍在同一 `.panel` 内，不能嵌套面板材质。计算 trace 行不是 `.panel`，避免 jade 重复叠加 blur。所有颜色、表面、边框色、阴影仍只取令牌；边框恒 1px，未决强调使用 `inset box-shadow`，不推动内容。

---

## 11. 响应式断点

| 断点 | 变化 |
|---|---|
| **≥1900px** | `--page-pad: 32px` |
| **≥1280px** | `--page-pad: 24px`，全布局 |
| **≤1279px** | `--w-right: 340px`（右栏收窄） |
| **≤1180px** | `.workbench` / `.case-layout` / `.fee-layout` 塌为单列；案件与费用的粘性抬头保留，参考事实栏排到主工作流之后；`.pagehead .page-sub` 换行占满 |
| **≤1100px** | `.quickbar .hint` 隐藏 |
| **≤1023px** | 顶栏横向预算收紧：`.topnav { gap: 10px }`、`.links a { padding: 0 8px }`、`.brand .ver` 隐藏、`.sk { min-width: 40px }`（不收的话 768px 处「退出」按钮会被挤出视口） |
| **≤980px** | **跑道砍掉时间轴条列**：`grid-template-columns: 96px minmax(0,1fr) 78px 56px`，`.rw-trk` / `.rw-track` `display: none`，`.rw-due` → 第 3 列、`.rw-key` → 第 4 列；费用明细收为两列，`.fee-item-settlement` 独占下一行 |
| **≤767px** | 见下 |

**移动端（<768px）全表：**

| 项 | 变化 |
|---|---|
| 尺度 | `--gap: 12px`，`--page-pad: 16px`，`body { font-size: 14px }` |
| 顶栏 | `.links` / `.navbadge.counts` 隐藏 → `.hamburger` + `.nav-dropdown` |
| 触控目标 | `.iconbtn` / `.hamburger` / `.theme-toggle` → **44×44**；`.btn`（含 `.small`）`min-height: 44px`；`.skins { height: 36px }`；`.sk { min-width: 38px }` |
| 跑道 | **两行化**：`72px \| 1fr \| auto`，剩余天数跨两行；`.rw-colhead` / `.rw-key` 隐藏；`.rw-days` 允许换行（`flex-wrap: wrap`） |
| 字号 | `.hd-num .n` → 48px；`.hd-deck` → 22px；`.rw-row.d1 .rw-days .n` → 22px |
| 网格 | `.tiles` → `minmax(128px, 1fr)`；`.case-grid` / `.formgrid` / `.theme-cards` → 单列；`.cal-sheet` 保持连续边框；`.cal-grid` / `.cal-weeks` / `.cal-week` 的 gap 为 0；`--cal-lane-h: 29px`；`.cal-cell { min-height: 0 }`，高度由 `.cal-week` 的 68/74px 最小高承接 |
| 图表 | `.donut-wrap` / `.gauge-wrap` 纵向；`.bar-chart { height: 140px }` |
| **换行兜底** | `.todo-row` / `.pay-row` / `.inb-row` / `.tl-item` **必须 `flex-wrap: wrap`** —— 否则操作按钮溢出行盒、被 `.panel { overflow: hidden }` 裁掉，390px 下点不到（实测） |
| 费用明细 | `.fee-item` 改为单列；三段之间用 1px 横线保持顺序，`.fee-share-result` 纵向展开，金额与方向/对象/状态保持连续左排；案级 `.p-foot` 固定两列，避免 `--f-num` 字宽令三皮肤换行不同；按钮继续遵守 44px 触控尺度 |
| 粘性抬头 | `.case-context-header` 主区单列；费用标题与“记款项”保持一行；分区锚点横滑，案件/费用焦点动作 ≥44px |
| 款项凭证 | `.fee-item-vouchers` 纵向；chip 与解除按钮 ≥44px；`.voucher-add` 全宽 44px，允许相机/文件选择 |
| 费用总账 | `.fee-ledger` 改为单列；等式以紧凑无换行形式保留运算顺序，净额 48px，主净额始终先于经营信号 |
| 分成弹层 | `.settlement-plan-fields` / `.settlement-formula-grid` / `.settlement-request-form` / `.settlement-amounts` 改单列；扣费、公式版本、trace 行按语义纵向展开，禁止水平滚动；操作组保持可换行、按钮触控尺度沿用全站规则 |

---

## 12. 皮肤切换实现规范

### 12.1 属性方案

```html
<html data-skin="pro">    <!-- 或 paper / jade -->
<html>                    <!-- 无属性 = auto，跟随 OS -->
```

| 状态 | DOM | CSS 命中 |
|---|---|---|
| pro | `data-skin="pro"` | `:root, [data-skin="pro"]` |
| paper | `data-skin="paper"` | `[data-skin="paper"]` |
| jade | `data-skin="jade"` | `[data-skin="jade"]` |
| auto + OS 亮 | **无属性** | `:root`（= pro 令牌） |
| auto + OS 暗 | **无属性** | `@media (prefers-color-scheme: dark) { :root:not([data-skin="pro"]):not([data-skin="paper"]):not([data-skin="jade"]) }` |

### 12.2 状态机（`public/js/skin.js`）

```js
const KEY = 'anjian-skin';        // 新键
const OLD_KEY = 'anjian-theme';   // v4 旧键，读到即迁移并删除
export const SKINS = ['pro', 'paper', 'jade', 'auto'];
const LEGACY = { light: 'pro', dark: 'jade', auto: 'auto' };   // 旧三态 → 新皮肤
```

导出 API：`getSkin()`（偏好）· `getResolvedSkin()`（落地生效值，auto → 跟随 OS）· `setSkin(v)`（写盘 + 300ms 过渡 + 落地）· `initSkinSwitcher(container)`

**JS 只负责 CSS 够不着的三件事**（换肤本体是 CSS 的活）：
1. `meta[name=theme-color]` → 各皮肤 `--bg-base`（`pro: #F6F7F8` / `paper: #F4EFE3` / `jade: #050D0A`）
2. `documentElement.style.colorScheme` → `auto: 'light dark'` / jade: `'dark'` / 其余 `'light'`。**不设的话 jade 暗底上会弹出亮色系统日期选择器**（快录条的 `<input type=date>`）
3. 切换器 UI 高亮

**切换器高亮的两套规则（有意为之）：**
- 顶栏 `.sk` 三键 → 按 **resolved** 高亮（auto 时没有第四个键位，点亮「当前实际生效」的那枚才诚实；title 追加「（当前跟随系统）」）
- profile `.theme-card` → 按 **pref** 高亮（那里有 auto 卡，选的是偏好本身）

**健壮性：** `localStorage` 在隐私模式下会抛 → 全部 `try/catch`（皮肤是装饰，绝不能因此炸掉整页）。脏值（`"undefined"` / 直写的 `light|dark`）一律回落 `auto`，杜绝 `data-skin="light"` 这种非法值。
`storage` 事件监听 → 跨标签页同步。`matchMedia('(prefers-color-scheme: dark)')` 的 `change` 监听 → auto 时实时跟随。

### 12.3 FOUC 防闪烁（9 页 `<head>` 内联脚本，CSS `<link>` 之前）

与 `skin.js` **同逻辑、幂等**（谁先跑都得到同一结果）：读键 → 迁移旧键 → 校验 → 设 `data-skin`（auto 则 `removeAttribute`）→ 设 `colorScheme` → 设 `theme-color`。

已确认 9 页（index / cases / case / calendar / fees / share-repairs / stats / profile / login）**全部包含**该脚本。

### 12.4 已废弃

`public/js/theme.js` 已删除；旧 API 不再提供。**新代码一律 `import { setSkin, getSkin, initSkinSwitcher } from './skin.js'`。**

---

## 13. 可访问性检查清单

### 13.1 文字对比度（各皮肤在自身 `--bg-base` 上实算）

| 令牌 | pro | paper | jade | AA 4.5:1 |
|---|---|---|---|---|
| `--ink`（正文） | 16.6:1 | 14.7:1 | 15.3:1 | ✓ |
| `--ink-2` | 9.1:1 | 8.1:1 | 11.6:1 | ✓ |
| `--muted` | 6.4:1 | 4.9:1 | 8.8:1 | ✓ |
| `--meta`（元信息下限） | 4.9:1 | 5.2:1 | 6.6:1 | ✓ |
| `--green` | 5.3:1 | — | 9.8:1 | ✓ |
| `--red` | 6.6:1 | — | 5.5:1 | ✓ |
| `--amber` | 4.9:1 | 4.8:1 | 8.3:1 | ✓ |
| `--blue` | 7.0:1 | — | 5.2:1 | ✓ |
| `--faint` | **仅装饰** | **仅装饰** | **仅装饰** | ✗ **禁作正文** |

> **v5 相对 v4 的关键改善：** v4 的 `--st-warn` (3.9:1) / `--st-crit` (3.6:1) 达不到 AA、只能当大字用；
> v5 三皮肤的状态色**全部 ≥4.8:1**，可直接作小字文字色。
> **`--faint` 是唯一的禁区：仅用于分隔线与 0 值降权，永不作正文。** 元信息一律用 `--meta`（已是最浅的合规档）。

### 13.2 硬底线（SPEC §4）

| 项 | 标准 | 状态 |
|---|---|---|
| 正文字号 | ≥14px | ✓ `--fs-body: 14px` |
| 标签 / 注释字号 | ≥12px | ✓ 全表下限 12px（`.cal-daynum` / `.step-name` 的 11.5px 与 `.strip-dow` 的 11px 为纯装饰性数字/图例） |
| 正文对比度 | ≥4.5:1 | ✓ 见 13.1 |
| 数字 | `tabular-nums` | ✓ 全局 `body` 一次性设定 |
| 中文引号 | 「」 | ✓ |
| 反 slop | 禁紫渐变 / 禁 emoji 作图标 / 禁每标题配 icon | ✓ `--chart-5` 改中性灰；面板标题纯文字 |

### 13.3 focus-visible

```css
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
input:focus, select:focus, textarea:focus { outline: 2px solid var(--focus); outline-offset: 0; border-color: transparent; }
.ck input:focus-visible + .box { outline: 2px solid var(--focus); outline-offset: 2px; }
```
`--focus` 三皮肤均为品牌绿（pro/paper `#0E7A56`，jade `#4FD6A4`）——**paper 也不例外**：可访问性优先于「绿只占两处签名位」的纯度。

### 13.4 触控目标（<768px）

| 元素 | 尺寸 |
|---|---|
| `.iconbtn` / `.hamburger` / `.theme-toggle` | 44×44 ✓ |
| `.btn` | `min-height: 44px` ✓ |
| `.nav-dropdown a` | `min-height: 44px` ✓ |
| `.cal-cell` | `min-height: 64px` ✓ |
| 弹层 input / select / textarea / disclosure summary | `min-height: 44px` ✓ |
| `.skins` | `height: 36px`（三键横排，单键 ≥38px 宽）⚠ 略低于 44 但为顶栏空间妥协 |

### 13.5 状态色不只靠颜色传达

| 双编码 | 实现 |
|---|---|
| 逾期 | 红 + **斜纹填充**（`--fill-over` 是 `repeating-linear-gradient`，非色盲用户也能辨） + 文案「逾期 N 天」 |
| 临期 / 正常 | 琥珀 / 绿 + **数字本身**（剩 N 天） + 跑道条**长度** |
| 开庭 | 蓝 + `.cal-chip.hearing` **加粗** + 文案 |
| 完成 | 绿 + **删除线**（`.todo-row:has(input:checked) .t-text`） |

### 13.6 降级

`prefers-reduced-motion` / `prefers-reduced-transparency` —— 见 §9.3。

---

## 附录 A：CSS 变量速查

**全部值以 `public/css/style.css` 为准。** 本附录只列骨架层原料（三皮肤共用）；三套皮肤的完整令牌见 §2.2 / §2.3 / §2.4，或直接按 CSS 的「层 B · 皮肤材质层」注释定位——那是唯一事实源，不在此重复以免二处失同步。

```css
/* 层 A · 骨架原料（皮肤禁改） */
:root {
  --sans: "Noto Sans SC", -apple-system, BlinkMacSystemFont, "PingFang SC", "MiSans",
          "Noto Sans CJK SC", "Helvetica Neue", "Segoe UI", "Microsoft YaHei", sans-serif;
  --mono: "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans SC", "PingFang SC", monospace;
  --serif: "Noto Serif SC", "Songti SC", "STSong", "Noto Serif CJK SC", "Times New Roman", "SimSun", serif;

  --h-top: 48px;      /* 顶栏高 */
  --h-qb: 60px;       /* 快录条基准高（三皮肤同高） */
  --w-page: 1400px;   /* 工作台页宽 */
  --w-read: 1180px;   /* 阅读型页宽 */
  --w-right: 404px;   /* 右栏宽 */
  --gap: 16px;
  --gap-s: 10px;
  --page-pad: 16px;   /* 唯一随断点缩放：16 / 20 / 24 / 32 */
  --fs-body: 14px;    /* 可访问性硬底线 */
}
```

**皮肤必须实现的槽位（缺一个就会 fallback 成空值 → 元素不可见）：**

```
底/表面  --bg-base --surface --surface-2 --surface-solid --surface-bar --surface-pop
         --head-bg --hover --ctl-bg --we-bg --sel --scrim
文本     --ink --ink-2 --muted --meta --faint
线       --border --border-h --line --rule
状态     --green --green-deep --green-bg --green-bg-h --green-line
         --red --red-dot --red-bg --red-line --red-soft-ink
         --amber --amber-dot --amber-bg --amber-line
         --blue --blue-dot --blue-bg --blue-line
         --teal --ok-dot --gray-dot
交互     --focus --link --link-h --on-solid
元件     --chip-bg --chip-bd --ck-bd --ck-bg --kbd-bg --kbd-bd --kbd-ink --kbd-sh
圆角     --r-panel --r-btn --r-chip --r-pill --r-seal
材质     --bf --atmo --grain --grain-img
阴影     --sh-panel --sh-top --sh-qb --sh-pop --sh-hover --btn-sh --cta-sh --dot-sh
         --head-rule --step-sh
字体角色 --f-num --f-case --f-quote --f-display
品牌     --seal-bg --seal-ink --seal-sh --pill-bg --pill-ink
         --nav-on-ink --nav-on-bg --nav-on-bar --sw-on-bg --sw-on-ink
头条     --hd-bg --hd-bg-h --hd-edge --hd-edge-ok --hd-ink --hd-meta --hd-rule
跑道     --trk-bg --trk-bd --trk-tick --fill-over --fill-crit --fill-warn --fill-ok
         --fill-ok-soft --fill-warn-soft --dot-ring
CTA      --cta-bg --cta-bg-h --cta-bd --cta-ink
今日     --today-bg --today-sh --today-ink
图表     --chart-1 --chart-2 --chart-3 --chart-4 --chart-5 --chart-6
```

**加第四个皮肤的清单：**
1. 在层 B 新增 `[data-skin="x"]`，把上表**全部**槽位填满。
2. `skin.js` 的 `SKINS` 数组加名字；`BG` 表加 `--bg-base` 值。
3. `nav.js` 的 `.skins` 三键加一键（注意顶栏横向预算，见 §11 的 ≤1023px 断点）。
4. 9 页 `<head>` FOUC 内联脚本的校验白名单加名字。
5. profile 页 `.theme-card` 加一张卡 + `.swatch` 加一个色卡（硬编码该皮肤自身的颜色）。
6. 跑 §1.6 验证：三皮肤零位移、总高一致。

---

## 附录 B：文档与实现的对应关系

| 文档章节 | 实现位置（`public/css/style.css`） |
|---|---|
| §1 皮肤架构 | 文件头说明 + `层 A · 共享骨架层` / `层 B · 皮肤材质层` 注释块 |
| §2.2 pro | `:root, [data-skin="pro"]` |
| §2.3 paper | `[data-skin="paper"]` |
| §2.4 jade | `[data-skin="jade"]` |
| §2.5 auto | `@media (prefers-color-scheme: dark)` 内的无 `data-skin` 分支 |
| §2.6 兼容别名 | 运行时已删除；本节仅保留历史映射对照 |
| §3 排版 | `A-0` + 各组件排版规则 |
| §4 间距尺度 | `A-0` |
| §7 弥散光 | `A-1` + jade 的 `--atmo` |
| §9.3 降级 | 文件末尾的「降级层」（**必须保持在末尾**，靠源顺序压住字面量 blur / transition） |
| §10 组件清单 | A-2 ~ A-26 |
| §11 响应式 | `A-27 响应式` |
| §12 皮肤切换 | `public/js/skin.js` + 9 页 `<head>` 内联脚本 |
