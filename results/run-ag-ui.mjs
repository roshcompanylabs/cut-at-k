/**
 * The worked example: AG-UI's own conformance corpus, cut at every event.
 *
 * This reads the raw observations recorded by replaying each fixture through a
 * real HttpAgent over real HTTP/SSE, and runs them through this library's own
 * summary so the numbers in the README come from the tool rather than from a
 * separate piece of arithmetic.
 *
 *   node results/run-ag-ui.mjs <path-to-sever-results.json>
 *
 * The recording step lives in the AG-UI checkout because it needs their client;
 * the file it writes is the input here.
 */
import { readFileSync } from 'node:fs';
import { severAtEveryPoint } from '../src/sever.js';
import { summarise, format } from '../src/report.js';

const input = process.argv[2];
if (!input) {
  console.error('usage: node results/run-ag-ui.mjs <sever-results.json>');
  process.exit(1);
}

const raw = JSON.parse(readFileSync(input, 'utf8'));

// Rebuild one report per fixture from the recorded observations. Replaying is
// already done; this replays from the recording so the analysis is the
// library's, not a bespoke script's.
const byFixture = new Map();
for (const row of raw.rows) {
  if (row.k < 0) continue;
  if (!byFixture.has(row.fixture)) byFixture.set(row.fixture, []);
  byFixture.get(row.fixture).push(row);
}

const reports = [];
for (const [fixture, rows] of byFixture) {
  rows.sort((a, b) => a.k - b.k);
  const of = rows[0].of;
  const whole = {
    delivered: String(rows[0].wholeDelivered).split(' ').filter(Boolean),
    settled: rows[0].wholeSettled,
    messages: rows[0].wholeMessages,
  };
  const recorded = new Map(rows.map((r) => [r.k, r]));

  reports.push(
    await severAtEveryPoint({
      events: Array.from({ length: of }, (_, i) => i),
      label: fixture,
      replay: async (prefix) => {
        if (prefix.length === of) return whole;
        const r = recorded.get(prefix.length);
        if (!r) throw new Error(`no recording for k=${prefix.length}`);
        if (r.threw) throw new Error(r.threw);
        return {
          delivered: String(r.cutDelivered).split(' ').filter(Boolean),
          settled: r.cutSettled,
          messages: r.cutMessages,
        };
      },
    }),
  );
}

// Fixtures whose whole stream is invalid on purpose. Cutting one before its
// deliberate error removes the error, so every comparison against it is noise.
const summary = summarise(reports, {
  ignore: (label) => label.includes('fatal'),
  // Did the cut actually remove something the application would have seen?
  // Cutting after the last content event and before some trailing bookkeeping
  // removes nothing, and a consumer reporting the same for those is right.
  lostContent: (cut, whole) => cut.messages !== whole.messages,
});

console.log(format(summary));
console.log('\nstreams with at least one silent cut:');
for (const [label, n] of Object.entries(summary.byStream).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(n).padStart(3)}  ${label}`);
}
console.log('\nlast event delivered on a silent cut:');
for (const [ev, n] of Object.entries(summary.byTerminal).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${ev}`);
}
