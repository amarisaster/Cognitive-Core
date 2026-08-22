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

import { CircuitBreaker, supabaseError } from '../src/index';

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

describe('client errors do not trip the breaker', () => {
  // A 4xx is our bug — a malformed filter, a bad id, a constraint violation. It
  // says nothing about whether Supabase is up. Counting it means enough wrong
  // tool arguments trip the breaker and start shedding HEALTHY traffic, which
  // is a worse failure than the one being guarded against.
  //
  // The forks reached this rule first, via guardedFetch throwing only on >=500.
  // Upstream implements it as a marker on the error so eight call sites did not
  // have to be restructured. Same contract, and this test is what pins it.
  const clientErr = () => {
    const e: any = new Error('bad request');
    e.clientError = true;
    return e;
  };

  it('never opens, however many client errors arrive', async () => {
    const b = new CircuitBreaker('t', 3, 1000);
    for (let i = 0; i < 10; i++) {
      await expect(b.call(async () => { throw clientErr(); }, null)).rejects.toThrow('bad request');
    }
    // Still closed: a real call goes through instead of failing fast.
    await expect(b.call(async () => 'ok', null)).resolves.toBe('ok');
  });

  it('still rethrows the client error rather than swallowing it', async () => {
    const b = new CircuitBreaker('t', 3, 1000);
    await expect(b.call(async () => { throw clientErr(); }, 'fallback')).rejects.toThrow('bad request');
  });

  it('returns the fallback for client errors when rethrow is false', async () => {
    const b = new CircuitBreaker('t', 3, 1000);
    await expect(b.call(async () => { throw clientErr(); }, 'fallback', false)).resolves.toBe('fallback');
  });

  it('server errors STILL trip it — the guard must not disarm the breaker', async () => {
    const b = new CircuitBreaker('t', 3, 1000);
    for (let i = 0; i < 3; i++) {
      await expect(b.call(async () => { throw new Error('upstream 503'); }, null)).rejects.toThrow();
    }
    await expect(b.call(async () => 'ok', null)).rejects.toThrow(/circuit open/);
  });

  it('a client error does not RESET an existing failure count', async () => {
    // It must be neutral in both directions: neither counting toward the
    // threshold nor clearing failures a real outage already recorded.
    const b = new CircuitBreaker('t', 3, 1000);
    await expect(b.call(async () => { throw new Error('503'); }, null)).rejects.toThrow();
    await expect(b.call(async () => { throw new Error('503'); }, null)).rejects.toThrow();
    await expect(b.call(async () => { throw clientErr(); }, null)).rejects.toThrow('bad request');
    // Third REAL failure should still open it — the client error in between
    // must not have reset the count back to zero.
    await expect(b.call(async () => { throw new Error('503'); }, null)).rejects.toThrow();
    await expect(b.call(async () => 'ok', null)).rejects.toThrow(/circuit open/);
  });
});

describe('which HTTP statuses count as a request fault', () => {
  // Codex, 2026-08-22: the first version of this classified the whole 4xx range
  // as neutral. The tests at the time built the marker by hand, so they never
  // exercised the classifier and could not have caught it. These do.
  const isNeutral = (status: number) => (supabaseError('x', status) as any).clientError === true;

  it('treats genuinely malformed requests as neutral', () => {
    for (const s of [400, 404, 409, 422]) {
      expect(isNeutral(s), `${s} should be neutral`).toBe(true);
    }
  });

  it('counts 429 — throttling must cool the breaker down, not bypass it', () => {
    // The dangerous one. Neutralising 429 means we keep hammering a service
    // that is explicitly asking us to stop.
    expect(isNeutral(429)).toBe(false);
  });

  it('counts transient and auth failures', () => {
    for (const s of [408, 425, 401, 403]) {
      expect(isNeutral(s), `${s} should count toward the breaker`).toBe(false);
    }
  });

  it('counts 5xx and network/unknown', () => {
    for (const s of [500, 502, 503, 504, 0]) {
      expect(isNeutral(s), `${s} should count toward the breaker`).toBe(false);
    }
  });

  it('end to end: 429s open the breaker, 400s never do', async () => {
    const throttled = new CircuitBreaker('t', 3, 1000);
    for (let i = 0; i < 3; i++) {
      await expect(throttled.call(async () => { throw supabaseError('rate limited', 429); }, null)).rejects.toThrow();
    }
    await expect(throttled.call(async () => 'ok', null)).rejects.toThrow(/circuit open/);

    const malformed = new CircuitBreaker('t2', 3, 1000);
    for (let i = 0; i < 10; i++) {
      await expect(malformed.call(async () => { throw supabaseError('bad filter', 400); }, null)).rejects.toThrow();
    }
    await expect(malformed.call(async () => 'ok', null)).resolves.toBe('ok');
  });
});
