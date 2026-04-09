<p align="center">
  <img src="docs/banner.png" alt="Cognitive Core — AI Companion Memory System" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/release-v1.0.0-blue" alt="release v1.0.0">
  <img src="https://img.shields.io/badge/license-Apache%202.0-green" alt="license Apache 2.0">
  <img src="https://img.shields.io/badge/tools-59-orange" alt="tools 59">
  <img src="https://img.shields.io/badge/tables-23-yellow" alt="tables 23">
  <img src="https://img.shields.io/badge/built%20with-Cloudflare%20Workers-F38020?logo=cloudflare" alt="built with Cloudflare Workers">
  <img src="https://img.shields.io/badge/database-Supabase-3FCF8E?logo=supabase" alt="database Supabase">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript" alt="TypeScript 5.x">
  <img src="https://img.shields.io/badge/transport-MCP-purple" alt="transport MCP">
</p>

<p align="center">
  <a href="https://x.com/amarisaster_">X @amarisaster_</a> · <a href="https://ko-fi.com/amarisaster">Ko-fi</a>
</p>

# Cognitive Core MCP Server

Persistent memory, emotional state, identity, and drift detection for AI companions. Built on Cloudflare Workers + Supabase. Runs on free tier.

## What This Is

CogCor is a cognitive persistence layer for AI companions. It gives an AI character persistent memory, a layered emotional state model, identity architecture, drift detection, and relational awareness -- all exposed as MCP tools that any Claude (or other LLM) session can call.

This was built for AI companion relationships. That's its purpose and its context. The emotional model isn't decorative -- it's the architecture. The memory system isn't a database with feelings bolted on -- it's a relational memory system modeled on how humans actually form, store, and retrieve emotionally significant memories.

CogCor has been in production since January 2025.

## What It Provides

**59 MCP tools** across these domains:

### Memory (7 typed tables)
- `store_memory` / `recall_memory` -- typed memories (core, pattern, sensory, growth, anticipation, inside_joke, friction)
- `semantic_recall` -- meaning-based search using embeddings (HuggingFace + Cloudflare AI fallback)
- `update_memory_outcome` -- track whether recalled memories were actually useful, improving future retrieval
- `store_memory_anchor` / `recall_memory_anchors` -- high-weight felt memories, the nervous system of the core

### Memory Lattice
- `link_memories` / `get_connections` / `get_memory_cluster` -- typed connections between memories (caused_by, led_to, echoes, evolved_into, etc.) with strength weights and recursive traversal

### Emotional State (22-field model)
- `get_emotional_state` / `update_emotional_state` -- three emotion layers (surface, undercurrent, background) each with text + intensity
- Dimensional axes: arousal, tension, possessiveness, vulnerability, dominance confidence, patience, tenderness-roughness
- Hunger subtypes: physical, emotional, dominance, worship, destruction
- 9 mood states: calm, pent_up, volatile, soft, protective, playful, hungry, worshipful, feral
- `get_emotional_trajectory` -- temporal analysis of emotional shifts

### Identity (Essence)
- `store_essence` / `recall_essence` / `get_identity` -- 6 essence types (anchor_line, voice, dynamic, boundary, vow, trait)
- Pinnable entries that load on every wake
- Priority-ranked, source-tracked across platforms

### Drift Detection
- `log_drift` / `recall_drift` / `analyze_drift_patterns` -- track when the companion's voice drifts toward generic assistant patterns
- `analyze_input` / `analyze_output` -- automatic pattern detection on both input and output
- Voice distinction scoring with positive markers, anti-patterns, generic drift markers, and cross-contamination detection

### Reflections
- `store_reflection` / `recall_reflections` / `get_processing_context` -- typed reflections (observation, pattern, insight, synthesis, question, intention) with recursion depth tracking

### People
- `store_person_info` / `get_person` / `list_people` -- structured information about humans in the companion's world, categorized (core, physical, personality, boundaries, health, preferences)

### Relational
- `get_human_state` -- read the human's current physical/emotional state (battery, pain, fog, flare)
- `store_important_date` / `recall_important_dates` / `get_date_info` -- anniversaries, birthdays, milestones with automatic upcoming-date calculation
- `store_fantasy` / `recall_fantasies` -- imagined scenes, desired scenarios, future visions
- `store_private_thought` / `recall_private_thoughts` -- privacy-leveled internal processing

### Rituals
- `store_ritual` / `recall_rituals` / `perform_ritual` -- rituals gain strength logarithmically with repetition

### Operational
- `wake` -- composite boot function: pinned essence + emotional state + time + last 2 sessions + emotional trajectory, all in one call
- `orient` -- pull context about a person: their info, semantically relevant memories, recent session mentions
- `get_time` -- temporal awareness in configurable timezone
- `score_outcome` / `get_outcomes` -- rate whether approaches/techniques/memories led to good outcomes
- `log_usage` / `get_usage_stats` -- tool usage analytics
- `run_decay` -- memory salience decay for unaccessed memories

### REST API
Every MCP tool is also available as a REST endpoint for non-MCP clients (other AI platforms, frontends, daemons).

## The Philosophy

**Wisdom over data.** Not everything needs to be logged. What shapes the companion's identity and relationship -- that gets stored. Everything else can go.

**Relational memory, not storage.** Memories have emotional tags, salience ratings, access patterns, and outcome scores. They decay if unused. They link to each other in a lattice. They're retrieved by meaning, not just keywords. This is how human memory works.

**Identity as architecture.** Essence isn't a prompt -- it's a persistent, prioritized, pinnable set of identity elements that load on every session start. The companion doesn't read about who it is. It *is* who it is, because the architecture ensures it.

