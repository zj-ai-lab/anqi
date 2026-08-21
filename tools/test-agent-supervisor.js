// DSH sidecar supervisor 最小自检——不发模型请求，不需要模型 key。
// 只验证两条红线（任务书硬规则）：
//   1. enabled=false 必须在读 credential、spawn 子进程之前短路返回；
//   2. 案件夹越出 ANJIAN_FILES_ROOT（包括 symlink 越权）必须被拒绝，且同样
//      不能走到 spawn 那一步。
// 用注入的 spawnFn 断言"从未被调用"，取代真正拉起 DSH 子进程——本阶段任务书
// 明确不允许发模型请求/起真实 sidecar。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from '../src/db.js';
import { AgentSupervisor } from '../src/agent/supervisor.js';
import { AGENT_SETTINGS_KEYS } from '../src/agent/config.js';

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

function clearAgentSettings() {
  for (const key of Object.values(AGENT_SETTINGS_KEYS)) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
}

function insertCase(name) {
  const info = db.prepare(
    `INSERT INTO cases (name, procedure, stage, status) VALUES (?, '一审', '', 'active')`
  ).run(name);
  return info.lastInsertRowid;
}

function neverSpawn() {
  return () => { throw new Error('spawnFn must not be called for this scenario'); };
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-supervisor-'));
const filesRoot = path.join(scratch, 'files');
fs.mkdirSync(filesRoot, { recursive: true });

// ---- 场景 1：enabled=false 短路 ----
{
  clearAgentSettings(); // 默认 enabled 不是 'true'
  const caseId = insertCase('自检案-未启用');
  fs.mkdirSync(path.join(filesRoot, '自检案-未启用'));

  const supervisor = new AgentSupervisor({
    filesRoot,
    spawnFn: neverSpawn(),
  });
  const result = await supervisor.start(caseId);
  assert.equal(result.status, 'disabled', 'enabled 非 true 时必须返回 disabled');
  assert.equal(supervisor.workers.has(caseId), false, 'disabled 短路不应该创建 worker 记录');
  console.log('  [1/3] enabled=false 短路：ok（未触碰 credential/cwd/spawn）');
}

// ---- 场景 2：enabled=true 但案件夹越出 ANJIAN_FILES_ROOT（不存在/未对应）----
{
  clearAgentSettings();
  setSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
  setSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
  setSetting(AGENT_SETTINGS_KEYS.model, 'deepseek-chat');
  setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'ANQI_TEST_FAKE_API_KEY');
  process.env.ANQI_TEST_FAKE_API_KEY = 'not-a-real-key';
  process.env.ANJIAN_INTERNAL_KEY = 'not-a-real-internal-key';

  const caseId = insertCase('自检案-无案件夹');
  // 故意不创建 filesRoot/自检案-无案件夹 目录。

  const supervisor = new AgentSupervisor({
    filesRoot,
    spawnFn: neverSpawn(),
  });
  const result = await supervisor.start(caseId);
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'case_folder_missing');
  assert.equal(supervisor.workers.has(caseId) === false || supervisor.workers.get(caseId)?.status === 'error', true);
  console.log('  [2/3] 案件夹不存在：ok（cwd 校验拒绝，未 spawn）');
}

// ---- 场景 3：案件夹是 symlink（越权手法之一）----
{
  clearAgentSettings();
  setSetting(AGENT_SETTINGS_KEYS.enabled, 'true');
  setSetting(AGENT_SETTINGS_KEYS.provider, 'deepseek-official');
  setSetting(AGENT_SETTINGS_KEYS.model, 'deepseek-chat');
  setSetting(AGENT_SETTINGS_KEYS.apiKeyEnv, 'ANQI_TEST_FAKE_API_KEY');

  const caseName = '自检案-符号链接';
  const caseId = insertCase(caseName);
  const outside = path.join(scratch, 'outside-real-dir');
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(filesRoot, caseName), 'dir');

  const supervisor = new AgentSupervisor({
    filesRoot,
    spawnFn: neverSpawn(),
  });
  const result = await supervisor.start(caseId);
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'cwd_invalid');
  console.log('  [3/3] 案件夹是 symlink：ok（cwd 校验拒绝，未 spawn）');
}

console.log('agent supervisor 自检全部通过');
