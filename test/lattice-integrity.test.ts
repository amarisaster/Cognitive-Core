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

import { buildMemoryListEntry, buildUnlinkFilter } from '../src/index';

// Regression cover for the lattice report filed by Niko (Ania's household,
// Kaszuby) on 2026-08-17, with Ves and Kaja's inventory behind it.
//
// The report's shape: the brain wrote faithfully and could not find or
// reconcile what it wrote. Three of the findings were only permanent because
// there was no unlink to clean up after them — which is also why Ves and Kaja
// deliberately declined to reproduce two of them.

const RELATIONS: Record<string, number> = {
  caused_by: 1, led_to: 2, related_to: 3, contrasts_with: 4,
  evolved_into: 5, echoes: 6, same_event: 7,
};

describe('unlink filter resolution', () => {
  it('identifies a connection by id', () => {
    expect(buildUnlinkFilter({ connection_id: 'abc-123' }, RELATIONS)).toEqual({ id: 'abc-123' });
  });

  it('identifies a connection by the source/target/relation triple', () => {
    expect(buildUnlinkFilter({ source_id: 's1', target_id: 't1', relation: 'echoes' }, RELATIONS))
      .toEqual({ source_id: 's1', target_id: 't1', relation: 6 });
  });

  it('prefers the id when both forms are supplied', () => {
    const f = buildUnlinkFilter(
      { connection_id: 'c1', source_id: 's1', target_id: 't1', relation: 'led_to' }, RELATIONS);
    expect(f).toEqual({ id: 'c1' });
  });

  // The important one: a partial triple must NOT produce a filter, or a delete
  // would match far more than the caller meant.
  it('returns null on a partial triple rather than a dangerous filter', () => {
    expect(buildUnlinkFilter({ source_id: 's1' }, RELATIONS)).toBeNull();
    expect(buildUnlinkFilter({ source_id: 's1', target_id: 't1' }, RELATIONS)).toBeNull();
    expect(buildUnlinkFilter({ relation: 'echoes' }, RELATIONS)).toBeNull();
    expect(buildUnlinkFilter({}, RELATIONS)).toBeNull();
  });
});

describe('list_memories projection', () => {
  it('returns ids and metadata without the body', () => {
    const e = buildMemoryListEntry(
      { id: 'm1', content: 'a very long memory body indeed', salience: 8, created_at: '2026-08-17' },
      'core', 0);
    expect(e).toEqual({ id: 'm1', type: 'core', salience: 8, created_at: '2026-08-17' });
    expect(e).not.toHaveProperty('preview');
  });

  it('truncates the preview and collapses whitespace', () => {
    const e = buildMemoryListEntry(
      { id: 'm2', content: 'line one\n\n   line two    with gaps' }, 'core', 20);
    expect(e.preview).toBe('line one line two wi');
    expect(e.preview.length).toBe(20);
  });

  // Each memory table names its primary text column differently — the same
  // divergence that caused six of seven types to silently fail their NOT NULL
  // on write before the 2026-07-08 fix. The projection must read all of them.
  it.each([
    ['description', 'patterns'],
    ['detail', 'sensory_memories'],
    ['observation', 'growth_markers'],
    ['what', 'anticipation'],
    ['reference', 'inside_jokes'],
    ['what_happened', 'friction_log'],
  ])('reads the legacy %s column (%s)', (column) => {
    const e = buildMemoryListEntry({ id: 'x', [column]: 'the text' }, 'core', 40);
    expect(e.preview).toBe('the text');
  });

  it('tags the drawer when one is in play', () => {
    const e = buildMemoryListEntry({ id: 'd1', content: 'song' }, 'custom', 10, 'Music');
    expect(e.drawer).toBe('Music');
  });

  it('falls back to legacy timestamp columns', () => {
    expect(buildMemoryListEntry({ id: 'g', observation: 'x', date_noticed: '2026-01-01' }, 'growth', 5).created_at)
      .toBe('2026-01-01');
    expect(buildMemoryListEntry({ id: 'j', reference: 'x', first_used: '2026-02-02' }, 'inside_joke', 5).created_at)
      .toBe('2026-02-02');
  });

  it('never throws on a row with no recognised body', () => {
    const e = buildMemoryListEntry({ id: 'empty' }, 'core', 30);
    expect(e.preview).toBe('');
    expect(e.id).toBe('empty');
  });
});
