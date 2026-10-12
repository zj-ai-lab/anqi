import assert from 'node:assert/strict';
import fs from 'node:fs';
const nav = fs.readFileSync('public/js/nav.js', 'utf8');
const notify = fs.readFileSync('public/js/notify.js', 'utf8');
const profile = fs.readFileSync('public/js/profile.js', 'utf8');
const settings = fs.readFileSync('src/routes/settings.js', 'utf8');
const caseJs = fs.readFileSync('public/js/case.js', 'utf8');
assert.match(nav, /notify\.js/); assert.match(notify, /EventSource\('\/api\/notifications\/stream'\)/); assert.match(notify, /new Notification\(/); assert.match(notify, /\/ack/);
for (const key of ['remind_enabled','remind_hearing_eve_time','remind_hearing_day_time','remind_deadline_days_before','remind_deadline_time','remind_task_minutes_before']) { assert.match(profile, new RegExp(key)); assert.match(settings, new RegExp(key)); }
assert.match(caseJs, /\/reminders/);
console.log('notification frontend static contract passed');
