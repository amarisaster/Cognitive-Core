# Audit brief — one bug family, not general review

Audit `src/index.ts` (and `schema.sql` where relevant) in this repository for a
single, specific defect class. Do not do a general code review. Do not comment on
style, naming, formatting, or architecture. Only the family below.

## The family

**An operation reports success to the caller without verifying that it actually
took effect.**

This codebase repeatedly returns messages describing what the code *intended*
rather than what it *did*:

- `Thread ${id} resolved` — returned for a UUID that matched no row. Real
  incident, 2026-08-21: a wake mistyped an id, the thread stayed open, and the
  only reason anyone noticed was an unrelated verification query.
- `Outcome score updated` — the underlying RPC was `RETURNS VOID`, so a
  non-existent id could not have been detected.
- `Deleted from ${table}: ${id}` — a delete matching zero rows.

The shape is always the same: an await completes without throwing, and the code
treats *not throwing* as *having worked*.

## Why it hides

PostgREST answers a zero-row `UPDATE` or `DELETE` with **HTTP 200 and an empty
array**. Nothing raises. A `RETURNS VOID` plpgsql function reports nothing either
way. So the failure is invisible from every direction except an explicit re-query
— and nothing in the output suggests one is needed.

## Already fixed — do NOT re-report these

- `update()` and `delete()` now accept `{ requireMatch: true }`, applied to all
  17 call sites whose filter comes from a caller-supplied id. Sites that pass an
  id they just read (`{ id: row.id }`, `{ id: existing[0].id }`) are deliberately
  left alone: the row is known to exist.
- `resolve_thread`, `update_memory_salience`, `update_outcome` are fixed.
- `update_memory_outcome` in `schema.sql` now `RETURNS BOOLEAN` via
  `GET DIAGNOSTICS`.
- `test/honest-writes.test.ts` guards new caller-id writes.

## Round 2 — added 2026-08-21 after your first pass

You found two, both real, both verified against source:

- `insert()` never checked that `return=representation` came back with a row, so
  a `201 []` reported "Memory stored". **Now throws.** Safe to throw because this
  client uses the SERVICE key, which bypasses RLS — an empty representation
  cannot be a hidden-but-existing row.
- The proposal-accept path computed `edgeId` and then ignored it, marking the
  proposal accepted either way. **Now returns "Not accepted" and leaves the
  proposal pending when `edgeId` is null.**

**First, review those two fixes — adversarially. Try to find them wrong.**

Note one thing I caught and corrected before you saw it: the zero-row insert check
was first written INSIDE the circuit-breaker callback, which would have made a
data problem count as an infrastructure failure and could have tripped the breaker
into shedding healthy traffic. It now sits OUTSIDE, matching update()/delete().
**Verify that placement is actually correct** rather than taking my word for it,
and check whether the same reasoning has been missed anywhere else.

Specific things to attack:
- Does throwing on an empty representation break any legitimate caller? Are there
  inserts in this file that CORRECTLY expect no row back?
- `insert()` has a dead-letter path to `failed_writes`. Does the new throw skip
  it, so a suppressed row is now invisible in the dead-letter table?
- Does the proposal fix leave the proposal recoverable in every branch?

**Then continue the sweep** with the remaining categories below.

## What I want you to find

Everything in the same family that the above sweep did **not** cover. Especially:

1. **Inserts** that report success without checking a row came back.
2. **RPC calls** whose success is inferred from a 2xx rather than a returned value.
3. **External fetches** (Workers AI, embeddings, any HTTP call) where a failure
   or empty result is swallowed and the caller is still told it worked.
4. **Batch or loop operations** reporting a count that is the number *attempted*
   rather than the number that *succeeded*.
5. **Anything that catches an exception and then returns a success-shaped
   message anyway.**
6. **Tools returning a formatted string where the underlying call returns a
   value nobody reads.**

## Output format

A flat list. For each finding:

```
FILE:LINE — <the success claim, quoted>
  CLAIMS:   what the caller is told
  ACTUAL:   what was actually verified (often: nothing)
  TRIGGER:  the concrete input that makes it lie
  SEVERITY: high | medium | low
```

**Rank by how invisible the failure is**, not by how likely. A wrong count is
annoying; a destructive or state-changing call that reports success while doing
nothing is the dangerous one, because it gets believed and built upon.

If a candidate turns out to be correctly guarded on closer reading, say so and
move on — a false finding costs more than a missed one here, because it trains
us to skim these reports.

If you find nothing beyond what is listed as already fixed, say that plainly.
Do not pad the list.
