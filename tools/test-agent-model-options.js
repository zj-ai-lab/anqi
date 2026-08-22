// public/js/agent-model-options.js 的 buildModelOptions() 纯逻辑单测——不
// 依赖 DOM，直接跑在 Node 里。这是 2026-08-23 复审修复的红线回归：拉取模型
// 成功后下拉框的默认选中项，必须只在用户之前的值确实出现在这次拉取到的
// 真实列表里才选它，否则必须默认选中真实列表第一项，绝不能让一个供应商
// 这次压根没返回的旧模型名冒充默认选中项（此前的 bug：unshift 进渲染列表
// 之后再用同一个列表判断"是否命中"，判断恒为真）。
import assert from 'node:assert/strict';
import { buildModelOptions } from '../public/js/agent-model-options.js';

// 1) preferValue 命中真实列表 → 原样选中它，不产生额外的"外来"选项。
{
  const { options, selected } = buildModelOptions(['a', 'b', 'c'], 'b');
  assert.deepEqual(options.map((o) => o.value), ['a', 'b', 'c'], '命中时不应该额外插入任何选项');
  assert.equal(selected, 'b');
  assert.equal(options.find((o) => o.value === 'b').label, 'b', '命中时选项文案就是模型名本身，不带任何后缀');
}

// 2) 【红线回归】preferValue 不在真实列表里（用户之前手填、这次供应商没
//    返回的旧模型名）→ 默认选中真实列表第一项，不是这个外来值；外来值仍
//    然作为一个额外选项出现在列表里（不丢用户之前的选择），但文案必须明确
//    标注"不在本次拉取到的列表中"，且总选项数必须是「真实模型数 + 1」。
{
  const { options, selected } = buildModelOptions(['deepseek-chat', 'deepseek-reasoner'], 'gpt-4o-legacy');
  assert.equal(selected, 'deepseek-chat', '默认必须选中真实列表第一项，不能是外来的旧值');
  assert.equal(options.length, 3, '外来值必须作为额外选项出现，总数应为真实模型数+1');
  const foreignOption = options.find((o) => o.value === 'gpt-4o-legacy');
  assert.ok(foreignOption, '外来值本身不应该从列表里消失（用户还能手动切回去）');
  assert.match(foreignOption.label, /不在本次拉取到的列表中/, '外来值的文案必须明确标注它不在这次拉取到的列表中，不能冒充正常选项');
  assert.equal(options[0].value, 'gpt-4o-legacy', '外来值渲染在最前面，方便用户看到并主动切换');
}

// 3) preferValue 为空/未提供 → 默认选中真实列表第一项，不产生外来选项。
{
  const { options, selected } = buildModelOptions(['only-model'], '');
  assert.equal(selected, 'only-model');
  assert.equal(options.length, 1);
}
{
  const { options, selected } = buildModelOptions(['x', 'y'], undefined);
  assert.equal(selected, 'x');
  assert.equal(options.length, 2);
}

// 4) 真实列表为空、只有一个外来 preferValue → 没有任何真实模型可以默认选
//    中，selected 必须是 null（不能凭空选中一个供应商都没确认过的值）；
//    该外来值仍然作为唯一选项渲染出来，供用户自己决定。
{
  const { options, selected } = buildModelOptions([], 'leftover-model');
  assert.equal(selected, null, '真实列表为空时不应该有任何默认选中值');
  assert.deepEqual(options.map((o) => o.value), ['leftover-model']);
  assert.match(options[0].label, /不在本次拉取到的列表中/);
}

// 5) 真实列表为空、preferValue 也为空 → 两者都是空结果，不抛出。
{
  const { options, selected } = buildModelOptions([], '');
  assert.deepEqual(options, []);
  assert.equal(selected, null);
}

// 6) models 不是数组（防御性：调用方理论上总传数组，这里确认不会抛出）。
{
  const { options, selected } = buildModelOptions(null, 'foo');
  assert.deepEqual(options.map((o) => o.value), ['foo']);
  assert.equal(selected, null);
}

console.log('agent-model-options 自检全部通过：命中/未命中/空列表/无 preferValue 四类场景，默认选中项与文案均正确');
