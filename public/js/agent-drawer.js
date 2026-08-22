// 案件助理抽屉（设计稿 §5：状态徽标 + 有限 assistant 文本 + 工具调用摘要 +
// 可展开错误 + proposal 卡片）。
//
// 特性探测：counts.agent=false（未启用，或已启用但白名单字段不合法/apiKeyEnv
// 指向的环境变量没有值）时，本模块整块不渲染——不挂入口按钮、不建抽屉 DOM、
// 不连 SSE（沿用 js/nav.js 对 counts.llm 的既有模式，见该文件 mountNav() 里
// 「未配 key 时不渲染按钮」的注释）。
//
// SSE 连接是懒建的：只在用户第一次点开抽屉时才 new EventSource()，不在页面
// 加载时就默默常驻一条长连接——案件页可能开很多个标签页，谁都不点抽屉的话
// 不该有谁在后台空转一条 SSE。
//
// 事件到 DOM 的映射（服务端形状见 src/routes/agent.js 的 SSE 面注释）：
//   - 'status'（每次连接建立的首帧，之后不会再收到同名事件）：disabled 时
//     形状只有 {status,caseId,error}；否则是完整 publicStatus() 投影，包含
//     pendingInteractions——用来在「打开抽屉」这一刻把已经在等待应答的
//     approval/question 卡片补渲染出来，不必等下一次恰好广播的
//     interaction/pending。
//   - 'worker/ready' / 'turn/start' / 'turn/end' / 'worker/exit'：origin 恒为
//     'supervisor'，驱动状态徽标 + 系统行。
//   - 'assistant/chunk'：origin 'wire'，data.chunk 是归一化后的增量块
//     （{type:'text-delta',text,index} 等，见 @deepseek-ai/dsh-llm 的
//     BlockAssembler 输出），只对 text-delta 做流式追加。
//   - 'assistant/message'：origin 'wire'，data.message.content 是内容块数组，
//     用来在一段助手发言结束时用权威文本收口（覆盖，不是追加）。
//   - 'tool/call' / 'tool/result'：origin 'wire'，只渲染成一行摘要（工具名 +
//     只读/写入性质），不展开完整参数/返回值。两者按 callId 关联（tool/call
//     data 形状是 {turn,step,callId,name,arguments}；tool/result data 形状是
//     {turn,step,message,error?,meta?}，message 是
//     createToolResultMessage() 产出的 {..., content:[{type:'tool-result',
//     toolCallId,content,isError}]}，与前者的 callId 是同一个值——见
//     @deepseek-ai/dsh-agent-loop/lib/index.js 的 appendToolCall/
//     appendToolResult）。data 顶层没有 created 字段：anqi_inbox_propose 的
//     {created:true,...} 是工具返回值，经 renderJson 变成
//     message.content[0].content[0].text 里的 JSON 文本，需要解析后才能读到
//     created，data.meta 则只有声明了 output.presentationMeta 的工具才有
//     （本工具没有）。按 callId 关联而不是按到达顺序猜，是因为并行工具调用
//     下 tool/call A → tool/call B → tool/result A 时「记住上一次」的写法会
//     错配到 B。
//   - 'interaction/pending' / 'interaction/expired'：origin 'supervisor'，
//     approval 卡片（允许一次/拒绝）与 question 卡片（受限答案表单）。
import { api, el, toast } from './api.js';

