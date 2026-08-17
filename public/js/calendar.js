// 日历：月历网格 + 事件 chip + 跨天车道长条 + 假期标注。
// 🔴 性能红线：.cal-cell 单页可达 42 个 —— 任何皮肤都不给它上 backdrop-filter（见 css/style.css A-19）。
// DOM 契约：#dow 只填一次（常驻）；#grid 每次 load() 整体 replaceChildren 重建，重建单位是「周行」。
//   周行 .cal-week 是 7 列嵌套网格；日期格 / 日期数字 / 车道长条 / chip 堆都是它的同级网格项：
//   .cal-cell 占 grid-row 1/-1 当背景与命中面，.cal-daynum 占第 1 行，长条占车道行，.cal-day-chips 占末行。
//   —— 长条因此在整个周行里恒占同一水平车道，不再被格内 chip 数量顶得高低错落。
import { api, el, toast, todayStr, SEV_LABEL, STATUS_LABEL } from './api.js';
import { mountNav } from './nav.js';
import { openTaskModal } from './calendar-task-modal.js';
import { caseColorStyle } from './calendar-ui.js';
import { bindFold, foldOpen, setFoldOpen } from './fold.js';

// task 三态标签（api.js 的 STATUS_LABEL 是 deadline 专用四态，不混用）
const TASK_STATUS_LABEL = { open: '', done: '已完成', dropped: '已放弃' };

await mountNav();

const title = document.getElementById('cal-title');
const loadMeta = document.getElementById('cal-load');
const grid = document.getElementById('grid');
const trayList = document.getElementById('unplanned-list');
const trayCount = document.getElementById('unplanned-count');
const trayHint = document.querySelector('.cal-tray-hint');
const calHint = document.getElementById('cal-hint');
const tray = document.getElementById('cal-tray');
const taskLegend = document.querySelector('.cal-legend .lg-task');

// 星期头：加载时填一次，load() 不重建它
const dow = document.getElementById('dow');
for (const d of ['一', '二', '三', '四', '五', '六', '日']) dow.append(el('div', { class: 'cal-dow' }, d));

let current = todayStr().slice(0, 7); // YYYY-MM
let allTasks = [];
let calendarData = null;
let revealTaskId = null;
let pickedTaskId = null;
let flipT = null;
const expanded = new Set(); // 周行序号；翻月时由导航动作清空，普通重绘保留

const PRIORITY_LABEL = { high: '高优先', normal: '一般', low: '低优先' };

function taskPriorityClass(priority) {
  if (priority === 'high') return 'pill crit';
  if (priority === 'normal') return 'pill acc';
  return 'pill';
}

function isNarrow() {
  return window.matchMedia('(max-width: 767px)').matches;
}

bindFold(tray, 'calendar-tray', true);   // 托盘始终展开：桌面要拖、窄屏改事实条
let lastNarrow = isNarrow();

function syncResponsiveCopy() {
  const narrow = isNarrow();
  if (trayHint) trayHint.textContent = narrow ? '点选待办，再点日期格排到当天' : '开放待办拖到月格即可排到当天';
  if (calHint) calHint.textContent = narrow
    ? '点选待办，再点日期格排期；点开任务改日期'
    : '点开待办可改期或处理 · 托盘待办拖到日期格排期';
  if (taskLegend) taskLegend.textContent = narrow
    ? '待办（按案件配色，点开改期）'
    : '待办（按案件配色，可拖可拉伸）';
  // 窄屏：托盘改成事实条（始终展开，summary 不再是折叠触发器）
  // 桌面：托盘要拖，保持常显（open）
  setFoldOpen(tray, true, { persist: false });
  tray.classList.toggle('is-tray-strip', narrow);
  lastNarrow = narrow;
}

function clearPickedTask() {
  pickedTaskId = null;
  trayList.querySelectorAll('.unplanned-item.is-picked').forEach((item) => {
    item.classList.remove('is-picked');
    item.setAttribute('aria-pressed', 'false');
  });
}

