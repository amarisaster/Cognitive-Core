import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Filed after Ves and Kaja's report of 2026-08-19: `66afea0` shipped a
// lattice-integrity.sql that Postgres rejects at line 42. Four dollar-quote
// delimiters were written as `$` instead of `$$` — introduced by the rewrite
// that fixed the both-ends blind spot, so the change broke the syntax of the
// thing it improved. Kaja found it by pasting the file into Supabase; four
// people had read it without seeing it.
//
// The gap Ves named is the point of this file: `lattice-integrity.test.ts`
// covers the migration's LOGIC and is green, but nothing ever touched the
// migration FILE. 87 passing tests and a migration no database would accept.
//
// What this does NOT do: parse SQL. Catching a genuine syntax error needs a
// real parser or a throwaway Postgres, and neither is worth a dependency here.
// It checks the structural properties that are cheap, mechanical, and were
// exactly what broke — dollar-quote delimiters doubled, balanced, and paired
// with their blocks. A whole class of "the file cannot run at all" for no cost.

const DIR = join(__dirname, '..', 'migrations');
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.sql'));

// Blank out comments and single-quoted literals before looking for delimiters,
// keeping newlines so reported line numbers still point at the real line.
// Without this, custom-drawers.sql trips on the end-of-string anchor in
// `drawer_name ~ '^[A-Za-z0-9]...$'` — a legitimate $ that is not a delimiter.
// Heuristic, not a lexer: it assumes quotes inside dollar-quoted bodies are
// balanced, which holds for these files and fails safe by over-reporting.
const blank = (m: string) => m.replace(/[^\n]/g, ' ');
function sanitize(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/'(?:[^']|'')*'/g, blank);
}

// Built at runtime so this file never itself contains the literal that a
// careless search-and-replace over migrations would also rewrite.
const D = '$';
const DD = D + D;

describe('migration files are structurally runnable', () => {
  it('finds migrations to check', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  for (const file of FILES) {
    describe(file, () => {
      const sql = sanitize(readFileSync(join(DIR, file), 'utf8'));
      const lines = sql.split(/\r?\n/);

      // Postgres accepts BOTH $$ and a named tag like $guard$. Treating only
      // $$ as valid made this test reject correct SQL, which is the failure
      // mode that gets a guard deleted rather than fixed. Delimiters are
      // tokenised properly now: $ + optional identifier + $.
      const DELIM = /\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$/g;

      it('has no lone-$ dollar-quote delimiters', () => {
        // Strip every WELL-FORMED delimiter; whatever $ survives is the defect.
        // This is the String.replace corruption: $$ silently collapsed to $,
        // leaving `DO $` / `END $;` that no database will accept.
        const bad: string[] = [];
        lines.forEach((line, i) => {
          if (line.replace(DELIM, '').includes(D)) bad.push(`line ${i + 1}: ${line.trim()}`);
        });
        expect(bad, `lone ${D} delimiter — Postgres rejects the file here`).toEqual([]);
      });

      it('closes every dollar-quoted block with its own tag', () => {
        // Per-tag, not in aggregate. A file opening $$ and closing $guard$ has
        // an even total and is still unrunnable.
        const counts = new Map<string, number>();
        for (const d of sql.match(DELIM) || []) counts.set(d, (counts.get(d) || 0) + 1);
        const odd = [...counts.entries()].filter(([, n]) => n % 2 !== 0).map(([d, n]) => `${d} x${n}`);
        expect(odd, 'a dollar-quoted block is left unterminated').toEqual([]);
      });

      it('pairs every DO block with an END', () => {
        // Tag-aware, and tolerant of `END` on its own line before the tag —
        // which is how plpgsql is normally formatted and how the lockdown
        // guard is written.
        const opens = (sql.match(/\bDO\s+(?:\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$)/gi) || []).length;
        const closes = (sql.match(/\bEND\s*(?:\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$)\s*;/gi) || []).length;
        expect(closes, `${opens} DO blocks but ${closes} END-with-delimiter terminators`).toBe(opens);
      });
    });
  }
});
