"""OpenAI Python SDK: when a Responses stream is cut, what is the caller left holding?

    uv venv && uv pip install openai
    .venv/Scripts/python probes/python/openai_python.py

The same question `probes/openai-node.mjs` asks of the Node SDK, asked of the Python
one, because that is where the report lives. openai-python#3561, open since 2026-07-31,
is about aborting a streaming Responses request after a `function_call` item has been
streamed: the item is never committed to the conversation, and the next turn fails with
a 400 because the remote conversation has no record of the call its output belongs to.

That half is server-side and needs a real conversation, so it is not what this measures.
What this measures is the half a client owns: after the cut, does `get_final_response()`
still carry the function_call the consumer watched arrive, and does `status` avoid
claiming the response completed. A caller that executes the tool locally relies on both.

The Node SDK answered clean. An OpenAI maintainer said as much for Node on
openai-node#2571, closing it as not planned with 56 streaming tests behind the claim.
Nobody has said it about the Python client, which is the one the report is filed against.
"""

from __future__ import annotations

import json
import sys
import urllib.request
from typing import Any, Callable

import httpx2
from openai import OpenAI


def require_latest(package: str) -> str:
    """Refuse to measure anything but the current release.

    The JS side of this repo learned it the expensive way: a probe once measured a
    version 882 releases behind the current one and nearly filed the result. A
    measurement of the wrong version is not a weaker result, it is not a result, and
    the version line is the first thing a maintainer checks.
    """
    import importlib.metadata as md

    installed = md.version(package)
    try:
        with urllib.request.urlopen(
            f"https://pypi.org/pypi/{package}/json", timeout=20
        ) as r:
            latest = json.load(r)["info"]["version"]
    except Exception:
        print(f"Refusing to measure: could not reach PyPI to check {package}", file=sys.stderr)
        raise SystemExit(1)

    if installed != latest:
        print(
            f"Refusing to measure a stale install:\n\n"
            f"  {package}=={installed}, but latest is {latest}\n\n"
            f"  python {sys.version.split()[0]}\n",
            file=sys.stderr,
        )
        raise SystemExit(1)

    print(f"{package}=={installed}  |  python {sys.version.split()[0]}\n")
    return installed


RESPONSE: dict[str, Any] = {
    "id": "resp_1",
    "object": "response",
    "created_at": 1,
    "status": "in_progress",
    "model": "m",
    "output": [],
    "parallel_tool_calls": False,
    "tool_choice": "auto",
    "tools": [],
}

CALL: dict[str, Any] = {
    "id": "fc_1",
    "type": "function_call",
    "call_id": "call_ABC",
    "name": "transfer",
    "arguments": '{"amount":50000}',
    "status": "completed",
}

# The stream, in order. A cut is a prefix of this.
EVENTS: list[dict[str, Any]] = [
    {"type": "response.created", "response": RESPONSE, "sequence_number": 0},
    {"type": "response.in_progress", "response": RESPONSE, "sequence_number": 1},
    {
        "type": "response.output_item.added",
        "item": {**CALL, "arguments": "", "status": "in_progress"},
        "output_index": 0,
        "sequence_number": 2,
    },
    {
        "type": "response.function_call_arguments.delta",
        "item_id": "fc_1",
        "output_index": 0,
        "delta": '{"amount":50000}',
        "sequence_number": 3,
    },
    {
        "type": "response.function_call_arguments.done",
        "item_id": "fc_1",
        "output_index": 0,
        "arguments": '{"amount":50000}',
        "sequence_number": 4,
    },
    {
        "type": "response.output_item.done",
        "item": CALL,
        "output_index": 0,
        "sequence_number": 5,
    },
    {
        "type": "response.completed",
        "response": {**RESPONSE, "status": "completed", "output": [CALL]},
        "sequence_number": 6,
    },
]

WROTE = [
    "nothing",
    "the response opened",
    "it is in progress",
    "a call is starting",
    "its arguments arrive",
    "its arguments finish",
    "the call is done",
    "the whole stream",
]


def transport_for(prefix: list[dict[str, Any]]) -> Callable[[httpx2.Request], httpx2.Response]:
    """Serve exactly these events as SSE and then close, cleanly."""

    body = "".join(
        f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in prefix
    ).encode()

    def handler(_request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=body,
        )

    return handler


def replay(prefix: list[dict[str, Any]]) -> dict[str, Any]:
    client = OpenAI(
        api_key="probe",
        http_client=httpx2.Client(transport=httpx2.MockTransport(transport_for(prefix))),
    )

    seen: list[str] = []
    final = None
    threw = None
    snapshot_calls = 0
    snapshot_status = None
    snapshot_ids: list[str | None] = []
    snapshot_item_status: list[str | None] = []

    try:
        with client.responses.stream(model="m", input="hi") as stream:
            for event in stream:
                seen.append(getattr(event, "type", "?"))

            # What the SDK accumulated, read before asking for it properly. This is
            # a name-mangled private and no caller should touch it; the point of
            # reading it here is to establish whether the data exists at all when
            # the public accessor refuses, which is a different claim from "lost".
            state = getattr(stream, "_state", None)
            snap = getattr(state, "_ResponseStreamState__current_snapshot", None)
            if snap is not None:
                snapshot_status = getattr(snap, "status", None)
                items = [o for o in (getattr(snap, "output", None) or [])
                         if getattr(o, "type", None) == "function_call"]
                snapshot_calls = len(items)
                # The fields a caller reconciling after an abort would key on.
                snapshot_ids = [getattr(o, "call_id", None) for o in items]
                snapshot_item_status = [getattr(o, "status", None) for o in items]

            final = stream.get_final_response()
    except Exception as exc:  # noqa: BLE001 - the probe reports whatever surfaced
        threw = f"{type(exc).__name__}"

    output = getattr(final, "output", None) or []
    calls = [o for o in output if getattr(o, "type", None) == "function_call"]

    return {
        "delivered": seen,
        "saw_call": any("function_call" in t or "output_item" in t for t in seen),
        "kept_calls": len(calls),
        "status": getattr(final, "status", None),
        "snapshot_calls": snapshot_calls,
        "snapshot_status": snapshot_status,
        "snapshot_ids": snapshot_ids,
        "snapshot_item_status": snapshot_item_status,
        "threw": threw,
    }


