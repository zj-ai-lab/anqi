import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const modalSource = await readFile(new URL('public/js/modal.js', root), 'utf8');

assert.match(modalSource, /export function openModal/);
assert.match(modalSource, /Escape/);
assert.match(modalSource, /inert/);
assert.match(modalSource, /focus/);

for (const file of ['public/js/dateedit.js', 'public/js/calendar-task-modal.js']) {
  const source = await readFile(new URL(file, root), 'utf8');
  assert.match(source, /from ['"]\.\/modal\.js['"]/ , `${file} must use shared modal`);
}

for (const file of ['public/index.html', 'public/cases.html', 'public/calendar.html']) {
  const source = await readFile(new URL(file, root), 'utf8');
  assert.match(source, /class="(?:btn|factstrip-edit)/, `${file} must keep shared control hooks`);
}

console.log('modal contract: ok');
