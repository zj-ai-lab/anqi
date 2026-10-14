import assert from 'node:assert/strict';
import { createAgentBridge } from '../src/lib/im/agent-bridge.js';
const sent = []; const supervisor = { onEvent: () => () => {}, isLive: () => true, prompt: async () => ({ turnId: 1 }) };
const bridge = createAgentBridge({ supervisor, hub: { ownerUserid: () => 'zhangsan_test' }, transport: { replyStream: async (...args) => { sent.push(args); } }, loadConfig: () => ({ enabled: false }) });
assert.equal(await bridge.handle({ msgid: 'm1', text: '测试', frame: {} }), 'agent_disabled'); assert.equal(sent.length, 1); bridge.close(); console.log('IM agent bridge disabled gate passed');
