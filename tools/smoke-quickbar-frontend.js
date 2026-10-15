#!/usr/bin/env node
// 快录条传票入口的静态冒烟：不依赖浏览器或模型，只守住 DOM/API 契约。
import assert from 'node:assert/strict';
import fs from 'node:fs';

const nav = fs.readFileSync('public/js/nav.js', 'utf8');
const css = fs.readFileSync('public/css/style.css', 'utf8');

assert.match(nav, /type: 'file'/);
assert.match(nav, /application\/pdf/);
assert.match(nav, /image\/jpeg/);
assert.match(nav, /\/api\/quick\/extract\?name=/);
assert.match(nav, /识别中…/);
assert.match(nav, /staged_token/);
assert.match(nav, /quick-attachment-clear/);
assert.match(nav, /pdf-text.*文字层/);
assert.match(nav, /system-ocr.*系统 OCR/);
assert.match(nav, /vision-llm.*AI 看图/);
assert.match(nav, /manual: '需要手填'/);
assert.match(css, /\.quickbar \.quick-attachment\s*\{/);
assert.match(css, /\.quickbar \.quick-attachment-name\s*\{[^}]*text-overflow: ellipsis/s);
assert.match(css, /@media \(max-width: 767px\)\s*\{[^}]*\.quickbar/s);
assert.match(css, /\.quickbar input\[type=text\] \{ min-width: 0/s);

// 控件高度只走层 A 尺寸令牌（--control-h / --control-touch-h），快录条段内不再写死像素高度。
const quickbarCss = css.slice(css.indexOf('/* ── A-22 快录条'), css.indexOf('/* ── A-23 toast'));
assert.ok(quickbarCss.length > 0, 'quickbar CSS section markers must exist');
assert.doesNotMatch(quickbarCss, /min-height:\s*\d+px/, 'quickbar heights must use control-size tokens');
assert.doesNotMatch(quickbarCss, /\.quickbar \.btn\s*\{[^}]*min-height/, '.quickbar .btn must not override the .btn token height');
assert.match(quickbarCss, /\.quickbar select, \.quickbar input \{[^}]*min-height: var\(--control-touch-h\)/, 'narrow quickbar fields must reach the 44px touch height');

console.log('quickbar frontend upload contract ok');