const STATUS_LABEL = {
  disabled: '未启用', starting: '启动中', ready: '就绪', running: '运行中',
  stopping: '停止中', stopped: '已停止', error: '出错', crashed: '已崩溃',
};
const STATUS_CHIP_CLASS = {
  disabled: 'c-gray', starting: 'c-amber', ready: 'c-green', running: 'c-blue',
  stopping: 'c-amber', stopped: 'c-gray', error: 'c-red', crashed: 'c-red',
};
// 会触发「启动/重新启动」按钮的状态：还没起过、或已经落终态但不是 disabled。
const STARTABLE_STATUSES = new Set(['stopped', 'error', 'crashed']);
// 只读工具白名单：anqi 自己的三个只读工具，加上三个不写案件数据的 DSH 工具
// （dsh-tool-skill/dsh-tool-ask-user/dsh-tool-todo 的 skill/ask_user_question/
// todo_write，工具名见各自 lib/index.js 的 name 字段）：skill 只读取受信任
// skill 定义；ask_user_question 只是向律师提问、不落任何字段；todo_write 写
// 的是助理会话自己的待办草稿（不进 anjian.db 的案件表）。三者标「写入」同样
// 是误导。read/read_image/glob/grep 曾经也在这份名单里——preset 自 2026-08-22
// 起不再挂载 dsh-tool-fs/dsh-tool-fs-search（见 agent.cordis.yml 顶部注释、
// docs/agent-gates.md 门禁 1/3「已知限制」§3），这四个工具名不会再出现在
// 任何 tool/call 事件里，这里同步去掉，避免留一份指向不存在工具的死配置。
const READONLY_TOOLS = new Set([
  'mcp__anqi-local__case_folder_info', 'anqi_case_get', 'anqi_digest',
  'skill', 'ask_user_question', 'todo_write',
]);
const PROPOSE_TOOL = 'anqi_inbox_propose';
const MAX_PROMPT_CHARS = 8000;
const MAX_ANSWER_CHARS = 2000;

