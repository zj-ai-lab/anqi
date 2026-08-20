import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { basename } from 'node:path';

const require = createRequire(import.meta.url);
const fixture = require('./fixture.cjs');
assert.equal(fixture.basename, basename(import.meta.filename));

const child = spawnSync(
  process.execPath,
  ['-e', "require('./trace-loaded/fixture.cjs')"],
  { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
);
assert.equal(child.status, 0, child.stderr);
process.stdout.write('trace fixture ok\n');