function pickTask(task) {
  pickedTaskId = String(task.id);
  trayList.querySelectorAll('.unplanned-item').forEach((item) => {
    const picked = item.dataset.taskId === pickedTaskId;
    item.classList.toggle('is-picked', picked);
    item.setAttribute('aria-pressed', String(picked));
  });
}

// 弹层模块保持独立；窄屏日期步进器在弹层同步挂载，避免为一个纯视图控件扩展数据/路由。
function enhanceTaskModalDates() {
  if (!isNarrow()) return;
  const form = document.querySelector('.task-modal-form');
  if (!form) return;
  const plan = form.querySelector('input[aria-label="计划开工日"]');
  const due = form.querySelector('input[aria-label="硬到期日"]');
  for (const input of [plan, due]) {
    if (!input || input.closest('.task-modal-date-control')) continue;
    const label = input.closest('label.f');
    if (!label) continue;
    const control = el('span', { class: 'task-modal-date-control' });
    input.replaceWith(control);
    const step = (delta, symbol, action) => el('button', {
      class: 'task-date-step', type: 'button',
      'aria-label': `${action}${input.getAttribute('aria-label')}`,
      title: `${action}${input.getAttribute('aria-label')}`,
      onclick: (e) => {
        e.preventDefault(); e.stopPropagation();
        const seed = input.value || (input === plan ? due?.value : plan?.value) || todayStr();
        input.value = shiftDate(seed, delta);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      },
    }, symbol);
    control.append(input, step(-1, '−', '减少'), step(1, '+', '增加'));
  }
}

function openTask(task) {
  clearPickedTask();
  const modal = openTaskModal(task, {
    onChanged: async (updated) => {
      // 完成动作的即时反馈保留在当前月历一次渲染中，即使“已处理”图例当前关闭。
      if (updated.status === 'done') revealTaskId = updated.id;
      await load();
      revealTaskId = null;
    },
  });
  enhanceTaskModalDates();
  modal.catch((error) => {
    toast('❌ ' + error.message);
  });
}

// ── 拖拽：唯一实现是 Pointer Events ──
// 🔴 不许再引入 HTML5 原生 DnD（draggable / dragstart / dragover / drop）。实测事件链（见 PROGRESS 任务 0）：
//    两套系统共享拖拽状态时，原生 dragstart 会让浏览器补发 pointercancel，把 Pointer 那套的状态清空，
//    随后 dragover 的 guard 静默 return、不 preventDefault → drop 根本不触发 → 真手势下拖拽完全无效。
//    因此所有可拖元素显式 draggable="false"（<a> 默认能被浏览器原生拖走，不显式关掉就会复发）。
const DRAG_THRESHOLD = 6; // px：小于它算点击，不算拖
let drag = null;          // { task, mode:'move'|'edge', edge, el, pointerId, origin, grabDate, moved }
let clickGuardUntil = 0;  // 拖完那一下的 click 要吞掉；用时间窗而非布尔量，落点不在源元素时能自愈

function clickSuppressed() {
  return performance.now() < clickGuardUntil;
}

// 桌面且精确指针才拖：手机沿用点选弹窗（领导已定，不做触屏拖拽）
function canDrag() {
  return window.matchMedia('(min-width: 768px)').matches
    && !window.matchMedia('(pointer: coarse)').matches;
}

// 日期格现在是周行里的底层网格项，光标底下压着 daynum / 长条 / chip ——
// elementFromPoint 只给最上面那个，必须用 elementsFromPoint 穿透取格子。
function cellAt(x, y) {
  for (const node of document.elementsFromPoint(x, y)) {
    if (node instanceof HTMLElement && node.classList.contains('cal-cell') && node.dataset.date) return node;
  }
  return null;
}

function clearDropTargets() {
  grid.querySelectorAll('.cal-cell.is-drop-target, .cal-cell.edge-drop-target')
    .forEach((cell) => cell.classList.remove('is-drop-target', 'edge-drop-target'));
}

function clearFlipTimer() {
  clearTimeout(flipT);
  flipT = null;
}

