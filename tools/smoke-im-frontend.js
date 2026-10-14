import assert from 'node:assert/strict';
import fs from 'node:fs';
const html = fs.readFileSync('public/profile.html', 'utf8'); const js = fs.readFileSync('public/js/profile.js', 'utf8'); const notify = fs.readFileSync('public/js/notify.js', 'utf8'); const drawer = fs.readFileSync('public/js/agent-drawer.js', 'utf8');
assert.match(html, /企业微信/); assert.match(html, /企业微信服务器传输/); for (const endpoint of ['/api/im/wecom/status', '/api/im/wecom/bind/start', '/api/im/wecom/unbind', '/api/im/wecom/reconnect', '/api/im/wecom/test']) assert.ok(js.includes(endpoint)); assert.match(js, /3000/); assert.match(notify, /channel=inapp/); assert.match(notify, /sent/); assert.match(drawer, /企业微信/); console.log('IM frontend static contract passed');
