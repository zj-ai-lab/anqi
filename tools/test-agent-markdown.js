import assert from 'node:assert/strict';
import { parseMarkdown, renderMarkdownInto, safeMarkdownHref } from '../public/js/markdown.js';

const sample = [
  '# 案情结论',
  '',
  '这是 **重点**、*解释*、~~旧说法~~、`due_on` 与 [法源](https://example.com/law)。',
  '',
  '- [x] 已核对',
  '- [ ] 待处理',
  '',
  '3. 第三项',
  '4. 第四项',
  '',
  '> 期限必须由 **案齐引擎** 计算。',
  '',
  '| 事项 | 日期 |',
  '|:---|---:|',
  '| 开庭 | 2026-09-01 |',
  '',
  '```js',
  "const unsafe = '<script>alert(1)</script>';",
  '```',
].join('\n');

const blocks = parseMarkdown(sample);
assert.deepEqual(blocks.map((block) => block.type), [
  'heading', 'paragraph', 'list', 'list', 'blockquote', 'table', 'code-block',
]);
assert.equal(blocks[0].level, 1);
assert.deepEqual(blocks[2].items.map((item) => item.checked), [true, false]);
assert.equal(blocks[3].ordered, true);
assert.equal(blocks[3].start, 3);
assert.deepEqual(blocks[5].align, ['left', 'right']);
assert.equal(blocks[6].language, 'js');
assert.match(blocks[6].text, /<script>alert\(1\)<\/script>/);

const paragraphTokens = blocks[1].children;
assert.ok(paragraphTokens.some((token) => token.type === 'strong'));
assert.ok(paragraphTokens.some((token) => token.type === 'em'));
assert.ok(paragraphTokens.some((token) => token.type === 'del'));
assert.ok(paragraphTokens.some((token) => token.type === 'code'));
assert.ok(paragraphTokens.some((token) => token.type === 'link' && token.href === 'https://example.com/law'));

// 流式阶段常会暂时只有开围栏；不能因为尚未收到 closing fence 就退回普通文本。
const streaming = parseMarkdown('```json\n{"ready": true');
assert.equal(streaming.length, 1);
assert.equal(streaming[0].type, 'code-block');
assert.equal(streaming[0].language, 'json');

assert.equal(safeMarkdownHref('https://example.com/a?q=1'), 'https://example.com/a?q=1');
assert.equal(safeMarkdownHref('mailto:test@example.com'), 'mailto:test@example.com');
for (const unsafe of ['javascript:alert(1)', 'data:text/html,boom', '/api/settings', ' https://exa\nmple.com']) {
  assert.equal(safeMarkdownHref(unsafe), null, `${unsafe} 不得成为可点击链接`);
}

// 用最小 fake DOM 跑真实 renderer：验证模型 HTML 永远只是文字、危险链接降级
// 成 span、图片语法不会创建 img（避免自动请求远端资源）。
class FakeClassList {
  constructor(owner) { this.owner = owner; }
  add(...names) {
    const values = new Set(this.owner.className.split(/\s+/).filter(Boolean));
    for (const name of names) values.add(name);
    this.owner.className = [...values].join(' ');
  }
}

class FakeNode {
  constructor(tag = '#text', text = '') {
    this.tagName = tag.toUpperCase();
    this.text = text;
    this.children = [];
    this.className = '';
    this.classList = new FakeClassList(this);
    this.style = {};
    this.attributes = {};
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.tagName === '#TEXT' ? this.text : this.text + this.children.map((child) => child.textContent).join(''); }
}

globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => new FakeNode('#text', String(text)),
};

const container = new FakeNode('div');
renderMarkdownInto(container, [
  '<script>alert(1)</script>',
  '',
  '[危险](javascript:alert(1)) [安全](https://example.com)',
  '',
  '![远端图](https://example.com/image.png)',
].join('\n'));

function flatten(node) {
  return [node, ...node.children.flatMap(flatten)];
}

const rendered = flatten(container);
assert.ok(container.className.includes('agent-markdown'));
assert.equal(rendered.some((node) => node.tagName === 'SCRIPT'), false, '原始 HTML 不能创建 script 节点');
assert.equal(rendered.some((node) => node.tagName === 'IMG'), false, 'Markdown 图片不能创建 img 节点');
assert.match(container.textContent, /<script>alert\(1\)<\/script>/, '原始 HTML 应按文字保留');
const anchors = rendered.filter((node) => node.tagName === 'A');
assert.deepEqual(anchors.map((node) => node.href), ['https://example.com', 'https://example.com/image.png']);
assert.ok(rendered.some((node) => node.tagName === 'SPAN' && node.textContent === '危险'));
assert.match(container.textContent, /图片：远端图/);

console.log('agent markdown ok');
