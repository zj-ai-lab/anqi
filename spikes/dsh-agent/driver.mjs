#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import * as nodeModule from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { writeTraceSummary } from './trace-loaded/summarize.mjs';

const SIDECAR_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = join(SIDECAR_DIR, 'agent.config.yaml');
const CORDIS_CONFIG = join(SIDECAR_DIR, 'anqi.cordis.yml');
const DSH_BIN = join(
  SIDECAR_DIR,
  'node_modules',
  '@deepseek-ai',
  'dsh-sdk-jsonrpc-demo',
  'lib',
  'bin.js',
);
const TRACE_PRELOAD = join(SIDECAR_DIR, 'trace-loaded', 'preload.mjs');
const MCP_BIN = join(SIDECAR_DIR, 'mcp', 'server.mjs');
const DEPENDENCY_ROOT = join(SIDECAR_DIR, 'node_modules');
const ANQI_SKILLS_ROOT = join(SIDECAR_DIR, 'skills');
const REQUIRED_ANQI_SKILL = join(ANQI_SKILLS_ROOT, 'anqi-case-brief', 'SKILL.md');
const REQUIRED_MCP_TOOL = 'mcp__anqi-local__case_folder_info';
const ALLOWED_CONFIG_KEYS = new Set(['enabled', 'provider', 'baseURL', 'model', 'apiKeyEnv']);
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const PREFLIGHT_REQUEST_TIMEOUT_MS = 90_000;

function verifyTrustedSkillsRoot() {
  let rootStat;
  try {
    rootStat = lstatSync(ANQI_SKILLS_ROOT);
  } catch {
    throw new Error(`trusted anqi skill root not found: ${ANQI_SKILLS_ROOT}`);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`trusted anqi skill root must be a real directory: ${ANQI_SKILLS_ROOT}`);
  }

  const root = realpathSync(ANQI_SKILLS_ROOT);
  const pendingDirectories = [root];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    let entries;
    try {
      entries = readdirSync(directory);
    } catch (error) {
      throw new Error(`trusted anqi skill root could not be read: ${directory}`, { cause: error });
    }
    for (const name of entries) {
      const entryPath = join(directory, name);
      let entryStat;
      try {
        entryStat = lstatSync(entryPath);
      } catch (error) {
        throw new Error(`trusted anqi skill entry could not be inspected: ${entryPath}`, { cause: error });
      }
      if (entryStat.isSymbolicLink()) {
        throw new Error(`trusted anqi skill tree must not contain symlinks: ${entryPath}`);
      }
      if (entryStat.isDirectory()) {
        pendingDirectories.push(entryPath);
      } else if (!entryStat.isFile()) {
        throw new Error(`trusted anqi skill tree contains a non-regular entry: ${entryPath}`);
      }
    }
  }

  const skillDirectory = join(root, 'anqi-case-brief');
  const skillPath = join(skillDirectory, 'SKILL.md');
  let skillDirectoryStat;
  let skillStat;
  try {
    skillDirectoryStat = lstatSync(skillDirectory);
    skillStat = lstatSync(skillPath);
  } catch {
    throw new Error(`required anqi skill not found: ${REQUIRED_ANQI_SKILL}`);
  }
  if (!skillDirectoryStat.isDirectory() || skillDirectoryStat.isSymbolicLink()) {
    throw new Error(`required anqi skill directory must be real: ${skillDirectory}`);
  }
  if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
    throw new Error(`required anqi skill must be a real file: ${REQUIRED_ANQI_SKILL}`);
  }
  return root;
}

function materializeTrustedSkillsRoot(sourceRoot) {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'anqi-dsh-skills-'));
  try {
    chmodSync(runtimeRoot, 0o700);
    const runtimeSkillDirectory = join(runtimeRoot, 'anqi-case-brief');
    mkdirSync(runtimeSkillDirectory, { mode: 0o700 });
    chmodSync(runtimeSkillDirectory, 0o700);
    copyFileSync(
      join(sourceRoot, 'anqi-case-brief', 'SKILL.md'),
      join(runtimeSkillDirectory, 'SKILL.md'),
    );
    chmodSync(join(runtimeSkillDirectory, 'SKILL.md'), 0o600);
    return runtimeRoot;
  } catch (error) {
    rmSync(runtimeRoot, { recursive: true, force: true });
    throw new Error(`could not materialize trusted anqi skills: ${sourceRoot}`, { cause: error });
  }
}

