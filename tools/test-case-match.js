import assert from 'node:assert/strict';
import { matchCaseByHints } from '../src/lib/case-match.js';

const cases = [
  { id: 1, name: '张三案', client: '张三', opponent: '', case_no: '(2099)测0000民初1号', court: '测试人民法院', handling_agency: '', status: 'active', updated_at: '2026-10-02', procedure: '一审', stage: '立案' },
  { id: 2, name: '张三另一案', client: '张三', opponent: '', case_no: '(2099)测0000民初2号', court: '测试人民法院', handling_agency: '', status: 'active', updated_at: '2026-10-03' },
  { id: 3, name: '李四案', client: '', opponent: '', case_no: '', court: '', handling_agency: '测试人民检察院', status: 'active', updated_at: '2026-10-04' },
  { id: 5, name: '王五案', client: '王五', opponent: '', case_no: 'X-5', court: '', handling_agency: '', status: 'active', updated_at: '2026-10-01' },
  { id: 4, name: '旧张三案', client: '张三', opponent: '', case_no: '', court: '', handling_agency: '', status: 'closed', updated_at: '2026-10-05' },
];
const contacts = [
  { case_id: 3, role: '当事人', name: '王五' },
  { case_id: 1, role: '承办法官', name: '王五' },
];
assert.equal(matchCaseByHints({ cases, contacts, hints: { parties: ['张三'], case_no: '(2099)测 0000 民初 1 号' } }).match, 'unique');
const conflict = matchCaseByHints({ cases, contacts, hints: { parties: ['张三'], case_no: 'X-5' } });
assert.equal(conflict.match, 'multiple');
assert.equal(conflict.conflict, true);
assert.equal(matchCaseByHints({ cases, contacts, hints: { parties: ['王五'] } }).candidates[0].id, 3);
const agency = matchCaseByHints({ cases, contacts, hints: { agency: '测试人民检察院' } });
assert.equal(agency.candidates[0].id, 3);
assert.equal(agency.inactive_hits, 0);
const none = matchCaseByHints({ cases, contacts, hints: { parties: ['张'] } });
assert.equal(none.match, 'none');
assert.equal(matchCaseByHints({ cases, contacts, hints: { parties: ['张三'] } }).inactive_hits, 1);
assert.ok(!Object.keys(agency.candidates[0]).some((key) => ['phone', 'id_no', 'note'].includes(key)));
console.log('case-match: local hints normalization, intersection/conflict, contact roles, inactive count and safe projection passed');
