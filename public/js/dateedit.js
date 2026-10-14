// 日期补录/改期弹层（全站共享）：小玻璃模态 + 原生日期控件。
// 用法：const v = await datePrompt({ title, fields: [{key,label,value,required,type?='date'|'text'|'tel'|'select',options?=[{value,label}],placeholder?}] });
// 返回 {key: 'YYYY-MM-DD'|''} 或 null（取消）。Enter=确认，Esc=取消，点遮罩=取消。
import { el } from './api.js';
import { openModal } from './modal.js';

let modalSeq = 0;

export function datePrompt({ title, fields, hint = '' }) {
  return new Promise((resolve) => {
    const inputs = {};
    const titleId = `dmodal-title-${++modalSeq}`;
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
        modal.close(out);
      },
    },
      el('h3', { class: 'dmodal-title', id: titleId }, title),
      hint ? el('p', { class: 'dmodal-hint' }, hint) : null,
      ...fields.map((f) => {
        if ((f.type || 'date') === 'select') {
          inputs[f.key] = el('select', { ...(f.required ? { required: '' } : {}) },
            ...(f.options || []).map((o) => el('option', { value: o.value }, o.label)));
          if (f.value != null) inputs[f.key].value = f.value;
        } else {
          inputs[f.key] = el('input', {
            type: f.type || 'date', value: f.value ?? '',
            ...(f.placeholder ? { placeholder: f.placeholder } : {}),
            ...(f.required ? { required: '' } : {}),
            ...(f.inputmode ? { inputmode: f.inputmode } : {}),
            ...(f.autocomplete ? { autocomplete: f.autocomplete } : {}),
            ...(f.pattern ? { pattern: f.pattern } : {}),
            ...(f.title ? { title: f.title } : {}),
            ...(f.min != null ? { min: f.min } : {}), ...(f.max != null ? { max: f.max } : {}),
            ...(f.step != null ? { step: f.step } : {}),
          });
        }
        return el('label', { class: 'f' }, f.label, inputs[f.key]);
      }),
      el('div', { class: 'dmodal-actions' },
        el('button', { class: 'btn', type: 'button', onclick: () => modal.close(null) }, '取消'),
        el('button', { class: 'btn primary', type: 'submit' }, '确认')
      )
    );
    const dialog = el('div', { class: 'dmodal' }, form);
    const modal = openModal(dialog, { labelledBy: titleId, initialFocus: () => inputs[fields[0]?.key], onClose: resolve });
  });
}
