#!/usr/bin/env node
// Pin the isolated DSH dependency closure to one upstream prerelease and prove
// the anqi overlay against it. Tracked manifests are restored automatically if
// npm resolution or the real project/full boot gates fail.
//
// Upstream renames, merges and drops packages between prereleases, so the pin
// set is derived instead of carried forward: direct DSH dependencies (what anqi
// imports or mounts) must be published at the target or the update stops before
// touching anything, while `overrides` is rewritten to exactly the resolved DSH
// closure — dropped packages leave, newly introduced ones are pinned too. The
// direct schemastery pin follows the exact version dsh-tools (the plugin API
// anqi's own plugins build on) depends on, so both sides share one Schema runtime.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(ROOT, 'src/agent/runtime');
const PACKAGE = path.join(RUNTIME, 'package.json');
const LOCK = path.join(RUNTIME, 'package-lock.json');
const DSH_PREFIX = '@deepseek-ai/dsh-';
const SCHEMASTERY = '@deepseek-ai/schemastery';
const requested = process.argv[2];

if (!requested || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requested)) {
  process.stderr.write('usage: node tools/update-dsh-runtime.mjs <exact-version>\n');
  process.exit(2);
}

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

function runCompatibilityGates() {
  run(process.execPath, ['tools/test-dsh-base-parity.js']);
  run(process.execPath, ['tools/test-agent-workspace-guard.js']);
  run(process.execPath, ['tools/test-agent-runtime-composition.js']);
}

function registryBase() {
  const result = spawnSync('npm', ['config', 'get', 'registry'], { cwd: RUNTIME, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('npm config get registry failed');
  const base = result.stdout.trim();
  return base.endsWith('/') ? base : `${base}/`;
}

async function publishedManifest(base, name, version) {
  const response = await fetch(`${base}${name.replace('/', '%2f')}/${version}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`registry answered ${response.status} for ${name}@${version}`);
  return response.json();
}

// npm will not lift a locked transitive peer (the cordis plugin family) to the
// exact version a new DSH prerelease demands — it fails with ERESOLVE instead.
// Forget every locked @deepseek-ai/* entry so that scope re-resolves against
// the target, while third-party packages keep their locked versions.
function forgetLockedScope() {
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  for (const key of Object.keys(lock.packages)) {
    if (/(^|\/)node_modules\/@deepseek-ai\//.test(key)) delete lock.packages[key];
  }
  fs.writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
}

function lockedDshClosure() {
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  return Object.keys(lock.packages)
    .filter((key) => /^node_modules\/@deepseek-ai\/dsh-[^/]+$/.test(key))
    .map((key) => key.slice('node_modules/'.length))
    .sort();
}

const writeManifest = (value) => fs.writeFileSync(PACKAGE, `${JSON.stringify(value, null, 2)}\n`);

const originalPackage = fs.readFileSync(PACKAGE, 'utf8');
const originalLock = fs.readFileSync(LOCK, 'utf8');
const manifest = JSON.parse(originalPackage);
const directDsh = Object.keys(manifest.dependencies).filter((name) => name.startsWith(DSH_PREFIX));
const pinned = [...new Set([
  ...directDsh,
  ...Object.keys(manifest.overrides || {}).filter((name) => name.startsWith(DSH_PREFIX)),
])];

const base = registryBase();
const published = new Map(await Promise.all(
  pinned.map(async (name) => [name, await publishedManifest(base, name, requested)]),
));
const missingDirect = directDsh.filter((name) => !published.get(name));
if (missingDirect.length > 0) {
  process.stderr.write(
    `DSH ${requested} does not publish these direct dependencies: ${missingDirect.join(', ')}\n`
    + 'Find where upstream moved them, then rename or drop them in src/agent/runtime/package.json'
    + ' and every assets/supervisor reference before retrying. Nothing was changed.\n',
  );
  process.exit(1);
}
const schemastery = published.get('@deepseek-ai/dsh-tools')?.dependencies?.[SCHEMASTERY];
if (!/^\d+\.\d+\.\d+$/.test(schemastery ?? '')) {
  process.stderr.write(`dsh-tools@${requested} does not pin an exact ${SCHEMASTERY} (saw ${schemastery}); nothing was changed\n`);
  process.exit(1);
}

for (const name of directDsh) manifest.dependencies[name] = requested;
manifest.dependencies[SCHEMASTERY] = schemastery;
const unpublishedOverrides = pinned.filter((name) => !published.get(name));
manifest.overrides = Object.fromEntries(
  pinned.filter((name) => published.get(name)).sort().map((name) => [name, requested]),
);

if (`${JSON.stringify(manifest, null, 2)}\n` === originalPackage) {
  process.stdout.write(`DSH runtime is already pinned to ${requested}\n`);
  runCompatibilityGates();
  process.exit(0);
}

try {
  writeManifest(manifest);
  forgetLockedScope();
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], RUNTIME);
  const closure = lockedDshClosure();
  const previousOverrides = Object.keys(manifest.overrides);
  const added = closure.filter((name) => !previousOverrides.includes(name));
  const removed = previousOverrides.filter((name) => !closure.includes(name));
  if (added.length > 0 || removed.length > 0) {
    manifest.overrides = Object.fromEntries(closure.map((name) => [name, requested]));
    writeManifest(manifest);
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], RUNTIME);
  }
  runCompatibilityGates();
  process.stdout.write(
    `DSH runtime updated to ${requested} (${SCHEMASTERY} ${schemastery}); real boot gates passed\n`
    + `  closure: ${closure.length} DSH packages pinned via overrides\n`
    + `  dropped (unpublished at target): ${unpublishedOverrides.join(', ') || 'none'}\n`
    + `  dropped (no longer in closure): ${removed.join(', ') || 'none'}\n`
    + `  newly pinned: ${added.join(', ') || 'none'}\n`,
  );
} catch (error) {
  process.stderr.write(`DSH ${requested} failed compatibility gates; restoring previous manifests and install\n`);
  fs.writeFileSync(PACKAGE, originalPackage);
  fs.writeFileSync(LOCK, originalLock);
  try {
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], RUNTIME);
  } catch (restoreError) {
    process.stderr.write(`warning: dependency restore failed: ${restoreError.message}\n`);
  }
  throw error;
}
