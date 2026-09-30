# The same question, asked of seven implementations

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
| **MCP TypeScript SDK** `@modelcontextprotocol/client@2.1.0` | the response can no longer arrive, and the caller is told only when its own timeout fires | **reported** |
| **OpenAI Python** `openai==3.22.1` | every cut raises rather than returning something that looks finished — but the call it accumulated is not reachable | clean |

Seven asked, five clean. Both of the two that answer wrongly were already reported by
someone else, which is the honest description of what this is for: the contribution
is the shape of a known defect, not its discovery. A harness that finds something
new everywhere it looks is measuring itself.

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

## MCP TypeScript SDK — reported, and the fix holds

```bash
npm install @modelcontextprotocol/client
node probes/mcp-streamable-http.mjs
```

A Streamable HTTP request can get a `text/event-stream` body back, and that leg is the
only place the matching JSON-RPC response can arrive. If it ends first, the response is
never coming. On `@modelcontextprotocol/client@2.1.0`, with a 400 ms timeout:

```
  k  written                      notifications seen     settled            ms    told promptly  caller callback
  1  a comment frame              —                      REQUEST_TIMEOUT    403   false          false
  2  an unrelated notification    notifications/message  REQUEST_TIMEOUT    406   false          false
  3  half of the response frame   notifications/message  REQUEST_TIMEOUT    402   false          false
  4  the whole response frame     notifications/message  resolved           8     true           false
```

One run. The millisecond figures move by a few either way; the 400 ms wall does not.

