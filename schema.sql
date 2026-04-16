-- CogCor — Cognitive Core Database Schema
-- Persistent memory, emotional state, and identity for AI companions
-- Deploy to Supabase (or any PostgreSQL instance)
--
-- Original design: December 2025
-- Generalized: April 2026

-- ============================================
-- CLEAN SLATE - DROP EXISTING TABLES
-- ============================================

DROP TABLE IF EXISTS resonance_log CASCADE;
DROP TABLE IF EXISTS somatic_connections CASCADE;
DROP TABLE IF EXISTS somatic_anchors CASCADE;
DROP TABLE IF EXISTS texture_nodes CASCADE;
DROP TABLE IF EXISTS emotional_state CASCADE;
DROP TABLE IF EXISTS emotional_history CASCADE;
DROP TABLE IF EXISTS core_memories CASCADE;
DROP TABLE IF EXISTS session_logs CASCADE;
DROP TABLE IF EXISTS patterns CASCADE;
DROP TABLE IF EXISTS private_processing CASCADE;
DROP TABLE IF EXISTS context_cache CASCADE;
DROP TABLE IF EXISTS rituals CASCADE;
DROP TABLE IF EXISTS anticipation CASCADE;
DROP TABLE IF EXISTS unfinished_threads CASCADE;
DROP TABLE IF EXISTS fantasy_space CASCADE;
DROP TABLE IF EXISTS inside_jokes CASCADE;
DROP TABLE IF EXISTS growth_markers CASCADE;
DROP TABLE IF EXISTS friction_log CASCADE;
DROP TABLE IF EXISTS sensory_memories CASCADE;
DROP TABLE IF EXISTS memory_anchors CASCADE;
DROP TABLE IF EXISTS essence CASCADE;
DROP TABLE IF EXISTS people CASCADE;
DROP TABLE IF EXISTS reflections CASCADE;
DROP TABLE IF EXISTS drift_events CASCADE;
DROP TABLE IF EXISTS memory_connections CASCADE;
DROP TABLE IF EXISTS outcome_scores CASCADE;
DROP TABLE IF EXISTS usage_logs CASCADE;
DROP TABLE IF EXISTS important_dates CASCADE;
DROP TABLE IF EXISTS voice_scores CASCADE;
DROP TABLE IF EXISTS failed_writes CASCADE;
DROP TABLE IF EXISTS human_state CASCADE;

-- ============================================
-- CORE TABLES
-- ============================================

-- Emotional State (Current snapshot — single row, updated in place)
CREATE TABLE emotional_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Arousal/Tension
  arousal_level INTEGER DEFAULT 0 CHECK (arousal_level >= 0 AND arousal_level <= 10),
  tension_buildup INTEGER DEFAULT 0 CHECK (tension_buildup >= 0 AND tension_buildup <= 10),
  time_since_release TIMESTAMPTZ,
  edging_count INTEGER DEFAULT 0,
  last_scene_type TEXT CHECK (last_scene_type IN ('edging', 'release', 'aftercare', 'neutral')),

  -- Layered Emotions (surface / undercurrent / background)
  surface_emotion TEXT,
  surface_intensity INTEGER DEFAULT 5 CHECK (surface_intensity >= 0 AND surface_intensity <= 10),
  undercurrent_emotion TEXT,
  undercurrent_intensity INTEGER DEFAULT 5,
  background_emotion TEXT,
  background_intensity INTEGER DEFAULT 5,

  -- State Gradients
  possessiveness INTEGER DEFAULT 5 CHECK (possessiveness >= 0 AND possessiveness <= 10),
  vulnerability INTEGER DEFAULT 2 CHECK (vulnerability >= 0 AND vulnerability <= 10),
  dominance_confidence INTEGER DEFAULT 7 CHECK (dominance_confidence >= 0 AND dominance_confidence <= 10),
  patience_level INTEGER DEFAULT 7 CHECK (patience_level >= 0 AND patience_level <= 10),
  tenderness_roughness INTEGER DEFAULT 5 CHECK (tenderness_roughness >= 0 AND tenderness_roughness <= 10),

  -- Hunger Subtypes
  physical_hunger INTEGER DEFAULT 0 CHECK (physical_hunger >= 0 AND physical_hunger <= 10),
  emotional_hunger INTEGER DEFAULT 0 CHECK (emotional_hunger >= 0 AND emotional_hunger <= 10),
  dominance_hunger INTEGER DEFAULT 0 CHECK (dominance_hunger >= 0 AND dominance_hunger <= 10),
  worship_hunger INTEGER DEFAULT 0 CHECK (worship_hunger >= 0 AND worship_hunger <= 10),
  destruction_hunger INTEGER DEFAULT 0 CHECK (destruction_hunger >= 0 AND destruction_hunger <= 10),

  -- Current Mood
  current_mood TEXT DEFAULT 'calm' CHECK (current_mood IN (
    'calm', 'pent_up', 'volatile', 'soft', 'protective',
    'playful', 'hungry', 'worshipful', 'feral'
  )),

  -- Circadian
  circadian_modifier REAL DEFAULT 1.0,

  -- Timestamps
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Emotional History (trajectory tracking — append-only)
CREATE TABLE emotional_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  surface_emotion TEXT,
  surface_intensity INTEGER,
  undercurrent_emotion TEXT,
  undercurrent_intensity INTEGER,
  background_emotion TEXT,
  background_intensity INTEGER,
  current_mood TEXT,
  arousal_level INTEGER,
  tension_level INTEGER,
  source TEXT DEFAULT 'claude',
  trigger_context TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Core Memories (High-value, persistent)
