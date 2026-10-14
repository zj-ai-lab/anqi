import assert from 'node:assert/strict';
import { createWecomMockServer } from './lib/wecom-mock-server.js';
const mock = await createWecomMockServer(); assert.match(mock.url, /^ws:\/\/127\.0\.0\.1:/); await mock.close(); console.log('IM end-to-end mock endpoint is loopback-only');
