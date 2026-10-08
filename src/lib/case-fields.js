// 后端校验与前端选项共享一个来源；空值表示尚未确认，不代表普通/公诉/在押。
export const criminalFields = [
  { key: 'case_side', label: '办案方向', options: ['辩护', '控告'] },
  { key: 'entrust_stage', label: '委托范围', options: ['单次会见', '侦查阶段', '审查起诉', '一审', '二审', '再审', '全案'] },
  { key: 'crime_type', label: '作案类型', options: ['普通', '流窜作案', '多次作案', '结伙作案'] },
  { key: 'trial_mode', label: '审理程序', options: ['普通程序', '简易程序', '速裁程序'] },
  { key: 'case_nature', label: '案件性质', options: ['公诉', '自诉'] },
  { key: 'custody_status', label: '羁押状态', options: ['在押', '取保', '监视居住', '未羁押'] },
  { key: 'co_counsel', label: '合作律师' },
  { key: 'contract_no', label: '委托合同号' },
  { key: 'custody_place', label: '羁押场所' },
  { key: 'handling_agency', label: '办案机关' },
];
export const criminalFieldKeys = criminalFields.map(f => f.key);
export function validateCriminalFields(body) {
  for (const f of criminalFields) {
    if (!(f.key in body)) continue;
    const value = body[f.key];
    if (typeof value !== 'string' || value.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) return `${f.label}格式非法`;
    if (value && f.options && !f.options.includes(value)) return `${f.label}须为：${f.options.join('/')}`;
  }
  return null;
}
