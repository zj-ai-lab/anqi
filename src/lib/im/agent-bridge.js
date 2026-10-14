import { audit } from '../../db.js';
import { loadAgentConfig } from '../../agent/config.js';
import { GLOBAL_SCOPE } from '../../agent/supervisor.js';
import { MAX_PROMPT_CHARS, buildQuestionAnswer } from '../../agent/interaction-answer.js';

const stripControls = (value) => String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');

function byteLimit(value, max = 20000) {
  const text = stripControls(value);
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  const suffix = '…（内容过长，完整内容请到案齐网页查看）';
  const budget = Math.max(0, max - Buffer.byteLength(suffix, 'utf8'));
  let out = '';
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > budget) break;
    out += ch;
    used += size;
  }
  return out + suffix;
}

function eventText(event) {
  const content = event?.data?.message?.content ?? event?.data?.content ?? [];
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content.filter((item) => item?.type === 'text').map((item) => item.text || item.content || '').join('')
    : '';
}

function timeoutAfter(ms) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timeout: true }), ms);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

export function createAgentBridge({
  db,
  supervisor,
  hub,
  transport,
  getTransport,
  now = () => Date.now(),
  loadConfig = loadAgentConfig,
  maxQueue = 3,
  timeoutMs = 9 * 60_000,
} = {}) {
  const currentTransport = () => (typeof getTransport === 'function' ? getTransport() : transport);
  let active = null;
  const queue = [];
  let currentTurn = null;
  const completedTurns = new Map();
  const pending = new Map();

  const unlisten = supervisor?.onEvent?.(GLOBAL_SCOPE, (event) => {
    if (event?.type === 'turn/start') {
      currentTurn = {
        turnId: event.data?.turnId,
        origin: event.data?.origin || 'web',
        text: '',
        pending: new Set(),
        started: Number(now()),
      };
      return;
    }

    if (event?.type === 'assistant/message') {
      // Wire assistant/message data has {turn, step, message}; it deliberately
      // does not contain the supervisor turnId. The supervisor has one FIFO
      // turn slot, so the current turn is the authoritative association.
      if (currentTurn?.origin === 'im:wecom') {
        const text = eventText(event);
        if (text) currentTurn.text = text;
      }
      return;
    }

    if (event?.type === 'turn/end') {
      const turnId = event.data?.turnId;
      if (currentTurn?.origin === 'im:wecom' && currentTurn.turnId === turnId) {
        completedTurns.set(turnId, currentTurn.text || '');
      }
      currentTurn = null;
      return;
    }

    // Only interactions emitted during the currently running IM turn may be
    // sent to WeCom. A web turn can be ahead of a queued IM prompt.
    if (event?.type === 'interaction/pending' && currentTurn?.origin === 'im:wecom') {
      const interactionId = event.data?.interactionId;
      if (!interactionId) return;
      currentTurn.pending.add(interactionId);
      if (event.data?.type === 'question') {
        pending.set(interactionId, { ...event.data, turnId: currentTurn.turnId });
        const questions = event.data.questions || [];
        const body = [
          'AI 需要你确认：',
          ...questions.map((question, index) => `${questions.length > 1 ? `${index + 1}. ` : ''}${question.question}`),
          questions.length > 1 ? '请按顺序每行回答一题。' : '',
          '直接回复这条消息即可，2 分钟内有效。',
        ].filter(Boolean).join('\n');
        const sent = currentTransport()?.sendMarkdown?.(hub.ownerUserid(), body);
        sent?.catch?.(() => {});
      } else if (event.data?.type === 'approval') {
        const sent = currentTransport()?.sendMarkdown?.(
          hub.ownerUserid(),
          '这一步需要在案齐网页里批准（2 分钟内有效），企业微信里不能批准；超时将自动拒绝。',
        );
        sent?.catch?.(() => {});
      }
      return;
    }

    if (event?.type === 'interaction/expired' && currentTurn?.origin === 'im:wecom') {
      const interactionId = event.data?.interactionId;
      if (!currentTurn.pending.has(interactionId)) return;
      pending.delete(interactionId);
      const sent = currentTransport()?.sendMarkdown?.(
        hub.ownerUserid(),
        '刚才的问题已超时（2 分钟），这一轮会按没有回答继续或结束。',
      );
      sent?.catch?.(() => {});
    }
  });

  async function send(message, text, finish = true) {
    const activeTransport = currentTransport();
    if (!activeTransport?.replyStream) return { status: 'failed', detail: 'not_connected' };
    try {
      return await activeTransport.replyStream(message.frame, `stream-${message.msgid}`, byteLimit(text), finish);
    } catch {
      return { status: 'unknown', detail: 'reply_failed' };
    }
  }

  async function answerPending(message) {
    const candidate = [...pending.entries()].find(([, entry]) => entry.turnId && (!entry.userid || entry.userid === message.userid));
    if (!candidate) return false;
    const [interactionId, entry] = candidate;
    const questions = entry.questions || [];
    const lines = questions.length > 1 ? String(message.text || '').split(/\r?\n/) : [String(message.text || '')];
    if (lines.length !== questions.length) {
      await send(message, `一共 ${questions.length} 个问题，请每行回答一个`);
      return true;
    }
    const built = buildQuestionAnswer(questions, questions.map((question, index) => ({ id: question.id, text: lines[index] })));
    const result = built ? await Promise.resolve(supervisor.resolveQuestion?.(GLOBAL_SCOPE, interactionId, built)) : { ok: false };
    if (!built || !result?.ok) {
      await send(message, '这个问题已经过期了，请重新发起');
      return true;
    }
    pending.delete(interactionId);
    return true;
  }

  async function run(message) {
    active = { message, turnId: null, cancelled: false, started: Number(now()) };
    const text = String(message.text || '').trim();
    try {
      const config = loadConfig();
      if (!config.enabled) {
        await send(message, 'AI 助理没有开启。请在案齐「用户中心 → AI 助理」里开启后再发。');
        return 'agent_disabled';
      }
      if (!text) {
        await send(message, '请输入文字或语音内容。');
        return 'failed';
      }
      if (text.length > MAX_PROMPT_CHARS) {
        await send(message, `太长了，请分几条发（上限 ${MAX_PROMPT_CHARS} 字）`);
        return 'failed';
      }
      if (!supervisor.isLive?.(GLOBAL_SCOPE)) {
        const started = await supervisor.start?.(GLOBAL_SCOPE);
        if (started?.status === 'disabled' || started?.status === 'error') {
          const error = new Error('agent start failed');
          error.code = started.status;
          throw error;
        }
      }
      audit('im:wecom', 'agent-prompt', 'agent-worker', 0, `scope=global via=wecom chars=${text.length}`);
      await send(message, '收到，正在处理…', false);
      const promptPromise = supervisor.prompt(GLOBAL_SCOPE, text, [], { origin: 'im:wecom' });
      const timeout = timeoutAfter(timeoutMs);
      const result = await Promise.race([promptPromise, timeout.promise]);
      timeout.cancel();
      if (result?.timeout) {
        await send(message, '处理时间较长，结果稍后单独发给你。', true);
        const completed = await promptPromise;
        const finalText = byteLimit(completedTurns.get(completed?.turnId) || '');
        await currentTransport()?.sendMarkdown?.(
          hub.ownerUserid(),
          finalText || '已处理，但 AI 没有给出文字回复。可以到案齐网页的 AI 抽屉查看。',
        );
        completedTurns.delete(completed?.turnId);
      } else {
        active.turnId = result?.turnId;
        const finalText = byteLimit(completedTurns.get(result?.turnId) || '');
        await send(message, finalText || '已处理，但 AI 没有给出文字回复。可以到案齐网页的 AI 抽屉查看。', true);
        completedTurns.delete(result?.turnId);
      }
      return 'prompted';
    } catch (error) {
      if (!active?.cancelled) {
        const reason = error?.message === 'turn timed out' || error?.code === 'timeout'
          ? '处理超时'
          : error?.message === 'turn cancelled' || error?.code === 'cancelled'
            ? '已取消'
            : 'AI 助理出错';
        await send(message, `这条没处理完：${reason}。总入口会话已重置，请重新发一次。`);
      }
      return active?.cancelled ? 'cancel' : 'failed';
    } finally {
      const finished = active;
      active = null;
      const next = queue.shift();
      if (next) run(next).catch(() => {});
      if (finished?.cancelled) return 'cancel';
    }
  }

  async function handle(message) {
    if (await answerPending(message)) return 'answered';
    const command = String(message.text || '').trim();
    if (command === '取消' || command === '停') {
      if (active) {
        active.cancelled = true;
        await Promise.resolve(supervisor.cancelTurn?.(GLOBAL_SCOPE, 'cancelled via wecom'));
        await send(message, '已取消。总入口会话已重置。');
        return 'cancel';
      }
      await send(message, '现在没有正在处理的事。');
      return 'cancel';
    }
    if (active || queue.length) {
      if (queue.length >= maxQueue) {
        await send(message, '前面还有几条没处理完，请稍等再发');
        return 'busy';
      }
      queue.push(message);
      return 'prompted';
    }
    return run(message);
  }

  return {
    handle,
    close: () => unlisten?.(),
    state: () => ({ active: !!active, queued: queue.length }),
  };
}

export default createAgentBridge;
