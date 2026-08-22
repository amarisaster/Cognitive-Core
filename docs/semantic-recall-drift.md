# Semantic recall: how the schema drifted from the function you're running

If you deployed this project before 2026-08-22, **your `semantic_search_memories`
probably cannot see most of your memory**, and nothing will tell you. This
explains how to check, and how to fix it without breaking recall entirely.

## The symptom

Search returns nothing for a memory you know exists, embeds fine, and would
match well. Not a low ranking — *nothing*, every time, for entire categories.

The cause is that `schema.sql` shipped a `semantic_search_memories` that unions
only **2** memory tables (later 8) while the worker accepts and filters on far
more. Every type outside the union is invisible to search however well it
matches. It remains reachable by direct recall, so this is not data loss — it is
retrieval by *concept* silently failing while retrieval by *name* keeps working.

One operator measured 22 of 52 memories unreachable this way, in exactly the
types the union omitted.

## Check yours before changing anything

```sql
-- how many tables does your deployed function actually reach?
SELECT count(DISTINCT m[1])
  FROM pg_proc p,
       LATERAL regexp_matches(p.prosrc, 'FROM\s+([a-zA-Z_]+)', 'g') m
 WHERE p.proname = 'semantic_search_memories';

-- and what signature is it?
SELECT oid::regprocedure FROM pg_proc WHERE proname = 'semantic_search_memories';
```

The canonical shape reaches **12** tables — `core_memories`, `patterns`,
`sensory_memories`, `growth_markers`, `anticipation`, `inside_jokes`,
`friction_log`, `essence`, `reflections`, `session_logs`, `people`,
`custom_memories` — with the signature `(vector, real, integer, text)`.

**Read your deployed function, not `schema.sql`.** That is the entire lesson
here: for months this repo described a function nobody was running, and every
fork that deployed from it inherited a search that could not see its own memory.

```sql
SELECT pg_get_functiondef(
  'public.semantic_search_memories(vector,real,integer,text)'::regprocedure);
```

## The fix

Run `migrations/semantic-recall-canonical.sql`. It is transcribed from a live
deployed function rather than authored from this repo.

It does three things a naive fix would not:

1. **Converges on one function by argument type.** If your deployment predates
   this, your function takes `FLOAT` — `double precision`, not `real`. A bare
   `CREATE OR REPLACE` with the correct signature would leave the old one in
   place as a *second overload*, and PostgREST resolves `rpc/` by name — so
   recall would go from partial to completely broken. The migration drops
   superseded overloads inside the transaction.
2. **Preserves soft deletes.** Eight of the tables carry `status`; their branches
   filter `COALESCE(status,'active') = 'active'`. A version without this
   resurrects deleted memories into search results.
3. **Reads `COALESCE(content, legacy_column)`.** These tables carry both a
   modern `content` column and their original one (`description`, `detail`,
   `observation`, `what`, `reference`, `what_happened`). Reading only the legacy
   column returns NULL for everything written through the current code path.

It verifies itself before committing — one function, right signature, twelve
tables — and rolls back otherwise.

## Two traps worth knowing

**`CREATE FUNCTION` succeeding proves nothing.** plpgsql does not plan a function
body until it is invoked. A body with `ORDER BY combined_score` over a `UNION`
whose first branch does not *alias* that column will create cleanly and then
raise on every single call. The aliases in the first branch of these functions
are load-bearing; do not tidy them away. Any post-condition you write should
**invoke** the function, not count rows in `pg_proc`.

**Verify per branch, never in aggregate.** A total row count passes happily with
two working branches and ten broken ones — which is how the 2-table version
survived as long as it did. Check each type against its own denominator, and
remember that a type with zero embedded rows returning nothing is correct.

## A superseded file you may still have

`semantic-rpc-custom.sql` at the repo root is now a comments-only tombstone. It
previously contained an 8-branch `double precision` implementation and told you
to apply it manually. Do not apply an older copy of it. `custom_memories` is
included as a branch in the canonical migration.
