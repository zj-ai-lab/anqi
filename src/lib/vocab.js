import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rulesDir = path.join(__dirname, '..', '..', 'rules');

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(rulesDir, name), 'utf8'));
}
function loadOptional(name) {
  const file = path.join(rulesDir, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

// 词表分文件维护：民诉（event_types / stage_templates）+ 刑事（*_criminal）。
// 合并后对上层完全透明；刑事文件的程序名带「刑事」前缀，与民诉 key 不冲突。
const et = load('event_types.json');
const etCr = loadOptional('event_types_criminal.json');
const st = load('stage_templates.json');
const stCr = loadOptional('stage_templates_criminal.json');
const slCr = loadOptional('stage_labels_criminal.json');   // 17 值诉讼状态标签层（刑事）
const lt = loadOptional('law_texts.json');                 // 本地法条原文库（民诉线）
const ltCr = loadOptional('law_texts_criminal.json');      // 本地法条原文库（刑事）

const allEventTypes = [...et.types, ...((etCr && etCr.types) || [])];

export const eventTypes = allEventTypes; // [{id,label}]
export const eventLabel = Object.fromEntries(allEventTypes.map((t) => [t.id, t.label]));
export const stageTemplates = { ...st.procedures, ...((stCr && stCr.procedures) || {}) }; // {一审:[...], 刑事一审:[...], ...}
export const procedures = Object.keys(stageTemplates);
export const staleDaysDefault = st.stale_days_default || 30;
export const stageTasks = { ...(st.stage_tasks || {}), ...((stCr && stCr.stage_tasks) || {}) }; // When/Then 模板（D7）

// 17 值诉讼状态标签（刑事）：仅作展示/筛选层与 procedure 同步写入的依据，不参与规则匹配。
// 规则匹配只看 cases.procedure（见 engine.js ruleMatches），故本层加错不会误派生期限。
export const stageLabels = (slCr && slCr.labels) || [];
export const stageLabelMap = Object.fromEntries(stageLabels.map((l) => [l.label, l]));

// 本地法条原文库：浮层展示用，离线可查、不耗检索额度。民诉（law_texts）+ 刑事（law_texts_criminal）合并。
// 结构：[{cite, match[], law, article, label, text, source, timeliness, url, retrieved_at}]。
// 匹配方式：前端取规则的 basis 文本，判断其是否包含某条目的 match 数组内任一元素（缺 match 时回退用 cite）。
// 文件缺失时为空数组，浮层退化为只显示规则自带的依据摘要。
export const lawTexts = [...((lt && lt.laws) || []), ...((ltCr && ltCr.laws) || [])];

export function tasksForStage(procedure, stage) {
  return stageTasks[procedure]?.[stage] || [];
}

export function isEventType(id) {
  return Object.hasOwn(eventLabel, id);
}
export function stagesOf(procedure) {
  return stageTemplates[procedure] || [];
}
