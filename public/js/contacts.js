import { api, el, toast } from './api.js';
import { mountNav } from './nav.js';
import { datePrompt } from './dateedit.js';

await mountNav();

const money = (n) => `¥${Number(n || 0).toLocaleString('zh-CN')}`;
const list = document.getElementById('people-list');

function personRow(person) {
  const cooperation = [
    person.case_count ? `${person.case_count} 案` : '',
    person.share_count ? `${person.share_count} 笔分成` : '',
    person.receivable ? `我收 ${money(person.receivable)}` : '',
    person.payable ? `我分 ${money(person.payable)}` : '',
  ].filter(Boolean).join(' · ') || '尚无分成记录';
  return el('div', { class: 'row person-row' },
    el('div', { class: 'person-main' },
      el('b', {}, person.name),
      person.org ? el('span', { class: 'meta' }, person.org) : null,
      person.phone ? el('a', { class: 'meta nowrap', href: `tel:${person.phone}` }, person.phone) : null
    ),
    el('span', { class: 'grow meta' }, cooperation),
    el('span', { class: 'tl-actions' },
      el('button', { class: 'btn small', type: 'button', onclick: async () => {
        const value = await datePrompt({
          title: `编辑「${person.name}」`,
          fields: [
            { key: 'name', label: '姓名', value: person.name, required: true },
            { key: 'phone', label: '电话', value: person.phone },
            { key: 'org', label: '律所 / 单位', value: person.org },
            { key: 'note', label: '备注', value: person.note },
          ],
        });
        if (!value) return;
        await api(`/people/${person.id}`, { method: 'PATCH', body: value });
        toast('通讯录对象已更新 ✓');
        await load();
      } }, '编辑'),
      el('button', { class: 'btn small danger', type: 'button', onclick: async () => {
        if (!confirm(`删除通讯录对象「${person.name}」？`)) return;
        await api(`/people/${person.id}`, { method: 'DELETE' });
        toast('已删除');
        await load();
      } }, '删')
    )
  );
}

async function load() {
  const people = await api('/people');
  document.getElementById('contacts-meta').textContent = `${people.length} 位对象 · 分成数据按案件累计`;
  list.replaceChildren();
  if (!people.length) {
    list.append(el('div', { class: 'section-empty' }, '还没有通讯录对象；先新增合作律师，案件页就可以直接选择。'));
    return;
  }
  for (const person of people) list.append(personRow(person));
}

const addToggle = document.getElementById('person-add-toggle');
const addMore = document.getElementById('person-add-more');
addToggle.addEventListener('click', () => {
  const open = addMore.hasAttribute('hidden');
  if (open) addMore.removeAttribute('hidden'); else addMore.setAttribute('hidden', '');
  addToggle.textContent = open ? '收起' : '新增对象';
  addToggle.setAttribute('aria-expanded', String(open));
});
document.getElementById('person-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.target).entries());
  await api('/people', { body });
  toast('通讯录对象已建立 ✓');
  event.target.reset();
  addMore.setAttribute('hidden', '');
  addToggle.textContent = '新增对象';
  await load();
});

await load();
