import assert from 'node:assert/strict';
import { isExternalCollectedFee, ownFeePredicate } from '../src/lib/fee-accounting.js';

assert.equal(isExternalCollectedFee([{ direction: 'receivable' }]), true);
assert.equal(isExternalCollectedFee([
  { direction: 'receivable' },
  { direction: 'payable' },
]), false, '同一款同时有应收和应付时仍按我方律师费处理');
assert.equal(isExternalCollectedFee([{ direction: 'payable' }]), false);
assert.equal(isExternalCollectedFee([]), false);

const predicate = ownFeePredicate('f');
assert.match(predicate, /external_share/);
assert.match(predicate, /own_share/);
assert.match(predicate, /cancelled_by_run_id IS NULL/);

console.log('fee accounting regression ok');
