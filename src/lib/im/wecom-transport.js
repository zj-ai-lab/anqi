import { EventEmitter } from 'node:events';
import * as WecomSdk from '@wecom/aibot-node-sdk';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function redact(value, botId, secret) {
  return String(value ?? '').replaceAll(String(secret), '[redacted]').replaceAll(String(botId), '[redacted]');
}

function normalizeText(body = {}) {
  if (body.msgtype === 'text') return String(body.text?.content || '');
  if (body.msgtype === 'voice') return String(body.voice?.content || '');
  if (body.msgtype === 'mixed') return (body.mixed?.msg_item || []).filter((x) => x.msgtype === 'text').map((x) => x.text?.content || '').join('');
  return '';
}

export function createWecomTransport({
  botId, secret, wsUrl = '', WSClient = WecomSdk.WSClient, logger = console,
  now = () => Date.now(), requestTimeout = 10000, rateLimitWindowMs = 60000, rateLimitMax = 25, reconnectInterval = 1000,
} = {}) {
  const events = new EventEmitter();
  let client = null;
  let status = { state: 'idle', since: new Date(now()).toISOString(), lastError: '' };
  let manuallyStopped = false;
  const sent = new Map();
  const pending = new Set();
  const safeLogger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (...args) => {
    if (level === 'debug') return;
    const fn = typeof logger[level] === 'function' ? logger[level].bind(logger) : console[level].bind(console);
    fn(...args.map((x) => redact(x, botId, secret)));
  }]));

  function setState(state, error = '') {
    status = { state, since: status.state === state ? status.since : new Date(now()).toISOString(), lastError: error ? redact(error, botId, secret) : status.lastError };
    events.emit('state', { ...status });
  }
  function recordError(error) {
    const message = redact(error?.message || error, botId, secret);
    status.lastError = message;
    safeLogger.error(message);
  }
  function bucket(userid) {
    const key = String(userid || '');
    const cutoff = Number(now()) - rateLimitWindowMs;
    const list = (sent.get(key) || []).filter((t) => t > cutoff);
    sent.set(key, list);
    return list;
  }
  async function acquire(userid) {
    const start = Number(now()); const wallStart = Date.now();
    for (;;) {
      const list = bucket(userid);
      if (list.length < rateLimitMax) { list.push(Number(now())); return true; }
      const wait = Math.max(1, list[0] + rateLimitWindowMs - Number(now()));
      if (Date.now() - wallStart + wait > rateLimitWindowMs || Number(now()) - start + wait > rateLimitWindowMs) return false;
      await sleep(Math.min(wait, 100));
    }
  }
  function requireReady() {
    if (!client || status.state !== 'ready' || client.isConnected === false) return false;
    return true;
  }
  function frameFor(value) { return value?.headers ? value : { headers: value?.headers || {} }; }
  async function callSend(userid, fn) {
    if (!requireReady()) return { status: 'failed', detail: 'not_connected' };
    if (!(await acquire(userid))) return { status: 'failed', detail: 'rate_limited' };
    const operation = Promise.resolve().then(fn);
    pending.add(operation);
    try {
      const ack = await Promise.race([
        operation,
        new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('request timeout'), { timeout: true })), requestTimeout)),
      ]);
      if (ack?.errcode === 0) return { status: 'sent', detail: 'ok' };
      return { status: 'failed', detail: `errcode:${ack?.errcode ?? 'unknown'}${ack?.errmsg ? ` ${ack.errmsg}` : ''}` };
    } catch (error) {
      if (error?.errcode !== undefined) return { status: 'failed', detail: `errcode:${error.errcode}${error.errmsg ? ` ${redact(error.errmsg, botId, secret)}` : ''}` };
      if (/not connected|queue|rate.?limit|too many|full/i.test(String(error?.message || error))) return { status: 'failed', detail: redact(error?.message || error, botId, secret) };
      return { status: 'unknown', detail: error?.timeout ? 'ack_timeout' : redact(error?.errmsg || error?.message || error, botId, secret) };
    } finally { pending.delete(operation); }
  }
  function createClient() {
    const instance = new WSClient({ botId, secret, ...(wsUrl ? { wsUrl } : {}), maxReconnectAttempts: -1, maxAuthFailureAttempts: 3, heartbeatInterval: 30000, requestTimeout, reconnectInterval, logger: safeLogger });
    instance.on('connected', () => setState('connecting'));
    instance.on('authenticated', () => setState('ready'));
    instance.on('reconnecting', () => setState('reconnecting'));
    instance.on('disconnected', (reason) => { if (status.state !== 'kicked' && !manuallyStopped) setState('reconnecting', reason); });
    instance.on('error', (error) => { recordError(error); if (/auth failure|authentication failed|max auth failure/i.test(String(error?.message || error))) setState('auth_failed', error); else if (status.state !== 'kicked') setState('error', error); if (events.listenerCount('error') > 0) events.emit('error', error); });
    instance.on('message', (frame) => {
      const body = frame?.body || {};
      events.emit('message', { msgid: body.msgid, chattype: body.chattype, userid: body.from?.userid || '', msgtype: body.msgtype, text: normalizeText(body), frame });
    });
    instance.on('event', (frame) => {
      if (frame?.body?.event?.eventtype === 'disconnected_event') {
        manuallyStopped = true;
        setState('kicked', 'disconnected_event');
      }
      events.emit('event', frame);
    });
    return instance;
  }
  function connect() {
    manuallyStopped = false;
    if (!client) client = createClient();
    setState('connecting');
    try { client.connect(); } catch (error) { recordError(error); setState('error', error); }
    return api;
  }
  function disconnect() {
    manuallyStopped = true;
    try { client?.disconnect(); } catch (error) { recordError(error); }
    setState('idle');
  }
  const api = {
    connect, disconnect, state: () => ({ ...status }),
    sendMarkdown: (userid, text) => callSend(userid, () => client.sendMessage(userid, { msgtype: 'markdown', markdown: { content: String(text) } })),
    replyStream: (frame, streamId, text, finish = false) => callSend(frame?.body?.from?.userid || '', () => client.replyStream(frameFor(frame), streamId, String(text), finish)),
    on: (...args) => { events.on(...args); return api; },
    off: (...args) => { events.off(...args); return api; },
    hasCredentials: () => Boolean(botId && secret),
    _client: () => client,
  };
  return api;
}

export default createWecomTransport;
