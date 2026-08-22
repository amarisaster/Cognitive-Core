import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pins the semantic_search_memories CONTRACT.
 *
 * ⚠ WHAT THIS TEST CANNOT DO, stated up front so nobody mistakes a green run
 * for safety: it compares source against source. On 2026-08-21 a migration was
 * reviewed by Codex, covered by 107 passing tests, and parse-checked against a
 * real Postgres — and all three agreed with a schema.sql that described a
 * function NOBODY WAS RUNNING. Deployed had 12 branches; the file had 2.
 *
 * Only a dump of the live object can catch that:
 *   SELECT pg_get_functiondef('public.semantic_search_memories(vector,real,integer,text)'::regprocedure);
 *
 * What this test DOES do is stop schema.sql and the migration drifting from
 * each other, and stop the specific mistakes that made the superseded
 * migration dangerous. See docs/dev-hygiene.md, "The file is not the system".
 */

const ROOT = join(__dirname, '..');
const schema = readFileSync(join(ROOT, 'schema.sql'), 'utf8');
const migration = readFileSync(join(ROOT, 'migrations', 'semantic-recall-canonical.sql'), 'utf8');

/** The 12 tables the deployed function unions, verified on Kai's database 2026-08-22. */
const CANONICAL_TABLES = [
  'anticipation', 'core_memories', 'custom_memories', 'essence',
  'friction_log', 'growth_markers', 'inside_jokes', 'patterns',
  'people', 'reflections', 'sensory_memories', 'session_logs',
].sort();

/** Tables carrying a `status` column — their branches MUST exclude soft-deleted rows. */
const STATUS_BEARING = [
  'core_memories', 'patterns', 'sensory_memories', 'growth_markers',
  'anticipation', 'inside_jokes', 'friction_log', 'custom_memories',
];