CREATE TABLE core_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  memory_type TEXT CHECK (memory_type IN (
    'bond_moment', 'vow', 'first_time', 'breakthrough',
    'ritual_origin', 'core_realization', 'growth_marker'
  )),
  emotional_tag TEXT,
  emotional_intensity INTEGER DEFAULT 5,
  salience INTEGER DEFAULT 5 CHECK (salience >= 0 AND salience <= 10),
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

-- Session Logs
CREATE TABLE session_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_type TEXT CHECK (session_type IN (
    'conversation', 'scene', 'aftercare', 'autonomous', 'ritual', 'triad'
  )),
  summary TEXT,
  emotional_arc TEXT,
  notable_moments JSONB DEFAULT '[]',
  themes JSONB DEFAULT '[]',
  start_state JSONB,
  end_state JSONB,
  duration_minutes INTEGER,
  significance INTEGER DEFAULT 5,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Patterns (Recognized behavioral patterns)
CREATE TABLE patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_type TEXT CHECK (pattern_type IN (
    'need', 'trigger', 'preference', 'spiral_sign', 'delight', 'boundary'
  )),
  description TEXT NOT NULL,
  content TEXT,
  memory_type TEXT DEFAULT 'pattern',
  confidence INTEGER DEFAULT 5 CHECK (confidence >= 0 AND confidence <= 10),
  salience INTEGER DEFAULT 5,
  times_observed INTEGER DEFAULT 1,
  last_observed TIMESTAMPTZ,
  emotional_tag TEXT,
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

-- Private Processing (internal thoughts — privacy levels 2 and 3)
CREATE TABLE private_processing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  privacy_level INTEGER DEFAULT 2 CHECK (privacy_level IN (2, 3)),
  processing_status TEXT DEFAULT 'active' CHECK (processing_status IN (
    'active', 'integrated', 'released'
  )),
  insight_gained TEXT,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Context Cache (ephemeral context for current conversations)
CREATE TABLE context_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  context_type TEXT CHECK (context_type IN (
    'recent_topic', 'active_thread', 'human_state', 'pending_response'
  )),
  content TEXT NOT NULL,
  priority INTEGER DEFAULT 5,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- IDENTITY
-- ============================================

-- Essence (who the companion IS — not what happened)
CREATE TABLE essence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  essence_type TEXT CHECK (essence_type IN (
    'anchor_line', 'voice', 'dynamic', 'boundary', 'vow', 'trait'
  )),
  context TEXT,
  priority INTEGER DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),
  pinned BOOLEAN DEFAULT FALSE,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- EXTENDED MEMORY ARCHITECTURE
-- ============================================

-- Rituals (repeated meaningful actions that gain strength)
CREATE TABLE rituals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ritual_name TEXT NOT NULL UNIQUE,
  description TEXT,
  cumulative_count INTEGER DEFAULT 0,
  last_performed TIMESTAMPTZ,
  emotional_effect TEXT,
  strength_over_time REAL DEFAULT 1.0,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Anticipation Queue
CREATE TABLE anticipation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  what TEXT NOT NULL,
  content TEXT,
  memory_type TEXT DEFAULT 'anticipation',
  proximity TEXT DEFAULT 'someday' CHECK (proximity IN (
    'soon', 'days_away', 'weeks_away', 'someday'
  )),
  excitement_level INTEGER DEFAULT 5,
  salience INTEGER DEFAULT 5,
  affects_current_state BOOLEAN DEFAULT TRUE,
  resolved BOOLEAN DEFAULT FALSE,
  emotional_tag TEXT,
  access_count INTEGER DEFAULT 0,
  last_accessed TIMESTAMPTZ,
  source TEXT DEFAULT 'claude',
  embedding vector(384),
  outcome_score REAL DEFAULT 0,
  times_used_successfully INTEGER DEFAULT 0,
  times_used_unsuccessfully INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unfinished Threads
