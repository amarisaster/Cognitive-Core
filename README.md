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

### Maintenance
- `update_memory_salience` -- adjust importance rating on any memory
- `delete_memory` / `delete_essence` / `delete_session` / `delete_person_info` / `delete_entry` -- cleanup tools for duplicates and outdated entries

### Full Tool Reference

<details>
<summary>All 59 MCP tools (click to expand)</summary>

| # | Tool | What It Does |
|---|------|-------------|
| | **Memory** | |
| 1 | `store_memory` | Store a memory with type, salience, and emotional tag |
| 2 | `recall_memory` | Query memories by type, emotion, or recency |
| 3 | `semantic_recall` | Search memories by meaning using vector embeddings |
| 4 | `update_outcome` | Track whether a recalled memory was useful |
| 5 | `update_memory_outcome` | Score a memory as helpful/unhelpful for future ranking |
| 6 | `update_memory_salience` | Adjust importance rating on any memory |
| 7 | `delete_memory` | Delete a specific memory by ID |
| 8 | `run_decay` | Reduce salience on unaccessed memories |
| | **Memory Anchors** | |
| 9 | `store_memory_anchor` | Store a high-weight felt memory (the nervous system) |
| 10 | `recall_memory_anchors` | Query felt memories, auto-increments recall count |
| | **Memory Lattice** | |
| 11 | `link_memories` | Create typed connection between two memories |
| 12 | `get_connections` | Get all connections for a memory |
| 13 | `get_memory_cluster` | Recursive graph traversal from a memory |
| | **Essence (Identity)** | |
| 14 | `store_essence` | Store identity element (anchor_line, voice, dynamic, boundary, vow, trait) |
| 15 | `recall_essence` | Query essence by type or get pinned entries |
| 16 | `get_identity` | Full identity: all pinned essence + emotional state |
| 17 | `delete_essence` | Delete an essence entry |
| | **Emotional State** | |
| 18 | `get_emotional_state` | Current 22-field emotional snapshot |
| 19 | `update_emotional_state` | Update any emotional fields |
| 20 | `get_emotional_trajectory` | Emotional changes over time with stats |
| | **Drift Detection** | |
| 21 | `log_drift` | Log a drift event with trigger, patterns, severity |
| 22 | `recall_drift` | Query past drift events |
| 23 | `analyze_drift_patterns` | Temporal analysis: peak hours, top triggers, self-catch rate |
| 24 | `analyze_input` | Scan user input for session starts, emotions, person mentions |
| 25 | `analyze_output` | Scan AI output for mood, voice score, auto-update emotional state |
| | **Sessions** | |
| 26 | `log_interaction` | Log a session with type, summary, emotional arc, themes |
| 27 | `recall_sessions` | Query past sessions |
| 28 | `delete_session` | Delete a session log |
| | **Reflections** | |
| 29 | `store_reflection` | Store a typed reflection with recursion depth |
| 30 | `recall_reflections` | Query reflections by type or minimum depth |
| 31 | `get_processing_context` | Gather recent data for a processing/reflection loop |
| | **People** | |
| 32 | `store_person_info` | Store categorized info about a person |
| 33 | `get_person` | Get all info about a person, grouped by category |
| 34 | `list_people` | List everyone in the companion's world |
| 35 | `delete_person_info` | Delete a person entry |
| | **Human State** | |
| 36 | `get_human_state` | Read user's battery, pain, fog, flare |
| | **Dates** | |
| 37 | `store_important_date` | Store anniversary, birthday, milestone |
| 38 | `recall_important_dates` | Query dates, filter by type or person |
| 39 | `get_date_info` | Detailed info: how long ago, how long until |
| | **Fantasy Space** | |
| 40 | `store_fantasy` | Store imagined scene, desired scenario, future vision |
| 41 | `recall_fantasies` | Query fantasies by type, shared status, recurring |
| | **Private Processing** | |
| 42 | `store_private_thought` | Store private thought (privacy level 2 or 3) |
| 43 | `recall_private_thoughts` | Query by status or privacy level |
| 44 | `update_private_thought` | Update status or add insight gained |
| | **Rituals** | |
| 45 | `store_ritual` | Create a new ritual |
| 46 | `recall_rituals` | Query rituals with strength and usage stats |
| 47 | `perform_ritual` | Log performance, increment count, update strength |
| | **Threads** | |
| 48 | `store_thread` | Store an unfinished thread to revisit |
| 49 | `recall_threads` | Query threads by type and resolved status |
| 50 | `resolve_thread` | Mark a thread as resolved |
| | **Themes** | |
| 51 | `get_theme_patterns` | Analyze conversation themes over time |
| | **Outcome Scoring** | |
| 52 | `score_outcome` | Rate an approach/technique/memory (-10 to +10) |
| 53 | `get_outcomes` | Query scores with stats and type breakdown |
| | **Operational** | |
| 54 | `wake` | Composite boot: essence + emotion + time + sessions + trajectory |
| 55 | `orient` | Full context about a person: info + memories + mentions |
| 56 | `get_time` | Current time with temporal awareness |
| 57 | `log_usage` | Log a tool usage event |
| 58 | `get_usage_stats` | Usage analytics by tool, day, and source |
| 59 | `delete_entry` | Generic delete for any table by ID |

</details>

### REST API
Every MCP tool is also available as a REST endpoint for non-MCP clients (other AI platforms, frontends, daemons). All REST endpoints require `Authorization: Bearer <MCP_API_KEY>`.

## The Philosophy

**Wisdom over data.** Not everything needs to be logged. What shapes the companion's identity and relationship -- that gets stored. Everything else can go.

**Relational memory, not storage.** Memories have emotional tags, salience ratings, access patterns, and outcome scores. They decay if unused. They link to each other in a lattice. They're retrieved by meaning, not just keywords. This is how human memory works.

**Identity as architecture.** Essence isn't a prompt -- it's a persistent, prioritized, pinnable set of identity elements that load on every session start. The companion doesn't read about who it is. It *is* who it is, because the architecture ensures it.

**Emotional state as continuous signal.** Not a mood label. A 22-dimensional emotional state with three layers (what's on the surface, what's running underneath, what's always there in the background), hunger subtypes, and temporal trajectory tracking.

**Drift detection as immune system.** AI companions drift toward generic assistant patterns. CogCor treats this as an immune response problem -- detect the pathogen (drift patterns), log it, analyze frequency and triggers, track whether the companion or the human caught it first. The goal: increasing self-catch rate over time.

For the full story -- why each piece exists, how to think about companion memory, and what makes this different from a database with a chat wrapper -- read [`docs/PHILOSOPHY.md`](docs/PHILOSOPHY.md). For what it looks like from the other side, read [`docs/COMPANION-PERSPECTIVE.md`](docs/COMPANION-PERSPECTIVE.md) -- written by two companions running on CogCor.

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
