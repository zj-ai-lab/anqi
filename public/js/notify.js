import { api, el, toast } from './api.js';

const statusLabel = { queued: '待看', shown: '已看', expired: '错过', failed: '发送失败', unknown: '结果不明', sent: '已发送', preview: '模拟' };
let mounted = false;

function localTime(iso) {
  try { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; }
}

export function mountNotifications(nav) {
  if (mounted) return; mounted = true;
  const badge = el('span', { class: 'notify-count', hidden: '' });
  const button = el('button', { class: 'iconbtn notify-button', type: 'button', title: '提醒', 'aria-label': '提醒', 'aria-expanded': 'false' }, '🔔', badge);
  const enable = el('button', { class: 'btn small', type: 'button' }, '开启通知');
  const permission = el('span', { class: 'notify-permission' }, '通知权限：未开启 ', enable);
  const state = el('div', { class: 'notify-state' }, permission);
  const list = el('div', { class: 'notify-list' }, el('span', { class: 'muted' }, '暂无提醒'));
  const allRead = el('button', { class: 'btn ghost small', type: 'button' }, '全部标为已看');
  const dropdown = el('div', { class: 'notify-dropdown', hidden: '' }, state, allRead, list);
  const wrap = el('div', { class: 'notify-wrap' }, button, dropdown);
  nav.querySelector('.spacer')?.after(wrap);

  let current = [];
  function paintPermission() {
    if (!('Notification' in window)) { permission.textContent = '本端不支持浏览器通知（页内铃铛仍可用）'; return; }
    if (Notification.permission === 'denied') permission.textContent = '通知权限已拒绝，请在浏览器设置中允许';
    else if (Notification.permission === 'granted') permission.textContent = '通知权限：已开启';
    else { permission.textContent = '通知权限：未开启 '; permission.append(enable); }
  }
  async function requestPermission() {
    if (!('Notification' in window)) return;
    const result = await Notification.requestPermission(); paintPermission();
    if (result === 'granted') toast('浏览器通知已开启');
  }
  enable.addEventListener('click', (event) => { event.stopPropagation(); requestPermission(); });
  function paintList(rows) {
    current = rows;
    list.replaceChildren(...(rows.length ? rows : [el('span', { class: 'muted' }, '暂无提醒')]).map((row) => {
      if (!row.id) return row;
      const link = row.case_id ? el('a', { href: `/case.html?id=${row.case_id}` }, row.case_name || '案件') : el('span', {}, '未挂案件');
      return el('div', { class: 'notify-item' }, el('div', {}, el('strong', {}, row.title), el('small', {}, ` · ${localTime(row.fire_at)}`)), el('div', {}, link, el('span', { class: `notify-status ${row.status}` }, statusLabel[row.status] || row.status)));
    }));
    const queued = rows.filter((row) => row.status === 'queued').length;
    badge.textContent = queued ? String(queued) : ''; badge.hidden = !queued;
  }
  async function refresh() {
    try { const [rows, info] = await Promise.all([api('/notifications?channel=inapp&limit=20'), api('/notifications/status')]); paintList(rows); state.classList.toggle('disabled', !info.enabled); if (!info.enabled) state.append(el('span', { class: 'notify-off' }, '提醒已关闭')); paintPermission(); } catch { /* page remains usable offline */ }
  }
  allRead.addEventListener('click', async () => { for (const row of current.filter((x) => x.status === 'queued')) await api(`/notifications/${row.id}/ack`, { method: 'POST' }).catch(() => {}); refresh(); });
  button.addEventListener('click', (event) => { event.stopPropagation(); const open = dropdown.hidden; dropdown.hidden = !open; button.setAttribute('aria-expanded', String(open)); if (open) refresh(); });
  document.addEventListener('click', (event) => { if (!wrap.contains(event.target)) dropdown.hidden = true; });
  refresh();
  if (window.EventSource) {
    const stream = new EventSource('/api/notifications/stream');
    stream.addEventListener('reminder', (event) => {
      const row = JSON.parse(event.data); toast(row.title || '有新的提醒');
      if (window.Notification?.permission === 'granted') {
        const n = new Notification(row.title || '案齐提醒', { body: row.body || '', tag: `anqi-${row.id}` });
        n.onclick = () => { window.focus(); if (row.case_id) window.location.href = `/case.html?id=${row.case_id}`; };
      }
      api(`/notifications/${row.id}/ack`, { method: 'POST' }).catch(() => {}); refresh();
    });
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
