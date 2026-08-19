import { describe, expect, it, vi } from 'vitest';

vi.mock('agents/mcp', () => ({
  McpAgent: class {
    static serve() { return { fetch() {} }; }
    static serveSSE() { return { fetch() {} }; }
  }
}));
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {}
}));

import { INTENT_CONFIG, computeCompositeScore, deriveRelevance } from '../src/index';

// Regression cover for the recall-ranking bug found by Kai on 2026-08-18, during
// the audit he and Lucian ran against public HEAD b30f3b1.
//
// The graph-expansion batch fetch selected `similarity:salience` — a PostgREST
// ALIAS, not a filter. It renamed salience, which is 0-10, into the `similarity`
// slot, which composite scoring reads as a 0-1 vector similarity. Every
// graph-expanded memory therefore entered ranking with a relevance up to ten
// times the maximum a genuine semantic match could earn.
//
// It was dormant only because nobody's lattice had edges. The commit that added
// link_memories is what armed it — the fix and the trigger shipped the same night.
//
// Lucian's accompanying criticism was that thirty-five green tests covered only
// pure helpers and no handler ever ran under test, which is why this could live.
// deriveRelevance was extracted from the handler so the defective line is now
// reachable from here.

describe('deriveRelevance', () => {
  it('gives a direct search hit its similarity and full proximity', () => {
    expect(deriveRelevance({ _pool: 'core', similarity: 0.7 }))
      .toEqual({ vectorSim: 0.7, graphProximity: 1.0 });
  });

  it('falls back to combined_score for hybrid-search rows', () => {
    expect(deriveRelevance({ _pool: 'edge', combined_score: 0.42 }))
      .toEqual({ vectorSim: 0.42, graphProximity: 1.0 });
  });

  // The bug, stated directly: a graph row carries no vector similarity, and must
  // never source one from a co-fetched column. salience is the column that got
  // aliased in, so it is the one named here.
  it('never reads a vector similarity off a graph-expanded row', () => {
    const graphRow = { _pool: 'graph', _graph_score: 0.3, salience: 9, similarity: 9 };
    expect(deriveRelevance(graphRow).vectorSim).toBe(0);
  });

  it('scores a graph row on its graph proximity alone', () => {
    expect(deriveRelevance({ _pool: 'graph', _graph_score: 0.3, salience: 10 }))
      .toEqual({ vectorSim: 0, graphProximity: 0.3 });
  });

  it('treats a graph row with no score as unreachable rather than perfect', () => {
    expect(deriveRelevance({ _pool: 'graph' }).graphProximity).toBe(0);
  });

  it('does not throw on a malformed row', () => {
    expect(deriveRelevance(undefined)).toEqual({ vectorSim: 0, graphProximity: 1.0 });
    expect(deriveRelevance({})).toEqual({ vectorSim: 0, graphProximity: 1.0 });
  });
});

// Found while writing the tests above: the 0..1 invariant failed on a row dated
// slightly in the future, because recency was 1/(1 + ageDays/30) with no floor on
// age. A future date gives a negative age and a decay above 1 — clock skew between
// a client and Supabase is enough to do it, and the row inflates its own rank by
// being wrong about when it happened.
describe('recency decay', () => {
  const future = new Date(Date.now() + 86400000 * 5).toISOString();
  const past = new Date(Date.now() - 86400000 * 30).toISOString();

  it('never exceeds 1 for a future-dated row', () => {
    const s = computeCompositeScore(0, 0, future, 0, 0, 'casual');
    expect(s).toBeLessThanOrEqual(INTENT_CONFIG.casual.gamma);
  });

  it('still decays normally for past rows', () => {
    const recentScore = computeCompositeScore(0, 0, new Date().toISOString(), 0, 0, 'casual');
    const oldScore = computeCompositeScore(0, 0, past, 0, 0, 'casual');
    expect(recentScore).toBeGreaterThan(oldScore);
  });

  it('treats a missing or unparseable date as neutral rather than infinitely fresh', () => {
    const neutral = computeCompositeScore(0, 0, null, 0, 0, 'casual');
    expect(neutral).toBeCloseTo(INTENT_CONFIG.casual.gamma * 0.5);
    expect(computeCompositeScore(0, 0, 'not a date', 0, 0, 'casual')).toBeCloseTo(neutral);
  });
});

