// 案件夹下拉的共用渲染（建案表单、案件详情换绑共用）。
// /api/case-folders 的 folders[].name 就是要回传的 folder_path：文件根下的文件夹是「名称」，
// 已登记分组下的文件夹是「分组/名称」，folders[].group 标出所属分组。
// 没有分组时照旧平铺；有分组时文件根下的放进「不分组」组，分组里的各放进自己的 <optgroup>。
import { el } from './api.js';

export function leafName(folderPath) {
  const value = String(folderPath || '');
  return value.slice(value.indexOf('/') + 1);
}

export function groupOf(folderPath) {
  const value = String(folderPath || '');
  const index = value.indexOf('/');
  return index < 0 ? '' : value.slice(0, index);
}

// label(folder) 决定每项显示的文字；分组内默认只显示末级名，分组名由 optgroup 标题给出。
export function appendFolderOptions(select, folders, { label = (folder) => leafName(folder.name) } = {}) {
  const list = Array.isArray(folders) ? folders : [];
  const groups = [...new Set(list.map((folder) => folder.group || groupOf(folder.name)).filter(Boolean))];
  const atRoot = list.filter((folder) => !(folder.group || groupOf(folder.name)));
  if (!groups.length) {
    for (const folder of atRoot) select.append(el('option', { value: folder.name }, label(folder)));
    return;
  }
  if (atRoot.length) {
    const rootGroup = el('optgroup', { label: '不分组' });
    for (const folder of atRoot) rootGroup.append(el('option', { value: folder.name }, label(folder)));
    select.append(rootGroup);
  }
  for (const group of groups) {
    const options = el('optgroup', { label: `${group}/` });
    for (const folder of list.filter((item) => (item.group || groupOf(item.name)) === group)) {
      options.append(el('option', { value: folder.name }, label(folder)));
    }
    select.append(options);
  }
}

// 自动创建时的落点：按案件类型的默认分组；没配默认分组就是文件根下。
export function defaultGroupFor(payload, caseType) {
  return payload?.defaults?.[caseType] || '';
}
