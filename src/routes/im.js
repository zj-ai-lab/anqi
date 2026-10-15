import { Router } from 'express';
import { audit } from '../db.js';

export function createImRouter(hub) {
  const r = Router();
  r.get('/im/wecom/status', (req, res) => res.json(hub.status()));
  r.post('/im/wecom/bind/start', (req, res) => {
    const result = hub.bindStart(req.actor);
    if (result?.error) return res.status(409).json({ error: result.error });
    res.json(result);
  });
  r.post('/im/wecom/unbind', (req, res) => { const result = hub.unbind(req.actor); res.json(result); });
  r.post('/im/wecom/reconnect', (req, res) => {
    if (!hub.reconnect()) return res.status(409).json({ error: 'im_not_reconnectable' });
    audit(req.actor, 'im-reconnect', 'im-binding', 0, 'provider=wecom'); res.json({ ok: true });
  });
  r.post('/im/wecom/test', async (req, res) => {
    const status = hub.status();
    if (!status.enabled || !status.credentials.configured || !status.binding.bound || status.connection.state !== 'ready') return res.status(409).json({ error: 'im_not_ready' });
    const result = await hub.test();
    audit(req.actor, 'im-test', 'im-binding', 0, `provider=wecom status=${result.status}`);
    res.json(result);
  });
  return r;
}

export default createImRouter;
