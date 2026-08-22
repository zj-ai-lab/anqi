// 「拉取可用模型」下拉框的纯选项计算逻辑，从 public/js/profile.js 的
// showModelSelect() 里拆出来单独成一个不依赖 DOM 的纯函数——原因见下面的
// 红线注释，也顺带让这条规则能在 Node 里直接单元测试（tools/test-agent-
// model-options.js），不需要真实浏览器/DOM。
//
// 【红线，2026-08-23 复审修复】此前的实现是：models.slice() 得到 values，
// 如果 preferValue 不在其中就把它 unshift 进 values，再判断
// `values.includes(preferValue)` 来决定要不要默认选中它——但 unshift 之后
// `values` 恒定包含 preferValue，这个判断永远是 true，于是"拉取成功"之后
// 下拉框会默认选中一个供应商这次压根没有返回的旧模型名（用户之前手填、或
// 上一次拉取时选的），状态行却如实显示"共 N 个模型"（N 是真实拉取到的数
// 量），两者对不上——按产品设计的主流程"拉取 → 下拉选一个 → 保存"，用户
// 信任默认选中直接保存，就会把一个不受支持的模型名存下去，错误要等 worker
// 真跑时才暴露。
//
// 这里用两个不同的数组把"渲染进下拉框的选项"与"判断默认选中项的依据"分开：
// knownValues 只是这次真实拉取到的列表（决定默认选中项）；values 才是渲染
// 用的列表（可能多出一个 preferValue，让用户不丢之前的选择、能手动切回
// 去，但绝不能让它冒充默认选中项）。
export function buildModelOptions(models, preferValue) {
  const knownValues = Array.isArray(models) ? models.slice() : [];
  const isForeign = !!preferValue && !knownValues.includes(preferValue);
  const values = isForeign ? [preferValue, ...knownValues] : knownValues;
  const options = values.map((value) => ({
    value,
    // 外来的旧值明确标注"不在本次拉取到的列表中"，不让它看起来像一个正常
    // 选项——用户如果确实想继续用它，可以自己从下拉里选中它，但保存前应该
    // 清楚知道这不是供应商刚刚确认支持的模型。
    label: isForeign && value === preferValue ? `${value}（当前值，不在本次拉取到的列表中）` : value,
  }));
  let selected = null;
  if (preferValue && knownValues.includes(preferValue)) {
    selected = preferValue;
  } else if (knownValues.length) {
    selected = knownValues[0];
  }
  return { options, selected };
}
