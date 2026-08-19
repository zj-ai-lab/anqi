#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

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
const ALLOWED_CONFIG_KEYS = new Set(['enabled', 'provider', 'baseURL', 'model', 'apiKeyEnv']);
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

function usage() {
  return `Usage: node driver.mjs --case <exact-case-folder-name> --ask <question> [--config <yaml>]

The sidecar is fail-closed: agent.config.yaml must exist, enabled must be true,
and apiKeyEnv must name a populated environment variable. Key values are never printed.`;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') return { help: true };
    if (!['--case', '--ask', '--config'].includes(token)) {
      throw new Error(`unknown argument: ${token}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
    result[token.slice(2)] = value;
    index += 1;
  }
  if (!result.case) throw new Error('--case is required');
  if (!result.ask) throw new Error('--ask is required');
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
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  const timeout = timeoutPromise(ms, 'DSH process did not exit after shutdown');
  return Promise.race([
    new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal }))),
    timeout.promise,
  ]).finally(timeout.cancel);
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

function createRpcClient(child, secretValues) {
  let nextId = 1;
  let closed = false;
  let promptStartedAt;
  let activeSessionId;
  let firstTokenRecorded = false;
  let sawRunning = false;
  let resolveTurn;
  let rejectTurn;
  const pending = new Map();
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

  function failAll(error) {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    rejectTurn(error);
  }

  function handleNotification(message) {
    const params = message.params || {};
    if (message.method === 'session.status') {
      process.stdout.write(`[session.status] ${redact(params.sessionId)} ${redact(params.status)}\n`);
      if (params.sessionId === activeSessionId && params.status === 'running') sawRunning = true;
      if (params.sessionId === activeSessionId && params.status === 'idle' && sawRunning) resolveTurn();
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
      process.stdout.write(`[request/header] ${redact(JSON.stringify(event.data))}\n`);
    } else if (event.type === 'tool/call') {
      process.stdout.write(`[tool/call] ${redact(JSON.stringify(event.data))}\n`);
    } else if (event.type === 'tool/result') {
      process.stdout.write(`[tool/result] ${redact(JSON.stringify(event.data))}\n`);
    } else if (event.type === 'turn/end') {
      process.stdout.write(`[turn/end] ${redact(JSON.stringify(event.data))}\n`);
      if (event.data?.reason?.kind !== 'completed') {
        rejectTurn(new Error(`DSH turn ended with ${redact(JSON.stringify(event.data?.reason || {}))}`));
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

  const configPath = resolve(args.config || DEFAULT_CONFIG);
  const config = readConfig(configPath);
  const caseDirectory = resolveCaseDirectory(args.case);
  for (const path of [CORDIS_CONFIG, DSH_BIN]) {
    if (!existsSync(path)) throw new Error(`required DSH runtime file not found: ${path}`);
  }

  const internalKeyEnv = process.env.ANQI_INTERNAL_KEY_ENV || 'ANJIAN_INTERNAL_KEY';
  const secretValues = [process.env[config.apiKeyEnv], process.env[internalKeyEnv]].filter(Boolean);
  const child = spawn(process.execPath, [DSH_BIN, CORDIS_CONFIG], {
    cwd: SIDECAR_DIR,
    env: {
      ...process.env,
      // The launcher gives this environment variable precedence over argv.
      // Pin it so a user's existing DSH profile can never replace the spike composition.
      DSH_CORDIS_CONFIG: CORDIS_CONFIG,
      DSH_PROVIDER_KIND: config.provider,
      DSH_API_KEY_ENV: config.apiKeyEnv,
      DSH_BASE_URL: config.baseURL,
      DSH_MODEL: config.model,
      DSH_CWD: caseDirectory,
      DSH_SESSION_ROOT: join(SIDECAR_DIR, '.runtime', 'sessions'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc = createRpcClient(child, secretValues);
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
  }
}

main().catch((error) => {
  process.stderr.write(`driver: ${error.message}\n`);
  process.exitCode = 1;
});
