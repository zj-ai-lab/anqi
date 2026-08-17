// 日期补录/改期弹层（全站共享）：小玻璃模态 + 原生日期控件。
// 用法：const v = await datePrompt({ title, fields: [{key,label,value,required,type?='date'|'text'|'tel'|'select',options?=[{value,label}],placeholder?}] });
// 返回 {key: 'YYYY-MM-DD'|''} 或 null（取消）。Enter=确认，Esc=取消，点遮罩=取消。
import { el } from './api.js';

let modalSeq = 0;

export function datePrompt({ title, fields, hint = '' }) {
  return new Promise((resolve) => {
    const inputs = {};
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const titleId = `dmodal-title-${++modalSeq}`;
    let inertedBackground = [];
    let closed = false;
    const close = (val) => {
      if (closed) return;
      closed = true;
      overlay.remove();
      for (const node of inertedBackground) node.inert = false;
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      resolve(val);
    };

    const handleModalKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
      if (e.key !== 'Tab') return;
      const focusable = [...form.querySelectorAll(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter((node) => node.getClientRects().length && node.getAttribute('aria-hidden') !== 'true');
      if (!focusable.length) { e.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    const form = el('form', {
      class: 'dmodal-form',
      onsubmit: (e) => {
        e.preventDefault();
        const out = {};
        for (const f of fields) {
          const v = inputs[f.key].value;
          if (f.required && !v) { inputs[f.key].focus(); return; }
          out[f.key] = v;
        }
        close(out);
      },
    },
      el('h3', { class: 'dmodal-title', id: titleId }, title),
      hint ? el('p', { class: 'dmodal-hint' }, hint) : null,
      ...fields.map((f) => {
        // 支持 select 类型（原生下拉，零新依赖）
        if ((f.type || 'date') === 'select') {
          inputs[f.key] = el('select', {
            ...(f.required ? { required: '' } : {}),
          }, ...(f.options || []).map(o => el('option', { value: o.value }, o.label)));
          if (f.value != null) inputs[f.key].value = f.value;
        } else {
          inputs[f.key] = el('input', {
            type: f.type || 'date', value: f.value || '',
            ...(f.placeholder ? { placeholder: f.placeholder } : {}),
            ...(f.required ? { required: '' } : {}),
            ...(f.inputmode ? { inputmode: f.inputmode } : {}),
            ...(f.autocomplete ? { autocomplete: f.autocomplete } : {}),
            ...(f.pattern ? { pattern: f.pattern } : {}),
            ...(f.title ? { title: f.title } : {}),
            ...(f.min != null ? { min: f.min } : {}),
            ...(f.max != null ? { max: f.max } : {}),
            ...(f.step != null ? { step: f.step } : {}),
          });
        }
        return el('label', { class: 'f' }, f.label, inputs[f.key]);
      }),
      el('div', { class: 'dmodal-actions' },
        el('button', { class: 'btn', type: 'button', onclick: () => close(null) }, '取消'),
        el('button', { class: 'btn primary', type: 'submit' }, '确认')
      )
    );

    const overlay = el('div', {
      class: 'dmodal-overlay',
      onclick: (e) => { if (e.target === overlay) close(null); },
      onkeydown: handleModalKey,
    }, el('div', {
      class: 'dmodal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
    }, form));

    document.body.appendChild(overlay);
    inertedBackground = [...document.body.children].filter((node) => node !== overlay && !node.inert);
    for (const node of inertedBackground) node.inert = true;
    inputs[fields[0]?.key]?.focus();
  });
}
