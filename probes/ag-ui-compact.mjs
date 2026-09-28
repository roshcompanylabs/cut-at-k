/**
 * AG-UI: two helpers from the same package, asked whether they agree.
 *
 *   npm install @ag-ui/client rxjs
 *   node probes/ag-ui-compact.mjs
 *
 * `compactEvents()` buffers a TOOL_CALL or TEXT_MESSAGE group until its `*_END`
 * arrives, while terminal events go straight out. A group still open when the
 * run ends is therefore flushed after the terminal. `verifyEvents()`, from the
 * same package, rejects almost everything once a run has closed. So there is an
 * invariant the two owe each other:
 *
 *   if verifyEvents accepts a stream, it must accept compactEvents(stream)
 *
 * Reported as [ag-ui#2813](https://github.com/ag-ui-protocol/ag-ui/issues/2813)
 * on 2026-09-22, with the user-visible half at
 * [CopilotKit#7368](https://github.com/CopilotKit/CopilotKit/issues/7368) — a
 * thread whose transcript never renders again — and a fix open at
 * [#2826](https://github.com/ag-ui-protocol/ag-ui/pull/2826).
 *
 * That report picks three streams by hand. This asks the same question at every
 * point a run can be cut, because the condition it names — "a run ends while a
 * tool call or an assistant message is still streaming" — is a set, not a case,
 * and how big the set is decides how much the defect matters.
 */
import { severAtEveryPoint, summarise, format } from '../src/index.js';
import { requireLatest } from './_versions.mjs';
import { compactEvents, verifyEvents } from '@ag-ui/client';
import { from, lastValueFrom, toArray } from 'rxjs';

await requireLatest(['@ag-ui/client'], { from: import.meta.url });

/** What `abortRun()` puts on the wire when a run is stopped. */
const ABORT = { type: 'RUN_ERROR', message: 'This operation was aborted', code: 'ABORTED' };