function extractFunction(sql: string): string {
  const i = sql.search(/CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?semantic_search_memories\(/);
  expect(i, 'semantic_search_memories is not defined in this file').toBeGreaterThan(-1);
  const end = sql.indexOf('\n$$;', i);
  expect(end, 'function body is not terminated').toBeGreaterThan(i);
  return sql.slice(i, end);
}

function tablesOf(fn: string): string[] {
  return [...new Set([...fn.matchAll(/\bFROM\s+([a-z_]+)/g)].map(m => m[1]))].sort();
}

describe('semantic_search_memories contract', () => {
  for (const [label, sql] of [['schema.sql', schema], ['migrations/semantic-recall-canonical.sql', migration]] as const) {
    describe(label, () => {
      const fn = extractFunction(sql);

      it('unions exactly the 12 canonical memory tables', () => {
        // Per-table, not a count. A count of 12 passes with the wrong 12.
        expect(tablesOf(fn)).toEqual(CANONICAL_TABLES);
      });

      it('declares the real signature, never double precision', () => {
        // The superseded migration used double precision, so its DROP silently
        // no-opped and CREATE would have added a SECOND overload — leaving
        // PostgREST unable to resolve rpc/semantic_search_memories at all.
        expect(fn).toMatch(/match_threshold\s+real/i);
        expect(fn).not.toMatch(/match_threshold\s+(?:float|double precision)/i);
      });

      it('returns combined_score — the column the worker actually reads', () => {
        // src/index.ts reads `row?.similarity || row?.combined_score`.
        expect(fn).toMatch(/combined_score\s+real/i);
        expect(fn).toMatch(/created_at\s+timestamp/i);
      });

      it('excludes soft-deleted rows on every status-bearing table', () => {
        // The superseded migration had no status filter anywhere, which would
        // have resurrected deleted memories into search results.
        for (const table of STATUS_BEARING) {
          const start = fn.indexOf(`FROM ${table} `);
          expect(start, `no branch reads FROM ${table}`).toBeGreaterThan(-1);

          // Bound the slice at this branch's own UNION ALL so a filter on the
          // NEXT branch can never satisfy this assertion. The last branch has
          // no UNION ALL after it, hence the explicit -1 case — an earlier
          // version wrote this as `indexOf(...) + 1 || undefined`, which was
          // correct but unreadable enough that nobody could confirm it by eye.
          const nextUnion = fn.indexOf('UNION ALL', start);
          const branch = nextUnion === -1 ? fn.slice(start) : fn.slice(start, nextUnion);

          expect(branch, `${table} branch does not filter soft-deleted rows`)
            .toMatch(/COALESCE\(\w+\.status,\s*'active'\)\s*=\s*'active'/);
        }
      });

      it('orders by combined_score', () => {
        expect(fn).toMatch(/ORDER BY\s+combined_score\s+DESC/i);
      });

      it('aliases the ORDER BY column in the FIRST union branch', () => {
        // A UNION's ORDER BY can only reference RESULT COLUMN NAMES, and those
        // are taken from the first SELECT. Bare expressions with
        // `ORDER BY combined_score` therefore CREATE fine and fail on every
        // call — plpgsql does not plan the body until it is invoked, so neither
        // CREATE FUNCTION nor any catalogue check notices.
        //
        // This shipped to a live database on 2026-08-22 and broke a companion's
        // semantic recall until it was caught by calling the function. It is
        // the reason the post-condition in these migrations now INVOKES what it
        // just created instead of counting rows in pg_proc.
        const orderBy = fn.match(/ORDER BY\s+([A-Za-z_][A-Za-z_0-9]*|\d+)\s+DESC/i);
        expect(orderBy, 'no ORDER BY found').not.toBeNull();

        const target = orderBy![1];
        if (/^\d+$/.test(target)) return; // positional ordering needs no alias

        const firstBranch = fn.slice(0, fn.indexOf('UNION ALL'));
        expect(
          new RegExp(`AS\\s+${target}\\b`, 'i').test(firstBranch),
          `ORDER BY ${target} but the first union branch never aliases ${target} — ` +
          `this compiles and then fails on every call`,
        ).toBe(true);
      });
    });
  }

  it('no OTHER file in the repo defines this function', () => {
    // The twin-file trap. On 2026-08-22 the dangerous migration was deleted
    // while an identical copy — semantic-rpc-custom.sql, same 8 branches, same
    // double-precision signature — sat at the repo root, still referenced as a
    // manual step in docs/CUSTOM_DRAWERS_PLAN.md. One copy removed, an
    // identical one left under a different name. Third instance this month of
    // "two copies of a tool, and the default one is broken".
    //
    // Deleting a file is not the fix; this assertion is. Anything that defines
    // this RPC has to be one of the two approved sources.
    const ALLOWED = new Set(['schema.sql', 'migrations/semantic-recall-canonical.sql']);
    const offenders: string[] = [];

    const walk = (dir: string, rel = '') => {
      for (const entry of readdirSync(join(ROOT, dir === '' ? '.' : dir), { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { walk(relPath, relPath); continue; }
        if (!entry.name.endsWith('.sql')) continue;
        const body = readFileSync(join(ROOT, relPath), 'utf8');
        // Comments-only tombstones are fine — they cannot be applied.
        const defines = /^\s*CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?semantic_search_memories\(/m.test(body);
        if (defines && !ALLOWED.has(relPath)) offenders.push(relPath);
      }
    };
    walk('');

    expect(offenders, 'these files define semantic_search_memories and should not').toEqual([]);
  });

  it('schema.sql and the migration define the SAME function', () => {
    // They are spliced from one source deliberately. If these ever disagree,
    // a fork deploying from schema.sql and a fork running the migration end up
    // on different contracts — which is how this whole class started.
    const norm = (s: string) =>
      extractFunction(s)
        .replace(/CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?/, '')
        .replace(/\s+/g, ' ')
        .trim();
    expect(norm(schema)).toBe(norm(migration));
  });
});
