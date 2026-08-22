export async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    // 【2026-08-23 UX 缺陷修复，编排方人工验收发现】并非所有 401 都等于
    // "anqi 会话过期"——例如 POST /api/agent/models 这类业务端点表达"上游
    // 供应商认证失败"时，服务端已经改用非 401 状态码（见
    // src/agent/models-client.js 的 modelsErrorToHttpStatus() 注释表）；这里
    // 再加一层前端纵深防御，与后端那一层互为兜底，不依赖"后端每个端点都记得
    // 避开 401"这一件事单独成立。判断依据：apiAuth 中间件返回的会话失效
    // 401，body 恒为 {error:'unauthorized'}（见 src/middleware/auth.js），
    // 从不带业务 `code` 字段；只有响应体确实不含非空字符串 `code` 时才当真
    // 是会话失效并跳登录页——带 code 的 401（万一未来某个端点疏忽把业务语义
    // 塞进了 401）一律交给下面 !res.ok 分支按普通错误处理并展示给调用方，
    // 不再无条件跳转。用 res.clone() 是因为 body 只能被消费一次，这里预读一
    // 次不影响下面 !res.ok 分支正常再读一次原始 res。
    let body = null;
    try { body = await res.clone().json(); } catch { /* body 不是 JSON，按无 code 处理 */ }
    if (!body || typeof body.code !== 'string' || !body.code) {
      location.href = '/login.html';
      throw new Error('unauthorized');
    }
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
