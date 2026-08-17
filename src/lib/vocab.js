import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rulesDir = path.join(__dirname, '..', '..', 'rules');

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(rulesDir, name), 'utf8'));
}

const et = load('event_types.json');
const st = load('stage_templates.json');

export const eventTypes = et.types; // [{id,label}]
export const eventLabel = Object.fromEntries(et.types.map((t) => [t.id, t.label]));
export const stageTemplates = st.procedures; // {一审:[...], ...}
export const procedures = Object.keys(st.procedures);
export const staleDaysDefault = st.stale_days_default || 30;
export const stageTasks = st.stage_tasks || {}; // When/Then 模板（D7）

export function tasksForStage(procedure, stage) {
  return stageTasks[procedure]?.[stage] || [];
}

export function isEventType(id) {
  return Object.hasOwn(eventLabel, id);
}
export function stagesOf(procedure) {
  return stageTemplates[procedure] || [];
}
