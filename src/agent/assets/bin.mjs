#!/usr/bin/env node
// anqi-owned DSH launcher. It keeps the stock JSON-RPC lifecycle but adds one
// optional, explicitly configured Cordis patch layer applied at boot. This is
// the compatibility seam for trusted third-party DSH plugins without modifying
// the signed/bundled anqi overlay.
//
// DSH 0.2.x removed app-boot's watchUserPatches (profile-only HMR now); the
// plugin patch is no longer hot-reloaded in place. Changing DSH_PLUGIN_PATCH
// requires restarting the worker — the supervisor already owns worker
// lifecycles, so patch edits flow through a stop + next-spawn.
import { existsSync } from 'node:fs';
import {
  boot,
  installFailLoud,
  loadEnv,
  loadOptionalPatches,
  resolveConfigPath,
} from '@deepseek-ai/dsh-app-boot';

const NAME = 'anqi-dsh-jsonrpc-agent';

installFailLoud(NAME);
loadEnv(NAME);

const requestedConfig = process.env.DSH_CORDIS_CONFIG || process.argv[2];
const configPath = requestedConfig ? resolveConfigPath(requestedConfig, undefined) : undefined;
if (!configPath || !existsSync(configPath)) {
  process.stderr.write(`usage: ${NAME} <path/to/cordis.yml> (or set DSH_CORDIS_CONFIG)\n`);
  process.exit(1);
}

const pluginPatch = process.env.DSH_PLUGIN_PATCH || '';
const initialPatches = pluginPatch ? loadOptionalPatches(NAME, pluginPatch) : undefined;
const ctx = await boot(NAME, configPath, initialPatches);

let exiting = false;
async function disposeAndExit(code) {
  if (exiting) return;
  exiting = true;
  try {
    await ctx.fiber.dispose();
  } finally {
    process.exit(code);
  }
}

process.stdin.on('end', () => { void disposeAndExit(0); });
process.on('SIGTERM', () => { void disposeAndExit(0); });
process.on('SIGINT', () => { void disposeAndExit(130); });
