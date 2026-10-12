import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shouldPreventClose } = require('../electron/window-policy.js');
assert.equal(shouldPreventClose('darwin', false), true);
assert.equal(shouldPreventClose('darwin', true), false);
assert.equal(shouldPreventClose('linux', false), false);
console.log('window policy: macOS hide/quit and non-macOS close behavior passed');
