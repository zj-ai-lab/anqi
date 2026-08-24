#!/usr/bin/env node
// anqi-owned DSH launcher. It keeps the stock JSON-RPC lifecycle but adds one
// optional, explicitly configured Cordis patch layer and watches that file via
// upstream HMR. This is the compatibility seam for trusted third-party DSH
// plugins without modifying the signed/bundled anqi overlay.
import { existsSync } from 'node:fs';
import {
  boot,
  installFailLoud,
  loadEnv,
  loadOptionalPatches,
  resolveConfigPath,
  watchUserPatches,
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
let disposePatchWatcher;
if (pluginPatch) {
  disposePatchWatcher = await watchUserPatches(ctx, {
    binName: NAME,
    filename: pluginPatch,
  });
}

let exiting = false;
async function disposeAndExit(code) {
  if (exiting) return;
  exiting = true;
  try {
    await disposePatchWatcher?.();
    await ctx.fiber.dispose();
  } finally {
    process.exit(code);
  }
}

process.stdin.on('end', () => { void disposeAndExit(0); });
process.on('SIGTERM', () => { void disposeAndExit(0); });
process.on('SIGINT', () => { void disposeAndExit(130); });
