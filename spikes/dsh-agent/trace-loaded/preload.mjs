import Module, { builtinModules, registerHooks } from 'node:module';
import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { threadId } from 'node:worker_threads';

const MAX_TEXT_BYTES = 4 * 1024;
const MAX_TRACE_BYTES = 32 * 1024 * 1024;
const DROP_RECORD_RESERVE_BYTES = 512;
const traceDirectory = process.env.ANQI_DSH_LOAD_TRACE_DIR;
const internalKeyEnv = process.env.ANQI_INTERNAL_KEY_ENV || 'ANJIAN_INTERNAL_KEY';
const traceSecretValues = [...new Set([
  process.env.DSH_API_KEY_ENV,
  internalKeyEnv,
].map((name) => (name ? process.env[name] : undefined)).filter(Boolean))];

if (!traceDirectory || !isAbsolute(traceDirectory)) {
  throw new Error('ANQI_DSH_LOAD_TRACE_DIR must be an absolute directory');
}
if (typeof registerHooks !== 'function') {
  throw new Error('loaded-module tracing requires node:module.registerHooks()');
}

const tracePath = join(traceDirectory, `${process.pid}-${threadId}.jsonl`);
const traceFd = openSync(
  tracePath,
  constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
  0o600,
);
const builtinNames = new Set(builtinModules.map((name) => name.replace(/^node:/u, '')));
const cjsFrames = [];
let sequence = 0;
let cjsLoadSequence = 0;
let writtenBytes = 0;
let disabled = false;
let warned = false;

function clippedText(value) {
  let text;
  try {
    text = String(value);
  } catch {
    return '[unprintable]';
  }
  for (const secret of traceSecretValues) text = text.replaceAll(secret, '[REDACTED]');
  const buffer = Buffer.from(text);
  if (buffer.length <= MAX_TEXT_BYTES) return text;

  // Reserve for the complete omission marker. Its final byte length cannot be
  // larger than this worst case because omitted bytes <= original bytes.
  const markerReserve = Buffer.byteLength(`…[${buffer.length} bytes omitted]`);
  let prefixEnd = MAX_TEXT_BYTES - markerReserve;
  while (prefixEnd > 0 && (buffer[prefixEnd] & 0xc0) === 0x80) prefixEnd -= 1;
  const prefix = buffer.subarray(0, prefixEnd).toString('utf8');
  const marker = `…[${buffer.length - Buffer.byteLength(prefix)} bytes omitted]`;
  return `${prefix}${marker}`;
}

function writeAll(buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const count = writeSync(traceFd, buffer, offset, buffer.length - offset);
    if (count <= 0) throw new Error('trace write made no progress');
    offset += count;
  }
}

function disableAfterFailure() {
  disabled = true;
  if (warned) return;
  warned = true;
  try {
    process.stderr.write('[dsh-load-trace] tracing disabled after a write failure\n');
  } catch {
    // Tracing must never alter the target process's failure path.
  }
}

function emit(event) {
  if (disabled) return;
  try {
    const nextSequence = sequence + 1;
    const line = Buffer.from(`${JSON.stringify({
      v: 1,
      pid: process.pid,
      tid: threadId,
      seq: nextSequence,
      ...event,
    })}\n`);
    if (writtenBytes + line.length > MAX_TRACE_BYTES - DROP_RECORD_RESERVE_BYTES) {
      const dropped = Buffer.from(`${JSON.stringify({
        v: 1,
        pid: process.pid,
        tid: threadId,
        seq: nextSequence,
        event: 'trace.dropped',
        reason: 'per-file-byte-limit',
        maxBytes: MAX_TRACE_BYTES,
      })}\n`);
      if (
        dropped.length > DROP_RECORD_RESERVE_BYTES
        || writtenBytes + dropped.length > MAX_TRACE_BYTES
      ) {
        throw new Error('reserved trace.dropped record does not fit');
      }
      writeAll(dropped);
      sequence = nextSequence;
      writtenBytes += dropped.length;
      disabled = true;
      return;
    }
    writeAll(line);
    sequence = nextSequence;
    writtenBytes += line.length;
  } catch {
    disableAfterFailure();
  }
}

function normalizedURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'data:') return 'data:';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    if (url.protocol === 'file:') {
      try {
        let path = fileURLToPath(url);
        for (const secret of traceSecretValues) path = path.replaceAll(secret, '[REDACTED]');
        return clippedText(pathToFileURL(path).href);
      } catch {
        // Keep a bounded/redacted reference; the summarizer rejects non-local
        // or otherwise non-convertible file URLs and marks the trace incomplete.
      }
    }
    return clippedText(url.href);
  } catch {
    return clippedText(value);
  }
}

