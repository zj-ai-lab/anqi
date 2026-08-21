// 扩展 JSON-RPC server：subclass HarnessSdkJsonRpcServer 只为补上 stock rc.7
// server 缺的三件事（移植自 anqi-spike-dsh，逻辑未改动，仅头注释更新——细节
// 见 spikes/dsh-agent/REPORT.md §9 踩坑 #7/#8/#9/#19/#20、§13.1）：
//
//   1. session/create 时通过 setup(agentCtx) 真正 mount 'anqi' preset（stock
//      server 不挂 preset）；
//   2. session/preflight：轮询直到该 exact live agent 的工具集恰好含
//      REQUIRED_MCP_TOOL、skill 集合恰好等于 REQUIRED_SKILL，才把 session
//      标记为「可以 prompt」——session/prompt 在 preflight 完成前直接拒绝；
//   3. approval/request 与 user-question/request 这两条反向 RPC：都复用同一
//      个 stdio JsonRpcLineTransport 的 request()（不另建 pending map，避免
//      与 transport 自身的 abort/close/response 分类冲突——踩坑 #19），并且
//      只应答"当前仍然活着的、由本 server 持有的 root agent"发出的请求；
//      approval 额外要求 (callId, toolName) 精确匹配一条尚未认领、尚未决定
//      的 approval/asked 事件，防止重放或跨请求答错。
//
// 本文件运行在 DSH 子进程内部（由 anqi.cordis.yml 的 sdk-jsonrpc-server 行
// 加载），是 supervisor.js（宿主 Node 进程里的 JSON-RPC 客户端）的对端。
import Schema from '@deepseek-ai/schemastery';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server';
import { SessionId } from '@deepseek-ai/dsh-session';
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions';

export const name = 'dsh-anqi-jsonrpc';
export const inject = [
  'agents',
  'agentPresets',
  'userQuestions',
  'approval',
  'tools',
  'skills',
];
export const Config = Schema.object({
  maxTokensAsSuccess: Schema.boolean().default(false),
  interactionTimeoutMs: Schema.number().step(1).min(1_000).default(120_000),
  preflightTimeoutMs: Schema.number().step(1).min(1_000).default(60_000),
});

const REQUIRED_MCP_TOOL = 'mcp__anqi-local__case_folder_info';
const REQUIRED_SKILL = 'anqi-case-brief';

