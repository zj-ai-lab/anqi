import assert from 'node:assert/strict';
import fs from 'node:fs';
const html = fs.readFileSync('public/profile.html', 'utf8');
const js = fs.readFileSync('public/js/profile.js', 'utf8');
const notify = fs.readFileSync('public/js/notify.js', 'utf8');
const drawer = fs.readFileSync('public/js/agent-drawer.js', 'utf8');
const style = fs.readFileSync('public/css/style.css', 'utf8');
assert.match(html, /aria-label="企业微信"/);
assert.match(html, /企业微信服务器传输/);
assert.match(html, /同一个机器人只能接在一处/);
assert.match(html, /im-wecom-enabled/);
assert.match(html, /im-wecom-bot-id/);
assert.match(html, /im-wecom-secret/);
for (const endpoint of ['/api/im/wecom/status', '/api/im/wecom/bind/start', '/api/im/wecom/unbind', '/api/im/wecom/reconnect', '/api/im/wecom/test']) assert.ok(js.includes(endpoint), endpoint);
for (const mode of ["'off'", "'preview'", "'live'"]) assert.ok(js.includes(mode), mode);
assert.match(js, /3000/);
assert.ok(js.includes('im_wecom_secret'));
assert.ok(!js.includes('im_wecom_secret_encrypted'));
assert.match(js, /已绑定|绑定成功|开始绑定|发一条测试消息/);
assert.match(notify, /channel=inapp/);
for (const label of ['sent', 'preview']) assert.ok(notify.includes(label));
assert.match(drawer, /String\(frame\.data\?\.origin \|\| ''\)\.startsWith\('im:'\)/);
assert.match(drawer, /企业微信/);
assert.match(style, /@media \(max-width: 767px\)/);
// Mac 验收真浏览器抓到的回归（2026-10-14）：
// ① 状态轮询把刚生成的挑战码改回「尚未绑定」，律师看不到码；绑定成功后倒计时仍覆盖「已绑定」。
assert.match(js, /else if \(imChallenge\) paintImChallenge\(\)/);
assert.match(js, /if \(bound\) \{ stopImChallenge\(\);/);
// ② 刷新后 BotID 输入框为空，只改提醒档位再保存会带空 BotID 被后端拒绝。
assert.match(js, /imBot\.value = s\.credentials\?\.bot_id \|\| ''/);
assert.match(js, /if \(!imBot\.disabled && imBot\.value\.trim\(\)\) body\.im_wecom_bot_id/);
// ③ 测试 fixture 漏进正式界面占位符；④ 未连接时可点「开始绑定」；⑤ 绑定时间显示原始 UTC 串。
assert.ok(!html.includes('bot_test_'), 'profile.html 不得含测试 BotID');
assert.match(js, /imBindStart\.disabled = state !== 'ready'/);
assert.match(js, /timeZone: 'Asia\/Shanghai'/);
console.log('IM frontend panel/endpoints/secret/modes/polling/notification/drawer/mobile contract passed');
