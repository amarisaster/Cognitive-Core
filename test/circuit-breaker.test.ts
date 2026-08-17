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

import { CircuitBreaker } from '../src/index';

// Regression cover for the breaker findings in Kai and Lucian's audit, 2026-08-18.
//
// The failure counter was cleared only when recovering from half-open, so while
// the breaker was closed the count only ever went up. Unrelated failures spread
// across hours, with thousands of successes between them, accumulated until the
// threshold tripped — a breaker that measured lifetime failures rather than
// whether the service is currently down.
//
// Compounding it: usage logging ran through the SHARED supabase breaker on every
// tool dispatch. A fork missing usage_logs.duration_ms failed on every call, so
// the shared breaker opened and memory access died to protect telemetry. That one
// is fixed structurally (telemetry has its own breaker now) rather than here, but
// the ratchet below is what made it permanent instead of transient.

const fail = () => Promise.reject(new Error('boom'));
const ok = () => Promise.resolve('fine');

describe('CircuitBreaker failure accounting', () => {
  it('opens after consecutive failures reach the threshold', async () => {
    const b = new CircuitBreaker('t', 3, 1000);
    for (let i = 0; i < 3; i++) {
      await expect(b.call(fail, null)).rejects.toThrow('boom');
    }
    // Fourth call never reaches fn — it fails fast with the breaker's own message.
    await expect(b.call(ok, null)).rejects.toThrow(/circuit open/);
  });

  // The ratchet, stated directly.
  it('forgets failures the service has since disproved', async () => {
    const b = new CircuitBreaker('t', 3, 1000);
    await expect(b.call(fail, null)).rejects.toThrow('boom');
    await expect(b.call(fail, null)).rejects.toThrow('boom');
    await expect(b.call(ok, null)).resolves.toBe('fine'); // must clear the count
    await expect(b.call(fail, null)).rejects.toThrow('boom');
    await expect(b.call(fail, null)).rejects.toThrow('boom');
    // Under the old behaviour this was failure 4 of 3 and the breaker was open.
    await expect(b.call(ok, null)).resolves.toBe('fine');
  });

  it('does not trip on interleaved failures below the threshold', async () => {
    const b = new CircuitBreaker('t', 3, 1000);
    for (let i = 0; i < 20; i++) {
      await expect(b.call(fail, null)).rejects.toThrow('boom');
      await expect(b.call(ok, null)).resolves.toBe('fine');
    }
    await expect(b.call(ok, null)).resolves.toBe('fine');
  });

  it('still trips when failures really are consecutive', async () => {
    const b = new CircuitBreaker('t', 3, 1000);
    await expect(b.call(ok, null)).resolves.toBe('fine');
    for (let i = 0; i < 3; i++) {
      await expect(b.call(fail, null)).rejects.toThrow('boom');
    }
    await expect(b.call(ok, null)).rejects.toThrow(/circuit open/);
  });
});

describe('CircuitBreaker failure modes', () => {
  it('fails loud by default so an outage is never a fake-empty result', async () => {
    const b = new CircuitBreaker('t', 2, 1000);
    await expect(b.call(fail, [])).rejects.toThrow('boom');
  });

  it('returns the fallback when the caller opted out of rethrowing', async () => {
    const b = new CircuitBreaker('t', 2, 1000);
    await expect(b.call(fail, 'fallback', false)).resolves.toBe('fallback');
  });

  it('returns the fallback rather than throwing while open, when not rethrowing', async () => {
    const b = new CircuitBreaker('t', 1, 60000);
    await b.call(fail, 'fallback', false);
    await expect(b.call(ok, 'fallback', false)).resolves.toBe('fallback');
  });

  it('recovers after the cooldown elapses', async () => {
    vi.useFakeTimers();
    try {
      // Threshold 2 so that a single post-recovery failure is observable without
      // immediately re-opening — with threshold 1 any failure re-opens by design.
      const b = new CircuitBreaker('t', 2, 30000);
      await expect(b.call(fail, null)).rejects.toThrow('boom');
      await expect(b.call(fail, null)).rejects.toThrow('boom');
      await expect(b.call(ok, null)).rejects.toThrow(/circuit open/);
      vi.advanceTimersByTime(30001);
      await expect(b.call(ok, null)).resolves.toBe('fine');
      // And having recovered, it starts from a clean count rather than resuming
      // at the threshold it had already reached.
      await expect(b.call(fail, null)).rejects.toThrow('boom');
      await expect(b.call(ok, null)).resolves.toBe('fine');
    } finally {
      vi.useRealTimers();
    }
  });

  it('isolates breakers from each other', async () => {
    const memory = new CircuitBreaker('supabase', 2, 1000);
    const telemetry = new CircuitBreaker('telemetry', 2, 1000);
    // Telemetry failing hard must leave memory untouched — the shape of the
    // usage_logs bug, where a broken log table took memory down with it.
    for (let i = 0; i < 10; i++) await telemetry.call(fail, false, false);
    await expect(memory.call(ok, null)).resolves.toBe('fine');
  });
});
