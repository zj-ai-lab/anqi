import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

if (process.platform !== 'darwin' || !spawnSync('which', ['swiftc'], { encoding: 'utf8' }).stdout.trim()) {
  console.log('skip anqi-ocr helper: macOS/swiftc unavailable');
  process.exit(0);
}
fs.mkdirSync('build/bin', { recursive: true });
const outputs = [];
for (const arch of ['arm64', 'x86_64']) {
  const output = path.join('build/bin', `anqi-ocr-${arch}`);
  const result = spawnSync('swiftc', ['-O', '-target', `${arch}-apple-macos13`, 'tools/ocr-macos/anqi-ocr.swift', '-o', output], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
  outputs.push(output);
}
const lipo = spawnSync('lipo', ['-create', ...outputs, '-output', 'build/bin/anqi-ocr'], { stdio: 'inherit' });
if (lipo.status !== 0) process.exit(lipo.status || 1);
for (const output of outputs) fs.rmSync(output, { force: true });
