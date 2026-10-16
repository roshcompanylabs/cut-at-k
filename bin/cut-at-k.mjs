#!/usr/bin/env node
/**
 * A way to see this work before deciding whether to write any code.
 *
 * The library asks for an event array, a replay function, a sameness predicate
 * and a lostContent predicate before it will tell you anything, which is four
 * decisions someone who has just installed it cannot make yet. Every probe in
 * this package is a worked answer to all four against a real SDK, and until now
 * none of them shipped. So: `cut-at-k demo` replays a recording and needs
 * nothing installed, and `cut-at-k probe <name>` runs one of the probes against
 * a client you already have.
 *
 * The one job this file does that the probes cannot do for themselves is check
 * their imports first. `requireLatest` resolves the SDK and throws from inside
 * someone else's module if it is absent; a stack trace naming a file you have
 * never opened is a worse answer than `npm install ai`.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { PROBES, PYTHON_PROBE } from '../probes/_catalog.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RECORDING = 'results/sever-results.json';

/**
 * Resolve a package the way the probe will, from the probe's own directory, so
 * that a pass here means the probe's `requireLatest` will get that far too.
 * Node's resolution walks up from there, which is what makes an SDK installed in
 * the caller's project visible to a probe living in node_modules/cut-at-k.
 */
function missingDeps(probe) {
  const req = createRequire(join(ROOT, probe.file));
  return probe.deps.filter((name) => {
    try {
      req.resolve(name);
      return false;
    } catch {
      return true;
    }
  });
}

function run(relPath, args = []) {
  const file = join(ROOT, relPath);
  if (!existsSync(file)) {
    console.error(`cut-at-k: ${relPath} is missing from this install.`);
    console.error('This is a packaging fault, not something you did. Please report it:');
    console.error('  https://github.com/roshcompanylabs/cut-at-k/issues');
    process.exit(1);
  }
  const child = spawn(process.execPath, [file, ...args], { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
  child.on('error', (err) => {
    console.error(`cut-at-k: could not start node — ${err.message}`);
    process.exit(1);
  });
}

function listProbes() {
  console.log('\nProbes. Each one drives a real client and prints what it found.\n');
  const width = Math.max(...Object.keys(PROBES).map((n) => n.length));
  for (const [name, probe] of Object.entries(PROBES)) {
    const missing = missingDeps(probe);
    const mark = missing.length ? '·' : '✓';
    console.log(`  ${mark} ${name.padEnd(width)}  ${probe.asks}`);
    console.log(
      `    ${' '.repeat(width)}  ${missing.length ? `needs: npm install ${missing.join(' ')}` : `${probe.deps.join(' ')} — installed`}`,
    );
  }
  console.log(`\n  · ${PYTHON_PROBE.file}`);
  console.log(`    ${PYTHON_PROBE.asks}`);
  console.log(`    run it with: ${PYTHON_PROBE.run}\n`);
  console.log('  cut-at-k probe <name>\n');
}

function help() {
  console.log(`
cut-at-k — cut a stream at every point and check what the consumer is left with.

  cut-at-k demo [recording]   Replay a recorded corpus and print the table.
                              Needs nothing installed. Start here.

  cut-at-k probe              List the probes and say which you can run now.
  cut-at-k probe <name>       Run one against a client you have installed.

  cut-at-k --help

The demo replays ${DEFAULT_RECORDING}, which ships with this package: 48 of
AG-UI's own conformance streams, cut at every event boundary. Nothing is sent
anywhere and no network is used.
`);
}

const [command, arg] = process.argv.slice(2);

switch (command) {
  case undefined:
  case '-h':
  case '--help':
  case 'help':
    help();
    break;

  case 'demo': {
    // Checked here rather than left to readFileSync, which answers a mistyped
    // path with a stack trace through node:fs — the same unhelpful shape as an
    // unresolved import, and the reason this command exists.
    const recording = arg ? resolve(process.cwd(), arg) : join(ROOT, DEFAULT_RECORDING);
    if (!existsSync(recording)) {
      console.error(`\n  No recording at ${recording}\n`);
      console.error('  `cut-at-k demo` with no argument replays the one that ships with this');
      console.error('  package. Pass a path only if you made your own with results/record.mjs.\n');
      process.exit(1);
    }
    run('results/run-ag-ui.mjs', [recording]);
    break;
  }

  case 'probe': {
    if (!arg) {
      listProbes();
      break;
    }
    const probe = PROBES[arg];
    if (!probe) {
      console.error(`cut-at-k: no probe called "${arg}".`);
      console.error(`Available: ${Object.keys(PROBES).join(', ')}`);
      console.error('Run `cut-at-k probe` to see what each one asks.');
      process.exit(1);
    }
    const missing = missingDeps(probe);
    if (missing.length) {
      console.error(`\n  ${arg} drives ${probe.deps.join(' and ')}, which ${missing.length > 1 ? 'are' : 'is'} not installed here.\n`);
      console.error(`      npm install ${missing.join(' ')}\n`);
      console.error('  The probe measures whatever version that resolves to, and refuses to run');
      console.error('  against a stale one — so install it where you want it measured.\n');
      process.exit(1);
    }
    run(probe.file);
    break;
  }

  default:
    console.error(`cut-at-k: unknown command "${command}".`);
    help();
    process.exit(1);
}
