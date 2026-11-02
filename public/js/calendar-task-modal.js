import { api, el, toast } from './api.js';
import { openModal } from './modal.js';
import { caseColorStyle } from './calendar-ui.js';
import { settleTask } from './record-actions.js';

let modalSeq = 0;

const PRIORITY_OPTIONS = [['high', '优先'], ['normal', '普通'], ['low', '低']];

// 待办弹层（日历 / 今日 / 案件页共用）：标题、优先级、日期、备注可改；挂靠案件只读。
// 所有写入走既有 tasks PATCH，只提交改过的字段。
// showCaseLink=false：已在该案件页里打开时不再给「打开案件」。
export function openTaskModal(task, { onChanged, showCaseLink = true } = {}) {
  return new Promise((resolve) => {
    const inputs = {};
    const titleId = `task-modal-title-${++modalSeq}`;
    const isOpen = (task.status || 'open') === 'open';
    const run = async (fn) => {
      try {
        await fn();
      } catch (error) {
        // api() already exposes HTTP failures as a toast; this catches only non-HTTP failures.
        if (!error.status) toast('❌ ' + error.message);
      }
    };

    inputs.title = el('input', {
      type: 'text', value: task.title || '', required: '', 'aria-label': '待办标题',
    });
    inputs.priority = el('select', { 'aria-label': '优先级' },
      ...PRIORITY_OPTIONS.map(([value, label]) => el('option', { value }, label)));
    inputs.priority.value = task.priority || 'normal';
    inputs.plan_date = el('input', {
      type: 'date', value: task.plan_date || '', 'aria-label': '计划开工日',
    });
    inputs.due_on = el('input', {
      type: 'date', value: task.due_on || '', 'aria-label': '硬到期日',
    });
    inputs.due_time = el('input', {
      type: 'time', value: task.due_time || '', step: '60', 'aria-label': '截止时刻',
    });
    inputs.note = el('textarea', { rows: '3', 'aria-label': '备注', placeholder: '无备注' });
    inputs.note.value = task.note || '';

    // 与打开时相比改了哪些字段；标题清空返回 null（不许存空标题）
    const changes = () => {
      const title = inputs.title.value.trim();
      if (!title) { inputs.title.focus(); return null; }
      const out = {};
      if (title !== (task.title || '')) out.title = title;
      if (inputs.priority.value !== (task.priority || 'normal')) out.priority = inputs.priority.value;
      if (inputs.note.value !== (task.note || '')) out.note = inputs.note.value;
      const dueOn = inputs.due_on.value;
      const dueTime = dueOn ? inputs.due_time.value : '';
      if (inputs.plan_date.value !== (task.plan_date || '') || dueOn !== (task.due_on || '')
        || dueTime !== (task.due_time || '')) {
        Object.assign(out, { plan_date: inputs.plan_date.value, due_on: dueOn, due_time: dueTime });
      }
      return out;
    };

    const patchTask = (body, message) => run(async () => {
      const updated = await api(`/tasks/${task.id}`, { method: 'PATCH', body });
      modal.close(updated);
      toast(message);
      await onChanged?.(updated);
    });
    // 完成 / 放弃：连同没保存的修改一起提交，提示条带「撤销」
    const settle = (status) => {
      const extra = changes();
      if (!extra) return;
      run(async () => {
        await settleTask(task, status, async (updated) => {
          modal.close(updated);
          await onChanged?.(updated);
        }, extra);
      });
    };

    const caseName = task.case_name || '不挂案件';
    const caseSummary = el('div', { class: 'task-modal-case' },
      el('span', { class: 'case-dot', style: caseColorStyle(task.case_id), 'aria-hidden': 'true' }),
      el('span', { class: 'task-modal-case-name' }, caseName)
    );

    const save = el('button', { class: 'btn primary', type: 'submit' }, '保存');
    const statusActions = isOpen
      ? [
        el('button', {
          class: 'btn ok', type: 'button', 'aria-label': `完成待办：${task.title}`,
          onclick: () => settle('done'),
        }, '完成'),
        el('button', {
          class: 'btn danger', type: 'button', 'aria-label': `放弃待办：${task.title}`,
          onclick: () => settle('dropped'),
        }, '放弃'),
        el('button', {
          class: 'btn', type: 'button', 'aria-label': `取消排期：${task.title}`,
          ...(!task.plan_date && !task.due_on ? { disabled: '' } : {}),
          onclick: () => patchTask({ plan_date: '', due_on: '' }, '已取消排期，待办回到托盘 ✓'),
        }, '取消排期'),
      ]
      : [
        el('button', {
          class: 'btn ok', type: 'button', 'aria-label': `重新打开待办：${task.title}`,
          onclick: () => {
            const extra = changes();
            if (extra) patchTask({ ...extra, status: 'open' }, '已重新打开 ✓');
          },
        }, '重新打开'),
      ];
    const openCase = task.case_id && showCaseLink
      ? el('a', {
        class: 'btn task-modal-open-case', href: `/case.html?id=${task.case_id}`,
      }, '打开案件')
      : null;

    const form = el('form', {
      class: 'dmodal-form task-modal-form',
      onsubmit: (e) => {
        e.preventDefault();
        const body = changes();
        if (!body) return;
        if (!Object.keys(body).length) { modal.close(null); return; }
        patchTask(body, '已保存 ✓');
      },
    },
      el('h3', { class: 'dmodal-title', id: titleId },
        isOpen ? '待办' : `待办 · ${task.status === 'done' ? '已完成' : '已放弃'}`),
      el('label', { class: 'f' }, '标题', inputs.title),
      caseSummary,
      el('div', { class: 'task-modal-dates' },
        el('label', { class: 'f' }, '计划开工日', inputs.plan_date),
        el('label', { class: 'f' }, '硬到期日', inputs.due_on),
        el('label', { class: 'f' }, '截止时刻', inputs.due_time)
      ),
      el('label', { class: 'f' }, '优先级', inputs.priority),
      el('label', { class: 'f' }, '备注', inputs.note),
      el('div', { class: 'dmodal-actions task-modal-actions' },
        save, ...statusActions, openCase
      )
    );

    const dialog = el('div', {
      class: 'dmodal task-modal',
    }, form);

    const modal = openModal(dialog, {
      labelledBy: titleId,
      initialFocus: () => inputs.title,
      onClose: resolve,
    });

    // 保留案件跳转的既有行为，同时让共享 Modal 负责清理焦点和 inert。
    dialog.querySelector('.task-modal-open-case')?.addEventListener('click', () => modal.close(null));
  });
}
