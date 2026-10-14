import assert from 'node:assert/strict';
import { createImRouter } from '../src/routes/im.js';
assert.equal(typeof createImRouter({ status: () => ({}), bindStart: () => ({ error: 'im_not_ready' }), unbind: () => ({ ok: true }), reconnect: () => false }), 'function');
console.log('IM HTTP router contract passed');
