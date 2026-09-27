# The same question, asked of three implementations

When a run stops early, can the consumer tell — and does what it was shown still
agree with what was saved?

Each probe drives the library rather than reimplementing it: everything specific to
the SDK lives in one `replay` function, and the loop, the comparison and the report
come from `severAtEveryPoint` and `summarise`. To point this at something else, copy
the shortest one and change `replay` and the `lostContent` predicate. Nothing else.

They sit outside `files`, so the published package keeps its zero dependencies while
each probe pulls in the SDK it tests. Install that first.

```js
const report = await severAtEveryPoint({ events, replay, label: 'my-client' });
console.log(format(summarise([report], { lostContent: (cut, whole) => /* ... */ })));
```

`replay(prefix)` runs one prefix through your client and returns what the caller was
left with: `delivered` (the event types it surfaced), `settled` (how the awaited call
reported, as a string), and anything else you want carried into `lostContent`.

| | when the run is cut | verdict |
|---|---|---|
| **AG-UI** `@ag-ui/client@1.0.0` | the awaited call resolves with what a completed run resolves with | **reported** |
| **Vercel AI SDK** `ai@6.0.293` | `finishReason` is `other` instead of `stop`, and the text streamed is the text handed to `onFinish` | clean |
| **LangGraph JS** `@langchain/langgraph@1.4.18` | the checkpoint stops where the consumer stopped, `next` says where to resume, and the call raises | clean |

Three asked, one answered wrongly. That ratio is the point: a harness that finds a
defect everywhere it looks is measuring itself.

## AG-UI — the one with the finding

```bash
node results/run-ag-ui.mjs results/sever-results.json
```

Reads the committed recording rather than replaying, so it needs nothing installed.
48 streams, 227 cuts, 18 excluded as invalid on purpose; 154 cuts where the client
reported the same as the whole run, 54 of those where something was actually lost,
52 of those with no terminal event either.

Already reported by someone else as
[ag-ui#2300](https://github.com/ag-ui-protocol/ag-ui/issues/2300) on 2026-08-03, with
a fix open at [#2354](https://github.com/ag-ui-protocol/ag-ui/pull/2354). What this
harness added was the frequency, and then
[a false positive in that fix](https://github.com/ag-ui-protocol/ag-ui/pull/2354#issuecomment-5849020368):
its cancellation exemption does not survive a stop-and-resend.

## Vercel AI SDK — clean, and the shortest adapter to copy

```bash
npm install ai
node probes/vercel-ai-sdk.mjs
```

The model's stream is cut after k parts, so no `finish` part ever arrives. The
complete run reports `stop`; every cut run reports `other`. A caller that checks
`finishReason` can tell, and the text that was streamed is the text `onFinish` was
handed, so display and persistence do not diverge.

Worth knowing while reading the probe: the provider stream part carries
`finishReason: { unified: 'stop' }`, while `onFinish` receives the unwrapped string.
Reading `.unified` off the callback value gives `undefined` — which is how the first
version of this probe was wrong, and why the whole run is there as a control.

## LangGraph JS — clean, with a distinction worth keeping

```bash
npm install @langchain/langgraph @langchain/core
node probes/langgraph-js.mjs
```

This is the one place the question has real teeth, because the checkpointer owns the
saving. Elsewhere "what was saved" is the caller's business; here it is the library's.

The cut here is an abort after k chunks rather than a prefix of a recorded stream,
because the graph produces its own events and cancelling is the only way to stop it
early. Two different things can stop a run early:

```
  mode    consumer saw      checkpoint holds   next     threw
  whole   one,two,three     one,two,three      —        —
  abort   one               one                two      AbortError
  break   one               one,two,three      —        —
```

On **abort** — the consumer cancels through the `AbortSignal` it passed in — the
checkpoint stops exactly where the consumer stopped, `next` names the node to resume
from, and the call raises. Three independent signals, all correct.

On **break** — the consumer stops reading the loop — the graph runs to completion and
the checkpoint holds all three steps. That is durable execution working as designed,
not a defect: leaving a `for await` is not a cancellation, and treating it as one
would be the worse bug. It is listed because a reader will otherwise wonder, and
because the gap between the two is the thing worth knowing.

## What these probes are not

Each is one library, one version, one shape of cut, driven through the mock the
library ships. They do not sweep a corpus the way the AG-UI run does, and a clean
verdict here means "not on this path", not "not anywhere". The versions are printed
by the probes themselves because the answers move with them.
