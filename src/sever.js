/**
 * Cut a stream at every point and record what the consumer is left with.
 *
 * The idea is small enough to state in a sentence: a stream that stops early is
 * not a rare case, it is Tuesday — a dropped connection, a proxy timeout, a
 * producer that died, a person who pressed stop. So run the same stream through
 * a consumer once whole, then once for every prefix of it, and compare.
 *
 * Nothing here knows about any particular protocol. You supply the events and a
 * function that replays them through whatever client you are testing; this
 * supplies the loop and the comparison.
 */

/**
 * @typedef {object} Observation
 *   Whatever the consumer ended up with. Only two fields are interpreted here;
 *   anything else you attach is carried through to the report untouched.
 * @property {string[]} [delivered] Event types the consumer actually surfaced.
 * @property {string}   [settled]   How the awaited call reported, as a string.
 */

/**
 * @template E
 * @param {object} options
 * @param {E[]} options.events            The whole stream, in order.
 * @param {(prefix: E[], label: string) => Promise<Observation>} options.replay
 *   Replays a prefix through the consumer and returns what it was left with.
 *   It is called once per cut, plus once with the whole stream.
 * @param {string} [options.label]        Names this stream in the report.
 * @param {(a: Observation, b: Observation) => boolean} [options.same]
 *   Decides whether two observations are indistinguishable to application code.
 *   Defaults to comparing `settled`.
 * @returns {Promise<CutReport>}
 */
export async function severAtEveryPoint({ events, replay, label = 'stream', same }) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('severAtEveryPoint: events must be a non-empty array');
  }
  const indistinguishable = same ?? ((a, b) => a.settled === b.settled);

  const whole = await replay(events, `${label}:whole`);
  /** @type {Cut[]} */
  const cuts = [];

  // k = events.length is the whole stream, which is the baseline, not a cut.
  for (let k = 1; k < events.length; k++) {
    let observation;
    let threw;
    try {
      observation = await replay(events.slice(0, k), `${label}:k${k}`);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }

    if (!observation) {
      cuts.push({ k, of: events.length, threw });
      continue;
    }

    const delivered = observation.delivered ?? [];
    cuts.push({
      k,
      of: events.length,
      observation,
      // Truncation may lose the tail. It must never change the head.
      prefixHeld: isPrefix(delivered, whole.delivered ?? []),
      // The property that matters: a run that was cut short must not report
      // what the same run reports when it finishes.
      settledAlike: indistinguishable(observation, whole),
      terminal: lastOf(delivered),
    });
  }

  return { label, whole, cuts };
}

/**
 * @typedef {object} Cut
 * @property {number} k
 * @property {number} of
 * @property {Observation} [observation]
 * @property {string} [threw]
 * @property {boolean} [prefixHeld]
 * @property {boolean} [settledAlike]
 * @property {string} [terminal]
 */

/**
 * @typedef {object} CutReport
 * @property {string} label
 * @property {Observation} whole
 * @property {Cut[]} cuts
 */

function isPrefix(short, long) {
  return short.length <= long.length && short.every((v, i) => v === long[i]);
}

function lastOf(list) {
  return list.length ? list[list.length - 1] : '(nothing)';
}
