/**
 * Vercel AI SDK, through this library rather than beside it.
 *
 *   npm install ai
 *   node probes/vercel-ai-sdk.mjs
 *
 * This is the shortest complete adapter, and it is here to be copied. Everything
 * specific to the SDK lives in `replay`; the loop, the comparison and the report
 * come from the library. To point it at something else, change `replay` and the
 * `lostContent` predicate and nothing else.
 *
 * Two shapes that are easy to get wrong: the provider stream part carries
 * `finishReason: { unified: 'stop' }`, while `onFinish` is handed the unwrapped
 * string. The whole run is the control in every probe — if it does not come back
 * clean, the cut runs mean nothing, and both mistakes above were caught that way.
 */
import { severAtEveryPoint, summarise, format } from '../src/index.js';
import { requireLatest } from './_versions.mjs';
import { streamText } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';

await requireLatest(['ai'], { from: import.meta.url });

/** The stream, in order. A cut is a prefix of this. */
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

/**
 * Run one prefix through a real `streamText` and report what the caller was left
 * with. `delivered` and `settled` are the two fields the library interprets; the
 * rest ride along for the predicate and the table below.
 */
async function replay(prefix) {
  const model = new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream(prefix) }),
  });

  let finishReason = null;
  let handed = null;
  let errored = null;
  let errorName = null;

  const result = streamText({
    model,
    prompt: 'x',
    onFinish: (e) => {
      finishReason = e.finishReason;
      handed = e.text;
    },
    onError: (e) => {
      errored = String(e?.error?.message ?? e?.error).slice(0, 60);
      errorName ??= e?.error?.name ?? null;
    },
  });

  let text = '';
  try {
    for await (const delta of result.textStream) text += delta;
  } catch {
    errored ??= 'textStream threw';
  }
  await new Promise((r) => setTimeout(r, 60));

  return {
    delivered: prefix.map((p) => p.type),
    // How the awaited call reported. This is what "reported the same as the whole
    // run" compares, so it has to carry every channel the caller could read.
    settled: JSON.stringify({ finishReason, errored }),
    text,
    handed,
    finishReason,
    errorName,
  };
}

const report = await severAtEveryPoint({ events: PARTS, replay, label: 'streamText' });

console.log(
  format(
    summarise([report], {
      // Content is lost when the text this cut produced differs from the whole run's.
      lostContent: (cut, whole) => cut.text !== whole.text,
    }),
  ),
);

// What the summary cannot see, because it is specific to this SDK. A cut reaches
// the caller in one of two shapes depending on whether any text got through, and
// the table is here so the claim in probes/README.md can be checked against it.
const cuts = report.cuts ?? [];

console.log('');
console.log('  cut  finishReason  error                     text === onFinish text');
for (const c of cuts) {
  const o = c.observation ?? {};
  console.log(
    `  ${String(c.k).padEnd(5)}${String(o.finishReason ?? '—').padEnd(14)}` +
      `${String(o.errorName ?? '—').padEnd(26)}${o.text === (o.handed ?? '')}`,
  );
}

const differs = cuts.every((c) => c.observation?.settled !== report.whole?.settled);
const displayIsWhatIsPersisted = [report.whole, ...cuts.map((c) => c.observation)]
  .filter(Boolean)
  .every((o) => o.text === (o.handed ?? ''));

console.log('');
console.log(`  the whole run reports                           : ${report.whole?.finishReason}`);
console.log(`  every cut reports differently from the whole run : ${differs}`);
console.log(`  what was streamed is what onFinish was handed    : ${displayIsWhatIsPersisted}`);
console.log('');
if (differs && displayIsWhatIsPersisted) {
  console.log('  No finding. The caller can tell a cut run from a complete one — by a');
  console.log('  finishReason of `other` where text got through, or by the error raised');
  console.log('  where none did — and what it displayed is what it was asked to persist.');
} else {
  console.log('  Look closer.');
}
