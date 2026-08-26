// 案件详情。DOM 契约见 case.html —— 改这里必须对着那里改。
// 资金区钩子：#case-money #share-agreements #share-list #share-receivable-add #share-payable-add #share-form；open 修复单在已结行标「待修复」。
// 设计体系 v2「一个骨架 · 三种材质」：面板 .panel/.p-head/.p-foot、期限跑道（母题）、
// 待办 .todo-row、款项 .pay-row、时间线 .tl-*。样式一律走 css/style.css 的类，不写内联样式
// （唯一例外：跑道时间轴的百分比几何 —— 颜色仍走 var()）。
import { api, el, toast, SEV_LABEL, STATUS_LABEL, todayStr } from './api.js';
import { mountNav } from './nav.js';
import { stepper, feeBar } from './charts.js';
import { datePrompt } from './dateedit.js';
import { fileIconEl } from './icons.js';
import { feeSettlementActions, openFormulaEditor, renderAgreementManager } from './fee-settlement.js';
import { renderFeeVouchers } from './fee-vouchers.js';
import { bindFold, setFoldOpen } from './fold.js';
import { mountAgentDrawer } from './agent-drawer.js';

await mountNav();

const id = new URLSearchParams(location.search).get('id');
// F18：缺 id 立即跳回列表并中止模块执行（ESM 顶层不能 return，用 throw 阻断后续 /api/meta、/api/cases/null 脏请求与错误 toast）
if (!id) { location.replace('/cases.html'); throw new Error('case.html: 缺 id 参数，已跳回案件列表'); }

function arrangeCaseLayout() {
  const layout = document.getElementById('case-layout');
  const sections = [...layout.children];
  const lane = (name) => el('div', { class: `case-lane case-lane-${name}` },
    ...sections
      .filter((section) => section.classList.contains(`case-${name}`))
      .sort((a, b) => Number(a.dataset.caseOrder) - Number(b.dataset.caseOrder))
  );
  layout.replaceChildren(lane('main'), lane('side'));
  layout.classList.add('is-arranged');
}

function initCaseFolds() {
  // D5 已忽略事实仍是 details.fold（保留在文件区内）
  bindFold(document.getElementById('file-ignored'), `case-${id}-file-ignored`, false);
  // 归档门：details.archive-door，复用 fold.js 持久化
  bindFold(document.getElementById('case-archive-door'), `case-${id}-archive`, false);
  const archiveDoor = document.getElementById('case-archive-door');
  archiveDoor.addEventListener('toggle', () => {
    const caret = archiveDoor.querySelector('.archive-door-caret');
    if (caret) caret.textContent = archiveDoor.open ? '▾' : '▸';
  });

  // 三条事实条：「展开/收起」就地展开同条内的录入区（.factstrip-more），不走 fold.js
  const bindStrip = (toggleId, moreId) => {
    const toggle = document.getElementById(toggleId);
    const more = document.getElementById(moreId);
    if (!toggle || !more) return;
    toggle.addEventListener('click', () => {
      const open = more.hasAttribute('hidden');
      if (open) more.removeAttribute('hidden'); else more.setAttribute('hidden', '');
      toggle.classList.toggle('is-active', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? '收起' : '展开';
    });
  };
  bindStrip('case-inputs-toggle', 'case-inputs-more');
  bindStrip('case-contacts-toggle', 'case-contacts-more');
  bindStrip('case-share-agreements-toggle', 'case-share-agreements-more');
}

function initSectionNav() {
  const links = [...document.querySelectorAll('#case-section-nav [data-target]')];
  const byId = new Map(links.map((link) => [link.dataset.target, link]));
  const setActive = (idToActivate) => {
    for (const link of links) link.classList.toggle('is-active', link.dataset.target === idToActivate);
  };
  const openTarget = (targetId, scroll = false) => {
    const target = document.getElementById(targetId);
    if (!target) return;
    // 命中的目标若是折叠门（.fold 或 .archive-door）或含折叠门，全部展开
    const isDoor = target.matches('details.fold, details.archive-door');
    const folds = isDoor ? [target] : [...target.querySelectorAll('details.fold, details.archive-door')];
    for (const details of folds) setFoldOpen(details, true, { persist: false });
    if (scroll) requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const applyHash = (scroll = false) => {
    const targetId = decodeURIComponent(location.hash.slice(1)) || 'case-overview';
    setActive(byId.has(targetId) ? targetId : (targetId.startsWith('case-') ? targetId : 'case-overview'));
    openTarget(targetId, scroll);
  };
  applyHash(false);
  for (const link of links) {
    link.addEventListener('click', () => {
      setActive(link.dataset.target);
      openTarget(link.dataset.target, true);
    });
  }
  window.addEventListener('hashchange', () => applyHash(true));
  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (visible) setActive(visible.target.id);
  }, { rootMargin: '-150px 0px -62% 0px', threshold: [0, 0.05] });
  for (const target of byId.keys()) {
    const section = document.getElementById(target);
    if (section) observer.observe(section);
  }
}

arrangeCaseLayout();
initCaseFolds();
initSectionNav();

const meta = await api('/meta');
const evTypeSel = document.getElementById('ev-type');
for (const t of meta.event_types) evTypeSel.append(el('option', { value: t.id }, t.label));
const evLabel = Object.fromEntries(meta.event_types.map((t) => [t.id, t.label]));

// 编辑案件信息：程序 → 阶段联动（与建案表单同一模式）。改名/改程序是「录错了」的自救口。
const efProc = document.querySelector('#edit-form [name="procedure"]');
const efStage = document.querySelector('#edit-form [name="stage"]');
for (const p of meta.procedures) efProc.append(el('option', { value: p }, p));
function syncEditStages(stage) {
  efStage.replaceChildren();
  for (const s of meta.stage_templates[efProc.value] || []) efStage.append(el('option', { value: s }, s));
  // 当前阶段不在新程序词表里（历史自定义阶段）时保留显示，避免静默改成第一阶段
  if (stage && ![...efStage.options].some((o) => o.value === stage)) efStage.append(el('option', { value: stage }, stage));
  efStage.value = stage || efStage.options[0]?.value || '';
}
efProc.addEventListener('change', () => syncEditStages(''));

let bundle = null;
const TIMELINE_PREVIEW_LIMIT = 5;
let timelineExpanded = false;
let timelineItems = [];
let timelineFilter = 'all';
let feeFilesEnabled = false;
let stopFolderWatch = () => {};

const daysTo = (dateStr, today = todayStr()) => Math.round((new Date(dateStr) - new Date(today)) / 86400000);

async function patchCase(body, msg = '已保存 ✓') {
  const r = await api(`/cases/${id}`, { method: 'PATCH', body });
  let text = msg;
  if (r.templated?.length) text += ` → 铺 ${r.templated.length} 条模板待办`;
  if (r.stage_change_log) text += ' · 已记入时间线';
  toast(text);
  await load();
}

// ---- 表单绑定 ----
// 从上下文面板直接进入对应录入器：展开、定位、聚焦三件事一次完成。
function revealRecordForm(formId) {
  const form = document.getElementById(formId);
  const adder = form?.closest('details.adder');
  if (!form || !adder) return;
  const fold = form.closest('details.fold');
  if (fold) setFoldOpen(fold, true);
  // 录入表单现在在事实条的 .factstrip-more（hidden 属性）里：先展开它
  const stripMore = form.closest('.factstrip-more');
  if (stripMore && stripMore.hasAttribute('hidden')) {
    stripMore.removeAttribute('hidden');
    const toggle = stripMore.parentElement?.querySelector('.factstrip-edit');
    if (toggle) {
      toggle.classList.add('is-active');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.textContent = '收起';
    }
  }
  adder.open = true;
  adder.scrollIntoView({ behavior: 'auto', block: 'center' });
  requestAnimationFrame(() => {
    form.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])')
      ?.focus({ preventScroll: true });
  });
}

document.getElementById('task-add-shortcut').addEventListener('click', () => revealRecordForm('task-form'));
document.getElementById('log-add-shortcut').addEventListener('click', () => revealRecordForm('log-form'));

const CASE_STATUS_LABEL = { active: '在办', shelved: '搁置', closed: '已结' };
document.getElementById('c-status').addEventListener('change', (e) => {
  const v = e.target.value;
  // 结案/搁置会让案件从默认在办列表消失——跟阶段切换同级，要确认；取消则还原下拉，不停在假状态
  if (v !== bundle.case.status && v !== 'active'
      && !confirm(`把案件状态改为「${CASE_STATUS_LABEL[v]}」？它会从默认的在办列表消失（列表页可筛选找回）。`)) {
    e.target.value = bundle.case.status;
    return;
  }
  patchCase({ status: v }, '状态已变更 ✓');
});

document.getElementById('edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await patchCase(Object.fromEntries(new FormData(e.target).entries()));
});

async function loadWorkspacePicker() {
  const select = document.getElementById('case-workspace-select');
  const note = document.getElementById('case-workspace-note');
  const bindButton = document.getElementById('case-workspace-bind');
  const createButton = document.getElementById('case-workspace-create');
  const current = bundle?.case?.folder_path || bundle?.case?.name || '';
  try {
    const result = await api('/case-folders');
    select.replaceChildren();
    if (!result.configured) {
      select.append(el('option', { value: current }, '未配置案件文件根'));
      select.disabled = true;
      bindButton.disabled = true;
      createButton.disabled = true;
      note.textContent = '当前部署未配置 ANJIAN_FILES_ROOT；请先配置案件文件根。';
      return;
    }
    const available = result.folders.filter((folder) => folder.bound_case_id == null || folder.bound_case_id === Number(id));
    if (!available.some((folder) => folder.name === current)) {
      available.unshift({ name: current, bound_case_id: Number(id), missing: true });
    }
    for (const folder of available) {
      const label = folder.name === current
        ? `${folder.name}${folder.missing ? '（当前指针，目录缺失）' : '（当前）'}`
        : folder.name;
      select.append(el('option', { value: folder.name }, label));
    }
    select.value = current;
    select.disabled = false;
    bindButton.disabled = select.options.length === 0;
    createButton.disabled = false;
    note.textContent = `当前项目：${current}。案件夹就是本案 AI 助理的工作目录；换绑不移动、不复制、也不删除原文件。`;
  } catch (error) {
    select.replaceChildren(el('option', { value: current }, current || '案件工作区不可用'));
    select.disabled = true;
    bindButton.disabled = true;
    createButton.disabled = true;
    note.textContent = `案件工作区读取失败：${error.message || error}`;
  }
}

