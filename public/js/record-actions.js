// 「完成 / 放弃」这类一点就生效的动作统一走这里：落库后提示条带「撤销」。
// 误点是这类按钮最常见的事故——期限是法定事实，点掉后会从跑道、日历上消失。
// 撤销 = 当没点过：状态退回原值；待办完成时自动写的那条留痕日志一并删掉。
import { api, toast, toastUndo } from './api.js';

const taskDoneMsg = (r) => r.completion_worklog
  ? (r.case_id ? '已完成，已记入案件时间线 ✓' : '已完成，已记入工作日志 ✓')
  : '已完成 ✓';

// extra：同一次 PATCH 里顺带提交的其它字段（任务弹层里没保存的修改）
export async function settleTask(task, status, onChanged, extra = {}) {
  const updated = await api(`/tasks/${task.id}`, { method: 'PATCH', body: { ...extra, status } });
  const log = updated.completion_worklog;
  toastUndo(status === 'done' ? taskDoneMsg(updated) : '已放弃 ✓', async () => {
    const reverted = await api(`/tasks/${task.id}`, { method: 'PATCH', body: { status: 'open' } });
    if (log) await api(`/worklog/${log.id}`, { method: 'DELETE' });
    toast('已撤销');
    await onChanged?.(reverted);
  });
  await onChanged?.(updated);
  return updated;
}

export async function settleDeadline(d, status, onChanged) {
  const updated = await api(`/deadlines/${d.id}`, { method: 'PATCH', body: { status } });
  toastUndo(status === 'done' ? '已完成 ✓' : '已放弃', async () => {
    await api(`/deadlines/${d.id}`, { method: 'PATCH', body: { status: 'pending' } });
    toast('已撤销');
    await onChanged?.();
  });
  await onChanged?.(updated);
  return updated;
}
