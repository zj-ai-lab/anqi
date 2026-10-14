import assert from 'node:assert/strict';
import { resolveWecomConfig } from '../src/lib/startup-config.js';
assert.throws(() => resolveWecomConfig({ ANJIAN_WECOM_BOT_ID: 'bot_test_0001' }));
assert.throws(() => resolveWecomConfig({ ANJIAN_WECOM_WS_URL: 'ws://example.com' }));
assert.equal(resolveWecomConfig({ ANJIAN_WECOM_BOT_ID: 'bot_test_0001', ANJIAN_WECOM_BOT_SECRET: 'secret-test-not-real', ANJIAN_WECOM_WS_URL: 'ws://127.0.0.1:1234' }).botId, 'bot_test_0001');
console.log('IM settings/startup validation passed');
