#!/usr/bin/env node
import assert from 'node:assert/strict';
import { normalizeDate, normalizeTime } from '../src/lib/cn-datetime.js';

const dates = [
  ['2099年11月3日', '2099-11-03'],
  ['2099-11-3', '2099-11-03'],
  ['2099/11/03', '2099-11-03'],
  ['2099.11.3', '2099-11-03'],
];
for (const [input, expected] of dates) assert.equal(normalizeDate(input), expected, input);

const times = [
  ['09:30', '09:30'],
  ['9:30', '09:30'],
  ['9时30分', '09:30'],
  ['9时', '09:00'],
  ['9点半', '09:30'],
  ['上午9时30分', '09:30'],
  ['下午2时', '14:00'],
  ['下午2点15分', '14:15'],
  ['中午12时', '12:00'],
  ['晚上7点', '19:00'],
];
for (const [input, expected] of times) assert.equal(normalizeTime(input), expected, input);

for (const input of ['2099年2月30日', '25时', '下午13时', '']) {
  assert.equal(normalizeDate(input), '', `date should reject ${input}`);
}
assert.equal(normalizeTime('25时'), '', 'time should reject 25时');
assert.equal(normalizeTime('下午13时'), '', 'time should reject 下午13时');
assert.equal(normalizeTime(''), '', 'time should reject empty input');

console.log('cn datetime normalization ok');
