/**
 * LangGraph JS: when a run stops early, does the checkpoint still agree with
 * what the consumer was shown?
 *
 *   npm install @langchain/langgraph @langchain/core
 *   node probes/langgraph-js.mjs
 *
 * This is the one place the question has teeth, because the checkpointer owns
 * the saving. Elsewhere "what was saved" is the caller's business; here it is
 * the library's.
 *
 * Two ways a run can stop early, and they are not the same thing:
 *
 *   break   the consumer stops reading the stream. LangGraph is a durable
 *           execution engine, so the graph keeps going — leaving the loop is
 *           not a cancellation, and treating it as one would be the worse bug.
 *   abort   the consumer cancels through the AbortSignal it passed in.
 *
 * Only the second is a truncated run in the specification's sense. The first is
 * reported here because a reader will otherwise wonder, and because the gap
 * between the two is the thing worth knowing.
 */
import { StateGraph, Annotation, START, END, MemorySaver } from '@langchain/langgraph';

const State = Annotation.Root({
  steps: Annotation({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
});

const node = (name) => async () => {
  await new Promise((r) => setTimeout(r, 30));
  return { steps: [name] };
};

const build = () =>
  new StateGraph(State)
    .addNode('one', node('one'))
    .addNode('two', node('two'))
    .addNode('three', node('three'))
    .addEdge(START, 'one')
    .addEdge('one', 'two')
    .addEdge('two', 'three')
    .addEdge('three', END)
    .compile({ checkpointer: new MemorySaver() });

async function run(mode) {
  const app = build();
  const controller = new AbortController();
  const config = { configurable: { thread_id: 't' }, signal: controller.signal };

  const seen = [];
  let threw = null;
  try {
    let n = 0;
    for await (const chunk of await app.stream({ steps: [] }, config)) {
      seen.push(Object.keys(chunk)[0]);
      if (++n === 1) {
        if (mode === 'abort') controller.abort();
        if (mode === 'break') break;
      }
    }
  } catch (e) {
    threw = String(e?.name ?? e?.message).slice(0, 36);
  }

  // let anything still running settle before reading the checkpoint
  await new Promise((r) => setTimeout(r, 300));
  const state = await app.getState({ configurable: { thread_id: 't' } });

  return {
    mode,
    seen: seen.join(','),
    saved: (state?.values?.steps ?? []).join(','),
    next: (state?.next ?? []).join(',') || '—',
    threw,
  };
}

const rows = [];
for (const m of ['whole', 'abort', 'break']) rows.push(await run(m));

console.log(
  `@langchain/langgraph@${(await import('@langchain/langgraph/package.json', { with: { type: 'json' } })).default.version}\n`,
);
console.log('  mode    consumer saw      checkpoint holds   next     threw');
for (const r of rows) {
  console.log(
    `  ${r.mode.padEnd(7)} ${r.seen.padEnd(17)} ${r.saved.padEnd(18)} ${r.next.padEnd(8)} ${r.threw ?? '—'}`,
  );
}

const abort = rows.find((r) => r.mode === 'abort');
const stoppedWhereTheConsumerStopped = abort.saved === abort.seen;
const saysWhereToResume = abort.next !== '—';
const raised = abort.threw !== null;

console.log('');
console.log(`  on abort, the checkpoint stops where the consumer stopped : ${stoppedWhereTheConsumerStopped}`);
console.log(`  on abort, the state says where to resume                  : ${saysWhereToResume} (${abort.next})`);
console.log(`  on abort, the call raises                                 : ${raised} (${abort.threw})`);
console.log('');
console.log(
  stoppedWhereTheConsumerStopped && saysWhereToResume && raised
    ? '  No finding on the abort path: three independent signals, all correct.\n' +
        '  The `break` row is durable execution working as designed, not a defect —\n' +
        '  the graph finishes because nobody cancelled it.'
    : '  Look closer.',
);
