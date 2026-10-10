-- CogCor 2.2: durable cognitive lifecycle records.
--
-- This migration adds the database half of consolidation, retention, and
-- proactive delivery. It deliberately does not install a scheduler: CogCor is
-- the brain service, while a trusted host/daemon decides when jobs run.
--
-- SAFE TO RE-RUN. Existing memory rows are not changed or deleted.

BEGIN;

CREATE TABLE IF NOT EXISTS job_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'partial', 'failed', 'skipped')),
  trigger_source TEXT NOT NULL DEFAULT 'scheduler',
  input_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_summary TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_runs_name_started
  ON job_runs(job_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_runs_status
  ON job_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS job_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_run_id UUID NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  stage_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
  input_count INTEGER NOT NULL DEFAULT 0 CHECK (input_count >= 0),
  output_count INTEGER NOT NULL DEFAULT 0 CHECK (output_count >= 0),
  receipt JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_summary TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  UNIQUE (job_run_id, stage_name)
);
CREATE INDEX IF NOT EXISTS idx_job_stages_status
  ON job_stages(status, started_at DESC);

-- Archive Echo is a temporary review label, not an automatic resurrection.
-- References are typed because CogCor stores memories in several tables.
CREATE TABLE IF NOT EXISTS archive_echoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cue_table TEXT NOT NULL,
  cue_id UUID NOT NULL,
  archived_table TEXT NOT NULL,
  archived_id UUID NOT NULL,
  similarity NUMERIC NOT NULL CHECK (similarity >= 0 AND similarity <= 1),
  rationale TEXT,
  source_records JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(source_records) = 'array'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'rescued', 'dismissed', 'expired')),
  job_run_id UUID REFERENCES job_runs(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cue_table, cue_id, archived_table, archived_id)
);
CREATE INDEX IF NOT EXISTS idx_archive_echoes_review
  ON archive_echoes(status, expires_at, similarity DESC);

-- Consolidation may suggest; only explicit review may promote identity.
CREATE TABLE IF NOT EXISTS cognitive_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_type TEXT NOT NULL CHECK (proposal_type IN ('orphan', 'identity')),
  proposed_content TEXT NOT NULL,
  rationale TEXT,
  confidence NUMERIC NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  source_records JSONB NOT NULL CHECK (
    CASE WHEN jsonb_typeof(source_records) = 'array'
      THEN jsonb_array_length(source_records) > 0 ELSE FALSE END
  ),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  accepted_content TEXT,
  accepted_record_table TEXT,
  accepted_record_id UUID,
  job_run_id UUID REFERENCES job_runs(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cognitive_proposals_review
  ON cognitive_proposals(status, proposal_type, confidence DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS dream_lineages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lineage_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  recurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (recurrence_count > 0),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_records JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(source_records) = 'array'),
  interpretation_status TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (interpretation_status IN ('unreviewed', 'reviewed', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dream_lineages_recurrence
  ON dream_lineages(recurrence_count DESC, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS dream_lineage_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lineage_id UUID NOT NULL REFERENCES dream_lineages(id) ON DELETE CASCADE,
  reflection_id UUID REFERENCES reflections(id) ON DELETE SET NULL,
  source_records JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(source_records) = 'array'),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lineage_id, reflection_id)
);
CREATE INDEX IF NOT EXISTS idx_dream_lineage_members_observed
  ON dream_lineage_members(lineage_id, observed_at DESC);

-- Summaries preserve long-range trajectory after raw history ages out.
CREATE TABLE IF NOT EXISTS emotional_history_rollups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_kind TEXT NOT NULL CHECK (bucket_kind IN ('daily', 'weekly')),
  bucket_start DATE NOT NULL,
  bucket_end DATE NOT NULL CHECK (bucket_end >= bucket_start),
  sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_records JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(source_records) = 'array'),
  job_run_id UUID REFERENCES job_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bucket_kind, bucket_start, bucket_end)
);
CREATE INDEX IF NOT EXISTS idx_emotional_rollups_period
  ON emotional_history_rollups(bucket_kind, bucket_start DESC);

