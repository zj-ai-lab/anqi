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

// 日历任务弹层的鼠标入口：pointerdown 抓指针会把 click 派给 grid，chip / 长条 / 托盘的 onclick 收不到。
// 只允许越过拖拽阈值后再抓（实测见 PR：main 上桌面鼠标单击三处入口都打不开弹层）。
{
  const calendar = await readFile(new URL('public/js/calendar.js', root), 'utf8');
  const fnBody = (name) => {
    const start = calendar.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `calendar.js must define ${name}()`);
    return calendar.slice(start, calendar.indexOf('\n}\n', start));
  };
  assert.doesNotMatch(fnBody('beginDrag'), /setPointerCapture/, 'calendar beginDrag must not capture the pointer on pointerdown');
  assert.match(fnBody('onPointerMove'), /DRAG_THRESHOLD[\s\S]*drag\.moved = true[\s\S]*setPointerCapture/,
    'calendar must capture the pointer only after crossing DRAG_THRESHOLD');
}

// ── 行为契约：最小假 DOM 驱动 openModal（仓库无 jsdom，只模拟 openModal 实际用到的接口）──
const rafQueue = [];
class FakeEl {
  constructor(tag, cls = '') {
    this.tagName = tag.toUpperCase();
    this.className = cls;
    this.attrs = {};
    this.children = [];
    this.parentNode = null;
    this.inert = false;
    this.disabled = false;
    this.listeners = {};
  }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === fakeDoc.body; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  append(...nodes) { for (const n of nodes) { n.remove(); n.parentNode = this; this.children.push(n); } }
  remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  * descendants() { for (const c of this.children) { yield c; yield* c.descendants(); } }
  querySelectorAll(sel) {
    if (sel.startsWith('.')) return [...this.descendants()].filter((n) => n.className.split(/\s+/).includes(sel.slice(1)));
    return [...this.descendants()].filter((n) => ['BUTTON', 'INPUT', 'A'].includes(n.tagName) && !n.disabled);
  }
  getClientRects() { return [{}]; }
  focus() { if (this.isConnected) fakeDoc.activeElement = this; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  click(target = this) { for (const f of this.listeners.click || []) f({ target }); }
}
const fakeDoc = {
  body: new FakeEl('body'),
  activeElement: null,
  listeners: {},
  createElement: (tag) => new FakeEl(tag),
  querySelectorAll: (sel) => fakeDoc.body.querySelectorAll(sel),
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); },
};
const press = (key, shiftKey = false) => {
  let prevented = false;
  for (const f of [...(fakeDoc.listeners.keydown || [])]) f({ key, shiftKey, preventDefault: () => { prevented = true; } });
  return prevented;
};
const flushFrames = () => { while (rafQueue.length) rafQueue.shift()(); };
Object.assign(globalThis, { document: fakeDoc, HTMLElement: FakeEl, requestAnimationFrame: (fn) => rafQueue.push(fn) });

const { openModal } = await import(new URL('public/js/modal.js', root));
const page = new FakeEl('main');
const alreadyInert = new FakeEl('aside');
alreadyInert.inert = true;
const opener = new FakeEl('button');
page.append(opener);
fakeDoc.body.append(page, alreadyInert);
opener.focus();

const makeDialog = () => {
  const dialog = new FakeEl('div', 'dmodal');
  const first = new FakeEl('input');
  const second = new FakeEl('button');
  const last = new FakeEl('button');
  dialog.append(first, second, last);
  return { dialog, first, second, last };
};

// initialFocus 必须生效（不得被「第一个可聚焦」覆盖）
const a = makeDialog();
const closedWith = [];
const ma = openModal(a.dialog, { label: 'A', initialFocus: () => a.second, onClose: (v) => closedWith.push(v) });
flushFrames();
assert.equal(fakeDoc.activeElement, a.second, 'initialFocus 指定的控件必须拿到首焦点');
assert.equal(a.dialog.getAttribute('role'), 'dialog');
assert.equal(a.dialog.getAttribute('aria-modal'), 'true');
assert.equal(page.inert, true, '打开后背景必须 inert');
assert.equal(ma.overlay.inert, false, '遮罩自身不得 inert');

// Tab 循环
a.last.focus();
assert.equal(press('Tab'), true, 'Tab 必须被弹层接管');
assert.equal(fakeDoc.activeElement, a.first, 'Tab 从最后一个绕回第一个');
assert.equal(press('Tab', true), true, 'Shift+Tab 必须被弹层接管');
assert.equal(fakeDoc.activeElement, a.last, 'Shift+Tab 从第一个绕回最后一个');
fakeDoc.activeElement = fakeDoc.body;   // 点过弹层空白处
assert.equal(press('Tab'), true, 'Tab 必须被弹层接管');
assert.equal(fakeDoc.activeElement, a.first, '焦点不在弹层控件上时 Tab 落到第一个');
fakeDoc.activeElement = fakeDoc.body;
assert.equal(press('Tab', true), true, 'Shift+Tab 必须被弹层接管');
assert.equal(fakeDoc.activeElement, a.last, '焦点不在弹层控件上时 Shift+Tab 落到最后一个');

// 遮罩：点弹层内部不关，点遮罩本身才关（这里先验内部）
ma.overlay.click(a.dialog);
assert.equal(ma.overlay.isConnected, true, '点弹层内部不得关闭');

// 叠层：Esc 只关最上层
const b = makeDialog();
const mb = openModal(b.dialog, { label: 'B' });
flushFrames();
assert.equal(fakeDoc.activeElement, b.first, '无 initialFocus 时落到第一个可聚焦控件');
assert.equal(ma.overlay.inert, true, '上层打开时下层遮罩必须 inert');
press('Escape');
assert.equal(mb.overlay.isConnected, false, 'Esc 关闭最上层');
assert.equal(ma.overlay.isConnected, true, 'Esc 不得连带关闭下层弹层');
assert.equal(ma.overlay.inert, false, '上层关闭后下层恢复可交互');
assert.equal(page.inert, true, '下层仍开着时背景保持 inert');

// 遮罩点击关闭 + 焦点 / inert 复原 + onClose 只调一次
ma.overlay.click(ma.overlay);
assert.equal(ma.overlay.isConnected, false, '点遮罩关闭');
assert.equal(fakeDoc.activeElement, opener, '关闭后焦点回到打开前元素');
assert.equal(page.inert, false, '关闭后背景 inert 复原');
assert.equal(alreadyInert.inert, true, '打开前本就 inert 的节点保持 inert');
ma.close('again');
assert.deepEqual(closedWith, [null], 'onClose 只调用一次');
assert.equal((fakeDoc.listeners.keydown || []).length, 0, '关闭后不得残留 keydown 监听');

// 打开后立即关闭：延迟的首焦点不得再抢焦点
const c = makeDialog();
openModal(c.dialog, { initialFocus: c.second }).close();
flushFrames();
assert.equal(fakeDoc.activeElement, opener, '已关闭的弹层不得在下一帧抢回焦点');

console.log('modal contract: ok');
