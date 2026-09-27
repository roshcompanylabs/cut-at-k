/**
 * LangGraph JS, through this library.
 *
 *   npm install @langchain/langgraph @langchain/core
 *   node probes/langgraph-js.mjs
 *
 * This is the one place the question has real teeth, because the checkpointer
 * owns the saving. Elsewhere "what was saved" is the caller's business; here it
 * is the library's, so a divergence would be a defect in the thing itself.
 *
 * The cut here is an abort after k chunks, not a prefix of a recorded stream:
 * the graph produces its own events, so the only way to stop it early is to
 * cancel it. That is also the only stop that counts. A consumer that just leaves
 * the `for await` has not cancelled anything — LangGraph is a durable execution
 * engine and the graph keeps going, which is correct and is checked separately
 * at the bottom.
 */
import { severAtEveryPoint, summarise, format } from '../src/index.js';
import { StateGraph, Annotation, START, END, MemorySaver } from '@langchain/langgraph';

const State = Annotation.Root({
  steps: Annotation({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
});

const NODES = ['one', 'two', 'three'];

const node = (name) => async () => {
  await new Promise((r) => setTimeout(r, 30));
  return { steps: [name] };
};

const build = () => {
  let g = new StateGraph(State);
  for (const n of NODES) g = g.addNode(n, node(n));
  g = g.addEdge(START, NODES[0]);
  for (let i = 1; i < NODES.length; i++) g = g.addEdge(NODES[i - 1], NODES[i]);
  return g.addEdge(NODES.at(-1), END).compile({ checkpointer: new MemorySaver() });
};

/**
 * Run the graph and cancel after `prefix.length` chunks, then read the
 * checkpoint. A prefix as long as the whole stream means no cancellation.
 */
async function replay(prefix) {
  const app = build();
  const controller = new AbortController();
  const config = { configurable: { thread_id: 't' }, signal: controller.signal };
  const cancelAfter = prefix.length < NODES.length ? prefix.length : Infinity;

  const seen = [];
  let threw = null;
  try {
    let n = 0;
    for await (const chunk of await app.stream({ steps: [] }, config)) {
      seen.push(Object.keys(chunk)[0]);
      if (++n >= cancelAfter) controller.abort();
    }
  } catch (e) {
    threw = String(e?.name ?? e?.message).slice(0, 36);
  }

  await new Promise((r) => setTimeout(r, 300));
  const state = await app.getState({ configurable: { thread_id: 't' } });

  return {
    delivered: seen,
    settled: JSON.stringify({ threw, next: (state?.next ?? []).join(',') || null }),
    saved: (state?.values?.steps ?? []).join(','),
    seen: seen.join(','),
  };
}

const report = await severAtEveryPoint({ events: NODES, replay, label: 'graph' });

const version = (await import('@langchain/langgraph/package.json', { with: { type: 'json' } }))
  .default.version;
console.log(`@langchain/langgraph@${version}\n`);
console.log(
  format(
    summarise([report], {
      // The checkpoint diverging from what the consumer was shown is the loss.
      lostContent: (cut) => cut.saved !== cut.seen,
    }),
  ),
);

const cuts = report.cuts ?? [];
const stopsWhereTheConsumerStopped = cuts.every((c) => c.observation?.saved === c.observation?.seen);
const saysWhereToResume = cuts.every((c) => JSON.parse(c.observation?.settled ?? '{}').next);
const raises = cuts.every((c) => JSON.parse(c.observation?.settled ?? '{}').threw);

console.log('');
console.log(`  on abort, the checkpoint stops where the consumer stopped : ${stopsWhereTheConsumerStopped}`);
console.log(`  on abort, the state says where to resume                  : ${saysWhereToResume}`);
console.log(`  on abort, the call raises                                 : ${raises}`);

// The other way a run stops early, checked once because a reader will wonder.
const app = build();
const seen = [];
for await (const chunk of await app.stream({ steps: [] }, { configurable: { thread_id: 'b' } })) {
  seen.push(Object.keys(chunk)[0]);
  break;
}
await new Promise((r) => setTimeout(r, 300));
const after = await app.getState({ configurable: { thread_id: 'b' } });
console.log(
  `\n  leaving the loop without cancelling: consumer saw ${seen.join(',')}, ` +
    `checkpoint holds ${(after?.values?.steps ?? []).join(',')}`,
);
console.log('  That is durable execution working as designed, not a defect — the graph');
console.log('  finishes because nobody cancelled it.');
console.log('');
console.log(
  stopsWhereTheConsumerStopped && saysWhereToResume && raises
    ? '  No finding on the abort path: three independent signals, all correct.'
    : '  Look closer.',
);
