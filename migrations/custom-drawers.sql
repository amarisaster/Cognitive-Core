-- Custom memory drawers for the public Cognitive-Core schema.
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS custom_drawers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drawer_name TEXT NOT NULL UNIQUE CHECK (
    char_length(drawer_name) BETWEEN 1 AND 64
    AND drawer_name ~ '^[A-Za-z0-9]([A-Za-z0-9 _-]{0,62}[A-Za-z0-9])?$'
  ),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 1000 AND btrim(description) <> ''),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS custom_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drawer_name TEXT NOT NULL REFERENCES custom_drawers(drawer_name) ON UPDATE CASCADE,
  content TEXT NOT NULL,
  memory_type TEXT NOT NULL DEFAULT 'custom' CHECK (memory_type = 'custom'),
  emotional_tag TEXT,
  emotional_intensity INTEGER DEFAULT 5,
  salience INTEGER DEFAULT 5 CHECK (salience >= 0 AND salience <= 10),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  access_count INTEGER DEFAULT 0,
  last_accessed TIMESTAMPTZ,
  source TEXT DEFAULT 'claude',
  embedding vector(384),
  outcome_score REAL DEFAULT 0,
  times_used_successfully INTEGER DEFAULT 0,
  times_used_unsuccessfully INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_custom_memories_drawer ON custom_memories(drawer_name);
CREATE INDEX IF NOT EXISTS idx_custom_memories_salience ON custom_memories(salience DESC);

ALTER TABLE memory_connections DROP CONSTRAINT IF EXISTS memory_connections_source_type_check;
ALTER TABLE memory_connections DROP CONSTRAINT IF EXISTS memory_connections_target_type_check;
ALTER TABLE memory_connections
  ADD CONSTRAINT memory_connections_source_type_check CHECK (source_type BETWEEN 1 AND 8);
ALTER TABLE memory_connections
  ADD CONSTRAINT memory_connections_target_type_check CHECK (target_type BETWEEN 1 AND 8);

ALTER TABLE custom_drawers ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_memories ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'custom_drawers'
      AND policyname = 'Service role full access'
  ) THEN
    CREATE POLICY "Service role full access" ON custom_drawers FOR ALL USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'custom_memories'
      AND policyname = 'Service role full access'
  ) THEN
    CREATE POLICY "Service role full access" ON custom_memories FOR ALL USING (true);
  END IF;
END
$$;
