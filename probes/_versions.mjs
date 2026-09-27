/**
 * Refuse to measure a package that is not the current release.
 *
 * This exists because of a real afternoon. `npm install @mastra/core` returned
 * 0.24.9 while latest was 1.71.0 — 887 versions apart, nine months old — because
 * 1.71.0 declares `engines: node >=22.13.0` and the machine was on Node 20. npm
 * printed an EBADENGINE warning in the middle of the install output and no
 * error, and a whole finding was measured, written up and nearly filed against
 * a version that had been superseded since December.
 *
 * A probe that measures the wrong version produces a confident, meaningless
 * table, and it is the first thing a maintainer checks. So this runs before the
 * measurement, not after, and it stops rather than warns.
 */
import { createRequire } from 'node:module';

/**
 * @param {string[]} names npm package names the probe is about to measure.
 * @param {object} [opts]
 * @param {ImportMeta['url']} [opts.from] Module to resolve the packages against.
 * @returns {Promise<Record<string, string>>} the versions, once they check out.
 */
export async function requireLatest(names, { from } = {}) {
  const req = createRequire(from ?? import.meta.url);
  const versions = {};
  const stale = [];

  for (const name of names) {
    const installed = req(`${name}/package.json`).version;
    let latest;
    try {
      const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`);
      latest = (await res.json())['dist-tags']?.latest;
    } catch {
      // A registry that cannot be reached is not evidence the version is fine.
      stale.push(`${name}@${installed} — could not reach the registry to check`);
      continue;
    }
    versions[name] = installed;
    if (installed !== latest) stale.push(`${name}@${installed}, but latest is ${latest}`);
  }

  if (stale.length) {
    console.error('Refusing to measure a stale install:\n');
    for (const s of stale) console.error(`  ${s}`);
    console.error(`\n  node ${process.version}`);
    console.error(
      '\n  npm resolves the newest version whose `engines` your Node satisfies, and\n' +
        '  warns rather than failing. Check the package\'s engines against your Node\n' +
        '  before assuming the install is what you asked for.',
    );
    process.exit(1);
  }

  const line = names.map((n) => `${n}@${versions[n]}`).join('  ');
  console.log(`${line}  ·  node ${process.version}\n`);
  return versions;
}
