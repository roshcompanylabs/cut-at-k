/**
 * AG-UI over real HTTP, with the line terminator as the variable.
 *
 *   npm install @ag-ui/client eventsource-parser
 *   node probes/ag-ui-line-endings.mjs
 *
 * Every other probe here cuts a stream and asks what the consumer is left with.
 * This one asks the question one layer down, because the answer turned out to
 * depend on something no cut can reach: how the lines were terminated.
 *
 * The SSE grammar in the HTML standard admits three:
 *
 *   end-of-line = ( cr lf / cr / lf )
 *
 * So `\r\n\r\n`, `\r\r` and `\n\n` are all the same boundary to a conformant
 * reader. `eventsource-parser` is here as that reader — the control is not this
 * file's opinion of the standard but a second implementation of it, handed the
 * same bytes.
 *
 * The prompt for asking came from openai-node#2726, merged 2026-09-16, which
 * fixed a decoder that only emitted on a blank line and so dropped a terminal
 * event flushed without one. AG-UI turns out to flush at EOF correctly. What it
 * does not do is recognise a boundary that is not `\n\n`.
 */
import { createServer } from 'node:http';
import { severAtEveryPoint, summarise, format } from '../src/index.js';
import { requireLatest } from './_versions.mjs';
import { HttpAgent } from '@ag-ui/client';
import { createParser } from 'eventsource-parser';

await requireLatest(['@ag-ui/client', 'eventsource-parser'], { from: import.meta.url });

const IDS = { threadId: 't', runId: 'r' };

/** The stream, in order. A cut is a prefix of this. */
const EVENTS = [
  { type: 'RUN_STARTED', ...IDS },
  { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Transferring $50,000' },
  { type: 'TEXT_MESSAGE_END', messageId: 'm' },
  { type: 'RUN_FINISHED', ...IDS },
];

/**
 * The three line terminators the grammar allows, plus the mixed form a server
 * produces when it writes CRLF field lines but joins events with a bare LF.
 */
const TERMINATORS = {
  'LF          \\n\\n': '\n\n',
  'CRLF        \\r\\n\\r\\n': '\r\n\r\n',
  'CR          \\r\\r': '\r\r',
  'CRLF field, LF blank': '\r\n\n',
};

/** Serve exactly these events, separated and terminated by `sep`, then close. */
function serve(events, sep) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (events.length) {
          res.write(events.map((e) => `data: ${JSON.stringify(e)}`).join(sep) + sep);
        }
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** What a second, conformant implementation makes of the same bytes. */
function conformant(events, sep) {
  if (!events.length) return [];
  const seen = [];
  const parser = createParser({
    onEvent: (e) => {
      try {
        seen.push(JSON.parse(e.data).type);
      } catch {
        seen.push('(unparseable)');
      }
    },
  });
  parser.feed(events.map((e) => `data: ${JSON.stringify(e)}`).join(sep) + sep);
  return seen;
}

const replayWith = (sep) => async (prefix) => {
  const { server, port } = await serve(prefix, sep);
  const agent = new HttpAgent({ url: `http://127.0.0.1:${port}/` });

  const seen = [];
  let threw = null;
  try {
    await agent.runAgent({ ...IDS }, { onEvent: ({ event }) => seen.push(event?.type) });
  } catch (e) {
    threw = String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 46);
  }
  server.close();

  const reference = conformant(prefix, sep);
  return {
    delivered: seen,
    settled: JSON.stringify({ threw, terminal: seen.includes('RUN_FINISHED') }),
    seenCount: seen.length,
    referenceCount: reference.length,
    threw,
  };
};

const rows = [];
for (const [name, sep] of Object.entries(TERMINATORS)) {
  const report = await severAtEveryPoint({
    events: EVENTS,
    replay: replayWith(sep),
    label: `sse ${name.trim()}`,
  });
  const whole = report.whole ?? {};
  rows.push({ name, report, whole });
}

console.log(
  format(
    summarise(
      rows.map((r) => r.report),
      {
        // The loss: a conformant reader got events out of these bytes and the
        // client under test did not.
        lostContent: (cut) => cut.referenceCount > cut.seenCount,
      },
    ),
  ),
);

console.log('\n  the complete stream, per line terminator\n');
console.log('  terminator                  conformant  @ag-ui/client  RUN_FINISHED  threw');
for (const { name, whole } of rows) {
  console.log(
    `  ${name.padEnd(28)}${String(whole.referenceCount ?? 0).padEnd(12)}` +
      `${String(whole.seenCount ?? 0).padEnd(15)}` +
      `${String((whole.delivered ?? []).includes('RUN_FINISHED')).padEnd(14)}${whole.threw ?? '—'}`,
  );
}

const disagree = rows.filter((r) => (r.whole.referenceCount ?? 0) > (r.whole.seenCount ?? 0));

console.log('');
if (disagree.length === 0) {
  console.log('  No finding. Every terminator the grammar allows reaches the consumer the');
  console.log('  same way it reaches a second implementation of the same grammar.');
} else {
  console.log(`  ${disagree.length} of ${rows.length} terminators are read differently by the two`);
  console.log('  implementations. These are complete streams, not cuts: the run is whole and');
  console.log('  the client still gets nothing from it.');
  for (const d of disagree) {
    console.log(`    ${d.name.trim()} — conformant ${d.whole.referenceCount}, client ${d.whole.seenCount}`);
  }

  // The summary above flags the prefix property as broken on these streams, and it
  // is right to: the one-event prefix delivers more than the whole run does. That
  // is not the harness misreading anything, it is the shape of the defect. With a
  // single event there is no boundary to find, so the EOF flush parses the frame
  // and the trailing CR is swallowed as JSON whitespace. With two, the same flush
  // parses both concatenated and throws. So the count does not degrade — it falls
  // off a cliff between one event and two, which is why a smoke test that sends
  // one event would pass.
  console.log('\n  how many events reach the client, by how many were sent\n');
  console.log('  terminator                  ' + EVENTS.map((_, i) => `k=${i + 1}`).join('  '));
  for (const { name, report } of rows) {
    const per = (report.cuts ?? []).map((c) => c.observation?.seenCount ?? 0);
    per.push(report.whole?.seenCount ?? 0);
    console.log(`  ${name.padEnd(28)}${per.map((n) => String(n).padEnd(5)).join('')}`);
  }
  console.log('\n  A stream carrying one event is read correctly under every terminator. The');
  console.log('  break needs a boundary to be there and be missed, so it takes two.');
}
