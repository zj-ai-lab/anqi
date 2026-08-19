import Schema from '@deepseek-ai/schemastery';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server';
import { SessionId } from '@deepseek-ai/dsh-session';
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions';

export const name = 'dsh-anqi-jsonrpc';
export const inject = ['agents', 'agentPresets', 'userQuestions', 'approval'];
export const Config = Schema.object({
  maxTokensAsSuccess: Schema.boolean().default(false),
  interactionTimeoutMs: Schema.number().step(1).min(1_000).default(120_000),
});

const APPROVAL_OUTCOMES = new Set([
  'allowed-once',
  'rejected',
  'cancelled',
  'unavailable',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
    this.shutdownController = new AbortController();
    this.sessionByAgent = new WeakMap();
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

  shutdown() {
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
