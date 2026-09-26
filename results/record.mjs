/**
 * The recording step for the AG-UI worked example.
 *
 * Replays every AG-UI conformance fixture through a real HttpAgent over real
 * HTTP/SSE — once whole, then once for every prefix — and writes the raw
 * observations as the JSON that results/run-ag-ui.mjs consumes.
 *
 *   node results/record.mjs <ag-ui>/spec/1.0/conformance/streams results/sever-results.json
 *   node results/run-ag-ui.mjs results/sever-results.json
 *
 * Only this file needs @ag-ui/client. Its output is committed beside it, so the
 * numbers in the README can be re-derived without installing their client at all.
 */
import { createServer } from 'node:http';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';
import { HttpAgent } from '@ag-ui/client';

const CORPUS = process.argv[2];
const OUT = process.argv[3];
if (!CORPUS || !OUT) {
  console.error('usage: node record.mjs <corpus-dir> <out.json>');
  process.exit(1);
}

const fixtures = readdirSync(CORPUS)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => {
    const j = JSON.parse(readFileSync(join(CORPUS, f), 'utf8'));
    return { name: j.name ?? basename(f, '.json'), file: f, stream: j.stream ?? [] };
  });

const byName = new Map(fixtures.map((f) => [f.name, f]));

// A real HTTP server speaking real SSE. Truncation = the response simply ends
// after k events: no further frames, no terminal event, clean close.
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const fx = byName.get(u.searchParams.get('fixture'));
  const k = Number(u.searchParams.get('k'));
  if (!fx) {
    res.writeHead(404).end();
    return;
  }
  // Drain the request body before answering.
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'close',
    });
    const prefix = fx.stream.slice(0, k);
    for (const ev of prefix) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    res.end();
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

function textOf(messages) {
  return messages
    .map((m) => {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null);
      const tc = (m.toolCalls ?? []).map((t) => `${t.function?.name}(${t.function?.arguments})`).join(',');
      return `${m.role}:${c}${tc ? `|${tc}` : ''}`;
    })
    .join('\u0001');
}

function contentOnly(messages) {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null)))
    .join('\u0001');
}

async function replay(fixture, k) {
  const delivered = [];
  const agent = new HttpAgent({
    url: `http://127.0.0.1:${port}/?fixture=${encodeURIComponent(fixture)}&k=${k}`,
  });
  try {
    const settled = await agent.runAgent({}, { onEvent: ({ event }) => delivered.push(event.type) });
    const msgs = settled.newMessages ?? [];
    return {
      delivered: delivered.join(' '),
      settled: JSON.stringify({ result: settled.result ?? null, newMessages: msgs.length }),
      messagesCount: msgs.length,
      messagesText: textOf(msgs),
      messagesContentOnly: contentOnly(msgs),
      messagesJson: JSON.stringify(msgs),
    };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return {
      threw: m,
      delivered: delivered.join(' '),
      // Alternative recording discipline: an errored run recorded as a settled
      // value rather than a throw, which is what their table's zero throws implies.
      errSettled: JSON.stringify({ error: m }),
    };
  }
}

const rows = [];
for (const fx of fixtures) {
  const of = fx.stream.length;
  if (of < 2) continue; // no cut exists: k runs 1..of-1
  const whole = await replay(fx.name, of);
  for (let k = 1; k < of; k++) {
    const cut = await replay(fx.name, k);
    rows.push({
      fixture: fx.name,
      k,
      of,
      threw: cut.threw,
      cutDelivered: cut.delivered,
      cutSettled: cut.settled,
      cutMessages: cut.messagesText,
      cutMessagesCount: cut.messagesCount,
      cutMessagesContentOnly: cut.messagesContentOnly,
      cutMessagesJson: cut.messagesJson,
      cutErrSettled: cut.errSettled,
      wholeDelivered: whole.delivered,
      wholeSettled: whole.settled,
      wholeMessages: whole.messagesText,
      wholeMessagesCount: whole.messagesCount,
      wholeMessagesContentOnly: whole.messagesContentOnly,
      wholeMessagesJson: whole.messagesJson,
      wholeErrSettled: whole.errSettled,
      wholeThrew: whole.threw,
    });
  }
  process.stderr.write('.');
}
process.stderr.write('\n');

// Which client produced this. Without it the figures cannot be re-recorded by anyone,
// which is the whole point of committing the observations rather than the numbers.
const clientVersion = JSON.parse(
  readFileSync(createRequire(import.meta.url).resolve('@ag-ui/client/package.json'), 'utf8'),
).version;

writeFileSync(
  OUT,
  JSON.stringify({ client: { name: '@ag-ui/client', version: clientVersion }, rows }, null, 1),
);
console.log(`fixtures seen: ${fixtures.length}`);
console.log(`fixtures replayed (>=2 events): ${new Set(rows.map((r) => r.fixture)).size}`);
console.log(`rows (cuts): ${rows.length}`);
await new Promise((r) => server.close(r));