SECOND_CALL: dict[str, Any] = {
    "id": "fc_2",
    "type": "function_call",
    "call_id": "call_DEF",
    "name": "search",
    "arguments": '{"q":"rate"}',
    "status": "completed",
}

# The shape the reconciliation design keys on: one call already terminal, a second
# still mid-arguments when the stream stops. Idempotency has to tell them apart.
TWO_CALLS: list[dict[str, Any]] = EVENTS[:6] + [
    {
        "type": "response.output_item.added",
        "item": {**SECOND_CALL, "arguments": "", "status": "in_progress"},
        "output_index": 1,
        "sequence_number": 6,
    },
    {
        "type": "response.function_call_arguments.delta",
        "item_id": "fc_2",
        "output_index": 1,
        "delta": '{"q":"ra',
        "sequence_number": 7,
    },
]


def two_calls_in_flight() -> None:
    """One call terminal, one still arriving, cut there."""
    client = OpenAI(
        api_key="probe",
        http_client=httpx2.Client(
            transport=httpx2.MockTransport(transport_for(TWO_CALLS))
        ),
    )
    with client.responses.stream(model="m", input="hi") as stream:
        for _ in stream:
            pass
        state = getattr(stream, "_state", None)
        snap = getattr(state, "_ResponseStreamState__current_snapshot", None)
        items = [o for o in (getattr(snap, "output", None) or [])
                 if getattr(o, "type", None) == "function_call"]

        print()
        print("  two calls in flight, cut while the second is mid-arguments")
        print()
        print("    order  call_id   name      status        arguments")
        for i, o in enumerate(items):
            print(
                f"    {i:<7}{getattr(o, 'call_id', None) or '-':<10}"
                f"{getattr(o, 'name', None) or '-':<10}"
                f"{getattr(o, 'status', None) or '-':<14}{getattr(o, 'arguments', None)!r}"
            )
        try:
            stream.get_final_response()
            print("\n    get_final_response(): returned")
        except Exception as exc:  # noqa: BLE001
            print(f"\n    get_final_response(): {type(exc).__name__}")

    # Derived from the events, not asserted: which call_ids were carried by an
    # output_item.done before the cut.
    sent_terminal = {
        e["item"]["call_id"]
        for e in TWO_CALLS
        if e["type"] == "response.output_item.done"
    }
    same_status = len({getattr(o, "status", None) for o in items}) == 1
    print(
        f"    both kept, in order, with distinct call_id : "
        f"{len(items) == 2 and len({getattr(o, 'call_id', None) for o in items}) == 2}"
    )
    print(f"    call_ids that received output_item.done  : {sorted(sent_terminal)}")
    print(f"    their status fields are indistinguishable : {same_status}")


def main() -> int:
    require_latest("openai")

    rows = []
    for k in range(1, len(EVENTS) + 1):
        rows.append((k, replay(EVENTS[:k])))

    print("  cut  wrote                  saw the call  get_final_response()  calls it gave  accumulated inside")
    for k, o in rows:
        gave = o["threw"] or (o["status"] or "-")
        ids = ",".join(i or "?" for i in o["snapshot_ids"]) or "-"
        st = ",".join(i or "?" for i in o["snapshot_item_status"]) or "-"
        inside = f"{o['snapshot_calls']} call(s) {ids} status={st}"
        print(
            f"  {str(k):<5}{WROTE[k]:<23}{str(o['saw_call']):<14}{gave:<22}"
            f"{str(o['kept_calls']):<15}{inside}"
        )

    cuts = [o for _, o in rows[:-1]]
    whole = rows[-1][1]
    watched = [o for o in cuts if o["saw_call"]]
    raised = [o for o in cuts if o["threw"]]
    held_inside = [o for o in watched if o["snapshot_calls"] > 0]
    gave_back = [o for o in watched if o["kept_calls"] > 0]

    print()
    print(f"  cuts where the consumer watched a call arrive     : {len(watched)}")
    print(f"  of those, the accumulated snapshot still holds it : {len(held_inside)}")
    print(f"  of those, the public accessor hands it back       : {len(gave_back)}")
    print(f"  cuts where the public accessor raised             : {len(raised)} of {len(cuts)}")
    print(f"  the whole stream reports                          : {whole['status']}")
    print()

    if len(raised) == len(cuts):
        print("  No silent failure: every cut raises rather than returning something that")
        print("  looks finished. The caller always finds out.")
    if held_inside and not gave_back:
        print()
        print("  The gap is not loss, it is reach. The SDK accumulated the call on every cut")
        print("  that showed one - it is sitting in a name-mangled private attribute - and")
        print("  `get_final_response()` is the only public accessor, which raises. A caller")
        print("  reconciling state after an abort has nothing supported to read.")
        print("  The Node SDK hands that same snapshot back; see probes/openai-node.mjs.")
    two_calls_in_flight()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
