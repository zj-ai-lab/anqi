// 案齐文件桥：首轮只建基线；新文件排队；解析完成只生成候选，不直写正式表。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-legalrag-bridge-'));
const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-legalrag-outside-'));
process.env.ANJIAN_FILES_ROOT = root;
process.env.LEGALRAG_URL = 'http://legalrag.test';
process.env.LEGALRAG_INTERNAL_KEY = 'test-bridge-key';
process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';

const { db } = await import('../src/db.js');
const { DOCUMENT_EXTRACTOR } = await import('../src/lib/document-extractor.js');
const {
  pendingLegalRagCandidates,
  processLegalRagBridgeTick,
  queueCaseFile,
  reconcileLegalRagFiles,
  legalRagStateMap,
} = await import('../src/lib/legalrag-bridge.js');

const caseId = db.prepare(
  "INSERT INTO cases (name,procedure,stage) VALUES ('示例桥接案','一审','审理中')"
).run().lastInsertRowid;
const caseRoot = path.join(root, '示例桥接案', '法院文书');
fs.mkdirSync(caseRoot, { recursive: true });
fs.writeFileSync(path.join(caseRoot, '既有材料.txt'), '部署前已存在');
fs.writeFileSync(path.join(outsideRoot, '外部材料.txt'), '不得进入桥接');
fs.symlinkSync(path.join(outsideRoot, '外部材料.txt'), path.join(caseRoot, '外链材料.txt'));
fs.symlinkSync(outsideRoot, path.join(root, '示例桥接案', '外链目录'));

const baseline = reconcileLegalRagFiles();
assert.equal(baseline.baseline, true);
assert.equal(db.prepare("SELECT sync_status FROM legalrag_files WHERE rel_path='法院文书/既有材料.txt'").get().sync_status, 'observed');
assert.equal(db.prepare("SELECT COUNT(*) AS c FROM legalrag_files WHERE rel_path LIKE '%外链%'").get().c, 0,
  '符号链接文件和目录不得进入 LegalRAG reconciliation');
assert.throws(
  () => queueCaseFile(caseId, '法院文书/外链材料.txt'),
  (error) => error?.code === 'symlink',
  '直接排队符号链接文件也必须失败'
);
const steadyChanges = db.prepare('SELECT total_changes() AS c').get().c;
const steady = reconcileLegalRagFiles();
assert.equal(steady.queued, 0);
assert.equal(
  db.prepare('SELECT total_changes() AS c').get().c,
  steadyChanges,
  '未变化的 reconciliation 不得制造 SQLite 写放大'
);

fs.writeFileSync(path.join(caseRoot, '新合同.txt'), '委托合同收费条款');
const discovered = reconcileLegalRagFiles();
assert.equal(discovered.queued, 1, '基线后新增文件应自动排队');
let file = db.prepare("SELECT * FROM legalrag_files WHERE rel_path='法院文书/新合同.txt'").get();
const same = queueCaseFile(caseId, '法院文书/新合同.txt');
assert.equal(same.id, file.id, '同一文件重复发现不新增 revision');

// 旧版遗留的待确认来源只能在新 schema 成功后退出；失败时不得先删旧候选。
const legacyExtractionId = db.prepare(
  `INSERT INTO legalrag_extractions
    (file_id,extractor,schema_version,model,status,document_type,raw_json,finished_at)
   VALUES (?,'legalrag-typed-v1',1,'legacy-model','done','court_document','{}',datetime('now','+8 hours'))`
).run(file.id).lastInsertRowid;
const legacyFactId = db.prepare(
  `INSERT INTO legalrag_candidate_facts(case_id,kind,fact_key,canonical_payload)
   VALUES (?,'event','legacy-noise',?)`
).run(caseId, JSON.stringify({
  type: 'hearing', occurred_on: '2026-06-01', service_method: '', instrument: '被引用的他案文书', note: '',
})).lastInsertRowid;
const legacyCandidateId = db.prepare(
  `INSERT INTO legalrag_candidates
    (extraction_id,file_id,case_id,kind,payload,confidence,source_page,source_quote,fact_id)
   VALUES (?,?,?,'event',?,0.99,1,'检索报告引用：某案开庭日期',?)`
).run(
  legacyExtractionId, file.id, caseId,
  JSON.stringify({ type: 'hearing', occurred_on: '2026-06-01', service_method: '', instrument: '被引用的他案文书', note: '' }),
  legacyFactId
).lastInsertRowid;

