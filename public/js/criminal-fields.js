import { el } from './api.js';

export function mountCriminalFields(container, meta, procedureSelect, stageSelect) {
  const inputs = {};
  const quick = el('select', { 'aria-label': '刑事阶段快捷切换' },
    el('option', { value: '' }, '选择阶段快捷填入程序、阶段及已明确的羁押状态'),
    ...(meta.stage_labels || []).filter(s => !s.terminal).map(s => el('option', { value: s.label }, s.label)));
  quick.addEventListener('change', () => {
    const mapping = meta.stage_labels.find(s => s.label === quick.value);
    if (!mapping) return;
    procedureSelect.value = mapping.procedure;
    procedureSelect.dispatchEvent(new Event('change'));
    stageSelect.value = mapping.stage;
    if (mapping.custody_status) inputs.custody_status.value = mapping.custody_status;
  });
  container.replaceChildren(
    el('p', { class: 'meta' }, '刑事条件未确认可留空；相关期限会提示待补条件。作案类型不是罪名，罪名请填在案由。阶段快捷切换只填入程序和阶段，不保存独立的退查回数标签。'),
    el('label', { class: 'f' }, '阶段快捷切换', quick),
    el('div', { class: 'formgrid' }, ...(meta.criminal_fields || []).map(f => {
      const input = f.options
        ? el('select', { name: f.key }, el('option', { value: '' }, '待确认'), ...f.options.map(v => el('option', { value: v }, v)))
        : el('input', { name: f.key, maxlength: '1000' });
      inputs[f.key] = input;
      return el('label', { class: 'f' }, f.label, input);
    })));
  const visibility = () => { container.hidden = !procedureSelect.value.startsWith('刑事'); quick.value = ''; };
  procedureSelect.addEventListener('change', visibility);
  visibility();
  return { fill(row) { for (const [key, input] of Object.entries(inputs)) input.value = row[key] || ''; visibility(); } };
}
