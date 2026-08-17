// 文书候选 v2：模型先裁决来源/本案关系，后端再 fail-closed 过滤。
import assert from 'node:assert/strict';

process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';

const requests = [];
let nextResult;
global.fetch = async (_url, options = {}) => {
  requests.push(JSON.parse(options.body));
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(nextResult) } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const {
  DOCUMENT_MIN_CONFIDENCE,
  extractDocument,
  normalizeDocumentResult,
} = await import('../src/lib/document-extractor.js');

const directEvent = {
  kind: 'event', evidence_relation: 'direct', confidence: 0.97,
  source_page: 2, source_quote: '本院定于二〇二六年八月一日开庭审理。',
  payload: {
    type: 'hearing', occurred_on: '2026-08-01', service_method: '',
    instrument: '示例传票', note: '',
  },
};

nextResult = {
  document_role: 'court_instrument',
  case_relation: 'direct',
  evidence_mode: 'primary_source',
  screening_reason: '案号及当事人与本案锚点一致',
  matched_case_markers: ['案号一致', '当事人一致'],
  candidates: [directEvent],
};
const direct = await extractDocument({
  fileName: '开庭传票.pdf',
  relativePath: '法院文书/开庭传票.pdf',
  caseContext: {
    name: '张三诉李四示例案', case_no: '（2026）粤0305民初0001号',
    client: '张三', opponent: '李四', procedure: '一审',
    note: '不得发送的额外字段',
  },
  text: '--- 第 2 页 ---\n本院定于二〇二六年八月一日开庭审理。',
});
assert.equal(direct.screening_decision, 'eligible');
assert.equal(direct.candidates.length, 1, '本案直接法院文书的高置信事件应进入候选');
assert.equal(direct.candidates[0].evidence_relation, 'direct');
const userMessage = requests[0].messages.find((message) => message.role === 'user').content;
assert.match(userMessage, /张三诉李四示例案/);
assert.match(userMessage, /法院文书\/开庭传票\.pdf/);
assert.doesNotMatch(userMessage, /不得发送的额外字段/, '只允许最小案件身份白名单进入模型上下文');

const report = normalizeDocumentResult({
  document_role: 'search_report',
  case_relation: 'direct',
  evidence_mode: 'quoted_reference',
  screening_reason: '这是类案检索报告，日期来自被引用的他案裁判',
  candidates: [directEvent],
});
assert.equal(report.screening_decision, 'filtered');
assert.equal(report.candidates.length, 0, '检索报告即使给出完整裁判摘录也必须 fail-closed');

const quoted = normalizeDocumentResult({
  document_role: 'court_instrument',
  case_relation: 'direct',
  evidence_mode: 'primary_source',
  candidates: [{ ...directEvent, evidence_relation: 'quoted' }],
});
assert.equal(quoted.candidates.length, 0, '原始文书中引用/举例的他案事实不得成为本案候选');

const uncertain = normalizeDocumentResult({
  document_role: 'court_instrument',
  case_relation: 'uncertain',
  evidence_mode: 'primary_source',
  candidates: [directEvent],
});
assert.equal(uncertain.candidates.length, 0, '无法确认属于本案时必须留空而不是猜测');

const lowConfidence = normalizeDocumentResult({
  document_role: 'court_instrument',
  case_relation: 'direct',
  evidence_mode: 'primary_source',
  candidates: [{ ...directEvent, confidence: DOCUMENT_MIN_CONFIDENCE - 0.01 }],
});
assert.equal(lowConfidence.candidates.length, 0, '低置信候选不得进入人工队列');

const invalidConfidence = normalizeDocumentResult({
  document_role: 'court_instrument',
  case_relation: 'direct',
  evidence_mode: 'primary_source',
  candidates: [{ ...directEvent, confidence: 99 }],
});
assert.equal(invalidConfidence.candidates.length, 0, '超出 0..1 协议范围的置信度必须 fail-closed');

const inventedQuote = normalizeDocumentResult({
  document_role: 'court_instrument',
  case_relation: 'direct',
  evidence_mode: 'primary_source',
  candidates: [directEvent],
}, { sourceText: '正文中没有模型声称的这句话。' });
assert.equal(inventedQuote.candidates.length, 0, '引文无法在 OCR 正文中定位时不得进入候选');

const fee = normalizeDocumentResult({
  document_role: 'retainer_agreement',
  case_relation: 'direct',
  evidence_mode: 'primary_source',
  candidates: [{
    kind: 'fee', evidence_relation: 'direct', confidence: 0.93,
    source_page: 3, source_quote: '代理费于合同签订之日支付。',
    payload: { label: '一审代理费', amount: '1000.00', node: '签约日支付', due_on: '', note: '' },
  }],
});
assert.equal(fee.candidates.length, 1, '本案委托合同的直接收费节点应保留');

const derivedFee = normalizeDocumentResult({
  document_role: 'retainer_agreement',
  case_relation: 'direct',
  evidence_mode: 'primary_source',
  screening_reason: '正文复制了委托合同条款',
  candidates: [{
    kind: 'fee', evidence_relation: 'direct', confidence: 0.99,
    source_page: 1, source_quote: '代理费于合同签订之日支付。',
    payload: { label: '一审代理费', amount: '1000.00', node: '签约日支付', due_on: '', note: '' },
  }],
}, { relativePath: '办案过程/材料事实摘录.md' });
assert.equal(derivedFee.screening_decision, 'filtered');
assert.equal(derivedFee.candidates.length, 0,
  '派生事实摘录即使被模型误判成委托合同，也不得作为直接原始依据');

const derivedCourt = normalizeDocumentResult({
  document_role: 'court_instrument',
  case_relation: 'direct',
  evidence_mode: 'primary_source',
  candidates: [directEvent],
}, { relativePath: '办案过程/检索报告/sources/doc_示例判决书.md' });
assert.equal(derivedCourt.candidates.length, 0,
  '检索报告目录中的裁判原文即使模型判 direct，也必须被路径来源门禁清零');

console.log('document extractor tests: contextual source gate + direct evidence filter passed');
