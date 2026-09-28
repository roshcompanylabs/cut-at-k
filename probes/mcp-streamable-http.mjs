/**
 * MCP Streamable HTTP: when the response leg of a POST dies, how long before the
 * caller finds out?
 *
 *   npm install @modelcontextprotocol/client
 *   node probes/mcp-streamable-http.mjs
 *
 * A Streamable HTTP request can get a `text/event-stream` body back. That leg is
 * the only place the matching JSON-RPC response can arrive, so if it ends first,
 * the response is never coming. The question is whether the caller is told, or
 * whether the request sits in the pending map until its own timeout expires.
 *
 * Reported as
 * [modelcontextprotocol/typescript-sdk#2739](https://github.com/modelcontextprotocol/typescript-sdk/issues/2739)
 * on 2026-08-30, with a fix open at
 * [#2830](https://github.com/modelcontextprotocol/typescript-sdk/pull/2830). The
 * issue tests two hand-picked points: an errored body, and a clean EOF with no
 * frames at all. A cut here is a non-empty prefix, so the empty leg is the one
 * case this does not add — it is the case already reported. What it adds is every
 * point after that, including a leg that carried real traffic and a leg that died
 * inside the only frame that mattered.
 *
 * Read the summary below carefully, because it says zero and it is right. Every
 * cut here reports differently from the whole run, so nothing is lost silently —
 * the caller does find out. The defect is on the other axis: *when*. That is why
 * the table underneath carries a millisecond column, and why `lostContent` is
 * written against lateness rather than against disagreement.
 */
import { severAtEveryPoint, summarise, format } from '../src/index.js';
import { requireLatest } from './_versions.mjs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

await requireLatest(['@modelcontextprotocol/client'], { from: import.meta.url });

/** How long the request is allowed to wait, and what counts as being told. */
const TIMEOUT = 400;
const PROMPT = TIMEOUT / 2;

/**
 * The response leg, as network writes. A cut is a prefix of these. The response
 * frame is split so that one cut point lands inside it — a leg can die halfway
 * through the only frame that mattered.
 */
const chunks = (id) => [
  ': keepalive\n\n',
  'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"hi"}}\n\n',
  `event: message\ndata: {"jsonrpc":"2.0","id":${JSON.stringify(id)},"res`,
  'ult":{}}\n\n',
];

// Indexed by k. Slot 0 is never reached — a cut is a non-empty prefix — and is
// kept so the index lines up with the k column.
const WROTE = [
  '(empty leg, see the header)',
  'a comment frame',
  'an unrelated notification',
  'half of the response frame',
  'the whole response frame',
];

/**
 * Serve `prefix` on the request leg and then close it. The handshake is answered
 * as plain JSON on purpose, so the only event stream in the run is the one under
 * test and nothing else can settle the request.
 */
