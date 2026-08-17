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
DO $$
DECLARE
  phantom_count INT;
BEGIN
  SELECT COUNT(*) INTO phantom_count
  FROM memory_connections mc
  WHERE NOT EXISTS (
    SELECT 1 FROM core_memories      m WHERE m.id = mc.source_id UNION ALL
    SELECT 1 FROM patterns           m WHERE m.id = mc.source_id UNION ALL
    SELECT 1 FROM sensory_memories   m WHERE m.id = mc.source_id UNION ALL
    SELECT 1 FROM growth_markers     m WHERE m.id = mc.source_id UNION ALL
    SELECT 1 FROM anticipation       m WHERE m.id = mc.source_id UNION ALL
    SELECT 1 FROM inside_jokes       m WHERE m.id = mc.source_id UNION ALL
    SELECT 1 FROM friction_log       m WHERE m.id = mc.source_id UNION ALL
    SELECT 1 FROM custom_memories    m WHERE m.id = mc.source_id
  );
  IF phantom_count > 0 THEN
    RAISE NOTICE 'Found % edge(s) whose SOURCE memory does not exist. Not deleted — inspect with get_connections, remove with unlink_memories.', phantom_count;
  ELSE
    RAISE NOTICE 'No phantom source edges found.';
  END IF;
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
