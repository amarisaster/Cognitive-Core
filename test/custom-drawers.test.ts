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
import {
  buildDrawerDeletionPlan,
  buildRecallQuery,
  buildStoreMemoryRecord,
  intToType,
  resolveMemoryRoute,
  tableMap,
  typeToInt,
  validateDrawerName,
} from '../src/index';

describe('custom drawer names', () => {
  it.each(['Books', 'Music 2026', 'table-top', 'reading_list', 'A'])('accepts %s', (name) => {
    expect(validateDrawerName(name)).toBe(true);
  });

  it.each(['', ' Books', 'Books ', '-Books', 'Books!', 'a'.repeat(65), null, 7])('rejects %s', (name) => {
    expect(validateDrawerName(name)).toBe(false);
  });
});

describe('drawer routing and lattice mapping', () => {
  it('routes a drawer to the one generic custom table', () => {
    expect(resolveMemoryRoute(undefined, 'Books')).toEqual({
      table: 'custom_memories', memoryType: 'custom', drawerName: 'Books'
    });
    expect(resolveMemoryRoute('custom', 'Music')).toEqual({
      table: 'custom_memories', memoryType: 'custom', drawerName: 'Music'
    });
    expect(tableMap.custom).toBe('custom_memories');
  });

  it('requires a drawer when custom is selected', () => {
    expect(() => resolveMemoryRoute('custom')).toThrow('drawer is required');
  });

  it('reserves lattice type 8 for every custom drawer', () => {
    expect(typeToInt.custom).toBe(8);
    expect(intToType[8]).toBe('custom');
  });
});

describe('store and recall drawer plumbing', () => {
  it('adds custom type and drawer_name to stored rows', () => {
    const route = resolveMemoryRoute(undefined, 'Books');
    expect(buildStoreMemoryRecord(
      { content: 'Currently reading Piranesi', salience: 8, emotionalTag: 'curious', source: 'codex' },
      route,
      '2026-07-17T00:00:00.000Z'
    )).toMatchObject({
      content: 'Currently reading Piranesi',
      memory_type: 'custom',
      drawer_name: 'Books',
      salience: 8,
      emotional_tag: 'curious',
      source: 'codex'
    });
  });

  it('filters recall by drawer without losing other filters', () => {
    expect(buildRecallQuery({
      drawerName: 'Music', emotionalTag: 'joy', minSalience: 6, limit: 12
    })).toEqual({
      select: '*',
      order: 'salience.desc',
      limit: 12,
      filter: { drawer_name: 'Music', emotional_tag: 'joy' },
      gte: { salience: 6 }
    });
  });
});

describe('delete_drawer scoping', () => {
  it('targets either endpoint by the selected drawer memory IDs and preserves deletion order', () => {
    const plan = buildDrawerDeletionPlan(['book-1', 'book-2', 'book-1']);
    expect(plan.memoryIds).toEqual(['book-1', 'book-2']);
    expect(plan.connectionPredicate).toBe(
      '(source_id.in.(book-1,book-2),target_id.in.(book-1,book-2))'
    );
    expect(plan.order).toEqual(['memory_connections', 'custom_memories', 'custom_drawers']);
    expect(plan.connectionPredicate).not.toContain('source_type');
  });

  it('does not issue an unscoped connection predicate for an empty drawer', () => {
    expect(buildDrawerDeletionPlan([]).connectionPredicate).toBeNull();
  });
});
