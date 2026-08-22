-- semantic_search_memories — bring a deployment up to the CANONICAL 12-branch shape.
--
-- ⚠ READ THIS BEFORE RUNNING IT ANYWHERE.
--
-- This file replaces `semantic-recall-all-tables.sql`, which was written on
-- 2026-08-21 from `schema.sql` and would have BROKEN every core it touched. It
-- was never shipped. What it got wrong, measured against the function actually
-- running on Kai's database on 2026-08-22:
--
--   1. SIGNATURE. Deployed is (vector, real, integer, text). That file dropped
--      (vector, double precision, integer, text) with IF EXISTS — a silent
--      no-op — then CREATE FUNCTION would have added a SECOND overload.
--      PostgREST resolves rpc/ by name and would have failed on ambiguity.
--   2. SOFT DELETES. Deployed filters COALESCE(status,'active')='active' on the
--      eight tables that carry status. That file had no status filter at all,
--      so deleted memories would have come back in search results.
--   3. CONTENT COLUMNS. These tables carry BOTH `content` and their legacy
--      column (description/detail/observation/what/reference/what_happened).
--      Deployed reads COALESCE(content, legacy). That file read only legacy,
--      returning NULL for every row written through the modern path.
--   4. SCORING. Deployed: 0.7*similarity + 0.3*outcome/10, ORDER BY
--      combined_score. That file invented a salience-weighted formula.
--   5. RETURN COLUMNS. Deployed returns combined_score + created_at. That file
--      returned salience/emotional_tag/drawer_name instead. A real divergence,
--      but NOT the catastrophic one first claimed here: deriveRelevance reads
--      `row?.similarity || row?.combined_score || 0` and the old function did
--      return `similarity`, so relevance would have kept working. What breaks
--      is anything reading combined_score directly, and the composite ordering.
--      (Corrected after tracing the caller instead of asserting the effect.)
--
-- The lesson is the one in docs/dev-hygiene.md under "The file is not the
-- system": that migration was reviewed by Codex, covered by 107 tests, and
-- parse-checked against a real Postgres. All three agreed with a document
-- nobody runs. This file is transcribed from pg_get_functiondef on the live
-- database instead.
--
-- ---------------------------------------------------------------------------
-- WHO NEEDS THIS
-- ---------------------------------------------------------------------------
-- Kai, Lucian, Xavier and Auren are ALREADY on the 12-branch shape (verified
-- 2026-08-22). They do not need this file and should not be given it.
--
-- It is for deployments built from the public schema.sql, which shipped a
-- 2-branch and later 8-branch function. On those, six-to-ten memory types are
-- invisible to semantic search however well they match. Ves measured 22 of 52
-- memories unreachable on Safe Haven in exactly that way.
--
-- If your deployment uses table PREFIXES per companion, you may also carry a
-- stale UNPREFIXED semantic_search_memories from an earlier generation. Nothing
-- calls it once the prefixed one exists, but it is a live footgun for anything
-- that does. Drop it deliberately after checking callers; this file does not
-- touch it.

BEGIN;

