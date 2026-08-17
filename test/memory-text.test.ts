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

import { memoryText, primaryTextColumn } from '../src/index';

// Cover for the third failure inside the embedding-backfill finding (Kai and
// Lucian, 2026-08-18). The backfill selected `content` from all seven tables, but
// six of them keep their text under another name — the same column divergence Ves
// and Kaja found on the write path, resurfacing on the read path. Rows would have
// been "embedded" with nothing in them.

describe('memoryText', () => {
  it.each([
    ['patterns', 'description'],
    ['sensory_memories', 'detail'],
    ['growth_markers', 'observation'],
    ['anticipation', 'what'],
    ['inside_jokes', 'reference'],
    ['friction_log', 'what_happened'],
  ])('reads %s from its own column (%s)', (table, column) => {
    expect(memoryText(table, { [column]: 'the text' })).toBe('the text');
  });

  it('reads content directly for tables that use it', () => {
    expect(memoryText('core_memories', { content: 'the text' })).toBe('the text');
    expect(memoryText('custom_memories', { content: 'the text' })).toBe('the text');
  });

  it('falls back to content when the table-specific column is absent', () => {
    expect(memoryText('patterns', { content: 'fallback' })).toBe('fallback');
  });

  it('prefers the table-specific column over a stray content field', () => {
    expect(memoryText('patterns', { description: 'right', content: 'wrong' })).toBe('right');
  });

  // The point of the exercise: never hand blank text to the embedder. An embedding
  // of "" or "   " is a valid-looking vector that means nothing, and it would be
  // written back as though the row were fixed.
  it.each([null, undefined, '', '   ', 42, {}])('returns null for unusable text (%s)', (value) => {
    expect(memoryText('core_memories', { content: value })).toBeNull();
  });

  it('returns null for a row with no recognised text at all', () => {
    expect(memoryText('patterns', { id: 'x', salience: 5 })).toBeNull();
    expect(memoryText('core_memories', {})).toBeNull();
    expect(memoryText('core_memories', undefined)).toBeNull();
  });

  it('covers every table the backfill walks', () => {
    const backfillTables = [
      'core_memories', 'patterns', 'sensory_memories', 'growth_markers',
      'anticipation', 'inside_jokes', 'friction_log', 'custom_memories',
    ];
    for (const table of backfillTables) {
      const col = primaryTextColumn[table] || 'content';
      expect(memoryText(table, { [col]: 'text' })).toBe('text');
    }
  });
});