function transportFor(prefix) {
  return async (_url, init) => {
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    const body = JSON.parse(String(init?.body));
    const req = (Array.isArray(body) ? body : [body]).find((m) => m.id !== undefined);
    if (!req) return new Response(null, { status: 202 });

    if (req.method !== 'ping') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { logging: {} },
            serverInfo: { name: 'probe', version: '1.0.0' },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }

    return new Response(
      new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          for (const part of prefix) c.enqueue(enc.encode(part(req.id)));
          c.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
}

async function replay(prefix) {
  const notes = [];
  let streamEndSeen = false;

  const transport = new StreamableHTTPClientTransport(new URL('https://probe.test/mcp'), {
    fetch: transportFor(prefix),
  });
  const client = new Client({ name: 'probe', version: '1.0.0' }, { capabilities: {} });
  client.onerror = () => {};
  client.fallbackNotificationHandler = async (n) => void notes.push(n?.method ?? '?');

  await client.connect(transport);

  let settled = 'resolved';
  const started = Date.now();
  try {
    await client.ping({
      timeout: TIMEOUT,
      // Documented as the way a caller learns its request's stream ended.
      onRequestStreamEnd: () => void (streamEndSeen = true),
    });
  } catch (e) {
    settled = String(e?.code ?? e?.message ?? e).slice(0, 18);
  }
  const ms = Date.now() - started;
  // On the cut legs the callback fires before the request settles, but on a whole
  // leg the response resolves first and the stream ends just after — so reading
  // the flag the instant `ping` returns reports `false` there and makes it look
  // as though the callback is selective. It is not; it is later. Give it the
  // turn it needs before reading, or the column is an artefact of this file.
  await new Promise((r) => setTimeout(r, 40));
  try {
    await client.close();
  } catch {}

  return {
    // What the caller was actually handed while the leg was alive.
    delivered: notes,
    settled: JSON.stringify({ settled, waitedForTimeout: ms >= PROMPT }),
    ms,
    outcome: settled,
    streamEndSeen,
    toldPromptly: ms < PROMPT,
  };
}

// `chunks` needs the request id, which is only known inside replay, so the events
// are the writers rather than the bytes.
const EVENTS = chunks(0).map((_, i) => (id) => chunks(id)[i]);

const report = await severAtEveryPoint({ events: EVENTS, replay, label: 'streamable-http POST leg' });

console.log(
  format(
    summarise([report], {
      // The loss: the response is never coming and the caller is not told until
      // its own timeout fires.
      lostContent: (cut) => cut.outcome !== 'resolved' && !cut.toldPromptly,
    }),
  ),
);

const cuts = report.cuts ?? [];
console.log(
  '\n  Zero above is correct: every cut reports differently from the whole run, so' +
    '\n  nothing is lost silently. The question this one is really asking is when.\n',
);
console.log('  the leg is closed after writing…\n');
console.log('  k  written                      notifications seen     settled            ms    told promptly  caller callback');
for (const c of cuts) {
  const o = c.observation ?? {};
  console.log(
    `  ${String(c.k).padEnd(3)}${WROTE[c.k].padEnd(29)}${(o.delivered?.join(',') || '—').padEnd(23)}` +
      `${String(o.outcome).padEnd(19)}${String(o.ms).padEnd(6)}${String(o.toldPromptly).padEnd(15)}${o.streamEndSeen}`,
  );
}
const w = report.whole ?? {};
console.log(
  `  ${String(EVENTS.length).padEnd(3)}${WROTE[EVENTS.length].padEnd(29)}${(w.delivered?.join(',') || '—').padEnd(23)}` +
    `${String(w.outcome).padEnd(19)}${String(w.ms).padEnd(6)}${String(w.toldPromptly).padEnd(15)}${w.streamEndSeen}`,
);

const unanswered = cuts.filter((c) => c.observation?.outcome !== 'resolved');
const late = unanswered.filter((c) => !c.observation?.toldPromptly);

console.log('');
console.log(`  cuts where the response never arrived     : ${unanswered.length} of ${cuts.length}`);
console.log(`  of those, told only when the timeout fired : ${late.length}`);
console.log(`  the complete leg still resolves            : ${w.outcome === 'resolved'}`);
console.log('');
if (late.length === 0) {
  console.log('  No finding. Every leg that cannot deliver a response says so before the');
  console.log('  caller has to guess, and a complete leg is unaffected.');
} else {
  console.log('  The leg is gone and the caller waits out its whole timeout anyway — at every');
  console.log('  point, including the one where half the response had already been written.');
  console.log('  A caller that sets a generous timeout waits exactly that long to learn a');
  console.log('  fact the transport had in hand immediately.');
  console.log('');
  console.log('  The fix open at #2830 is eighteen lines in Protocol._requestWithSchemaViaCodec.');
  console.log('  To measure it instead of this, install the build that PR publishes:');
  console.log('');
  console.log('    npm i https://pkg.pr.new/@modelcontextprotocol/client@2830');
  console.log('');
  console.log('  and comment out the requireLatest call above, since that build reports its');
  console.log('  own base version rather than the current release.');
}
