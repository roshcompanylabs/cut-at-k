# cut-at-k

Cut a stream at every point and check what the consumer is left with.

A stream that stops early is not a rare case. A connection drops, a proxy times out,
a producer dies, someone presses stop. So take the same stream, run it through your
client once whole and once for every prefix of it, and ask two questions of each cut:

- **Did the head change?** Truncation may lose the tail. It must never alter what came
  before the cut.
- **Does the consumer say so?** A run that was cut short must not report what the same
  run reports when it finishes.

The second one is where things are usually wrong, and it is quiet when it is wrong,
which is why a loop is better at finding it than reading the code.

```bash
npm install cut-at-k
```

```js
import { severAtEveryPoint, summarise, format } from 'cut-at-k';

const report = await severAtEveryPoint({
  events,                                  // the whole stream, in order
  label: 'my-stream',
  replay: async (prefix) => {              // run this prefix through your client
    const seen = [];
    const settled = await drive(prefix, seen);
    return { delivered: seen, settled, text: render(seen) };
  },
});

console.log(format(summarise([report], {
  lostContent: (cut, whole) => cut.text !== whole.text,
})));
```

Nothing here knows about any protocol. You supply the events and a function that
replays them; this supplies the loop and the comparison.

## It will not call something a defect on your behalf

Three things look identical in the raw numbers and only one of them is a finding:

- A cut that **lost nothing**. Cutting after the last content event and before some
  trailing bookkeeping removes no information, so of course the consumer reports the
  same thing. Correct behaviour.
- A stream that is **invalid on purpose**. Cutting it before its deliberate error
  removes the error, so the whole stream delivers *less* than the prefix and every
  comparison against it is noise. Conformance corpora are full of these.
- A cut that **lost content and was reported as though it had not**. The finding.

So `summarise` reports nothing as a defect unless you pass `lostContent`, and it
reports excluded streams as a count rather than dropping them silently. The first
version of this file did not make these distinctions and called 158 cuts a problem
on a corpus where 48 were. A tool that cries wolf is worse than no tool.

## Worked example: AG-UI's own conformance corpus

[AG-UI](https://github.com/ag-ui-protocol/ag-ui) ships 68 conformance fixtures — real
event streams, written by the protocol's authors, with the outcome each one requires.
Replaying every fixture through a real `HttpAgent` over real HTTP/SSE, cut at every
event boundary:

```
48 streams, 227 cuts, 18 streams excluded as invalid on purpose

reported the same as the whole run    : 158
  of which something was actually lost : 48
  of those, no terminal event either   : 46
spread across                          : 33 streams
```

A cut here is the specification's own definition of a truncated run: the stream ends
after k events with no further frames and no terminal event. From
[`/spec/1.0/basic/transports#truncation`](https://github.com/ag-ui-protocol/ag-ui):

> A consumer whose stream ends without a terminal event has a truncated run … A
> consumer MUST NOT synthesize a `RUN_FINISHED` for it and MUST NOT report it as
> having succeeded.

The smallest case, from their `conformant-run-is-quiet` fixture cut after its fourth
event:

```
truncated   settled {"result":null,"newMessages":1}   text "Hello, "
            events  RUN_STARTED STEP_STARTED TEXT_MESSAGE_START TEXT_MESSAGE_CONTENT
completed   settled {"result":null,"newMessages":1}   text "Hello, world."
```

The awaited call reports the same value either way. A subscriber sees no terminal
event at all. Neither channel says the run was cut.

`results/run-ag-ui.mjs` reproduces the table from the recorded observations, through
this library's own summary rather than separate arithmetic, so the numbers above and
the numbers the tool prints cannot drift apart.

### What this is not

It is one protocol, one client, at one commit, cut at event boundaries. Cutting inside
a frame — mid-UTF-8 sequence, mid-SSE frame, mid tool-call JSON — is not covered yet
and is where the more interesting failures probably live. Other frameworks have no
validator of their own to use as an oracle, so for those the harness would have to
assert its own expectation, which is weaker evidence.

Findings belong in the tracker of the project that carries them, not in a scoreboard
kept outside it.

## Status

Early. The core loop and the summary are tested (`npm test`, 10 tests, no
dependencies); the AG-UI adapter lives in that checkout because it needs their client.
The API will change.

## Licence

MIT © Redouane (ROSH Company Labs)
