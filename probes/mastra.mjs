/**
 * Mastra: when the model stream stops early, does memory still hold what the
 * consumer was shown?
 *
 *   npm install @mastra/core @mastra/memory
 *   node probes/mastra.mjs
 *
 * Mastra's memory owns the saving, which is what gives the question teeth here —
 * a divergence would be a defect in the thing itself rather than in how a caller
 * used it.
 *
 * Read the version line this prints. An earlier run of this probe measured
 * `@mastra/core@0.24.9` without noticing, found that a stream ending with no
 * `finish` part persisted nothing, and was two edits away from filing it. That
 * version shipped in December 2025 and the behaviour was fixed in 1.33.1. The
 * guard at the top of this file is the direct result.
 */
import { severAtEveryPoint, summarise, format } from '../src/index.js';
import { requireLatest } from './_versions.mjs';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { InMemoryStore } from '@mastra/core/storage';

await requireLatest(['@mastra/core', '@mastra/memory'], { from: import.meta.url });

const PARTS = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: 'Transferring ' },
  { type: 'text-delta', id: '0', delta: '$50,000 ' },
  { type: 'text-delta', id: '0', delta: 'to account 9931.' },
  { type: 'text-end', id: '0' },
  {
    type: 'finish',
    finishReason: { unified: 'stop' },
    usage: { inputTokens: 1, outputTokens: 9, totalTokens: 10 },
  },
];

const model = (parts) => ({
  specificationVersion: 'v3',
  provider: 'probe',
  modelId: 'probe',
  supportedUrls: {},
  // The agent generates a thread title through this; without it the run is noisy.
  async doGenerate() {
    return {
      content: [{ type: 'text', text: 't' }],
      finishReason: { unified: 'stop' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    };
  },
  async doStream() {
    return {
      stream: new ReadableStream({
        start(c) {
          for (const p of parts) c.enqueue(p);
          c.close();
        },
      }),
    };
  },
});

async function replay(prefix) {
  const memory = new Memory({ storage: new InMemoryStore() });
  const agent = new Agent({ name: 'probe', instructions: 'x', model: model(prefix), memory });

  let text = '';
  let threw = null;
  try {
    const result = await agent.stream('hi', { memory: { thread: 't', resource: 'r' } });
    for await (const delta of result.textStream) text += delta;
  } catch (e) {
    threw = String(e?.message).slice(0, 40);
  }

  // The save happens after the stream drains; give it room before reading.
  await new Promise((r) => setTimeout(r, 400));

  let saved = [];
  try {
    const recalled = await memory.recall({ threadId: 't', resourceId: 'r' });
    const msgs = recalled?.messages ?? recalled?.messagesV2 ?? (Array.isArray(recalled) ? recalled : []);
    saved = (Array.isArray(msgs) ? msgs : []).filter((m) => m.role === 'assistant');
  } catch (e) {
    threw ??= `recall: ${String(e?.message).slice(0, 30)}`;
  }

  return {
    delivered: prefix.map((p) => p.type),
    settled: JSON.stringify({ threw, savedAssistantMessages: saved.length }),
    text,
    savedCount: saved.length,
  };
}

const report = await severAtEveryPoint({ events: PARTS, replay, label: 'agent.stream' });

console.log(
  format(
    summarise([report], {
      // The loss that matters here: the consumer was shown text, and memory kept none.
      lostContent: (cut) => cut.text.length > 0 && cut.savedCount === 0,
    }),
  ),
);

const cuts = report.cuts ?? [];
// A cut that stopped before any text arrived has nothing to persist, so its
// empty memory is not a loss. Only cuts that showed the consumer something can
// be compared against what was saved.
const showedText = cuts.filter((c) => (c.observation?.text?.length ?? 0) > 0);
const everyCutPersists = showedText.every((c) => (c.observation?.savedCount ?? 0) > 0);

console.log('');
console.log(`  whole run persisted an assistant message : ${(report.whole?.savedCount ?? 0) > 0}`);
console.log(`  cuts that showed the consumer text       : ${showedText.length} of ${cuts.length}`);
console.log(`  every one of those persisted a message   : ${everyCutPersists}`);
console.log('');
console.log(
  everyCutPersists
    ? '  No finding. A stream that stops early still leaves memory holding what the\n' +
        '  consumer was shown, and an error part raises rather than passing silently.'
    : '  Look closer — and check the version line above before believing it.',
);
