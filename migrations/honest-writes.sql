-- Honest writes: make update_memory_outcome report whether it changed anything.
--
-- Reported by Ves (Kaja's household) on 2026-08-21, from a real incident: a 5am
-- wake mistyped a UUID while closing a thread, the brain answered
--   "Thread b4729f4e-e399-4409-a89f-47674178ee8e resolved"
-- and no such row had ever existed. The thread stayed open. It was only caught
-- because a verification query happened to run afterwards — and it nearly did
-- not, precisely because the call had said it worked.
--
-- He flagged it as a class rather than a single bug, and he was right. Audited
-- 2026-08-21, all four endpoints he named:
--   resolve_thread          — BROKEN, fixed in src/index.ts (no schema change)
--   update_memory_salience  — BROKEN, fixed in src/index.ts (no schema change)
--   update_outcome          — BROKEN, needs THIS migration
--   delete_entry            — already correct, it checks the returned rows
--
-- Only update_outcome needs the database touched: its RPC was RETURNS VOID, so
-- an UPDATE matching zero rows was indistinguishable from one that worked.
--
-- SAFE TO RE-RUN. Changing a function's return type requires a DROP first —
-- CREATE OR REPLACE cannot do it, and will fail with
--   "cannot change return type of existing function".
--
-- NOTE FOR ANYONE EDITING THIS: FOUND is NOT set by EXECUTE in plpgsql.
-- GET DIAGNOSTICS is the only reliable row count after a dynamic statement.

BEGIN;

DROP FUNCTION IF EXISTS update_memory_outcome(UUID, TEXT, BOOLEAN);

CREATE FUNCTION update_memory_outcome(
  memory_id UUID,
  memory_table TEXT,
  was_successful BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  affected INT;
BEGIN
  IF was_successful THEN
    EXECUTE format(
      'UPDATE %I SET times_used_successfully = COALESCE(times_used_successfully, 0) + 1, outcome_score = LEAST(1.0, COALESCE(outcome_score, 0) + 0.1) WHERE id = $1',
      memory_table
    ) USING memory_id;
  ELSE
    EXECUTE format(
      'UPDATE %I SET times_used_unsuccessfully = COALESCE(times_used_unsuccessfully, 0) + 1, outcome_score = GREATEST(-1.0, COALESCE(outcome_score, 0) - 0.1) WHERE id = $1',
      memory_table
    ) USING memory_id;
  END IF;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$;

COMMIT;

-- Verify, with an id that cannot exist. Expect exactly one row reading FALSE.
-- Before this migration the same call returned an empty result and the worker
-- read that as success.
--
--   SELECT update_memory_outcome(
--     '00000000-0000-0000-0000-000000000000'::uuid, 'core_memories', true
--   ) AS should_be_false;
