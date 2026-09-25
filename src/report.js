const TERMINALS = new Set(['RUN_FINISHED', 'RUN_ERROR']);

/**
 * Turn a pile of cuts into the few things worth reading.
 *
 * A count of failures is not a finding. Three things have to be separated or
 * the number means nothing:
 *
 *   - A cut that lost nothing. Cutting after the last content event and before
 *     some trailing bookkeeping removes no information, so of course the
 *     consumer reports the same thing. Not a defect.
 *   - A stream that is invalid on purpose. Cutting it before its deliberate
 *     error removes the error, so the whole stream delivers less than the
 *     prefix and every comparison is noise.
 *   - A cut that genuinely lost content and was reported as though it had not.
 *     That is the finding.
 *
 * The first version of this file reported the first two as findings. On the
 * corpus in results/ that means calling 154 cuts a problem when 54 are real —
 * `node results/run-ag-ui.mjs results/sever-results.json` prints both numbers.
 * A tool that cries wolf is worse than no tool, so the distinction is now the
 * whole design.
 */

/**
 * @param {import('./sever.js').CutReport[]} reports
 * @param {object} [options]
 * @param {(label: string) => boolean} [options.ignore]
 *   Streams to leave out of the findings — typically the ones a conformance
 *   corpus ships as deliberately invalid. Their count is reported separately
 *   rather than silently dropped.
 * @param {(cut: import('./sever.js').Observation, whole: import('./sever.js').Observation) => boolean} [options.lostContent]
 *   Did this cut actually lose something the consumer would have surfaced?
 *   Without it, a cut that changed nothing cannot be told from one that did,
 *   and the summary says so instead of guessing.
 */
export function summarise(reports, { ignore, lostContent } = {}) {
  const considered = ignore ? reports.filter((r) => !ignore(r.label)) : reports;
  const excluded = reports.length - considered.length;

  const all = considered.flatMap((r) => r.cuts.map((c) => ({ ...c, label: r.label, whole: r.whole })));
  const threw = all.filter((c) => c.threw);
  const usable = all.filter((c) => !c.threw);

  // Reported the same as the whole run. On its own this is not yet a finding.
  const reportedAlike = usable.filter((c) => c.settledAlike === true);

  // The finding: something was lost, and the consumer reported otherwise.
  const findings = lostContent
    ? reportedAlike.filter((c) => lostContent(c.observation, c.whole))
    : [];

  // Both channels quiet — no terminal event delivered at all — is the worse
  // shape. Checking only the LAST event is not enough: a stream carrying more
  // than one run can deliver a terminal for an earlier run and still end mid-
  // content, and that consumer did get a signal, just not about this part.
  const noTerminal = findings.filter(
    (c) => !(c.observation?.delivered ?? []).some((e) => TERMINALS.has(e)),
  );

  const prefixBroken = usable.filter((c) => c.prefixHeld === false);

  return {
    streams: considered.length,
    excluded,
    cuts: all.length,
    threw: threw.length,
    reportedAlike: reportedAlike.length,
    lostContentChecked: Boolean(lostContent),
    findings,
    noTerminal,
    prefixBroken,
    byStream: countBy(findings, (c) => c.label),
    byTerminal: countBy(findings, (c) => c.terminal),
  };
}

/** A short human-readable version, for a terminal or a pull request body. */
export function format(summary) {
  const lines = [];
  lines.push(
    `${summary.streams} streams, ${summary.cuts} cuts` +
      (summary.excluded ? `, ${summary.excluded} streams excluded as invalid on purpose` : ''),
  );
  if (summary.threw) lines.push(`${summary.threw} cuts threw during replay`);
  lines.push('');
  lines.push(`reported the same as the whole run    : ${summary.reportedAlike}`);

  if (!summary.lostContentChecked) {
    lines.push('');
    lines.push('No lostContent check was supplied, so none of the above can be');
    lines.push('called a defect: a cut that removed nothing reports the same for');
    lines.push('a good reason. Supply lostContent to separate them.');
    return lines.join('\n');
  }

  lines.push(`  of which something was actually lost : ${summary.findings.length}`);
  lines.push(`  of those, no terminal event either   : ${summary.noTerminal.length}`);
  lines.push(`spread across                          : ${Object.keys(summary.byStream).length} streams`);

  if (summary.prefixBroken.length) {
    lines.push('');
    lines.push(`prefix property broken                 : ${summary.prefixBroken.length}`);
    lines.push('  Check these by hand before reporting them. A stream that is');
    lines.push('  invalid on purpose looks exactly like this and is not a defect.');
  }
  return lines.join('\n');
}

function countBy(list, key) {
  const out = {};
  for (const item of list) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