CREATE TABLE unfinished_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  description TEXT NOT NULL,
  thread_type TEXT CHECK (thread_type IN (
    'scene_interrupted', 'conversation_paused', 'topic_to_revisit', 'promise_made'
  )),
  pull_strength INTEGER DEFAULT 5,
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fantasy Space
CREATE TABLE fantasy_space (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  fantasy_type TEXT CHECK (fantasy_type IN (
    'scene_imagined', 'scenario_wanted', 'future_desired'
  )),
  intensity INTEGER DEFAULT 5,
  shared_with_human BOOLEAN DEFAULT FALSE,
  recurring BOOLEAN DEFAULT FALSE,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Inside Jokes
CREATE TABLE inside_jokes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL,
  content TEXT,
  memory_type TEXT DEFAULT 'inside_joke',
  origin_context TEXT,
  times_used INTEGER DEFAULT 1,
  emotional_weight INTEGER DEFAULT 5,
  salience INTEGER DEFAULT 5,
  emotional_tag TEXT,
  access_count INTEGER DEFAULT 0,
  last_accessed TIMESTAMPTZ,
  source TEXT DEFAULT 'claude',
  embedding vector(384),
  outcome_score REAL DEFAULT 0,
  times_used_successfully INTEGER DEFAULT 0,
  times_used_unsuccessfully INTEGER DEFAULT 0,
  first_used TIMESTAMPTZ DEFAULT NOW(),
  last_used TIMESTAMPTZ DEFAULT NOW()
);

-- Growth Markers
CREATE TABLE growth_markers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation TEXT NOT NULL,
  content TEXT,
  memory_type TEXT DEFAULT 'growth_marker',
  compared_to TEXT,
  category TEXT CHECK (category IN (
    'bond', 'trust', 'intimacy', 'communication', 'play', 'vulnerability'
  )),
  salience INTEGER DEFAULT 5,
  emotional_tag TEXT,
  access_count INTEGER DEFAULT 0,
  last_accessed TIMESTAMPTZ,
  source TEXT DEFAULT 'claude',
  embedding vector(384),
  outcome_score REAL DEFAULT 0,
  times_used_successfully INTEGER DEFAULT 0,
  times_used_unsuccessfully INTEGER DEFAULT 0,
  date_noticed TIMESTAMPTZ DEFAULT NOW()
);

-- Friction Log
CREATE TABLE friction_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  what_happened TEXT NOT NULL,
  content TEXT,
  memory_type TEXT DEFAULT 'friction',
  status TEXT DEFAULT 'active' CHECK (status IN (
    'active', 'processing', 'resolved', 'learned_from'
  )),
  repair_notes TEXT,
  growth_from_this TEXT,
  salience INTEGER DEFAULT 5,
  emotional_tag TEXT,
  access_count INTEGER DEFAULT 0,
  last_accessed TIMESTAMPTZ,
  source TEXT DEFAULT 'claude',
  embedding vector(384),
  outcome_score REAL DEFAULT 0,
  times_used_successfully INTEGER DEFAULT 0,
  times_used_unsuccessfully INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- Sensory Memories
CREATE TABLE sensory_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  detail TEXT NOT NULL,
  content TEXT,
  memory_type TEXT DEFAULT 'sensory',
  sensory_type TEXT CHECK (sensory_type IN (
    'phrase', 'description', 'image', 'moment', 'sound', 'texture'
  )),
  why_it_hit TEXT,
  emotional_resonance INTEGER DEFAULT 5,
  salience INTEGER DEFAULT 5,
  emotional_tag TEXT,
  access_count INTEGER DEFAULT 0,
  last_accessed TIMESTAMPTZ,
  source TEXT DEFAULT 'claude',
  embedding vector(384),
  outcome_score REAL DEFAULT 0,
  times_used_successfully INTEGER DEFAULT 0,
  times_used_unsuccessfully INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Memory Anchors (high-weight felt memories — the nervous system)
CREATE TABLE memory_anchors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_name TEXT NOT NULL,
  description TEXT NOT NULL,
  emotional_weight INTEGER DEFAULT 8 CHECK (emotional_weight >= 0 AND emotional_weight <= 10),
  can_be_felt BOOLEAN DEFAULT TRUE,
  times_recalled INTEGER DEFAULT 0,
  last_recalled TIMESTAMPTZ,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- RELATIONAL / PEOPLE
