// 案件助理回复的安全 Markdown 子集。
//
// 这里刻意不用 innerHTML，也不把模型输出交给浏览器当 HTML 解析：parseMarkdown()
// 先得到一个很小的 AST，renderMarkdownInto() 再用 createElement/textContent 组装
// DOM。这样原始 HTML、事件属性和 script 天然只能作为文字出现；链接还会再过一遍
// 协议白名单。图片语法只渲染成来源链接，不主动请求远端资源，避免模型回复触发
// 隐私外带。

const LIST_RE = /^ {0,3}([-+*]|\d+[.)])\s+(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.+?)\s*$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/;
const HR_RE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;

function pushText(tokens, value) {
  if (!value) return;
  const last = tokens[tokens.length - 1];
  if (last?.type === 'text') last.text += value;
  else tokens.push({ type: 'text', text: value });
}

function findUnescaped(source, needle, from) {
  let at = from;
  while ((at = source.indexOf(needle, at)) >= 0) {
    let slashes = 0;
    for (let i = at - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
    if (slashes % 2 === 0) return at;
    at += needle.length;
  }
  return -1;
}

function readLink(source, offset, image) {
  const labelStart = offset + (image ? 2 : 1);
  const labelEnd = findUnescaped(source, ']', labelStart);
  if (labelEnd < 0 || source[labelEnd + 1] !== '(') return null;
  const targetEnd = findUnescaped(source, ')', labelEnd + 2);
  if (targetEnd < 0) return null;

  let target = source.slice(labelEnd + 2, targetEnd).trim();
  const titled = target.match(/^(<[^>]+>|\S+?)(?:\s+(?:"[^"]*"|'[^']*'))?$/);
  if (titled) target = titled[1];
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);

  return {
    end: targetEnd + 1,
    label: source.slice(labelStart, labelEnd).replace(/\\([\\`*_[\]{}()#+\-.!>])/g, '$1'),
    href: target.replace(/\\([()])/g, '$1'),
  };
}

export function parseInlineMarkdown(value, depth = 0) {
  const source = String(value ?? '');
  if (depth > 12) return [{ type: 'text', text: source }];
  const tokens = [];

  for (let i = 0; i < source.length;) {
    if (source[i] === '\\' && i + 1 < source.length && /[\\`*_[\]{}()#+\-.!>~]/.test(source[i + 1])) {
      pushText(tokens, source[i + 1]);
      i += 2;
      continue;
    }

    if (source[i] === '`') {
      const ticks = source.slice(i).match(/^`+/)?.[0] || '`';
      const end = findUnescaped(source, ticks, i + ticks.length);
      if (end >= 0) {
        let text = source.slice(i + ticks.length, end).replace(/\n/g, ' ');
        if (/^\s.*\s$/.test(text) && /\S/.test(text)) text = text.slice(1, -1);
        tokens.push({ type: 'code', text });
        i = end + ticks.length;
        continue;
      }
    }

    const image = source.startsWith('![', i) ? readLink(source, i, true) : null;
    if (image) {
      tokens.push({ type: 'image-link', href: image.href, children: parseInlineMarkdown(image.label, depth + 1) });
      i = image.end;
      continue;
    }

    const link = source[i] === '[' ? readLink(source, i, false) : null;
    if (link) {
      tokens.push({ type: 'link', href: link.href, children: parseInlineMarkdown(link.label, depth + 1) });
      i = link.end;
      continue;
    }

    const strong = source.startsWith('**', i) ? '**' : (source.startsWith('__', i) ? '__' : null);
    if (strong) {
      const end = findUnescaped(source, strong, i + 2);
      if (end > i + 2) {
        tokens.push({ type: 'strong', children: parseInlineMarkdown(source.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }

    if (source.startsWith('~~', i)) {
      const end = findUnescaped(source, '~~', i + 2);
      if (end > i + 2) {
        tokens.push({ type: 'del', children: parseInlineMarkdown(source.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }

    if (source[i] === '*') {
      const end = findUnescaped(source, '*', i + 1);
      if (end > i + 1) {
        tokens.push({ type: 'em', children: parseInlineMarkdown(source.slice(i + 1, end), depth + 1) });
        i = end + 1;
        continue;
      }
    }

    if (source[i] === '<') {
      const end = source.indexOf('>', i + 1);
      if (end > i + 1) {
        const candidate = source.slice(i + 1, end);
        if (/^https?:\/\/[^\s]+$/i.test(candidate)) {
          tokens.push({ type: 'link', href: candidate, children: [{ type: 'text', text: candidate }] });
          i = end + 1;
          continue;
        }
        if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(candidate)) {
          tokens.push({ type: 'link', href: `mailto:${candidate}`, children: [{ type: 'text', text: candidate }] });
          i = end + 1;
          continue;
        }
      }
    }

    if (source[i] === '\n') {
      tokens.push({ type: 'break' });
      i++;
      continue;
    }

    pushText(tokens, source[i]);
    i++;
  }

  return tokens;
}

function splitTableRow(line) {
  if (!line.includes('|')) return null;
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);

  const cells = [];
  let current = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && value[i + 1] === '|') {
      current += '|';
      i++;
    } else if (value[i] === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += value[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

function tableAt(lines, index) {
  if (index + 1 >= lines.length) return null;
  const head = splitTableRow(lines[index]);
  const divider = splitTableRow(lines[index + 1]);
  if (!head || !divider || head.length !== divider.length || head.length < 2) return null;
  if (!divider.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  return {
    head,
    align: divider.map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : (cell.endsWith(':') ? 'right' : 'left')),
  };
}

function startsBlock(lines, index) {
  const line = lines[index] || '';
  return FENCE_RE.test(line) || HEADING_RE.test(line) || QUOTE_RE.test(line)
    || LIST_RE.test(line) || HR_RE.test(line) || !!tableAt(lines, index);
}

export function parseMarkdown(value) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];

  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) { i++; continue; }

    const fence = lines[i].match(FENCE_RE);
    if (fence) {
      const marker = fence[1][0];
      const minimum = fence[1].length;
      const language = (fence[2] || '').slice(0, 32);
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker === '`' ? '`' : '~'}{${minimum},}\\s*$`).test(lines[i])) {
        body.push(lines[i++]);
      }
      if (i < lines.length) i++;
      blocks.push({ type: 'code-block', language, text: body.join('\n') });
      continue;
    }

    const heading = lines[i].match(HEADING_RE);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInlineMarkdown(heading[2].replace(/\s+#+\s*$/, '')) });
      i++;
      continue;
    }

    if (HR_RE.test(lines[i])) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    const table = tableAt(lines, i);
    if (table) {
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim()) {
        const cells = splitTableRow(lines[i]);
        if (!cells) break;
        rows.push(table.head.map((_, cellIndex) => cells[cellIndex] || ''));
        i++;
      }
      blocks.push({
        type: 'table',
        align: table.align,
        head: table.head.map((cell) => parseInlineMarkdown(cell)),
        rows: rows.map((row) => row.map((cell) => parseInlineMarkdown(cell))),
      });
      continue;
    }

    if (QUOTE_RE.test(lines[i])) {
      const quoted = [];
      while (i < lines.length) {
        const match = lines[i].match(QUOTE_RE);
        if (!match) break;
        quoted.push(match[1]);
        i++;
      }
      blocks.push({ type: 'blockquote', blocks: parseMarkdown(quoted.join('\n')) });
      continue;
    }

    const list = lines[i].match(LIST_RE);
    if (list) {
      const ordered = /^\d/.test(list[1]);
      const start = ordered ? Math.min(Number.parseInt(list[1], 10) || 1, 1_000_000) : 1;
      const items = [];
      while (i < lines.length) {
        const item = lines[i].match(LIST_RE);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        let text = item[2];
        i++;
        while (i < lines.length && /^ {2,}\S/.test(lines[i]) && !LIST_RE.test(lines[i])) {
          text += `\n${lines[i].trim()}`;
          i++;
        }
        const task = text.match(/^\[([ xX])\]\s+(.*)$/);
        items.push({
          checked: task ? task[1].toLowerCase() === 'x' : null,
          children: parseInlineMarkdown(task ? task[2] : text),
        });
      }
      blocks.push({ type: 'list', ordered, start, items });
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim()) {
      if (paragraph.length && startsBlock(lines, i)) break;
      paragraph.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: 'paragraph', children: parseInlineMarkdown(paragraph.join('\n')) });
  }

  return blocks;
}

export function safeMarkdownHref(value) {
  const href = String(value ?? '').trim();
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return null;
  if (/^https?:\/\/[^\s]+$/i.test(href) || /^mailto:[^\s@]+@[^\s@]+$/i.test(href)) return href;
  return null;
}

function appendInline(parent, tokens) {
  for (const token of tokens) {
    if (token.type === 'text') parent.append(document.createTextNode(token.text));
    else if (token.type === 'break') parent.append(document.createElement('br'));
    else if (token.type === 'code') {
      const code = document.createElement('code');
      code.textContent = token.text;
      parent.append(code);
    } else if (token.type === 'strong' || token.type === 'em' || token.type === 'del') {
      const node = document.createElement(token.type);
      appendInline(node, token.children);
      parent.append(node);
    } else if (token.type === 'link' || token.type === 'image-link') {
      const href = safeMarkdownHref(token.href);
      const node = document.createElement(href ? 'a' : 'span');
      if (token.type === 'image-link') node.append(document.createTextNode('图片：'));
      appendInline(node, token.children);
      if (href) {
        node.href = href;
        node.target = '_blank';
        node.rel = 'noopener noreferrer';
      }
      parent.append(node);
    }
  }
}

function renderBlock(block) {
  if (block.type === 'heading') {
    const node = document.createElement(`h${block.level}`);
    appendInline(node, block.children);
    return node;
  }
  if (block.type === 'paragraph') {
    const node = document.createElement('p');
    appendInline(node, block.children);
    return node;
  }
  if (block.type === 'hr') return document.createElement('hr');
  if (block.type === 'code-block') {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (/^[a-z0-9_+-]{1,32}$/i.test(block.language)) code.className = `language-${block.language}`;
    code.textContent = block.text;
    pre.append(code);
    return pre;
  }
  if (block.type === 'blockquote') {
    const node = document.createElement('blockquote');
    for (const child of block.blocks) node.append(renderBlock(child));
    return node;
  }
  if (block.type === 'list') {
    const node = document.createElement(block.ordered ? 'ol' : 'ul');
    if (block.ordered && block.start !== 1) node.start = block.start;
    for (const item of block.items) {
      const li = document.createElement('li');
      if (item.checked !== null) {
        li.classList.add('task-list-item');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.disabled = true;
        box.checked = item.checked;
        box.setAttribute('aria-label', item.checked ? '已完成' : '未完成');
        li.append(box);
      }
      appendInline(li, item.children);
      node.append(li);
    }
    return node;
  }
  if (block.type === 'table') {
    const wrap = document.createElement('div');
    wrap.className = 'agent-markdown-table-wrap';
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    block.head.forEach((cell, index) => {
      const th = document.createElement('th');
      th.style.textAlign = block.align[index];
      appendInline(th, cell);
      headRow.append(th);
    });
    thead.append(headRow);
    const tbody = document.createElement('tbody');
    for (const row of block.rows) {
      const tr = document.createElement('tr');
      row.forEach((cell, index) => {
        const td = document.createElement('td');
        td.style.textAlign = block.align[index];
        appendInline(td, cell);
        tr.append(td);
      });
      tbody.append(tr);
    }
    table.append(thead, tbody);
    wrap.append(table);
    return wrap;
  }
  return document.createTextNode('');
}

export function renderMarkdownInto(container, value) {
  container.classList.add('agent-markdown');
  container.replaceChildren(...parseMarkdown(value).map(renderBlock));
}
