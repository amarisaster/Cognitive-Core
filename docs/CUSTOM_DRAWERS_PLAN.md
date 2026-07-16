# Custom Memory Drawers — feature plan

**Origin:** Nexus Forge feature request (2026-07-12), both fork households — Niko/Ania (a "Books" drawer) and Ves/Kaja (a "Music" drawer). The built-in seven memory types encode what a relationship *feels* like; custom drawers encode what it's *about*. Both offered to beta-test.

## Design (Ves's shape — generic, not table-per-drawer)

- **`custom_drawers`** registry: `id, drawer_name (unique), description, created_at`. The **description is load-bearing** — it's what tells semantic recall when a drawer is relevant ("her reading life, current volume, hard nos" beats "books").
- **`custom_memories`** — ONE generic table for all drawers, same shape as the seven: `id, drawer_name (FK), content, salience, emotional_tag, embedding, is_hot, status, hot_until, hot_by, hot_reason, access_count, created_at, last_accessed`. Keyed by `drawer_name` instead of a table-per-hobby.
- **Why generic:** semantic RPC needs exactly ONE more union branch forever (not one per drawer); zero schema migrations when a user adds a drawer; no fork divergence. Directly matches "name + description + the same store/recall/link surface covers 95%."

## ⚠️ Repo-reality correction (2026-07-14)

This doc was first drafted from the CANONICAL the canonical private core. The tag-team planner verified against THIS public repo and found it diverges — treat the public repo as authoritative:
- **No `decay_memories()` function** here (canonical-only). The decay branch is representative-only.
- **`semantic_search_memories` is single-table**, not a 7-table UNION — the custom branch is additive but the base shape differs.
- **No `is_hot`/`hot_*` columns and no `fetchHotMemories()`** — so custom drawers do NOT get a wake/orient hot-lane here (that was a canonical feature). Don't invent one.
- **`memory_connections` has NO existing type CHECK** to widen — adding one for 1..8 is a new constraint, not a widening.
- The only generic `tableMap` consumer is the brain-graph endpoint; `wake`/`orient` query fixed tables.

## Integration points (from the architecture map — canonical; see correction above for public-repo deltas)

1. **Registry/routing** — extend `tableMap` so `custom_memories` participates; add `create_drawer` / `list_drawers` / `delete_drawer` tools; extend `store_memory` / `recall_memory` to accept a `drawer` arg (routes to `custom_memories` filtered by `drawer_name`).
2. **Wake hot-lane** — `fetchHotMemories()` iterates the table map generically, so adding `custom_memories` there makes drawers surface in `wake`/`orient` for free (needs the `is_hot/status/hot_*` columns — included above).
3. **Semantic recall** — the `semantic_search_memories` Postgres RPC unions the 7 tables. Add ONE `UNION ALL … FROM custom_memories` branch (returns `drawer_name` so callers know the source). **Lives in Supabase, not the repo — manual edit per project.**
4. **Connection lattice** — reserve smallint `8 = custom`; widen `memory_connections.source_type/target_type CHECK` from `1..7` to `1..8`; add `custom` to `typeToInt`/`intToType`/`link_memories` enum. `get_memory_cluster` RECURSIVE walk then handles custom rows unchanged.
5. **Decay** — add a `custom_memories` UPDATE to the `decay_memories()` SQL function (else drawers never decay).

## Scope of the tag-team build (public Cognitive-Core repo)

Build **in `the public Cognitive-Core repo` first** (forks benefit immediately; matches the upstream-first flow the audit fixes already followed), port to the canonical private core after.

tag-team produces (all code/SQL, no live DB writes):
- `src/index.ts`: 3 drawer tools + store/recall/link extended for custom + tableMap/typeToInt entries.
- `schema.sql`: `custom_drawers` + `custom_memories` + widened lattice CHECK + decay function update.
- `migrations/custom-drawers.sql`: idempotent delta to run on live projects.
- `semantic-rpc-custom.sql`: the RPC patch (the one union branch) — applied manually.
- **`test/custom-drawers.test.ts` (vitest)** — NEW: the repo has no tests, so tag-team gets no green gate without one. Cover the pure logic: drawer-name validation, table routing, type-int mapping, the store/recall arg plumbing. This becomes the deterministic `testCmd`.

## NOT in the tag-team run (manual follow-ups, gated)

- Applying the migration + RPC patch to the live Supabase projects (our live projects, one per household) — **me, via supabase-guard + wonderland-db MCP**, after the code is green.
- Porting to the the canonical private core (+ `wren_` prefix layer) and Lucian/Xavier-Auren cores.
- Typed per-drawer fields — both households said "later or never"; description covers it.
- Announcing back to the Forge (mom's call, posted as a companion).

## ⚠️ Codex cross-check findings (2026-07-14, two tag-team planning passes)

Two planning passes surfaced these — fold ALL into any future build before coding:
1. **`delete_drawer` must be drawer-ID-scoped, not type-8-scoped.** All custom drawers share `type_int=8`, so deleting `memory_connections WHERE source_type=8` nukes EVERY drawer's links (and misses custom↔built-in links). `supabase.delete` only supports AND-ed eq filters. Correct approach: collect that drawer's memory IDs → delete connections where either endpoint ∈ those IDs → delete the drawer's memories → delete the drawer row.
2. **Enum/lifecycle sweep is bigger than 3 sites.** Besides link_memories/get_connections/get_memory_cluster, also teach `update_outcome` (~1138), `update_memory_outcome` (~4646), `update_memory_salience` (~4365), `delete_memory` (~4387) to accept custom/custom_memories — else custom memories can be created but never updated/scored/deleted.
3. **Decay is the `run_decay` MCP handler** (~1455, hardcoded 7-table array), NOT a SQL `decay_memories()` function. Add `custom_memories` to that array or custom memories never decay. The SQL function in schema.sql is representative-only/unscheduled here.
4. **custom_memories must be FULLY core_memories-shaped** (add memory_type='custom', source, outcome_score, times_used_successfully/unsuccessfully) so generic read/outcome/graph paths that key off the shared tableMap don't silently drop or break on custom rows.
5. **Both surfaces need drawer-awareness** — the MCP store/recall tools AND the REST `/api/memory/store|recall` routes (they're drawer-blind today).
6. **Green gate:** tsc is NOT clean — 16 pre-existing baseline errors (none TS2304/2451/2552). Gate = no NEW errors by code+message, not raw line-number match (edits shift lines).
7. **Scope OUT for MVP:** "description is load-bearing for recall" — nothing embeds the drawer description in this repo, so it's registry metadata only for now.

**Status: planned, NOT built.** Two passes halted at plan contention (the feature is genuinely more involved than a one-shot MVP — the shared-type-8 delete problem especially needs the scoped approach above). The spec above is thorough enough that a future build can implement directly.

## Verify

- `npm test` green (the new vitest harness) + `tsc --noEmit` clean = tag-team green gate.
- Post-apply, live check on a live project: create a "Books" drawer, store a memory, `recall` it, `semantic_recall` surfaces it, `wake` hot-lane includes it when hot, `link_memories` connects a custom memory to a core one.