Reported as
[typescript-sdk#2739](https://github.com/modelcontextprotocol/typescript-sdk/issues/2739)
on 2026-08-30, with a fix open at
[#2830](https://github.com/modelcontextprotocol/typescript-sdk/pull/2830) — eighteen
lines threading the transport's existing `onRequestStreamEnd` into the request funnel.

**The summary prints zero lost, and that is right.** Every cut reports differently from
the whole run, so a caller can tell a dead leg from a live one. The defect is on the
other axis: *when*. That is the one case where reading only the summary would miss the
finding, which is why this probe carries a millisecond column and writes `lostContent`
against lateness.

What the issue's own reproduction tests is an errored body and a clean EOF with no frames
at all. Cutting at every point adds the rest, and two of those cells are worth having:
a leg that delivered real traffic first (k=2), and a leg that died inside the only frame
that mattered (k=3). Both behave the same as the empty leg, which is the useful answer —
partial progress does not change the outcome.

Running the same probe against the build that PR publishes:

```bash
npm i https://pkg.pr.new/@modelcontextprotocol/client@2830
```

```
  k  written                      notifications seen     settled            ms    told promptly  caller callback
  1  a comment frame              —                      CONNECTION_CLOSED  3     true           true
  2  an unrelated notification    notifications/message  CONNECTION_CLOSED  2     true           true
  3  half of the response frame   notifications/message  CONNECTION_CLOSED  1     true           true
  4  the whole response frame     notifications/message  resolved           7     true           true
```

That build reports `@modelcontextprotocol/client@2.0.0`, so it is compared against `2.0.0`
from npm and the eighteen lines are the only difference. Comparing it against `2.1.0`
instead — which is what a first attempt did — mixes in a release's worth of other changes
and is not a differential at all, however much the numbers happen to agree.

It settles promptly at every cut, and k=4 still resolves, which is the case the fix must
*not* fire on: the response arrived, the server then closed the leg as it always does, and
the `responseReceived` guard inside `cancel` holds.

One thing the fix does that neither the issue nor the PR description mentions: the caller's
own `onRequestStreamEnd` never fired at all before it — `false` on every row of the
published release, including the successful one, because `Protocol.request` never forwarded
the option. The same eighteen lines make a documented public option work for the first
time. It fires on success too, since a leg that delivered a response still ends, and that
is worth knowing before using it as a loss signal.

Reading that column takes care: on a cut leg the callback fires before the request settles,
but on a whole leg the response resolves first and the stream ends a moment later. A probe
that reads the flag the instant `ping` returns reports `false` there and makes the callback
look selective when it is only later. The first version of this one did exactly that.

## AG-UI a third time — two helpers that disagree about a valid stream

```bash
npm install @ag-ui/client rxjs
node probes/ag-ui-compact.mjs
```

`compactEvents()` buffers a `TOOL_CALL` or `TEXT_MESSAGE` group until its `*_END`, while
terminal events go straight out, so a group still open when the run ends is flushed after
the terminal. `verifyEvents()`, from the same package, rejects almost everything once a run
has closed. The invariant the two owe each other is simple: if `verifyEvents` accepts a
stream, it must accept `compactEvents(stream)`.

Reported as [ag-ui#2813](https://github.com/ag-ui-protocol/ag-ui/issues/2813) on
2026-09-22, with the user-visible half at
[CopilotKit#7368](https://github.com/CopilotKit/CopilotKit/issues/7368) — a thread whose
transcript never renders again for anyone — and a fix open at
[#2826](https://github.com/ag-ui-protocol/ag-ui/pull/2826).

Aborting one ordinary run at each point in turn, with the `RUN_ERROR` an abort actually
emits:

```
  k   groups open  raw stream  compacted  reordered  what verifyEvents said about the compacted form
  1   0            accepted    accepted   false      —
  2   1            accepted    REJECTED   true       Cannot send event type 'TEXT_MESSAGE_START': The run has a
  3   1            accepted    REJECTED   true       Cannot send event type 'TEXT_MESSAGE_START': The run has a
  4   1            accepted    REJECTED   true       Cannot send event type 'TEXT_MESSAGE_START': The run has a
  5   0            accepted    accepted   true       —
  6   1            accepted    REJECTED   true       Cannot send event type 'TOOL_CALL_START': The run has alre
  7   1            accepted    REJECTED   true       Cannot send event type 'TOOL_CALL_START': The run has alre
  8   0            accepted    accepted   true       —
  9   0            accepted    accepted   true       —
  10  1            accepted    REJECTED   true       Cannot send event type 'TOOL_CALL_START': The run has alre
  11  1            accepted    REJECTED   true       Cannot send event type 'TOOL_CALL_START': The run has alre
```

The `reordered` column is worth a glance: k=5, 8 and 9 are reordered and still accepted.
Compaction moves closed groups around too, harmlessly. Reordering is not the defect —
reordering *past a terminal event* is.

Seven of the eleven points break, the raw stream is valid at all eleven, and the seven are
exactly the seven where a group was open — the same set, no exceptions in either direction.

**The seven is not a rate.** It is a property of the run that was cut: one with groups open
for longer breaks at more points. The rule is what carries, and the report already states
the rule. What a sweep adds here is that it holds with no exceptions, and one thing the
report does not cover.

Every stream above closes each group before opening the next, so only ever one is pending.
The fix adds a `pendingStreamOrder` list precisely so that several pending groups flush in
the order they were opened — machinery that does nothing unless more than one is pending.
These are the streams where it does, and AG-UI accepts all three:

```
  stream                                   raw       compacted  order after compaction
  a tool opened while a message is open    accepted  REJECTED   R_STARTED,R_ERROR,TM_START,TM_CONTENT,TC_START,TC_ARGS
  two tool calls open at once              accepted  REJECTED   R_STARTED,R_ERROR,TC_START,TC_ARGS,TC_START,TC_ARGS
  a closed message, then a tool left open  accepted  REJECTED   R_STARTED,TM_START,TM_CONTENT,TM_END,R_ERROR,TC_START,TC_ARGS
```

## OpenAI Python — the same question in the language the report is filed in

```bash
cd probes/python
uv venv && uv pip install openai
.venv/Scripts/python openai_python.py     # or .venv/bin/python on Unix
```

The Node probe above answers for the Node SDK, and an OpenAI maintainer has said as much
on [openai-node#2571](https://github.com/openai/openai-node/issues/2571), closing it as
not planned. But [openai-python#3561](https://github.com/openai/openai-python/issues/3561)
is filed against the Python client, and nobody has measured that one.

```
  cut  wrote                  saw the call  get_final_response()  calls it gave  accumulated inside
  1    the response opened    False         RuntimeError          0              0 call(s) - status=-
  2    it is in progress      False         RuntimeError          0              0 call(s) - status=-
  3    a call is starting     True          RuntimeError          0              1 call(s) call_ABC status=in_progress
  4    its arguments arrive   True          RuntimeError          0              1 call(s) call_ABC status=in_progress
  5    its arguments finish   True          RuntimeError          0              1 call(s) call_ABC status=in_progress
  6    the call is done       True          RuntimeError          0              1 call(s) call_ABC status=in_progress
  7    the whole stream       True          completed             1              1 call(s) call_ABC status=in_progress
```

**Nothing fails silently.** Every cut raises `RuntimeError: Didn't receive a
'response.completed' event` rather than returning an object that could be mistaken for a
finished one. On the axis this repo usually measures, the Python client is clean, and
arguably louder than the Node one.

The difference is on another axis. The SDK **did** accumulate the call — on all four cuts
that showed one, `status=in_progress` with the `function_call` intact, name and arguments
and all. It is sitting in `_ResponseStreamState__current_snapshot`, and
`get_final_response()` is the only public accessor, and it raises. So a caller reconciling
state after an abort has nothing supported to read.

The Node SDK hands that same snapshot back: `finalResponse()` returns `status: in_progress`
carrying the call, on exactly the cuts where Python raises. Same accumulation, opposite
decision about whether the caller may see it.

That distinction is the point for #3561, where the whole difficulty is working out what
you were left holding after an abort. The probe reads the private attribute once, to
establish that the data exists rather than is lost — those are different claims and only
one of them is true here.

**One field in that snapshot is not what it looks like.** Every row above reads
`status=in_progress`, including cut 6, which arrived *after* `response.output_item.done`
carried `status: "completed"` for that item — and including the whole stream. The
snapshot's per-item status reflects `output_item.added` and is never updated by
`output_item.done`. On a complete run that is invisible, because `get_final_response()`
returns the terminal event's authoritative output instead, where the item does read
`completed`. On a cut there is no terminal event, so the snapshot is all there is, and the
one field that separates a call that already finished from one still mid-arguments is the
one field it does not carry.

The probe finishes by putting exactly those two calls side by side — the first has had its
`output_item.done`, the second is still mid-arguments at the cut:

```
    order  call_id   name      status        arguments
    0      call_ABC  transfer  in_progress   '{"amount":50000}'
    1      call_DEF  search    in_progress   '{"q":"ra'

    get_final_response(): RuntimeError
    both kept, in order, with distinct call_id : True
    call_ids that received output_item.done  : ['call_ABC']
    their status fields are indistinguishable : True
```

The `output_item.done` line is read out of the event list rather than asserted, so the
contradiction is visible in one place: `call_ABC` got its terminal item event, `call_DEF`
did not, and the field that should record the difference reads the same for both.

Both survive the cut with their own `call_id`, in order, arguments included down to the
half-written ones. Only the field that would tell them apart is the same for both.

## AG-UI, below the frame — the parser rather than the state machine

```bash
npm install @ag-ui/client rxjs
node probes/ag-ui-bytes.mjs
```

Every probe above severs *between* events, which tests the state machine: does the consumer
handle a run that stopped after three events rather than nine. This one severs *inside the
bytes*, which tests the parser underneath — a cut in the middle of a UTF-8 sequence, between
`data:` and its newline, or halfway through a JSON payload. They are different targets, and
a defect found in one says nothing about the other.

`severAtEveryByte` has been in `src/` since the start and no probe used it until someone
[asked](https://dev.to/roshcompanylabs/i-cut-six-streaming-sdks-at-every-point-nothing-i-found-was-new-2pbo)
whether the harness went below event boundaries. `seams()` picks the offsets rather than
sweeping all of them, because most bytes of a frame are unremarkable and the ones that break
things sit at structural marks. The run body is deliberately non-ASCII so a cut can land
mid-character:

```
  396 bytes, 124 seams worth cutting at

  where the cut landed        cuts  reported like the whole run  raised  saw RUN_FINISHED
  after a field colon         23    0                            23      0
  just inside an object       6     0                            6       0
  just inside a string        68    0                            68      0
  after a comma               12    0                            12      0
  between frame newlines      6     1                            0       1
  mid-UTF-8 sequence          9     0                            9       0

  cuts that report the same as the whole run: 1 of 124
  of those, with no terminal event          : 0
    @395 of 396  (between frame newlines)  (the body minus its trailing newline)
```

**No finding**, and the single row that reports like the whole run is the cut at byte 395 of
396 — the body minus its final newline, with all six frames intact. It is the whole run by
another name.

That is worth putting next to the CRLF result above, because together they draw the line the
question was about. Cut the bytes anywhere inside a frame and the parser refuses, including
all nine cuts that split an Arabic character in half. Keep every frame intact and change only
the byte that separates them, and it accepts nothing at all. The buffering is sound; what is
missing is that `\r\n\r\n` is a boundary.

## What these probes are not

Each is one library, one version, one shape of cut, driven through the mock the
library ships. They do not sweep a corpus the way the AG-UI run does, and a clean
verdict here means "not on this path", not "not anywhere". The versions are printed
by the probes themselves because the answers move with them.
