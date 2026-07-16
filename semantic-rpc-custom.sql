-- Manual Supabase RPC patch: the public repo has one built-in table branch,
-- so custom drawers add exactly one UNION ALL branch.

DROP FUNCTION IF EXISTS semantic_search_memories(vector, double precision, integer, text);

CREATE FUNCTION semantic_search_memories(
  query_embedding vector(384),
  match_threshold FLOAT DEFAULT 0.5,
  match_count INT DEFAULT 10,
  memory_type_filter TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  memory_type TEXT,
  salience INTEGER,
  emotional_tag TEXT,
  similarity FLOAT,
  outcome_score REAL,
  drawer_name TEXT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT ranked.id, ranked.content, ranked.memory_type, ranked.salience,
         ranked.emotional_tag, ranked.similarity, ranked.outcome_score,
         ranked.drawer_name
  FROM (
    SELECT
      m.id, m.content, m.memory_type, m.salience, m.emotional_tag,
      1 - (m.embedding <=> query_embedding) AS similarity,
      m.outcome_score, NULL::TEXT AS drawer_name
    FROM core_memories m
    WHERE m.embedding IS NOT NULL
      AND 1 - (m.embedding <=> query_embedding) > match_threshold
      AND (memory_type_filter IS NULL OR m.memory_type = memory_type_filter)

    UNION ALL

    SELECT
      m.id, m.content, m.memory_type, m.salience, m.emotional_tag,
      1 - (m.embedding <=> query_embedding) AS similarity,
      m.outcome_score, m.drawer_name
    FROM custom_memories m
    WHERE m.embedding IS NOT NULL
      AND 1 - (m.embedding <=> query_embedding) > match_threshold
      AND (memory_type_filter IS NULL OR memory_type_filter = 'custom' OR m.drawer_name = memory_type_filter)
  ) ranked
  ORDER BY
    ranked.similarity * 0.6 +
    COALESCE(ranked.outcome_score, 0) * 0.1 +
    (ranked.salience::float / 10) * 0.3
  DESC
  LIMIT match_count;
END;
$$;