// 旧版 ready 代表没有待确认来源；v2 发布不得为了补分类而把它们全量送入模型。
const legacyReadyFileId = db.prepare(
  `INSERT INTO legalrag_files
    (case_id,rel_path,filename,revision,sync_status,legalrag_document_id)
   VALUES (?,'法院文书/旧版无候选.txt','旧版无候选.txt',1,'ready','lr-doc-legacy-ready')`
).run(caseId).lastInsertRowid;
db.prepare(
  `INSERT INTO legalrag_extractions
    (file_id,extractor,schema_version,model,status,document_type,raw_json,finished_at)
   VALUES (?,'legalrag-typed-v1',1,'legacy-model','done','other','{}',datetime('now','+8 hours'))`
).run(legacyReadyFileId);

const calls = [];
global.fetch = async (url, options = {}) => {
  calls.push(String(url));
  if (String(url).endsWith('/api/v1/integrations/documents/register')) {
    const body = JSON.parse(options.body);
    assert.equal(body.case_name, '示例桥接案');
    assert([
      '法院文书/新合同.txt',
      '法院文书/合同副本.txt',
      '法院文书/类案检索报告.txt',
      '法院文书/预存收费合同.txt',
      '法院文书/预存收费合同副本.txt',
    ].includes(body.relative_path));
    if (body.relative_path === '法院文书/类案检索报告.txt') {
      return new Response(JSON.stringify({
        status: 'ready', duplicate: false, case_id: 'lr-case-1', document_id: 'lr-doc-report',
        checksum: 'report123', source_revision: 1, job: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (body.relative_path.includes('预存收费合同')) {
      return new Response(JSON.stringify({
        status: 'ready', duplicate: true, case_id: 'lr-case-1', document_id: 'lr-doc-prelinked',
        checksum: 'prelinked123', source_revision: 1, job: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      status: 'ready', duplicate: true, case_id: 'lr-case-1', document_id: 'lr-doc-1',
      checksum: 'abc123', source_revision: 1, job: null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (String(url).endsWith('/api/v1/integrations/documents/lr-doc-1')) {
    return new Response(JSON.stringify({
      document_id: 'lr-doc-1', file_name: '新合同.txt', ocr_status: 'done',
      ocr_text: '--- 第 3 页 ---\n律师费于签约日支付。', ingested_at: '2026-01-01 00:00:00',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (String(url).endsWith('/api/v1/integrations/documents/lr-doc-prelinked')) {
    return new Response(JSON.stringify({
      document_id: 'lr-doc-prelinked', file_name: '预存收费合同.txt', ocr_status: 'done',
      ocr_text: '--- 第 2 页 ---\n预存顾问费于收到材料后支付。', ingested_at: '2026-01-01 00:00:00',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (String(url).endsWith('/api/v1/integrations/documents/lr-doc-report')) {
    return new Response(JSON.stringify({
      document_id: 'lr-doc-report', file_name: '类案检索报告.txt', ocr_status: 'done',
      ocr_text: '类案检索报告\n检索结果一：某法院判决记载二〇二六年六月一日开庭。',
      ingested_at: '2026-01-01 00:00:00',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (String(url).endsWith('/api/v1/integrations/documents/lr-doc-fail')) {
    return new Response(JSON.stringify({
      document_id: 'lr-doc-fail', file_name: '模型失败材料.txt', ocr_status: 'done',
      ocr_text: '模拟模型失败，但旧候选必须保留。', ingested_at: '2026-01-01 00:00:00',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (String(url) === 'https://api.deepseek.com/chat/completions') {
    const request = JSON.parse(options.body);
    const userText = request.messages.find((message) => message.role === 'user')?.content || '';
    if (userText.includes('模拟模型失败')) {
      return new Response('temporary upstream failure', { status: 500 });
    }
    if (userText.includes('预存顾问费')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        document_role: 'retainer_agreement',
        case_relation: 'direct',
        evidence_mode: 'primary_source',
        screening_reason: '本案委托合同',
        matched_case_markers: ['案件名称一致'],
        candidates: [{
          kind: 'fee', evidence_relation: 'direct', confidence: 0.99, source_page: 2,
          source_quote: '预存顾问费于收到材料后支付。',
          payload: { label: '预存顾问费', amount: '4200.00', node: '收到材料后', due_on: '', note: '' },
        }],
      }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (userText.includes('类案检索报告')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        document_role: 'search_report',
        case_relation: 'direct',
        evidence_mode: 'quoted_reference',
        screening_reason: '材料是类案检索报告，日期来自引用案例',
        candidates: [{
          kind: 'event', evidence_relation: 'direct', confidence: 0.99, source_page: 1,
          source_quote: '某法院判决记载二〇二六年六月一日开庭。',
          payload: { type: 'hearing', occurred_on: '2026-06-01', service_method: '', instrument: '引用案例', note: '' },
        }],
      }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      document_role: 'retainer_agreement',
      case_relation: 'direct',
      evidence_mode: 'primary_source',
      screening_reason: '本案委托合同',
      matched_case_markers: ['案件名称一致'],
      candidates: [{
        kind: 'fee', evidence_relation: 'direct', confidence: 0.98, source_page: 3,
        source_quote: '律师费于签约日支付。',
        payload: { label: '一审代理费', amount: '1000.00', node: '签约日支付', due_on: '', note: '' },
      }],
    }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`unexpected fetch: ${url}`);
};

await processLegalRagBridgeTick();
assert.equal(db.prepare(
  'SELECT COUNT(*) AS c FROM legalrag_extractions WHERE file_id=? AND extractor=?'
).get(legacyReadyFileId, DOCUMENT_EXTRACTOR).c, 0,
  '旧版 ready 文件没有待确认噪音，不得自动触发 v2 模型调用');
file = db.prepare('SELECT * FROM legalrag_files WHERE id=?').get(file.id);
assert.equal(file.sync_status, 'review');
assert.equal(file.legalrag_document_id, 'lr-doc-1');
assert.equal(file.content_checksum, 'abc123');
const candidates = pendingLegalRagCandidates(caseId);
assert.equal(candidates.length, 1);
assert.equal(candidates[0].kind, 'fee');
assert.equal(candidates[0].source_page, 3);
const screenedState = legalRagStateMap(caseId).get('法院文书/新合同.txt');
assert.equal(screenedState.case_relation, 'direct');
assert.equal(screenedState.evidence_mode, 'primary_source');
assert.equal(screenedState.screening_decision, 'eligible');
assert.equal(
  db.prepare('SELECT status FROM legalrag_candidates WHERE id=?').get(legacyCandidateId).status,
  'superseded',
  '新 schema 成功后旧 extractor 的未裁决噪音来源必须退出候选队列'
);
assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fee_items WHERE case_id=?').get(caseId).c, 0,
  'LLM 提取后不得自动写正式费用表');
assert(calls.some((url) => url.includes('/documents/register')));
assert(calls.some((url) => url === 'https://api.deepseek.com/chat/completions'));

fs.writeFileSync(path.join(caseRoot, '类案检索报告.txt'), '类案检索报告');
assert.equal(reconcileLegalRagFiles().queued, 1);
await processLegalRagBridgeTick();
const reportFile = db.prepare(
  "SELECT * FROM legalrag_files WHERE rel_path='法院文书/类案检索报告.txt' ORDER BY revision DESC LIMIT 1"
).get();
assert.equal(reportFile.sync_status, 'ready', '模型筛除的检索报告应结束处理而不是占用人工队列');
assert.equal(db.prepare(
  "SELECT COUNT(*) AS c FROM legalrag_candidates WHERE file_id=? AND status='pending'"
).get(reportFile.id).c, 0, '检索报告即使夹带形状合法的事件也不得生成候选');
const reportExtraction = db.prepare(
  'SELECT raw_json FROM legalrag_extractions WHERE file_id=? AND extractor=?'
).get(reportFile.id, DOCUMENT_EXTRACTOR);
assert.equal(JSON.parse(reportExtraction.raw_json).screening_decision, 'filtered');
assert.equal(legalRagStateMap(caseId).get('法院文书/类案检索报告.txt').screening_decision, 'filtered');

fs.appendFileSync(path.join(caseRoot, '新合同.txt'), '\n第二版');
const future = new Date(Date.now() + 2000);
fs.utimesSync(path.join(caseRoot, '新合同.txt'), future, future);
const revised = reconcileLegalRagFiles();
assert.equal(revised.queued, 1, '同一路径新内容应追加 revision');
const revisions = db.prepare(
  "SELECT id,revision,sync_status FROM legalrag_files WHERE rel_path='法院文书/新合同.txt' ORDER BY revision"
).all();
assert.equal(revisions.length, 2);
assert.equal(revisions[0].sync_status, 'ignored', '旧 revision 不得继续占用处理状态');
assert.equal(revisions[1].sync_status, 'queued');
assert.equal(
  db.prepare('SELECT status FROM legalrag_candidates WHERE file_id=?').get(revisions[0].id).status,
  'superseded',
  '旧 revision 的待确认候选必须自动退出人工队列'
);
assert.equal(pendingLegalRagCandidates(caseId).length, 0, '旧 revision 候选不得继续显示');

// 逻辑事实已经人工弃置后，同路径新 revision 与另一份文件都只保留证据，不再浮出 review。
const oldCandidate = db.prepare(
  `SELECT c.id,c.fact_id FROM legalrag_candidates c
    JOIN legalrag_extractions e ON e.id=c.extraction_id
   WHERE c.file_id=? AND e.extractor=?`
).get(revisions[0].id, DOCUMENT_EXTRACTOR);
db.prepare(
  `UPDATE legalrag_candidate_facts SET status='declined',decided_at=datetime('now','+8 hours') WHERE id=?`
).run(oldCandidate.fact_id);
fs.writeFileSync(path.join(caseRoot, '合同副本.txt'), '委托合同收费条款');
const duplicateDiscovered = reconcileLegalRagFiles();
assert.equal(duplicateDiscovered.queued, 1);
await processLegalRagBridgeTick(); // 先处理较早入队的原路径 revision 2
await processLegalRagBridgeTick(); // 再处理另一份文件
const inheritedRows = db.prepare(
  `SELECT c.status,f.sync_status,f.rel_path
     FROM legalrag_candidates c JOIN legalrag_files f ON f.id=c.file_id
    WHERE c.fact_id=? AND f.id<>? ORDER BY f.id`
).all(oldCandidate.fact_id, revisions[0].id);
assert.equal(inheritedRows.length, 2);
assert(inheritedRows.every((row) => row.status === 'declined'), '新来源必须继承弃置裁决');
assert(inheritedRows.every((row) => row.sync_status === 'ready'), '无 pending fact 的文件不得停在 review');
assert.equal(pendingLegalRagCandidates(caseId).length, 0, '跨 revision/跨文件弃置不得重新出现');

// 正式收费早于候选存在：strict unique 只关联事实，不写/改正式表，也不进入 review。
const prelinkedFeeId = db.prepare(
  `INSERT INTO fee_items(case_id,label,amount,amount_fen,node,due_on,note)
   VALUES (?,'预存顾问费',4200,420000,'收到材料后','','人工预先录入')`
).run(caseId).lastInsertRowid;
const prelinkedBefore = db.prepare('SELECT * FROM fee_items WHERE id=?').get(prelinkedFeeId);
fs.writeFileSync(path.join(caseRoot, '预存收费合同.txt'), '预存顾问费合同');
assert.equal(reconcileLegalRagFiles().queued, 1);
await processLegalRagBridgeTick();
const prelinkedFile = db.prepare(
  "SELECT * FROM legalrag_files WHERE rel_path='法院文书/预存收费合同.txt' ORDER BY revision DESC LIMIT 1"
).get();
const prelinkedSource = db.prepare(
  "SELECT * FROM legalrag_candidates WHERE file_id=? AND kind='fee'"
).get(prelinkedFile.id);
const prelinkedFact = db.prepare(
  'SELECT * FROM legalrag_candidate_facts WHERE id=?'
).get(prelinkedSource.fact_id);
assert.equal(prelinkedFile.sync_status, 'ready');
assert.equal(prelinkedSource.status, 'accepted');
assert.equal(prelinkedSource.accepted_entity_id, prelinkedFeeId);
assert.equal(prelinkedFact.status, 'accepted');
assert.equal(prelinkedFact.accepted_entity_id, prelinkedFeeId);
assert.deepEqual(db.prepare('SELECT * FROM fee_items WHERE id=?').get(prelinkedFeeId), prelinkedBefore,
  '系统预关联不得改变正式收费字段或版本');
assert.equal(pendingLegalRagCandidates(caseId).length, 0);
assert.equal(db.prepare(
  "SELECT COUNT(*) AS c FROM audit_log WHERE action='legalrag-prelink-exact' AND entity_id=?"
).get(prelinkedFact.id).c, 1, 'strict unique 事实只写一次系统预关联审计');

// 新文件再次提取同一事实：继承 accepted alias，不重复建账、不重新进入 review。
fs.writeFileSync(path.join(caseRoot, '预存收费合同副本.txt'), '同一预存顾问费合同副本');
assert.equal(reconcileLegalRagFiles().queued, 1);
await processLegalRagBridgeTick();
const prelinkedCopy = db.prepare(
  "SELECT * FROM legalrag_files WHERE rel_path='法院文书/预存收费合同副本.txt' ORDER BY revision DESC LIMIT 1"
).get();
const inheritedAccepted = db.prepare(
  "SELECT * FROM legalrag_candidates WHERE file_id=? AND kind='fee'"
).get(prelinkedCopy.id);
assert.equal(inheritedAccepted.fact_id, prelinkedFact.id);
assert.equal(inheritedAccepted.status, 'accepted');
assert.equal(inheritedAccepted.accepted_entity_id, prelinkedFeeId);
assert.equal(prelinkedCopy.sync_status, 'ready');
assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fee_items WHERE id=?').get(prelinkedFeeId).c, 1);
assert.equal(pendingLegalRagCandidates(caseId).length, 0);

// v10 语义 backfill：继承裁决后要清掉假的 review，但不能覆盖 missing 等文件生命周期。
const { backfillCandidateFacts, ensureCandidateFact } = await import('../src/lib/candidate-facts.js');
const backfillPayload = { type: 'other', occurred_on: '2026-07-15', service_method: '', instrument: '示例通知', note: '' };
const backfillFact = ensureCandidateFact(caseId, 'event', backfillPayload);
db.prepare(
  "UPDATE legalrag_candidate_facts SET status='declined',decision_reason='测试忽略' WHERE id=?"
).run(backfillFact.id);
const insertBackfillSource = (relPath, status) => {
  const sourceFileId = db.prepare(
    `INSERT INTO legalrag_files(case_id,rel_path,filename,revision,sync_status)
     VALUES (?,?,?,1,?)`
  ).run(caseId, relPath, path.basename(relPath), status).lastInsertRowid;
  const sourceExtractionId = db.prepare(
    "INSERT INTO legalrag_extractions(file_id,extractor,schema_version,status) VALUES (?,'test-backfill',1,'done')"
  ).run(sourceFileId).lastInsertRowid;
  const sourceCandidateId = db.prepare(
    `INSERT INTO legalrag_candidates
      (extraction_id,file_id,case_id,kind,payload,source_quote,fact_id,status)
     VALUES (?,?,?,'event',?,'示例原文',?,'pending')`
  ).run(sourceExtractionId, sourceFileId, caseId, JSON.stringify(backfillPayload), backfillFact.id).lastInsertRowid;
  return { sourceFileId, sourceCandidateId };
};
const reviewSource = insertBackfillSource('法院文书/待回填状态.txt', 'review');
const missingSource = insertBackfillSource('法院文书/已删除来源.txt', 'missing');
backfillCandidateFacts();
assert.equal(db.prepare('SELECT status FROM legalrag_candidates WHERE id=?').get(reviewSource.sourceCandidateId).status, 'declined');
assert.equal(db.prepare('SELECT sync_status FROM legalrag_files WHERE id=?').get(reviewSource.sourceFileId).sync_status, 'ready',
  'backfill 后没有 pending fact 的 review 文件必须回到 ready');
assert.equal(db.prepare('SELECT sync_status FROM legalrag_files WHERE id=?').get(missingSource.sourceFileId).sync_status, 'missing',
  '候选状态刷新不得覆盖 missing/failed/ignored 等文件生命周期');

// 状态漂移容错：有 pending 来源的旧版 ready 仍应进入重筛；模型缺失时必须保留 review 入口。
const driftPayload = {
  type: 'hearing', occurred_on: '2026-09-01', service_method: '', instrument: '待重筛示例', note: '',
};
const driftFact = ensureCandidateFact(caseId, 'event', driftPayload);
const driftFileId = db.prepare(
  `INSERT INTO legalrag_files
    (case_id,rel_path,filename,revision,sync_status,legalrag_document_id)
   VALUES (?,'法院文书/状态漂移材料.txt','状态漂移材料.txt',1,'ready','lr-doc-drift')`
).run(caseId).lastInsertRowid;
const driftExtractionId = db.prepare(
  `INSERT INTO legalrag_extractions
    (file_id,extractor,schema_version,status,document_type,raw_json,finished_at)
   VALUES (?,'legalrag-typed-v1',1,'done','court_document','{}',datetime('now','+8 hours'))`
).run(driftFileId).lastInsertRowid;
db.prepare(
  `INSERT INTO legalrag_candidates
    (extraction_id,file_id,case_id,kind,payload,confidence,source_quote,fact_id)
   VALUES (?,?,?,'event',?,0.95,'待重筛示例原文',?)`
).run(driftExtractionId, driftFileId, caseId, JSON.stringify(driftPayload), driftFact.id);
delete process.env.DEEPSEEK_API_KEY;
await processLegalRagBridgeTick();
process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
const driftState = db.prepare('SELECT sync_status,last_error FROM legalrag_files WHERE id=?').get(driftFileId);
assert.equal(driftState.sync_status, 'review', '模型缺失时有 pending 的文件不得变 ready 并隐藏候选入口');
assert.match(driftState.last_error, /未配置文书提取模型/);
assert.equal(db.prepare(
  'SELECT status FROM legalrag_candidates WHERE file_id=?'
).get(driftFileId).status, 'pending', '重筛未成功时旧候选必须保留');
db.prepare("UPDATE legalrag_files SET sync_status='ignored' WHERE id=?").run(driftFileId);

// 真正进入 v2 后上游失败，也必须先保住旧 pending 来源，不能先删后筛。
const failedPayload = {
  type: 'other', occurred_on: '2026-09-02', service_method: '', instrument: '旧候选示例', note: '',
};
const failedFact = ensureCandidateFact(caseId, 'event', failedPayload);
const failedFileId = db.prepare(
  `INSERT INTO legalrag_files
    (case_id,rel_path,filename,revision,sync_status,legalrag_document_id)
   VALUES (?,'法院文书/模型失败材料.txt','模型失败材料.txt',1,'review','lr-doc-fail')`
).run(caseId).lastInsertRowid;
const failedLegacyExtraction = db.prepare(
  `INSERT INTO legalrag_extractions
    (file_id,extractor,schema_version,status,document_type,raw_json,finished_at)
   VALUES (?,'legalrag-typed-v1',1,'done','court_document','{}',datetime('now','+8 hours'))`
).run(failedFileId).lastInsertRowid;
const failedLegacyCandidate = db.prepare(
  `INSERT INTO legalrag_candidates
    (extraction_id,file_id,case_id,kind,payload,confidence,source_quote,fact_id)
   VALUES (?,?,?,'event',?,0.95,'旧候选示例原文',?)`
).run(failedLegacyExtraction, failedFileId, caseId, JSON.stringify(failedPayload), failedFact.id).lastInsertRowid;
await processLegalRagBridgeTick();
assert.equal(db.prepare('SELECT sync_status FROM legalrag_files WHERE id=?').get(failedFileId).sync_status, 'failed');
assert.equal(db.prepare('SELECT status FROM legalrag_candidates WHERE id=?').get(failedLegacyCandidate).status, 'pending',
  'v2 上游失败时旧 pending 来源不得被 supersede');
assert.equal(db.prepare(
  'SELECT status FROM legalrag_extractions WHERE file_id=? AND extractor=?'
).get(failedFileId, DOCUMENT_EXTRACTOR).status, 'failed');

db.close();
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(outsideRoot, { recursive: true, force: true });
console.log('legalrag bridge tests: baseline + revision lifecycle + inherited fact decisions passed');
