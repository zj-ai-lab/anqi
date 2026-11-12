import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ids = (filename) => [
  ...fs.readFileSync(filename, 'utf8').matchAll(/^\s*- id:\s*(\S+)/gm),
].map((match) => match[1]);

const baseIds = ids(path.join(
  ROOT,
  'src/agent/runtime/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml',
));
const anqiIds = new Set([
  ...ids(path.join(ROOT, 'src/agent/assets/anqi.cordis.yml')),
]);

// These are intentionally host/CLI UI concerns rather than missing agent
// capabilities. Any new upstream row is not silently accepted: the updater and
// CI fail until it is either mounted or consciously classified here.
const intentionalHostExclusions = new Set([
  'typert',
  'typert-loader',
  'typert-gateway',
  'session-title',
  'session-title-llm',
  'agent-default-model',
  'settings',
  'session-query-sqlite',
  'session-telemetry-otel',
  'permission',
  'skill-badge',
  // Extra top-level fields on official DeepSeek requests: the session log and
  // the loaded plugin inventory. Case transcripts and the host composition stay
  // local, like session-telemetry-otel; the adapter treats the registry as optional.
  'deepseek-llm-api-extensions',
  'session-log-deepseek',
  'plugin-package-inventory-deepseek',
  // Durable KV stack under $DSH_HOME/storages backing the host session-listing
  // projection cache. Workers persist only per-case JSONL under DSH_SESSION_ROOT;
  // listing consumers fall back to live projections when the cache is absent.
  'storage',
  'storage-json',
  'storage-domain',
  'session-projection-cache',
  // web_fetch stays off (anqi.cordis.yml tool-web fetch: false): the model would
  // choose the request target, so no fetch provider is mounted.
  'web-fetch-http',
  // 0.2.x host/UI or account rows that stay out of the anqi sidecar: runtime
  // plugin management is a dsh CLI concern (settings-page plugin patches mount
  // through DSH_PLUGIN_PATCH instead), remote access and the config editor are
  // interactive-host surfaces, and authorization/deepseek-account/
  // llm-deepseek-account are the DeepSeek sign-in stack — anqi authenticates
  // provider API keys, never DSH accounts.
  'tool-plugin-manager',
  'plugin-manager',
  'remote-access',
  'config-editor',
  'authorization',
  'deepseek-account',
  'llm-deepseek-account',
  // OTel exporter base; session telemetry stays local (see session-telemetry-otel).
  'otel',
  // working-directory the *service* is mounted (agent-instructions and the
  // session cwd context depend on it); only the model-facing cd tool stays off —
  // the sandbox root is pinned per case and must not be movable mid-session.
  'tool-working-directory',
  // New 0.2.x multi-agent team orchestration; not evaluated for the anqi full
  // tier yet. Revisit with the next upstream bump.
  'agent-team',
  'tool-agent-team',
]);

const unreviewed = baseIds.filter((id) => !anqiIds.has(id) && !intentionalHostExclusions.has(id));
assert.deepEqual(
  unreviewed,
  [],
  `upstream dsh-base added unreviewed rows: ${unreviewed.join(', ')}`,
);

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/agent/runtime/package.json'), 'utf8'));
const dshPins = [];
for (const sectionName of ['dependencies', 'overrides']) {
  for (const [name, version] of Object.entries(manifest[sectionName] || {})) {
    if (name.startsWith('@deepseek-ai/dsh-')) dshPins.push([`${sectionName}.${name}`, version]);
  }
}
const versions = new Set(dshPins.map(([, version]) => version));
assert.equal(versions.size, 1, `DSH dependency closure must use one exact version; saw ${[...versions].join(', ')}`);
const [pinnedVersion] = versions;

// The manifest is only intent; the lockfile is what ships. Every DSH package
// npm resolved (nested copies included) must sit at the pinned version and be
// pinned by overrides, or the next re-resolution could drift it. The updater
// rewrites overrides to exactly this closure.
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/agent/runtime/package-lock.json'), 'utf8'));
const locked = Object.entries(lock.packages)
  .filter(([key]) => /(^|\/)node_modules\/@deepseek-ai\/dsh-[^/]+$/.test(key));
const drifted = locked
  .filter(([, entry]) => entry.version !== pinnedVersion)
  .map(([key, entry]) => `${key}@${entry.version}`);
assert.deepEqual(drifted, [], `locked DSH closure drifted from ${pinnedVersion}: ${drifted.join(', ')}`);
const overrides = manifest.overrides || {};
const unpinned = locked
  .map(([key]) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length))
  .filter((name) => !(name in overrides));
assert.deepEqual(unpinned, [], `locked DSH packages missing from overrides: ${unpinned.join(', ')}; rerun npm run agent:update-runtime -- ${pinnedVersion}`);

console.log(`DSH base parity tests: ${baseIds.length} upstream rows reviewed; runtime closure of ${locked.length} locked packages pinned to ${pinnedVersion}`);
