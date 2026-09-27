/**
 * Vercel AI SDK: does a stream that ends early leave the caller unable to tell?
 *
 *   npm install ai
 *   node probes/vercel-ai-sdk.mjs
 *
 * The model's stream is cut after k parts, so the run ends with no `finish` part
 * — the specification case of a truncated run. The question is not whether the
 * tail is lost; it is whether anything the caller can read says so.
 *
 * Two shapes, and they are not the same: the provider stream part carries
 * `finishReason: { unified: 'stop' }`, while `onFinish` is handed the unwrapped
 * string. Reading `.unified` off the callback value gives undefined.
 *
 * The whole run is the control. If it does not come back clean, the cut runs
 * mean nothing — both mistakes above were caught that way, once by passing a
 * V2-style string to a V3 model and once by reading the wrong shape here.
 */
import { streamText } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';

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

async function run(cutAfter) {
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream(
        cutAfter === null ? PARTS : PARTS.slice(0, cutAfter),
      ),
    }),
  });

  let finished = null;
  let errored = null;
  const result = streamText({
    model,
    prompt: 'x',
    onFinish: (e) => {
      finished = { finishReason: e.finishReason, text: e.text };
    },
    onError: (e) => {
      errored = String(e?.error?.message ?? e?.error).slice(0, 48);
    },
  });

  let seen = '';
  try {
    for await (const delta of result.textStream) seen += delta;
  } catch (e) {
    errored ??= 'textStream threw';
  }
  await new Promise((r) => setTimeout(r, 60));

  return { cutAfter, seen, finished, errored };
}

const rows = [];
for (const k of [null, 6, 5, 4, 3, 2]) rows.push(await run(k));

const whole = rows[0];
console.log(`ai@${(await import('ai/package.json', { with: { type: 'json' } })).default.version}\n`);
console.log('  cut   finishReason   text seen                       text handed to onFinish');
for (const r of rows) {
  console.log(
    `  ${String(r.cutAfter ?? 'none').padEnd(5)} ` +
      `${String(r.finished?.finishReason ?? '—').padEnd(14)} ` +
      `${JSON.stringify(r.seen).padEnd(42)} ${JSON.stringify(r.finished?.text ?? null)}` +
      (r.errored ? `  err=${r.errored}` : ''),
  );
}

const cuts = rows.slice(1);
const distinguishable = cuts.every(
  (r) => r.finished?.finishReason !== whole.finished?.finishReason,
);
const displayMatchesSaved = rows.every((r) => r.seen === (r.finished?.text ?? ''));

console.log('');
console.log(`  whole run reports              : ${whole.finished?.finishReason}`);
console.log(`  every cut run reports something else: ${distinguishable}`);
console.log(`  what was streamed === what onFinish was handed: ${displayMatchesSaved}`);
console.log('');
console.log(
  distinguishable && displayMatchesSaved
    ? '  No finding. The caller can tell a cut run from a complete one, and the\n' +
        '  text it displayed is the text it was asked to persist.'
    : '  Look closer.',
);
