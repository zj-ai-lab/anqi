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
  ...ids(path.join(ROOT, 'src/agent/assets/preset/anqi/agent.cordis.yml')),
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

console.log(`DSH base parity tests: ${baseIds.length} upstream rows reviewed; runtime closure pinned to ${[...versions][0]}`);