function maybeFlipMonth(cell) {
  const date = cell?.dataset.date || '';
  if (!date) {
    clearFlipTimer();
    return;
  }
  const outside = date.slice(0, 7) !== current;
  if (!outside) {
    clearFlipTimer();
    return;
  }
  if (flipT) return;
  const dir = date > current ? 1 : -1;
  flipT = setTimeout(async () => {
    flipT = null;
    current = shiftMonth(current, dir);
    expanded.clear();
    await load();
  }, 650);
}

function beginDrag(spec, e) {
  if (!canDrag() || e.pointerType === 'touch' || e.button !== 0) return;
  if (!spec.task || spec.task.status !== 'open') return; // done / dropped 不可拖
  drag = {
    ...spec,
    el: e.currentTarget,
    pointerId: e.pointerId,
    origin: { x: e.clientX, y: e.clientY },
    grabDate: cellAt(e.clientX, e.clientY)?.dataset.date || '',
    // 月份自动翻页会重建 grid 内的原始节点；把捕获交给常驻根节点，
    // 让重绘后的 pointerup 仍能回到 finishDrag()。
    captureEl: grid,
    moved: false,
  };
  e.currentTarget.setPointerCapture?.(e.pointerId);
  try { drag.captureEl?.setPointerCapture?.(e.pointerId); } catch { /* pointer 已失效 */ }
}

function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.moved) {
    if (Math.hypot(e.clientX - drag.origin.x, e.clientY - drag.origin.y) < DRAG_THRESHOLD) return;
    drag.moved = true;
    drag.el?.classList.add('dragging');
    document.body.classList.add('cal-dragging');
  }
  clearDropTargets();
  const cell = cellAt(e.clientX, e.clientY);
  if (cell) {
    cell.classList.add(drag.mode === 'edge' ? 'edge-drop-target' : 'is-drop-target');
    maybeFlipMonth(cell);
  } else {
    clearFlipTimer();
  }
}

// commit=false 用于 pointercancel / Esc：清干净状态，一次 PATCH 都不发。
function finishDrag(e, commit) {
  clearFlipTimer();
  const d = drag;
  drag = null;
  if (!d) return;
  try { d.el?.releasePointerCapture?.(d.pointerId); } catch { /* pointer 已失效 */ }
  try { d.captureEl?.releasePointerCapture?.(d.pointerId); } catch { /* pointer 已失效 */ }
  d.el?.classList.remove('dragging');
  document.body.classList.remove('cal-dragging');
  clearDropTargets();
  if (!d.moved) return;
  clickGuardUntil = performance.now() + 300;
  if (!commit) return;
  const date = cellAt(e.clientX, e.clientY)?.dataset.date || '';
  if (!date) return; // 拖出网格 / 落在行首空白格 → 0 次 PATCH
  if (d.mode === 'edge') void moveTaskEdge(d.task, d.edge, date);
  else void moveTaskWhole(d.task, d.grabDate, date);
}

