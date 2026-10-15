const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function focusableIn(dialog) {
  return [...dialog.querySelectorAll(FOCUSABLE)]
    .filter((node) => node.getClientRects().length && node.getAttribute('aria-hidden') !== 'true');
}

// 叠层时只有最上层响应键盘（与 fee-settlement 的 modalShell 同口径）：否则一次 Esc 会连关多层，
// 且下层按打开时的快照复原 inert，会把整页永久锁成 inert。
function isTopmost(overlay) {
  return [...document.querySelectorAll('.dmodal-overlay')].at(-1) === overlay;
}

export function openModal(dialog, {
  labelledBy = '',
  label = '',
  initialFocus = null,
  closeOnBackdrop = true,
  onClose = null,
} = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'dmodal-overlay';
  if (labelledBy) dialog.setAttribute('aria-labelledby', labelledBy);
  if (label) dialog.setAttribute('aria-label', label);
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  overlay.append(dialog);

  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const inertedBackground = [...document.body.children]
    .filter((node) => node !== overlay)
    .map((node) => ({ node, wasInert: node.inert }));
  let closed = false;

  const close = (value = null) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    for (const { node, wasInert } of inertedBackground) node.inert = wasInert;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    onClose?.(value);
  };

  const onKey = (event) => {
    if (!isTopmost(overlay)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = focusableIn(dialog);
    if (!nodes.length) {
      event.preventDefault();
      return;
    }
    const first = nodes[0];
    const last = nodes.at(-1);
    if (!nodes.includes(document.activeElement)) {
      // 点过弹层空白处后焦点在 body 上，从这里 Tab / Shift+Tab 也不得跑出弹层
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  overlay.addEventListener('click', (event) => {
    if (closeOnBackdrop && event.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  for (const { node } of inertedBackground) node.inert = true;

  const target = typeof initialFocus === 'function' ? initialFocus() : initialFocus;
  // focus() 返回 undefined：不能写成 target.focus() || 兜底，否则兜底永远执行、initialFocus 被覆盖。
  requestAnimationFrame(() => {
    if (closed) return;
    (target?.isConnected && dialog.contains(target) ? target : focusableIn(dialog)[0])?.focus();
  });
  return { overlay, dialog, close };
}

export function confirmModal(message, { title = '请确认', confirmLabel = '确认', danger = false } = {}) {
  return new Promise((resolve) => {
    const titleId = `modal-title-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const dialog = document.createElement('div');
    dialog.className = 'dmodal confirm-modal';
    dialog.innerHTML = `<h3 class="dmodal-title" id="${titleId}"></h3><p class="dmodal-hint"></p><div class="dmodal-actions"></div>`;
    dialog.querySelector('.dmodal-title').textContent = title;
    dialog.querySelector('.dmodal-hint').textContent = message;
    const actions = dialog.querySelector('.dmodal-actions');
    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.type = 'button';
    cancel.textContent = '取消';
    const confirm = document.createElement('button');
    confirm.className = `btn${danger ? ' danger' : ' primary'}`;
    confirm.type = 'button';
    confirm.textContent = confirmLabel;
    actions.append(cancel, confirm);
    const modal = openModal(dialog, { labelledBy: titleId, onClose: resolve });
    cancel.addEventListener('click', () => modal.close(false));
    confirm.addEventListener('click', () => modal.close(true));
  });
}
