import { utcIsoToBeijing } from '../reminder-plan.js';

export function createWecomChannel({ hub, timeoutMs = 15000 } = {}) {
  return {
    id: 'wecom', label: '企业微信',
    configured() { return hub.reminderMode() !== 'off' && hub.hasCredentials() && hub.isBound(); },
    async deliver(row) {
      const mode = hub.reminderMode();
      const body = String(row.body || row.title || '');
      if (mode === 'preview') return { status: 'preview', detail: `${body.length}字` };
      const local = utcIsoToBeijing(row.fire_at);
      const text = `⏰ 案齐提醒\n${body}\n${local.date} ${local.time}`;
      const send = Promise.resolve(hub.sendToOwner(text));
      const result = await Promise.race([send, new Promise((resolve) => setTimeout(() => resolve({ status: 'unknown', detail: 'timeout' }), timeoutMs))]);
      return result?.status ? result : { status: 'unknown', detail: 'timeout' };
    },
  };
}

export default createWecomChannel;