function shiftDate(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayDiff(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}

function monthEnd(ym) {
  const [year, month] = ym.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function taskLabel(task) {
  return task.due_time ? `${task.due_time} ${task.title}` : task.title;
}

// 条身 / 单日 chip / 托盘条目拖动 = 整体平移排期：跨度不变，两端同步移。
// 只有「本来就没有区间」的（托盘未排期、或缺 plan_date）才把两端一起钉到落点。
async function moveTaskWhole(task, grabDate, dropDate) {
  const live = allTasks.find((item) => String(item.id) === String(task.id)) || task;
  if (!live || live.status !== 'open' || !dropDate) return;
  let body;
  if (!live.plan_date || !live.due_on || !grabDate) {
    body = { plan_date: dropDate, due_on: dropDate };
  } else {
    const delta = dayDiff(grabDate, dropDate);
    if (!delta) return;
    body = { plan_date: shiftDate(live.plan_date, delta), due_on: shiftDate(live.due_on, delta) };
  }
  if (body.plan_date === live.plan_date && body.due_on === live.due_on) return;
  try {
    const updated = await api(`/tasks/${live.id}`, { method: 'PATCH', body });
    toast(updated.plan_date === updated.due_on
      ? `已排到 ${updated.due_on} ✓`
      : `排期已移到 ${updated.plan_date} 至 ${updated.due_on} ✓`);
    await load();
  } catch (error) {
    // api() gives HTTP errors a toast; retain an explicit fallback for non-HTTP failures.
    if (!error.status) toast('❌ 排期失败：' + error.message);
  }
}

async function moveTaskEdge(task, edge, date) {
  const live = allTasks.find((item) => String(item.id) === String(task.id)) || task;
  if (!live || live.status !== 'open' || !date || !['plan_date', 'due_on'].includes(edge)) return;
  if (live[edge] === date) return;
  try {
    const updated = await api(`/tasks/${live.id}`, { method: 'PATCH', body: { [edge]: date } });
    toast(`${edge === 'plan_date' ? '开工日' : '截止日'}已改为 ${updated[edge]} ✓`);
    await load();
  } catch (error) {
    // api() already gives HTTP failures a visible toast; retain a fallback for network/runtime failures.
    if (!error.status) toast('❌ 端点拖拽失败：' + error.message);
  }
}

function renderTray(tasks) {
  const unplanned = tasks.filter((task) => task.status === 'open' && !task.due_on);
  trayCount.textContent = unplanned.length ? `${unplanned.length} 条` : '';
  if (!unplanned.length) {
    trayList.replaceChildren(el('p', { class: 'cal-tray-empty' }, '所有开放待办都已排到日历上。'));
    return;
  }
  trayList.replaceChildren(...unplanned.map((task) => el('button', {
    class: `unplanned-item${String(task.id) === pickedTaskId ? ' is-picked' : ''}`, type: 'button',
    draggable: 'false', style: caseColorStyle(task.case_id),
    'data-task-id': String(task.id),
    'aria-label': `打开待办：${task.title}`,
    'aria-pressed': String(String(task.id) === pickedTaskId),
    onclick: () => {
      if (clickSuppressed()) return;
      if (isNarrow()) pickTask(task);
      else openTask(task);
    },
    onpointerdown: (e) => beginDrag({ task, mode: 'move' }, e),
  },
    el('span', { class: 'unplanned-dot', 'aria-hidden': 'true' }),
    el('strong', { class: 'unplanned-title' }, taskLabel(task)),
    el('span', { class: 'unplanned-case' }, task.case_name || '不挂案件'),
    el('span', { class: taskPriorityClass(task.priority) }, PRIORITY_LABEL[task.priority] || '一般')
  )));
}

function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

// severity / status → .cal-chip 修饰类。
// 两者正交：已处理的致命死线保留红边条，只是灰显划线（CSS 的 .done 是叠加态，不是互斥态）。
function chipClass(severity, status) {
  const c = ['cal-chip'];
  if (severity === 'critical') c.push('crit');
  else if (severity === 'high') c.push('warn');
  if (status !== 'pending') c.push('done');
  return c.join(' ');
}

// task chip 的 class —— 与 chipClass 同构：边条永远 .task，done/dropped 叠 .done 灰显。
function taskChipClass(status) {
  const c = ['cal-chip', 'task'];
  if (status !== 'open') c.push('done');
  return c.join(' ');
}

// 一个周行内的一段长条（seg = { task, from, to, c0, c1, lane }）。
// 真端点落在本段里才画 .start/.end 与把手；被周界/月界切断的那头是 .continued-*（方角 = 还没完）。
function taskSpanNode(seg, monthStart, monthLast) {
  const task = seg.task;
  const startVisible = task.plan_date === seg.from && task.plan_date >= monthStart;
  const endVisible = task.due_on === seg.to && task.due_on <= monthLast;
  const cls = ['cal-span', 'task-span'];
  cls.push(startVisible ? 'start' : 'continued-start');
  cls.push(endVisible ? 'end' : 'continued-end');
  if (task.status !== 'open') cls.push('done');
  const children = [el('span', { class: 'cal-span-label' }, taskLabel(task))];
  const draggableEdges = task.status === 'open' && canDrag();
  if (startVisible && draggableEdges) {
    children.push(el('button', {
      class: 'cal-span-handle start', type: 'button', draggable: 'false',
      'aria-label': `拖动${task.title}的计划开工日`,
      title: '拖动计划开工日',
      onpointerdown: (e) => { e.stopPropagation(); beginDrag({ task, mode: 'edge', edge: 'plan_date' }, e); },
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); },
    }));
  }
  if (endVisible && draggableEdges) {
    children.push(el('button', {
      class: 'cal-span-handle end', type: 'button', draggable: 'false',
      'aria-label': `拖动${task.title}的截止日`,
      title: '拖动截止日',
      onpointerdown: (e) => { e.stopPropagation(); beginDrag({ task, mode: 'edge', edge: 'due_on' }, e); },
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); },
    }));
  }
  return el('div', {
    class: cls.join(' '), role: 'button', tabindex: '0', draggable: 'false',
    style: `${caseColorStyle(task.case_id)};grid-column:${seg.c0 + 1}/${seg.c1 + 2};grid-row:${seg.lane + 2}`,
    title: `跨天待办 · ${taskLabel(task)} · ${task.plan_date} 至 ${task.due_on}`,
    'aria-label': `跨天待办：${taskLabel(task)}，${task.plan_date}至${task.due_on}`,
    onpointerdown: (e) => beginDrag({ task, mode: 'move' }, e),
    onclick: (e) => {
      if (clickSuppressed() || e.target.closest('.cal-span-handle')) return;
      openTask(task);
    },
    onkeydown: (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('.cal-span-handle')) {
        e.preventDefault(); openTask(task);
      }
    },
  }, children);
}

