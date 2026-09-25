/**
 * The byte-level cutter has to find the seams it claims to find, and has to be
 * able to fail. Each case uses a toy consumer with known behaviour.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { toSSE, seams, severAtEveryByte } from '../src/bytes.js';

const EVENTS = [{ type: 'START', id: 'm1' }, { type: 'CONTENT', text: 'hi' }, { type: 'END' }];

test('toSSE frames one event per data line', () => {
  const body = toSSE([{ a: 1 }, { b: 2 }]);
  assert.equal(body, 'data: {"a":1}\n\ndata: {"b":2}\n\n');
});

test('toSSE can name the event type', () => {
  assert.match(toSSE([{ a: 1 }], { event: 'message' }), /^event: message\ndata: /);
});

test('seams land inside a multi-byte character, not only between frames', () => {
  // "é" is two bytes; "😀" is four. Cutting inside either splits a character.
  const body = toSSE([{ text: 'é😀' }]);
  const found = seams(body);
  const utf8 = found.filter((s) => s.why === 'mid-UTF-8 sequence');
  assert.ok(utf8.length >= 4, `expected several mid-character offsets, got ${utf8.length}`);
});

test('seams include the position right after a field colon', () => {
  const found = seams(toSSE([{ a: 1 }]));
  assert.ok(found.some((s) => s.why === 'after a field colon'));
});

test('seams never point at 0 or at the end', () => {
  const body = toSSE(EVENTS);
  const bytes = new TextEncoder().encode(body).length;
  for (const { offset } of seams(body)) {
    assert.ok(offset > 0 && offset < bytes, `offset ${offset} is out of range`);
  }
});

test('a consumer that reports the truncation is not flagged', async () => {
  const body = toSSE(EVENTS);
  const honest = async (bytes) => ({
    delivered: [],
    settled: bytes === body ? 'complete' : 'incomplete',
  });
  const report = await severAtEveryByte({ body, replay: honest, label: 'honest' });
  assert.ok(report.cuts.length > 0, 'there must be something to check');
  assert.ok(report.cuts.every((c) => c.settledAlike === false));
});

test('a consumer that always reports success is flagged at every seam', async () => {
  const body = toSSE(EVENTS);
  const silent = async () => ({ delivered: [], settled: 'complete' });
  const report = await severAtEveryByte({ body, replay: silent, label: 'silent' });
  assert.ok(report.cuts.every((c) => c.settledAlike === true));
});

test('offsets: every is denser than offsets: seams', async () => {
  const body = toSSE(EVENTS);
  const noop = async () => ({ delivered: [], settled: 'x' });
  const bySeam = await severAtEveryByte({ body, replay: noop, offsets: 'seams' });
  const byByte = await severAtEveryByte({ body, replay: noop, offsets: 'every' });
  assert.ok(byByte.points > bySeam.points, `${byByte.points} should exceed ${bySeam.points}`);
  assert.equal(byByte.points, byByte.bytes - 1);
});

test('a replay that throws is recorded against its offset', async () => {
  const body = toSSE(EVENTS);
  const boom = async (bytes) => {
    if (bytes.length === 10) throw new Error('parser gave up');
    return { delivered: [], settled: 'x' };
  };
  const report = await severAtEveryByte({ body, replay: boom, offsets: 'every' });
  const threw = report.cuts.filter((c) => c.threw);
  assert.equal(threw.length, 1);
  assert.match(threw[0].threw, /parser gave up/);
  assert.equal(threw[0].offset, 10);
});

test('an empty body is rejected rather than reported as clean', async () => {
  await assert.rejects(
    () => severAtEveryByte({ body: '', replay: async () => ({}) }),
    /non-empty/,
  );
});

test('a cut inside a character really does hand over a broken one', async () => {
  const body = toSSE([{ text: '😀' }]);
  const seen = [];
  await severAtEveryByte({
    body,
    replay: async (bytes) => {
      seen.push(bytes);
      return { delivered: [], settled: 'x' };
    },
    offsets: 'every',
  });
  // The replacement character is what a lenient decoder produces for a partial
  // sequence. If none appears, nothing was ever cut mid-character.
  assert.ok(seen.some((b) => b.includes('�')), 'no partial character was produced');
});