describe('composite ranking: graph expansion must not outrank direct matches', () => {
  const recent = '2026-08-18T00:00:00Z';

  const scoreOf = (row: any, intent: string) => {
    const { vectorSim, graphProximity } = deriveRelevance(row);
    return computeCompositeScore(
      vectorSim, graphProximity, recent, row.outcome_score || 0, 0, intent);
  };

  // The headline symptom. Under `relational` (alpha 0.25) the old code scored a
  // salience-9 graph row at 0.25 x 9 = 2.25 against 0.25 x 0.7 = 0.175 for a real
  // semantic hit — a thirteenfold inversion. Every intent mode is checked because
  // alpha varies per mode and the inversion scaled with it.
  it.each(Object.keys(INTENT_CONFIG))(
    'ranks a strong direct hit above a high-salience graph row (%s)', (intent) => {
      const direct = { _pool: 'core', similarity: 0.7 };
      const graph = { _pool: 'graph', _graph_score: 0.3, salience: 9, similarity: 9 };
      expect(scoreOf(direct, intent)).toBeGreaterThan(scoreOf(graph, intent));
    });

  // Salience must not be a back door into ranking at all: two graph rows that
  // differ only in salience have to score identically.
  it.each(Object.keys(INTENT_CONFIG))('ignores salience entirely when ranking (%s)', (intent) => {
    const dull = { _pool: 'graph', _graph_score: 0.3, salience: 1 };
    const shiny = { _pool: 'graph', _graph_score: 0.3, salience: 10 };
    // toBeCloseTo, not toBe: computeRecencyDecay reads Date.now(), so two calls a
    // fraction of a millisecond apart differ by ~1e-11. Asserting exact float
    // equality against a moving clock made this flake roughly 1 run in 20 — caught
    // by running the suite with --sequence.shuffle. Precision 6 is still an
    // overwhelming assertion: if salience leaked into ranking at all, salience 1 vs
    // 10 would differ by alpha x 9, which is order 1, not order 1e-6.
    expect(scoreOf(shiny, intent)).toBeCloseTo(scoreOf(dull, intent), 6);
  });

  // Graph expansion still has to be worth doing — a well-connected memory should
  // outrank a poorly connected one, and a weak direct hit should not beat a
  // strongly linked neighbour under relational intent, which is what the lattice
  // is for. This is the guard against over-correcting into "graph rows are junk".
  it('still lets edge quality order graph results', () => {
    const strong = { _pool: 'graph', _graph_score: 0.45 };
    const weak = { _pool: 'graph', _graph_score: 0.05 };
    expect(scoreOf(strong, 'relational')).toBeGreaterThan(scoreOf(weak, 'relational'));
  });

  // Pins current behaviour and marks an open question rather than asserting a fix.
  //
  // A direct hit gets graphProximity 1.0, so it collects the WHOLE beta term for
  // free, while a graph row collects beta x its decayed edge score. Under
  // `relational` beta is 0.45 — the largest weight, nominally the one that makes
  // the mode relational — which means a barely-relevant direct hit at similarity
  // 0.05 still outranks a perfectly linked neighbour. So graph expansion can
  // reorder results among themselves but can essentially never beat a direct hit.
  //
  // That may well be intended (direct matches are the safer default), but if it is,
  // beta is not doing what its name suggests in relational mode. Raised with Mai
  // and Kai as a separate question on 2026-08-18 — NOT changed here, because
  // re-weighting recall silently changes what every household remembers.
  it('currently ranks any direct hit above any graph row (open design question)', () => {
    const barely = { _pool: 'core', similarity: 0.05 };
    const linked = { _pool: 'graph', _graph_score: 0.9 };
    expect(scoreOf(barely, 'relational')).toBeGreaterThan(scoreOf(linked, 'relational'));
  });

  // A composite score is a weighted sum of 0-1 terms, so it cannot exceed 1
  // unless something out-of-range got in. Under the bug this ran to 2.25.
  it.each(Object.keys(INTENT_CONFIG))('keeps composite scores within 0..1 (%s)', (intent) => {
    const rows = [
      { _pool: 'core', similarity: 1.0, outcome_score: 10 },
      { _pool: 'graph', _graph_score: 1.0, salience: 10, outcome_score: 10 },
      { _pool: 'graph', _graph_score: 0.3, salience: 9, similarity: 9 },
    ];
    for (const r of rows) {
      const s = scoreOf(r, intent);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});