async function bindWorkspace(folderPath, create) {
  const name = String(folderPath || '').trim();
  if (!name) { toast('请先选择或填写案件工作区'); return; }
  const previous = bundle.case.folder_path || bundle.case.name;
  if (name !== previous && !confirm(`把本案 Agent 项目从「${previous}」切换到「${name}」？原文件不会移动或删除，正在运行的助理会停止。`)) return;
  const result = await api(`/cases/${id}/workspace`, {
    method: 'PUT',
    body: { folder_path: name, create },
  });
  toast(result.workspace.created ? '案件工作区已创建并绑定 ✓' : '案件工作区已绑定 ✓');
  document.getElementById('case-workspace-new').value = '';
  await load();
  stopFolderWatch();
  stopFolderWatch = watchFolder();
}

document.getElementById('case-workspace-bind').addEventListener('click', async () => {
  try {
    await bindWorkspace(document.getElementById('case-workspace-select').value, false);
  } catch { /* api() 已显示服务端错误；避免留下 unhandled rejection */ }
});
document.getElementById('case-workspace-create').addEventListener('click', async () => {
  const input = document.getElementById('case-workspace-new');
  try {
    await bindWorkspace(input.value || bundle.case.name, true);
  } catch { /* api() 已显示服务端错误；避免留下 unhandled rejection */ }
});

async function uploadFile(file, { dir = '法院文书', entity = '', entityId = '' } = {}) {
  const q = new URLSearchParams({ dir, name: file.name });
  if (entity) { q.set('entity', entity); q.set('entity_id', entityId); }
  const res = await fetch(`/api/cases/${id}/files?` + q.toString(), { method: 'PUT', body: file });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `上传失败 ${res.status}`);
  }
  return res.json();
}

document.getElementById('contact-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  await api(`/cases/${id}/contacts`, { body });
  toast('联系人已记录 ✓');
  e.target.reset();
  await load();
});

const ROLE_PILL = { 当事人: 'ok', 对方当事人: 'warn', 承办法官: 'acc', 法官助理: 'acc', 书记员: '', 对方律师: 'warn', 合作律师: 'acc', 其他: '' };

function contactRow(p) {
  return el('div', { class: 'row' },
    el('span', { class: `pill ${ROLE_PILL[p.role] || ''}` }, p.role),
    el('b', {}, p.name),
    p.phone ? el('a', { href: 'tel:' + p.phone, class: 'meta nowrap', title: '点击拨打' }, p.phone) : null,
    p.id_no ? el('a', {
      href: '#', class: 'meta nowrap', title: '点击复制身份证号',
      onclick: async (e) => { e.preventDefault(); await navigator.clipboard.writeText(p.id_no); toast('身份证号已复制'); },
    }, p.id_no) : null,
    el('span', { class: 'grow meta' }, [p.org, p.note].filter(Boolean).join('｜')),
    el('span', { class: 'tl-actions' },
      el('button', {
        class: 'btn small', type: 'button',
        onclick: async () => {
          const v = await datePrompt({
            title: `编辑「${p.name}」`,
            fields: [
              { key: 'name', label: '姓名', value: p.name, type: 'text', required: true },
              { key: 'phone', label: '电话', value: p.phone, type: 'tel' },
              { key: 'id_no', label: '身份证号', value: p.id_no, type: 'text' },
              { key: 'org', label: '单位/庭室', value: p.org, type: 'text' },
              { key: 'note', label: '备注', value: p.note, type: 'text' },
            ],
          });
          if (!v) return;
          await api(`/contacts/${p.id}`, { method: 'PATCH', body: v });
          toast('已保存 ✓'); load();
        },
      }, '编辑'),
      el('button', {
        class: 'btn small danger', type: 'button',
        onclick: async () => { if (!confirm(`删除联系人「${p.name}」？`)) return; await api(`/contacts/${p.id}`, { method: 'DELETE' }); toast('已删除'); load(); },
      }, '删')
    )
  );
}

document.getElementById('event-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  const filesInput = document.getElementById('ev-files');
  const files = [...(filesInput.files || [])];
  const r = await api(`/cases/${id}/events`, { body });
  let uploaded = 0;
  for (const f of files) {
    try { await uploadFile(f, { entity: 'event', entityId: r.id }); uploaded++; }
    catch (err) { toast('❌ 附件上传失败：' + err.message, 3200); }
  }
  const nd = r.derived?.deadlines?.length || 0;
  const nt = r.derived?.tasks?.length || 0;
  const parts = [];
  if (nd) parts.push(`派生 ${nd} 条期限`);
  if (nt) parts.push(`${nt} 条录入任务`);
  if (uploaded) parts.push(`${uploaded} 份文书入夹`);
  toast(parts.length ? `已记录 → ${parts.join('、')}` : '事件已记录 ✓');
  e.target.reset();
  await load();
  await loadFiles();
});

document.getElementById('deadline-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  await api(`/cases/${id}/deadlines`, { body });
  toast('死线已记录 ✓');
  e.target.reset();
  await load();
});

document.getElementById('task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  body.case_id = Number(id);
  await api('/tasks', { body });
  toast('待办已记录 ✓');
  e.target.reset();
  await load();
});

document.getElementById('fee-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  if (body.amount === '') delete body.amount;
  await api(`/cases/${id}/fees`, { body });
  toast('款项已记录 ✓');
  e.target.reset();
  await loadFees();
});

const openShareAgreement = (direction) => openFormulaEditor({
  caseId: Number(id), direction,
  onChanged: async () => Promise.all([loadShares(), loadFees()]),
});
document.getElementById('share-receivable-add').addEventListener('click', () => openShareAgreement('receivable'));
document.getElementById('share-payable-add').addEventListener('click', () => openShareAgreement('payable'));

document.getElementById('share-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  body.case_id = Number(id);
  if (!body.due_month) delete body.due_month;
  await api('/shares', { body });
  toast('分成已记录 ✓');
  e.target.reset();
  await loadShares();
});

document.getElementById('log-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  body.case_id = Number(id);
  if (body.minutes) body.minutes = Number(body.minutes); else delete body.minutes;
  if (!body.worked_on) delete body.worked_on;
  await api('/worklog', { body });
  toast('日志已记录 ✓');
  e.target.reset();
  await load();
});

// ---- 期限跑道（本设计的母题：今日 → 死线）----
// 16 日刻度 = 逾期 2 日 + 今日 + 未来 14 日；今日原点固定 12.5%，每日 6.25%。
// 只有这里用内联 style：跑道几何是数据驱动的百分比，颜色仍全部走 var()。
const TRK_STEP = 6.25;
const TRK_ORIGIN = 12.5;

function track(d) {
  const days = d.days_left;
  const trk = el('div', {
    class: 'trk',
    title: days < 0
      ? `逾期 ${-days} 日 —— 死线 ${d.due_on} 已落在今日原点左侧`
      : days === 0 ? `今日截止 —— ${d.due_on}` : `剩 ${days} 日 —— 今日到死线 ${d.due_on}`,
  });
  if (days < 0) {
    const w = Math.min(-days, 2) * TRK_STEP;   // 逾期段向原点左侧反向延伸，封顶 2 日
    trk.append(
      el('i', { class: 'trk-fill over', style: `left:${TRK_ORIGIN - w}%;width:${w}%` }),
      el('i', { class: 'trk-origin' }),
      el('i', { class: 'trk-dot crit', style: `left:${TRK_ORIGIN - w}%` })
    );
    return trk;
  }
  const w = Math.min(days, 14) * TRK_STEP;     // 未来段封顶 14 日（刻度尺右端）
  trk.append(
    el('i', { class: `trk-fill ${days <= 7 ? 'warn' : 'ok'}`, style: `left:${TRK_ORIGIN}%;width:${w}%` }),
    el('i', { class: 'trk-origin' }),
    el('i', { class: `trk-dot ${days <= 3 ? 'crit' : days <= 7 ? 'warn' : 'ok'}`, style: `left:${TRK_ORIGIN + w}%` })
  );
  return trk;
}

function doneBtn(d, cls = 'btn small rw-done') {
  return el('button', {
    class: cls, type: 'button', 'aria-label': `完成期限：${d.name}`,
    onclick: async () => {
      await api(`/deadlines/${d.id}`, { method: 'PATCH', body: { status: 'done' } });
      toast('已完成 ✓'); load();
    },
  }, '完成');
}

// 改期：跑道行与时间线共用一个入口（手动改期 → 人工设定，级联重算默认不再覆盖它）
async function editDeadlineDue(d) {
  const v = await datePrompt({
    title: `改「${d.name}」截止日`,
    hint: '手动改期将标记为人工设定，级联重算默认不再覆盖它',
    fields: [{ key: 'due_on', label: '截止日', value: d.due_on, required: true }],
  });
  if (!v || v.due_on === d.due_on) return;
  await api(`/deadlines/${d.id}`, { method: 'PATCH', body: { due_on: v.due_on } });
  toast('截止日已改 ✓'); load();
}

function editDueBtn(d, cls = 'btn small') {
  return el('button', { class: cls, type: 'button', 'aria-label': `改期：${d.name}`, onclick: () => editDeadlineDue(d) }, '改期');
}

// 依据 / 算法 / 人工设定 —— 跑道行与头条共用的小字尾
function deadlineMeta(d) {
  return [
    el('span', {}, SEV_LABEL[d.severity] || '一般'),
    d.basis ? el('span', { class: 'sep' }, '·') : null,
    d.basis ? el('span', {}, d.basis) : null,
    d.is_manual_override ? el('span', { class: 'sep' }, '·') : null,
    d.is_manual_override ? el('span', {}, '人工设定') : null,
  ];
}

// 头条：本案最近的那条死线。只在「真该喊」时出现（逾期或 ≤7 日）——
// 否则一条 60 天后的期限也顶着红色巨字，是虚假警报。
function runwayLead(d) {
  const days = d.days_left;
  const over = days < 0;
  return el('div', { class: 'rw-lead' + (!over && days > 3 ? ' amb' : '') },
    el('div', { class: 'hd-main' },
      el('div', { class: 'hd-kick' }, over ? '最近死线 · 已逾期' : days === 0 ? '最近死线 · 今日截止' : '最近死线'),
      el('div', { class: 'hd-num' },
        el('span', { class: 'w' }, over ? '逾期' : '剩'),
        el('span', { class: 'n' }, String(Math.abs(days))),
        el('span', { class: 'w' }, '天')
      ),
      el('h3', { class: 'hd-deck' }, d.name),
      el('div', { class: 'hd-rule', 'aria-hidden': 'true' }),
      el('div', { class: 'hd-meta' },
        el('span', {}, `${d.due_on} 到期`),
        el('span', { class: 'sep' }, '·'),
        ...deadlineMeta(d),
        d.calc_note ? el('span', { class: 'sep' }, '·') : null,
        d.calc_note ? el('span', {}, d.calc_note) : null
      )
    ),
    el('div', { class: 'rw-trk' }, track(d)),
    el('div', { class: 'rw-due' }, d.due_on.slice(5)),
    el('span', { class: 'rw-key' }, editDueBtn(d), doneBtn(d, 'btn small'))
  );
}

