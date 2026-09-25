/**
 * Cut inside a frame, not just between events.
 *
 * Severing between events tests the state machine: does the consumer handle a
 * run that stopped after three events rather than nine. Severing inside a frame
 * tests the parser underneath it, which is a different and usually softer
 * target — a cut in the middle of a UTF-8 sequence, between `data:` and its
 * newline, or halfway through a JSON payload.
 *
 * The interesting offsets are not evenly spread. Most bytes of a frame are
 * unremarkable; the ones that break things sit at structural seams. So this
 * offers both: every offset when you can afford it, and the seams when you
 * cannot.
 */

const encoder = new TextEncoder();

/** Serialise events as an SSE body, one event per frame. */
export function toSSE(events, { event: eventName } = {}) {
  return events
    .map((e) => {
      const data = typeof e === 'string' ? e : JSON.stringify(e);
      const name = eventName ? `event: ${eventName}\n` : '';
      return `${name}data: ${data}\n\n`;
    })
    .join('');
}

/**
 * Offsets worth cutting at, for a body you do not want to cut 40,000 times.
 *
 * @param {string} body
 * @returns {{offset: number, why: string}[]}
 */
export function seams(body) {
  const bytes = encoder.encode(body);
  /** @type {Map<number, string>} */
  const found = new Map();
  const note = (offset, why) => {
    if (offset > 0 && offset < bytes.length && !found.has(offset)) found.set(offset, why);
  };

  // Structural positions in the SSE framing itself.
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];

    // Inside a multi-byte UTF-8 sequence. A continuation byte is 10xxxxxx, so
    // cutting immediately before one splits a character in half.
    if ((b & 0b1100_0000) === 0b1000_0000) note(i, 'mid-UTF-8 sequence');

    // Between a field name and its value: `data:` and what follows.
    if (b === 0x3a /* : */) note(i + 1, 'after a field colon');

    // Between the two newlines that end a frame.
    if (b === 0x0a /* \n */ && bytes[i + 1] === 0x0a) note(i + 1, 'between frame newlines');

    // Inside the JSON payload, at its own structural marks.
    if (b === 0x7b /* { */) note(i + 1, 'just inside an object');
    if (b === 0x22 /* " */) note(i + 1, 'just inside a string');
    if (b === 0x2c /* , */) note(i + 1, 'after a comma');
  }

  return [...found.entries()]
    .map(([offset, why]) => ({ offset, why }))
    .sort((a, b) => a.offset - b.offset);
}

/**
 * Cut a serialised body at chosen byte offsets and record what the consumer is
 * left with.
 *
 * @param {object} options
 * @param {string} options.body                 The whole serialised stream.
 * @param {(bytes: string, label: string) => Promise<import('./sever.js').Observation>} options.replay
 * @param {string} [options.label]
 * @param {'seams' | 'every'} [options.offsets] Which offsets to try. Defaults
 *   to the structural seams, which is the version you can run in CI.
 * @param {(a: import('./sever.js').Observation, b: import('./sever.js').Observation) => boolean} [options.same]
 */
export async function severAtEveryByte({
  body,
  replay,
  label = 'stream',
  offsets = 'seams',
  same,
}) {
  if (typeof body !== 'string' || body.length === 0) {
    throw new Error('severAtEveryByte: body must be a non-empty string');
  }
  const indistinguishable = same ?? ((a, b) => a.settled === b.settled);
  const bytes = encoder.encode(body);

  const points =
    offsets === 'every'
      ? Array.from({ length: bytes.length - 1 }, (_, i) => ({ offset: i + 1, why: 'byte' }))
      : seams(body);

  const whole = await replay(body, `${label}:whole`);
  const cuts = [];

  for (const { offset, why } of points) {
    // Slice the bytes, then decode. A cut inside a multi-byte sequence leaves a
    // partial character, which is the whole point — decoding with a fatal
    // decoder here would throw away the case being tested.
    const prefix = new TextDecoder('utf-8').decode(bytes.slice(0, offset));

    let observation;
    let threw;
    try {
      observation = await replay(prefix, `${label}:@${offset}`);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }

    if (!observation) {
      cuts.push({ offset, why, of: bytes.length, threw });
      continue;
    }

    cuts.push({
      offset,
      why,
      of: bytes.length,
      observation,
      settledAlike: indistinguishable(observation, whole),
      terminal: (observation.delivered ?? []).at(-1) ?? '(nothing)',
    });
  }

  return { label, whole, cuts, points: points.length, bytes: bytes.length };
}
