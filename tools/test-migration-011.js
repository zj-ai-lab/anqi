// migration 011：v10 → v11，验证旧推荐/候选保全、幂等索引与原子回滚。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDir = path.join(root, 'src', 'migrations');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-011-'));
const files10 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|010)_.*\.sql$/.test(name)).sort();
const files11 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|01[01])_.*\.sql$/.test(name)).sort();

function copy(files, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(migrationsDir, file), path.join(target, file));
}

const dir10 = path.join(scratch, 'v10');
const dir11 = path.join(scratch, 'v11');
copy(files10, dir10);
copy(files11, dir11);

const fixture = new Database(path.join(scratch, 'fixture.db'));
fixture.pragma('foreign_keys=ON');
runMigrations(fixture, dir10);
assert.equal(fixture.pragma('user_version', { simple: true }), 10);
const caseId = fixture.prepare(
  "INSERT INTO cases(name,procedure,stage) VALUES ('张三诉李四合同纠纷（迁移测试）','一审','审理中')"
).run().lastInsertRowid;
const legacyCaseId = fixture.prepare(
  "INSERT INTO cases(name,procedure,stage) VALUES ('旧案弃置记忆（迁移测试）','一审','审理中')"
).run().lastInsertRowid;
const insertInbox = fixture.prepare(
  `INSERT INTO inbox(kind,payload,source,case_id,status,decided_at)
   VALUES ('task',?,'llm-suggest',?,?,?)`
);
const pendingId = insertInbox.run(JSON.stringify({ title: '核对材料' }), caseId, 'pending', '').lastInsertRowid;
const declinedId = insertInbox.run(JSON.stringify({ title: '联系法院' }), caseId, 'declined', '2026-07-18 10:00:00').lastInsertRowid;
insertInbox.run(JSON.stringify({ title: '联系法院' }), caseId, 'declined', '2026-07-19 10:00:00');
const legacyDeclinedA = insertInbox.run(
  JSON.stringify({ title: '联系法院询问进度' }), legacyCaseId, 'declined', '2026-07-18 10:00:00'
).lastInsertRowid;
const legacyDeclinedB = insertInbox.run(
  JSON.stringify({ title: '整理下一步材料' }), legacyCaseId, 'declined', '2026-07-19 10:00:00'
).lastInsertRowid;

const fileId = fixture.prepare(
  `INSERT INTO legalrag_files(case_id,rel_path,filename,file_size,mtime_ms,revision,sync_status)
   VALUES (?,'法院文书/示例.pdf','示例.pdf',10,1,1,'review')`
).run(caseId).lastInsertRowid;
const extractionId = fixture.prepare(
  `INSERT INTO legalrag_extractions(file_id,extractor,schema_version,status)
   VALUES (?,'test',1,'done')`
).run(fileId).lastInsertRowid;
const candidateId = fixture.prepare(
  `INSERT INTO legalrag_candidates(extraction_id,file_id,case_id,kind,payload,status)
   VALUES (?,?,?,'event',?,'declined')`
).run(extractionId, fileId, caseId,
  JSON.stringify({ type: 'judgment_served', occurred_on: '2026-07-10' })).lastInsertRowid;

runMigrations(fixture, dir11);
assert.equal(fixture.pragma('user_version', { simple: true }), 11);
assert.equal(fixture.prepare('SELECT status FROM inbox WHERE id=?').get(pendingId).status, 'pending');
assert.equal(fixture.prepare('SELECT status FROM inbox WHERE id=?').get(declinedId).status, 'declined');
assert.equal(fixture.prepare('SELECT content_key FROM inbox WHERE id=?').get(declinedId).content_key, '联系法院');
assert.equal(fixture.prepare('SELECT status FROM legalrag_candidates WHERE id=?').get(candidateId).status, 'declined');
assert.equal(fixture.prepare('SELECT fact_id FROM legalrag_candidates WHERE id=?').get(candidateId).fact_id, null);
assert.ok(fixture.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='legalrag_candidate_facts'"
).get());
assert.ok(fixture.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='llm_legacy_suppressions'"
).get());

const keyed = fixture.prepare(
  `INSERT INTO inbox(kind,payload,source,case_id,intent_key,state_fingerprint)
   VALUES ('task','{"title":"建议"}','llm-suggest',?,'v1:case.next_action','v1:same')`
);
keyed.run(caseId);
assert.throws(() => keyed.run(caseId), /UNIQUE constraint/);
assert.equal(fixture.pragma('integrity_check', { simple: true }), 'ok');
assert.deepEqual(fixture.pragma('foreign_key_check'), []);
fixture.close();

// 启动时语义 backfill：每一条旧 declined 进入独立 suppression，不伪造 state fingerprint；
// 改写标题的 next_action 仍被长期抑制。
const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import { backfillRecommendationMemory, enqueueLlmSuggestion } from './src/lib/recommendations.js';
  backfillRecommendationMemory();
  const result = enqueueLlmSuggestion({
    caseId: ${legacyCaseId},
    payload: { title: '换种说法继续推进本案', priority: 'normal', basis: '迁移回归' },
    recommendation: { intent: 'case.next_action' }
  }, 'test');
  process.stdout.write(JSON.stringify(result));
`], {
  cwd: root,
  env: { ...process.env, DB_PATH: path.join(scratch, 'fixture.db') },
  encoding: 'utf8',
});
assert.equal(child.status, 0, child.stderr);
assert.equal(JSON.parse(child.stdout).reason, 'legacy_declined');
const backfilled = new Database(path.join(scratch, 'fixture.db'));
assert.equal(backfilled.prepare(
  'SELECT COUNT(*) c FROM llm_legacy_suppressions WHERE case_id=?'
).get(legacyCaseId).c, 2);
for (const id of [legacyDeclinedA, legacyDeclinedB]) {
  const row = backfilled.prepare('SELECT intent_key,state_fingerprint FROM inbox WHERE id=?').get(id);
  assert.equal(row.intent_key, '');
  assert.equal(row.state_fingerprint, '');
}
backfilled.close();

const failingDir = path.join(scratch, 'failure');
copy(files10, failingDir);
fs.writeFileSync(
  path.join(failingDir, '011_llm_feedback_dedup.sql'),
  `${fs.readFileSync(path.join(migrationsDir, '011_llm_feedback_dedup.sql'), 'utf8')}\nTHIS IS INVALID SQL;\n`
);
const failing = new Database(path.join(scratch, 'failing.db'));
runMigrations(failing, dir10);
assert.throws(() => runMigrations(failing, failingDir), /near "THIS"|syntax error/i);
assert.equal(failing.pragma('user_version', { simple: true }), 10);
assert.equal(
  failing.prepare("SELECT 1 FROM pragma_table_info('inbox') WHERE name='intent_key'").get(),
  undefined
);
assert.equal(
  failing.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legalrag_candidate_facts'").get(),
  undefined
);
failing.close();

fs.rmSync(scratch, { recursive: true, force: true });
console.log('migration 011 tests: v10 preservation + recommendation uniqueness + atomic rollback passed');