/** A run with both kinds of group, in an order every prefix leaves valid. */
const EVENTS = [
  { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
  { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Transferring ' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: '$50,000' },
  { type: 'TEXT_MESSAGE_END', messageId: 'm' },
  { type: 'TOOL_CALL_START', toolCallId: 'a', toolCallName: 'search' },
  { type: 'TOOL_CALL_ARGS', toolCallId: 'a', delta: '{}' },
  { type: 'TOOL_CALL_END', toolCallId: 'a' },
  { type: 'TOOL_CALL_RESULT', toolCallId: 'a', messageId: 'a-res', role: 'tool', content: '{}' },
  { type: 'TOOL_CALL_START', toolCallId: 'b', toolCallName: 'transfer' },
  { type: 'TOOL_CALL_ARGS', toolCallId: 'b', delta: '{"amount":5' },
];

const accepts = async (events) => {
  try {
    await lastValueFrom(from(events).pipe(verifyEvents(false), toArray()));
    return null;
  } catch (e) {
    return String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 58);
  }
};

/**
 * Cut the run at k and terminate it the way an abort does, then ask both
 * helpers about the result. The raw stream is the control: a prefix that is
 * already invalid says nothing about whether compacting made it worse.
 */
async function replay(prefix) {
  const cut = [...prefix, ABORT];
  const rawError = await accepts(cut);

  let compacted = null;
  let compactError = null;
  let threw = null;
  try {
    compacted = compactEvents(cut);
    compactError = await accepts(compacted);
  } catch (e) {
    threw = String(e?.message ?? e).slice(0, 40);
  }

  const open =
    prefix.filter((e) => e.type.endsWith('_START')).length -
    prefix.filter((e) => e.type.endsWith('_END')).length;

  return {
    delivered: prefix.map((p) => p.type),
    settled: JSON.stringify({ rawError, compactError, threw }),
    rawOk: rawError === null,
    compactOk: compactError === null && threw === null,
    moved: compacted ? compacted.map((e) => e.type).join(',') !== cut.map((e) => e.type).join(',') : false,
    openGroups: open,
    compactError: compactError ?? threw,
  };
}

const report = await severAtEveryPoint({ events: EVENTS, replay, label: 'compactEvents' });

console.log(
  format(
    summarise([report], {
      // The loss: the library's own verifier accepts the stream and refuses the
      // compacted form of the same stream.
      lostContent: (cut) => cut.rawOk && !cut.compactOk,
    }),
  ),
);

const all = [...(report.cuts ?? []), { k: EVENTS.length, observation: report.whole }];
console.log('\n  the run is aborted after event k\n');
console.log('  k   groups open  raw stream  compacted  reordered  what verifyEvents said about the compacted form');
for (const c of all) {
  const o = c.observation ?? {};
  console.log(
    `  ${String(c.k).padEnd(4)}${String(o.openGroups ?? 0).padEnd(13)}` +
      `${(o.rawOk ? 'accepted' : 'rejected').padEnd(12)}${(o.compactOk ? 'accepted' : 'REJECTED').padEnd(11)}` +
      `${String(o.moved).padEnd(11)}${o.compactError ?? '—'}`,
  );
}

const broken = all.filter((c) => c.observation?.rawOk && !c.observation?.compactOk);
const openAtCut = all.filter((c) => (c.observation?.openGroups ?? 0) > 0);

console.log('');
console.log(`  cut points where the raw stream is valid        : ${all.filter((c) => c.observation?.rawOk).length} of ${all.length}`);
console.log(`  of those, compacting produces an invalid one    : ${broken.length}`);
console.log(`  cut points with a group still open             : ${openAtCut.length}`);
console.log(`  the two sets are the same set                  : ${broken.length === openAtCut.length && broken.every((b) => (b.observation?.openGroups ?? 0) > 0)}`);
console.log('');
console.log('  The count is a property of this run, not a rate — a run with more groups');
console.log('  open for longer breaks at more points. The rule underneath is what carries:');
console.log('  a group open at the terminal, exactly that, with no exceptions either way.');

/**
 * Every stream above closes each group before opening the next, so only ever one
 * is pending. That is the easy half. The fix open at #2826 adds an explicit
 * `pendingStreamOrder` list so that groups are flushed in the order they were
 * opened, across both of its maps — machinery that does nothing at all unless
 * more than one stream is pending at once. These are the streams where it does.
 */
const CONCURRENT = {
  'a tool opened while a message is open': [
    { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
    { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'thinking' },
    { type: 'TOOL_CALL_START', toolCallId: 'a', toolCallName: 'edit' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'a', delta: '{' },
  ],
  'two tool calls open at once': [
    { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
    { type: 'TOOL_CALL_START', toolCallId: 'a', toolCallName: 'search' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'a', delta: '{' },
    { type: 'TOOL_CALL_START', toolCallId: 'b', toolCallName: 'edit' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'b', delta: '{' },
  ],
  'a closed message, then a tool left open': [
    { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
    { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'ok' },
    { type: 'TEXT_MESSAGE_END', messageId: 'm' },
    { type: 'TOOL_CALL_START', toolCallId: 'a', toolCallName: 'edit' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'a', delta: '{' },
  ],
};

const short = (t) =>
  t.replace('TEXT_MESSAGE_', 'TM_').replace('TOOL_CALL_', 'TC_').replace('RUN_', 'R_');

console.log('\n  more than one stream pending at the terminal\n');
console.log('  stream                                   raw       compacted  order after compaction');
for (const [name, events] of Object.entries(CONCURRENT)) {
  const cut = [...events, ABORT];
  const rawError = await accepts(cut);
  const compacted = compactEvents(cut);
  const compactError = await accepts(compacted);
  console.log(
    `  ${name.padEnd(41)}${(rawError === null ? 'accepted' : 'rejected').padEnd(10)}` +
      `${(compactError === null ? 'accepted' : 'REJECTED').padEnd(11)}${compacted.map((e) => short(e.type)).join(',')}`,
  );
}

console.log('');
if (broken.length === 0) {
  console.log('  No finding. Compacting never turns a stream the verifier accepts into one');
  console.log('  it refuses.');
} else {
  console.log('  Every one of these is a stream the verifier accepts and refuses after');
  console.log('  compacting, and there is nothing unusual about any of them: a stop, a');
  console.log('  dropped upstream and a client disconnect all land here.');
  console.log('');
  console.log('  The three at the bottom are the ones worth keeping. A group open at the');
  console.log('  terminal is already the reported case; two of them open at once is the');
  console.log('  case that decides whether an ordering fix ordered anything.');
}
