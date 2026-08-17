import { api, el, toast } from './api.js';
import { caseColorStyle } from './calendar-ui.js';

let modalSeq = 0;

// 日历任务的处理弹层：日期可改，任务/案件事实只读；所有写入仍走既有 tasks PATCH。
export function openTaskModal(task, { onChanged } = {}) {
  return new Promise((resolve) => {
    const inputs = {};
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const titleId = `task-modal-title-${++modalSeq}`;
    let inertedBackground = [];
    let closed = false;

    const close = (value = null) => {
      if (closed) return;
      closed = true;
      overlay.remove();
      for (const node of inertedBackground) node.inert = false;
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      resolve(value);
    };

    const handleModalKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
      if (e.key !== 'Tab') return;
      const focusable = [...form.querySelectorAll(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter((node) => node.getClientRects().length && node.getAttribute('aria-hidden') !== 'true');
      if (!focusable.length) { e.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    const patchTask = async (body, message) => {
      try {
        const updated = await api(`/tasks/${task.id}`, { method: 'PATCH', body });
        close(updated);
        toast(typeof message === 'function' ? message(updated) : message);
        await onChanged?.(updated);
      } catch (error) {
        // api() already exposes HTTP failures as a toast; this catches only non-HTTP failures.
        if (!error.status) toast('❌ ' + error.message);
      }
    };

    const note = el('div', { class: 'task-modal-note-value' }, task.note || '无备注');
    const caseName = task.case_name || '不挂案件';
    const caseSummary = el('div', { class: 'task-modal-case' },
      el('span', { class: 'case-dot', style: caseColorStyle(task.case_id), 'aria-hidden': 'true' }),
      el('span', { class: 'task-modal-case-name' }, caseName)
    );
    inputs.plan_date = el('input', {
      type: 'date', value: task.plan_date || '', 'aria-label': '计划开工日',
    });
    inputs.due_on = el('input', {
      type: 'date', value: task.due_on || '', 'aria-label': '硬到期日',
    });
    inputs.due_time = el('input', {
      type: 'time', value: task.due_time || '', step: '60', 'aria-label': '截止时刻',
    });

    const complete = el('button', {
      class: 'btn ok', type: 'button',
      'aria-label': `完成待办：${task.title}`,
      ...(task.status === 'done' ? { disabled: '' } : {}),
      onclick: () => patchTask({ status: 'done' }, (updated) =>
        updated.completion_worklog
          ? (updated.case_id ? '已完成，已记入案件时间线 ✓' : '已完成，已记入工作日志 ✓')
          : '已完成 ✓'
      ),
    }, '完成');
    const drop = el('button', {
      class: 'btn danger', type: 'button',
      'aria-label': `放弃待办：${task.title}`,
      ...(task.status === 'dropped' ? { disabled: '' } : {}),
      onclick: () => patchTask({ status: 'dropped' }, '已放弃 ✓'),
    }, '放弃');
    const reschedule = el('button', {
      class: 'btn primary', type: 'submit', 'aria-label': `改期：${task.title}`,
    }, '改期');
    const cancelSchedule = el('button', {
      class: 'btn', type: 'button', 'aria-label': `取消排期：${task.title}`,
      ...(!task.plan_date && !task.due_on ? { disabled: '' } : {}),
      onclick: () => patchTask({ plan_date: '', due_on: '' }, '已取消排期，待办回到托盘 ✓'),
    }, '取消排期');
    const openCase = task.case_id
      ? el('a', {
        class: 'btn task-modal-open-case', href: `/case.html?id=${task.case_id}`,
        onclick: () => close(null),
      }, '打开案件')
      : null;

    const form = el('form', {
      class: 'dmodal-form task-modal-form',
      onsubmit: (e) => {
        e.preventDefault();
        const dueOn = inputs.due_on.value;
        patchTask({
          plan_date: inputs.plan_date.value,
          due_on: dueOn,
          due_time: dueOn ? inputs.due_time.value : '',
        }, '排期已更新 ✓');
      },
    },
      el('h3', { class: 'dmodal-title', id: titleId }, task.title),
      caseSummary,
      el('div', { class: 'task-modal-dates' },
        el('label', { class: 'f' }, '计划开工日', inputs.plan_date),
        el('label', { class: 'f' }, '硬到期日', inputs.due_on),
        el('label', { class: 'f' }, '截止时刻', inputs.due_time)
      ),
      el('div', { class: 'task-modal-note' },
        el('span', { class: 'task-modal-note-label' }, '备注'), note
      ),
      el('div', { class: 'dmodal-actions task-modal-actions' },
        complete, drop, reschedule, cancelSchedule, openCase
      )
    );

    const overlay = el('div', {
      class: 'dmodal-overlay',
      onclick: (e) => { if (e.target === overlay) close(null); },
      onkeydown: handleModalKey,
    }, el('div', {
      class: 'dmodal task-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
    }, form));

    document.body.appendChild(overlay);
    inertedBackground = [...document.body.children].filter((node) => node !== overlay && !node.inert);
    for (const node of inertedBackground) node.inert = true;
    inputs.plan_date.focus();
  });
}
