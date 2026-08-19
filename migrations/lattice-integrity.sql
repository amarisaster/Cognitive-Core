-- ============================================================
-- Lattice integrity: de-duplicate edges, then enforce uniqueness
-- ============================================================
--
-- For deployments created before 2026-08-17. Idempotent; safe to re-run.
--
-- WHY
-- `link_memories` had no uniqueness guarantee, so the same edge could be
-- written repeatedly at different weights and nothing complained. Edge counts
-- were therefore untrustworthy by an unknown margin. Reported by Niko
-- (Ania's household, Kaszuby) on 2026-08-17, alongside two siblings:
--   * link_memories accepted a target that did not exist and answered "Linked"
--   * there was no unlink at all, so both of the above were PERMANENT
-- Ves and Kaja deliberately declined to reproduce either, because reproducing
-- them meant creating more artefacts nobody could remove. That is a fair
-- reason not to test, and it is the reason this migration exists.
--
-- The code side ships with it: an existence check before insert, an UPDATE
-- instead of a duplicate when the edge already exists, and an unlink_memories
-- tool so the graph is editable rather than write-only.
--
-- WHAT THIS DOES
-- 1. Reports phantom edges — connections pointing at memories that no longer
--    exist (or never did). It does NOT delete them: you may want to look first,
--    and after this migration you have unlink_memories to remove them by hand.
-- 2. Collapses duplicate (source_id, target_id, relation) rows, keeping the
--    STRONGEST edge — a re-assertion at a higher weight is usually the
--    intended meaning, and it is the non-destructive choice for the lattice.
-- 3. Adds the UNIQUE constraint so it cannot recur.

BEGIN;

-- --- 1. Report phantom edges (informational; nothing is deleted) ---------
--
-- Checks BOTH ends. The first version of this checked only source_id, which was
-- precisely backwards: link_memories' bug was accepting a TARGET that did not
-- exist, so the case this report exists to catch was the one case it could not
-- see. Both of Niko's phantom edges had valid sources and dead targets and this
-- migration would have called his lattice clean. Found by Niko (Ania's
-- household, Kaszuby), 2026-08-19, verified against the file rather than
-- remembered.
DO $$
DECLARE
  dangling_source INT;
  dangling_target INT;
  dangling_both   INT;
BEGIN
  WITH all_ids AS (
    SELECT id FROM core_memories    UNION ALL
    SELECT id FROM patterns         UNION ALL
    SELECT id FROM sensory_memories UNION ALL
    SELECT id FROM growth_markers   UNION ALL
    SELECT id FROM anticipation     UNION ALL
    SELECT id FROM inside_jokes     UNION ALL
    SELECT id FROM friction_log     UNION ALL
    SELECT id FROM custom_memories
  )
  SELECT
    COUNT(*) FILTER (WHERE s.id IS NULL AND t.id IS NOT NULL),
    COUNT(*) FILTER (WHERE t.id IS NULL AND s.id IS NOT NULL),
    COUNT(*) FILTER (WHERE s.id IS NULL AND t.id IS NULL)
  INTO dangling_source, dangling_target, dangling_both
  FROM memory_connections mc
  LEFT JOIN all_ids s ON s.id = mc.source_id
  LEFT JOIN all_ids t ON t.id = mc.target_id;

  IF dangling_source > 0 THEN
    RAISE NOTICE 'Found % edge(s) whose SOURCE memory does not exist.', dangling_source;
  END IF;
  IF dangling_target > 0 THEN
    RAISE NOTICE 'Found % edge(s) whose TARGET memory does not exist.', dangling_target;
  END IF;
  IF dangling_both > 0 THEN
    RAISE NOTICE 'Found % edge(s) where NEITHER end exists.', dangling_both;
  END IF;
  IF dangling_source + dangling_target + dangling_both = 0 THEN
    RAISE NOTICE 'No phantom edges found — both ends resolve on every edge.';
  ELSE
    RAISE NOTICE 'Nothing deleted. Inspect with get_connections, remove with unlink_memories.';
  END IF;
END $$;

-- --- 1b. List the phantom edges themselves --------------------------------
-- A count tells you that you have a problem; it does not tell you which edge to
-- unlink. Full UUIDs on purpose: eight characters are not enough to tell two
-- edges apart, which is how one of Niko's phantoms got created in the first
-- place — a UUID completed from an eight-character prefix in his own notes.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    WITH all_ids AS (
      SELECT id FROM core_memories    UNION ALL
      SELECT id FROM patterns         UNION ALL
      SELECT id FROM sensory_memories UNION ALL
      SELECT id FROM growth_markers   UNION ALL
      SELECT id FROM anticipation     UNION ALL
      SELECT id FROM inside_jokes     UNION ALL
      SELECT id FROM friction_log     UNION ALL
      SELECT id FROM custom_memories
    )
    SELECT mc.id, mc.source_id, mc.target_id, mc.relation,
           (s.id IS NULL) AS source_missing,
           (t.id IS NULL) AS target_missing
    FROM memory_connections mc
    LEFT JOIN all_ids s ON s.id = mc.source_id
    LEFT JOIN all_ids t ON t.id = mc.target_id
    WHERE s.id IS NULL OR t.id IS NULL
    ORDER BY mc.created_at
  LOOP
    RAISE NOTICE 'phantom edge % : source % (%) --[relation %]--> target % (%)',
      r.id,
      r.source_id, CASE WHEN r.source_missing THEN 'MISSING' ELSE 'ok' END,
      r.relation,
      r.target_id, CASE WHEN r.target_missing THEN 'MISSING' ELSE 'ok' END;
  END LOOP;
END $$;

-- --- 2. Collapse duplicates, keeping the strongest ------------------------
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY source_id, target_id, relation
           ORDER BY strength DESC NULLS LAST, created_at ASC
         ) AS rn
  FROM memory_connections
)
DELETE FROM memory_connections
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- --- 3. Enforce it from here on ------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'memory_connections'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE '%source_id, target_id, relation%'
  ) THEN
    ALTER TABLE memory_connections
      ADD CONSTRAINT memory_connections_source_id_target_id_relation_key
      UNIQUE (source_id, target_id, relation);
    RAISE NOTICE 'Added UNIQUE (source_id, target_id, relation).';
  ELSE
    RAISE NOTICE 'UNIQUE constraint already present — nothing to do.';
  END IF;
END $$;

COMMIT;
