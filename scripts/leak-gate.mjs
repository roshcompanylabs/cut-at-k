/**
 * Refuse to publish a tarball that carries anything about the machine that built it.
 *
 * The check is worth nothing if it is remembered rather than enforced, so it runs in the
 * release workflow before `npm publish` and a hit fails the job. It inspects the real
 * tarball rather than the working tree, because `files` in package.json decides what ships
 * and that has been wrong before.
 *
 * The tar is unpacked here rather than shelled out to, so the gate behaves the same on a
 * laptop as in CI. Zero dependencies, like the rest of this package.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PATTERNS = [
  [/(^|[\s"'(=])[A-Za-z]:[\\/]/m, 'a Windows path'],
  [/\/(?:home|Users)\/[A-Za-z0-9._-]+\//, 'a Unix home path'],
  [/AppData[\\/]/i, 'an AppData path'],
  [/\.ssh[\\/]|id_rsa|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/, 'key material'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'an npm token'],
  [/\bghp_[A-Za-z0-9]{36}\b/, 'a GitHub token'],
];

/** Walk a POSIX tar in memory: 512-byte header, then the file, padded to 512. */
function entries(buf) {
  const out = [];
  for (let off = 0; off + 512 <= buf.length; ) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;                       // end-of-archive
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8) || 0;
    const type = String.fromCharCode(header[156]);
    off += 512;
    if (type === '0' || type === '\0') out.push({ name, body: buf.subarray(off, off + size) });
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

const work = mkdtempSync(join(tmpdir(), 'leak-gate-'));
try {
  // shell: true so this runs on Windows, where npm is npm.cmd
  const out = execFileSync('npm', ['pack', '--pack-destination', work], { encoding: 'utf8', shell: true });
  const tarball = out.trim().split('\n').pop().trim();
  const files = entries(gunzipSync(readFileSync(join(work, tarball))));

  const hits = [];
  for (const f of files) {
    const text = f.body.toString('utf8');
    if (text.includes('\u0000')) continue;                          // binary
    for (const [re, what] of PATTERNS) {
      const m = text.match(re);
      if (m) hits.push({ file: f.name, what, sample: m[0].slice(0, 40) });
    }
  }

  console.log(`checked ${files.length} files in ${tarball}`);
  if (hits.length) {
    for (const h of hits) console.error(`  ${h.file}: ${h.what} — ${JSON.stringify(h.sample)}`);
    console.error(`\n${hits.length} leak(s); refusing to publish.`);
    process.exit(1);
  }
  console.log('clean');
} finally {
  rmSync(work, { recursive: true, force: true });
}
