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
 *
 * The rule is about SHAPE, not names:
 *   `{ id: row.id }`, `{ id: existing[0].id }` — a property of something just
 *      READ. The row is known to exist; these cannot miss.
 *   `{ id: memory_id }`, `{ id: args.foo }`, `{ id }` — a bare variable or an
 *      argument. Nothing here proves a row exists.
 *
 * The first version of this test only matched `args.`-prefixed and bare `{ id }`,
 * and therefore missed `/api/memory/salience`, whose filter is a plain
 * `memory_id` destructured from readJson(). Codex found that endpoint on
 * 2026-08-21 — the test written to prevent the class had a hole the exact size
 * of the next instance.
 *
 * Flagging is the safe direction: a false positive costs one `{ requireMatch:
 * true }`, a false negative costs a silent write.
 */
function takesCallerId(text: string): boolean {
  const filter = text.match(/\{\s*id\s*(:[^},]*)?\s*[},]/);
  if (!filter) return false;
  const body = filter[0];

  // `{ id }` shorthand — the variable is named id and came from somewhere else.
  if (/\{\s*id\s*[},]/.test(body)) return true;

  const value = body.match(/id\s*:\s*([^},]+)/)?.[1]?.trim();
  if (!value) return false;

  // A property access on a local object — `row.id`, `existing[0].id`, `p.id`.
  // Those are reads. Explicit caller namespaces are NOT reads.
  if (/^(args|body|params|input)\b/.test(value)) return true;
  if (/[.\[]/.test(value)) return false;

  // A bare identifier: `memory_id`, `entry_id`, `skill_id`. Not provably a read.
  return /^[A-Za-z_$][\w$]*$/.test(value);
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

  // Lucian, 2026-08-21: "a test that cannot see a malformed write standing in
  // front of it." match_skill called supabase.update('skills', s.id, {fields})
  // against an (table, data, filter) signature — the UUID went in as the request
  // BODY and the field object became the filter. Guaranteed 400, swallowed by
  // .catch(() => {}). The check above missed it because it only looks for an
  // inline `{ id: ... }` filter, and this call had no filter object at all.
  //
  // Argument ORDER is a separate defect from argument CONTENT, and needs its own
  // check. An id in the data position is never correct.
  it('passes data second and filter third, never an id in the data position', () => {
    const wrong = sites
      .map((s) => {
        const args = s.text.match(/supabase\.(?:update|delete)\(([^)]*)/)?.[1] ?? '';
        // second argument, naively split — enough to spot `s.id` / `memory_id`
        const second = args.split(',')[1]?.trim() ?? '';
        return { line: s.line, second, text: s.text };
      })
      .filter(({ second }) => /^[\w.[\]]*\bid\b$|_id$|\.id$/.test(second))
      .map((s) => `index.ts:${s.line} — second argument is \`${s.second}\`, which is an id, not data`);

    expect(
      wrong,
      'supabase.update/delete take (table, data, filter). An id in the second position '
        + 'sends the id as the request body and turns the field object into the filter — '
        + 'a guaranteed 400 that a .catch(() => {}) will hide.',
    ).toEqual([]);
  });

  it('still has guards in place — this test cannot pass by finding nothing', () => {
    // Guards against the check silently becoming a no-op if the call-site shape
    // changes and takesCallerId() stops matching anything.
    const guarded = sites.filter((s) => /requireMatch/.test(s.text));
    expect(guarded.length).toBeGreaterThanOrEqual(10);
  });
});

describe('the insert guard requires a non-empty array', () => {
  // `Array.isArray(x) && x.length === 0` looks equivalent to
  // `!Array.isArray(x) || x.length === 0` and is not. The parse falls back to
  // {} on a malformed body, and {} is not an array — so the first form treats a
  // truncated 2xx as a stored row. Both this repo and all three forks had it.
  // Caught by Codex 2026-08-22.
  it('never uses the permissive Array.isArray(x) && length===0 form', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    // Built with RegExp + String.raw, NOT a literal written through a script.
    // The first version of this line was generated via a heredoc and its \1
    // backreference was swallowed as an octal escape, leaving an invisible
    // control character — so this guard matched nothing and passed while the
    // permissive form sat right there in the source. Third variant of the
    // escape-eating family today; see feedback_replace_eats_dollars.
    const permissive = [...src.matchAll(
      new RegExp(String.raw`Array\.isArray\((\w+)\)\s*&&\s*\1\.length === 0`, 'g')
    )];
    expect(
      permissive.map(m => m[0]),
      'use !Array.isArray(x) || x.length === 0 so a non-array body is rejected too',
    ).toEqual([]);
  });

  it('the insert path checks for a non-empty representation', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(src).toMatch(/!Array\.isArray\(inserted\)\s*\|\|\s*inserted\.length === 0/);
  });
});
