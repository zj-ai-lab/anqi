// 期限「依据」浮层（Q10 裁定「丙」的落地，全站共享）。
// 背景：期限规则自带的 basis（依据摘要）文本很长，直铺在跑道行/时间线里会打断排版。
// 改为问号按钮，点开弹层展示：法规名 + 条号 + 条文原文 + 本案算法。
//
// 条文原文离线取自 /api/meta 的 law_texts（源文件 rules/law_texts.json + rules/law_texts_criminal.json），
// 不消耗任何检索额度；匹配方式为「规则的 basis 文本是否包含条目 match 数组内任一元素」。
//
// 起算口径（裁定「丙」）：月数/年数类一律按法定算法（次日起算）。实务文书常按含当日起算书写，
// 得出的届满日会早 1 天，弹层须显式注明，避免用户拿文书日期对不上时误判系统算错。
//
// 用法：
//   import { setLawTexts, basisBtn } from './deadline-basis.js';
//   setLawTexts(meta.law_texts);        // 已取过 /meta 的页面注入一次即可
//   el('span', {}, basisBtn(d))         // d 为期限对象，需含 basis / calc_note / name / due_on
import { api, el } from './api.js';

let lawTexts = [];
let lazy = null;

// 页面若已取过 /meta，直接注入，避免二次请求。
export function setLawTexts(list) {
  if (Array.isArray(list)) lawTexts = list;
}

// 未注入时按需懒加载一次（如首页 today.js 不取 /meta）。失败不阻断：退化为只显示依据摘要。
function ensureLawTexts() {
  if (lawTexts.length) return Promise.resolve(lawTexts);
  if (!lazy) {
    lazy = api('/meta')
      .then((m) => { lawTexts = m.law_texts || []; return lawTexts; })
      .catch(() => { lawTexts = []; return lawTexts; });
  }
  return lazy;
}

export function matchLawTexts(basis) {
  const b = String(basis || '');
  if (!b) return [];
  return lawTexts.filter((t) => {
    const keys = (t.match && t.match.length) ? t.match : [t.cite];
    return keys.some((k) => k && b.includes(k));
  });
}

// 起算口径差异提示：仅在确为法定次日起算时出现（引擎写入的 calc_note 带「次日起算」）。
function countFromDiff(d) {
  const s = `${d.calc_note || ''}${d.basis || ''}`;
  if (!s.includes('次日起算')) return null;
  return '本期限按法定算法自次日起算（期间开始之日不计入）。实务文书（起诉书、判决书、期限告知书）常按含当日起算书写，据此得出的届满日会早 1 天；两者不一致时以本系统法定算法为准。';
}

function articleCard(t) {
  return el('div', { class: 'basis-art' },
    el('div', { class: 'basis-art-hd' },
      el('span', { class: 'basis-art-name' }, `${t.law} ${t.article}`),
      t.timeliness ? el('span', { class: 'pill' }, t.timeliness) : null
    ),
    t.label ? el('div', { class: 'basis-art-label' }, t.label) : null,
    el('div', { class: 'basis-art-text' }, t.text || '（未取得条文原文）'),
    t.source ? el('div', { class: 'basis-art-src' }, `来源：${t.source}${t.retrieved_at ? `（检索日 ${t.retrieved_at}）` : ''}`) : null
  );
}

export function openBasisPop(d) {
  const render = () => {
    const matched = matchLawTexts(d.basis);
    const diff = countFromDiff(d);
    const cards = matched.length
      ? matched.map(articleCard)
      : [el('div', { class: 'basis-art' },
          el('div', { class: 'basis-art-hd' }, el('span', { class: 'basis-art-name' }, '未匹配到本地法条库')),
          el('div', { class: 'basis-art-label' }, '以下为该期限规则自带的依据摘要'),
          el('div', { class: 'basis-art-text' }, d.basis || '（该期限未记录依据）')
        )];

    const overlay = el('div', {
      class: 'dmodal-overlay',
      onclick: (e) => { if (e.target === overlay) close(); },
    },
      el('div', { class: 'dmodal basis-pop', role: 'dialog', 'aria-modal': 'true', 'aria-label': `期限依据：${d.name}` },
        el('div', { class: 'basis-pop-hd' },
          el('h3', {}, '期限依据'),
          el('button', { class: 'basis-pop-x', type: 'button', 'aria-label': '关闭', onclick: () => close() }, '×')
        ),
        el('div', { class: 'basis-pop-sub' }, `${d.name} · ${d.due_on} 到期`),
        diff ? el('div', { class: 'basis-pop-warn' }, diff) : null,
        ...cards,
        d.calc_note ? el('div', { class: 'basis-calc' }, el('span', { class: 'basis-calc-hd' }, '本案算法'), d.calc_note) : null
      )
    );

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }

    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    overlay.querySelector('.basis-pop-x')?.focus();
  };

  // 首次打开且法条库尚未注入时，异步取回后重绘一次（标题与「本案算法」先行可见）。
  if (lawTexts.length) { render(); return; }
  ensureLawTexts().then(render);
}

// 跑道行/时间线/首页共用的问号按钮。无 basis 时不渲染（el() 忽略 null）。
export function basisBtn(d, label = '依据') {
  if (!d.basis) return null;
  return el('button', {
    class: 'basis-q', type: 'button', title: '查看法条依据与原文',
    'aria-label': `查看期限依据：${d.name}`,
    onclick: (e) => { e.stopPropagation(); openBasisPop(d); },
  }, label);
}
