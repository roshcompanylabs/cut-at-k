# The same question, asked of five implementations

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
| **Vercel AI SDK** `ai@7.0.118` | a cut that streamed text reports `finishReason: other`; a cut that streamed none raises instead | clean |
| **LangGraph JS** `@langchain/langgraph@1.4.18` | the checkpoint stops where the consumer stopped, `next` says where to resume, and the call raises | clean |
| **Mastra** `@mastra/core@1.71.0` | every cut that showed the consumer text still persisted it, and an error part raises | clean |
| **OpenAI Node** `openai@7.23.0` | `finalResponse()` still carries the tool call the consumer watched arrive, and `status` never says `completed` | clean |

Five asked, one answered wrongly. That ratio is the point: a harness that finds a
defect everywhere it looks is measuring itself.

One probe asks a different question, because the answer to this one turned out to
depend on something no cut can reach: [the line
terminator](#ag-ui-again--the-line-terminator-no-cut-can-reach).

Every probe that installs an SDK refuses to run against anything but the current
release, which is not caution for its own sake — see the Mastra section.

## AG-UI — the one with the finding

```bash
node results/run-ag-ui.mjs results/sever-results.json
```

Reads the committed recording rather than replaying, so it needs nothing installed.
48 streams, 227 cuts, 18 streams excluded as invalid on purpose; 154 cuts where the client
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

The model's stream is cut after k parts, so no `finish` part ever arrives. The whole
run reports `stop`, and a cut comes back to the caller in one of two shapes:

```
  cut  finishReason  error                     text === onFinish text
  1    —             AI_NoOutputGeneratedError true
  2    —             AI_NoOutputGeneratedError true
  3    other         —                         true
  4    other         —                         true
```

A cut that got text through reports `finishReason: other`. A cut that got none never
calls `onFinish` at all and raises `AI_NoOutputGeneratedError` instead. Either way the
caller can tell, and in every case the text that was streamed is the text `onFinish`
was handed, so display and persistence do not diverge.

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

## Mastra — clean, and the reason every probe checks its version

```bash
npm install @mastra/core @mastra/memory
node probes/mastra.mjs
```

Mastra's memory owns the saving, so a divergence here would be a defect in the thing
itself rather than in how a caller used it. Every cut that showed the consumer text
still persisted an assistant message; the two that persisted nothing had shown nothing,
which is not a loss. An `error` part raises rather than passing silently.

**An earlier run of this probe found the opposite, and it was wrong.** It measured
`@mastra/core@0.24.9` — published 2025-12-19, 882 releases behind — because
`npm install @mastra/core` silently resolved there: 1.71.0 declares
`engines: node >=22.13.0`, the machine was on Node 20, and npm picks the newest version
your Node satisfies and warns rather than failing. On that nine-month-old build a stream
ending with no `finish` part persisted nothing, and the finding was written up and two
edits from being filed. Which release changed it is not something this establishes —
only that the behaviour on the current one is correct.

`probes/_versions.mjs` now stops any probe whose install is not the current release. It
runs before the measurement rather than after, because a measurement of the wrong version
is not a weaker result, it is not a result — and the version line is the first thing a
maintainer checks.

It earned its keep a second time straight away. The Vercel row above read `ai@6.0.293`
until `ai@7` shipped, and re-running under the guard is what turned that row into the
two shapes it actually has.

## OpenAI Node — clean, on the half a client owns

```bash
npm install openai
node probes/openai-node.mjs
```

The question comes from
[openai-python#3561](https://github.com/openai/openai-python/issues/3561), open since
2026-07-31: aborting a streaming Responses request after a `function_call` item has
been streamed leaves that item unpersisted, so the next turn fails with a 400 because
the remote conversation has no record of the call the output belongs to.

That is the Python SDK, and the part that breaks is server-side state — reproducing it
needs a real conversation, so it is not what this measures. What this measures is the
half a client owns, in the Node SDK: after the cut, does `finalResponse()` still carry
the `function_call` the consumer watched arrive, and does `status` avoid claiming the
response completed. A caller that executes the tool locally is relying on both.

```
  cut  consumer saw the call   final.status   calls kept   threw
  1    false                 in_progress    0            —
  3    true                  in_progress    1            —
  6    true                  in_progress    1            —
```

All four cuts that showed the consumer a tool call still had it in `finalResponse()`,
none of the six reports `completed`, and none throws. The transport is a `fetch` the
probe supplies, so the frames are exactly the ones listed in the file and no key is
ever used.

## AG-UI again — the line terminator no cut can reach

```bash
npm install @ag-ui/client eventsource-parser
node probes/ag-ui-line-endings.mjs
```

The SSE grammar in the HTML standard admits three line terminators:

```
end-of-line = ( cr lf / cr / lf )
```

So `\r\n\r\n`, `\r\r` and `\n\n` are the same event boundary to a conformant reader.
This probe holds the events fixed and varies only that, over real HTTP, with
`eventsource-parser` alongside as a second implementation of the same grammar handed
the same bytes — the control is not this repo's reading of the standard.

```
  terminator                  conformant  @ag-ui/client  RUN_FINISHED  threw
  LF          \n\n            5           5              true          —
  CRLF        \r\n\r\n        5           0              false         Unexpected non-whitespace character after JSON
  CR          \r\r            5           0              false         Unexpected non-whitespace character after JSON
  CRLF field, LF blank        5           5              true          —
```

These are **complete** streams. Nothing is cut: the run is whole, and under two of the
three terminators the grammar allows, the client delivers no events at all and the
awaited call rejects with a JSON parse error.

`sse.ts` on main splits with `buffer.split(/\n\n/)`, so a `\r\n\r\n` boundary is never
found; the whole response accumulates, and the EOF flush then parses every frame
concatenated and throws. The docstring above that line reads "Strictly follows the SSE
standard". A CRLF field line joined by a bare LF blank line does work, which places the
defect in the boundary alone rather than in the field terminator.

The count does not degrade, it falls off a cliff:

```
  terminator                  k=1  k=2  k=3  k=4  k=5
  LF          \n\n            1    2    3    4    5
  CRLF        \r\n\r\n        1    0    0    0    0
```

One event is read correctly under every terminator, because with one event there is no
boundary to miss. The break needs two. A smoke test that sends a single frame passes.

This is why the summary reports the prefix property as broken on those two streams: a
one-event prefix delivers more than the whole run. That flag is the harness working —
it says "check this by hand before reporting it", and checking it by hand is what
produced the table above.

Status: the premise is already accepted in the project's own tracker.
[ag-ui#2439](https://github.com/ag-ui-protocol/ag-ui/issues/2439) states it — "a stream
using `\r\n` never completes a frame" — for the community Rust SDK, and
[#2500](https://github.com/ag-ui-protocol/ag-ui/pull/2500) fixes it there. The
TypeScript client has taken the other half of #2439, a 10 MB `MAX_BUFFER_SIZE` cap, and
not this half. `sse.test.ts` has fifteen tests and no case containing a carriage return.

## What these probes are not

Each is one library, one version, one shape of cut, driven through the mock the
library ships. They do not sweep a corpus the way the AG-UI run does, and a clean
verdict here means "not on this path", not "not anywhere". The versions are printed
by the probes themselves because the answers move with them.