const APPROVAL_OUTCOMES = new Set([
  'allowed-once',
  'rejected',
  'cancelled',
  'unavailable',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sessionIdFromParams(params, method) {
  const sessionId = params?.sessionId;
  if (
    typeof sessionId !== 'string'
    || sessionId.length === 0
    || sessionId.length > 512
    || /[\0-\x1f\x7f]/u.test(sessionId)
  ) {
    throw new Error(`${method} requires a valid sessionId`);
  }
  return sessionId;
}

function abortReason(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error('preflight was aborted');
}

function validateQuestionAnswer(value, sessionId, questions) {
  if (!isRecord(value) || value.sessionId !== sessionId || !isRecord(value.answer)) {
    throw new UserQuestionError('user-question response did not match its session', 'BAD_PROVIDER_RESPONSE');
  }
  const answers = value.answer.answers;
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    throw new UserQuestionError('user-question response had the wrong answer count', 'BAD_PROVIDER_RESPONSE');
  }

  const normalized = answers.map((answer, index) => {
    const question = questions[index];
    if (!isRecord(answer) || answer.id !== question.id || !Array.isArray(answer.selected)) {
      throw new UserQuestionError('user-question response did not match question order', 'BAD_PROVIDER_RESPONSE');
    }
    if (!answer.selected.every((label) => typeof label === 'string')) {
      throw new UserQuestionError('user-question response contained an invalid option label', 'BAD_PROVIDER_RESPONSE');
    }
    if (new Set(answer.selected).size !== answer.selected.length) {
      throw new UserQuestionError('user-question response repeated an option label', 'BAD_PROVIDER_RESPONSE');
    }
    const custom = answer.custom;
    if (custom !== undefined && (typeof custom !== 'string' || custom.trim() === '')) {
      throw new UserQuestionError('user-question custom text must be non-empty', 'BAD_PROVIDER_RESPONSE');
    }
    if (question.multiSelect !== true) {
      if (custom !== undefined && answer.selected.length > 0) {
        throw new UserQuestionError('single-select response mixed an option with custom text', 'BAD_PROVIDER_RESPONSE');
      }
      if (answer.selected.length > 1) {
        throw new UserQuestionError('single-select response selected more than one option', 'BAD_PROVIDER_RESPONSE');
      }
    }
    const labels = new Set((question.options || []).map((option) => option.label));
    if (!answer.selected.every((label) => labels.has(label))) {
      throw new UserQuestionError('user-question response selected an unknown option', 'BAD_PROVIDER_RESPONSE');
    }
    return {
      id: answer.id,
      selected: [...answer.selected],
      ...(custom === undefined ? {} : { custom }),
    };
  });

  return { answers: normalized };
}

class AnqiJsonRpcServer extends HarnessSdkJsonRpcServer {
  constructor(ctx, transport, options = {}) {
    super(ctx, transport, options);
    this.interactionTimeoutMs = options.interactionTimeoutMs ?? 120_000;
    this.preflightTimeoutMs = options.preflightTimeoutMs ?? 60_000;
    this.shutdownController = new AbortController();
    this.sessionByAgent = new WeakMap();
    this.preflightedSessions = new Map();
    this.claimedApprovalIds = new Set();
  }

  async createSession(sessionId) {
    let liveAgent;
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: {
        cwd: this.cwd,
        agentPreset: 'anqi',
      },
      agentOptions: {
        provider: this.provider,
        model: this.model,
        ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
      },
      setup: async (agentCtx) => {
        await this.ctx.agentPresets.mount(agentCtx, 'anqi');
        agentCtx.on('approval/request', (request, next) => {
          if (liveAgent === undefined || request.agent !== liveAgent) return next();
          return this.relayApproval(sessionId, request, next);
        });
      },
    });
    liveAgent = handle.agent;

    const record = { handle };
    this.sessions.set(sessionId, record);
    this.sessionByAgent.set(handle.agent, sessionId);
    return record;
  }

  assertLiveSession(sessionId, expectedAgent) {
    const record = this.sessions.get(sessionId);
    const agent = expectedAgent ?? record?.handle?.agent;
    if (
      agent === undefined
      || record?.handle?.agent !== agent
      || this.ctx.agents.get(agent.id) !== agent
    ) {
      throw new Error(`session is unknown or no longer live: ${sessionId}`);
    }
    return { record, agent };
  }

  async createSessionRequest(params) {
    const sessionId = sessionIdFromParams(params, 'session/create');
    const record = await this.getOrCreateSession(sessionId);
    this.assertLiveSession(sessionId, record.handle.agent);
    return { sessionId };
  }

  async promptSession(params) {
    const sessionId = sessionIdFromParams(params, 'session/prompt');
    const { agent } = this.assertLiveSession(sessionId);
    if (this.preflightedSessions.get(sessionId) !== agent) {
      throw new Error(`session/preflight is required before session/prompt: ${sessionId}`);
    }
    return super.handleRequest('session/prompt', params);
  }

  completePreflight(sessionId, agent, observation) {
    this.assertLiveSession(sessionId, agent);
    this.preflightedSessions.set(sessionId, agent);
    return { sessionId, ...observation };
  }

  async inspectReadiness(sessionId, agent, signal) {
    this.assertLiveSession(sessionId, agent);
    const toolNames = this.ctx.tools.schemas(agent).map((schema) => schema.name);
    const skillSnapshot = await this.ctx.skills.snapshot({
      scope: agent,
      cwd: this.cwd,
      signal,
    });
    this.assertLiveSession(sessionId, agent);
    const skillNames = skillSnapshot.skills.map((skill) => skill.name);
    const toolsReady = toolNames.includes(REQUIRED_MCP_TOOL);
    const skillsReady = skillSnapshot.complete === true
      && skillNames.length === 1
      && skillNames[0] === REQUIRED_SKILL;
    return {
      ready: toolsReady && skillsReady,
      tools: {
        required: REQUIRED_MCP_TOOL,
        visibleNames: toolNames,
        ready: toolsReady,
      },
      skills: {
        complete: skillSnapshot.complete === true,
        names: skillNames,
        required: [REQUIRED_SKILL],
        ready: skillsReady,
      },
    };
  }

  async preflightSession(params) {
    const sessionId = sessionIdFromParams(params, 'session/preflight');
    const { agent } = this.assertLiveSession(sessionId);
    // The current rc.7 transport handler does not expose a request signal. The
    // server shutdown signal and this bounded timeout are the only cancellation
    // sources available at this wire boundary.
    const timeoutSignal = AbortSignal.timeout(this.preflightTimeoutMs);
    const signal = AbortSignal.any([this.shutdownController.signal, timeoutSignal]);
    let changeVersion = 0;
    let waiter;
    let disposalError;
    const invalidate = () => {
      changeVersion += 1;
      waiter?.();
    };
    const onAgentDisposed = (payload) => {
      if (payload?.agent !== agent) return;
      disposalError = new Error(`session agent was disposed during preflight: ${sessionId}`);
      changeVersion += 1;
      waiter?.(disposalError);
    };

    // First observe before subscribing, then subscribe and observe again in the
    // loop below. The second check closes the event-registration race.
    let observation = await this.inspectReadiness(sessionId, agent, signal);
    if (observation.ready) return this.completePreflight(sessionId, agent, observation);

    const disposeToolsListener = this.ctx.on('tools/change', invalidate);
    const disposeSkillsListener = this.ctx.on('skills/change', invalidate);
    const disposeAgentListener = this.ctx.on('agent/disposed', onAgentDisposed);

    const waitForChange = (observedVersion) => new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        if (waiter === settle) waiter = undefined;
      };
      const settle = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error instanceof Error) reject(error);
        else resolve();
      };
      const onAbort = () => settle(abortReason(signal));
      waiter = settle;
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        settle(abortReason(signal));
        return;
      }
      if (disposalError !== undefined) {
        settle(disposalError);
        return;
      }
      if (changeVersion !== observedVersion) settle();
    });

    try {
      for (;;) {
        const beforeVersion = changeVersion;
        observation = await this.inspectReadiness(sessionId, agent, signal);
        if (observation.ready) return this.completePreflight(sessionId, agent, observation);
        if (disposalError !== undefined) throw disposalError;
        const afterVersion = changeVersion;
        if (afterVersion !== beforeVersion) continue;
        await waitForChange(afterVersion);
      }
    } finally {
      disposeToolsListener();
      disposeSkillsListener();
      disposeAgentListener();
    }
  }

  async handleRequest(method, params) {
    switch (method) {
      case 'session/create':
        return this.createSessionRequest(params);
      case 'session/preflight':
        return this.preflightSession(params);
      case 'session/prompt':
        return this.promptSession(params);
      default:
        return super.handleRequest(method, params);
    }
  }

  shutdown() {
    this.preflightedSessions.clear();
    if (!this.shutdownController.signal.aborted) {
      this.shutdownController.abort(new Error('JSON-RPC server is shutting down'));
    }
    return super.shutdown();
  }

  relaySignals(sourceSignal) {
    const timeoutSignal = AbortSignal.timeout(this.interactionTimeoutMs);
    const signals = [this.shutdownController.signal, timeoutSignal];
    if (sourceSignal !== undefined) signals.push(sourceSignal);
    return {
      signal: AbortSignal.any(signals),
      timeoutSignal,
    };
  }

  claimApprovalId(request) {
    const decided = new Set();
    const events = request.agent.session.events;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type === 'approval/decided') {
        decided.add(event.data.id);
        continue;
      }
      if (event.type !== 'approval/asked') continue;
      if (decided.has(event.data.id) || this.claimedApprovalIds.has(event.data.id)) continue;
      if ((request.callId ?? null) !== (event.data.callId ?? null)) continue;
      if (request.toolName !== event.data.toolName) continue;
      this.claimedApprovalIds.add(event.data.id);
      return event.data.id;
    }
    return undefined;
  }

  async relayApproval(sessionId, request, next) {
    if (request.signal?.aborted) return 'cancelled';
    const approvalId = this.claimApprovalId(request);
    if (approvalId === undefined) return next();

    const { signal } = this.relaySignals(request.signal);
    try {
      const result = await this.transport.request('approval/request', {
        sessionId,
        approvalId,
        toolName: request.toolName,
        ...(request.callId === undefined ? {} : { callId: request.callId }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      }, signal);
      if (
        !isRecord(result)
        || result.sessionId !== sessionId
        || result.approvalId !== approvalId
        || !APPROVAL_OUTCOMES.has(result.outcome)
      ) {
        return 'unavailable';
      }
      return result.outcome;
    } catch {
      if (request.signal?.aborted || this.shutdownController.signal.aborted) return 'cancelled';
      return 'unavailable';
    } finally {
      this.claimedApprovalIds.delete(approvalId);
    }
  }

  async askUserQuestion(request) {
    const agent = request.agent;
    if (agent === undefined) {
      throw new UserQuestionError('JSON-RPC user interaction requires an agent-owned session', 'ASK_MISSING_AGENT');
    }
    const sessionId = this.sessionByAgent.get(agent);
    const record = sessionId === undefined ? undefined : this.sessions.get(sessionId);
    if (
      sessionId === undefined
      || record?.handle.agent !== agent
      || this.ctx.agents.get(agent.id) !== agent
    ) {
      throw new UserQuestionError('user-question request did not come from this server\'s live root agent', 'CALLER_NOT_LIVE');
    }

    const { signal, timeoutSignal } = this.relaySignals(request.signal);
    let result;
    try {
      result = await this.transport.request('user-question/request', {
        sessionId,
        questions: request.questions,
      }, signal);
    } catch (error) {
      if (request.signal?.aborted || this.shutdownController.signal.aborted) {
        throw new UserQuestionError('ask_user_question was cancelled before an answer arrived', 'ASK_ABORTED', { cause: error });
      }
      if (timeoutSignal.aborted) {
        throw new UserQuestionError('ask_user_question timed out waiting for the JSON-RPC client', 'ASK_TIMEOUT', { cause: error });
      }
      throw new UserQuestionError('JSON-RPC user-question provider failed', 'PROVIDER_FAILED', { cause: error });
    }
    return validateQuestionAnswer(result, sessionId, request.questions);
  }
}

