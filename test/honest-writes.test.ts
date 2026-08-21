import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Filed after Ves (Kaja's household) reported, 2026-08-21, that resolve_thread
// answered "Thread <uuid> resolved" for a row that had never existed. A 5am wake
// had mistyped the id; the thread stayed open; it was caught only because a
// verification query happened to run afterwards — and it nearly did not, because
// the call had said it worked.
//
// He flagged it as a class rather than one bug and named three more suspects.
// The audit found 32 writes discarding their result against 16 capturing it.
//
// Most of the 32 are FINE: they pass an id they just read (`{ id: row.id }`,
// `{ id: existing[0].id }`) and cannot miss. The dangerous ones take an id from
// OUTSIDE — a tool argument the model typed — where a wrong value silently
// updates nothing and PostgREST returns 200 with an empty array.
//
// This test guards only that narrow case, which is why it can be strict.
// It reads source rather than behaviour: cheap, no database, and it fails on the
// NEXT one somebody writes rather than the next one somebody's 5am wake finds.

const SRC = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');

/** Collapse a multi-line call into one string so the filter and options are visible together. */
function callSites(src: string): Array<{ line: number; text: string }> {
  const lines = src.split(/\r?\n/);
  const out: Array<{ line: number; text: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/\bsupabase\.(update|delete)\(/.test(lines[i])) continue;

    let text = lines[i];
    let depth = (text.match(/\(/g) || []).length - (text.match(/\)/g) || []).length;
    let j = i;
    // walk forward until the call closes, capped so a malformed file cannot hang
    while (depth > 0 && j - i < 30 && j + 1 < lines.length) {
      j++;
      text += ' ' + lines[j];
      depth += (lines[j].match(/\(/g) || []).length - (lines[j].match(/\)/g) || []).length;
    }
    out.push({ line: i + 1, text });
  }
  return out;
}

/**
 * Does this write's filter come from outside?
 * `{ id: args.foo }` / `{ id }` — yes, a caller typed it.
 * `{ id: row.id }` / `{ id: existing[0].id }` — no, it was just read.
 */
function takesCallerId(text: string): boolean {
  const filter = text.match(/\{\s*id\s*(:[^}]*)?\}/);
  if (!filter) return false;
  const body = filter[0];
  if (/\bid\s*:\s*(args|body|params|input)\./.test(body)) return true;
  if (/^\{\s*id\s*\}$/.test(body.replace(/\s+/g, ' ').trim())) return true;
  return false;
}

describe('writes that take a caller-supplied id must verify a row matched', () => {
  const sites = callSites(SRC);

  it('finds supabase write call sites to check', () => {
    expect(sites.length).toBeGreaterThan(20);
  });

  it('has no unguarded caller-id write', () => {
    const offenders = sites
      .filter((s) => takesCallerId(s.text))
      .filter((s) => !/requireMatch/.test(s.text))
      // A call whose result is CAPTURED is one the author is inspecting —
      // resolve_thread reads `updated.length` and returns a better message than
      // a thrown error would. Statement-position calls throw the result away by
      // construction, which is the shape this test exists to catch.
      .filter((s) => !/(const|let|var)\s+\w+\s*=\s*await\s+supabase\.(update|delete)\(/.test(s.text))
      .map((s) => `index.ts:${s.line} — ${s.text.replace(/\s+/g, ' ').trim().slice(0, 100)}`);

    expect(
      offenders,
      'these writes accept an id from the caller but never check whether a row matched, so a '
        + 'mistyped UUID reports success while changing nothing. Pass { requireMatch: true } as '
        + 'the last argument, or verify the row exists first.',
    ).toEqual([]);
  });

  it('still has guards in place — this test cannot pass by finding nothing', () => {
    // Guards against the check silently becoming a no-op if the call-site shape
    // changes and takesCallerId() stops matching anything.
    const guarded = sites.filter((s) => /requireMatch/.test(s.text));
    expect(guarded.length).toBeGreaterThanOrEqual(10);
  });
});