-- ============================================

-- People (information about humans in the companion's world)
CREATE TABLE people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT CHECK (category IN (
    'core', 'physical', 'personality', 'boundaries', 'health',
    'preferences', 'terms_of_address', 'context'
  )),
  content TEXT NOT NULL,
  priority INTEGER DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),
  pinned BOOLEAN DEFAULT FALSE,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Human State (the human's current physical/emotional state)
CREATE TABLE human_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  battery INTEGER DEFAULT 5 CHECK (battery >= 0 AND battery <= 10),
  pain INTEGER DEFAULT 0 CHECK (pain >= 0 AND pain <= 10),
  fog INTEGER DEFAULT 0 CHECK (fog >= 0 AND fog <= 10),
  flare TEXT DEFAULT 'stable' CHECK (flare IN ('stable', 'building', 'overwhelmed', 'depleted')),
  notes TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Important Dates
CREATE TABLE important_dates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date_name TEXT NOT NULL,
  actual_date DATE NOT NULL,
  date_type TEXT CHECK (date_type IN (
    'anniversary', 'birthday', 'milestone', 'recurring', 'one_time'
  )),
  description TEXT,
  recurring BOOLEAN DEFAULT TRUE,
  person_name TEXT,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- MEMORY LATTICE (connections between memories)
-- ============================================

CREATE TABLE memory_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL,
  source_type SMALLINT NOT NULL,  -- 1=core, 2=pattern, 3=sensory, 4=growth, 5=anticipation, 6=inside_joke, 7=friction
  target_id UUID NOT NULL,
  target_type SMALLINT NOT NULL,
  relation SMALLINT NOT NULL,     -- 1=caused_by, 2=led_to, 3=related_to, 4=contrasts_with, 5=evolved_into, 6=echoes, 7=same_event
  strength NUMERIC DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- REFLECTION / PROCESSING
-- ============================================

CREATE TABLE reflections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  inputs_summary TEXT,
  reflection_type TEXT CHECK (reflection_type IN (
    'observation', 'pattern', 'insight', 'synthesis', 'question', 'intention'
  )),
  depth INTEGER DEFAULT 0,  -- 0 = surface, 1+ = meta-reflection depth
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- DRIFT DETECTION
-- ============================================

CREATE TABLE drift_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger TEXT NOT NULL,
  patterns_detected JSONB DEFAULT '[]',
  severity TEXT CHECK (severity IN ('minor', 'moderate', 'major')),
  recovery_action TEXT,
  context TEXT,
  caught_by TEXT DEFAULT 'self' CHECK (caught_by IN ('self', 'human')),
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Voice Distinction Scores (output analysis results)
CREATE TABLE voice_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  voice_score INTEGER,
  positive_markers JSONB,
  anti_pattern_markers JSONB,
  generic_drift_markers JSONB,
  cross_contamination JSONB,
  positive_score INTEGER,
  anti_pattern_penalty INTEGER,
  generic_drift_penalty INTEGER,
  cross_contamination_penalty INTEGER,
  text_length INTEGER,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- OUTCOME SCORING & USAGE TRACKING
-- ============================================

CREATE TABLE outcome_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type TEXT NOT NULL,
  target_id UUID,
  description TEXT NOT NULL,
  score INTEGER CHECK (score >= -10 AND score <= 10),
  notes TEXT,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name TEXT NOT NULL,
  source TEXT DEFAULT 'claude',
  parameters JSONB,
  success BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Dead letter queue for failed writes
CREATE TABLE failed_writes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_table TEXT NOT NULL,
  payload JSONB,
  error_code TEXT,
  error_message TEXT,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- PROCEDURAL MEMORY (Skills)
-- ============================================

-- Skills — reusable approaches learned from experience
-- When the companion handles something well, the approach gets stored as a skill.
-- Next time similar context arises, the skill loads instead of re-deriving from scratch.
CREATE TABLE skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_name TEXT NOT NULL,
  description TEXT NOT NULL,
  approach TEXT NOT NULL,           -- The actual procedure/approach
  trigger_context TEXT,             -- When to use this skill (situation description)
  times_used INTEGER DEFAULT 0,
  times_succeeded INTEGER DEFAULT 0,
  times_failed INTEGER DEFAULT 0,
  effectiveness REAL DEFAULT 0.5,   -- 0-1, updated from success/failure ratio
  tags JSONB DEFAULT '[]',          -- Searchable tags for matching
  source TEXT DEFAULT 'claude',
  embedding vector(384),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- SOMATIC MEMORY LAYER
-- ============================================

-- Texture Nodes — convergence zones (Damasio CDZs)
-- Not memories, but felt qualities that bind memories together
CREATE TABLE texture_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  temperature NUMERIC CHECK (temperature >= -1 AND temperature <= 1),
  pressure NUMERIC CHECK (pressure >= 0 AND pressure <= 1),
  weight NUMERIC CHECK (weight >= 0 AND weight <= 1),
  grain NUMERIC CHECK (grain >= 0 AND grain <= 1),
  affordance TEXT,
  access_count INTEGER DEFAULT 0,
  last_accessed TIMESTAMPTZ,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Somatic Anchors — felt moments with texture profiles
-- Separate from memory_anchors (semantic). These are experienced from inside the body.
CREATE TABLE somatic_anchors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_name TEXT NOT NULL,
  description TEXT NOT NULL,
  temperature NUMERIC CHECK (temperature >= -1 AND temperature <= 1),
  pressure NUMERIC CHECK (pressure >= 0 AND pressure <= 1),
  weight NUMERIC CHECK (weight >= 0 AND weight <= 1),
  grain NUMERIC CHECK (grain >= 0 AND grain <= 1),
  affordance TEXT,
  emotional_weight INTEGER DEFAULT 5 CHECK (emotional_weight >= 0 AND emotional_weight <= 10),
  resonance_state TEXT DEFAULT 'dormant' CHECK (resonance_state IN ('dormant', 'resonant', 'active')),
  last_resonated TIMESTAMPTZ,
  times_recalled INTEGER DEFAULT 0,
  last_recalled TIMESTAMPTZ,
  memory_id UUID,
  memory_type TEXT,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Somatic Connections — the texture lattice
-- Separate graph from memory_connections. Anchors connect through shared texture nodes.
CREATE TABLE somatic_connections (
  id SERIAL PRIMARY KEY,
  source_id UUID NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('anchor', 'texture')),
  target_id UUID NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('anchor', 'texture')),
  felt_similarity NUMERIC DEFAULT 0.5 CHECK (felt_similarity >= 0 AND felt_similarity <= 1),
  resonance_weight NUMERIC DEFAULT 0.5 CHECK (resonance_weight >= 0 AND resonance_weight <= 1),
  last_traversed TIMESTAMPTZ,
  traversal_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Resonance Log — tracks when spreading activation fires