// 紧凑跑道行。字号梯度 28 → 20 → 15（d1/d2/d3）＝ 信息层级：越靠前越急。
function runwayRow(d, i) {
  const days = d.days_left;
  const over = days < 0;
  const tone = (over || days <= 3) ? ' crit' : days <= 7 ? ' amb' : '';
  const size = i === 0 ? ' d1' : i === 1 ? ' d2' : ' d3';
  return el('div', { class: `rw-row${size}${tone}` },
    el('div', { class: 'rw-days' },
      el('span', { class: 'pre' }, over ? '逾期' : '剩'),
      el('span', { class: 'n' }, String(Math.abs(days))),
      el('span', { class: 'u' }, '天')
    ),
    el('div', { class: 'rw-main' },
      el('div', { class: 'm1' }, d.name),
      el('div', { class: 'm2' }, ...deadlineMeta(d))
    ),
    el('div', { class: 'rw-trk' }, track(d)),
    el('div', { class: 'rw-due' }, d.due_on.slice(5)),
    el('span', { class: 'rw-acts' }, editDueBtn(d), doneBtn(d))
  );
}

function caseRunway(items) {
  const wrap = el('div', { class: 'runway runway-act' },
    el('div', { class: 'rw-colhead' },
      el('span', { class: 'h-days' }, '剩余'),
      el('span', { class: 'h-item' }, '事项 · 级别 · 依据'),
      el('span', { class: 'h-trk' }, '今日 → 死线'),
      el('span', { class: 'h-due' }, '到期'),
      el('span', { class: 'h-key' }, '操作')
    )
  );
  const lead = items[0].days_left <= 7 ? items[0] : null;
  if (lead) wrap.append(runwayLead(lead));
  (lead ? items.slice(1) : items).forEach((d, i) => wrap.append(runwayRow(d, i)));
  return wrap;
}

// ---- 费用 ----
function canToggleFeeWaiver(f) {
  if (f.settlement_context) {
    return !f.settlement_context.settlement_history && !f.settlement_context.share_history;
  }
  return !((f.settlement_runs || []).length || (f.shares || []).length);
}

function feeWaiverButton(f, refreshFinancials) {
  if (!['unpaid', 'waived'].includes(f.status) || !canToggleFeeWaiver(f)) return null;
  const restoring = f.status === 'waived';
  return el('button', {
    class: `btn small${restoring ? '' : ' danger'}`, type: 'button',
    onclick: async () => {
      const message = restoring
        ? `恢复「${f.label}」为待收？它会重新进入待收与逾期统计，原分成办法仍保留。`
        : `减免「${f.label}」？它会退出待收与逾期统计；本操作不会生成或删除分成，之后可以恢复。`;
      if (!confirm(message)) return;
      await api(`/fees/${f.id}`, {
        method: 'PATCH',
        body: { status: restoring ? 'unpaid' : 'waived', version: f.version },
      });
      toast(restoring ? '已恢复为待收 ✓' : '已减免，可随时恢复 ✓');
      await refreshFinancials();
    },
  }, restoring ? '恢复待收' : '减免');
}

// 款项账本行（规格 §4）：一行 7 列 = 款项/状态/触发节点/金额/分成/凭证/动作。
// 取消 2.2.4 的每笔款独立折叠——收起态就能读出触发节点与分成对象金额（回归点）。
// 低频的合同条款/收款记录/凭证列表走行内「明细」按钮，同一时间只展开一笔。
// 状态列 116px：装下「逾期 · 2026-04-27」带日期 chip（与 fees.js FEE_ITEM_GRID 同病同修）。
// 列最小值合计 ≤ 面板可用宽（1440 视口实测 ~918px），超了动作列会被 overflow 裁掉。
const CASE_FEE_GRID = 'minmax(140px,1.1fr) 116px minmax(130px,1.15fr) 92px minmax(110px,.9fr) 52px 148px';
let feeDetailId = null;   // 当前展开明细的款项 id（单值，非 map）

function feeStatusChip(f) {
  if (f.status === 'paid') return el('span', { class: 'ledger-chip is-ok' }, f.paid_on ? `已收 · ${f.paid_on}` : '已收');
  if (f.status === 'waived') return el('span', { class: 'ledger-chip is-muted' }, '减免');
  if (!f.due_on) return el('span', { class: 'ledger-chip is-muted' }, '待收 · 节点未到');
  const overdue = f.due_on < todayStr();
  return el('span', { class: `ledger-chip ${overdue ? 'is-crit' : 'is-warn'}` },
    overdue ? `逾期 · ${f.due_on}` : `待收 · ${f.due_on}`);
}

// 分成列文案：取首条 share，或「无分成」
function feeShareText(f) {
  const first = (f.shares || [])[0];
  if (!first) return { text: '无分成', cls: 'is-faint' };
  const done = first.status === 'settled';
  return {
    text: `${first.direction === 'payable' ? '应付' : '应收'} ${first.counterpart} ${shareFmt(first.amount)}`,
    cls: done ? '' : 'is-warn',
  };
}

function feeRow(f) {
  const refreshFinancials = () => Promise.all([loadFees(), loadShares()]);

  const shareInfo = feeShareText(f);
  const voucherCount = (f.vouchers || []).length;
  const isOpen = feeDetailId === f.id;
  const stateColor = f.status === 'paid' ? 'var(--ok-dot)'
    : (f.status === 'unpaid' && f.due_on && f.due_on < todayStr() ? 'var(--red-dot)' : 'var(--amber-dot)');

  // 动作列按设计稿 §4：行内只放「主按钮 + 明细」两个按钮，完整结算操作收进明细展开区。
  // 主按钮：paid → 记分成（打开结算编辑器）；unpaid → 标记已收；waived → 无主按钮。
  const primaryBtn = f.status === 'paid'
    ? el('button', { class: 'ledger-btn primary is-paid', type: 'button',
        onclick: () => openFeeSettlement({ fee: f, onChanged: refreshFinancials }) }, '记分成')
    : f.status === 'unpaid'
      ? el('button', { class: 'ledger-btn primary', type: 'button',
          onclick: () => openFeeSettlement({ fee: f, onChanged: refreshFinancials }) }, '标记已收')
      : null;

  const row = el('div', {
    class: 'ledger-item case-fee-ledger-item',
    style: `grid-template-columns:${CASE_FEE_GRID}`,
  },
    el('span', { class: 'ledger-item-label', style: 'grid-column:1' }, f.label),
    el('span', { style: 'grid-column:2;justify-self:start' }, feeStatusChip(f)),
    el('span', { class: 'ledger-item-node', style: 'grid-column:3', title: f.node || '' }, f.node || '未填写'),
    el('span', {
      class: `ledger-item-amt${f.status === 'waived' ? ' is-muted' : ''}`,
      style: 'grid-column:4',
    }, f.amount != null ? `¥${f.amount.toLocaleString()}` : '待定'),
    el('span', {
      class: `ledger-item-share ${shareInfo.cls}`,
      style: 'grid-column:5', title: shareInfo.text,
    }, shareInfo.text),
    el('span', {
      class: `ledger-item-vou${voucherCount ? '' : ' is-missing'}`,
      style: 'grid-column:6',
    }, voucherCount ? `${voucherCount} 份` : '缺'),
    el('span', { class: 'ledger-item-acts', style: 'grid-column:7' },
      primaryBtn,
      el('button', {
        class: 'ledger-btn ghost', type: 'button',
        onclick: () => { feeDetailId = feeDetailId === f.id ? null : f.id; renderFeeList(); },
        'aria-expanded': String(isOpen),
      }, isOpen ? '收起' : '明细'),
    ),
  );

  if (!isOpen) return [row];

  // 明细展开区（规格 §4）：合同条款/收款记录/凭证/备注 + 分成结果带。左侧状态色 inset shadow。
  const detailRows = [];
  if (f.node) detailRows.push(['触发节点', f.node]);
  if (f.note) detailRows.push(['备注', f.note]);
  if (f.paid_on) detailRows.push(['收款记录', `${f.paid_on} · ${f.amount != null ? `¥${f.amount.toLocaleString()}` : ''}`]);
  detailRows.push(['凭证', voucherCount
    ? (f.vouchers || []).map((v) => String(v.rel_path || '').split('/').pop() || '未命名').join(' · ')
    : '暂无 —— 拖入回单或发票即可归入本案文件夹']);

  const detail = el('div', {
    class: 'ledger-detail case-fee-ledger-detail',
    style: `box-shadow: inset 3px 0 0 0 ${stateColor}`,
  },
    ...detailRows.map(([k, v]) => el('div', {
      class: 'case-fee-detail-row',
      style: 'display:grid;grid-template-columns:84px 1fr;gap:14px;padding:8px 14px 8px 30px;border-top:1px solid var(--line)',
    },
      el('span', { class: 'ledger-detail-key' }, k),
      el('span', { class: 'ledger-detail-val' }, v),
    )),
    ...(f.shares || []).length
      ? f.shares.map((s) => el('div', {
          class: 'case-fee-detail-row',
          style: 'display:grid;grid-template-columns:84px 1fr;gap:14px;padding:8px 14px 8px 30px;border-top:1px solid var(--line)',
        },
        el('span', { class: 'ledger-detail-key' }, '分成'),
        el('span', { class: 'ledger-detail-val' },
          shareSubRowInline(s)),
        ))
      : [],
    // 完整凭证管理区（拖拽上传）
    renderFeeVouchers(f, { enabled: feeFilesEnabled, onChanged: loadFees })
      ? el('div', {
          class: 'case-fee-detail-row',
          style: 'display:grid;grid-template-columns:84px 1fr;gap:14px;padding:8px 14px 8px 30px;border-top:1px solid var(--line)',
        },
        el('span', { class: 'ledger-detail-key' }, '凭证管理'),
        renderFeeVouchers(f, { enabled: feeFilesEnabled, onChanged: loadFees }),
        )
      : null,
    // 完整结算操作区：这笔怎么分 / 改到期 / 减免 / 删 等收进明细（行内只有主按钮+明细）
    el('div', {
      class: 'case-fee-detail-row case-fee-detail-actions',
      style: 'display:grid;grid-template-columns:84px 1fr;gap:14px;padding:8px 14px 8px 30px;border-top:1px solid var(--line)',
    },
      el('span', { class: 'ledger-detail-key' }, '操作'),
      el('span', { class: 'ledger-detail-val case-fee-action-set' }, feeDetailActions(f, refreshFinancials)),
    ),
  );
  return [row, detail];
}