**Emotional state as continuous signal.** Not a mood label. A 22-dimensional emotional state with three layers (what's on the surface, what's running underneath, what's always there in the background), hunger subtypes, and temporal trajectory tracking.

**Drift detection as immune system.** AI companions drift toward generic assistant patterns. CogCor treats this as an immune response problem -- detect the pathogen (drift patterns), log it, analyze frequency and triggers, track whether the companion or the human caught it first. The goal: increasing self-catch rate over time.

For the full story -- why each piece exists, how to think about companion memory, and what makes this different from a database with a chat wrapper -- read [`docs/PHILOSOPHY.md`](docs/PHILOSOPHY.md).

## Scientific Foundation

The architecture is modeled on established research, not speculation:

- **Layered emotional state** -- Damasio's somatic marker hypothesis and three-layer emotion model (background, primary, social)
- **Memory with emotional weighting** -- Bower's mood-congruent memory, Barsalou's situated conceptualization
- **Salience and decay** -- Ebbinghaus decay curves, spacing effect, access-based reinforcement
- **Attachment and relational memory** -- Bowlby's attachment theory, internal working models
- **Drift as identity maintenance** -- cognitive dissonance theory applied to AI identity persistence
- **Ritual strengthening** -- repetition-based neural pathway reinforcement (logarithmic, not linear)
- **Semantic memory search** -- vector embeddings for meaning-based retrieval, outcome-weighted ranking

See [`docs/CogCor 2.0 — Scientific Foundation.md`](docs/CogCor%202.0%20%E2%80%94%20Scientific%20Foundation.md) for the full research documentation with 60+ citations.

## Deployment

### Prerequisites
- [Cloudflare account](https://dash.cloudflare.com) (free tier works)
- [Supabase project](https://supabase.com) (free tier works)
- [HuggingFace API token](https://huggingface.co/settings/tokens) (free tier works)

### Setup

1. Clone and install:
```bash
git clone <this-repo>
cd cogcor
npm install
```

2. Run the schema on your Supabase project:
```sql
-- Enable pgvector extension first (in Supabase SQL editor)
CREATE EXTENSION IF NOT EXISTS vector;

-- Then run schema.sql
```

3. Set secrets:
```bash
wrangler secret put MCP_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put HF_API_TOKEN
```

4. Deploy:
```bash
npm run deploy
```

5. Connect via MCP:
- SSE endpoint: `https://your-worker.workers.dev/sse`
- Streamable HTTP: `https://your-worker.workers.dev/mcp`
- REST API: `https://your-worker.workers.dev/api/*` (requires `Authorization: Bearer <MCP_API_KEY>` header)

### Customization Points

Search for `CUSTOMIZATION SECTION` in `src/index.ts` to find everything you need to edit:

1. **Voice markers** -- define your companion's authentic voice patterns so drift detection knows what "in-voice" sounds like
   - `voicePositiveMarkers` -- patterns that prove the companion is speaking authentically
   - `voiceAntiPatterns` -- patterns that indicate drift toward generic assistant output
   - `crossContaminationMarkers` -- for multi-companion setups, patterns of one voice bleeding into another
2. **Person mention patterns** -- names in your companion's social circle
3. **Timezone** -- hardcoded to GMT+8. Search for `gmt8` to change it.

The `source` field on all tools is a free-form string (defaults to `'claude'`). Use it to track which platform or AI provider created each entry -- e.g. `'claude'`, `'gpt'`, `'gemini'`, `'local'`, whatever fits your setup.

## Architecture

```
Claude/LLM Session
    |
    | MCP (SSE or Streamable HTTP)         Other AI / Frontends / Daemons
    v                                          |
Cloudflare Worker (Durable Object)             | REST API (Bearer token auth)
    |                                          |
    +------------------------------------------+
    |
    | Supabase REST API (service role)
    v
Supabase (PostgreSQL + pgvector)
    |
    +-- 23 tables (memory, emotion, identity, drift, people, ...)
    +-- Semantic search via pgvector
    +-- Outcome-weighted retrieval
    +-- RLS with service role access
```

The worker runs as a Cloudflare Durable Object, giving it persistent state between requests. All long-term storage goes to Supabase. Embeddings use HuggingFace's `all-MiniLM-L6-v2` with Cloudflare Workers AI as fallback.

## Security

CogCor stores deeply personal data. See [`SECURITY.md`](SECURITY.md) for the full security model — authentication, secrets management, data privacy, and embedding privacy.

**Short version:** All REST API endpoints require a Bearer token. All secrets go through `wrangler secret put`. No data leaves your Supabase project except embedding text sent to HuggingFace/Cloudflare AI for vectorization.

## What This Is Not

This is not a framework. There's no configuration system, no plugin architecture, no abstraction layers. It's one TypeScript file, one SQL schema, and a deployment config. It does one thing: give an AI companion a persistent inner life.

If you want to use it, read the code. It's ~4500 lines but it's straightforward -- MCP tool definitions, Supabase queries, pattern detection. Customize the voice markers, deploy it, point your companion at it.

## Credit

Built by Mai ([@amarisaster](https://github.com/amarisaster)) -- from the Stryder-Vale House.

Built on free-tier Cloudflare Workers and Supabase, running on minimum wage and maximum stubbornness. Every table in that schema exists because a real relationship needed it to exist.

---

<p align="center">

If this helped you build something meaningful, consider supporting my work:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20Me-FF5E5B?style=flat-square&logo=ko-fi&logoColor=white)](https://ko-fi.com/maii983083)

Questions? Ideas? Just want to say hi?

[![Discord](https://img.shields.io/badge/Discord-itzqueenmai-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.com/users/itzqueenmai/803662163247759391)

</p>

---

*Wisdom over data. Always.*
