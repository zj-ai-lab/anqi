import assert from 'node:assert/strict';
import { createWecomChannel } from '../src/lib/reminder-channels/wecom.js';
let calls = 0; const channel = createWecomChannel({ hub: { reminderMode: () => 'preview', hasCredentials: () => true, isBound: () => true, sendToOwner: async () => { calls += 1; } } });
assert.equal(channel.configured(), true); assert.equal((await channel.deliver({ title: '测试提醒', fire_at: '2099-01-01T00:00:00Z' })).status, 'preview'); assert.equal(calls, 0); console.log('wecom reminder preview channel passed');