export async function mountAgentDrawer(caseId) {
  const slot = document.getElementById('agent-entry-slot');
  if (!slot) return; // 页面没有这个挂载点（理论上不会发生，防御一下）
  let counts;
  try { counts = await api('/counts'); } catch { return; }
  if (!counts.agent) return; // 特性探测：未启用/未配置，整块不渲染

  const state = {
    es: null,
    connected: false,
    status: 'stopped',
    currentBubble: null,
    currentBubbleText: '',
    pendingToolCalls: new Map(), // callId -> name（tool/call 与 tool/result 按 callId 关联，不能按顺序猜——并行工具调用下顺序会错配）
    cards: new Map(), // interactionId -> { el }
  };

  const entryBtn = el('button', { class: 'btn small', type: 'button' }, 'AI 助理');
  slot.replaceChildren(entryBtn);

  const badge = el('span', { class: 'chip c-gray' }, '未启动');
  const logEl = el('div', { class: 'agent-log' });
  const emptyHint = el('div', { class: 'agent-empty' }, '还没有对话——在下面输入一句话给 AI 助理下达指令。');
  logEl.append(emptyHint);

  const startBtn = el('button', { class: 'btn small primary', type: 'button', hidden: '' }, '启动 AI 助理');
  const textarea = el('textarea', {
    placeholder: '给 AI 助理下达指令……', rows: '2', maxlength: String(MAX_PROMPT_CHARS), disabled: '',
  });
  const sendBtn = el('button', { class: 'btn small primary', type: 'submit', disabled: '' }, '发送');
  const stopBtn = el('button', { class: 'btn small danger', type: 'button', disabled: '' }, '停止');

  const promptForm = el('form', { class: 'agent-prompt-form' },
    textarea,
    el('div', { class: 'agent-drawer-actions' }, startBtn, stopBtn, sendBtn)
  );

  const closeBtn = el('button', { class: 'iconbtn', type: 'button', 'aria-label': '关闭' }, '×');
  const drawer = el('aside', { class: 'agent-drawer', hidden: '', 'aria-hidden': 'true', role: 'complementary', 'aria-label': 'AI 助理' },
    el('header', { class: 'agent-drawer-head' },
      el('div', { class: 'agent-drawer-title' }, 'AI 助理', badge),
      closeBtn
    ),
    el('div', { class: 'agent-drawer-body' }, logEl),
    el('div', { class: 'agent-drawer-foot' }, promptForm)
  );
  const backdrop = el('div', { class: 'agent-drawer-backdrop', hidden: '' });
  document.body.append(backdrop, drawer);

  function scrollLogDown() {
    logEl.scrollTop = logEl.scrollHeight;
  }

  function clearEmptyHint() {
    if (emptyHint.isConnected) emptyHint.remove();
  }

  function appendMsg(cls, text) {
    clearEmptyHint();
    const node = el('div', { class: `agent-msg ${cls}` }, text);
    logEl.append(node);
    scrollLogDown();
    return node;
  }

  const appendSystem = (text) => appendMsg('agent-msg-system', text);
  const appendUser = (text) => appendMsg('agent-msg-user', text);

  function appendToolCall(name) {
    clearEmptyHint();
    const readonly = READONLY_TOOLS.has(name);
    const kind = name === PROPOSE_TOOL ? '建议（不直接写入）' : (readonly ? '只读' : '写入');
    const node = el('div', { class: 'agent-msg agent-msg-tool' }, `🔧 ${name} · ${kind}`);
    logEl.append(node);
    scrollLogDown();
  }

  // 从真实的 tool/result data 里取出 anqi_inbox_propose 的 created 字段——
  // data.message.content[0].content 是工具 render 出来的内容块数组，
  // renderJson 只产出一个 {type:'text',text:JSON字符串} 块（见
  // src/agent/assets/plugins/dsh-anqi/index.js 的 renderJson()）。解析失败
  // （形状不对/非 JSON）一律当作「不是一次成功的建议提交」处理，不抛错。
  function readProposalCreated(resultData) {
    try {
      const blocks = resultData?.message?.content?.[0]?.content;
      const textBlock = Array.isArray(blocks) ? blocks.find((b) => b?.type === 'text') : null;
      if (!textBlock?.text) return false;
      return JSON.parse(textBlock.text)?.created === true;
    } catch {
      return false;
    }
  }

  function appendProposalNotice() {
    clearEmptyHint();
    const node = el('div', { class: 'agent-card agent-card-proposal' },
      el('div', { class: 'agent-card-title' }, '已提交建议到收件箱'),
      el('div', {}, 'AI 助理只能提交建议，不能直接写入待办/期限；是否采纳请在收件箱人工裁决。'),
      el('div', { class: 'agent-card-actions' },
        el('a', { class: 'btn small', href: '/#sec-inbox-card', target: '_blank', rel: 'noopener' }, '去收件箱 ↗')
      )
    );
    logEl.append(node);
    scrollLogDown();
  }

  function removeCard(interactionId) {
    const card = state.cards.get(interactionId);
    if (!card) return;
    card.el.remove();
    state.cards.delete(interactionId);
  }

  // 一次性把卡片的动作区替换成一句提示——404（已过期/已消费/已属于另一个
  // worker）优雅收尾，不留一个点了必失败的死按钮。
  function settleCard(interactionId, note) {
    const card = state.cards.get(interactionId);
    if (!card) return;
    card.actions.replaceChildren(el('span', { class: 'meta' }, note));
  }

  async function answerInteraction(interactionId, body, okNote) {
    try {
      await api(`/agent/interactions/${interactionId}/answer`, { method: 'POST', body });
      settleCard(interactionId, okNote);
      setTimeout(() => removeCard(interactionId), 1200);
    } catch (e) {
      // 404（interaction_not_found：过期/已消费/worker 已退出）与其它错误都
      // 优雅收尾——api() 已经 toast 过服务端 error，这里只负责别留一张死卡片。
      settleCard(interactionId, e.status === 404 ? '该请求已过期或已处理' : '提交失败');
      setTimeout(() => removeCard(interactionId), 1600);
    }
  }

  function renderApprovalCard(interactionId, toolName) {
    if (state.cards.has(interactionId)) return;
    clearEmptyHint();
    const actions = el('div', { class: 'agent-card-actions' },
      el('button', {
        class: 'btn small ok', type: 'button',
        onclick: () => answerInteraction(interactionId, { outcome: 'allowed-once' }, '已允许一次'),
      }, '允许一次'),
      el('button', {
        class: 'btn small danger', type: 'button',
        onclick: () => answerInteraction(interactionId, { outcome: 'rejected' }, '已拒绝'),
      }, '拒绝')
    );
    const node = el('div', { class: 'agent-card agent-card-approval' },
      el('div', { class: 'agent-card-title' }, '需要授权'),
      el('div', {}, `AI 助理请求执行：${toolName || '（未知工具）'}`),
      actions
    );
    logEl.append(node);
    state.cards.set(interactionId, { el: node, actions });
    scrollLogDown();
  }

  function renderQuestionCard(interactionId, questions) {
    if (state.cards.has(interactionId)) return;
    clearEmptyHint();
    const list = Array.isArray(questions) ? questions : [];
    // textareas 与 list 按下标一一对应（同一次渲染、同一份数组生成，顺序恒
    // 定），提交时直接按下标取值，不需要靠 dataset 再反查一遍 DOM。
    const textareas = list.map(() => el('textarea', { rows: '2', maxlength: String(MAX_ANSWER_CHARS), placeholder: '你的回答……' }));
    const items = list.map((q, i) => el('div', { class: 'agent-question-item' },
      el('div', { class: 'agent-question-text' }, q.question || ''),
      textareas[i]
    ));
    const actions = el('div', { class: 'agent-card-actions' },
      el('button', {
        class: 'btn small primary', type: 'button',
        onclick: () => {
          const answers = list.map((q, i) => ({ id: q.id, text: textareas[i].value.trim() }));
          if (answers.some((a) => !a.text)) { toast('每道问题都要填答案'); return; }
          answerInteraction(interactionId, { answers }, '已提交答案');
        },
      }, '提交答案')
    );
    const node = el('div', { class: 'agent-card agent-card-question' },
      el('div', { class: 'agent-card-title' }, 'AI 助理有一个问题'),
      ...items,
      actions
    );
    logEl.append(node);
    state.cards.set(interactionId, { el: node, actions });
    scrollLogDown();
  }

  function applyStatus(status, errorMsg) {
    state.status = status;
    badge.replaceChildren();
    badge.className = `chip ${STATUS_CHIP_CLASS[status] || 'c-gray'}`;
    badge.append(STATUS_LABEL[status] || status || '未知');
    const isReady = status === 'ready';
    const isRunning = status === 'running';
    textarea.disabled = !(isReady);
    sendBtn.disabled = !isReady;
    stopBtn.disabled = !isRunning;
    startBtn.hidden = !STARTABLE_STATUSES.has(status);
    if (errorMsg) appendSystem(`⚠ ${errorMsg}`);
  }

  // 首帧/重连快照：disabled 时形状只有 {status,caseId,error}；否则是完整
  // publicStatus() 投影（含 pendingInteractions），把已经在等待应答的
  // approval/question 卡片一并补渲染出来。
  function applySnapshot(data) {
    applyStatus(data.status, data.error);
    for (const item of data.pendingInteractions || []) {
      if (item.type === 'approval') renderApprovalCard(item.id, item.toolName);
      else if (item.type === 'question') renderQuestionCard(item.id, item.questions);
    }
  }

  function connectSSE() {
    if (state.connected) return;
    state.connected = true;
    const es = new EventSource(`/api/cases/${caseId}/agent/events`);
    state.es = es;

    es.addEventListener('status', (e) => {
      const data = JSON.parse(e.data);
      // 纵深防御：真实 status 首帧是 supervisor.publicStatus() 的原始投影，
      // 顶层从不带 origin 字段（origin 只出现在 {origin,data} 包一层的
      // tool/*、assistant/* 等事件里）。服务端已经把子进程 session.event 撞
      // 上保留事件名的情形重写成 wire/<type>（见 src/routes/agent.js），这里
      // 独立于服务端再核验一次：一旦收到的 status 帧顶层带 origin，视为 wire
      // 一侧的伪造/异常帧，直接丢弃，不喂给 applySnapshot()。
      if (data.origin) return;
      applySnapshot(data);
    });
    es.addEventListener('worker/ready', () => { applyStatus('ready'); appendSystem('AI 助理已就绪'); });
    es.addEventListener('turn/start', () => { applyStatus('running'); });
    es.addEventListener('turn/end', (e) => {
      const data = JSON.parse(e.data).data || {};
      if (state.currentBubble) {
        state.currentBubble.classList.remove('is-streaming');
        state.currentBubble = null;
        state.currentBubbleText = '';
      }
      if (data.outcome === 'completed') applyStatus('ready');
      else appendSystem('本轮出错，正在收尾……');
    });
    es.addEventListener('worker/exit', (e) => {
      const data = JSON.parse(e.data).data || {};
      applyStatus(data.status, null);
      // worker 退出后，任何还没收到 tool/result 的 pendingToolCalls 记录都成了
      // 孤儿（旧 worker 的 callId 命名空间已经结束）——清空，避免残留条目
      // 无限增长，也避免下次重启后的新 worker 若恰好复用了同一个 callId 字面
      // 值时被错配到上一任 worker 遗留的工具名。
      state.pendingToolCalls.clear();
      appendSystem(`AI 助理已停止${data.detail ? '：' + data.detail : ''}`);
    });
    es.addEventListener('assistant/chunk', (e) => {
      const data = JSON.parse(e.data).data || {};
      const chunk = data.chunk;
      if (!chunk || chunk.type !== 'text-delta' || !chunk.text) return;
      if (!state.currentBubble) {
        state.currentBubble = appendMsg('agent-msg-assistant is-streaming', '');
        state.currentBubbleText = '';
      }
      state.currentBubbleText += chunk.text;
      state.currentBubble.textContent = state.currentBubbleText;
      scrollLogDown();
    });
    es.addEventListener('assistant/message', (e) => {
      const data = JSON.parse(e.data).data || {};
      const blocks = data.message?.content;
      const text = Array.isArray(blocks)
        ? blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('')
        : '';
      if (!text) return;
      if (!state.currentBubble) state.currentBubble = appendMsg('agent-msg-assistant', '');
      state.currentBubble.classList.remove('is-streaming');
      state.currentBubble.textContent = text;
      state.currentBubble = null;
      state.currentBubbleText = '';
      scrollLogDown();
    });
    es.addEventListener('tool/call', (e) => {
      const frame = JSON.parse(e.data);
      if (frame.origin !== 'wire') return;
      const { callId, name } = frame.data || {};
      if (!name) return;
      if (callId != null) state.pendingToolCalls.set(callId, name);
      appendToolCall(name);
    });
    es.addEventListener('tool/result', (e) => {
      const frame = JSON.parse(e.data);
      if (frame.origin !== 'wire') return;
      const data = frame.data || {};
      const callId = data.message?.content?.[0]?.toolCallId;
      const name = callId != null ? state.pendingToolCalls.get(callId) : undefined;
      if (callId != null) state.pendingToolCalls.delete(callId);
      if (name === PROPOSE_TOOL && readProposalCreated(data)) appendProposalNotice();
    });
    es.addEventListener('interaction/pending', (e) => {
      const data = JSON.parse(e.data).data || {};
      if (data.type === 'approval') renderApprovalCard(data.interactionId, data.toolName);
      else if (data.type === 'question') renderQuestionCard(data.interactionId, data.questions);
    });
    es.addEventListener('interaction/expired', (e) => {
      const data = JSON.parse(e.data).data || {};
      settleCard(data.interactionId, '该请求已过期');
      setTimeout(() => removeCard(data.interactionId), 1600);
    });
    es.onerror = () => { /* EventSource 自己会重连，不额外处理——重连后会再收一次 status 首帧 */ };
  }

  function openDrawer() {
    drawer.hidden = false; drawer.setAttribute('aria-hidden', 'false');
    backdrop.hidden = false;
    connectSSE();
    scrollLogDown();
  }
  function closeDrawer() {
    drawer.hidden = true; drawer.setAttribute('aria-hidden', 'true');
    backdrop.hidden = true;
  }
  entryBtn.addEventListener('click', openDrawer);
  closeBtn.addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawer.hidden) closeDrawer(); });

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    try {
      const snapshot = await api(`/cases/${caseId}/agent/start`, { method: 'POST' });
      applySnapshot(snapshot);
    } catch { /* api() 已经 toast 过错误，这里不重复 */ }
    finally { startBtn.disabled = false; }
  });

  stopBtn.addEventListener('click', async () => {
    stopBtn.disabled = true;
    try {
      await api(`/cases/${caseId}/agent/cancel`, { method: 'POST' });
      appendSystem('已请求停止');
    } catch { /* api() 已经 toast 过错误 */ }
    finally { stopBtn.disabled = false; }
  });

  promptForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    try {
      await api(`/cases/${caseId}/agent/prompt`, { method: 'POST', body: { text } });
      appendUser(text);
      textarea.value = '';
    } catch { /* api() 已经 toast 过错误 */ }
    finally { sendBtn.disabled = state.status !== 'ready'; }
  });
}