export function apply(ctx, config) {
  const resolvedConfig = config;
  const rootFiber = ctx.root.fiber;
  const input = config.input ?? process.stdin;
  const output = config.output ?? process.stdout;
  const exit = config.exit ?? ((code) => process.exit(code));
  const transport = new JsonRpcLineTransport(input, output);
  const server = new AnqiJsonRpcServer(ctx, transport, {
    maxTokensAsSuccess: resolvedConfig.maxTokensAsSuccess,
    interactionTimeoutMs: resolvedConfig.interactionTimeoutMs,
    preflightTimeoutMs: resolvedConfig.preflightTimeoutMs,
  });
  let exitTask;

  const disposeAndExit = () => {
    exitTask ??= (async () => {
      await Promise.allSettled([Promise.resolve().then(() => transport.flush())]);
      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())]);
      exit(0);
    })();
    return exitTask;
  };

  transport.onRequest(async (method, params) => {
    const result = await server.handleRequest(method, params);
    if (method === 'shutdown') setImmediate(() => disposeAndExit());
    return result;
  });

  ctx.effect(() => {
    const disposeProvider = ctx.userQuestions.registerProvider({
      ask: (request) => server.askUserQuestion(request),
    });
    transport.start();
    return async () => {
      disposeProvider();
      await server.shutdown();
      transport.close();
    };
  }, 'jsonrpc.serve');
}
