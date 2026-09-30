/**
 * AG-UI, cut inside the frame rather than between events.
 *
 *   npm install @ag-ui/client rxjs
 *   node probes/ag-ui-bytes.mjs
 *
 * Every other probe here severs between events, which tests the state machine:
 * does the consumer handle a run that stopped after three events rather than
 * nine. This one severs inside the bytes, which tests the parser underneath —
 * a cut in the middle of a UTF-8 sequence, between `data:` and its newline, or
 * halfway through a JSON payload.
 *
 * The two are different targets and the distinction is worth keeping: a defect
 * found here is a parser buffering defect, and one found between events is
 * incomplete-run handling. The CRLF result in this directory came from varying
 * the framing of complete frames, which is neither.
 *
 * `seams()` picks the offsets rather than sweeping all of them — most bytes of
 * a frame are unremarkable and the ones that break things sit at structural
 * marks. Pass `offsets: 'every'` when you can afford it.
 */
import { createServer } from 'node:http';
import { severAtEveryByte, seams, toSSE } from '../src/index.js';
import { requireLatest } from './_versions.mjs';
import { HttpAgent } from '@ag-ui/client';

await requireLatest(['@ag-ui/client'], { from: import.meta.url });

const IDS = { threadId: 't', runId: 'r' };

/** A complete, valid run — non-ASCII on purpose, so a cut can land mid-character. */
const EVENTS = [
  { type: 'RUN_STARTED', ...IDS },
  { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'تحويل ' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: '50,000 درهم' },
  { type: 'TEXT_MESSAGE_END', messageId: 'm' },
  { type: 'RUN_FINISHED', ...IDS },
];

const BODY = toSSE(EVENTS);

/** Serve exactly these bytes and close. */
function serve(body) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(body);
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function replay(body) {
  const { server, port } = await serve(body);
  const agent = new HttpAgent({ url: `http://127.0.0.1:${port}/` });

  const seen = [];
  let threw = null;
  try {
    await agent.runAgent({ ...IDS }, { onEvent: ({ event }) => seen.push(event?.type) });
  } catch (e) {
    threw = String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 44);
  }
  server.close();

  const text = (agent.messages ?? [])
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('');

  return {
    delivered: seen,
    settled: JSON.stringify({ threw, terminal: seen.includes('RUN_FINISHED') }),
    text,
    threw,
  };
}

const report = await severAtEveryByte({ body: BODY, replay, label: 'ag-ui bytes' });

console.log(`  ${report.bytes} bytes, ${report.points} seams worth cutting at\n`);

const byReason = new Map();
for (const c of report.cuts) {
  const r = byReason.get(c.why) ?? { n: 0, alike: 0, threw: 0, terminal: 0 };
  r.n += 1;
  if (c.settledAlike) r.alike += 1;
  if (c.observation?.threw || c.threw) r.threw += 1;
  if ((c.observation?.delivered ?? []).includes('RUN_FINISHED')) r.terminal += 1;
  byReason.set(c.why, r);
}

console.log('  where the cut landed        cuts  reported like the whole run  raised  saw RUN_FINISHED');
for (const [why, r] of byReason) {
  console.log(
    `  ${why.padEnd(28)}${String(r.n).padEnd(6)}${String(r.alike).padEnd(29)}${String(r.threw).padEnd(8)}${r.terminal}`,
  );
}

const silent = report.cuts.filter(
  (c) => c.settledAlike && !(c.observation?.delivered ?? []).includes('RUN_FINISHED'),
);
const whole = report.whole ?? {};

const alike = report.cuts.filter((c) => c.settledAlike);

console.log('');
console.log(`  the whole body delivers RUN_FINISHED      : ${(whole.delivered ?? []).includes('RUN_FINISHED')}`);
console.log(`  cuts that report the same as the whole run: ${alike.length} of ${report.cuts.length}`);
console.log(`  of those, with no terminal event          : ${silent.length}`);
for (const c of alike) {
  // A cut that reports like the whole run is only interesting if it lost
  // something. The last seam is the body minus its final newline, so every
  // frame is intact and it is the whole run by another name.
  const tail = c.offset >= c.of - 2 ? '  (the body minus its trailing newline)' : '';
  console.log(`    @${c.offset} of ${c.of}  (${c.why})${tail}`);
}
console.log('');
if (silent.length === 0) {
  console.log('  No finding. A body cut inside a frame never reports what a complete body');
  console.log('  reports — the parser refuses it rather than passing a half-read run on.');
} else {
  console.log('  Look closer: a cut inside a frame reported what a finished run reports.');
  for (const c of silent.slice(0, 6)) {
    console.log(`    @${c.offset} of ${c.of}  (${c.why})  last delivered: ${c.terminal}`);
  }
}
