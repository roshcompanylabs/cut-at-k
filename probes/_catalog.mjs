/**
 * What the CLI needs to know about each probe, and nothing more.
 *
 * Deliberately absent: the verdict. Every probe prints its own, measured on the
 * run you just asked for, and the table in probes/README.md is re-derived when
 * the pins move. A copy here would be a third place for the same claim to live
 * and the first one to go stale — the two that already exist are two because one
 * is prose and the other is the measurement, not because duplication is fine.
 *
 * `deps` is what the probe imports beyond this package, which is how the CLI can
 * say `npm install ai` instead of letting Node throw ERR_MODULE_NOT_FOUND from
 * inside someone else's file.
 */

/**
 * @typedef {object} Probe
 * @property {string}   file  Path relative to the package root.
 * @property {string[]} deps  npm packages the probe imports.
 * @property {string}   asks  One line: what this probe wants to find out.
 */

/** @type {Record<string, Probe>} */
export const PROBES = {
  'ag-ui': {
    file: 'probes/ag-ui-compact.mjs',
    deps: ['@ag-ui/client'],
    asks: 'When a run is cut, does the awaited call report what a completed run reports?',
  },
  'ag-ui-bytes': {
    file: 'probes/ag-ui-bytes.mjs',
    deps: ['@ag-ui/client'],
    asks: 'Same question, cut between bytes rather than between events.',
  },
  'ag-ui-line-endings': {
    file: 'probes/ag-ui-line-endings.mjs',
    deps: ['@ag-ui/client', 'eventsource-parser'],
    asks: 'What a cut cannot reach: the line terminator the frame is split on.',
  },
  langgraph: {
    file: 'probes/langgraph-js.mjs',
    deps: ['@langchain/langgraph', '@langchain/core'],
    asks: 'After a cut, does the checkpoint agree with what the consumer was shown?',
  },
  mastra: {
    file: 'probes/mastra.mjs',
    deps: ['@mastra/core', '@mastra/memory'],
    asks: 'Is text the consumer saw still persisted when the run is cut?',
  },
  mcp: {
    file: 'probes/mcp-streamable-http.mjs',
    deps: ['@modelcontextprotocol/client'],
    asks: 'When the response can no longer arrive, is the caller told, and when?',
  },
  openai: {
    file: 'probes/openai-node.mjs',
    deps: ['openai'],
    asks: 'Does finalResponse() still carry the tool call, and does status admit the cut?',
  },
  'vercel-ai': {
    file: 'probes/vercel-ai-sdk.mjs',
    deps: ['ai'],
    asks: 'Does a cut run report differently from one that finished?',
  },
};

/**
 * The Python probe is listed rather than run. Spawning an interpreter this
 * package does not depend on, to run a file whose imports it cannot check,
 * fails in more ways than it helps — so the CLI prints the command instead.
 */
export const PYTHON_PROBE = {
  file: 'probes/python/openai_python.py',
  run: 'python probes/python/openai_python.py',
  deps: ['openai (pip)'],
  asks: 'The same question in Python, where the report that started this lives.',
};
