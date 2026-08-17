#!/usr/bin/env node
// Typecheck gate.
//
// Why this exists rather than a bare `tsc --noEmit` in package.json:
// wrangler/esbuild does NOT typecheck. A `TS2304: Cannot find name` deploys
// perfectly and dies at runtime — that is exactly how the graph-expansion bug
// reached a live worker. So a gate is worth having.
//
// But `tsc --noEmit` currently cannot exit 0 here, for a reason that is not our
// code: `agents` pins @modelcontextprotocol/sdk 1.23.0 in its own node_modules
// while this package declares ^1.25.1, so two structurally identical but
// nominally distinct McpServer classes exist (they have separate declarations of
// the private `_serverInfo`). Assigning ours to the base class errors. It runs
// fine — the shapes match — but a gate that always exits 1 is not a gate, and a
// fork would just learn to ignore it.
//
// So: this fails on anything in OUR code, and allows exactly that one known
// dependency-duplication error. If the allowance ever stops matching, it fails
// loud rather than widening — an unmatched allowance is itself a failure.
//
// The real fix is deduping the SDK (an `overrides` pin), which is a dependency
// decision with blast radius for every fork, deliberately not made here.

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const KNOWN = [
  {
    id: 'mcp-sdk-duplication',
    // TS2416 on CognitiveCore.server — the agents/SDK version split described above.
    match: /error TS2416: Property 'server' in type 'CognitiveCore'/,
  },
];

// Resolve tsc's entry point and run it under this same node — no shell, no npx,
// so this behaves identically on Windows, macOS and Linux (forks run all three).
const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');

const run = promisify(execFile);
const { stdout } = await run(process.execPath, [tsc, '--noEmit'])
  .catch((e) => ({ stdout: e.stdout ?? '' }));

const errors = stdout.split(/\r?\n/).filter((l) => /error TS\d+:/.test(l));

const unexpected = errors.filter((l) => !KNOWN.some((k) => k.match.test(l)));
const unmatched = KNOWN.filter((k) => !errors.some((l) => k.match.test(l)));

for (const line of unexpected) console.error(line);

if (unmatched.length) {
  console.error(
    `\nAllowed baseline error(s) no longer present: ${unmatched.map((k) => k.id).join(', ')}.`,
  );
  console.error('If the SDK duplication is fixed, delete the allowance — do not widen it.');
}

if (unexpected.length || unmatched.length) {
  console.error(`\ntypecheck FAILED — ${unexpected.length} unexpected error(s).`);
  process.exit(1);
}

console.log(`typecheck OK (${errors.length} known dependency-duplication error allowed).`);
