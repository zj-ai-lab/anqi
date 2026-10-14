import { audit } from '../../db.js';
import { loadAgentConfig } from '../../agent/config.js';
import { GLOBAL_SCOPE } from '../../agent/supervisor.js';
import { MAX_PROMPT_CHARS, buildQuestionAnswer } from '../../agent/interaction-answer.js';

const stripControls = (value) => String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
function byteLimit(value, max = 20000) {
  const text = stripControls(value);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= max) return text;
  const suffix = '…（内容过长，完整内容请到案齐网页查看）';
  const budget = max - Buffer.byteLength(suffix, 'utf8');
  let out = ''; let used = 0;
  for (const ch of text) { const size = Buffer.byteLength(ch); if (used + size > budget) break; out += ch; used += size; }
  return out + suffix;
}
function eventText(event) {
  const content = event?.data?.message?.content ?? event?.data?.content ?? [];
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter((x) => x?.type === 'text').map((x) => x.text || x.content || '').join('') : '';
}
function timeoutAfter(ms) {
  let timer;
  const promise = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), ms); timer.unref?.(); });
  return { promise, cancel: () => clearTimeout(timer) };
}

export function createAgentBridge({ db, supervisor, hub, transport, now = () => Date.now(), loadConfig = loadAgentConfig, maxQueue = 3, timeoutMs = 9 * 60_000 } = {}) {
  let active = null;
  const queue = [];
  const turns = new Map();
  const pending = new Map();
  const unlisten = supervisor?.onEvent?.(GLOBAL_SCOPE, (event) => {
    if (event?.type === 'turn/start' && event.data?.origin === 'im:wecom') { turns.set(event.data.turnId, { text: '', started: Number(now()) }); if (active) active.turnId = event.data.turnId; }
    if (event?.type === 'assistant/message') {
      const id = event.data?.turnId || event.data?.turn?.turnId || event.data?.message?.turnId;
      const text = eventText(event);
      if (id && turns.has(id) && text) turns.get(id).text = text;
    }
    if (event?.type === 'interaction/pending' && active && event.data?.type === 'question') {
      const id = event.data.interactionId;
      pending.set(id, { ...event.data, turnId: active.turnId });
      const questions = event.data.questions || [];
      const body = ['AI 需要你确认：', ...questions.map((q, i) => `${questions.length > 1 ? `${i + 1}. ` : ''}${q.question}`), questions.length > 1 ? '请按顺序每行回答一题。' : '', '直接回复这条消息即可，2 分钟内有效。'].filter(Boolean).join('\n');
      const sent = transport?.sendMarkdown?.(hub.ownerUserid(), body); sent?.catch?.(() => {});
    }
    if (event?.type === 'interaction/pending' && active && event.data?.type === 'approval') {
      const sent = transport?.sendMarkdown?.(hub.ownerUserid(), '这一步需要在案齐网页里批准（2 分钟内有效），企业微信里不能批准；超时将自动拒绝。'); sent?.catch?.(() => {});
    }
    if (event?.type === 'interaction/expired' && active && pending.has(event.data?.interactionId)) {
      pending.delete(event.data.interactionId);
      const sent = transport?.sendMarkdown?.(hub.ownerUserid(), '刚才的问题已超时（2 分钟），这一轮会按没有回答继续或结束。'); sent?.catch?.(() => {});
    }
  });

  async function send(message, text, finish = true) {
    try { return await transport.replyStream(message.frame, `stream-${message.msgid}`, byteLimit(text), finish); } catch { return { status: 'unknown', detail: 'reply_failed' }; }
  }
  async function answerPending(message) {
    const entry = [...pending.values()].find((x) => x.userid === undefined || x.userid === message.userid);
    if (!entry) return false;
    const all = [...pending.entries()].filter(([, x]) => x.turnId === active?.turnId);
    const questions = entry.questions || [];
    const lines = questions.length > 1 ? message.text.split(/\r?\n/) : [message.text];
    if (lines.length !== questions.length) { await send(message, `一共 ${questions.length} 个问题，请每行回答一个`); return true; }
    const built = buildQuestionAnswer(questions, questions.map((q, i) => ({ id: q.id, text: lines[i] })));
    const interactionId = [...pending.entries()].find(([, x]) => x === entry)?.[0];
    const result = built ? supervisor.resolveQuestion?.(GLOBAL_SCOPE, interactionId, built) : { ok: false };
    if (!built || !result?.ok) { await send(message, '这个问题已经过期了，请重新发起'); return true; }
    for (const [id] of all) pending.delete(id);
    return true;
  }
  async function process(message) {
    try { if (await answerPending(message)) return 'answered'; } catch { await send(message, '这个问题已经过期了，请重新发起'); return 'answered'; }
    if (['取消', '停'].includes(String(message.text || '').trim())) {
      if (active) { active.cancelled = true; supervisor.cancelTurn?.(GLOBAL_SCOPE, 'cancelled via wecom'); await send(message, '已取消。总入口会话已重置。'); return 'cancel'; }
      await send(message, '现在没有正在处理的事。'); return 'cancel';
    }
    const config = loadConfig();
    if (!config.enabled) { await send(message, 'AI 助理没有开启。请在案齐「用户中心 → AI 助理」里开启后再发。'); return 'agent_disabled'; }
    const text = String(message.text || '').trim();
    if (!text) { await send(message, '请输入文字或语音内容。'); return 'failed'; }
    if (text.length > MAX_PROMPT_CHARS) { await send(message, `太长了，请分几条发（上限 ${MAX_PROMPT_CHARS} 字）`); return 'failed'; }
    if (active || queue.length) {
      if (queue.length >= maxQueue) { await send(message, '前面还有几条没处理完，请稍等再发'); return 'busy'; }
      queue.push(message); return 'prompted';
    }
    active = { message, turnId: null, started: Number(now()) };
    await send(message, '收到，正在处理…', false);
    try {
      if (!supervisor.isLive?.(GLOBAL_SCOPE)) {
        const started = await supervisor.start?.(GLOBAL_SCOPE);
        if (started?.status === 'disabled' || started?.status === 'error') throw Object.assign(new Error('agent start failed'), { code: started.status });
      }
      audit('im:wecom', 'agent-prompt', 'agent-worker', 0, `scope=global via=wecom chars=${text.length}`);
      const promptPromise = supervisor.prompt(GLOBAL_SCOPE, text, [], { origin: 'im:wecom' });
      const timeout = timeoutAfter(timeoutMs);
      const timed = await Promise.race([promptPromise, timeout.promise]);
      timeout.cancel();
      if (timed?.timeout) {
        await send(message, '处理时间较长，结果稍后单独发给你。', true);
        const result = await promptPromise.catch((error) => { throw error; });
        const finalText = byteLimit(turns.get(result?.turnId)?.text || '');
        await transport.sendMarkdown(hub.ownerUserid(), finalText || '已处理，但 AI 没有给出文字回复。可以到案齐网页的 AI 抽屉查看。');
      } else {
        active.turnId = timed?.turnId;
        const finalText = byteLimit(turns.get(timed?.turnId)?.text || '');
        await send(message, finalText || '已处理，但 AI 没有给出文字回复。可以到案齐网页的 AI 抽屉查看。', true);
      }
      return 'prompted';
    } catch (error) {
      if (!active?.cancelled) {
        const reason = error?.message === 'turn timed out' || error?.code === 'timeout' ? '处理超时' : error?.message === 'turn cancelled' || error?.code === 'cancelled' ? '已取消' : 'AI 助理出错';
        await send(message, `这条没处理完：${reason}。总入口会话已重置，请重新发一次。`);
      }
      return 'failed';
    } finally {
      active = null;
      const next = queue.shift();
      if (next) process(next).catch(() => {});
    }
  }
  return { handle: process, close: () => unlisten?.(), state: () => ({ active: !!active, queued: queue.length }) };
}

export default createAgentBridge;