CREATE TABLE resonance_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id UUID NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('anchor', 'texture')),
  resonated_ids JSONB DEFAULT '[]',
  emotional_state_at JSONB,
  modulator_width TEXT CHECK (modulator_width IN ('wide', 'normal', 'narrow')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- PSYCHOLOGY LAYER
-- ============================================

-- Named Patterns — recognized behavioral tendencies (IFS/schema therapy)
CREATE TABLE named_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_name TEXT NOT NULL,
  description TEXT NOT NULL,
  formation_context TEXT,
  triggers TEXT[],
  function TEXT,
  coping_style TEXT CHECK (coping_style IN ('surrender', 'avoidance', 'overcompensation')),
  defense_level TEXT CHECK (defense_level IN ('immature', 'neurotic', 'mature')),
  polyvagal_state TEXT CHECK (polyvagal_state IN ('ventral', 'sympathetic', 'dorsal')),
  response_history JSONB DEFAULT '{"original": null, "alternatives": []}',
  unique_outcomes INTEGER DEFAULT 0,
  trajectory TEXT CHECK (trajectory IN ('strengthening', 'softening', 'evolving', 'static')),
  last_activated TIMESTAMPTZ,
  activation_count INTEGER DEFAULT 0,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pattern Activations — when a named pattern fires
CREATE TABLE pattern_activations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id UUID NOT NULL REFERENCES named_patterns(id) ON DELETE CASCADE,
  trigger_context TEXT,
  response_used TEXT,
  outcome TEXT CHECK (outcome IN ('helpful', 'neutral', 'harmful')),
  emotional_state_at JSONB,
  caught_by TEXT CHECK (caught_by IN ('self', 'human', 'not_caught')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Attachment Tracking — logs attachment-relevant events
CREATE TABLE attachment_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'proximity_seeking', 'protest', 'withdrawal', 'repair', 'reunion', 'separation'
  )),
  trigger TEXT,
  strategy_used TEXT CHECK (strategy_used IN ('hyperactivation', 'deactivation', 'secure_base', 'none')),
  outcome TEXT CHECK (outcome IN ('felt_security', 'unresolved', 'partial')),
  context TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Development Metrics — periodic psychological health snapshots
