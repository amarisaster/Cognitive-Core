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

      it('has no lone-$ dollar-quote delimiters', () => {
        // A `$` that is not part of a `$$` pair. This is the exact defect:
        // `DO $` and `END $;` instead of `DO $$` / `END $$;`.
        const bad: string[] = [];
        lines.forEach((line, i) => {
          if (/(?<!\$)\$(?!\$)/.test(line)) bad.push(`line ${i + 1}: ${line.trim()}`);
        });
        expect(bad, `lone ${D} delimiter — Postgres rejects the file here`).toEqual([]);
      });

      it('has an even number of $$ delimiters', () => {
        const count = (sql.match(/\$\$/g) || []).length;
        expect(count % 2, `${count} ${DD} delimiters — an odd count leaves a block unterminated`).toBe(0);
      });

      it('pairs every DO block with an END', () => {
        const opens = (sql.match(/\bDO\s+\$\$/gi) || []).length;
        const closes = (sql.match(/\bEND\s+\$\$\s*;/gi) || []).length;
        expect(closes, `${opens} DO ${DD} blocks but ${closes} END ${DD}; terminators`).toBe(opens);
      });
    });
  }
});
