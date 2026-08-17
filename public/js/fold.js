// 全站原生折叠：只保存 UI 状态，不触碰 API、数据库或业务数据。
const KEY = 'anjian-fold';
const skipNextToggle = new WeakSet();
let suppressPersistence = false;

function readAll() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeAll(value) {
  try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* 私密模式/配额不足时退化为本次状态 */ }
}

export function foldOpen(id, dflt = false) {
  const value = readAll()[id];
  return typeof value === 'boolean' ? value : dflt;
}

export function bindFold(details, id, dflt = false, { forceOpen = false } = {}) {
  if (!details || details.tagName !== 'DETAILS' || !id) return details;
  details.dataset.foldId = id;
  details.open = forceOpen ? true : foldOpen(id, dflt);
  details.addEventListener('toggle', () => {
    if (suppressPersistence || skipNextToggle.delete(details)) return;
    const all = readAll();
    all[id] = details.open;
    writeAll(all);
  });
  return details;
}

export function setFoldOpen(details, open, { persist = true } = {}) {
  if (!details || details.tagName !== 'DETAILS') return;
  if (!persist) {
    skipNextToggle.add(details);
    setTimeout(() => skipNextToggle.delete(details), 0);
  }
  details.open = Boolean(open);
  if (!persist || !details.dataset.foldId) return;
  const all = readAll();
  all[details.dataset.foldId] = details.open;
  writeAll(all);
}

export function bindAllFolds(root = document) {
  return [...root.querySelectorAll('details[data-fold-id]')].map((details) => {
    const dflt = details.dataset.defaultOpen === 'true'
      || (details.hasAttribute('data-default-open') && details.dataset.defaultOpen !== 'false');
    return bindFold(details, details.dataset.foldId, dflt);
  });
}

let printStates = null;
function expandForPrint() {
  printStates = [...document.querySelectorAll('details')].map((details) => [details, details.open]);
  suppressPersistence = true;
  for (const [details] of printStates) details.open = true;
}

function restoreAfterPrint() {
  if (!printStates) return;
  for (const [details, open] of printStates) details.open = open;
  printStates = null;
  setTimeout(() => { suppressPersistence = false; }, 0);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeprint', expandForPrint);
  window.addEventListener('afterprint', restoreAfterPrint);
}
