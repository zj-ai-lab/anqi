#!/usr/bin/env node
// Pin the isolated DSH dependency closure to one upstream prerelease and prove
// the anqi overlay against it. Tracked manifests are restored automatically if
// npm resolution or the real project/full boot gates fail.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(ROOT, 'src/agent/runtime');
const PACKAGE = path.join(RUNTIME, 'package.json');
const LOCK = path.join(RUNTIME, 'package-lock.json');
const requested = process.argv[2];

if (!requested || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requested)) {
  process.stderr.write('usage: node tools/update-dsh-runtime.mjs <exact-version>\n');
  process.exit(2);
}

const originalPackage = fs.readFileSync(PACKAGE, 'utf8');
const originalLock = fs.readFileSync(LOCK, 'utf8');
const manifest = JSON.parse(originalPackage);
let changed = 0;

for (const sectionName of ['dependencies', 'overrides']) {
  const section = manifest[sectionName] || {};
  for (const packageName of Object.keys(section)) {
    if (!packageName.startsWith('@deepseek-ai/dsh-')) continue;
    if (section[packageName] !== requested) changed += 1;
    section[packageName] = requested;
  }
}

if (changed === 0) {
  process.stdout.write(`DSH runtime is already pinned to ${requested}\n`);
  runCompatibilityGates();
  process.exit(0);
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

try {
  fs.writeFileSync(PACKAGE, `${JSON.stringify(manifest, null, 2)}\n`);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], RUNTIME);
  runCompatibilityGates();
  process.stdout.write(`DSH runtime updated to ${requested}; ${changed} direct/override pins changed and real boot gates passed\n`);
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
