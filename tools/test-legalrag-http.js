// 文书候选 HTTP：人工确认、既有事实认领、事件派生与拒绝路径。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { db } from '../src/db.js';

const port = 39774;
const base = `http://127.0.0.1:${port}`;
const caseId = db.prepare(
  "INSERT INTO cases (name,procedure,stage) VALUES ('张三诉李四合同纠纷（候选测试）','一审','审理中')"
).run().lastInsertRowid;
const feeId = db.prepare(
  "INSERT INTO fee_items (case_id,label,amount,amount_fen,node,due_on) VALUES (?,'一审代理费',1000,100000,'签约日支付','')"
).run(caseId).lastInsertRowid;
const aliasFeeId = db.prepare(
  "INSERT INTO fee_items (case_id,label,amount,amount_fen,node,due_on) VALUES (?,'既有阶段收费',2000,200000,'收案后','')"
).run(caseId).lastInsertRowid;
const ambiguousFeeIds = [1, 2].map(() => db.prepare(
  "INSERT INTO fee_items (case_id,label,amount,amount_fen,node,due_on) VALUES (?,'二审代理费',3000,300000,'立案后','')"
).run(caseId).lastInsertRowid);
const maxSafeFeeId = db.prepare(
  "INSERT INTO fee_items (case_id,label,amount,amount_fen,node,due_on) VALUES (?,'极值代理费',?,?,'签约后','')"
).run(caseId, 90071992547409.9, Number.MAX_SAFE_INTEGER).lastInsertRowid;
const fileId = db.prepare(
  `INSERT INTO legalrag_files
    (case_id,rel_path,filename,file_size,mtime_ms,revision,sync_status,legalrag_document_id)
   VALUES (?,'立案材料/委托合同.pdf','委托合同.pdf',100,1,1,'review','lr-doc')`
).run(caseId).lastInsertRowid;
const extractionId = db.prepare(
  `INSERT INTO legalrag_extractions
    (file_id,extractor,schema_version,model,status,document_type,raw_json,finished_at)
   VALUES (?,'test',1,'test-model','done','retainer_agreement','{}',datetime('now','+8 hours'))`
).run(fileId).lastInsertRowid;
const feeCandidate = db.prepare(
  `INSERT INTO legalrag_candidates
    (extraction_id,file_id,case_id,kind,payload,confidence,source_page,source_quote)
   VALUES (?,?,?,'fee',?,0.99,3,'一审代理费于签约日支付')`
).run(
  extractionId, fileId, caseId,
  JSON.stringify({ label: '一审代理费', amount: '1000.00', node: '签约日支付', due_on: '', note: '' })
).lastInsertRowid;
const aliasPayload = { label: '合同首期费用', amount: '2000.00', node: '签约后', due_on: '', note: '' };
const aliasCandidate = db.prepare(
  `INSERT INTO legalrag_candidates
    (extraction_id,file_id,case_id,kind,payload,confidence,source_page,source_quote)
   VALUES (?,?,?,'fee',?,0.97,4,'合同首期费用于签约后支付')`
).run(extractionId, fileId, caseId, JSON.stringify(aliasPayload)).lastInsertRowid;
const ambiguousPayload = { label: '二审代理费', amount: '3000.00', node: '立案后', due_on: '', note: '' };
const ambiguousCandidate = db.prepare(
  `INSERT INTO legalrag_candidates
    (extraction_id,file_id,case_id,kind,payload,confidence,source_page,source_quote)
   VALUES (?,?,?,'fee',?,0.95,4,'二审代理费于立案后支付')`
).run(extractionId, fileId, caseId, JSON.stringify(ambiguousPayload)).lastInsertRowid;
const maxSafePayload = {
  label: '极值代理费', amount: '90071992547409.91', node: '签约后', due_on: '', note: '',
};
const maxSafeCandidate = db.prepare(
  `INSERT INTO legalrag_candidates
    (extraction_id,file_id,case_id,kind,payload,confidence,source_page,source_quote)
   VALUES (?,?,?,'fee',?,0.92,4,'极值代理费于签约后支付')`
).run(extractionId, fileId, caseId, JSON.stringify(maxSafePayload)).lastInsertRowid;
const historicalDeclinedPayload = {
  label: '既有阶段收费', amount: '2000.00', node: '收案后', due_on: '', note: '',
};
const historicalDeclinedCandidate = db.prepare(
  `INSERT INTO legalrag_candidates
    (extraction_id,file_id,case_id,kind,payload,confidence,source_page,source_quote,status,decided_at)
   VALUES (?,?,?,'fee',?,0.93,4,'既有阶段收费于收案后支付','declined',datetime('now','+8 hours'))`
).run(extractionId, fileId, caseId, JSON.stringify(historicalDeclinedPayload)).lastInsertRowid;
const eventCandidate = db.prepare(
  `INSERT INTO legalrag_candidates
    (extraction_id,file_id,case_id,kind,payload,confidence,source_page,source_quote)
   VALUES (?,?,?,'event',?,0.96,5,'判决书于二〇二六年七月十日送达')`
).run(
  extractionId, fileId, caseId,
  JSON.stringify({ type: 'judgment_served', occurred_on: '2026-07-10', service_method: '直接送达', instrument: '示例判决书', note: '' })
).lastInsertRowid;
const duplicateFileId = db.prepare(
  `INSERT INTO legalrag_files
    (case_id,rel_path,filename,file_size,mtime_ms,revision,sync_status,legalrag_document_id)
   VALUES (?,'客户沟通/送达回执.pdf','送达回执.pdf',80,2,1,'review','lr-doc-2')`
).run(caseId).lastInsertRowid;
const duplicateExtractionId = db.prepare(
  `INSERT INTO legalrag_extractions
    (file_id,extractor,schema_version,model,status,document_type,raw_json,finished_at)
   VALUES (?,'test',1,'test-model','done','court_document','{}',datetime('now','+8 hours'))`
).run(duplicateFileId).lastInsertRowid;
const duplicateEventCandidate = db.prepare(
  `INSERT INTO legalrag_candidates
    (extraction_id,file_id,case_id,kind,payload,confidence,source_page,source_quote)
   VALUES (?,?,?,'event',?,0.91,1,'送达日期为二〇二六年七月十日')`
).run(
  duplicateExtractionId, duplicateFileId, caseId,
  JSON.stringify({ type: 'judgment_served', occurred_on: '2026-07-10', service_method: '邮寄', instrument: '示例送达回执', note: '' })
).lastInsertRowid;
const declineCandidate = db.prepare(
  `INSERT INTO legalrag_candidates
    (extraction_id,file_id,case_id,kind,payload,confidence,source_page,source_quote)
   VALUES (?,?,?,'fee',?,0.5,6,'疑似收费条款')`
).run(
  extractionId, fileId, caseId,
  JSON.stringify({ label: '待核条款', amount: null, node: '', due_on: '', note: '' })
).lastInsertRowid;