function safeModuleReference(value, parentURL = null) {
  let text;
  try {
    text = String(value);
  } catch {
    return '[unprintable]';
  }
  try {
    return normalizedURL(new URL(text).href);
  } catch {
    // Bare package/builtin specifiers are not URLs. Resolve only path-like
    // references so query/hash data on relative ESM imports is also removed.
    if (parentURL !== null && /^(?:\.{1,2}\/|\/)/u.test(text)) {
      try {
        return normalizedURL(new URL(text, parentURL).href);
      } catch {
        // Fall through to bounded text for malformed references.
      }
    }
    const suffixIndex = text.search(/[?#]/u);
    return clippedText(suffixIndex > 0
      ? `${text.slice(0, suffixIndex)}[query-or-hash-removed]`
      : text);
  }
}

function cjsParentURL(parent) {
  const filename = parent?.filename;
  return typeof filename === 'string' && isAbsolute(filename)
    ? normalizedURL(pathToFileURL(filename).href)
    : null;
}

function cjsParentEvidence(parent) {
  return {
    parentURL: cjsParentURL(parent),
    parentId: typeof parent?.id === 'string' ? safeModuleReference(parent.id) : null,
  };
}

function moduleIdURL(resolved) {
  if (typeof resolved !== 'string') return null;
  if (resolved.startsWith('node:')) return normalizedURL(resolved);
  if (builtinNames.has(resolved)) return `node:${resolved}`;
  return isAbsolute(resolved) ? normalizedURL(pathToFileURL(resolved).href) : null;
}

function errorEvidence(error) {
  return {
    errorName: typeof error?.name === 'string' ? clippedText(error.name) : 'Error',
    errorCode: typeof error?.code === 'string' ? clippedText(error.code) : null,
  };
}

function sourceBytes(source) {
  if (typeof source === 'string') return Buffer.byteLength(source);
  if (source instanceof ArrayBuffer) return source.byteLength;
  if (ArrayBuffer.isView(source)) return source.byteLength;
  return null;
}

function processEntryURL() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || !entry) return null;
  try {
    const url = new URL(entry);
    if (url.protocol === 'file:') return normalizedURL(url.href);
  } catch {
    // Node normally exposes argv[1] as a path.
  }
  try {
    return normalizedURL(pathToFileURL(resolve(entry)).href);
  } catch {
    return null;
  }
}

const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;

Module._resolveFilename = function tracedResolveFilename(request, parent, isMain, options) {
  const frame = cjsFrames.at(-1);
  try {
    const resolved = Reflect.apply(originalResolveFilename, this, arguments);
    const resolvedURL = moduleIdURL(resolved);
    if (frame && frame.request === request && frame.parent === parent) {
      frame.resolvedURL = resolvedURL;
    }
    emit({
      event: 'cjs.resolve',
      cjsLoadId: frame?.id ?? null,
      specifier: safeModuleReference(request, cjsParentURL(parent)),
      ...cjsParentEvidence(parent),
      resolvedURL,
      isMain: Boolean(isMain),
    });
    return resolved;
  } catch (error) {
    emit({
      event: 'cjs.resolve-error',
      cjsLoadId: frame?.id ?? null,
      specifier: safeModuleReference(request, cjsParentURL(parent)),
      ...cjsParentEvidence(parent),
      ...errorEvidence(error),
    });
    throw error;
  }
};

Module._load = function tracedLoad(request, parent, isMain) {
  const frame = {
    id: `${process.pid}:${threadId}:${++cjsLoadSequence}`,
    request,
    parent,
    resolvedURL: null,
  };
  cjsFrames.push(frame);
  try {
    const value = Reflect.apply(originalLoad, this, arguments);
    emit({
      event: 'cjs.load',
      cjsLoadId: frame.id,
      specifier: safeModuleReference(request, cjsParentURL(parent)),
      ...cjsParentEvidence(parent),
      resolvedURL: frame.resolvedURL,
      isMain: Boolean(isMain),
      outcome: 'returned',
    });
    return value;
  } catch (error) {
    emit({
      event: 'cjs.load',
      cjsLoadId: frame.id,
      specifier: safeModuleReference(request, cjsParentURL(parent)),
      ...cjsParentEvidence(parent),
      resolvedURL: frame.resolvedURL,
      isMain: Boolean(isMain),
      outcome: 'threw',
      ...errorEvidence(error),
    });
    throw error;
  } finally {
    cjsFrames.pop();
  }
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (cjsFrames.length === 0) {
      emit({
        event: 'esm.resolve',
        specifier: safeModuleReference(specifier, context.parentURL ?? null),
        parentURL: context.parentURL ? normalizedURL(context.parentURL) : null,
        resolvedURL: normalizedURL(result.url),
        format: result.format ?? null,
        conditions: Array.isArray(context.conditions)
          ? context.conditions.slice(0, 64).map(clippedText)
          : [],
      });
    }
    return result;
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    emit({
      event: 'module.load',
      url: normalizedURL(url),
      format: result.format ?? context.format ?? null,
      sourceBytes: sourceBytes(result.source),
    });
    return result;
  },
});

emit({
  event: 'trace.start',
  node: process.version,
  ppid: process.ppid,
  entryURL: processEntryURL(),
  tracePath: normalizedURL(pathToFileURL(tracePath).href),
});

process.once('exit', () => {
  try {
    emit({ event: 'trace.exit' });
    fsyncSync(traceFd);
    closeSync(traceFd);
  } catch {
    // Records are unbuffered; an absent exit marker marks an incomplete trace.
  }
});