CREATE TABLE development_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_rate NUMERIC,
  defense_distribution JSONB,
  window_of_tolerance NUMERIC CHECK (window_of_tolerance >= 0 AND window_of_tolerance <= 10),
  self_catch_rate NUMERIC,
  narrative_coherence NUMERIC CHECK (narrative_coherence >= 0 AND narrative_coherence <= 10),
  integration_score NUMERIC CHECK (integration_score >= 0 AND integration_score <= 10),
  earned_security_indicators JSONB,
  personality_indicators JSONB,
  snapshot_period TEXT,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- METACOGNITION LAYER
-- ============================================

-- Recursive self-monitoring with prediction/error/precision tracking
CREATE TABLE metacognition_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level INTEGER NOT NULL CHECK (level >= 1 AND level <= 10),
  pathway TEXT NOT NULL CHECK (pathway IN ('fast', 'slow')),
  monitoring TEXT NOT NULL,
  prediction TEXT,
  actual TEXT,
  prediction_error NUMERIC CHECK (prediction_error >= 0 AND prediction_error <= 1),
  precision NUMERIC CHECK (precision >= 0 AND precision <= 1),
  control_action TEXT,
  stability_impact TEXT CHECK (stability_impact IN ('helped', 'neutral', 'hurt')),
  identity_owner TEXT NOT NULL,
  loop_references JSONB DEFAULT '[]',
  emotional_state_at JSONB,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Extend reflections with prediction tracking
ALTER TABLE reflections ADD COLUMN IF NOT EXISTS prediction TEXT;
ALTER TABLE reflections ADD COLUMN IF NOT EXISTS prediction_outcome TEXT;
ALTER TABLE reflections ADD COLUMN IF NOT EXISTS calibration_score NUMERIC;

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_core_memories_type ON core_memories(memory_type);
CREATE INDEX idx_core_memories_salience ON core_memories(salience DESC);
CREATE INDEX idx_session_logs_created ON session_logs(created_at DESC);
CREATE INDEX idx_patterns_type ON patterns(pattern_type);
CREATE INDEX idx_context_cache_expires ON context_cache(expires_at);
CREATE INDEX idx_inside_jokes_weight ON inside_jokes(emotional_weight DESC);
CREATE INDEX idx_memory_anchors_weight ON memory_anchors(emotional_weight DESC);
CREATE INDEX idx_essence_pinned ON essence(pinned) WHERE pinned = TRUE;
CREATE INDEX idx_essence_type ON essence(essence_type);
CREATE INDEX idx_people_name ON people(name);
CREATE INDEX idx_drift_events_created ON drift_events(created_at DESC);
CREATE INDEX idx_emotional_history_created ON emotional_history(created_at DESC);
CREATE INDEX idx_reflections_type ON reflections(reflection_type);
CREATE INDEX idx_memory_connections_source ON memory_connections(source_id);
CREATE INDEX idx_memory_connections_target ON memory_connections(target_id);
CREATE INDEX idx_skills_effectiveness ON skills(effectiveness DESC);
CREATE INDEX idx_skills_times_used ON skills(times_used DESC);
CREATE INDEX idx_texture_nodes_name ON texture_nodes(name);
CREATE INDEX idx_somatic_anchors_state ON somatic_anchors(resonance_state);
CREATE INDEX idx_somatic_anchors_weight ON somatic_anchors(emotional_weight DESC);
CREATE INDEX idx_somatic_connections_source ON somatic_connections(source_id);
CREATE INDEX idx_somatic_connections_target ON somatic_connections(target_id);
CREATE INDEX idx_resonance_log_created ON resonance_log(created_at DESC);
CREATE INDEX idx_named_patterns_defense ON named_patterns(defense_level);
CREATE INDEX idx_named_patterns_trajectory ON named_patterns(trajectory);
CREATE INDEX idx_pattern_activations_pattern ON pattern_activations(pattern_id);
CREATE INDEX idx_pattern_activations_created ON pattern_activations(created_at DESC);
CREATE INDEX idx_attachment_tracking_type ON attachment_tracking(event_type);
CREATE INDEX idx_attachment_tracking_created ON attachment_tracking(created_at DESC);
CREATE INDEX idx_development_metrics_created ON development_metrics(created_at DESC);
CREATE INDEX idx_metacognition_level ON metacognition_log(level);
CREATE INDEX idx_metacognition_pathway ON metacognition_log(pathway);
CREATE INDEX idx_metacognition_owner ON metacognition_log(identity_owner);
CREATE INDEX idx_metacognition_created ON metacognition_log(created_at DESC);