// ── 筛选器：图例即开关 ──
// 类型四档（致命 / 重要·一般 / 开庭 / 待办）默认开，「已处理」默认关 ——
// 与 deadlines 现有的「全状态返回、前端灰显」模式对齐：默认只看在追的，
// 想看历史就点亮「已处理」。
const FILTER_KEYS = ['crit', 'warn', 'hearing', 'task', 'done'];
const FILTER_DEFAULT = { crit: true, warn: true, hearing: true, task: true, done: false };
const FILTER_STORE = 'anjian-cal-filter';

// localStorage 在隐私模式 / 禁 Cookie 下会抛 —— 筛选是装饰，绝不炸整页（同 skin.js 惯例）
function readFilters() {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_STORE) || '{}');
    return { ...FILTER_DEFAULT, ...pick(raw) };
  } catch { return { ...FILTER_DEFAULT }; }
}
function writeFilters(f) {
  try { localStorage.setItem(FILTER_STORE, JSON.stringify(f)); } catch { /* noop */ }
}
function pick(obj) {
  const o = {};
  for (const k of FILTER_KEYS) if (typeof obj[k] === 'boolean') o[k] = obj[k];
  return o;
}
let filters = readFilters();

// 单条事项是否该画。两类维度正交：先过类型开关，再过「已处理」开关。
// 「已处理」= deadline.status !== 'pending' 或 task.status !== 'open'；开庭无 status，永不被它挡。
function visible(kind, item) {
  if (!filters[kind]) return false;
  if (kind === 'task' && item.id === revealTaskId) return true;
  const processed =
    (kind === 'crit' || kind === 'warn') ? item.status !== 'pending' :
    (kind === 'task') ? item.status !== 'open' : false;
  return !processed || filters.done;
}