// 明细区里的完整操作集：把原 feeSettlementActions + 改到期/减免/删 组合在一起。
// 这些是低频但必要的操作，收进明细后行内只剩主按钮 + 明细两个按钮（设计稿 §4）。
function feeDetailActions(f, refreshFinancials) {
  const extraActions = [];
  if (f.status === 'unpaid') {
    extraActions.push(el('button', {
      class: 'btn small', type: 'button',
      onclick: async () => {
        const v = await datePrompt({
          title: `「${f.label}」到期日`,
          hint: '节点日期明确后回填（如立案之日）',
          fields: [{ key: 'due_on', label: '到期日（清空=节点未到）', value: f.due_on }],
        });
        if (!v) return;
        await api(`/fees/${f.id}`, { method: 'PATCH', body: { due_on: v.due_on } });
        toast('到期日已更新 ✓');
        await loadFees();
      },
    }, f.due_on ? '改到期' : '设到期'));
    const waive = feeWaiverButton(f, refreshFinancials);
    if (waive) extraActions.push(waive);
    const deleteBlocked = f.settlement_context
      ? (f.settlement_context.assignment || f.settlement_context.settlement_history || f.settlement_context.linked_share)
      : ((f.share_plans || []).some((plan) => plan.plan)
        || (f.settlement_runs || []).length || (f.shares || []).length);
    if (!deleteBlocked && !(f.vouchers || []).length) {
      extraActions.push(el('button', {
        class: 'btn small danger', type: 'button',
        onclick: async () => {
          if (!confirm('删除该款项？')) return;
          await api(`/fees/${f.id}`, { method: 'DELETE' });
          toast('已删除');
          await loadFees();
        },
      }, '删'));
    }
  } else if (f.status === 'waived') {
    const restore = feeWaiverButton(f, refreshFinancials);
    if (restore) extraActions.push(restore);
  }
  const settlementActions = feeSettlementActions({ fee: f, onChanged: refreshFinancials, extraActions });
  return settlementActions || (extraActions.length
    ? el('span', { class: 'tl-actions settlement-actions' },
      el('span', { class: 'settlement-action-buttons' }, ...extraActions))
    : el('span', { class: 'meta' }, '当前没有可执行操作'));
}

// 分成结果带的行内紧凑版（明细区用）
function shareSubRowInline(s) {
  const receivable = s.direction === 'receivable';
  return el('span', {},
    el('span', { class: `chip ${s.direction === 'payable' ? 'c-amber' : 'c-blue'}` }, s.direction === 'payable' ? '应付' : '应收'),
    ' ', s.counterpart, ' · ',
    el('b', { class: 'num' }, shareFmt(s.amount)),
    ' · ', s.status === 'settled' ? (receivable ? '已收' : '已分') : (receivable ? '待收' : '待分'),
  );
}

// 纯前端重渲染款项表（不拉 API）——明细展开/收起切换用，保证 0 请求。
let lastFeeItems = [];
function renderFeeList() {
  const box = document.getElementById('fee-list');
  if (!lastFeeItems.length) {
    box.replaceChildren(el('div', { class: 'section-empty' }, '尚未登记款项——从下方按合同节点录入'));
    return;
  }
  const table = el('div', { class: 'ledger-table case-fee-ledger' },
    el('div', { class: 'ledger-head', style: `grid-template-columns:${CASE_FEE_GRID}` },
      el('span', { style: 'grid-column:1' }, '款项'),
      el('span', { style: 'grid-column:2' }, '状态'),
      el('span', { style: 'grid-column:3' }, '触发节点'),
      el('span', { class: 'is-num', style: 'grid-column:4' }, '金额'),
      el('span', { style: 'grid-column:5' }, '分成'),
      el('span', { class: 'is-num', style: 'grid-column:6' }, '凭证'),
      el('span', { style: 'grid-column:7' }, '动作'),
    ),
    ...lastFeeItems.flatMap(feeRow).filter(Boolean),
  );
  box.replaceChildren(table);
}

async function loadFees() {
  const d = await api(`/cases/${id}/fees`);
  feeFilesEnabled = Boolean(d.files_enabled);
  lastFeeItems = d.items;
  document.getElementById('case-money-badge').textContent = d.items.length || '';
  const viz = document.getElementById('fee-viz');
  viz.replaceChildren();
  viz.hidden = !d.items.length;
  if (d.items.length) {
    viz.append(feeBar({
      paid: d.total_paid,
      unpaid: d.total_unpaid,
      tbd: d.items.filter((x) => x.amount == null && x.status === 'unpaid').length,
    }));
  }
  renderFeeList();

  // 归档门：已结清款项（status==='paid'）收进本页唯一归档门。
  // 非结清（unpaid/waived）留在主款项表里全可见，不许被折叠或归档掩盖（边界 §3）。
  renderCaseArchive(d.items);
}

