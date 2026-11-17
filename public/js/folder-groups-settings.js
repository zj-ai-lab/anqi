// 设置页「案件文件夹分组」面板：GET /api/case-folders 取现状，PUT /api/case-folder-groups 整体保存。
// 只编辑草稿，按「保存分组设置」才落库；服务端负责全部把关（分组已绑案件、旧路径同前缀、
// 分组下还有案件时不能移除），这里的禁用只是提前提示，不替代服务端校验。
import { api, el, toast } from './api.js';
import { CASE_TYPES } from './case-types.js';

export function mountFolderGroupSettings() {
  const panel = document.getElementById('folder-groups-panel');
  if (!panel) return;
  const state = document.getElementById('folder-groups-state');
  const list = document.getElementById('folder-groups-list');
  const input = document.getElementById('folder-group-new');
  const candidates = document.getElementById('folder-group-candidates');
  const addButton = document.getElementById('folder-group-add');
  const defaultsGrid = document.getElementById('folder-group-defaults');
  const saveButton = document.getElementById('folder-groups-save');

  let payload = null;
  let draft = { groups: [], defaults: {} };

  const caseCountOf = (name) => payload?.groups?.find((group) => group.name === name)?.case_count || 0;

  function setEnabled(enabled) {
    for (const control of [input, addButton, saveButton]) control.disabled = !enabled;
  }

  function render() {
    list.replaceChildren();
    if (!draft.groups.length) {
      list.append(el('p', { class: 'page-sub' }, '还没有分组：案件夹都直接放在案件文件夹位置下面。'));
    }
    // 事实条：「分组」/ 名称与状态 / 移除。分组下还有案件时不给移除按钮，状态里写明原因。
    const strip = el('div', { class: 'factstrip' });
    for (const name of draft.groups) {
      const count = caseCountOf(name);
      const known = payload?.groups?.find((group) => group.name === name);
      const status = !known ? '待保存'
        : count > 0 ? `已有 ${count} 个案件（先把它们换绑出去才能移除）`
          : known.exists ? '还没有案件' : '文件夹还不存在，建第一个案件时自动创建';
      const action = count > 0 ? el('span') : el('button', {
        class: 'factstrip-edit',
        type: 'button',
        'aria-label': `移除分组 ${name}`,
        onclick: () => {
          draft.groups = draft.groups.filter((item) => item !== name);
          for (const [type, group] of Object.entries(draft.defaults)) if (group === name) delete draft.defaults[type];
          render();
        },
      }, '移除');
      strip.append(el('div', { class: 'factstrip-row' },
        el('span', { class: 'factstrip-label' }, '分组'),
        el('span', { class: 'factstrip-fact', title: `${name}/ · ${status}` }, `${name}/ · ${status}`),
        action));
    }
    if (draft.groups.length) list.append(strip);

    candidates.replaceChildren();
    const taken = new Set(draft.groups);
    for (const folder of payload?.folders || []) {
      if (!folder.group && folder.bound_case_id == null && !taken.has(folder.name)) {
        candidates.append(el('option', { value: folder.name }));
      }
    }

    defaultsGrid.replaceChildren();
    for (const type of CASE_TYPES) {
      const select = el('select', {
        'aria-label': `${type}案件的默认分组`,
        onchange: (event) => {
          if (event.target.value) draft.defaults[type] = event.target.value;
          else delete draft.defaults[type];
        },
      }, el('option', { value: '' }, '不分组（文件根下）'), ...draft.groups.map((name) => el('option', { value: name }, `${name}/`)));
      select.value = draft.defaults[type] || '';
      select.disabled = !payload?.configured;
      defaultsGrid.append(el('label', { class: 'f' }, type, select));
    }
  }

  function load(next) {
    payload = next;
    draft = { groups: [...(next.groups || []).map((group) => group.name)], defaults: { ...(next.defaults || {}) } };
    state.textContent = next.configured ? `${draft.groups.length} 个分组` : '未配置案件文件根';
    setEnabled(!!next.configured);
    render();
  }

  addButton.addEventListener('click', () => {
    const name = input.value.trim();
    if (!name) { toast('先填分组文件夹名'); return; }
    if (name.includes('/') || name.includes('\\') || name.startsWith('.')) { toast('分组名是一个文件夹名，不能含 / 或以 . 开头'); return; }
    if (!draft.groups.includes(name)) draft.groups.push(name);
    input.value = '';
    render();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); addButton.click(); }
  });

  saveButton.addEventListener('click', async () => {
    saveButton.disabled = true;
    try {
      const next = await api('/case-folder-groups', { method: 'PUT', body: draft });
      load(next);
      toast('分组设置已保存');
    } catch {
      /* api() 已显示服务端错误（例如分组下还有案件） */
    } finally {
      saveButton.disabled = !payload?.configured;
    }
  });

  api('/case-folders').then(load).catch((error) => {
    state.textContent = '暂不可用';
    setEnabled(false);
    list.replaceChildren(el('p', { class: 'page-sub' }, `案件文件根暂不可用：${error.message || error}`));
  });
}
