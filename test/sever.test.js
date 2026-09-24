/**
 * The harness has to be able to fail, or it is decoration.
 *
 * Each case builds a toy consumer whose behaviour is known, so the assertion is
 * about what `severAtEveryPoint` concludes rather than about any real client.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { severAtEveryPoint } from '../src/sever.js';
import { summarise } from '../src/report.js';

const EVENTS = ['START', 'CONTENT', 'CONTENT', 'END', 'FINISHED'];

/** A consumer that reports whether it saw the terminal event. Correct. */
const honest = async (prefix) => ({
  delivered: [...prefix],
  settled: prefix.includes('FINISHED') ? 'complete' : 'incomplete',
});

/** A consumer that always reports success. The defect this tool looks for. */
const silent = async (prefix) => ({ delivered: [...prefix], settled: 'complete' });

test('an honest consumer is reported as distinguishable at every cut', async () => {
  const report = await severAtEveryPoint({ events: EVENTS, replay: honest, label: 'honest' });
  assert.equal(report.cuts.length, EVENTS.length - 1);
  assert.ok(report.cuts.every((c) => c.settledAlike === false), 'no cut should match the whole');
  assert.ok(report.cuts.every((c) => c.prefixHeld === true), 'prefixes must hold');
});

test('a consumer that always says success is caught at every cut', async () => {
  const report = await severAtEveryPoint({ events: EVENTS, replay: silent, label: 'silent' });
  assert.ok(report.cuts.every((c) => c.settledAlike === true), 'every cut should be flagged');
});

test('the summary separates a silent consumer from an honest one', async () => {
  const reports = [
    await severAtEveryPoint({ events: EVENTS, replay: honest, label: 'honest' }),
    await severAtEveryPoint({ events: EVENTS, replay: silent, label: 'silent' }),
  ];
  const lostContent = (cut, whole) => cut.delivered.length < whole.delivered.length;
  const s = summarise(reports, { lostContent });
  assert.equal(s.streams, 2);
  assert.equal(s.cuts, (EVENTS.length - 1) * 2);
  assert.equal(s.findings.length, EVENTS.length - 1, 'only the silent consumer is reported');
  assert.ok(s.findings.every((c) => c.label === 'silent'));
});

test('without a lostContent check nothing is called a defect', async () => {
  const reports = [await severAtEveryPoint({ events: EVENTS, replay: silent, label: 'silent' })];
  const s = summarise(reports);
  assert.equal(s.reportedAlike, EVENTS.length - 1, 'the raw count is still reported');
  assert.equal(s.findings.length, 0, 'but nothing is claimed as a finding');
  assert.equal(s.lostContentChecked, false);
});

test('a cut that lost nothing is not a finding', async () => {
  // Every cut reports the same, but nothing was ever lost.
  const reports = [await severAtEveryPoint({ events: EVENTS, replay: silent, label: 'silent' })];
  const s = summarise(reports, { lostContent: () => false });
  assert.equal(s.reportedAlike, EVENTS.length - 1);
  assert.equal(s.findings.length, 0, 'losing nothing is not a defect');
});

test('ignore removes a stream from the findings without hiding the count', async () => {
  const reports = [
    await severAtEveryPoint({ events: EVENTS, replay: silent, label: 'real' }),
    await severAtEveryPoint({ events: EVENTS, replay: silent, label: 'invalid-on-purpose-fatal' }),
  ];
  const lostContent = (cut, whole) => cut.delivered.length < whole.delivered.length;
  const s = summarise(reports, { ignore: (l) => l.endsWith('-fatal'), lostContent });
  assert.equal(s.streams, 1);
  assert.equal(s.excluded, 1);
  assert.ok(s.findings.every((c) => c.label === 'real'));
});

test('a replay that throws is recorded, not swallowed', async () => {
  const boom = async (prefix) => {
    if (prefix.length === 2) throw new Error('replay exploded');
    return { delivered: [...prefix], settled: 'x' };
  };
  const report = await severAtEveryPoint({ events: EVENTS, replay: boom, label: 'boom' });
  const threw = report.cuts.filter((c) => c.threw);
  assert.equal(threw.length, 1);
  assert.match(threw[0].threw, /replay exploded/);
});

test('a prefix that grows rather than shrinks is flagged', async () => {
  // A stream that is invalid on purpose: the consumer gives up at the bad event,
  // so the whole stream delivers LESS than a prefix cut before it.
  const givesUp = async (prefix) => ({
    delivered: prefix.includes('BAD') ? ['START'] : [...prefix],
    settled: 'x',
  });
  const report = await severAtEveryPoint({
    events: ['START', 'CONTENT', 'BAD'],
    replay: givesUp,
    label: 'invalid',
  });
  assert.ok(report.cuts.some((c) => c.prefixHeld === false), 'this shape must be visible');
});

test('an empty stream is rejected rather than reported as clean', async () => {
  await assert.rejects(
    () => severAtEveryPoint({ events: [], replay: honest }),
    /non-empty/,
  );
});

test('a custom comparison replaces the default', async () => {
  // Compare rendered content instead of the settlement string.
  const byText = async (prefix) => ({ delivered: [...prefix], text: prefix.join('') });
  const report = await severAtEveryPoint({
    events: EVENTS,
    replay: byText,
    label: 'text',
    same: (a, b) => a.text === b.text,
  });
  assert.ok(report.cuts.every((c) => c.settledAlike === false));
});
