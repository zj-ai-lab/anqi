export const CASE_TYPES=['民事','刑事','行政','非诉','其他','未分类'];
export const caseType=row=>CASE_TYPES.includes(row.case_type)?row.case_type:'未分类';
export const typeClass=row=>'case-type-'+CASE_TYPES.indexOf(caseType(row));
export const typeOrder=(a,b)=>CASE_TYPES.indexOf(caseType(a))-CASE_TYPES.indexOf(caseType(b));
export const procedureLabel=value=>({'一审':'民事一审','二审':'民事二审'}[value]||value||'程序待补');