function usage() {
  return `Usage: node driver.mjs --case <exact-case-folder-name> --ask <question> [options]

Options:
  --config <yaml>             Agent configuration (default: agent.config.yaml)
  --approval <policy>         reject or allow-once (default: reject)
  --question-answer <text>    Answer user questions; separate multiple answers with " / "
  --trace-loaded              Trace CJS/ESM loads; requires empty inherited NODE_OPTIONS

The sidecar is fail-closed: agent.config.yaml must exist, enabled must be true,
and apiKeyEnv must name a populated environment variable. Approval defaults to
rejection, unanswered questions fail, and key values are never printed.`;
}

function parseArgs(argv) {
  const result = { approval: 'reject' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') return { help: true };
    if (token === '--trace-loaded') {
      if (result.traceLoaded === true) throw new Error('--trace-loaded may be specified only once');
      result.traceLoaded = true;
      continue;
    }
    if (!['--case', '--ask', '--config', '--approval', '--question-answer'].includes(token)) {
      throw new Error(`unknown argument: ${token}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
    const key = token === '--question-answer' ? 'questionAnswer' : token.slice(2);
    result[key] = value;
    index += 1;
  }
  if (!result.case) throw new Error('--case is required');
  if (!result.ask) throw new Error('--ask is required');
  if (!['reject', 'allow-once'].includes(result.approval)) {
    throw new Error('--approval must be reject or allow-once');
  }
  if (result.questionAnswer !== undefined && !String(result.questionAnswer).trim()) {
    throw new Error('--question-answer must not be empty');
  }
  if (result.traceLoaded && typeof nodeModule.registerHooks !== 'function') {
    throw new Error(
      '--trace-loaded requires node:module.registerHooks() (Node 22.15+, 23.5+, or later)',
    );
  }
  return result;
}

function readConfig(configPath) {
  if (!existsSync(configPath)) {
    throw new Error(`configuration not found: ${configPath}; copy agent.config.example.yaml first`);
  }
  const document = yaml.load(readFileSync(configPath, 'utf8'));
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('agent config must be one YAML mapping');
  }
  const unknown = Object.keys(document).filter((key) => !ALLOWED_CONFIG_KEYS.has(key));
  if (unknown.length) throw new Error(`unknown agent config field(s): ${unknown.join(', ')}`);
  if (document.enabled !== true) throw new Error('DSH sidecar is disabled (set enabled: true explicitly)');

  const provider = String(document.provider || '');
  if (!['deepseek-official', 'openai-completions'].includes(provider)) {
    throw new Error('provider must be deepseek-official or openai-completions');
  }
  const model = String(document.model || '').trim();
  const apiKeyEnv = String(document.apiKeyEnv || '').trim();
  if (!model) throw new Error('model is required');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error('apiKeyEnv must be an environment variable name');
  }
  if (!process.env[apiKeyEnv]) throw new Error(`${apiKeyEnv} is not set`);

  let baseURL = String(document.baseURL || '').trim();
  if (provider === 'deepseek-official' && !baseURL) baseURL = 'https://api.deepseek.com';
  let parsedBaseURL;
  try {
    parsedBaseURL = new URL(baseURL);
  } catch {
    throw new Error('baseURL must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(parsedBaseURL.protocol)) {
    throw new Error('baseURL must use HTTP or HTTPS');
  }
  if (parsedBaseURL.username || parsedBaseURL.password) {
    throw new Error('baseURL must not contain credentials');
  }

  return {
    provider,
    runtimeProvider: provider === 'openai-completions' ? 'anqi-openai' : 'deepseek-official',
    baseURL: parsedBaseURL.toString().replace(/\/$/, ''),
    model,
    apiKeyEnv,
  };
}

function resolveCaseDirectory(caseName) {
  const filesRoot = process.env.ANJIAN_FILES_ROOT;
  if (!filesRoot) throw new Error('ANJIAN_FILES_ROOT is not set');
  const cleanName = String(caseName).trim();
  if (
    !cleanName
    || cleanName === '.'
    || cleanName === '..'
    || cleanName.startsWith('.')
    || cleanName.includes('/')
    || cleanName.includes('\\')
    || /[\0-\x1f\x7f]/.test(cleanName)
    || Buffer.byteLength(cleanName, 'utf8') > 255
  ) {
    throw new Error('--case must be one valid, non-hidden case-folder name');
  }

  const root = realpathSync(resolve(filesRoot));
  const candidate = join(root, cleanName);
  const stat = lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`case folder is not a real directory: ${cleanName}`);
  }
  const actual = realpathSync(candidate);
  const rel = relative(root, actual);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || basename(actual) !== cleanName) {
    throw new Error('case folder escapes ANJIAN_FILES_ROOT');
  }
  return actual;
}

function timeoutPromise(ms, message) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  const timeout = timeoutPromise(ms, 'DSH process did not exit after shutdown');
  return Promise.race([
    new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal }))),
    timeout.promise,
  ]).finally(timeout.cancel);
}

function traceNodeOptions(preloadPath) {
  return `--import=${pathToFileURL(preloadPath).href}`;
}

async function finalizeLoadedTrace(traceDirectory, childClosed) {
  if (traceDirectory === null) return;
  const timeout = timeoutPromise(30_000, 'DSH stdio did not close before trace summarization');
  let exit;
  try {
    exit = await Promise.race([childClosed, timeout.promise]);
  } catch (error) {
    process.stderr.write(`[trace-loaded/error] ${JSON.stringify({
      v: 1,
      traceDirectory,
      error: error.message,
    })}\n`);
    return;
  } finally {
    timeout.cancel();
  }

  try {
    const { summary, summaryPath } = writeTraceSummary(traceDirectory, {
      dependencyRoot: DEPENDENCY_ROOT,
      projectRoot: SIDECAR_DIR,
      requiredEntries: [DSH_BIN, MCP_BIN],
    });
    process.stderr.write(`[trace-loaded] ${JSON.stringify({
      v: 1,
      traceDirectory,
      summaryPath,
      exit,
      records: summary.records,
      malformedLines: summary.malformedLines,
      completeness: summary.completeness,
      processEntries: summary.processEntries,
      packageResolution: summary.packageResolution,
      edges: summary.edges,
      loads: summary.loads,
      loaded: summary.loaded,
      reachedDependencies: summary.reachedDependencies,
      reachedDirectDependencies: summary.reachedDirectDependencies,
      packageRoots: summary.packages.length,
    })}\n`);
  } catch (error) {
    process.stderr.write(`[trace-loaded/error] ${JSON.stringify({
      v: 1,
      traceDirectory,
      exit,
      error: error.message,
    })}\n`);
  }
}

function printContentBlocks(prefix, blocks, redact) {
  if (!Array.isArray(blocks)) {
    process.stdout.write(`${prefix} ${redact(JSON.stringify(blocks))}\n`);
    return;
  }
  for (const block of blocks) {
    if (block?.type === 'text') process.stdout.write(`${prefix} ${redact(String(block.text || ''))}\n`);
    else process.stdout.write(`${prefix} ${redact(JSON.stringify(block))}\n`);
  }
}

function createRpcClient(child, secretValues, interactionPolicy) {
  let nextId = 1;
  let closed = false;
  let promptStartedAt;
  let activeSessionId;
  let firstTokenRecorded = false;
  let sawRunning = false;
  let sawIdle = false;
  let sawCompletedTurnEnd = false;
  let firstRequestHeader;
  let sawRequiredMcpToolCall = false;
  let resolveTurn;
  let rejectTurn;
  const pending = new Map();
  const handledChildRequests = new Set();
  const turnDone = new Promise((resolveDone, rejectDone) => {
    resolveTurn = resolveDone;
    rejectTurn = rejectDone;
  });
  // The promise is armed before a request and may otherwise reject during startup.
  turnDone.catch(() => {});

  const redact = (input) => secretValues.reduce(
    (text, secret) => (secret ? text.replaceAll(secret, '[REDACTED]') : text),
    String(input),
  );

  function assertFirstRequestReadiness() {
    if (!firstRequestHeader || firstRequestHeader.reason !== 'initial') {
      throw new Error('first request/header must have reason=initial');
    }
    const tools = firstRequestHeader.header?.tools;
    if (!Array.isArray(tools) || !tools.some((tool) => tool?.name === REQUIRED_MCP_TOOL)) {
      throw new Error(`first request/header is missing ${REQUIRED_MCP_TOOL}`);
    }
    if (!sawRequiredMcpToolCall) {
      throw new Error(`turn did not call ${REQUIRED_MCP_TOOL}`);
    }
  }

  function failAll(error) {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    rejectTurn(error);
  }

  function maybeResolveTurn() {
    if (!sawRunning || !sawIdle || !sawCompletedTurnEnd) return;
    try {
      assertFirstRequestReadiness();
      resolveTurn();
    } catch (error) {
      rejectTurn(error);
    }
  }

  function childRequestError(message, code = -32602) {
    const error = new Error(message);
    error.rpcCode = code;
    return error;
  }

  function writeChildResponse(frame) {
    if (closed || !child.stdin.writable) {
      failAll(new Error('cannot answer DSH request: JSON-RPC client is closed'));
      return;
    }
    child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
      if (error) failAll(error);
    });
  }

  function requireActiveSession(params) {
    if (!activeSessionId || params?.sessionId !== activeSessionId) {
      throw childRequestError('request does not belong to the active session', -32001);
    }
  }

  function approvalResult(params) {
    requireActiveSession(params);
    if (typeof params.approvalId !== 'string' || !params.approvalId) {
      throw childRequestError('approvalId must be a non-empty string');
    }
    if (typeof params.toolName !== 'string' || !params.toolName) {
      throw childRequestError('toolName must be a non-empty string');
    }
    return {
      sessionId: activeSessionId,
      approvalId: params.approvalId,
      outcome: interactionPolicy.approval === 'allow-once' ? 'allowed-once' : 'rejected',
    };
  }

  function questionResult(params) {
    requireActiveSession(params);
    if (!Array.isArray(params.questions) || params.questions.length === 0) {
      throw childRequestError('questions must be a non-empty array');
    }
    if (interactionPolicy.questionAnswer === undefined) {
      throw childRequestError('no --question-answer was configured', -32004);
    }

    const questions = params.questions;
    const ids = new Set();
    for (const question of questions) {
      if (!question || typeof question !== 'object' || Array.isArray(question)) {
        throw childRequestError('each question must be an object');
      }
      if (typeof question.id !== 'string' || !question.id || ids.has(question.id)) {
        throw childRequestError('question ids must be unique non-empty strings');
      }
      if (typeof question.question !== 'string' || !question.question.trim()) {
        throw childRequestError('question text must be a non-empty string');
      }
      ids.add(question.id);
    }

    const configured = String(interactionPolicy.questionAnswer).trim();
    const parts = questions.length === 1
      ? [configured]
      : configured.split(/\s*\/\s*/u).map((part) => part.trim());
    if (parts.length !== questions.length || parts.some((part) => !part)) {
      throw childRequestError(
        `--question-answer must contain ${questions.length} non-empty slash-separated answer(s)`,
        -32004,
      );
    }

    return {
      sessionId: activeSessionId,
      answer: {
        answers: questions.map((question, index) => ({
          id: question.id,
          selected: [],
          custom: parts[index],
        })),
      },
    };
  }

  function handleChildRequest(message) {
    const requestKey = `${typeof message.id}:${String(message.id)}`;
    if (handledChildRequests.has(requestKey)) {
      writeChildResponse({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32600, message: 'duplicate JSON-RPC request id' },
      });
      return;
    }
    handledChildRequests.add(requestKey);

    try {
      const params = message.params || {};
      let result;
      if (message.method === 'approval/request') {
        process.stdout.write(`[approval/request] ${redact(JSON.stringify(params))}\n`);
        result = approvalResult(params);
        process.stdout.write(`[approval/response] ${redact(JSON.stringify(result))}\n`);
      } else if (message.method === 'user-question/request') {
        process.stdout.write(`[user-question/request] ${redact(JSON.stringify(params))}\n`);
        result = questionResult(params);
        process.stdout.write(`[user-question/response] ${redact(JSON.stringify(result))}\n`);
      } else {
        throw childRequestError(`unknown DSH request method: ${message.method}`, -32601);
      }
      writeChildResponse({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      const code = Number.isInteger(error.rpcCode) ? error.rpcCode : -32603;
      const detail = redact(error.message || String(error));
      process.stdout.write(`[${redact(message.method)}/error] ${detail}\n`);
      writeChildResponse({
        jsonrpc: '2.0',
        id: message.id,
        error: { code, message: detail },
      });
    }
  }

  function handleNotification(message) {
    const params = message.params || {};
    if (message.method === 'session.status') {
      process.stdout.write(`[session.status] ${redact(params.sessionId)} ${redact(params.status)}\n`);
      if (params.sessionId === activeSessionId && params.status === 'running') sawRunning = true;
      if (params.sessionId === activeSessionId && params.status === 'idle') {
        sawIdle = true;
        maybeResolveTurn();
      }
      return;
    }
    if (message.method === 'subagent.started' || message.method === 'subagent.finished') {
      process.stdout.write(`[${message.method}] ${redact(JSON.stringify(params))}\n`);
      return;
    }
    if (message.method !== 'session.event') {
      process.stdout.write(`[notification] ${redact(message.method)} ${redact(JSON.stringify(params))}\n`);
      return;
    }
    if (params.sessionId !== activeSessionId) return;

    const event = params.event || {};
    if (event.type === 'assistant/chunk' && !firstTokenRecorded) {
      firstTokenRecorded = true;
      const latency = promptStartedAt === undefined ? null : performance.now() - promptStartedAt;
      if (latency !== null) process.stdout.write(`[metric] first_assistant_chunk_ms=${latency.toFixed(1)}\n`);
    }
    if (event.type === 'request/header') {
      if (firstRequestHeader === undefined) firstRequestHeader = event.data;
      process.stdout.write(`[request/header] ${redact(JSON.stringify(event.data))}\n`);
    } else if (event.type === 'tool/call') {
      if (event.data?.name === REQUIRED_MCP_TOOL) sawRequiredMcpToolCall = true;
      process.stdout.write(`[tool/call] ${redact(JSON.stringify(event.data))}\n`);
    } else if (event.type === 'tool/result') {
      process.stdout.write(`[tool/result] ${redact(JSON.stringify(event.data))}\n`);
    } else if (event.type === 'turn/end') {
      process.stdout.write(`[turn/end] ${redact(JSON.stringify(event.data))}\n`);
      if (event.data?.reason?.kind !== 'completed') {
        rejectTurn(new Error(`DSH turn ended with ${redact(JSON.stringify(event.data?.reason || {}))}`));
      } else {
        sawCompletedTurnEnd = true;
        maybeResolveTurn();
      }
    } else if (event.type === 'assistant/message') {
      if (!firstTokenRecorded) {
        firstTokenRecorded = true;
        const latency = promptStartedAt === undefined ? null : performance.now() - promptStartedAt;
        if (latency !== null) process.stdout.write(`[metric] first_assistant_message_ms=${latency.toFixed(1)}\n`);
      }
      printContentBlocks('[assistant]', event.data?.message?.content, redact);
    }
  }

  const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdout.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      failAll(new Error(`non-JSON data on DSH stdout: ${redact(line)}`));
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      handleChildRequest(message);
      return;
    }
    if (message.id !== undefined && ('result' in message || 'error' in message)) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) {
        const detail = redact(message.error.message || JSON.stringify(message.error));
        entry.reject(new Error(`JSON-RPC ${entry.method} failed: ${detail}`));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (message.method) handleNotification(message);
  });
  stdout.on('error', failAll);
  child.stdin.on('error', failAll);

  child.once('error', (error) => failAll(new Error(`failed to start DSH: ${error.message}`)));
  child.once('exit', (code, signal) => {
    failAll(new Error(`DSH exited (code=${code}, signal=${signal || 'none'})`));
  });

  return {
    redact,
    markPromptStart(sessionId) {
      activeSessionId = sessionId;
      promptStartedAt = performance.now();
    },
    request(method, params, timeoutMs = 60_000) {
      if (closed) return Promise.reject(new Error('JSON-RPC client is closed'));
      const id = nextId;
      nextId += 1;
      const timeout = timeoutPromise(timeoutMs, `JSON-RPC ${method} timed out`);
      const response = new Promise((resolveResponse, rejectResponse) => {
        pending.set(id, {
          method,
          resolve: resolveResponse,
          reject: rejectResponse,
        });
        child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          ...(params === undefined ? {} : { params }),
        })}\n`, (error) => {
          if (!error) return;
          pending.delete(id);
          rejectResponse(error);
        });
      });
      return Promise.race([response, timeout.promise]).finally(() => {
        timeout.cancel();
        if (pending.get(id)?.method === method) pending.delete(id);
      });
    },
    waitForTurn(timeoutMs = TURN_TIMEOUT_MS) {
      const timeout = timeoutPromise(timeoutMs, 'DSH turn timed out');
      return Promise.race([turnDone, timeout.promise]).finally(timeout.cancel);
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args.traceLoaded && String(process.env.NODE_OPTIONS || '').trim()) {
    throw new Error('--trace-loaded requires inherited NODE_OPTIONS to be empty');
  }

  const configPath = resolve(args.config || DEFAULT_CONFIG);
  const config = readConfig(configPath);
  const caseDirectory = resolveCaseDirectory(args.case);
  const trustedSkillsRoot = verifyTrustedSkillsRoot();
  const requiredRuntimePaths = [CORDIS_CONFIG, DSH_BIN];
  if (args.traceLoaded) requiredRuntimePaths.push(TRACE_PRELOAD, MCP_BIN);
  for (const path of requiredRuntimePaths) {
    if (!existsSync(path)) throw new Error(`required DSH runtime file not found: ${path}`);
  }
  const anqiSkillsRoot = materializeTrustedSkillsRoot(trustedSkillsRoot);

  const traceDirectory = args.traceLoaded
    ? mkdtempSync(join(tmpdir(), 'anqi-dsh-load-trace-'))
    : null;
  if (traceDirectory !== null) chmodSync(traceDirectory, 0o700);
  const childArguments = [DSH_BIN, CORDIS_CONFIG];
  const internalKeyEnv = process.env.ANQI_INTERNAL_KEY_ENV || 'ANJIAN_INTERNAL_KEY';
  const secretValues = [process.env[config.apiKeyEnv], process.env[internalKeyEnv]].filter(Boolean);
  const child = spawn(process.execPath, childArguments, {
    cwd: SIDECAR_DIR,
    env: {
      ...process.env,
      ...(traceDirectory === null
        ? {}
        : { NODE_OPTIONS: traceNodeOptions(TRACE_PRELOAD) }),
      // The launcher gives this environment variable precedence over argv.
      // Pin it so a user's existing DSH profile can never replace the spike composition.
      DSH_CORDIS_CONFIG: CORDIS_CONFIG,
      DSH_PROVIDER_KIND: config.provider,
      DSH_API_KEY_ENV: config.apiKeyEnv,
      DSH_BASE_URL: config.baseURL,
      DSH_MODEL: config.model,
      DSH_CWD: caseDirectory,
      DSH_ANQI_SKILLS_ROOT: anqiSkillsRoot,
      DSH_SESSION_ROOT: join(SIDECAR_DIR, '.runtime', 'sessions'),
      ...(traceDirectory === null ? {} : { ANQI_DSH_LOAD_TRACE_DIR: traceDirectory }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const childClosed = new Promise((resolveClose) => {
    child.once('close', (code, signal) => resolveClose({ code, signal }));
  });
  const rpc = createRpcClient(child, secretValues, {
    approval: args.approval,
    questionAnswer: args.questionAnswer,
  });
  const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
  stderr.on('line', (line) => process.stderr.write(`[dsh] ${rpc.redact(line)}\n`));

  let initialized = false;
  let shuttingDown = false;
  const stop = () => {
    if (!shuttingDown && child.exitCode === null) child.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    const coldStartedAt = performance.now();
    const initializedResult = await rpc.request('initialize', {
      cwd: caseDirectory,
      provider: config.runtimeProvider,
      model: config.model,
    }, 120_000);
    initialized = true;
    process.stdout.write(
      `[initialize] ${rpc.redact(JSON.stringify(initializedResult))} cold_ms=${(performance.now() - coldStartedAt).toFixed(1)}\n`,
    );

    const sessionId = `anqi-${randomUUID()}`;
    const created = await rpc.request('session/create', { sessionId }, 120_000);
    if (created?.sessionId !== sessionId) throw new Error('session/create returned the wrong session identity');
    process.stdout.write(`[session/create] ${rpc.redact(JSON.stringify(created))}\n`);

    const preflight = await rpc.request(
      'session/preflight',
      { sessionId },
      PREFLIGHT_REQUEST_TIMEOUT_MS,
    );
    const skillNames = preflight?.skills?.names;
    const visibleToolNames = preflight?.tools?.visibleNames;
    if (
      preflight?.ready !== true
      || preflight.tools?.required !== REQUIRED_MCP_TOOL
      || preflight.tools?.ready !== true
      || !Array.isArray(visibleToolNames)
      || !visibleToolNames.includes(REQUIRED_MCP_TOOL)
      || preflight.skills?.complete !== true
      || !Array.isArray(skillNames)
      || skillNames.length !== 1
      || skillNames[0] !== 'anqi-case-brief'
      || preflight.skills?.ready !== true
    ) {
      throw new Error('session/preflight did not establish the required scoped tools and skill');
    }
    process.stdout.write(`[session/preflight] ${rpc.redact(JSON.stringify(preflight))}\n`);

    rpc.markPromptStart(sessionId);
    const receipt = await rpc.request('session/prompt', {
      sessionId,
      contentBlocks: [{ type: 'text', text: args.ask }],
    });
    process.stdout.write(`[session/prompt] ${rpc.redact(JSON.stringify({ sessionId, ...receipt }))}\n`);
    await rpc.waitForTurn();

    shuttingDown = true;
    const shutdown = await rpc.request('shutdown', undefined, 30_000);
    process.stdout.write(`[shutdown] ${rpc.redact(JSON.stringify(shutdown))}\n`);
    const exit = await waitForExit(child, 30_000);
    if (exit.code !== 0) throw new Error(`DSH exited after shutdown with code=${exit.code} signal=${exit.signal || 'none'}`);
  } catch (error) {
    shuttingDown = true;
    if (initialized && child.exitCode === null) {
      try {
        await rpc.request('shutdown', undefined, 10_000);
        await waitForExit(child, 10_000);
      } catch {
        child.kill('SIGTERM');
      }
    } else if (child.exitCode === null) {
      child.kill('SIGTERM');
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await finalizeLoadedTrace(traceDirectory, childClosed);
    rmSync(anqiSkillsRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`driver: ${error.message}\n`);
  process.exitCode = 1;
});