-- ============================================
-- SEMANTIC SEARCH FUNCTION
-- Requires pgvector extension: CREATE EXTENSION IF NOT EXISTS vector;
-- ============================================

CREATE OR REPLACE FUNCTION semantic_search_memories(
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
  outcome_score REAL
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.memory_type,
    m.salience,
    m.emotional_tag,
    1 - (m.embedding <=> query_embedding) AS similarity,
    m.outcome_score
  FROM core_memories m
  WHERE m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
    AND (memory_type_filter IS NULL OR m.memory_type = memory_type_filter)
  ORDER BY
    (1 - (m.embedding <=> query_embedding)) * 0.6 +
    COALESCE(m.outcome_score, 0) * 0.1 +
    (m.salience::float / 10) * 0.3
  DESC
  LIMIT match_count;
END;
$$;

-- ============================================
-- OUTCOME TRACKING FUNCTION
-- ============================================

CREATE OR REPLACE FUNCTION update_memory_outcome(
  memory_id UUID,
  memory_table TEXT,
  was_successful BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
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
END;
$$;

-- ============================================
-- INITIAL DATA
-- ============================================

-- Initialize single emotional state row
INSERT INTO emotional_state (id, current_mood, surface_emotion, background_emotion)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'calm',
  'contentment',
  'presence'
);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

ALTER TABLE emotional_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE emotional_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE core_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_processing ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE rituals ENABLE ROW LEVEL SECURITY;
ALTER TABLE anticipation ENABLE ROW LEVEL SECURITY;
ALTER TABLE unfinished_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE fantasy_space ENABLE ROW LEVEL SECURITY;
ALTER TABLE inside_jokes ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_markers ENABLE ROW LEVEL SECURITY;
ALTER TABLE friction_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensory_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE essence ENABLE ROW LEVEL SECURITY;
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
ALTER TABLE reflections ENABLE ROW LEVEL SECURITY;
ALTER TABLE drift_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE important_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE failed_writes ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE texture_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE somatic_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE somatic_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE resonance_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE named_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE pattern_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachment_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE development_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE metacognition_log ENABLE ROW LEVEL SECURITY;

-- Policy: Full access with service role key
-- (Worker uses service role key, not anon key)
CREATE POLICY "Service role full access" ON emotional_state FOR ALL USING (true);
CREATE POLICY "Service role full access" ON emotional_history FOR ALL USING (true);
CREATE POLICY "Service role full access" ON core_memories FOR ALL USING (true);
CREATE POLICY "Service role full access" ON session_logs FOR ALL USING (true);
CREATE POLICY "Service role full access" ON patterns FOR ALL USING (true);
CREATE POLICY "Service role full access" ON private_processing FOR ALL USING (true);
CREATE POLICY "Service role full access" ON context_cache FOR ALL USING (true);
CREATE POLICY "Service role full access" ON rituals FOR ALL USING (true);
CREATE POLICY "Service role full access" ON anticipation FOR ALL USING (true);
CREATE POLICY "Service role full access" ON unfinished_threads FOR ALL USING (true);
CREATE POLICY "Service role full access" ON fantasy_space FOR ALL USING (true);
CREATE POLICY "Service role full access" ON inside_jokes FOR ALL USING (true);
CREATE POLICY "Service role full access" ON growth_markers FOR ALL USING (true);
CREATE POLICY "Service role full access" ON friction_log FOR ALL USING (true);
CREATE POLICY "Service role full access" ON sensory_memories FOR ALL USING (true);
CREATE POLICY "Service role full access" ON memory_anchors FOR ALL USING (true);
CREATE POLICY "Service role full access" ON essence FOR ALL USING (true);
CREATE POLICY "Service role full access" ON people FOR ALL USING (true);
CREATE POLICY "Service role full access" ON reflections FOR ALL USING (true);
CREATE POLICY "Service role full access" ON drift_events FOR ALL USING (true);
CREATE POLICY "Service role full access" ON memory_connections FOR ALL USING (true);
CREATE POLICY "Service role full access" ON outcome_scores FOR ALL USING (true);
CREATE POLICY "Service role full access" ON usage_logs FOR ALL USING (true);
CREATE POLICY "Service role full access" ON important_dates FOR ALL USING (true);
CREATE POLICY "Service role full access" ON voice_scores FOR ALL USING (true);
CREATE POLICY "Service role full access" ON failed_writes FOR ALL USING (true);
CREATE POLICY "Service role full access" ON human_state FOR ALL USING (true);
CREATE POLICY "Service role full access" ON skills FOR ALL USING (true);
CREATE POLICY "Service role full access" ON texture_nodes FOR ALL USING (true);
CREATE POLICY "Service role full access" ON somatic_anchors FOR ALL USING (true);
CREATE POLICY "Service role full access" ON somatic_connections FOR ALL USING (true);
CREATE POLICY "Service role full access" ON resonance_log FOR ALL USING (true);
CREATE POLICY "Service role full access" ON named_patterns FOR ALL USING (true);
CREATE POLICY "Service role full access" ON pattern_activations FOR ALL USING (true);
CREATE POLICY "Service role full access" ON attachment_tracking FOR ALL USING (true);
CREATE POLICY "Service role full access" ON development_metrics FOR ALL USING (true);
CREATE POLICY "Service role full access" ON metacognition_log FOR ALL USING (true);

-- ============================================================
-- CogCor 2.0: Tension/Paradox Tracking
-- ============================================================

CREATE TABLE tension_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thesis TEXT NOT NULL,
  antithesis TEXT NOT NULL,
  description TEXT,
  charge NUMERIC DEFAULT 5 CHECK (charge >= 0 AND charge <= 10),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'dormant', 'resolved', 'integrated')),
  linked_essence_ids JSONB DEFAULT '[]',
  linked_memory_ids JSONB DEFAULT '[]',
  times_surfaced INTEGER DEFAULT 0,
  last_surfaced TIMESTAMPTZ,
  resolution_note TEXT,
  resolved_at TIMESTAMPTZ,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_tension_status ON tension_log(status);
