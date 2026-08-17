export async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    let data = null;
    let msg = `HTTP ${res.status}`;
    try {
      data = await res.json();
      msg = data?.error || msg;
    } catch { /* noop */ }
    toast('❌ ' + msg);
    const error = new Error(msg);
    error.status = res.status;
    error.code = data?.code || '';
    error.data = data;
    throw error;
  }
  return res.json();
}

export function toast(msg, ms = 2200) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
}

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    n.append(c.nodeType ? c : document.createTextNode(c));
  }
  return n;
}

export function fmtDaysLeft(n) {
  if (n < 0) return `逾期 ${-n} 日`;
  if (n === 0) return '今日截止';
  return `剩 ${n} 日`;
}

export function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

export const SEV_LABEL = { critical: '致命', high: '重要', normal: '一般' };
export const STATUS_LABEL = { pending: '在追', done: '已完成', missed: '已错过', waived: '已放弃' };
