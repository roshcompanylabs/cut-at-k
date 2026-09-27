/**
 * OpenAI Node SDK: when a Responses stream is cut, what is the caller left
 * holding — and does anything say the response was incomplete?
 *
 *   npm install openai
 *   node probes/openai-node.mjs
 *
 * The question comes from openai-python#3561, open since 2026-07-31: aborting a
 * streaming Responses request after a `function_call` item has been streamed
 * leaves that item unpersisted, and the next turn fails with a 400 because the
 * remote conversation has no record of the call its output belongs to.
 *
 * That half is server-side and needs a real conversation, so it is not what this
 * measures. What this measures is the half a client owns: after the cut, does
 * `finalResponse()` still carry the function_call the consumer watched arrive,
 * and does `status` say the response never completed. A caller that executes the
 * tool locally is relying on both.
 */
import { requireLatest } from './_versions.mjs';
import { severAtEveryPoint, summarise, format } from '../src/index.js';
import OpenAI from 'openai';

await requireLatest(['openai'], { from: import.meta.url });

const RESPONSE = {
  id: 'resp_1',
  object: 'response',
  created_at: 1,
  status: 'in_progress',
  model: 'm',
  output: [],
  parallel_tool_calls: false,
  tool_choice: 'auto',
  tools: [],
};

const CALL = {
  id: 'fc_1',
  type: 'function_call',
  call_id: 'call_ABC',
  name: 'transfer',
  arguments: '{"amount":50000}',
  status: 'completed',
};

/** The stream, in order. A cut is a prefix of this. */
const EVENTS = [
  { type: 'response.created', response: RESPONSE, sequence_number: 0 },
  { type: 'response.in_progress', response: RESPONSE, sequence_number: 1 },
  {
    type: 'response.output_item.added',
    item: { ...CALL, arguments: '', status: 'in_progress' },
    output_index: 0,
    sequence_number: 2,
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_1',
    output_index: 0,
    delta: '{"amount":50000}',
    sequence_number: 3,
  },
  {
    type: 'response.function_call_arguments.done',
    item_id: 'fc_1',
    output_index: 0,
    arguments: '{"amount":50000}',
    sequence_number: 4,
  },
  { type: 'response.output_item.done', item: CALL, output_index: 0, sequence_number: 5 },
  {
    type: 'response.completed',
    response: { ...RESPONSE, status: 'completed', output: [CALL] },
    sequence_number: 6,
  },
];

/** A transport that serves exactly these events and then closes, cleanly. */
const transportFor = (events) => async () =>
  new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const e of events) {
          controller.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

async function replay(prefix) {
  const client = new OpenAI({ apiKey: 'probe', fetch: transportFor(prefix) });

  const seen = [];
  let final = null;
  let threw = null;
  try {
    const stream = client.responses.stream({ model: 'm', input: 'hi' });
    for await (const event of stream) seen.push(event.type);
    final = await stream.finalResponse();
  } catch (e) {
    threw = String(e?.message ?? e).slice(0, 52);
  }

  const calls = (final?.output ?? []).filter((o) => o.type === 'function_call');
  return {
    delivered: seen,
    settled: JSON.stringify({ status: final?.status ?? null, threw }),
    sawCall: seen.some((t) => t.includes('function_call') || t.includes('output_item')),
    keptCalls: calls.length,
    status: final?.status ?? null,
    threw,
  };
}

const report = await severAtEveryPoint({ events: EVENTS, replay, label: 'responses.stream' });

console.log(
  format(
    summarise([report], {
      // The loss: the consumer watched a tool call arrive and the final response
      // does not carry it.
      lostContent: (cut) => cut.sawCall && cut.keptCalls === 0,
    }),
  ),
);

const cuts = report.cuts ?? [];
console.log('\n  cut  consumer saw the call   final.status   calls kept   threw');
for (const c of cuts) {
  const o = c.observation ?? {};
  console.log(
    `  ${String(c.k).padEnd(5)}${String(o.sawCall).padEnd(22)}${String(o.status).padEnd(15)}` +
      `${String(o.keptCalls).padEnd(13)}${o.threw ?? '—'}`,
  );
}

const watchedACall = cuts.filter((c) => c.observation?.sawCall);
const keptIt = watchedACall.filter((c) => (c.observation?.keptCalls ?? 0) > 0);
const saysIncomplete = cuts.every((c) => c.observation?.status !== 'completed');

console.log('');
console.log(`  cuts where the consumer watched a call arrive : ${watchedACall.length}`);
console.log(`  of those, the final response kept it          : ${keptIt.length}`);
console.log(`  no cut claims the response completed          : ${saysIncomplete}`);