async function load({ refresh = true } = {}) {
  if (refresh) {
    const [data, taskRows] = await Promise.all([
      api('/calendar?month=' + current),
      api('/tasks?status=all'),
    ]);
    calendarData = data;
    allTasks = taskRows;
  }
  if (!calendarData) return;
  const data = calendarData;
  const taskDetails = new Map(allTasks.map((task) => [task.id, task]));
  const monthTasks = data.tasks.map((task) => ({ ...task, ...(taskDetails.get(task.id) || {}) }));
  const today = todayStr();
  const [y, m] = current.split('-').map(Number);

  // 标题 = 月份本体；当前月挂「本月」标记（翻走即消失，与「今天」键呼应）
  // ⚠ replaceChildren 会把 null 转成字面量 "null" 文本节点（不像 el() 会跳过）——只能传真节点。
  const head = [el('span', { class: 'date' }, `${y} 年 ${String(m).padStart(2, '0')} 月`)];
  if (current === today.slice(0, 7)) head.push(el('span', { class: 'wk' }, '本月'));
  title.replaceChildren(...head);

  // 本月负荷：计数只算当前筛选可见的事项 —— 与格子显示保持一致。
  // 致命计数恒反映真实未处理量（不受 .crit 关闭影响）：它是安全警示，不是展示偏好。
  const vd = data.deadlines.filter((d) => visible(d.severity === 'critical' ? 'crit' : 'warn', d));
  const vh = filters.hearing ? data.hearings : [];
  const vt = monthTasks.filter((t) => visible('task', t));
  const critLeft = data.deadlines.filter((d) => d.status === 'pending' && d.severity === 'critical').length;
  const parts = [];
  if (vd.length) parts.push(el('span', { class: 'm' }, `期限 ${vd.length}`));
  if (vh.length) parts.push(el('span', { class: 'm' }, `开庭 ${vh.length}`));
  if (vt.length) parts.push(el('span', { class: 'm' }, `待办 ${vt.length}`));
  if (critLeft) parts.push(el('span', { class: 'm hot' }, `致命 ${critLeft}`));
  // 「·」做分隔符，插在相邻项之间
  const spaced = [];
  for (const p of parts) { if (spaced.length) spaced.push(el('span', {}, '·')); spaced.push(p); }
  loadMeta.replaceChildren(...(spaced.length ? spaced : [el('span', {}, '本月无排期')]));

  // 按日聚合 chip：期限 → 开庭 → 待办；同日有截止时刻的待办先排，并按 HH:MM 排序。
  // 跨天长条不进这里 —— 它按周行走车道，见下面的 ranges。
  const byDay = new Map();
  let pushSeq = 0;
  const push = (date, node, order = 0, time = '') => {
    if (!date) return;
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push({ node, order, time, seq: pushSeq++ });
  };
  for (const d of data.deadlines) {
    if (!visible(d.severity === 'critical' ? 'crit' : 'warn', d)) continue;
    const sev = SEV_LABEL[d.severity] || '';
    const st = d.status === 'pending' ? '' : ` · ${STATUS_LABEL[d.status] || d.status}`;
    // 事项名在前、案件在后 —— 与期限跑道 .rw-main 同一信息层级：格子窄，先保住「要做什么」。
    // 全文走 title 悬浮（格内必然截断）。
    // 期限 / 开庭是法定事实，永不可拖（安全铁律）：不挂 pointerdown，并显式关掉 <a> 的原生拖走。
      push(d.due_on, el('a', {
        class: chipClass(d.severity, d.status),
        href: `/case.html?id=${d.case_id}`,
        draggable: 'false',
        title: `${sev}期限 · ${d.name} · ${d.case_name}${st}`,
      }, el('span', { class: 'cal-chip-label' }, `${d.name}·${d.case_name}`)), 0);
  }
  for (const h of data.hearings) {
    if (!filters.hearing) continue;
    push(h.occurred_on, el('a', {
      class: 'cal-chip hearing',
      href: `/case.html?id=${h.case_id}`,
      draggable: 'false',
      title: `开庭 · ${h.case_name}${h.note ? ' · ' + h.note : ''}`,
    }, el('span', { class: 'cal-chip-label' }, `开庭·${h.case_name}`)), 1);
  }
  for (const t of monthTasks) {
    if (!visible('task', t)) continue;
    const hasRange = t.plan_date && t.due_on && t.plan_date < t.due_on;
    if (hasRange) continue;
    const st = TASK_STATUS_LABEL[t.status] ? ` · ${TASK_STATUS_LABEL[t.status]}` : '';
    const taskOrder = t.due_time ? 2 : 3;
    push(t.due_on, el('a', {
      class: taskChipClass(t.status),
      href: `#task-${t.id}`,
      draggable: 'false',
      style: caseColorStyle(t.case_id),
      title: `待办 · ${taskLabel(t)}${t.case_name ? ' · ' + t.case_name : ''}${st}`,
      onclick: (e) => { e.preventDefault(); if (!clickSuppressed()) openTask(t); },
      onpointerdown: (e) => beginDrag({ task: t, mode: 'move' }, e),
    }, el('span', { class: 'cal-chip-label' }, taskLabel(t))), taskOrder, t.due_time || '');
  }
  for (const entries of byDay.values()) {
    entries.sort((a, b) => a.order - b.order || a.time.localeCompare(b.time) || a.seq - b.seq);
  }

  // 跨天长条的本月可见区间；按起点排序，供每周行贪心分车道。
  const monthStart = `${current}-01`;
  const monthLast = monthEnd(current);
  const ranges = monthTasks
    .filter((t) => visible('task', t) && t.plan_date && t.due_on && t.plan_date < t.due_on)
    .map((t) => ({
      task: t,
      from: t.plan_date > monthStart ? t.plan_date : monthStart,
      to: t.due_on < monthLast ? t.due_on : monthLast,
    }))
    .filter((r) => r.from <= r.to)
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.task.id - b.task.id);

  // 月格（周一起始）：整体重建，单位是周行
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const slots = [];
  for (let i = lead; i > 0; i--) slots.push(shiftDate(`${current}-01`, -i));
  for (let day = 1; day <= daysInMonth; day++) slots.push(`${current}-${String(day).padStart(2, '0')}`);
  while (slots.length % 7) slots.push(shiftDate(monthLast, slots.length - (lead + daysInMonth) + 1));

  grid.replaceChildren();
  for (let w = 0; w * 7 < slots.length; w++) {
    const week = slots.slice(w * 7, w * 7 + 7);
    const dates = week.filter(Boolean);
    const weekStart = dates[0] || '';
    const weekEnd = dates[dates.length - 1] || '';

    // 本周行的长条段 + 贪心车道分配（ranges 已按 from 排序 → 车道内右端单调递增）
    const segs = [];
    if (weekStart) {
      for (const r of ranges) {
        const from = r.from > weekStart ? r.from : weekStart;
        const to = r.to < weekEnd ? r.to : weekEnd;
        if (from > to) continue;
        segs.push({ task: r.task, from, to, c0: week.indexOf(from), c1: week.indexOf(to), lane: 0 });
      }
    }
    const laneEnd = [];
    for (const seg of segs) {
      let lane = laneEnd.findIndex((end) => end < seg.c0);
      if (lane < 0) { lane = laneEnd.length; laneEnd.push(-1); }
      laneEnd[lane] = seg.c1;
      seg.lane = lane;
    }
    const total = laneEnd.length;
    const cap = window.matchMedia('(max-width: 767px)').matches ? 2 : 3;
    const open = expanded.has(w);
    const overflow = !open && total > cap;
    const visLanes = overflow ? cap - 1 : total;
    const hidden = Array(7).fill(0);
    if (overflow) {
      for (const seg of segs) {
        if (seg.lane < visLanes) continue;
        for (let i = seg.c0; i <= seg.c1; i++) hidden[i]++;
      }
    }
    const laneRows = Array.from({ length: visLanes }, () => 'var(--cal-lane-h)');
    if (overflow) laneRows.push('auto');
    const laneCount = visLanes + (overflow ? 1 : 0);
    const chipRows = Math.max(...week.map((date) => date ? (byDay.get(date) || []).length : 0), 0);
    const chipRow = laneCount + 2;
    const row = el('div', {
      class: 'cal-week',
      style: `grid-template-rows:auto ${laneRows.join(' ')} 1fr;min-height:${laneCount || chipRows ? 68 : 74}px`.replace(/\s+/g, ' '),
    });

    // ① 日期格：占满整行高度，是背景、边框与拖拽命中面
    week.forEach((date, i) => {
      const cls = ['cal-cell'];
      if (!date) {
        row.append(el('div', { class: 'cal-cell other', style: `grid-column:${i + 1}` }));
        return;
      }
      const wd = new Date(date + 'T00:00:00Z').getUTCDay();
      const hk = data.holidays?.[date]; // holiday | workday
      if (date.slice(0, 7) !== current) cls.push('other');
      if (date === today) cls.push('today');
      if (hk === 'holiday') cls.push('holiday');
      else if (hk === 'workday') cls.push('workday');
      else if (wd === 0 || wd === 6) cls.push('weekend');
      row.append(el('div', {
        class: cls.join(' '), 'data-date': date, style: `grid-column:${i + 1}`,
        onclick: (e) => {
          if (!isNarrow() || !pickedTaskId) return;
          if (e.target.closest('.cal-span, .cal-chip, .cal-more')) return;
          const task = allTasks.find((item) => String(item.id) === pickedTaskId);
          if (!task || task.status !== 'open') { clearPickedTask(); return; }
          clearPickedTask();
          void moveTaskWhole(task, '', date);
        },
      }));
    });

    // ② 日期数字：第 1 行，与车道对齐的锚（原来嵌在格内，会随格内内容漂移）
    week.forEach((date, i) => {
      if (!date) return;
      const hk = data.holidays?.[date];
      row.append(el('div', {
        class: `cal-daynum${date.slice(0, 7) !== current ? ' other' : ''}${date === today ? ' is-today' : ''}`,
        style: `grid-column:${i + 1};grid-row:1`,
      },
        el('span', {}, String(Number(date.slice(8)))),
        hk ? el('span', { class: 'hmark' }, hk === 'holiday' ? '休' : '班') : null
      ));
    });

    // ③ 车道长条：跨列一条到底，同一周行内恒等高
    for (const seg of segs) {
      if (overflow && seg.lane >= visLanes) continue;
      row.append(taskSpanNode(seg, monthStart, monthLast));
    }

    if (overflow) {
      hidden.forEach((count, i) => {
        if (!count || !week[i]) return;
        row.append(el('button', {
          class: 'cal-more', type: 'button',
          style: `grid-column:${i + 1};grid-row:${visLanes + 2}`,
          'aria-label': `展开第 ${w + 1} 周隐藏的 ${count} 条待办`,
          onclick: () => { expanded.add(w); void load({ refresh: false }); },
        }, `+${count} 条`));
      });
    } else if (open && total > cap) {
      row.append(el('button', {
        class: 'cal-more cal-more-collapse', type: 'button',
        style: `grid-column:7;grid-row:${total + 2}`,
        'aria-label': `收起第 ${w + 1} 周待办`,
        onclick: () => { expanded.delete(w); void load({ refresh: false }); },
      }, '收起'));
    }

    // ④ chip 堆：车道区下方的末行
    week.forEach((date, i) => {
      const entries = date ? (byDay.get(date) || []) : [];
      if (!entries.length) return;
      row.append(el('div', {
        class: 'cal-day-chips',
        style: `grid-column:${i + 1};grid-row:${chipRow}`,
      }, ...entries.map((entry) => entry.node)));
    });

    grid.append(row);
  }
  renderTray(allTasks);
}