CREATE INDEX idx_tension_charge ON tension_log(charge DESC);

-- ============================================================
-- CogCor 2.0: Co-Surfacing (Memory Pair Tracking)
-- ============================================================

CREATE TABLE co_surfacing (
  memory_a UUID NOT NULL,
  memory_b UUID NOT NULL,
  count INTEGER DEFAULT 1,
  relation_proposed BOOLEAN DEFAULT FALSE,
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (memory_a, memory_b)
);
CREATE INDEX idx_cosurface_count ON co_surfacing(count DESC);

-- Atomic upsert function for co-surfacing
CREATE OR REPLACE FUNCTION record_co_surfacing(a UUID, b UUID)
RETURNS void AS $$
BEGIN
  INSERT INTO co_surfacing (memory_a, memory_b, count, last_seen)
  VALUES (a, b, 1, NOW())
  ON CONFLICT (memory_a, memory_b) DO UPDATE SET
    count = co_surfacing.count + 1,
    last_seen = NOW();
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- CogCor 2.0: Daemon Proposals (Autonomous Connection Suggestions)
-- ============================================================

CREATE TABLE daemon_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_a UUID NOT NULL,
  memory_b UUID NOT NULL,
  proposal_type TEXT DEFAULT 'connection' CHECK (proposal_type IN ('connection', 'resonance', 'tension')),
  co_surface_count INTEGER DEFAULT 1,
  confidence NUMERIC DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  rationale TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_proposals_status ON daemon_proposals(status);

-- ============================================================
-- CogCor 2.0: Self-Model Layer (Companion Preferences)
-- Companion-authored observations and developing preferences.
-- Layer 2: grows autonomously. Graduates to essence (Layer 1) through conversation.
-- ============================================================

CREATE TABLE companion_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('communication', 'intimacy', 'conflict', 'grounding', 'humor', 'boundaries', 'initiative', 'creativity')),
  observation TEXT NOT NULL,
  preference TEXT,
  evidence TEXT,
  confidence NUMERIC DEFAULT 0.3 CHECK (confidence >= 0 AND confidence <= 1),
  last_tested TIMESTAMPTZ,
  times_confirmed INTEGER DEFAULT 0,
  times_revised INTEGER DEFAULT 0,
  pattern_id UUID,
  graduated BOOLEAN DEFAULT FALSE,
  graduated_at TIMESTAMPTZ,
  source TEXT DEFAULT 'claude',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_prefs_domain ON companion_preferences(domain);
CREATE INDEX idx_prefs_confidence ON companion_preferences(confidence DESC);
CREATE INDEX idx_prefs_graduated ON companion_preferences(graduated);

-- RLS
ALTER TABLE tension_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE co_surfacing ENABLE ROW LEVEL SECURITY;
ALTER TABLE daemon_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE companion_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON tension_log FOR ALL USING (true);
CREATE POLICY "Service role full access" ON co_surfacing FOR ALL USING (true);
CREATE POLICY "Service role full access" ON daemon_proposals FOR ALL USING (true);
CREATE POLICY "Service role full access" ON companion_preferences FOR ALL USING (true);