function renderCaseArchive(items) {
  const settled = items.filter((f) => f.status === 'paid');
  const countNode = document.getElementById('case-archive-count');
  const body = document.getElementById('case-archive-body');
  const section = document.getElementById('case-archive');
  if (!countNode || !body || !section) return;
  if (!settled.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const total = settled.reduce((s, f) => s + (Number(f.amount) || 0), 0);
  countNode.textContent = `结清 ${settled.length} 项 · 合计 ${shareFmt(total)}`;
  body.replaceChildren(...settled.map((f) => el('div', { class: 'archive-door-row' },
    el('span', { class: 'archive-door-key' }, f.paid_on || '已收'),
    el('span', { class: 'archive-door-val' },
      `${f.label} · ${f.amount != null ? shareFmt(f.amount) : '金额待定'}`,
      f.paid_on ? ` · ${f.paid_on} 收款` : '',
    ),
  )));
}

// ---- 合作分成 ----
const shareFmt = (n) => (Number(n) < 0 ? '−¥' : '¥') + Math.abs(Number(n)).toLocaleString('zh-CN');

function shareDirection(direction) {
  return el('span', { class: `chip ${direction === 'payable' ? 'c-amber' : 'c-blue'}` },
    direction === 'payable' ? '应付' : '应收');
}

function shareAmountNodes(s) {
  const amount = el('b', { class: 'num' }, shareFmt(s.amount));
  return Number(s.amount) < 0 ? [el('span', { class: 'chip c-red' }, '冲抵'), amount] : amount;
}

function shareStatus(s) {
  const receivable = s.direction === 'receivable';
  if (s.status === 'settled') return el('span', { class: 'pill ok' }, s.settled_on
    ? `${receivable ? '已收' : '已分'} · ${s.settled_on}`
    : (receivable ? '已收' : '已分'));
  if (s.status === 'waived') return el('span', { class: 'pill' }, '减免');
  const overdue = s.due_month < todayStr().slice(0, 7);
  return el('span', { class: `pill ${overdue ? 'crit' : 'warn'}` },
    overdue
      ? `${receivable ? '待收' : '待分'} · 逾期（${s.due_month}）`
      : `${receivable ? '待收' : '待分'} · ${s.due_month}`);
}

function shareActions(s) {
  if (s.status !== 'pending') return null;
  const actions = [
    el('button', {
      class: 'btn small primary', type: 'button',
      onclick: async () => {
        const receivable = s.direction === 'receivable';
        const v = await datePrompt({
          title: receivable ? `已收到「${s.counterpart}」给我的分成` : `已向「${s.counterpart}」完成分成`,
          fields: [{ key: 'settled_on', label: receivable ? '收款日期' : '分成日期', value: todayStr(), required: true }],
        });
        if (!v) return;
        await api(`/shares/${s.id}`, { method: 'PATCH', body: { status: 'settled', settled_on: v.settled_on } });
        toast(receivable ? '已标记收款 ✓' : '已标记分成完成 ✓');
        loadShares();
      },
    }, s.direction === 'receivable' ? '已收' : '已分'),
    el('button', {
      class: 'btn small', type: 'button',
      onclick: async () => {
        const receivable = s.direction === 'receivable';
        const v = await datePrompt({
          title: `修改与「${s.counterpart}」的${receivable ? '应收' : '应分'}月份`,
          fields: [{ key: 'due_month', label: receivable ? '应收月份' : '应分月份', value: s.due_month, type: 'month', required: true }],
        });
        if (!v || v.due_month === s.due_month) return;
        await api(`/shares/${s.id}`, { method: 'PATCH', body: { due_month: v.due_month } });
        toast(`${receivable ? '应收' : '应分'}月份已更新 ✓`);
        loadShares();
      },
    }, '改月份')
  ];
  const engineGenerated = s.settlement_snapshot_id != null
    || s.assignment_id != null
    || s.entry_kind === 'calculated'
    || s.entry_kind === 'adjustment';
  if (!engineGenerated && !s.is_void) actions.push(el('button', {
      class: 'btn small danger', type: 'button',
      onclick: async () => {
        if (!confirm(`删除与「${s.counterpart}」的这笔分成？`)) return;
        await api(`/shares/${s.id}`, { method: 'DELETE' });
        toast('分成记录已删除');
        loadShares();
      },
    }, '删'));
  return el('span', { class: 'tl-actions' }, ...actions);
}

function shareRow(s, repair = null) {
  const sub = [s.base_amount != null ? `基数 ${shareFmt(s.base_amount)}` : '', s.note].filter(Boolean).join('｜');
  const feeChip = s.fee_label ? el('span', { class: 'chip' }, '← ' + s.fee_label) : null;
  const repairLink = repair
    ? el('span', { class: 'tl-actions' }, el('a', {
      class: 'btn small', href: `/share-repairs.html#repair-${repair.id}`,
      title: '此已结历史分成必须在修复工作台人工裁决',
    }, '去修复'))
    : null;
  return el('div', { class: 'row' },
    shareDirection(s.direction),
    el('b', {}, s.counterpart),
    feeChip,
    shareStatus(s),
    repair ? el('span', { class: 'chip c-amber' }, '待修复') : null,
    ...[shareAmountNodes(s)].flat(),
    el('span', { class: 'grow meta' }, sub),
    repairLink || shareActions(s)
  );
}

async function loadShares() {
  const [d, repairs] = await Promise.all([
    api(`/cases/${id}/shares`),
    api('/share-repairs?status=open'),
  ]);
  const repairByShareId = new Map(
    repairs.filter((repair) => String(repair.share.case_id) === String(id))
      .map((repair) => [repair.fee_share_id, repair])
  );
  renderAgreementManager({
    agreements: d.agreements,
    target: document.getElementById('share-agreements'),
    caseId: Number(id),
    onChanged: async () => Promise.all([loadShares(), loadFees()]),
  });
  const activeAgreements = d.agreements.filter((agreement) => agreement.status === 'active');
  const agreementSummary = document.getElementById('case-share-summary');
  if (!activeAgreements.length) {
    agreementSummary.textContent = '未设置分成';
  } else {
    const lines = activeAgreements.map((agreement) => {
      const view = agreement.latest_revision?.money_view;
      const relation = agreement.direction === 'payable' ? `应付${agreement.counterpart}` : `应收${agreement.counterpart}`;
      const rate = view?.headline_text || view?.human_summary || '待定';
      const term = agreement.settlement_term || view?.settlement_term || '待确定';
      return `${view?.human_summary || '分成办法待补充'} · ${relation} ${rate} · ${term}`;
    });
    agreementSummary.textContent = lines.join('；');
  }
  const agreementNeedsAttention = activeAgreements.some((agreement) => (
    agreement.latest_revision?.money_view?.provisional || agreement.unresolved
  ));
  if (agreementNeedsAttention) {
    // 分成约定现在是事实条：需关注时自动展开它的 more 区（不走 fold.js）
    const more = document.getElementById('case-share-agreements-more');
    const toggle = document.getElementById('case-share-agreements-toggle');
    if (more && more.hasAttribute('hidden')) {
      more.removeAttribute('hidden');
      if (toggle) {
        toggle.classList.add('is-active');
        toggle.setAttribute('aria-expanded', 'true');
        toggle.textContent = '收起';
      }
    }
  }

  const items = document.getElementById('share-list');
  items.replaceChildren(...d.items.map((share) => shareRow(share, repairByShareId.get(share.id))));
  if (!d.items.length) items.append(el('div', { class: 'section-empty' }, '尚无已发生分成台账——约定本身不会提前生成金额'));
  const pending = d.items.filter((share) => share.status === 'pending');
  const payable = pending.filter((share) => share.direction === 'payable')
    .reduce((sum, share) => sum + Number(share.amount || 0), 0);
  const receivable = pending.filter((share) => share.direction === 'receivable')
    .reduce((sum, share) => sum + Number(share.amount || 0), 0);
  document.getElementById('case-share-list-summary').textContent =
    `应付未结 ${shareFmt(payable)} · 应收未结 ${shareFmt(receivable)}`;
  // case-share-list 现在是常显区（不再折叠），无需展开
}

// ---- 待办 ----
function taskRow(t) {
  const dl = t.due_on ? daysTo(t.due_on) : null;
  const dueCls = dl === null ? '' : dl < 0 ? 'chip c-red' : dl <= 3 ? 'chip c-amber' : 'chip';
  const urgencyClass = dl === null ? '' : dl < 0 ? ' is-overdue' : dl <= 3 ? ' is-soon' : '';
  return el('div', { class: `todo-row${urgencyClass}` },
    el('label', { class: 'ck' },
      el('input', {
        type: 'checkbox', 'aria-label': `完成：${t.title}`,
        onchange: async () => {
          const result = await api(`/tasks/${t.id}`, { method: 'PATCH', body: { status: 'done' } });
          toast(result.completion_worklog ? '已完成，已记入案件时间线 ✓' : '已完成 ✓');
          load();
        },
      }),
      el('span', { class: 'box', 'aria-hidden': 'true' })
    ),
    el('span', { class: 't-text' },
      dl !== null && dl < 0 ? el('span', { class: 'warn-glyph', 'aria-hidden': 'true' }, '⚠︎') : null,
      t.title
    ),
    el('span', { class: 't-chips' },
      t.priority === 'high' ? el('span', { class: 'pill crit' }, '优先') : null,
      t.origin !== 'manual' ? el('span', { class: 'pill acc' }, t.origin === 'llm' ? 'AI' : '模板') : null,
      t.plan_date ? el('span', { class: 'chip' }, `计划 ${t.plan_date.slice(5)}`) : null,
      t.due_on ? el('span', { class: dueCls }, `截止 ${t.due_on.slice(5)}`) : null
    ),
    el('span', { class: 't-key tl-actions' },
      el('button', {
        class: 'btn small', type: 'button', 'aria-label': `改期：${t.title}`,
        onclick: async () => {
          const v = await datePrompt({
            title: '改待办日期',
            fields: [
              { key: 'plan_date', label: '计划开工（可空）', value: t.plan_date },
              { key: 'due_on', label: '硬到期（可空）', value: t.due_on },
            ],
          });
          if (!v) return;
          await api(`/tasks/${t.id}`, { method: 'PATCH', body: v });
          toast('日期已改 ✓'); load();
        },
      }, '改期'),
      el('button', {
        class: 'btn small danger', type: 'button', 'aria-label': `删除：${t.title}`,
        onclick: async () => { if (!confirm(`删除待办「${t.title}」？`)) return; await api(`/tasks/${t.id}`, { method: 'DELETE' }); toast('已删除'); load(); },
      }, '删')
    )
  );
}

// ---- 时间线 ----
function tlItem(date, nodeCls, kindPill, bodyEls, actions = null) {
  return el('div', { class: 'tl-item' },
    el('span', { class: `tl-node ${nodeCls}`, 'aria-hidden': 'true' }),
    el('span', { class: 'tl-date' }, date),
    el('div', { class: 'tl-body' }, kindPill, ' ', ...bodyEls),
    actions ? el('span', { class: 'tl-actions' }, actions) : null
  );
}

function attachmentsFor(entity, entityId) {
  const list = (bundle.attachments || []).filter((a) => a.entity === entity && a.entity_id === entityId);
  if (!list.length) return [];
  return [el('div', { class: 't-chips' },
    ...list.map((a) => el('a', {
      class: 'chip',
      href: `/api/cases/${id}/file?path=` + encodeURIComponent(a.rel_path),
      target: '_blank', rel: 'noopener', title: a.rel_path,
    }, a.filename))
  )];
}

function drawTimeline(nextItems = timelineItems) {
  timelineItems = nextItems;
  const sourceTotal = timelineItems.length;
  const filtered = timelineFilter === 'all'
    ? timelineItems
    : timelineItems.filter((item) => item.kind === timelineFilter);
  const total = filtered.length;
  if (total <= TIMELINE_PREVIEW_LIMIT) timelineExpanded = false;

  const visible = timelineExpanded ? filtered : filtered.slice(0, TIMELINE_PREVIEW_LIMIT);
  const tl = document.getElementById('timeline');
  tl.replaceChildren(...visible.map((item) => item.build()));
  if (!total) {
    tl.append(el('div', { class: 'section-empty' },
      el('span', {}, timelineFilter === 'all' ? '还没有记录' : '这个筛选下没有记录'),
      el('button', {
        class: 'btn small panel-quick-action', type: 'button',
        'aria-controls': 'log-form',
        onclick: () => revealRecordForm('log-form'),
      }, '记一条工作日志')
    ));
  }

  document.getElementById('timeline-meta').textContent = timelineFilter === 'all'
    ? (total ? `${total} 条` : '事件 · 期限 · 日志')
    : `${total} / ${sourceTotal} 条`;
  const controls = document.getElementById('timeline-controls');
  const toggle = document.getElementById('timeline-toggle');
  const state = document.getElementById('timeline-visible-meta');
  controls.hidden = total <= TIMELINE_PREVIEW_LIMIT;
  toggle.setAttribute('aria-expanded', String(timelineExpanded));
  if (controls.hidden) {
    toggle.textContent = '展开全部';
    state.textContent = '';
    return;
  }
  toggle.textContent = timelineExpanded
    ? `收起，仅看最近 ${TIMELINE_PREVIEW_LIMIT} 条`
    : `展开全部（${total} 条）`;
  state.textContent = timelineExpanded
    ? `已显示全部 ${total} 条`
    : `已显示最近 ${TIMELINE_PREVIEW_LIMIT} / 共 ${total} 条`;
}

for (const button of document.querySelectorAll('[data-timeline-filter]')) {
  button.addEventListener('click', () => {
    timelineFilter = button.dataset.timelineFilter;
    timelineExpanded = false;
    for (const item of document.querySelectorAll('[data-timeline-filter]')) {
      item.classList.toggle('is-active', item === button);
    }
    drawTimeline();
  });
}

document.getElementById('timeline-toggle').addEventListener('click', (event) => {
  const toggle = event.currentTarget;
  timelineExpanded = !timelineExpanded;
  drawTimeline();
  requestAnimationFrame(() => toggle.scrollIntoView({ behavior: 'auto', block: 'nearest' }));
});

// ---- 渲染 ----
function render() {
  const c = bundle.case;
  document.title = `${c.name} · 案齐`;
  document.getElementById('title').textContent = c.name;
  document.getElementById('subtitle').textContent =
    [c.case_no, c.cause, c.court, c.client && `${c.client}（${c.client_role || '我方'}）`, c.opponent && `对方：${c.opponent}`]
      .filter(Boolean).join(' · ') || '（信息待补——点「编辑案件信息」）';

  // 阶段步进器（点步进节点切换阶段）
  const stageStepper = stepper(bundle.stages, c.stage, async (s) => {
    if (s === c.stage) return;
    if (!confirm(`把阶段从「${c.stage}」切换到「${s}」？`)) return;
    await patchCase({ stage: s }, '阶段已变更 ✓');
  });
  stageStepper.classList.add('stepper-vertical');
  document.getElementById('stepper-box').replaceChildren(stageStepper);
  document.getElementById('c-status').value = c.status;
  const sd = document.getElementById('c-stagedays');
  sd.replaceChildren(`本阶段已停留 ${c.stage_days} 天`);
  if (c.stage_days > 30) sd.append(el('span', { class: 'chip c-amber' }, '偏久 · 考虑推进或核对状态'));

  const ef = document.getElementById('edit-form');
  for (const f of ['name', 'case_no', 'cause', 'court', 'client', 'client_role', 'opponent', 'accepted_at', 'note', 'legalrag_url']) {
    if (ef.elements[f]) ef.elements[f].value = c[f] || '';
  }
  efProc.value = c.procedure;
  syncEditStages(c.stage);
  document.getElementById('legalrag-slot').replaceChildren(
    c.legalrag_url
      ? el('a', { class: 'btn small', href: c.legalrag_url, target: '_blank', rel: 'noopener' }, 'LegalRAG 案件库 ↗')
      : ''
  );

  // 联系人
  const cbox = document.getElementById('contact-list');
  cbox.replaceChildren(...(bundle.contacts || []).map(contactRow));
  if (!(bundle.contacts || []).length) cbox.append(el('div', { class: 'section-empty' }, '尚未登记——当事人、承办法官、法官助理都记在这里'));
  const contacts = bundle.contacts || [];
  const firstContact = (...roles) => contacts.find((contact) => roles.includes(contact.role))?.name || '';
  const contactSummary = [
    `委托人 ${c.client || firstContact('当事人') || '待补'}`,
    `对方 ${c.opponent || firstContact('对方当事人') || '待补'}`,
    `代理人 ${firstContact('合作律师', '对方律师') || '待补'}`,
  ].join(' · ');
  document.getElementById('contact-summary').textContent = contactSummary;

  // 本案期限跑道（母题）
  const today = todayStr();
  const pend = bundle.deadlines
    .filter((x) => x.status === 'pending')
    .map((x) => ({ ...x, days_left: daysTo(x.due_on, today) }))
    .sort((a, b) => a.days_left - b.days_left);

  const nextDeadline = pend[0];
  const deadlineHead = document.getElementById('case-head-deadline');
  deadlineHead.replaceChildren(nextDeadline
    ? el('div', { class: `case-head-deadline-card${nextDeadline.days_left < 0 ? ' is-overdue' : ''}` },
      el('a', { href: '#case-actions' },
        el('span', {}, '下一期限'),
        el('b', {}, nextDeadline.name),
        el('strong', { class: 'num' }, nextDeadline.days_left < 0
          ? `逾期 ${Math.abs(nextDeadline.days_left)} 日`
          : nextDeadline.days_left === 0 ? '今日截止' : `剩 ${nextDeadline.days_left} 日`)
      ),
      editDueBtn(nextDeadline, 'btn small case-head-deadline-action')
    )
    : el('span', { class: 'is-clear' }, '当前无在追期限'));

  document.getElementById('case-runway').replaceChildren(
    pend.length ? caseRunway(pend) : el('div', { class: 'section-empty' }, '无在追死线——录入触发事件或手动记死线')
  );
  document.getElementById('runway-legend').hidden = !pend.length;
  const rwMeta = document.getElementById('runway-meta');
  rwMeta.replaceChildren();
  if (pend.length) {
    const over = pend.filter((x) => x.days_left < 0).length;
    rwMeta.append(
      el('span', {}, '按剩余天数升序'),
      el('span', { class: 'sep' }, '·'),
      el('span', { class: 'm' }, `${pend.length} 项`)
    );
    if (over) rwMeta.append(el('span', { class: 'sep' }, '·'), el('span', { class: 'm hot' }, `${over} 逾期`));
  }

  // 未结待办
  const open = bundle.tasks.filter((t) => t.status === 'open');
  const tbox = document.getElementById('open-tasks');
  tbox.replaceChildren(...open.map(taskRow));
  if (!open.length) tbox.append(el('div', { class: 'section-empty' },
    el('span', {}, '无未结待办'),
    el('button', {
      class: 'btn small panel-quick-action', type: 'button',
      'aria-controls': 'task-form',
      onclick: () => revealRecordForm('task-form'),
    }, '记一条')
  ));
  document.getElementById('tasks-count').textContent = open.length ? `${open.length} 项` : '';
  document.getElementById('case-action-badge').textContent = pend.length + open.length || '';

  // 时间线合流：event / deadline / worklog
  const items = [
    ...bundle.events.map((e) => ({ kind: 'event', date: e.occurred_on, sort2: 2, build: () => tlItem(e.occurred_on, 'tl-node-event',
      el('span', { class: 'pill acc' }, evLabel[e.type] || e.type),
      [
        e.instrument ? el('span', {}, e.instrument, ' ') : null,
        e.service_method ? el('span', { class: 'pill' }, e.service_method) : null,
        e.note ? el('div', { class: 'tl-note' }, e.note) : null,
        ...attachmentsFor('event', e.id),
      ],
      el('span', {},
        el('button', {
          class: 'btn small', type: 'button',
          onclick: async () => {
            const v = await datePrompt({
              title: `改「${evLabel[e.type] || e.type}」日期`,
              hint: '改触发日期会弹级联重算预览；人工设定过的期限默认不动',
              fields: [{ key: 'occurred_on', label: '事件日期', value: e.occurred_on, required: true }],
            });
            const nd = v?.occurred_on;
            if (!nd || nd === e.occurred_on) return;
            const r = await api(`/events/${e.id}`, { method: 'PATCH', body: { occurred_on: nd } });
            if (r.needs_confirm) {
              const msg = [
                `改日期 ${r.event.old_date} → ${r.event.new_date}，将级联重算：`,
                ...r.recalc.map((x) => `  · ${x.name}：${x.old_due} → ${x.new_due}`),
                ...(r.excluded.length ? ['不动（保护）：', ...r.excluded.map((x) => `  · ${x.name}（${x.reason}）`)] : []),
                '确认执行？',
              ].join('\n');
              if (!confirm(msg)) { toast('已取消'); return; }
              await api(`/events/${e.id}`, { method: 'PATCH', body: { occurred_on: nd, confirm: true } });
            }
            toast('日期已改，派生期限已重算 ✓');
            load();
          },
        }, '改日期'),
        el('button', {
          class: 'btn small danger', type: 'button',
          onclick: async () => {
            if (!confirm('删除该事件？')) return;
            await api(`/events/${e.id}`, { method: 'DELETE' });
            toast('已删除'); load();
          },
        }, '删')
      )
    ) })),
    ...bundle.deadlines.map((d) => {
      const overdue = d.status === 'pending' && d.due_on < today;
      const nodeCls = d.status !== 'pending' ? 'tl-node-muted'
        : d.severity === 'critical' ? 'tl-node-crit' : d.severity === 'high' ? 'tl-node-warn' : 'tl-node-ok';
      const buildPill = () => d.status === 'pending'
        ? el('span', { class: `pill ${d.severity === 'critical' ? 'crit' : d.severity === 'high' ? 'warn' : 'ok'}` },
            `死线 · ${SEV_LABEL[d.severity]}${overdue ? ' · 已逾期' : ''}`)
        : el('span', { class: `pill ${d.status === 'done' ? 'ok' : ''}` }, `死线 · ${STATUS_LABEL[d.status]}`);
      return { kind: 'deadline', date: d.due_on, sort2: 1, build: () => tlItem(d.due_on, nodeCls, buildPill(),
        [
          el('b', {}, d.name), ' ',
          d.basis ? el('span', { class: 'tl-note' }, `依据：${d.basis} `) : null,
          d.calc_note ? el('div', { class: 'tl-note' }, `算法：${d.calc_note}`) : null,
          d.is_manual_override ? el('span', { class: 'pill' }, '人工设定') : null,
        ],
        d.status === 'pending' ? el('span', {},
          editDueBtn(d),
          el('button', { class: 'btn small', type: 'button', onclick: async () => { await api(`/deadlines/${d.id}`, { method: 'PATCH', body: { status: 'done' } }); toast('已完成 ✓'); load(); } }, '完成'),
          el('button', { class: 'btn small', type: 'button', onclick: async () => { await api(`/deadlines/${d.id}`, { method: 'PATCH', body: { status: 'waived' } }); toast('已放弃'); load(); } }, '放弃'),
          el('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (!confirm('删除该期限？')) return; await api(`/deadlines/${d.id}`, { method: 'DELETE' }); toast('已删除'); load(); } }, '删')
        ) : null
      ) };
    }),
    ...bundle.worklog.map((w) => ({ kind: 'log', date: w.worked_on, sort2: 3, build: () => tlItem(w.worked_on, 'tl-node-log',
      el('span', { class: 'pill' }, '日志'),
      [w.content, w.minutes ? el('span', { class: 'tl-note' }, `（${w.minutes} 分钟）`) : null,
        w.artifacts ? el('div', { class: 'tl-note' }, `产物：${w.artifacts}`) : null],
      el('span', {},
        el('button', {
          class: 'btn small', type: 'button',
          onclick: async () => {
            const v = await datePrompt({ title: '改日志日期', fields: [{ key: 'worked_on', label: '工作日期', value: w.worked_on, required: true }] });
            if (!v || v.worked_on === w.worked_on) return;
            await api(`/worklog/${w.id}`, { method: 'PATCH', body: v });
            toast('日期已改 ✓'); load();
          },
        }, '改期'),
        el('button', {
          class: 'btn small danger', type: 'button',
          onclick: async () => { if (!confirm('删除该日志？')) return; await api(`/worklog/${w.id}`, { method: 'DELETE' }); toast('已删除'); load(); },
        }, '删')
      )
    ) })),
  ];
  items.sort((a, b) => (b.date + b.sort2).localeCompare(a.date + a.sort2));
  drawTimeline(items);
}

// ---- 案件文件浏览器（读写配置的案件夹）----
// 双向同步：上传 → 直接落案件夹（PUT 即 fs.write，案件夹是唯一真相源）；
//          案件夹被外部改动（外部同步工具）→ SSE 推送，页面自动刷新。
let curDir = '';
// 「新」标记只在**同一目录内**跨轮次比较才有意义：换目录时整目录都没见过，
// 全标新等于没标（实测踩过）。所以把目录和已见集合绑在一起，换目录即重新基线。
let seenDir = null;
let seenFiles = null;
let liveOk = false;     // SSE 是否活着——活着就不轮询（低功耗自托管约束）
let fileProcessTimer = null;
let focusedCandidateRel = '';
let candidateFocusRequest = 0;
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

const FILE_SYNC = {
  observed: ['未解析', 'idle'],
  queued: ['排队中', 'work'],
  registering: ['登记中', 'work'],
  processing: ['解析中', 'work'],
  extracting: ['提取中', 'work'],
  review: ['待确认', 'review'],
  ready: ['已处理', 'ready'],
  failed: ['处理失败', 'fail'],
  missing: ['源文件缺失', 'fail'],
  ignored: ['已忽略', 'idle'],
};

const activeFileStatus = (status) => ['queued', 'registering', 'processing', 'extracting'].includes(status);

function syncBadge(state) {
  if (!state) return el('span', { class: 'file-sync idle' }, '未解析');
  let [label, tone] = FILE_SYNC[state.status] || ['未解析', 'idle'];
  if (state.status === 'ready' && state.screening_decision === 'filtered') {
    label = '智能筛除';
    tone = 'idle';
  }
  const suffix = state.status === 'review' && state.candidate_count ? ` ${state.candidate_count}` : '';
  return el('span', {
    class: `file-sync ${tone}`,
    ...((state.error || state.screening_reason) ? { title: state.error || state.screening_reason } : {}),
  }, label + suffix);
}

async function processFile(rel) {
  await api(`/cases/${id}/files/process`, { body: { rel_path: rel } });
  toast('已进入解析队列');
  await Promise.all([loadFiles(), loadFileCandidates()]);
}

function processButton(rel, state, enabled) {
  if (!enabled) return null;
  if (state?.status === 'review') {
    return el('button', {
      class: 'btn small ok', type: 'button',
      onclick: () => focusFileCandidates(rel),
    }, '查看候选');
  }
  if (activeFileStatus(state?.status)) {
    return el('button', { class: 'btn small', type: 'button', disabled: '' }, '处理中');
  }
  if (state?.status === 'ready') return null;
  return el('button', {
    class: 'btn small', type: 'button',
    onclick: () => processFile(rel),
  }, state?.status === 'failed' ? '重试' : '立即处理');
}

function scheduleFileProcessRefresh(files) {
  clearTimeout(fileProcessTimer);
  if (!files.some((file) => activeFileStatus(file.legalrag?.status))) return;
  fileProcessTimer = setTimeout(async () => {
    await Promise.all([loadFiles(), loadFileCandidates()]);
  }, 2200);
}

function setFileStatus(text, live) {
  const s = document.getElementById('file-status');
  if (!s) return;
  s.textContent = text;
  s.classList.toggle('is-live', !!live);
}

// T2 可见回落提示：secure-files 判定 folder_path 失效、回落到同名目录时，API 只在该次
// 响应里带 workspace_notice。文本一律走 textContent 防 XSS；style.css 属本轮冻结区，
// 复用三皮肤 amber 提示类 .money-notice（同 --amber/--amber-line/--amber-bg token）。
function renderWorkspaceNotice(notice) {
  const prev = document.getElementById('file-workspace-notice');
  if (!notice) { prev?.remove(); return; }
  const text = '⚠ ' + notice;
  if (prev) { prev.textContent = text; return; }
  const box = document.getElementById('file-list');
  const node = el('div', { id: 'file-workspace-notice', class: 'money-notice', role: 'status' });
  node.textContent = text;
  box.before(node);
}

async function loadFiles() {
  const box = document.getElementById('file-list');
  const crumbs = document.getElementById('file-crumbs');
  let d;
  try {
    d = await api(`/cases/${id}/files?dir=` + encodeURIComponent(curDir));
  } catch {
    renderWorkspaceNotice(null);
    box.replaceChildren(el('div', { class: 'section-empty' }, '文件根未配置或不可达'));
    setFileStatus('未连通', false);
    return;
  }
  if (!d.exists) {
    renderWorkspaceNotice(null);
    box.replaceChildren(el('div', { class: 'section-empty' }, '案件夹不存在——核对 §9.3 文件夹名与 cases.name 是否一致'));
    crumbs.textContent = '';
    setFileStatus('无案件夹', false);
    return;
  }
  renderWorkspaceNotice(d.workspace_notice || null);
  // 面包屑
  crumbs.replaceChildren(
    el('a', { href: '#', onclick: (e) => { e.preventDefault(); curDir = ''; loadFiles(); } }, '案件根'),
    ...curDir.split('/').filter(Boolean).map((seg, i, arr) => el('span', {}, ' / ',
      el('a', { href: '#', onclick: (e) => { e.preventDefault(); curDir = arr.slice(0, i + 1).join('/'); loadFiles(); } }, seg)))
  );
  // 上传目录下拉
  const upDir = document.getElementById('up-dir');
  if (!upDir.options.length) {
    for (const w of d.write_dirs) upDir.append(el('option', { value: w }, '→ ' + w));
  }
  const rows = [];
  for (const dir of d.dirs) {
    rows.push(el('div', { class: 'row row-dir' },
      fileIconEl(dir, true),
      el('a', { href: '#', class: 'grow', onclick: (e) => { e.preventDefault(); curDir = curDir ? curDir + '/' + dir : dir; loadFiles(); } }, dir),
      el('span', { class: 'meta nowrap' }, '目录')
    ));
  }
  // 首轮（或刚换目录）不标新：没有可比的基线
  const known = seenDir === curDir ? seenFiles : null;
  const now = new Set(d.files.map((f) => f.name));
  for (const f of d.files) {
    const rel = curDir ? curDir + '/' + f.name : f.name;
    const isNew = known && !known.has(f.name);
    rows.push(el('div', { class: 'row file-row' + (isNew ? ' row-new' : '') },
      fileIconEl(f.name),
      el('a', {
        class: 'grow file-name', href: `/api/cases/${id}/file?path=` + encodeURIComponent(rel),
        target: '_blank', rel: 'noopener',
      }, f.name),
      ...(isNew ? [el('span', { class: 'chip chip-new' }, '新')] : []),
      d.legalrag_enabled ? syncBadge(f.legalrag) : null,
      el('span', { class: 'meta nowrap file-meta' }, `${fmtSize(f.size)} · ${f.mtime}`),
      el('span', { class: 'file-actions' }, processButton(rel, f.legalrag, d.legalrag_enabled))
    ));
  }
  seenDir = curDir;
  seenFiles = now;
  box.replaceChildren(...(rows.length ? rows : [el('div', { class: 'section-empty' }, '（空目录）')]));
  const t = new Date().toTimeString().slice(0, 5);
  setFileStatus(liveOk ? `实时同步中 · ${t}` : `已刷新 ${t}`, liveOk);
  scheduleFileProcessRefresh(d.files);
  return d;
}

function candidateTitle(candidate, payload) {
  if (candidate.kind === 'fee') {
    const amount = payload.amount == null || payload.amount === ''
      ? '金额待定'
      : `¥${Number(payload.amount).toLocaleString('zh-CN')}`;
    return `${payload.label || '收费节点'} · ${amount}`;
  }
  if (candidate.kind === 'event') {
    return `${evLabel[payload.type] || payload.type || '程序事件'} · ${payload.occurred_on || '日期待核'}`;
  }
  return payload.title || payload.content || '提取候选';
}

function candidateSources(candidate) {
  return candidate.sources?.length ? candidate.sources : [candidate];
}

function candidateIncludesFile(candidate, rel) {
  return !!rel && candidateSources(candidate).some((source) => source.rel_path === rel);
}

function candidateCardId(candidate) {
  return `candidate-fact-${candidate.fact_id || candidate.id}`;
}

async function focusFileCandidates(rel) {
  const request = ++candidateFocusRequest;
  focusedCandidateRel = rel;
  const { rows } = await loadFileCandidates();
  // A slower response from an earlier click must never steal scroll/focus from
  // the file the user clicked most recently.
  if (request !== candidateFocusRequest) return;
  const matches = rows.filter((candidate) => candidateIncludesFile(candidate, rel));
  if (!matches.length) {
    focusedCandidateRel = '';
    toast('这份文件当前没有待确认候选，列表已刷新');
    return;
  }
  const target = document.getElementById(candidateCardId(matches[0]));
  // Long candidate lists can make a smooth scroll spend seconds passing unrelated
  // cards. Jump straight to the exact source match, then keep keyboard focus there.
  target?.scrollIntoView({ behavior: 'auto', block: 'start' });
  target?.focus({ preventScroll: true });
  toast(`已定位到这份文件的 ${matches.length} 条候选`);
}

function feeLinkOption(fee) {
  const amount = fee.amount == null ? '金额待定' : `¥${Number(fee.amount).toLocaleString('zh-CN')}`;
  const condition = fee.due_on || fee.node || '未设付款条件';
  const status = fee.status === 'paid' ? '已收' : fee.status === 'waived' ? '减免' : '待收';
  return `#${fee.id} · ${fee.label} · ${amount} · ${condition} · ${status}`;
}

async function linkCandidateFee(candidate) {
  const fees = await api(`/cases/${id}/fees`);
  if (!fees.items?.length) {
    toast('本案还没有可关联的收费记录');
    return;
  }
  const exactIds = new Set((candidate.formal_fee_match?.matches || []).map((fee) => fee.id));
  const ordered = [...fees.items].sort((a, b) => Number(exactIds.has(b.id)) - Number(exactIds.has(a.id)) || a.id - b.id);
  const choice = await datePrompt({
    title: '关联已有收费',
    hint: '这是人工建立的持久关联：不会新增或修改收费；以后其他文件或新版本再次提取同一表述，也不会重新提示。',
    fields: [{
      key: 'fee_item_id',
      label: '本案收费记录',
      value: '',
      type: 'select',
      required: true,
      options: [
        { value: '', label: '请选择要关联的收费' },
        ...ordered.map((fee) => ({
          value: String(fee.id),
          label: `${exactIds.has(fee.id) ? '严格匹配 · ' : ''}${feeLinkOption(fee)}`,
        })),
      ],
    }],
  });
  if (!choice) return;
  await api(`/legalrag/candidates/${candidate.id}/link-fee`, {
    body: { fee_item_id: Number(choice.fee_item_id) },
  });
  toast('已关联现有收费；相同提取今后不再提示');
  await Promise.all([loadFiles(), loadFileCandidates()]);
}

async function acceptCandidate(candidate) {
  const p = candidate.payload || {};
  const sourceHint = candidate.file_count > 1
    ? `${candidate.file_count} 份材料给出同一事实（${candidate.source_count} 条引文）｜请逐条对照下方原文确认。`
    : `${candidate.source_ref}｜请对照下方原文确认。`;
  let edited;
  if (candidate.kind === 'fee') {
    edited = await datePrompt({
      title: '核对并录入收费节点',
      hint: `${sourceHint} 金额与日期可修改。`,
      fields: [
        { key: 'label', label: '收费节点', value: p.label, type: 'text', required: true },
        { key: 'amount', label: '金额（留空表示待定）', value: p.amount ?? '', type: 'text' },
        { key: 'node', label: '付款条件', value: p.node, type: 'text' },
        { key: 'due_on', label: '明确到期日', value: p.due_on || '', type: 'date' },
        { key: 'note', label: '备注', value: p.note || '', type: 'text' },
      ],
    });
  } else if (candidate.kind === 'event') {
    edited = await datePrompt({
      title: '核对并录入程序事件',
      hint: `${sourceHint} 期限不会由模型计算；确认事件后由案齐规则引擎派生。`,
      fields: [
        { key: 'type', label: '事件类型', value: p.type, type: 'select', required: true,
          options: meta.event_types.map((item) => ({ value: item.id, label: item.label })) },
        { key: 'occurred_on', label: '事件日期', value: p.occurred_on, type: 'date', required: true },
        { key: 'service_method', label: '送达方式', value: p.service_method || '', type: 'text' },
        { key: 'instrument', label: '文书依据', value: p.instrument || '', type: 'text' },
        { key: 'note', label: '备注', value: p.note || '', type: 'text' },
      ],
    });
  }
  if (!edited) return;
  const result = await api(`/legalrag/candidates/${candidate.id}/accept`, { body: { payload: edited } });
  toast(result.created?.linked_existing ? '已关联现有记录，没有重复录入' : '已确认录入 ✓');
  await load();
  await loadFileCandidates();
}

function feeMatchNotice(candidate) {
  const match = candidate.formal_fee_match;
  if (match?.state === 'unique') return '发现 1 笔严格匹配的已有收费，可直接关联';
  if (match?.state === 'ambiguous') return `发现 ${match.matches.length} 笔完全相同的已有收费，请明确选择关联对象`;
  return '';
}

function candidateCard(candidate) {
  const p = candidate.payload || {};
  const kindLabel = candidate.kind === 'fee' ? '收费节点' : candidate.kind === 'event' ? '程序事件' : '信息候选';
  const sources = candidateSources(candidate);
  const targeted = candidateIncludesFile(candidate, focusedCandidateRel);
  return el('article', {
    class: `extract-card${targeted ? ' is-targeted' : ''}`,
    id: candidateCardId(candidate),
    tabindex: '-1',
  },
    el('div', { class: 'extract-head' },
      el('span', { class: `extract-kind ${candidate.kind}` }, kindLabel),
      el('span', { class: 'extract-source' }, candidate.file_count > 1
        ? `${candidate.file_count} 份材料 · ${candidate.source_count} 条引文（已合并）`
        : sources.length > 1 ? `${sources.length} 条引文（已合并）` : candidate.source_ref),
      el('span', { class: 'extract-confidence' }, `${Math.round(Number(candidate.confidence || 0) * 100)}%`)
    ),
    el('div', { class: 'extract-main' }, candidateTitle(candidate, p)),
    candidate.kind === 'fee' && feeMatchNotice(candidate)
      ? el('div', { class: 'extract-detail' }, feeMatchNotice(candidate))
      : null,
    candidate.kind === 'fee' && p.node ? el('div', { class: 'extract-detail' }, p.node) : null,
    candidate.kind === 'event' && p.instrument ? el('div', { class: 'extract-detail' }, p.instrument) : null,
    ...sources.map((source) => el('blockquote', { class: 'extract-quote' },
      el('div', { class: 'extract-source' }, `${source.source_ref || candidate.source_ref} · ${Math.round(Number(source.confidence || 0) * 100)}%`),
      `“${source.source_quote || ''}”`
    )),
    el('div', { class: 'extract-actions' },
      el('button', { class: 'btn small', type: 'button', onclick: async () => {
        const decision = await datePrompt({
          title: '不再提示这一事实？',
          hint: '这会同时处理当前全部来源；以后其他文件或新版本再次提到同一事实，也不会重新浮出。可在“已忽略”中恢复。',
          fields: [
            { key: 'reason', label: '忽略原因（可选）', value: '', type: 'text', placeholder: '例如：OCR 误识别、并非本案事实' },
          ],
        });
        if (!decision) return;
        await api(`/legalrag/candidates/${candidate.id}/decline`, { body: decision });
        toast('已不再提示；需要时可从“已忽略”恢复');
        await Promise.all([loadFiles(), loadFileCandidates()]);
      } }, '不再提示'),
      candidate.kind === 'fee'
        ? el('button', { class: 'btn small', type: 'button', onclick: () => linkCandidateFee(candidate) }, '关联已有收费')
        : null,
      el('button', { class: 'btn small primary', type: 'button', onclick: () => acceptCandidate(candidate) }, '核对并录入')
    )
  );
}

function declinedCandidateCard(candidate) {
  const p = candidate.payload || {};
  const sources = candidate.sources?.length ? candidate.sources : [candidate];
  const kindLabel = candidate.kind === 'fee' ? '收费节点' : '程序事件';
  return el('article', { class: 'extract-card' },
    el('div', { class: 'extract-head' },
      el('span', { class: `extract-kind ${candidate.kind}` }, kindLabel),
      el('span', { class: 'extract-source' }, candidate.file_count > 1
        ? `${candidate.file_count} 份材料 · ${candidate.source_count} 条引文`
        : candidate.source_ref),
      el('span', { class: 'extract-confidence' }, '已忽略')
    ),
    el('div', { class: 'extract-main' }, candidateTitle(candidate, p)),
    candidate.decision_reason ? el('div', { class: 'extract-detail' }, `原因：${candidate.decision_reason}`) : null,
    ...sources.map((source) => el('blockquote', { class: 'extract-quote' },
      el('div', { class: 'extract-source' }, `${source.source_ref || candidate.source_ref} · ${Math.round(Number(source.confidence || 0) * 100)}%`),
      `“${source.source_quote || ''}”`
    )),
    el('div', { class: 'extract-actions' },
      el('button', { class: 'btn small primary', type: 'button', onclick: async () => {
        if (!confirm('恢复为待确认后，当前材料中的这条事实会重新出现。确认恢复？')) return;
        await api(`/legalrag/candidate-facts/${candidate.fact_id}/reopen`, { body: {} });
        toast('已恢复为待确认');
        await Promise.all([loadFiles(), loadFileCandidates()]);
      } }, '恢复待确认')
    )
  );
}

async function loadFileCandidates() {
  const wrap = document.getElementById('file-review');
  const box = document.getElementById('file-candidates');
  const ignoredWrap = document.getElementById('file-ignored');
  const ignoredBox = document.getElementById('file-ignored-candidates');
  if (!wrap || !box) return;
  let rows = [];
  let ignored = [];
  try {
    [rows, ignored] = await Promise.all([
      api(`/cases/${id}/legalrag/candidates`),
      api(`/cases/${id}/legalrag/candidates?status=declined`),
    ]);
  } catch { rows = []; ignored = []; }
  if (focusedCandidateRel && !rows.some((candidate) => candidateIncludesFile(candidate, focusedCandidateRel))) {
    focusedCandidateRel = '';
  }
  wrap.hidden = rows.length === 0;
  if (!rows.length) box.replaceChildren();
  else {
    document.getElementById('file-review-meta').textContent = `${rows.length} 条 · 确认后才写入正式台账`;
    box.replaceChildren(...rows.map(candidateCard));
  }
  ignoredWrap.hidden = ignored.length === 0;
  document.getElementById('file-ignored-meta').textContent = `已忽略 ${ignored.length} 条`;
  ignoredBox.replaceChildren(...ignored.map(declinedCandidateCard));
  return { rows, ignored };
}

// 案件夹变更推送：外部（外部同步工具）改了文件，页面自己刷新
function watchFolder() {
  let poll = null;
  let lastSig = null;

  const stopPoll = () => { clearInterval(poll); poll = null; };
  const startPoll = () => {          // SSE 不可用时的降级：只在标签页可见时轮询指纹
    if (poll) return;
    poll = setInterval(async () => {
      if (document.hidden) return;
      try {
        const { sig } = await api(`/cases/${id}/files/sig?dir=` + encodeURIComponent(curDir));
        if (lastSig !== null && sig !== lastSig) await loadFiles();
        lastSig = sig;
      } catch { /* 断网/未配根：下一轮再试 */ }
    }, 12000);
  };

  let es;
  const onVisibility = () => { if (!document.hidden) loadFiles(); };
  try { es = new EventSource(`/api/cases/${id}/files/events`); } catch {
    startPoll();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stopPoll(); document.removeEventListener('visibilitychange', onVisibility); };
  }

  es.addEventListener('ready', (e) => {
    const d = JSON.parse(e.data || '{}');
    liveOk = !!d.watching;
    if (liveOk) stopPoll(); else startPoll();   // 服务端 watch 起不来 → 轮询兜底
    setFileStatus(liveOk ? '实时同步中' : '已刷新', liveOk);
  });
  es.addEventListener('degraded', () => { liveOk = false; startPoll(); });
  es.addEventListener('change', () => { loadFiles(); });
  es.onerror = () => { liveOk = false; startPoll(); };  // EventSource 自己会重连，轮询只是保底

  // 从 Finder 拖完文件切回浏览器——立刻对一次，不等推送
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    stopPoll();
    es.close();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

async function uploadInto(files, dir) {
  let ok = 0;
  let queued = 0;
  for (const f of files) {
    try {
      const result = await uploadFile(f, { dir });
      ok++;
      if (result.legalrag && result.legalrag.status !== 'failed') queued++;
    }
    catch (err) { toast('❌ ' + f.name + '：' + err.message, 3200); }
  }
  if (ok) toast(`已上传 ${ok} 份 → ${dir}/${queued ? `，${queued} 份已进解析队列` : '（案件夹同步中）'}`);
  curDir = dir;
  await Promise.all([loadFiles(), loadFileCandidates()]);
}

document.getElementById('up-btn').addEventListener('click', async () => {
  const input = document.getElementById('up-files');
  const files = [...(input.files || [])];
  if (!files.length) { toast('先选择文件'); return; }
  await uploadInto(files, document.getElementById('up-dir').value || '法院文书');
  input.value = '';
});

document.getElementById('file-refresh')?.addEventListener('click', () => loadFiles());

// 拖拽入夹：拖到文件面板 = 上传到当前上传目录
const drop = document.getElementById('file-drop');
if (drop) {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;
  drop.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    stop(e);
    dragDepth += 1;
    drop.classList.add('dropping');
  });
  drop.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    stop(e);
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    drop.classList.add('dropping');
  });
  drop.addEventListener('dragleave', (e) => {
    if (!drop.classList.contains('dropping')) return;
    stop(e);
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) drop.classList.remove('dropping');
  });
  drop.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    stop(e);
    dragDepth = 0;
    drop.classList.remove('dropping');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) await uploadInto(files, document.getElementById('up-dir').value || '法院文书');
  });
}

async function load() {
  bundle = await api(`/cases/${id}`);
  render();
  await Promise.all([loadFees(), loadShares(), loadWorkspacePicker()]);
  await Promise.all([loadFiles(), loadFileCandidates()]);
}

document.addEventListener('anjian:changed', load);
await load();
stopFolderWatch = watchFolder();

// AI 助理抽屉：counts.agent=false（未启用/未配置）时 mountAgentDrawer() 自己
// 整块不渲染（特性探测模式同 nav.js 对 c.llm 的既有用法），本文件不重复判断。
mountAgentDrawer(Number(id));