document.getElementById('prev').addEventListener('click', () => { expanded.clear(); current = shiftMonth(current, -1); load(); });
document.getElementById('next').addEventListener('click', () => { expanded.clear(); current = shiftMonth(current, 1); load(); });
document.getElementById('today-btn').addEventListener('click', () => { expanded.clear(); current = todayStr().slice(0, 7); load(); });
document.addEventListener('pointermove', onPointerMove);
document.addEventListener('pointerup', (e) => finishDrag(e, true));
document.addEventListener('pointercancel', (e) => finishDrag(e, false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drag) finishDrag(e, false); });
window.addEventListener('resize', syncResponsiveCopy, { passive: true });

// 图例即筛选开关：点击切 .off → 写 localStorage → 重渲染。
// 初始 .off 态与 filters 对齐（首次进入时按持久化偏好点亮/熄灭）。
for (const btn of document.querySelectorAll('.cal-legend .lg[data-key]')) {
  const key = btn.dataset.key;
  btn.setAttribute('role', 'switch');
  btn.setAttribute('aria-checked', String(filters[key]));
  if (!filters[key]) btn.classList.add('off');
  btn.addEventListener('click', () => {
    filters[key] = !filters[key];
    btn.classList.toggle('off', !filters[key]);
    btn.setAttribute('aria-checked', String(filters[key]));
    writeFilters(filters);
    load();
  });
}

document.addEventListener('anjian:changed', load);
syncResponsiveCopy();
await load();
