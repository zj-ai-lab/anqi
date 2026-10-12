import assert from 'node:assert/strict';
import { CANDIDATE_FIELDS, matchCaseByHints } from '../src/lib/case-match.js';

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
  { case_id: 6, role: '当事人', name: '赵六' },
  { case_id: 7, role: '承办法官', name: '赵六' },
];
const extraCases = [
  { id: 6, name: '联系人甲案', client: '', opponent: '', case_no: '', court: '', handling_agency: '', status: 'active', updated_at: '2026-10-06' },
  { id: 7, name: '联系人乙案', client: '', opponent: '', case_no: '', court: '', handling_agency: '', status: 'active', updated_at: '2026-10-07' },
  ...Array.from({ length: 12 }, (_, index) => ({
    id: 8 + index, name: `候选案${index + 1}`, client: '候选人', opponent: '', case_no: '', court: '', handling_agency: '', status: 'active',
    updated_at: `2026-10-${String(8 + index).padStart(2, '0')}`,
  })),
  { id: 20, name: '搁置张三案', client: '张三', opponent: '', case_no: '', court: '', handling_agency: '', status: 'shelved', updated_at: '2026-10-20' },
];
const allCases = [...cases, ...extraCases];
const unique = matchCaseByHints({ cases, contacts, hints: { parties: ['张三'], case_no: '(2099)测 0000 民初 1 号' } });
assert.equal(unique.match, 'unique');
assert.deepEqual(unique.candidates.map((row) => row.id), [1]);
const twoPartyHits = matchCaseByHints({ cases, contacts, hints: { parties: ['张三'] } });
assert.equal(twoPartyHits.match, 'multiple');
assert.equal(twoPartyHits.conflict, false);
assert.deepEqual(twoPartyHits.candidates.map((row) => row.id), [2, 1]);
const conflict = matchCaseByHints({ cases, contacts, hints: { parties: ['张三'], case_no: 'X-5' } });
assert.equal(conflict.match, 'multiple');
assert.equal(conflict.conflict, true);
assert.equal(matchCaseByHints({ cases, contacts, hints: { parties: ['王五'] } }).candidates[0].id, 3);
const contactRoleMatch = matchCaseByHints({ cases: allCases, contacts, hints: { parties: ['赵六'] } });
assert.equal(contactRoleMatch.match, 'unique');
assert.equal(contactRoleMatch.candidates[0].id, 6);
const manyCandidates = matchCaseByHints({ cases: allCases, contacts, hints: { parties: ['候选人'] } });
assert.equal(manyCandidates.candidates.length, 10);
assert.equal(manyCandidates.candidates[0].id, 19);
const agency = matchCaseByHints({ cases, contacts, hints: { agency: '测试人民检察院' } });
assert.equal(agency.candidates[0].id, 3);
assert.equal(agency.inactive_hits, 0);
const none = matchCaseByHints({ cases, contacts, hints: { parties: ['张'] } });
assert.equal(none.match, 'none');
const inactiveHits = matchCaseByHints({ cases: allCases, contacts, hints: { parties: ['张三'] } });
assert.equal(inactiveHits.candidates.some((row) => row.id === 4), false);
assert.equal(inactiveHits.inactive_hits, 2);
const caseNoCases = [
  { id: 21, name: '案号一案', client: '', opponent: '', case_no: '(2099)测0000民初1号', court: '', handling_agency: '', status: 'active', updated_at: '2026-10-21' },
  { id: 22, name: '案号十案', client: '', opponent: '', case_no: '(2099)测0000民初10号', court: '', handling_agency: '', status: 'active', updated_at: '2026-10-22' },
];
const exactCaseNo = matchCaseByHints({ cases: caseNoCases, hints: { case_no: '(2099)测0000民初1号' } });
assert.equal(exactCaseNo.match, 'unique');
assert.equal(exactCaseNo.candidates[0].id, 21);
const containsCaseNo = matchCaseByHints({ cases: caseNoCases, hints: { case_no: '民初10号' } });
assert.equal(containsCaseNo.match, 'unique');
assert.equal(containsCaseNo.candidates[0].id, 22);
assert.deepEqual(Object.keys(agency.candidates[0]), CANDIDATE_FIELDS);
assert.equal(matchCaseByHints({ cases, contacts, hints: { parties: '李四' } }).match, 'unique');
assert.equal(matchCaseByHints({ cases, contacts }).match, 'none');
console.log('case-match: local hints normalization, intersection/conflict, contact roles, inactive count and safe projection passed');
