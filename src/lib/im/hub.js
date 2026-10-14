import crypto from 'node:crypto';
import { db as defaultDb, audit } from '../../db.js';
import { decryptSecret, resolveMasterKey } from '../secret-box.js';
import { settingsEvents } from '../settings-events.js';
import { createWecomTransport } from './wecom-transport.js';
import { createAgentBridge } from './agent-bridge.js';

const iso = (now) => new Date(typeof now === 'function' ? now() : now).toISOString();
const readRows = (db) => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((r) => [r.key, String(r.value ?? '')]));
const maskUserid = (value) => { const s = String(value || ''); return s ? `${s.slice(0, 2)}***${s.slice(-1)}` : ''; };
const challengeNormalize = (text) => String(text || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();

export function createImHub({ db = defaultDb, supervisor, env = process.env, transportFactory = createWecomTransport, now = () => new Date() } = {}) {
  let transport = null;
  let bridge = null;
  let settings = {};
  let challenge = null;
  let pruneTimer = null;
  let unsubscribeSettings;
  const counters = { ignored: 0, prompted: 0, answered: 0, unsupported: 0, failed: 0 };
  const state = { state: 'disabled', since: iso(now), lastError: '' };
  const nowMs = () => new Date(typeof now === 'function' ? now() : now).getTime();

  function credentials() {
    const envBot = String(env.ANJIAN_WECOM_BOT_ID || '').trim();
    const envSecret = String(env.ANJIAN_WECOM_BOT_SECRET || '');
    if (envBot || envSecret) return { botId: envBot, secret: envSecret, source: 'env' };
    let secret = '';
    const encrypted = settings.im_wecom_secret_encrypted || '';
    if (encrypted) { try { secret = decryptSecret(encrypted, resolveMasterKey()); } catch { secret = ''; } }
    return { botId: String(settings.im_wecom_bot_id || '').trim(), secret, source: secret ? 'stored' : 'none' };
  }
  function enabled() { return settings.im_wecom_enabled === 'true'; }
  function botId() { return credentials().botId; }
  function hasCredentials() { const c = credentials(); return Boolean(c.botId && c.secret); }
  function reminderMode() { return ['off', 'preview', 'live'].includes(settings.im_wecom_remind_mode) ? settings.im_wecom_remind_mode : 'preview'; }
  function binding() { const row = db.prepare("SELECT * FROM im_bindings WHERE provider='wecom'").get(); return row && row.bot_id === botId() ? row : null; }
  function isBound() { return Boolean(binding()); }
  function setState(next, error = '') { const previous = state.state; state.state = next; if (previous !== next) state.since = iso(now); if (error) state.lastError = String(error.message || error).slice(0, 500); }
  function currentConfig() { return { ...settings, ...credentials() }; }
  async function stopTransport() { if (transport) { try { transport.disconnect(); } catch {} } transport = null; }
  function wireTransport(instance) {
    instance.on('state', (value) => { state.state = value.state; state.since = value.since; state.lastError = value.lastError || state.lastError; });
    instance.on('error', (error) => setState('error', error));
    instance.on('message', (message) => { handleMessage(message).catch((error) => { setState('error', error); counters.failed += 1; }); });
  }
  async function reload() {
    settings = readRows(db);
    const shouldRun = enabled() && hasCredentials();
    if (!shouldRun) { await stopTransport(); setState('disabled'); return; }
    const c = credentials();
    if (transport && transport._configKey === `${c.botId}:${c.secret}:${env.ANJIAN_WECOM_WS_URL || ''}`) return;
    await stopTransport();
    transport = transportFactory({ botId: c.botId, secret: c.secret, wsUrl: env.ANJIAN_WECOM_WS_URL || undefined, now: () => new Date(now()).getTime() });
    transport._configKey = `${c.botId}:${c.secret}:${env.ANJIAN_WECOM_WS_URL || ''}`;
    wireTransport(transport);
    setState('connecting');
    transport.connect();
  }
  async function start() {
    settings = readRows(db);
    unsubscribeSettings = (keys) => { if (keys.some((key) => key.startsWith('im_wecom_'))) reload().catch((e) => setState('error', e)); };
    settingsEvents.on('changed', unsubscribeSettings);
    pruneTimer = setInterval(prune, 24 * 3600_000); pruneTimer.unref?.();
    prune();
    await reload();
  }
  async function stop() { if (unsubscribeSettings) settingsEvents.off('changed', unsubscribeSettings); if (pruneTimer) clearInterval(pruneTimer); pruneTimer = null; await stopTransport(); setState('disabled'); }
  function prune() { const cutoff = new Date(nowMs() - 7 * 24 * 3600_000).toISOString(); db.prepare('DELETE FROM im_inbound WHERE received_at < ?').run(cutoff); }
  function newChallenge() {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let suffix = ''; for (let i = 0; i < 8; i += 1) suffix += alphabet[crypto.randomInt(alphabet.length)];
    const code = `绑定 ${suffix}`; challenge = { code, hash: crypto.createHash('sha256').update(challengeNormalize(code)).digest('hex'), expiresAt: nowMs() + 10 * 60_000 };
    return { code, expires_at: new Date(challenge.expiresAt).toISOString() };
  }
  function startBind(actor = 'web') { if (state.state !== 'ready') return { error: 'im_not_ready' }; const result = newChallenge(); audit(actor, 'im-bind-start', 'im-binding', 0, 'provider=wecom'); return result; }
  function unbind(actor = 'web') { db.prepare("DELETE FROM im_bindings WHERE provider='wecom'").run(); audit(actor, 'im-unbind', 'im-binding', 0, 'provider=wecom'); return { ok: true }; }
  function reconnect() { if (!['kicked', 'auth_failed', 'error'].includes(state.state)) return false; transport?.connect(); return true; }
  async function reply(message, text, finish = true) { if (!transport) return { status: 'failed', detail: 'not_connected' }; return transport.replyStream(message.frame, `stream-${message.msgid}`, text, finish); }
  async function bindOrRoute(message) {
    const text = challengeNormalize(message.text);
    if (challenge && nowMs() <= challenge.expiresAt && crypto.createHash('sha256').update(text).digest('hex') === challenge.hash && message.chattype === 'single') {
      const old = db.prepare("SELECT version FROM im_bindings WHERE provider='wecom'").get();
      db.prepare("INSERT INTO im_bindings(provider,userid,bot_id,bound_at,version) VALUES ('wecom',?,?,?,?) ON CONFLICT(provider) DO UPDATE SET userid=excluded.userid,bot_id=excluded.bot_id,bound_at=excluded.bound_at,version=im_bindings.version+1")
        .run(message.userid, botId(), iso(now), old ? old.version : 1);
      challenge = null;
      audit('im:wecom', 'im-bind', 'im-binding', 0, 'provider=wecom');
      await reply(message, '绑定成功。之后提醒会发到这里；你也可以直接跟我说要记的事，比如：今天去 XX 看守所会见了张三');
      return true;
    }
    return false;
  }
  async function handleMessage(message) {
    if (!message?.msgid) return;
    let inserted = true;
    try { db.prepare('INSERT INTO im_inbound(provider,msgid,received_at,outcome) VALUES (?,?,?,?)').run('wecom', message.msgid, iso(now), 'ignored'); } catch (error) { if (/UNIQUE/.test(String(error.message))) inserted = false; else throw error; }
    if (!inserted) return;
    if (await bindOrRoute(message)) { db.prepare('UPDATE im_inbound SET outcome=? WHERE provider=? AND msgid=?').run('bound', 'wecom', message.msgid); return; }
    const current = binding();
    if (!current || message.chattype !== 'single' || message.userid !== current.userid) { counters.ignored += 1; return; }
    if (!['text', 'voice', 'mixed', 'image', 'file', 'video'].includes(message.msgtype)) return;
    if (['image', 'file', 'video'].includes(message.msgtype) || !message.text) {
      counters.unsupported += 1; await reply(message, '暂时只支持文字和语音。图片和文件请在案齐网页里上传。');
      db.prepare('UPDATE im_inbound SET outcome=? WHERE provider=? AND msgid=?').run('unsupported', 'wecom', message.msgid); return;
    }
    if (!bridge) bridge = createAgentBridge({ db, supervisor, hub: api, transport });
    const outcome = await bridge.handle(message);
    counters[outcome] = (counters[outcome] || 0) + 1;
    db.prepare('UPDATE im_inbound SET outcome=? WHERE provider=? AND msgid=?').run(outcome, 'wecom', message.msgid);
  }
  const api = {
    start, stop, reload, state: () => ({ ...state }), status: () => ({
      enabled: enabled(), credentials: { configured: hasCredentials(), source: credentials().source, bot_id: botId() },
      connection: { state: state.state, since: state.since, last_error: state.lastError || null },
      binding: (() => { const row = binding(); return { bound: !!row, userid_masked: row ? maskUserid(row.userid) : '', bound_at: row?.bound_at || null }; })(),
      challenge: { active: !!(challenge && nowMs() <= challenge.expiresAt), expires_at: challenge ? new Date(challenge.expiresAt).toISOString() : null },
      remind_mode: reminderMode(), counters: { ...counters },
    }),
    bindStart: startBind, unbind, reconnect, hasCredentials, isBound, reminderMode, ownerUserid: () => binding()?.userid || '', sendToOwner: (text) => binding() && transport ? transport.sendMarkdown(binding().userid, text) : Promise.resolve({ status: 'failed', detail: 'not_configured' }),
    test: () => api.sendToOwner('这是一条测试消息'),
    reply,
    transport: () => transport,
    prune,
    _handleMessage: handleMessage,
  };
  return api;
}

export default createImHub;
