// 案件夹分组的读取口径（settings 表 case_folder_groups）。
//
// 分组 = 文件根下被登记为「类别」的一级文件夹（如 诉讼/、顾问/）。登记后，案件夹既可以
// 是文件根下的一级文件夹（老样子），也可以是某个分组下的一级文件夹（folder_path 记为
// 「分组/案件夹」）。最多两层；分组本身不是案件夹，案件夹不互相嵌套。
//
// 凡是要把 cases 行解析成真实案件夹的地方（文件 API、款项凭证、附件、LegalRAG 桥、
// AI 助理 supervisor）都经本模块取当前分组清单，再交给 secure-files.js 做结构与真实
// 路径校验——secure-files.js 本身不碰数据库。没登记任何分组时，一切行为与此前一致。
import { db } from '../db.js';
import { CASE_TYPES } from '../../public/js/case-types.js';
import {
  caseDirectoryName,
  normalizeCaseDirectoryName,
  resolveCaseDirectoryForCase,
} from './secure-files.js';

export const CASE_FOLDER_SETTINGS_KEY = 'case_folder_groups';
export const MAX_CASE_FOLDER_GROUPS = 20;

// 存储值是 JSON：{ groups: ['诉讼','顾问'], defaults: { 民事: '诉讼', 非诉: '顾问' } }。
// 读取时逐项重新校验：坏值、重复项、指向不存在分组的默认值一律丢弃，不抛错。
export function parseCaseFolderConfig(raw) {
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  const groups = [];
  for (const value of Array.isArray(parsed?.groups) ? parsed.groups : []) {
    const name = normalizeCaseDirectoryName(value);
    if (name && !groups.includes(name) && groups.length < MAX_CASE_FOLDER_GROUPS) groups.push(name);
  }
  const defaults = {};
  const source = parsed?.defaults && typeof parsed.defaults === 'object' ? parsed.defaults : {};
  for (const type of CASE_TYPES) {
    const group = normalizeCaseDirectoryName(source[type]);
    if (group && groups.includes(group)) defaults[type] = group;
  }
  return { groups, defaults };
}

export function readCaseFolderConfig() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(CASE_FOLDER_SETTINGS_KEY);
  return parseCaseFolderConfig(row?.value);
}

export function writeCaseFolderConfig(config) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(CASE_FOLDER_SETTINGS_KEY, JSON.stringify({ groups: config.groups, defaults: config.defaults }));
}

export function caseFolderOptions() {
  return { groups: readCaseFolderConfig().groups };
}

// 本案案件夹的相对路径（「案件夹」或「分组/案件夹」）；不合法时回落标题，与 secure-files 同口径。
export function caseFolderPathOf(caseRow) {
  return caseDirectoryName(caseRow, caseFolderOptions());
}

export function resolveCaseFolderForCase(configuredRoot, caseRow) {
  return resolveCaseDirectoryForCase(configuredRoot, caseRow, caseFolderOptions());
}

export function isGroupedCaseFolder(folderPath) {
  return typeof folderPath === 'string' && folderPath.includes('/');
}