-- Durable outbox: a host claims a delivery and writes the final receipt.
CREATE TABLE IF NOT EXISTS proactive_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'delivered', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  receipt JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proactive_deliveries_claim
  ON proactive_deliveries(status, available_at, created_at);

-- Promote a reviewed identity proposal atomically. The row lock makes retries
-- safe: exactly one caller can turn a pending proposal into Essence.
CREATE OR REPLACE FUNCTION accept_identity_proposal(
  target_proposal_id UUID,
  reviewed_content TEXT,
  reviewed_essence_type TEXT DEFAULT 'trait'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  proposal cognitive_proposals%ROWTYPE;
  new_essence_id UUID;
BEGIN
  IF btrim(COALESCE(reviewed_content, '')) = '' THEN
    RAISE EXCEPTION 'reviewed_content is required';
  END IF;
  IF reviewed_essence_type NOT IN ('anchor_line', 'voice', 'dynamic', 'boundary', 'vow', 'trait') THEN
    RAISE EXCEPTION 'invalid essence type';
  END IF;

  SELECT * INTO proposal
  FROM cognitive_proposals
  WHERE id = target_proposal_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'proposal not found'; END IF;
  IF proposal.proposal_type <> 'identity' THEN RAISE EXCEPTION 'proposal is not identity'; END IF;
  IF proposal.status <> 'pending' THEN RAISE EXCEPTION 'proposal is already %', proposal.status; END IF;

  INSERT INTO essence (content, essence_type, context, priority, pinned, source, created_at, updated_at)
  VALUES (
    btrim(reviewed_content),
    reviewed_essence_type,
    jsonb_build_object('proposal_id', proposal.id, 'source_records', proposal.source_records)::text,
    5, FALSE, 'consolidation_review', NOW(), NOW()
  )
  RETURNING id INTO new_essence_id;

  UPDATE cognitive_proposals SET
    status = 'accepted',
    accepted_content = btrim(reviewed_content),
    accepted_record_table = 'essence',
    accepted_record_id = new_essence_id,
    resolved_at = NOW()
  WHERE id = target_proposal_id;

  RETURN new_essence_id;
END;
$$;

REVOKE ALL ON FUNCTION accept_identity_proposal(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION accept_identity_proposal(UUID, TEXT, TEXT) TO service_role;

ALTER TABLE job_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_echoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cognitive_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE dream_lineages ENABLE ROW LEVEL SECURITY;
ALTER TABLE dream_lineage_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE emotional_history_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE proactive_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON job_runs;
DROP POLICY IF EXISTS "Service role full access" ON job_stages;
DROP POLICY IF EXISTS "Service role full access" ON archive_echoes;
DROP POLICY IF EXISTS "Service role full access" ON cognitive_proposals;
DROP POLICY IF EXISTS "Service role full access" ON dream_lineages;
DROP POLICY IF EXISTS "Service role full access" ON dream_lineage_members;
DROP POLICY IF EXISTS "Service role full access" ON emotional_history_rollups;
DROP POLICY IF EXISTS "Service role full access" ON proactive_deliveries;

CREATE POLICY "Service role full access" ON job_runs FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON job_stages FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON archive_echoes FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON cognitive_proposals FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON dream_lineages FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON dream_lineage_members FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON emotional_history_rollups FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON proactive_deliveries FOR ALL TO service_role USING (true) WITH CHECK (true);

-- RLS is not a substitute for grants. Keep public client roles outside the
-- brain even on projects whose default privileges were never hardened.
REVOKE ALL ON job_runs, job_stages, archive_echoes, cognitive_proposals,
  dream_lineages, dream_lineage_members, emotional_history_rollups,
  proactive_deliveries FROM anon, authenticated;

COMMIT;
