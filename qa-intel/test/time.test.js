'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/time');

// 14 Oct 2026 01:30 IST — still 13 Oct in UTC, so UTC-based logic would be wrong.
const NOW = new Date('2026-10-13T20:00:00Z');
const r = (q) => T.resolveDateRange(q, NOW).range;

test('IST calendar parts differ from UTC around midnight', () => {
  assert.equal(T.istDateKey(NOW), '2026-10-14');
  assert.equal(T.formatIst(NOW), 'Wed 14 Oct 2026, 01:30 IST');
});

test('today / yesterday / N days ago use IST days', () => {
  assert.deepEqual([r('today').start, r('today').end], ['2026-10-13T18:30:00.000Z', '2026-10-14T18:30:00.000Z']);
  assert.equal(r('what happened yesterday').start, '2026-10-12T18:30:00.000Z');
  assert.equal(r('tests added two days ago').start, '2026-10-11T18:30:00.000Z');
  assert.equal(r('tests added 2 days ago').description, 'Mon 12 Oct 2026 (00:00–23:59 IST)');
  assert.equal(r('the day before yesterday').start, '2026-10-11T18:30:00.000Z');
});

test('weeks start on Monday; months are calendar months', () => {
  const week = r('this week');
  assert.equal(week.start, '2026-10-11T18:30:00.000Z'); // Mon 12 Oct 00:00 IST
  assert.equal(week.end, '2026-10-18T18:30:00.000Z');
  assert.equal(r('last week').start, '2026-10-04T18:30:00.000Z');
  assert.equal(r('this month').start, '2026-09-30T18:30:00.000Z'); // 1 Oct 00:00 IST
  assert.equal(r('this month').end, '2026-10-31T18:30:00.000Z');
  assert.equal(r('last month').start, '2026-08-31T18:30:00.000Z');
});

test('rolling windows include today', () => {
  const seven = r('framework changes in the last seven days');
  assert.equal(seven.start, '2026-10-07T18:30:00.000Z'); // Thu 8 Oct
  assert.equal(seven.end, '2026-10-14T18:30:00.000Z');
  assert.match(seven.description, /Thu 8 Oct 2026 00:00 IST to Wed 14 Oct 2026 23:59 IST/);
  assert.equal(r('past 3 days').start, '2026-10-11T18:30:00.000Z');
});

test('explicit dates (ISO, day-first, month names, ranges)', () => {
  assert.equal(r('on 2026-10-05').start, '2026-10-04T18:30:00.000Z');
  assert.equal(r('on 05/10/2026').start, '2026-10-04T18:30:00.000Z');
  assert.equal(r('on 5 Oct').start, '2026-10-04T18:30:00.000Z');
  assert.equal(r('on October 5th, 2026').start, '2026-10-04T18:30:00.000Z');
  const between = r('between 2026-10-01 and 2026-10-03');
  assert.deepEqual([between.start, between.end], ['2026-09-30T18:30:00.000Z', '2026-10-03T18:30:00.000Z']);
  assert.equal(r('since 2026-10-10').start, '2026-10-09T18:30:00.000Z');
});

test('no date expression → null', () => {
  assert.equal(T.resolveDateRange('what tests failed in the last five executions', NOW), null);
  assert.equal(T.resolveDateRange('which tests are flaky', NOW), null);
});

test('inRange is start-inclusive, end-exclusive', () => {
  const y = r('yesterday');
  assert.ok(T.inRange('2026-10-12T18:30:00Z', y));
  assert.ok(!T.inRange('2026-10-13T18:30:00Z', y));
});