const otherCaseId = db.prepare(
  "INSERT INTO cases (name,procedure,stage) VALUES ('王五示例案','一审','审理中')"
).run().lastInsertRowid;
const otherCaseFeeId = db.prepare(
  "INSERT INTO fee_items (case_id,label,amount,amount_fen,node,due_on) VALUES (?,'其他案件收费',3000,300000,'立案后','')"
).run(otherCaseId).lastInsertRowid;

const child = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    ANJIAN_UNSAFE_NO_AUTH: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk; });
child.stderr.on('data', (chunk) => { logs += chunk; });

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(base + '/healthz');
      if (response.ok) return;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start\n${logs}`);
}

async function post(route, body = {}) {
  return fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

try {
  await waitReady();
  let listResponse = await fetch(`${base}/api/cases/${caseId}/legalrag/candidates`);
  assert.equal(listResponse.status, 200);
  let listed = await listResponse.json();
  const groupedEvent = listed.find((candidate) => candidate.kind === 'event');
  assert.equal(groupedEvent.source_count, 2, '两份文件的同一事件必须合成一张卡');
  assert.equal(groupedEvent.file_count, 2, '材料份数与引文条数必须分别统计');
  assert.equal(groupedEvent.sources.length, 2, '合并不能丢失任一份引文证据');

  const candidateFacts = await import('../src/lib/candidate-facts.js');
  const exactFact = db.prepare(
    `SELECT f.* FROM legalrag_candidates c
      JOIN legalrag_candidate_facts f ON f.id=c.fact_id WHERE c.id=?`
  ).get(feeCandidate);
  assert.equal(exactFact.status, 'accepted', 'strict unique 既有收费应在进入 review 前自动关联');
  assert.equal(exactFact.accepted_entity_id, feeId);
  assert.equal(listed.some((candidate) => candidate.id === feeCandidate), false,
    '自动关联的严格重复不得进入待确认列表');
  const maxSafeFact = db.prepare(
    `SELECT f.* FROM legalrag_candidates c
      JOIN legalrag_candidate_facts f ON f.id=c.fact_id WHERE c.id=?`
  ).get(maxSafeCandidate);
  assert.equal(maxSafeFact.status, 'accepted',
    '正式收费匹配必须使用权威 amount_fen，不能被 REAL 展示投影舍入影响');
  assert.equal(maxSafeFact.accepted_entity_id, maxSafeFeeId);
  assert.equal(listed.some((candidate) => candidate.id === maxSafeCandidate), false,
    '整数分极值的严格重复不得进入待确认列表');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fee_items WHERE case_id=?').get(caseId).c, 5,
    '系统预关联不得新增或修改正式收费');
  const historicalDeclinedFact = db.prepare(
    `SELECT f.* FROM legalrag_candidates c
      JOIN legalrag_candidate_facts f ON f.id=c.fact_id WHERE c.id=?`
  ).get(historicalDeclinedCandidate);
  assert.equal(historicalDeclinedFact.status, 'declined',
    '旧版人工 declined 必须先于 strict unique 回填，不能被系统改成 accepted');
  assert.equal(historicalDeclinedFact.accepted_entity_id, null);
  assert.equal(listed.some((candidate) => candidate.id === historicalDeclinedCandidate), false);
  assert.equal(candidateFacts.ensureCandidateFact(caseId, 'fee', historicalDeclinedPayload).status, 'declined',
    '历史人工拒绝必须继续压住未来相同来源');

  let response = await post(`/api/legalrag/candidates/${feeCandidate}/accept`);
  assert.equal(response.status, 409, '系统预关联后候选不得再次裁决');

  const ambiguousListed = listed.find((candidate) => candidate.id === ambiguousCandidate);
  assert.equal(ambiguousListed.formal_fee_match.state, 'ambiguous');
  assert.equal(ambiguousListed.formal_fee_match.matches.length, 2,
    '多条 strict exact 正式收费必须保留歧义，不能任选第一条');
  response = await post(`/api/legalrag/candidates/${ambiguousCandidate}/link-fee`, {
    fee_item_id: otherCaseFeeId,
  });
  assert.equal(response.status, 400, '显式关联不得跨案件');
  assert.equal(db.prepare('SELECT status FROM legalrag_candidates WHERE id=?').get(ambiguousCandidate).status, 'pending');
  response = await post(`/api/legalrag/candidates/${ambiguousCandidate}/accept`);
  assert.equal(response.status, 409, '普通接受遇到多条 exact 正式收费必须拒绝');
  let payload = await response.json();
  assert.equal(payload.code, 'fee_exact_match_ambiguous');
  assert.equal(payload.matches.length, 2);
  response = await post(`/api/legalrag/candidates/${ambiguousCandidate}/link-fee`, {
    fee_item_id: ambiguousFeeIds[1],
  });
  assert.equal(response.status, 200);
  payload = await response.json();
  assert.equal(payload.linked.id, ambiguousFeeIds[1]);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fee_items WHERE case_id=?').get(caseId).c, 5);

  const aliasKey = candidateFacts.candidateFactKey('fee', aliasPayload);
  response = await post(`/api/legalrag/candidates/${aliasCandidate}/link-fee`, { fee_item_id: aliasFeeId });
  assert.equal(response.status, 200);
  payload = await response.json();
  assert.equal(payload.linked.id, aliasFeeId);
  const linkedAlias = db.prepare(
    'SELECT * FROM legalrag_candidate_facts WHERE case_id=? AND kind=? AND fact_key=?'
  ).get(caseId, 'fee', aliasKey);
  assert.equal(linkedAlias.status, 'accepted');
  assert.equal(linkedAlias.accepted_entity_id, aliasFeeId);
  assert.equal(candidateFacts.ensureCandidateFact(caseId, 'fee', { ...aliasPayload, note: '另一来源' }).accepted_entity_id, aliasFeeId,
    '人工建立的原始 fact alias 必须被未来来源继承');
  const editResponse = await fetch(`${base}/api/fees/${aliasFeeId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: '人工改名后的阶段收费', node: '收到材料后' }),
  });
  assert.equal(editResponse.status, 200);
  assert.equal(candidateFacts.ensureCandidateFact(caseId, 'fee', aliasPayload).accepted_entity_id, aliasFeeId,
    '正式收费后续编辑不得重算或改绑既有 alias');

  const deleteResponse = await fetch(`${base}/api/fees/${feeId}`, { method: 'DELETE' });
  assert.equal(deleteResponse.status, 200);
  assert.equal(db.prepare('SELECT status FROM legalrag_candidate_facts WHERE id=?').get(exactFact.id).status, 'declined',
    '正式收费删除必须在同一请求内撤回 alias，不等待下一次提取');
  const withdrawnFee = candidateFacts.ensureCandidateFact(caseId, 'fee', {
    label: '一审代理费', amount: '1000.00', node: '签约日支付', due_on: '', note: '',
  });
  assert.equal(withdrawnFee.status, 'declined', '正式记录删除后应成为可撤销的负反馈');
  assert.equal(db.prepare('SELECT status FROM legalrag_candidates WHERE id=?').get(feeCandidate).status, 'declined');
  assert.equal(db.prepare('SELECT accepted_entity_id FROM legalrag_candidates WHERE id=?').get(feeCandidate).accepted_entity_id, null,
    '正式记录删除后不得留下 candidate 悬空链接');

  response = await post(`/api/legalrag/candidates/${eventCandidate}/accept`, {
    payload: { occurred_on: '2026-07-11' },
  });
  assert.equal(response.status, 200);
  payload = await response.json();
  assert.equal(payload.created.entity, 'event');
  assert.equal(payload.created.linked_existing, false);
  assert.equal(payload.created.source_count, 2);
  assert.equal(db.prepare('SELECT status FROM legalrag_candidates WHERE id=?').get(duplicateEventCandidate).status, 'accepted');
  assert.equal(db.prepare('SELECT accepted_entity_id FROM legalrag_candidates WHERE id=?').get(duplicateEventCandidate).accepted_entity_id, payload.created.id);
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(payload.created.id);
  assert.equal(event.type, 'judgment_served');
  assert.equal(event.occurred_on, '2026-07-11');
  assert.equal(
    db.prepare('SELECT fact_key FROM legalrag_candidate_facts WHERE id=?').get(payload.created.fact_id).fact_key,
    candidateFacts.candidateFactKey('event', {
      type: 'judgment_served', occurred_on: '2026-07-11', service_method: '直接送达', instrument: '示例判决书', note: '',
    }),
    '人工修改身份字段后必须按修正后的 identity 归并'
  );
  assert.equal(candidateFacts.ensureCandidateFact(caseId, 'event', {
    type: 'judgment_served', occurred_on: '2026-07-11', service_method: '直接送达', instrument: '示例判决书', note: '',
  }).status, 'accepted', '修正后的事实不得在下一份材料中重新浮出');
  assert.equal(candidateFacts.ensureCandidateFact(caseId, 'event', {
    type: 'judgment_served', occurred_on: '2026-07-10', service_method: '直接送达', instrument: '示例判决书', note: '',
  }).status, 'declined', '原 OCR identity 必须保留为修正 alias，不能再次骚扰');
  assert.notEqual(
    candidateFacts.candidateFactKey('event', { type: 'other', occurred_on: '2026-07-12', instrument: '通知一' }),
    candidateFacts.candidateFactKey('event', { type: 'other', occurred_on: '2026-07-12', instrument: '通知二' }),
    '同日不同程序事件不得误合并'
  );
  assert.notEqual(
    candidateFacts.candidateFactKey('fee', { label: '阶段款', amount: '1000', due_on: '', node: '立案后' }),
    candidateFacts.candidateFactKey('fee', { label: '阶段款', amount: '1000', due_on: '', node: '开庭后' }),
    '无明确日期的不同付款条件不得误合并'
  );
  assert.equal(
    candidateFacts.candidateFactKey('fee', {
      label: ' ＡＢＣ  阶段款 ', amount: '1000', due_on: '2026-09-01', node: '原条件', note: '来源一',
    }),
    candidateFacts.candidateFactKey('fee', {
      label: 'abc 阶段款', amount: '1000.00', due_on: '2026-09-01', node: '另一条件', note: '来源二',
    }),
    'NFKC、大小写、空白、等价金额、note 及明确日期下的 node 差异不得裂开事实'
  );
  assert.notEqual(
    candidateFacts.candidateFactKey('fee', { label: '阶段款', amount: null, due_on: '', node: '签约后' }),
    candidateFacts.candidateFactKey('fee', { label: '阶段款', amount: 0, due_on: '', node: '签约后' }),
    '金额待定与零元必须是不同事实'
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM deadlines WHERE trigger_event_id=?').get(event.id).c,
    1,
    '确认事件后必须走确定性引擎派生期限'
  );
  assert.equal(
    db.prepare('SELECT sync_status FROM legalrag_files WHERE id=?').get(duplicateFileId).sync_status,
    'ready',
    '合并事实裁决后所有来源文件都要退出 review'
  );

  response = await post(`/api/legalrag/candidates/${declineCandidate}/decline`, { reason: '当前不是本案收费节点' });
  assert.equal(response.status, 200);
  assert.equal(
    db.prepare('SELECT status FROM legalrag_candidates WHERE id=?').get(declineCandidate).status,
    'declined'
  );
  const declineFactId = db.prepare('SELECT fact_id FROM legalrag_candidates WHERE id=?').get(declineCandidate).fact_id;
  assert.equal(
    db.prepare('SELECT decision_reason FROM legalrag_candidate_facts WHERE id=?').get(declineFactId).decision_reason,
    '当前不是本案收费节点'
  );
  assert.equal(
    db.prepare('SELECT sync_status FROM legalrag_files WHERE id=?').get(fileId).sync_status,
    'ready',
    '最后一条候选裁决后文件回到 ready'
  );
  listResponse = await fetch(`${base}/api/cases/${caseId}/legalrag/candidates?status=declined`);
  let ignored = await listResponse.json();
  assert(ignored.some((candidate) => candidate.fact_id === declineFactId), '已忽略事实必须可查、可撤销');
  response = await post(`/api/legalrag/candidate-facts/${declineFactId}/reopen`);
  assert.equal(response.status, 200);
  assert.equal(db.prepare('SELECT status FROM legalrag_candidates WHERE id=?').get(declineCandidate).status, 'pending');
  assert.equal(db.prepare('SELECT sync_status FROM legalrag_files WHERE id=?').get(fileId).sync_status, 'review');
  response = await post(`/api/legalrag/candidates/${declineCandidate}/decline`, { reason: '当前不是本案收费节点' });
  assert.equal(response.status, 200);
  assert.equal(db.prepare('SELECT sync_status FROM legalrag_files WHERE id=?').get(fileId).sync_status, 'ready');

  const declinedPayload = { label: '待核条款', amount: null, node: '', due_on: '', note: '' };
  const inherited = candidateFacts.ensureCandidateFact(caseId, 'fee', declinedPayload);
  assert.equal(inherited.status, 'declined', '旧弃置必须成为跨文件负反馈');
  const laterFileId = db.prepare(
    `INSERT INTO legalrag_files
      (case_id,rel_path,filename,file_size,mtime_ms,revision,sync_status,legalrag_document_id)
     VALUES (?,'立案材料/补充协议.pdf','补充协议.pdf',90,3,1,'review','lr-doc-3')`
  ).run(caseId).lastInsertRowid;
  const laterExtractionId = db.prepare(
    `INSERT INTO legalrag_extractions(file_id,extractor,schema_version,status)
     VALUES (?,'test',1,'done')`
  ).run(laterFileId).lastInsertRowid;
  db.prepare(
    `INSERT INTO legalrag_candidates
      (extraction_id,file_id,case_id,kind,payload,confidence,source_quote,fact_id,status,decided_at)
     VALUES (?,?,?,'fee',?,0.88,'另一份文件中的同一疑似条款',?,'declined',datetime('now','+8 hours'))`
  ).run(laterExtractionId, laterFileId, caseId, JSON.stringify(declinedPayload), inherited.id);
  candidateFacts.refreshLegalRagFileStates([laterFileId]);
  listResponse = await fetch(`${base}/api/cases/${caseId}/legalrag/candidates`);
  listed = await listResponse.json();
  assert.equal(listed.some((candidate) => candidate.payload?.label === '待核条款'), false,
    '弃置事实换文件后不得再次浮出');
  assert.equal(db.prepare('SELECT sync_status FROM legalrag_files WHERE id=?').get(laterFileId).sync_status, 'ready');
  console.log('legalrag HTTP tests: multi-source merge + shared decisions + engine linkage passed');
} finally {
  child.kill('SIGTERM');
  db.close();
}