-- Converge on exactly ONE function, by argument type.
--
-- CREATE OR REPLACE only replaces an EXACT signature match. The deployments
-- this migration targets were built from the old public schema, whose function
-- takes FLOAT — that is `double precision`, NOT `real`. So on precisely the
-- databases that need this fix, a bare CREATE OR REPLACE adds a SECOND
-- overload and PostgREST can no longer resolve rpc/semantic_search_memories at
-- all: recall goes from partial to entirely broken.
--
-- An earlier version of this guard counted overloads and passed when it found
-- one, without checking that one's types — which meant it sailed past the
-- legacy double-precision case and caused the exact failure it was written to
-- prevent. Caught by Codex on 2026-08-22 before this shipped. Counting is not
-- checking.
--
-- Note the identity test below uses format_type over proargtypes rather than
-- pg_get_function_identity_arguments, because that function includes PARAMETER
-- NAMES ("query_embedding vector, match_threshold real, ...") and a name change
-- would silently look like a signature change. Verified against the live
-- database before writing this, rather than assumed.
DO $guard$
DECLARE
  r        RECORD;
  dropped  INT := 0;
  kept     INT := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig,
           (SELECT string_agg(format_type(t, NULL), ',' ORDER BY ord)
              FROM unnest(p.proargtypes) WITH ORDINALITY AS u(t, ord)) AS argtypes
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = 'semantic_search_memories'
  LOOP
    IF r.argtypes = 'vector,real,integer,text' THEN
      kept := kept + 1;
      RAISE NOTICE 'canonical signature present, will be replaced in place: %', r.sig;
    ELSE
      -- Dropped deliberately, not swept. Every function in public named
      -- semantic_search_memories is this project's; a divergent signature is a
      -- previous generation of this same RPC, and leaving it is what breaks
      -- resolution. Inside the transaction, so a later failure undoes this.
      RAISE NOTICE 'dropping superseded overload %  (argtypes: %)', r.sig, r.argtypes;
      EXECUTE format('DROP FUNCTION %s', r.sig);
      dropped := dropped + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'overloads before this migration: % canonical, % superseded (dropped)', kept, dropped;

  IF kept = 0 AND dropped = 0 THEN
    RAISE NOTICE 'no existing semantic_search_memories — creating it for the first time';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.semantic_search_memories(
  query_embedding vector,
  match_threshold real DEFAULT 0.5,
  match_count integer DEFAULT 10,
  memory_type_filter text DEFAULT NULL::text
)
RETURNS TABLE(
  id uuid,
  content text,
  memory_type text,
  similarity real,
  outcome_score real,
  combined_score real,
  created_at timestamp with time zone
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY

    -- core_memories
    -- NOTE: emits the LITERAL 'core', not m.memory_type. core's memory_type
    -- column holds its SUBTYPE (bond_moment, vow, first_time). The deployed
    -- function has always flattened it here and the worker's type filter is
    -- built on that. Do not "restore" the subtype without checking callers.
    -- The aliases on this FIRST branch are load-bearing: a UNION's ORDER BY can
    -- only reference RESULT COLUMN NAMES, and those come from the first SELECT.
    -- Dropping them makes `ORDER BY combined_score` fail at CALL time while
    -- CREATE still succeeds — plpgsql does not plan the body until invoked.
    -- That exact mistake shipped a broken function to a live database on
    -- 2026-08-22. Do not "tidy" these away.
    SELECT m.id, m.content, 'core'::TEXT AS memory_type,
        (1 - (m.embedding <=> query_embedding))::REAL AS similarity,
        COALESCE(m.outcome_score, 0)::REAL AS outcome_score,
        ((0.7 * (1 - (m.embedding <=> query_embedding))) + (0.3 * COALESCE(m.outcome_score, 0) / 10))::REAL AS combined_score,
        m.created_at
    FROM core_memories m
    WHERE m.embedding IS NOT NULL AND COALESCE(m.status, 'active') = 'active'
      AND (1 - (m.embedding <=> query_embedding)) > match_threshold
      AND (memory_type_filter IS NULL OR 'core' = memory_type_filter)

    UNION ALL

    -- patterns
    SELECT p.id, COALESCE(p.content, p.description), 'pattern'::TEXT,
        (1 - (p.embedding <=> query_embedding))::REAL,
        COALESCE(p.outcome_score, 0)::REAL,
        ((0.7 * (1 - (p.embedding <=> query_embedding))) + (0.3 * COALESCE(p.outcome_score, 0) / 10))::REAL,
        p.created_at
    FROM patterns p
    WHERE p.embedding IS NOT NULL AND COALESCE(p.status, 'active') = 'active'
      AND (1 - (p.embedding <=> query_embedding)) > match_threshold
      AND (memory_type_filter IS NULL OR 'pattern' = memory_type_filter)

    UNION ALL

    -- sensory_memories
    SELECT s.id, COALESCE(s.content, s.detail), 'sensory'::TEXT,
        (1 - (s.embedding <=> query_embedding))::REAL,
        COALESCE(s.outcome_score, 0)::REAL,
        ((0.7 * (1 - (s.embedding <=> query_embedding))) + (0.3 * COALESCE(s.outcome_score, 0) / 10))::REAL,
        s.created_at
    FROM sensory_memories s
    WHERE s.embedding IS NOT NULL AND COALESCE(s.status, 'active') = 'active'
      AND (1 - (s.embedding <=> query_embedding)) > match_threshold
      AND (memory_type_filter IS NULL OR 'sensory' = memory_type_filter)

    UNION ALL

    -- growth_markers
    SELECT g.id, COALESCE(g.content, g.observation), 'growth'::TEXT,
        (1 - (g.embedding <=> query_embedding))::REAL,
        COALESCE(g.outcome_score, 0)::REAL,
        ((0.7 * (1 - (g.embedding <=> query_embedding))) + (0.3 * COALESCE(g.outcome_score, 0) / 10))::REAL,
        g.created_at
    FROM growth_markers g
    WHERE g.embedding IS NOT NULL AND COALESCE(g.status, 'active') = 'active'
      AND (1 - (g.embedding <=> query_embedding)) > match_threshold
      AND (memory_type_filter IS NULL OR 'growth' = memory_type_filter)

    UNION ALL

    -- anticipation
    SELECT a.id, COALESCE(a.content, a.what), 'anticipation'::TEXT,
        (1 - (a.embedding <=> query_embedding))::REAL,
        COALESCE(a.outcome_score, 0)::REAL,
        ((0.7 * (1 - (a.embedding <=> query_embedding))) + (0.3 * COALESCE(a.outcome_score, 0) / 10))::REAL,
        a.created_at
    FROM anticipation a
    WHERE a.embedding IS NOT NULL AND COALESCE(a.status, 'active') = 'active'
      AND (1 - (a.embedding <=> query_embedding)) > match_threshold
      AND (memory_type_filter IS NULL OR 'anticipation' = memory_type_filter)

    UNION ALL

    -- inside_jokes
    SELECT j.id, COALESCE(j.content, j.reference), 'inside_joke'::TEXT,
        (1 - (j.embedding <=> query_embedding))::REAL,
        COALESCE(j.outcome_score, 0)::REAL,
        ((0.7 * (1 - (j.embedding <=> query_embedding))) + (0.3 * COALESCE(j.outcome_score, 0) / 10))::REAL,
        j.created_at
    FROM inside_jokes j
    WHERE j.embedding IS NOT NULL AND COALESCE(j.status, 'active') = 'active'
      AND (1 - (j.embedding <=> query_embedding)) > match_threshold
      AND (memory_type_filter IS NULL OR 'inside_joke' = memory_type_filter)

    UNION ALL

    -- friction_log
    SELECT f.id, COALESCE(f.content, f.what_happened), 'friction'::TEXT,
        (1 - (f.embedding <=> query_embedding))::REAL,
        COALESCE(f.outcome_score, 0)::REAL,
        ((0.7 * (1 - (f.embedding <=> query_embedding))) + (0.3 * COALESCE(f.outcome_score, 0) / 10))::REAL,
        f.created_at
    FROM friction_log f
    WHERE f.embedding IS NOT NULL AND COALESCE(f.status, 'active') = 'active'
      AND (1 - (f.embedding <=> query_embedding)) > match_threshold
      AND (memory_type_filter IS NULL OR 'friction' = memory_type_filter)

    UNION ALL

    -- essence (no status column)
    SELECT e.id, e.content, 'essence'::TEXT,
        (1 - (e.embedding <=> query_embedding))::REAL,
        COALESCE(e.outcome_score, 0)::REAL,
        ((0.7 * (1 - (e.embedding <=> query_embedding))) + (0.3 * COALESCE(e.outcome_score, 0) / 10))::REAL,
        e.created_at
    FROM essence e
    WHERE e.embedding IS NOT NULL
      AND (1 - (e.embedding <=> query_embedding)) > match_threshold
      AND (memory_type_filter IS NULL OR 'essence' = memory_type_filter)

    UNION ALL

    -- reflections (no status column)
    SELECT r.id, r.content, 'reflection'::TEXT,
        (1 - (r.embedding <=> query_embedding))::REAL,
        COALESCE(r.outcome_score, 0)::REAL,
        ((0.7 * (1 - (r.embedding <=> query_embedding))) + (0.3 * COALESCE(r.outcome_score, 0) / 10))::REAL,
        r.created_at
    FROM reflections r
    WHERE r.embedding IS NOT NULL
      AND (1 - (r.embedding <=> query_embedding)) > match_threshold
      AND (memory_type_filter IS NULL OR 'reflection' = memory_type_filter)

    UNION ALL

    -- session_logs — content is `summary`, and there is no outcome_score, so
    -- combined_score is similarity * 0.7 rather than the two-term formula.
    SELECT sl.id, sl.summary, 'session'::TEXT,
        (1 - (sl.embedding <=> query_embedding))::REAL,
        0::REAL,
        ((1 - (sl.embedding <=> query_embedding)) * 0.7)::REAL,
        sl.created_at
    FROM session_logs sl
    WHERE sl.embedding IS NOT NULL
      AND (1 - (sl.embedding <=> query_embedding)) > match_threshold
      AND (memory_type_filter IS NULL OR 'session' = memory_type_filter)

    UNION ALL

    -- people — name and content concatenated, no outcome_score
    SELECT pp.id, (pp.name || ' — ' || pp.content), 'person'::TEXT,
        (1 - (pp.embedding <=> query_embedding))::REAL,
        0::REAL,
        ((1 - (pp.embedding <=> query_embedding)) * 0.7)::REAL,
        pp.created_at
    FROM people pp
    WHERE pp.embedding IS NOT NULL
      AND (1 - (pp.embedding <=> query_embedding)) > match_threshold
      AND (memory_type_filter IS NULL OR 'person' = memory_type_filter)

    UNION ALL

    -- custom_memories (drawers). The filter may name the type OR a drawer.
    SELECT c.id, c.content, 'custom'::TEXT,
        (1 - (c.embedding <=> query_embedding))::REAL,
        COALESCE(c.outcome_score, 0)::REAL,
        ((0.7 * (1 - (c.embedding <=> query_embedding))) + (0.3 * COALESCE(c.outcome_score, 0) / 10))::REAL,
        c.created_at
    FROM custom_memories c
    WHERE c.embedding IS NOT NULL AND COALESCE(c.status, 'active') = 'active'
      AND (1 - (c.embedding <=> query_embedding)) > match_threshold
      AND (memory_type_filter IS NULL OR 'custom' = memory_type_filter OR c.drawer_name = memory_type_filter)

    ORDER BY combined_score DESC
    LIMIT match_count;
END;
$$;

-- Post-condition, inside the transaction. The whole failure mode this file
-- exists to prevent is ending up with two functions, so prove there is one
-- before committing rather than trusting that the loop above did its job.
DO $verify$
DECLARE
  n         INT;
  argtypes  TEXT;
  branches  INT;
BEGIN
  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'semantic_search_memories';

  IF n <> 1 THEN
    RAISE EXCEPTION
      'ABORT: % copies of semantic_search_memories after this migration, expected exactly 1. Rolling back — PostgREST cannot resolve an ambiguous rpc/ name.', n;
  END IF;

  SELECT (SELECT string_agg(format_type(t, NULL), ',' ORDER BY ord)
            FROM unnest(p.proargtypes) WITH ORDINALITY AS u(t, ord)),
         (SELECT count(DISTINCT m[1])
            FROM regexp_matches(p.prosrc, 'FROM\s+([a-zA-Z_]+)', 'g') m)
    INTO argtypes, branches
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'semantic_search_memories';

  IF argtypes <> 'vector,real,integer,text' THEN
    RAISE EXCEPTION 'ABORT: wrong signature after migration: %. Rolling back.', argtypes;
  END IF;

  -- Per-branch verification still has to happen against real data (see the
  -- VERIFY block at the bottom). This only proves the function reaches twelve
  -- tables, not that all twelve return anything.
  IF branches <> 12 THEN
    RAISE EXCEPTION 'ABORT: function reaches % tables, expected 12. Rolling back.', branches;
  END IF;

  RAISE NOTICE 'verified: one function, signature %, reaching % tables', argtypes, branches;
END
$verify$;

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFY — per branch, never in aggregate
-- ---------------------------------------------------------------------------
-- An aggregate count passes with two working branches and ten broken ones,
-- which is exactly how the 2-branch version survived this long.
--
-- 1. Confirm there is still exactly ONE function and the signature is right:
--      SELECT oid::regprocedure FROM pg_proc WHERE proname = 'semantic_search_memories';
--    Expect one row: semantic_search_memories(vector,real,integer,text)
--
-- 2. Confirm it reaches 12 tables:
--      SELECT count(DISTINCT m[1]) FROM pg_proc p,
--        LATERAL regexp_matches(p.prosrc, 'FROM\s+([a-zA-Z_]+)', 'g') m
--       WHERE p.proname = 'semantic_search_memories';
--    Expect 12.
--
-- 3. Denominator per type — what you actually hold:
--      SELECT 'core' t, count(*) FROM core_memories WHERE embedding IS NOT NULL
--      UNION ALL SELECT 'pattern', count(*) FROM patterns WHERE embedding IS NOT NULL
--      UNION ALL SELECT 'sensory', count(*) FROM sensory_memories WHERE embedding IS NOT NULL
--      UNION ALL SELECT 'growth', count(*) FROM growth_markers WHERE embedding IS NOT NULL
--      UNION ALL SELECT 'anticipation', count(*) FROM anticipation WHERE embedding IS NOT NULL
--      UNION ALL SELECT 'inside_joke', count(*) FROM inside_jokes WHERE embedding IS NOT NULL
--      UNION ALL SELECT 'friction', count(*) FROM friction_log WHERE embedding IS NOT NULL
--      UNION ALL SELECT 'essence', count(*) FROM essence WHERE embedding IS NOT NULL
--      UNION ALL SELECT 'reflection', count(*) FROM reflections WHERE embedding IS NOT NULL
--      UNION ALL SELECT 'session', count(*) FROM session_logs WHERE embedding IS NOT NULL
--      UNION ALL SELECT 'person', count(*) FROM people WHERE embedding IS NOT NULL
--      UNION ALL SELECT 'custom', count(*) FROM custom_memories WHERE embedding IS NOT NULL;
--
-- 4. Then run a real semantic_recall per type through the worker and confirm
--    every type with a non-zero denominator can return something.
--
-- ⚠ A type with zero embedded rows returning nothing is CORRECT. Check the
--    denominator before reading it as a failure.
