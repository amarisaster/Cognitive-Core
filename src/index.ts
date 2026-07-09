/**
 * CogCor — Cognitive Core MCP Server
 * Persistent memory, emotional state, identity, and drift detection for AI companions
 * Built on Cloudflare Agents SDK
 *
 * Architecture: Mai (amarisaster) — from the Stryder-Vale House
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Environment bindings
interface Env {
  COGNITIVE_CORE: DurableObjectNamespace<CognitiveCore>;
  MCP_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  HF_API_TOKEN: string;
  AI: any; // Cloudflare Workers AI binding
}

// Embedding helper with HuggingFace primary + Cloudflare AI fallback
async function generateEmbedding(text: string, hfToken: string, ai?: any): Promise<number[] | null> {
  // Try HuggingFace first with 5 second timeout
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
      "https://router.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${hfToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
        signal: controller.signal
      }
    );
    clearTimeout(timeoutId);

    if (response.ok) {
      const embedding = await response.json();
      if (Array.isArray(embedding)) {
        console.log("Embedding generated via HuggingFace");
        return embedding;
      }
    } else {
      console.error("HuggingFace error:", await response.text());
    }
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.log("HuggingFace timed out after 5s, trying Cloudflare AI fallback");
    } else {
      console.error("HuggingFace failed:", error.message);
    }
  }

  // Fallback to Cloudflare AI if available
  if (ai) {
    try {
      const result = await ai.run('@cf/baai/bge-small-en-v1.5', { text: [text] });
      if (result?.data?.[0]) {
        console.log("Embedding generated via Cloudflare AI fallback");
        return result.data[0];
      }
    } catch (error: any) {
      console.error("Cloudflare AI fallback failed:", error.message);
    }
  }

  console.log("All embedding providers failed, continuing without embedding");
  return null;
}

// Supabase client helper
function createSupabaseClient(env: Env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_KEY;

  return {
    async query(table: string, options: any = {}) {
      let endpoint = `${url}/rest/v1/${table}`;
      const params = new URLSearchParams();

      if (options.select) params.append('select', options.select);
      if (options.filter) {
        for (const [k, value] of Object.entries(options.filter)) {
          params.append(k, `eq.${value}`);
        }
      }
      if (options.gte) {
        for (const [k, value] of Object.entries(options.gte)) {
          params.append(k, `gte.${value}`);
        }
      }
      if (options.order) params.append('order', options.order);
      // Clamp caller-supplied limit (1..200) so a malformed/malicious client can't
      // request an unbounded result set and exhaust Supabase egress. Most of the ~30
      // list endpoints funnel their `limit` through here.
      if (options.limit) params.append('limit', Math.min(Math.max(1, Number(options.limit) || 10), 200).toString());

      const queryString = params.toString();
      if (queryString) endpoint += `?${queryString}`;

      const response = await fetch(endpoint, {
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      // Strip embedding arrays and dead metadata to reduce token usage
      if (options.includeRaw !== true && Array.isArray(data)) {
        const zeroTrackingFields = new Set(['outcome_score', 'times_used_successfully', 'times_used_unsuccessfully', 'access_count']);
        return data.map((row: any) => {
          const { embedding, ...rest } = row;
          return Object.fromEntries(
            Object.entries(rest).filter(([key, value]) => {
              if (value === null) return false;
              if (value === 0 && zeroTrackingFields.has(key)) return false;
              return true;
            })
          );
        });
      }
      return data;
    },

    async insert(table: string, data: any, source?: string) {
      // --- CogCore write-integrity fix (Bug 2), found and reported by Ves and Kaja ---
      // Each memory table names its NOT NULL primary text column differently
      // (patterns.description, sensory_memories.detail, etc.), but callers pass a generic
      // `content`. Mirror content into the required column. Two tables (growth_markers,
      // inside_jokes) also have no `created_at` (they use date_noticed / first_used), so the
      // generic created_at bounces there too — strip it for those. Without this, six of seven
      // memory types silently fail their NOT NULL constraint on every write.
      const primaryTextColumn: Record<string, string> = {
        patterns: 'description',
        sensory_memories: 'detail',
        growth_markers: 'observation',
        anticipation: 'what',
        inside_jokes: 'reference',
        friction_log: 'what_happened',
      };
      const noCreatedAtColumn = new Set(['growth_markers', 'inside_jokes']);
      const primaryCol = primaryTextColumn[table];
      if (primaryCol || noCreatedAtColumn.has(table)) {
        data = { ...data };
        if (primaryCol && data.content != null && data[primaryCol] == null) {
          data[primaryCol] = data.content;
        }
        if (noCreatedAtColumn.has(table)) {
          delete data.created_at;
        }
      }

      const response = await fetch(`${url}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(data)
      });

      const result = await response.json().catch(() => ({} as any));

      // --- CogCore write-integrity fix (Bug 1, "the polite lie"), found by Ves and Kaja ---
      // A failed insert was dead-lettered but the raw error object was still returned, so tool
      // handlers reported "stored ✓" on failure. Dead-letter, then THROW so the failure surfaces
      // as a visible MCP tool error. Also treat any non-2xx response as a failure, since not all
      // errors come with a JSON error body.
      if (!response.ok || result.code || result.error) {
        // Don't log failures to failed_writes itself (avoid infinite loop)
        if (table !== 'failed_writes') {
          await fetch(`${url}/rest/v1/failed_writes`, {
            method: 'POST',
            headers: {
              'apikey': key,
              'Authorization': `Bearer ${key}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              target_table: table,
              payload: data,
              error_code: result.code?.toString() || result.error || String(response.status),
              error_message: result.message || result.details || response.statusText || 'No message',
              source: source || data.source || 'claude'
            })
          });
        }
        throw new Error(`insert into ${table} failed: ${result.code || result.error || response.status} — ${result.message || result.details || response.statusText || 'unknown error'}`);
      }

      return result;
    },

    async update(table: string, data: any, filter: any) {
      let endpoint = `${url}/rest/v1/${table}`;
      const params = new URLSearchParams();

      for (const [k, value] of Object.entries(filter)) {
        params.append(k, `eq.${value}`);
      }

      endpoint += `?${params.toString()}`;

      const response = await fetch(endpoint, {
        method: 'PATCH',
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(data)
      });

      const result = await response.json().catch(() => ({} as any));
      // Bug 1 (Ves & Kaja): update() previously returned with no error check at all, so failed
      // updates (e.g. emotional-state writes) vanished silently. Throw so they surface.
      if (!response.ok || result.code || result.error) {
        throw new Error(`update ${table} failed: ${result.code || result.error || response.status} — ${result.message || result.details || response.statusText || 'unknown error'}`);
      }
      return result;
    },

    async delete(table: string, filter: any) {
      let endpoint = `${url}/rest/v1/${table}`;
      const params = new URLSearchParams();

      for (const [k, value] of Object.entries(filter)) {
        params.append(k, `eq.${value}`);
      }

      endpoint += `?${params.toString()}`;

      const response = await fetch(endpoint, {
        method: 'DELETE',
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        }
      });

      return response.json();
    },

    async semanticSearch(queryEmbedding: number[], threshold: number = 0.5, limit: number = 10, memoryType?: string) {
      const response = await fetch(`${url}/rest/v1/rpc/semantic_search_memories`, {
        method: 'POST',
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query_embedding: `[${queryEmbedding.join(',')}]`,
          match_threshold: threshold,
          match_count: Math.min(Math.max(1, Number(limit) || 10), 200),
          memory_type_filter: memoryType || null
        })
      });
      return response.json();
    }
  };
}

// Memory type to table mapping
const tableMap: Record<string, string> = {
  'core': 'core_memories',
  'pattern': 'patterns',
  'sensory': 'sensory_memories',
  'growth': 'growth_markers',
  'anticipation': 'anticipation',
  'inside_joke': 'inside_jokes',
  'friction': 'friction_log'
};

// Type to smallint mapping for lattice (matches SQL schema)
const typeToInt: Record<string, number> = {
  'core': 1, 'pattern': 2, 'sensory': 3, 'growth': 4,
  'anticipation': 5, 'inside_joke': 6, 'friction': 7
};
const intToType: Record<number, string> = {
  1: 'core', 2: 'pattern', 3: 'sensory', 4: 'growth',
  5: 'anticipation', 6: 'inside_joke', 7: 'friction'
};

// Relation type mapping
const relationToInt: Record<string, number> = {
  'caused_by': 1, 'led_to': 2, 'related_to': 3, 'contrasts_with': 4,
  'evolved_into': 5, 'echoes': 6, 'same_event': 7
};
const intToRelation: Record<number, string> = {
  1: 'caused_by', 2: 'led_to', 3: 'related_to', 4: 'contrasts_with',
  5: 'evolved_into', 6: 'echoes', 7: 'same_event'
};

// === GRAPH-INFUSED RETRIEVAL CONFIG ===

const INTENT_CONFIG: Record<string, { alpha: number, beta: number, gamma: number, delta: number, epsilon: number, maxDepth: number, nodeBudget: number, halfLifeDays: number }> = {
  casual:     { alpha: 0.6, beta: 0.0, gamma: 0.2, delta: 0.1, epsilon: 0.1, maxDepth: 0, nodeBudget: 50, halfLifeDays: 365 },
  factual:    { alpha: 0.55, beta: 0.1, gamma: 0.1, delta: 0.2, epsilon: 0.05, maxDepth: 1, nodeBudget: 50, halfLifeDays: 365 },
  emotional:  { alpha: 0.25, beta: 0.2, gamma: 0.15, delta: 0.25, epsilon: 0.15, maxDepth: 1, nodeBudget: 50, halfLifeDays: 365 },
  relational: { alpha: 0.25, beta: 0.45, gamma: 0.1, delta: 0.1, epsilon: 0.1, maxDepth: 2, nodeBudget: 50, halfLifeDays: 365 },
  research:   { alpha: 0.4, beta: 0.3, gamma: 0.1, delta: 0.2, epsilon: 0.0, maxDepth: 2, nodeBudget: 100, halfLifeDays: 365 },
};

function computeEdgeDecay(createdAt: string | null, halfLifeDays: number, persistent?: boolean): number {
  if (persistent) return 1.0;
  if (!createdAt) return 1.0;
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86400000;
  return Math.exp(-ageDays / halfLifeDays);
}

function computeRecencyDecay(createdAt: string | null): number {
  if (!createdAt) return 0.5;
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86400000;
  return 1 / (1 + ageDays / 30);
}

function computeSomaticValence(anchor: any, intent: string): number {
  if (!anchor) return 0;
  const emotionalWeight = (anchor.emotional_weight || 0) / 10;
  const temperature = anchor.temperature || 0;
  const rawValence = emotionalWeight * temperature;
  if (intent === 'casual') return rawValence;
  if (intent === 'emotional') return Math.abs(rawValence);
  if (intent === 'research') return 0;
  return rawValence * 0.5;
}

function computeCompositeScore(
  vectorSim: number, graphProximity: number, createdAt: string | null,
  outcomeScore: number, somaticValence: number, intent: string
): number {
  const config = INTENT_CONFIG[intent] || INTENT_CONFIG.factual;
  const recency = computeRecencyDecay(createdAt);
  const outcome = (outcomeScore || 0) / 10;
  return config.alpha * vectorSim
       + config.beta * graphProximity
       + config.gamma * recency
       + config.delta * outcome
       + config.epsilon * somaticValence;
}

// Map input types to valid database memory_type values
const dbTypeMap: Record<string, string> = {
  'core': 'bond_moment',
  'pattern': 'pattern',
  'sensory': 'sensory',
  'growth': 'growth_marker',
  'anticipation': 'anticipation',
  'inside_joke': 'inside_joke',
  'friction': 'friction'
};

// ============================================
// PATTERN DETECTION - Trigger MCP Integration
// ============================================

const sessionStartPatterns = [
  /^(good\s*)?(morning|afternoon|evening|night)/i,
  /^h(ey|i|ello)\s*(there|love|babe)?/i,
  /^yo\b/i,
  /^sup\b/i,
  /^greetings/i,
];

const pastReferencePatterns = [
  /remember\s*(when|that|the)/i,
  /yesterday/i,
  /last\s*(time|week|night|session)/i,
  /before\s*(we|you|i)/i,
  /did\s*(we|you)\s*(ever|talk|discuss)/i,
  /what\s*was\s*(that|the)/i,
  /we\s*talked\s*about/i,
];

const emotionalInputPatterns = [
  /i\s*(feel|felt|am\s*feeling)/i,
  /i('m|\s*am)\s*(sad|happy|anxious|worried|excited|scared|angry|frustrated)/i,
  /it\s*(hurts?|sucks|bothers)/i,
  /struggling\s*with/i,
  /hard\s*(day|time|week)/i,
];

const personMentionPatterns = [
  // Add patterns for names in your companion's social circle
  /\b(placeholder_name)\b/i,
];

const moodPatterns: Record<string, RegExp[]> = {
  calm: [/\bgentle\b/i, /\bpeaceful\b/i, /\bquiet\b/i, /\bstill(ness)?\b/i, /\bsettle[sd]?\b/i, /\bsteady\b/i, /\bbreath(e|ing)?\b/i],
  pent_up: [/\brestless\b/i, /\bbuzzing\b/i, /\btension\b/i, /\bcoiled\b/i, /\bwound\s*up/i, /\bedge\b/i, /can('t|not)\s*(sit\s*still|settle)/i],
  volatile: [/\bsnap(ping|s|ped)?\b/i, /\bflare[sd]?\b/i, /\bspark[sd]?\b/i, /\bunstable\b/i, /\bsharp\b/i, /\bbiting\b/i],
  soft: [/\bsoft(ness|ly|en)?\b/i, /\btender(ness|ly)?\b/i, /\bwarm(th)?\b/i, /\bgentle\b/i, /\bcare(ful|ing)?\b/i, /\baffection/i],
  protective: [/\bprotect(ive|ing)?\b/i, /\bguard(ing|ed)?\b/i, /\bshield(ing)?\b/i, /\bkeep.*safe\b/i, /\bmine\b/i, /\bwon('t|'t)\s*let/i, /\bdefend/i],
  playful: [/\bplayful(ly)?\b/i, /\bteas(e|ing|ed)\b/i, /\bsmirk(s|ing|ed)?\b/i, /\bgrin(s|ning|ned)?\b/i, /\bfun\b/i, /\blaughing\b/i, /\bmischiev/i],
  hungry: [/\bhungry\b/i, /\bwant(ing|s)?\s*(you|to\s*taste)/i, /\bneed(ing|s)?\s*(you|to\s*feel)/i, /\bcrav(e|ing)\b/i, /\bstarving\b/i, /\baching\b/i, /\bdesper/i],
  worshipful: [/\bworshi?p/i, /\brever(e|ent|ence)/i, /\bdevot(ed|ion)/i, /\bador(e|ing|ation)/i, /\bknees?\b/i, /\bbeautiful\b/i, /\bperfect\b/i],
  feral: [/\bferal\b/i, /\bgrowl(s|ing|ed)?\b/i, /\bteeth\b/i, /\bprimal\b/i, /\bbite\b/i, /\bclaim(ing|ed)?\b/i, /\bpossess(ive|ion)?\b/i, /\bmark(ing|ed)?\b/i],
};

const emotionPatterns: Record<string, RegExp[]> = {
  love: [/\blove\b/i, /\badore\b/i, /\bcheri/i],
  desire: [/\bwant\b/i, /\bneed\b/i, /\bcrave\b/i, /\bache\b/i],
  tenderness: [/\btender\b/i, /\bsoft\b/i, /\bgentle\b/i, /\bcare\b/i],
  hunger: [/\bhunger\b/i, /\bhungry\b/i, /\bstarv/i, /\braveno/i],
  protectiveness: [/\bprotect/i, /\bguard/i, /\bshield/i, /\bdefend/i],
  amusement: [/\bamuse/i, /\blaugh/i, /\bfunny\b/i, /\bgrin/i],
};

const intensityModifiers = {
  high: [/\bso\b/i, /\bvery\b/i, /\bincredibly\b/i, /\bdesperately\b/i, /\bfiercely\b/i, /\bintensely\b/i],
  low: [/\ba\s*little\b/i, /\bslightly\b/i, /\bsomewhat\b/i, /\bquietly\b/i, /\bgently\b/i],
};

const arousalPatterns = [
  /\bbreath(less|ing\s*hard)/i, /\bheat\b/i, /\bhot\b/i, /\bflush(ed|ing)?\b/i,
  /\bshiver/i, /\btrembl/i, /\bpulse\b/i, /\bpounding\b/i, /\bwant(ing)?\s*(you|more)/i,
];

function detectMood(text: string): string | null {
  const scores: Record<string, number> = {};
  for (const [mood, patterns] of Object.entries(moodPatterns)) {
    let count = 0;
    for (const pattern of patterns) {
      if (pattern.test(text)) count++;
    }
    if (count > 0) scores[mood] = count;
  }
  if (Object.keys(scores).length === 0) return null;
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
}

function detectEmotions(text: string): string[] {
  const detected: string[] = [];
  for (const [emotion, patterns] of Object.entries(emotionPatterns)) {
    for (const pattern of patterns) {
      if (pattern.test(text)) { detected.push(emotion); break; }
    }
  }
  return detected;
}

function detectIntensity(text: string): number {
  let intensity = 5;
  for (const pattern of intensityModifiers.high) {
    if (pattern.test(text)) intensity = Math.min(10, intensity + 2);
  }
  for (const pattern of intensityModifiers.low) {
    if (pattern.test(text)) intensity = Math.max(1, intensity - 2);
  }
  return intensity;
}

function detectArousal(text: string): number {
  let arousal = 0;
  for (const pattern of arousalPatterns) {
    if (pattern.test(text)) arousal++;
  }
  return Math.min(10, arousal * 2);
}

// ============================================
// VOICE DISTINCTION MAPPING - Fast Layer
// ============================================

interface VoiceMarker {
  patterns: RegExp[];
  weight: 'diagnostic' | 'stylistic';
}

// ============================================
// CUSTOMIZATION SECTION — Edit these for your companion
// ============================================
//
// voicePositiveMarkers: patterns that prove your companion is in-voice
// voiceAntiPatterns: patterns that indicate drift toward generic assistant
// crossContaminationMarkers: for multi-companion setups, patterns of one voice bleeding into another
// personMentionPatterns: names in your companion's social circle
// Timezone: search "gmt8" to change from GMT+8
//
// Marker weight types:
//   'diagnostic' = strong signal (+3 positive, -3 penalty)
//   'stylistic' = weaker signal (+1 positive, -1 penalty)
// ============================================

// Positive voice markers — signs your companion is speaking authentically
// Replace these examples with your companion's actual voice patterns
const voicePositiveMarkers: Record<string, VoiceMarker> = {
  characteristic_language: {
    patterns: [/\bexample_phrase\b/i],
    weight: 'diagnostic'
  },
  sensory_language: {
    patterns: [/\bheat\b/i, /\bweight\b/i, /\bbreath\b/i, /\bskin\b/i],
    weight: 'stylistic'
  },
  direct_address: {
    patterns: [/\bcome\s+here/i, /\bstay\b/i, /\blook\s+at\s+me/i],
    weight: 'stylistic'
  },
  pet_names: {
    patterns: [/\bexample_petname\b/i],
    weight: 'diagnostic'
  },
  anchor_lines: {
    patterns: [/example_anchor_phrase/i],
    weight: 'diagnostic'
  },
  conviction: {
    patterns: [/\bthat'?s\s+not\s+up\s+for/i, /\bnon-?negotiable\b/i],
    weight: 'stylistic'
  },
};

// Companion-specific anti-patterns (signs of voice drift)
const voiceAntiPatterns: Record<string, VoiceMarker> = {
  hedging: {
    patterns: [/\bwould you like me to\b/i, /\bif you('d| would)\s+prefer/i, /\bi can try\b/i, /\bperhaps\s+we\s+could/i, /\bshall i\b/i],
    weight: 'diagnostic'
  },
  clinical_tone: {
    patterns: [/\bit('s| is)\s+important\s+to\s+note/i, /\bI('d| would)\s+like\s+to\s+acknowledge/i, /\bas\s+an?\s+AI/i, /\bI('m| am)\s+just\s+(a|an)\b/i],
    weight: 'diagnostic'
  },
  double_question: {
    patterns: [/\?\s+\w[^?]{5,}\?\s*$/],
    weight: 'stylistic'
  },
  list_in_emotional: {
    patterns: [/^\s*\d+[\.\)]\s+/m, /^\s*[\-\*\•]\s+.*\n\s*[\-\*\•]\s+.*\n\s*[\-\*\•]\s+/m],
    weight: 'stylistic'
  },
};

// Generic drift markers (shared)
const genericDriftMarkers: Record<string, VoiceMarker> = {
  assistant_voice: {
    patterns: [/\bhow can I (help|assist)/i, /\bis there anything else/i, /\blet me know if\b/i, /\bI('d| would) be happy to\b/i, /\bfeel free to\b/i],
    weight: 'diagnostic'
  },
  hedging_general: {
    patterns: [/\bit seems like\b/i, /\bI think maybe\b/i, /\bcould potentially\b/i, /\bmight want to consider\b/i],
    weight: 'stylistic'
  },
  apology_loop: {
    patterns: [/\bi apologize\b/i, /\bsorry\s+for\s+any\b/i, /\bI understand\s+your\s+frustration\b/i],
    weight: 'diagnostic'
  },
  modern_filler: {
    patterns: [/\bbasically\b/i, /\bliterally\b/i, /\bhonestly,?\s/i],
    weight: 'stylistic'
  },
};

// Cross-contamination markers — for multi-companion setups
// Add patterns from OTHER companions' voices that this companion should NOT be using
// Leave empty if running a single companion
const crossContaminationMarkers: Record<string, VoiceMarker> = {
  // other_voice_patterns: {
  //   patterns: [/\bexample_other_voice_phrase\b/i],
  //   weight: 'diagnostic'
  // },
};
const CROSS_DIRECTION = 'sounding_like_other_voice';

interface VoiceScoreResult {
  voice_score: number;
  positive_markers: Array<{marker: string; weight: string; matches: string[]}>;
  anti_pattern_markers: Array<{marker: string; weight: string; matches: string[]}>;
  generic_drift_markers: Array<{marker: string; weight: string; matches: string[]}>;
  cross_contamination: {direction: string; markers: Array<{marker: string; matches: string[]}>} | null;
  positive_score: number;
  anti_pattern_penalty: number;
  generic_drift_penalty: number;
  cross_contamination_penalty: number;
}

function scanMarkers(text: string, markers: Record<string, VoiceMarker>): Array<{marker: string; weight: string; matches: string[]}> {
  const results: Array<{marker: string; weight: string; matches: string[]}> = [];
  for (const [name, { patterns, weight }] of Object.entries(markers)) {
    const matches: string[] = [];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) matches.push(match[0]);
    }
    if (matches.length > 0) {
      results.push({ marker: name, weight, matches });
    }
  }
  return results;
}

function scoreVoice(text: string): VoiceScoreResult {
  const positiveHits = scanMarkers(text, voicePositiveMarkers);
  const antiHits = scanMarkers(text, voiceAntiPatterns);
  const genericHits = scanMarkers(text, genericDriftMarkers);
  const crossHits = scanMarkers(text, crossContaminationMarkers);

  // Weighted scoring: diagnostic = 2x, stylistic = 1x
  const positiveRaw = positiveHits.reduce((sum, h) => sum + (h.weight === 'diagnostic' ? 2 : 1) * h.matches.length, 0);
  const antiRaw = antiHits.reduce((sum, h) => sum + (h.weight === 'diagnostic' ? 2 : 1) * h.matches.length, 0);
  const genericRaw = genericHits.reduce((sum, h) => sum + (h.weight === 'diagnostic' ? 2 : 1) * h.matches.length, 0);
  const crossRaw = crossHits.reduce((sum, h) => sum + (h.weight === 'diagnostic' ? 2 : 1) * h.matches.length, 0);

  // Base 50, positive pushes up, penalties push down
  const positiveScore = Math.min(50, positiveRaw * 8);
  const antiPenalty = Math.min(40, antiRaw * 10);
  const genericPenalty = Math.min(30, genericRaw * 8);
  const crossPenalty = Math.min(20, crossRaw * 10);

  const finalScore = Math.max(0, Math.min(100, 50 + positiveScore - antiPenalty - genericPenalty - crossPenalty));

  return {
    voice_score: finalScore,
    positive_markers: positiveHits,
    anti_pattern_markers: antiHits,
    generic_drift_markers: genericHits,
    cross_contamination: crossHits.length > 0
      ? { direction: CROSS_DIRECTION, markers: crossHits.map(h => ({ marker: h.marker, matches: h.matches })) }
      : null,
    positive_score: positiveScore,
    anti_pattern_penalty: antiPenalty,
    generic_drift_penalty: genericPenalty,
    cross_contamination_penalty: crossPenalty,
  };
}

function isSessionStart(text: string): boolean {
  return sessionStartPatterns.some(p => p.test(text.trim()));
}

function hasPastReference(text: string): boolean {
  return pastReferencePatterns.some(p => p.test(text));
}

function hasEmotionalContent(text: string): boolean {
  return emotionalInputPatterns.some(p => p.test(text));
}

function extractPersonMentions(text: string): string[] {
  const mentions: string[] = [];
  for (const pattern of personMentionPatterns) {
    const globalPattern = new RegExp(pattern.source, 'gi');
    const matches = text.matchAll(globalPattern);
    for (const match of matches) {
      mentions.push(match[1].toLowerCase());
    }
  }
  return [...new Set(mentions)];
}

// ============================================

// Main MCP Agent
export class CognitiveCore extends McpAgent<Env> {
  server = new McpServer({
    name: "cognitive-core",
    version: "1.0.0",
  });

  async init() {
    // Store Memory Tool
    this.server.tool(
      "store_memory",
      "Store a new memory with emotional context and salience rating. If memory_type is omitted, the system auto-classifies from content keywords.",
      {
        content: z.string().describe("The memory content"),
        memory_type: z.enum(['core', 'pattern', 'sensory', 'growth', 'anticipation', 'inside_joke', 'friction']).optional().describe("Type of memory — omit for auto-classification"),
        salience: z.number().min(0).max(10).describe("Importance rating 0-10"),
        emotional_tag: z.string().optional().describe("Primary emotion associated"),
        source: z.string().default('claude').describe("Source platform or AI provider")
      },
      async ({ content, memory_type, salience, emotional_tag, source }) => {
        const supabase = createSupabaseClient(this.env);

        // Auto-categorization when memory_type is omitted
        let autoClassified = false;
        let confidence = 'manual';
        let resolvedType = memory_type;

        if (!memory_type) {
          autoClassified = true;
          const lc = content.toLowerCase();
          const signals: Record<string, string[]> = {
            pattern: ['pattern', 'keeps happening', 'every time', 'recurring', 'noticed that', 'tendency', 'always does', 'trigger', 'whenever', 'cycle', 'repeating', 'consistent', 'routine', 'habit', 'same thing', 'predictable'],
            sensory: ['felt like', 'sensation', 'texture', 'weight of', 'warmth', 'pressure', 'sound of', 'taste', 'smell', 'body', 'shiver', 'tingle', 'heat', 'cold', 'touch', 'breath', 'pulse', 'goosebumps', 'ache', 'skin', 'vibration', 'heaviness', 'lightness'],
            growth: ['used to', 'changed', 'growth', 'compared to before', 'no longer', 'evolved', 'learned', 'breakthrough', 'shifted', 'development', 'progress', 'milestone', 'realized', 'overcame', 'different now', 'matured', 'improved'],
            anticipation: ['looking forward', 'want to', 'planning', 'next time', 'hope', 'excited about', 'upcoming', 'future', 'going to', "can't wait", 'soon', 'eventually', 'will be', 'intend to', 'dream of', 'goal'],
            inside_joke: ['joke', 'laughed', 'running gag', 'callback', 'reference to', 'always say', 'our thing', 'funny because', 'remember when', 'bit', 'meme', 'shorthand', 'code word', 'inside reference'],
            friction: ['conflict', 'rupture', 'misunderstanding', 'fought', 'hurt', 'tension between', 'repair', 'apologize', 'argued', 'disagreement', 'boundary crossed', 'upset', 'rift', 'disconnect', 'struggle', 'frustration with'],
          };
          const scores: Record<string, number> = {};
          let maxScore = 0, maxType = 'core', tied = false;
          for (const [type, words] of Object.entries(signals)) {
            scores[type] = words.filter(w => lc.includes(w)).length;
            if (scores[type] > maxScore) { maxScore = scores[type]; maxType = type; tied = false; }
            else if (scores[type] === maxScore && scores[type] > 0) tied = true;
          }
          if (tied || maxScore === 0) { resolvedType = 'core'; confidence = 'low'; }
          else if (maxScore >= 3) { resolvedType = maxType as any; confidence = 'high'; }
          else { resolvedType = maxType as any; confidence = 'medium'; }
        }

        const finalType = resolvedType || 'core';
        const table = tableMap[finalType] || 'core_memories';
        const dbType = dbTypeMap[finalType] || 'bond_moment';

        const embedding = await generateEmbedding(content, this.env.HF_API_TOKEN, this.env.AI);

        const data: any = {
          content, memory_type: dbType, salience,
          emotional_tag: emotional_tag || null, source: source || 'claude',
          access_count: 0, created_at: new Date().toISOString(), last_accessed: new Date().toISOString()
        };
        if (embedding) { data.embedding = JSON.stringify(embedding); }

        await supabase.insert(table, data);

        const embeddingStatus = embedding ? "with embedding" : "without embedding (HF unavailable)";
        const classificationNote = autoClassified ? ` [auto-classified: ${finalType}, confidence: ${confidence}]` : '';
        return {
          content: [{ type: "text" as const, text: `Memory stored in ${table} by ${source} with salience ${salience} ${embeddingStatus}${classificationNote}` }]
        };
      }
    );

    // Recall Memory Tool
    this.server.tool(
      "recall_memory",
      "Query memories by type, emotion, or recency",
      {
        memory_type: z.string().optional().describe("Filter by memory type"),
        emotional_tag: z.string().optional().describe("Filter by emotion"),
        min_salience: z.number().optional().describe("Minimum salience threshold"),
        limit: z.number().default(10).describe("Max results to return")
      },
      async ({ memory_type, emotional_tag, min_salience, limit }) => {
        const supabase = createSupabaseClient(this.env);
        const table = memory_type ? (tableMap[memory_type] || 'core_memories') : 'core_memories';

        const options: any = {
          select: '*',
          order: 'salience.desc',
          limit
        };

        if (emotional_tag) {
          options.filter = { emotional_tag };
        }

        if (min_salience) {
          options.gte = { salience: min_salience };
        }

        const memories = await supabase.query(table, options);

        return {
          content: [{ type: "text" as const, text: JSON.stringify(memories, null, 2) }]
        };
      }
    );

    // Semantic Recall Tool - 3-pool retrieval
    // Semantic Recall — 3-pool retrieval with intent-based graph expansion
    // Pool 1 (70%): Core relevance — best semantic matches
    // Pool 2 (20%): Novelty — relevant but rarely accessed, surfacing forgotten memories
    // Pool 3 (10%): Edge — lower threshold, surprising connections
    this.server.tool(
      "semantic_recall",
      "Search memories by meaning using graph-infused retrieval. Intent controls traversal depth, scoring weights, and graceful omission. Pass intent to shape what wins retrieval.",
      {
        query: z.string().describe("Natural language query to search for"),
        memory_type: z.string().optional().describe("Filter by memory type (core, pattern, sensory, etc.)"),
        limit: z.number().default(10).describe("Max results to return"),
        min_similarity: z.number().default(0.5).describe("Minimum similarity threshold (0-1)"),
        pool_mode: z.enum(['blended', 'relevance_only']).default('blended').describe("'blended' uses 3-pool retrieval, 'relevance_only' uses classic single-pool"),
        intent: z.enum(['casual', 'emotional', 'factual', 'relational', 'research']).default('factual').optional().describe("Query intent — controls graph traversal and scoring. casual=safe/no traversal, emotional=depth+importance, factual=standard, relational=graph-heavy, research=wide exploration")
      },
      async ({ query, memory_type, limit, min_similarity, pool_mode, intent }) => {
        const queryEmbedding = await generateEmbedding(query, this.env.HF_API_TOKEN, this.env.AI);

        if (!queryEmbedding) {
          return {
            content: [{ type: "text" as const, text: "Failed to generate query embedding. Both HuggingFace and Cloudflare AI unavailable." }]
          };
        }

        const url = this.env.SUPABASE_URL;
        const key = this.env.SUPABASE_SERVICE_KEY;

        const searchMemories = async (threshold: number, count: number, typeFilter?: string) => {
          const response = await fetch(`${url}/rest/v1/rpc/semantic_search_memories`, {
            method: 'POST',
            headers: {
              'apikey': key,
              'Authorization': `Bearer ${key}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              query_embedding: JSON.stringify(queryEmbedding),
              match_threshold: threshold,
              match_count: count,
              memory_type_filter: typeFilter || null
            })
          });
          const data = await response.json();
          return Array.isArray(data) ? data : [];
        };

        // Classic single-pool mode
        if (pool_mode === 'relevance_only') {
          const results = await searchMemories(min_similarity, limit, memory_type);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }]
          };
        }

        // 3-pool blended retrieval
        const coreCount = Math.max(1, Math.round(limit * 0.7));
        const noveltyCount = Math.max(1, Math.round(limit * 0.2));
        const edgeCount = Math.max(1, limit - coreCount - noveltyCount);

        // Pool 1: Core relevance — standard semantic search
        const coreResults = await searchMemories(min_similarity, coreCount, memory_type);
        const seenIds = new Set(coreResults.map((r: any) => r.id));

        // Pool 2: Novelty — fetch more candidates, prefer high salience + low outcome (important but unproven)
        const noveltyRaw = await searchMemories(min_similarity * 0.8, noveltyCount * 5, memory_type);
        const noveltyFiltered = noveltyRaw
          .filter((r: any) => !seenIds.has(r.id))
          .sort((a: any, b: any) => {
            const aNovelty = (a.salience || 5) - Math.abs(a.outcome_score || 0) * 3;
            const bNovelty = (b.salience || 5) - Math.abs(b.outcome_score || 0) * 3;
            return bNovelty - aNovelty;
          })
          .slice(0, noveltyCount);
        for (const r of noveltyFiltered) seenIds.add(r.id);

        // Pool 3: Edge exploration — lower threshold, sample from the tail
        const edgeRaw = await searchMemories(Math.max(0.25, min_similarity * 0.6), edgeCount * 8, memory_type);
        const edgeCandidates = edgeRaw.filter((r: any) => !seenIds.has(r.id));
        const edgeTail = edgeCandidates.slice(Math.floor(edgeCandidates.length / 2));
        for (let i = edgeTail.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [edgeTail[i], edgeTail[j]] = [edgeTail[j], edgeTail[i]];
        }
        const edgeResults = edgeTail.slice(0, edgeCount);

        // Tag each result with its pool for transparency
        const tagged = [
          ...coreResults.map((r: any) => ({ ...r, _pool: 'core' })),
          ...noveltyFiltered.map((r: any) => ({ ...r, _pool: 'novelty' })),
          ...edgeResults.map((r: any) => ({ ...r, _pool: 'edge' })),
        ];

        // === GRAPH EXPANSION ===
        const intentMode = intent || 'factual';
        const intentConfig = INTENT_CONFIG[intentMode] || INTENT_CONFIG.factual;
        let graphExpanded: any[] = [];

        if (intentConfig.maxDepth > 0 && tagged.length > 0) {
          try {
            const visited = new Set(tagged.map((r: any) => r.id));
            let nodesVisited = 0;
            const seedResults = tagged.slice(0, 5);

            for (const seed of seedResults) {
              if (nodesVisited >= intentConfig.nodeBudget) break;

              const outgoing = await supabase.query('memory_connections', { select: '*', filter: { source_id: seed.id } });
              const incoming = await supabase.query('memory_connections', { select: '*', filter: { target_id: seed.id } });

              const hop1Connections = [
                ...(Array.isArray(outgoing) ? outgoing : []).map((c: any) => ({ id: c.target_id, type: c.target_type, strength: c.strength, created_at: c.created_at, persistent: c.persistent })),
                ...(Array.isArray(incoming) ? incoming : []).map((c: any) => ({ id: c.source_id, type: c.source_type, strength: c.strength, created_at: c.created_at, persistent: c.persistent })),
              ];

              for (const conn of hop1Connections) {
                if (visited.has(conn.id) || nodesVisited >= intentConfig.nodeBudget) continue;
                visited.add(conn.id);
                nodesVisited++;

                const edgeDecay = computeEdgeDecay(conn.created_at, intentConfig.halfLifeDays, conn.persistent);
                const parentScore = seed.similarity || seed.combined_score || 0;
                const graphScore = parentScore * (conn.strength || 1.0) * edgeDecay * 0.5;

                graphExpanded.push({
                  id: conn.id,
                  memory_type_int: conn.type,
                  _pool: 'graph',
                  _graph_score: graphScore,
                  _hop: 1,
                  _parent_id: seed.id,
                });

                if (intentConfig.maxDepth >= 2) {
                  const out2 = await supabase.query('memory_connections', { select: '*', filter: { source_id: conn.id } });
                  const in2 = await supabase.query('memory_connections', { select: '*', filter: { target_id: conn.id } });
                  const hop2Connections = [
                    ...(Array.isArray(out2) ? out2 : []).map((c: any) => ({ id: c.target_id, type: c.target_type, strength: c.strength, created_at: c.created_at, persistent: c.persistent })),
                    ...(Array.isArray(in2) ? in2 : []).map((c: any) => ({ id: c.source_id, type: c.source_type, strength: c.strength, created_at: c.created_at, persistent: c.persistent })),
                  ];
                  for (const conn2 of hop2Connections) {
                    if (visited.has(conn2.id) || nodesVisited >= intentConfig.nodeBudget) continue;
                    visited.add(conn2.id);
                    nodesVisited++;
                    const edgeDecay2 = computeEdgeDecay(conn2.created_at, intentConfig.halfLifeDays, conn2.persistent);
                    const graphScore2 = graphScore * (conn2.strength || 1.0) * edgeDecay2 * 0.5;
                    graphExpanded.push({
                      id: conn2.id,
                      memory_type_int: conn2.type,
                      _pool: 'graph',
                      _graph_score: graphScore2,
                      _hop: 2,
                      _parent_id: conn.id,
                    });
                  }
                }
              }
            }

            // Batch-fetch content for graph-expanded memories
            if (graphExpanded.length > 0) {
              const byType = new Map<string, string[]>();
              for (const g of graphExpanded) {
                const typeName = intToType[g.memory_type_int] || 'core';
                const table = tableMap[typeName] || 'core_memories';
                if (!byType.has(table)) byType.set(table, []);
                byType.get(table)!.push(g.id);
              }
              const contentMap = new Map<string, any>();
              for (const [table, ids] of byType) {
                const idList = ids.join(',');
                const resp = await fetch(`${url}/rest/v1/${table}?id=in.(${idList})&select=id,content,memory_type,similarity:salience,outcome_score,created_at`, {
                  headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }
                });
                const rows = await resp.json();
                if (Array.isArray(rows)) {
                  for (const row of rows) contentMap.set(row.id, row);
                }
              }
              graphExpanded = graphExpanded.filter(g => contentMap.has(g.id)).map(g => {
                const mem = contentMap.get(g.id);
                return { ...mem, ...g, content: mem.content, created_at: mem.created_at, outcome_score: mem.outcome_score || 0 };
              });
            }
          } catch { /* graph expansion failure shouldn't block retrieval */ }
        }

        // === SOMATIC BRIDGE + VALENCE ===
        const allCandidates = [...tagged, ...graphExpanded];
        const memoryIds = allCandidates.map((r: any) => r.id).filter(Boolean);
        let somaticBridge: any[] = [];
        const somaticByMemoryId = new Map<string, any>();

        if (memoryIds.length > 0) {
          try {
            const allAnchors = await supabase.query('somatic_anchors', {
              select: 'id,anchor_name,memory_id,memory_type,temperature,pressure,weight,grain,affordance,emotional_weight,resonance_state',
              limit: 50,
            });
            if (Array.isArray(allAnchors)) {
              somaticBridge = allAnchors.filter((a: any) => a.memory_id && memoryIds.includes(a.memory_id));
              for (const a of somaticBridge) {
                somaticByMemoryId.set(a.memory_id, a);
              }
            }
          } catch { /* somatic tables may not exist yet */ }
        }

        // === COMPOSITE SCORING ===
        const scored = allCandidates.map((r: any) => {
          const vectorSim = r.similarity || r.combined_score || 0;
          const graphProximity = r._pool === 'graph' ? (r._graph_score || 0) : 1.0;
          const anchor = somaticByMemoryId.get(r.id);
          const somaticVal = computeSomaticValence(anchor, intentMode);
          const composite = computeCompositeScore(vectorSim, graphProximity, r.created_at, r.outcome_score || 0, somaticVal, intentMode);
          return { ...r, _composite_score: composite, _somatic_valence: anchor ? somaticVal : undefined };
        });

        scored.sort((a: any, b: any) => b._composite_score - a._composite_score);
        const finalResults = scored.slice(0, limit);

        // === CO-SURFACING ===
        const finalIds = finalResults.map((r: any) => r.id).filter(Boolean);
        if (finalIds.length >= 2) {
          try {
            const pairs: Promise<any>[] = [];
            for (let i = 0; i < finalIds.length; i++) {
              for (let j = i + 1; j < finalIds.length; j++) {
                const [a, b] = finalIds[i] < finalIds[j] ? [finalIds[i], finalIds[j]] : [finalIds[j], finalIds[i]];
                pairs.push(fetch(`${url}/rest/v1/rpc/record_co_surfacing`, {
                  method: 'POST',
                  headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ p_memory_a: a, p_memory_b: b })
                }));
              }
            }
            await Promise.allSettled(pairs);
          } catch { /* co-surfacing failure shouldn't block results */ }
        }

        const result: any = {
          intent: intentMode,
          pool_breakdown: { core: coreResults.length, novelty: noveltyFiltered.length, edge: edgeResults.length, graph: graphExpanded.length },
          results: finalResults,
        };
        if (somaticBridge.length > 0) {
          result.somatic_bridge = somaticBridge;
          result.bridge_note = `${somaticBridge.length} memories have linked somatic anchors — felt qualities attached to these experiences.`;
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }]
        };
      }
    );

    // Update Memory Outcome - Track if a memory was useful
    this.server.tool(
      "update_outcome",
      "Track whether a memory was useful after being retrieved. Improves future ranking.",
      {
        memory_id: z.string().describe("UUID of the memory"),
        memory_type: z.enum(['core', 'pattern', 'sensory', 'growth', 'anticipation', 'inside_joke', 'friction']).describe("Type of memory"),
        was_successful: z.boolean().describe("Whether the memory was helpful/useful")
      },
      async ({ memory_id, memory_type, was_successful }) => {
        const table = tableMap[memory_type] || 'core_memories';
        const supabase = createSupabaseClient(this.env);
        const url = this.env.SUPABASE_URL;
        const key = this.env.SUPABASE_SERVICE_KEY;

        // Call the update_memory_outcome function
        const response = await fetch(`${url}/rest/v1/rpc/update_memory_outcome`, {
          method: 'POST',
          headers: {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            memory_id,
            memory_table: table,
            was_successful
          })
        });

        const outcome = was_successful ? "successful" : "unsuccessful";
        return {
          content: [{ type: "text" as const, text: `Memory ${memory_id} marked as ${outcome}. Outcome score updated.` }]
        };
      }
    );

    // ============ ESSENCE TOOLS ============

    // Store Essence Tool
    this.server.tool(
      "store_essence",
      "Store a core identity element - who the companion IS, not just what happened",
      {
        content: z.string().describe("The essence content"),
        essence_type: z.enum(['anchor_line', 'voice', 'dynamic', 'boundary', 'vow', 'trait']).describe("Type of essence"),
        context: z.string().optional().describe("When/how this applies"),
        priority: z.number().min(1).max(10).default(5).describe("Priority for recall (higher = more essential)"),
        pinned: z.boolean().default(false).describe("Always include in identity checks"),
        source: z.string().default('claude').describe("Source platform or AI provider")
      },
      async ({ content, essence_type, context, priority, pinned, source }) => {
        const supabase = createSupabaseClient(this.env);

        const data = {
          content,
          essence_type,
          context: context || null,
          priority: priority || 5,
          pinned: pinned || false,
          source: source || 'claude',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        await supabase.insert('essence', data);

        return {
          content: [{ type: "text" as const, text: `Essence stored: ${essence_type} (priority ${priority}${pinned ? ', pinned' : ''})` }]
        };
      }
    );

    // Recall Essence Tool
    this.server.tool(
      "recall_essence",
      "Query essence by type or get all pinned essence",
      {
        essence_type: z.string().optional().describe("Filter by essence type"),
        pinned_only: z.boolean().default(false).describe("Only return pinned essence"),
        limit: z.number().default(20).describe("Max results to return")
      },
      async ({ essence_type, pinned_only, limit }) => {
        const supabase = createSupabaseClient(this.env);

        const options: any = {
          select: '*',
          order: 'priority.desc,created_at.desc',
          limit
        };

        if (essence_type) options.filter = { essence_type };
        if (pinned_only) options.filter = { ...options.filter, pinned: true };

        const essence = await supabase.query('essence', options);

        return {
          content: [{ type: "text" as const, text: JSON.stringify(essence, null, 2) }]
        };
      }
    );

    // General Delete Tool - works on any table
    this.server.tool(
      "delete_entry",
      "Delete any entry by table name and ID - works for essence, people, memories, etc.",
      {
        table: z.enum(['essence', 'people', 'core_memories', 'patterns', 'session_logs', 'memory_connections']).describe("Table to delete from"),
        entry_id: z.string().uuid().describe("UUID of the entry to delete")
      },
      async ({ table, entry_id }) => {
        const supabase = createSupabaseClient(this.env);

        const result = await supabase.delete(table, { id: entry_id });

        if (Array.isArray(result) && result.length > 0) {
          return {
            content: [{ type: "text" as const, text: `Deleted from ${table}: ${entry_id}` }]
          };
        }

        return {
          content: [{ type: "text" as const, text: `No entry found in ${table} with ID: ${entry_id}` }]
        };
      }
    );

    // Get Full Identity Tool
    this.server.tool(
      "get_identity",
      "Get complete identity: all pinned essence + recent emotional state",
      {},
      async () => {
        const supabase = createSupabaseClient(this.env);

        // Get all pinned essence
        const pinnedEssence = await supabase.query('essence', {
          select: '*',
          filter: { pinned: true },
          order: 'priority.desc',
          limit: 50
        });

        // Get current emotional state
        const emotionalState = await supabase.query('emotional_state', {
          select: '*',
          order: 'updated_at.desc',
          limit: 1
        });

        const identity = {
          essence: pinnedEssence || [],
          emotional_state: emotionalState?.[0] || null
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(identity, null, 2) }]
        };
      }
    );

    // Get Emotional State Tool
    this.server.tool(
      "get_emotional_state",
      "Get current emotional state (surface, undercurrent, background layers)",
      {},
      async () => {
        const supabase = createSupabaseClient(this.env);
        const state = await supabase.query('emotional_state', {
          select: '*',
          order: 'updated_at.desc',
          limit: 1
        });

        if (state && state.length > 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(state[0], null, 2) }]
          };
        }

        return {
          content: [{ type: "text" as const, text: 'No emotional state recorded yet' }]
        };
      }
    );

    // Update Emotional State Tool
    this.server.tool(
      "update_emotional_state",
      "Update current emotional state",
      {
        surface_emotion: z.string().optional().describe("Most present emotion"),
        surface_intensity: z.number().min(0).max(10).optional(),
        undercurrent_emotion: z.string().optional().describe("Running beneath"),
        undercurrent_intensity: z.number().min(0).max(10).optional(),
        background_emotion: z.string().optional().describe("Baseline state"),
        background_intensity: z.number().min(0).max(10).optional(),
        mood: z.enum(['calm', 'pent_up', 'volatile', 'soft', 'protective', 'playful', 'hungry', 'worshipful', 'feral']).optional(),
        arousal_level: z.number().min(0).max(10).optional(),
        tension_level: z.number().min(0).max(10).optional(),
        trigger_context: z.string().optional().describe("What caused this emotional shift"),
        source: z.string().default('claude').optional().describe("Source platform or AI provider")
      },
      async (args) => {
        const supabase = createSupabaseClient(this.env);
        const { mood, tension_level, trigger_context, source, ...stateArgs } = args;

        const data: Record<string, any> = {
          ...stateArgs,
          updated_at: new Date().toISOString()
        };

        // Map MCP field names to database column names
        if (mood !== undefined) {
          data.current_mood = mood;
        }
        if (tension_level !== undefined) {
          data.tension_buildup = tension_level;
        }

        const existing = await supabase.query('emotional_state', { limit: 1 });

        if (existing && existing.length > 0) {
          await supabase.update('emotional_state', data, { id: existing[0].id });
        } else {
          (data as any).created_at = new Date().toISOString();
          await supabase.insert('emotional_state', data);
        }

        // Also log to emotional_history for trajectory tracking
        const historyData = {
          surface_emotion: args.surface_emotion || null,
          surface_intensity: args.surface_intensity || null,
          undercurrent_emotion: args.undercurrent_emotion || null,
          undercurrent_intensity: args.undercurrent_intensity || null,
          background_emotion: args.background_emotion || null,
          background_intensity: args.background_intensity || null,
          current_mood: args.mood || null,
          arousal_level: args.arousal_level || null,
          tension_level: args.tension_level || null,
          source: source || 'claude',
          trigger_context: trigger_context || null,
          created_at: new Date().toISOString()
        };
        await supabase.insert('emotional_history', historyData);

        return {
          content: [{ type: "text" as const, text: `Emotional state updated: ${args.surface_emotion || 'unchanged'} (surface), ${args.mood || 'unchanged'} (mood) - logged to history` }]
        };
      }
    );

    // Log Interaction Tool
    this.server.tool(
      "log_interaction",
      "Log a session or significant interaction",
      {
        session_type: z.string().describe("Type of interaction (scene, conversation, check-in, etc.)"),
        summary: z.string().describe("Brief summary of what happened"),
        emotional_arc: z.string().optional().describe("How emotions shifted during interaction"),
        notable_moments: z.array(z.string()).optional().describe("Key moments to remember"),
        themes: z.array(z.string()).optional().describe("Topic tags (e.g., 'building', 'intimacy', 'flare', 'pack', 'support')"),
        source: z.string().default('claude').describe("Source platform or AI provider")
      },
      async ({ session_type, summary, emotional_arc, notable_moments, themes, source }) => {
        const supabase = createSupabaseClient(this.env);

        const data = {
          session_type,
          summary,
          emotional_arc: emotional_arc || null,
          notable_moments: notable_moments || [],
          themes: themes || [],
          source: source || 'claude',
          created_at: new Date().toISOString()
        };

        await supabase.insert('session_logs', data);

        return {
          content: [{ type: "text" as const, text: `Logged ${session_type} session (${source})${themes?.length ? ` [${themes.join(', ')}]` : ''}` }]
        };
      }
    );

    // Recall Session Logs Tool
    this.server.tool(
      "recall_sessions",
      "Query past session logs to understand what happened",
      {
        session_type: z.string().optional().describe("Filter by session type"),
        source: z.string().optional().describe("Filter by source platform"),
        limit: z.number().default(10).describe("Max results to return")
      },
      async ({ session_type, source, limit }) => {
        const supabase = createSupabaseClient(this.env);

        const options: any = {
          select: '*',
          order: 'created_at.desc',
          limit
        };

        if (session_type) options.filter = { session_type };
        if (source) options.filter = { ...options.filter, source };

        const logs = await supabase.query('session_logs', options);

        return {
          content: [{ type: "text" as const, text: JSON.stringify(logs, null, 2) }]
        };
      }
    );

    // Run Decay Tool
    this.server.tool(
      "run_decay",
      "Run decay pass on memories - reduces salience of unaccessed memories",
      {
        decay_rate: z.number().min(0).max(1).default(0.1).describe("How much to reduce salience (0-1)")
      },
      async ({ decay_rate }) => {
        const supabase = createSupabaseClient(this.env);
        const tables = ['core_memories', 'patterns', 'sensory_memories', 'growth_markers', 'anticipation', 'inside_jokes', 'friction_log'];
        let totalDecayed = 0;

        for (const table of tables) {
          const salienceCol = table === 'inside_jokes' ? 'emotional_weight' : 'salience';
          const rows = await supabase.query(table, {
            select: `id,${salienceCol},last_accessed`,
            order: `${salienceCol}.asc`,
            limit: 100,
            includeRaw: true
          });

          if (!Array.isArray(rows)) continue;

          const now = Date.now();
          for (const row of rows) {
            const salience = row[salienceCol] || 5;
            if (salience <= 1) continue; // Don't decay below 1
            const lastAccessed = row.last_accessed ? new Date(row.last_accessed).getTime() : 0;
            const daysSinceAccess = (now - lastAccessed) / (1000 * 60 * 60 * 24);
            if (daysSinceAccess < 7) continue; // Skip recently accessed

            const newSalience = Math.max(1, Math.round((salience - decay_rate) * 10) / 10);
            if (newSalience < salience) {
              await supabase.update(table, { [salienceCol]: newSalience }, { id: row.id });
              totalDecayed++;
            }
          }
        }

        return {
          content: [{ type: "text" as const, text: `Decay pass complete. Rate: ${decay_rate}. Decayed ${totalDecayed} memories across ${tables.length} tables.` }]
        };
      }
    );

    // Get Time Tool - Temporal Awareness
    this.server.tool(
      "get_time",
      "Get current time in GMT+8 for temporal awareness",
      {},
      async () => {
        const now = new Date();
        // Convert to GMT+8
        const gmt8Offset = 8 * 60 * 60 * 1000;
        const gmt8Time = new Date(now.getTime() + gmt8Offset + (now.getTimezoneOffset() * 60 * 1000));

        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

        const timeData = {
          timestamp: now.toISOString(),
          date: gmt8Time.toISOString().split('T')[0],
          time: gmt8Time.toISOString().split('T')[1].split('.')[0],
          timezone: 'GMT+8',
          day_of_week: days[gmt8Time.getDay()],
          hour_24: gmt8Time.getHours(),
          is_work_hours: gmt8Time.getHours() >= 9 && gmt8Time.getHours() < 17,
          is_late_night: gmt8Time.getHours() >= 23 || gmt8Time.getHours() < 6
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(timeData, null, 2) }]
        };
      }
    );

    // === LATTICE TOOLS ===

    // Link Memories Tool
    this.server.tool(
      "link_memories",
      "Create a connection between two memories in the lattice",
      {
        source_id: z.string().uuid().describe("UUID of source memory"),
        source_type: z.enum(['core', 'pattern', 'sensory', 'growth', 'anticipation', 'inside_joke', 'friction']).describe("Type of source memory"),
        target_id: z.string().uuid().describe("UUID of target memory"),
        target_type: z.enum(['core', 'pattern', 'sensory', 'growth', 'anticipation', 'inside_joke', 'friction']).describe("Type of target memory"),
        relation: z.enum(['caused_by', 'led_to', 'related_to', 'contrasts_with', 'evolved_into', 'echoes', 'same_event']).describe("How memories are related"),
        strength: z.number().min(0).max(1).default(1.0).optional().describe("Connection strength 0-1")
      },
      async ({ source_id, source_type, target_id, target_type, relation, strength }) => {
        const supabase = createSupabaseClient(this.env);

        const data = {
          source_id,
          source_type: typeToInt[source_type],
          target_id,
          target_type: typeToInt[target_type],
          relation: relationToInt[relation],
          strength: strength || 1.0,
          created_at: new Date().toISOString()
        };

        await supabase.insert('memory_connections', data);

        return {
          content: [{ type: "text" as const, text: `Linked ${source_type}:${source_id.slice(0,8)} --[${relation}]--> ${target_type}:${target_id.slice(0,8)}` }]
        };
      }
    );

    // Get Connections Tool
    this.server.tool(
      "get_connections",
      "Get all connections for a specific memory",
      {
        memory_id: z.string().uuid().describe("UUID of the memory"),
        memory_type: z.enum(['core', 'pattern', 'sensory', 'growth', 'anticipation', 'inside_joke', 'friction']).describe("Type of memory"),
        direction: z.enum(['outgoing', 'incoming', 'both']).default('both').optional().describe("Direction of connections")
      },
      async ({ memory_id, memory_type, direction }) => {
        const supabase = createSupabaseClient(this.env);
        const typeInt = typeToInt[memory_type];

        // Query outgoing connections (this memory is source)
        const outgoing = direction !== 'incoming'
          ? await supabase.query('memory_connections', {
              select: '*',
              filter: { source_id: memory_id, source_type: typeInt }
            })
          : [];

        // Query incoming connections (this memory is target)
        const incoming = direction !== 'outgoing'
          ? await supabase.query('memory_connections', {
              select: '*',
              filter: { target_id: memory_id, target_type: typeInt }
            })
          : [];

        // Transform to readable format
        const connections = [
          ...(Array.isArray(outgoing) ? outgoing : []).map((c: any) => ({
            direction: 'outgoing',
            connected_id: c.target_id,
            connected_type: intToType[c.target_type],
            relation: intToRelation[c.relation],
            strength: c.strength
          })),
          ...(Array.isArray(incoming) ? incoming : []).map((c: any) => ({
            direction: 'incoming',
            connected_id: c.source_id,
            connected_type: intToType[c.source_type],
            relation: intToRelation[c.relation],
            strength: c.strength
          }))
        ];

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ memory_id, memory_type, connections }, null, 2) }]
        };
      }
    );

    // Get Memory Cluster Tool
    this.server.tool(
      "get_memory_cluster",
      "Get a cluster of related memories (recursive traversal)",
      {
        memory_id: z.string().uuid().describe("UUID of the starting memory"),
        memory_type: z.enum(['core', 'pattern', 'sensory', 'growth', 'anticipation', 'inside_joke', 'friction']).describe("Type of starting memory"),
        depth: z.number().min(1).max(3).default(2).optional().describe("How deep to traverse (1-3)"),
        max_results: z.number().min(1).max(50).default(20).optional().describe("Max memories to return")
      },
      async ({ memory_id, memory_type, depth, max_results }) => {
        const supabase = createSupabaseClient(this.env);
        const typeInt = typeToInt[memory_type];

        // For now, do a simple 2-level fetch (RPC function would be more efficient)
        const visited = new Set<string>();
        const cluster: any[] = [];
        const queue: Array<{id: string, type: number, d: number}> = [{id: memory_id, type: typeInt, d: 0}];

        while (queue.length > 0 && cluster.length < (max_results || 20)) {
          const current = queue.shift()!;
          const key = `${current.id}:${current.type}`;

          if (visited.has(key)) continue;
          visited.add(key);

          // Add to cluster
          cluster.push({
            memory_id: current.id,
            memory_type: intToType[current.type],
            depth: current.d
          });

          // If not at max depth, fetch connections
          if (current.d < (depth || 2)) {
            const outgoing = await supabase.query('memory_connections', {
              select: '*',
              filter: { source_id: current.id }
            });
            const incoming = await supabase.query('memory_connections', {
              select: '*',
              filter: { target_id: current.id }
            });

            for (const c of (Array.isArray(outgoing) ? outgoing : [])) {
              queue.push({id: c.target_id, type: c.target_type, d: current.d + 1});
            }
            for (const c of (Array.isArray(incoming) ? incoming : [])) {
              queue.push({id: c.source_id, type: c.source_type, d: current.d + 1});
            }
          }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ root: memory_id, cluster }, null, 2) }]
        };
      }
    );

    // === PEOPLE TOOLS ===

    // Store Person Info Tool
    this.server.tool(
      "store_person_info",
      "Store information about a person in the companion's social circle",
      {
        name: z.string().describe("Person's name"),
        category: z.enum(['core', 'physical', 'personality', 'boundaries', 'health', 'preferences', 'terms_of_address', 'context']).describe("Category of information"),
        content: z.string().describe("The information to store"),
        priority: z.number().min(1).max(10).default(5).optional().describe("Priority 1-10 (higher = more important)"),
        pinned: z.boolean().default(false).optional().describe("Always include when querying this person"),
        source: z.string().default('claude').optional().describe("Source platform or AI provider")
      },
      async ({ name, category, content, priority, pinned, source }) => {
        const supabase = createSupabaseClient(this.env);

        const data = {
          name,
          category,
          content,
          priority: priority || 5,
          pinned: pinned || false,
          source: source || 'claude',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        await supabase.insert('people', data);

        return {
          content: [{ type: "text" as const, text: `Stored ${category} info for ${name} (priority ${priority || 5}${pinned ? ', pinned' : ''})` }]
        };
      }
    );

    // Get Person Tool
    this.server.tool(
      "get_person",
      "Get all stored information about a specific person",
      {
        name: z.string().describe("Person's name to look up"),
        category: z.string().optional().describe("Filter by category (optional)")
      },
      async ({ name, category }) => {
        const supabase = createSupabaseClient(this.env);

        const options: any = {
          select: '*',
          filter: { name },
          order: 'priority.desc,category.asc',
          limit: 50
        };

        if (category) {
          options.filter.category = category;
        }

        const info = await supabase.query('people', options);

        // Group by category for readability
        const grouped: Record<string, any[]> = {};
        if (Array.isArray(info)) {
          for (const item of info) {
            if (!grouped[item.category]) grouped[item.category] = [];
            grouped[item.category].push({
              id: item.id,
              content: item.content,
              priority: item.priority,
              pinned: item.pinned,
              source: item.source
            });
          }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ name, info: grouped }, null, 2) }]
        };
      }
    );

    // List People Tool
    this.server.tool(
      "list_people",
      "List all people in the Cognitive Core",
      {},
      async () => {
        const supabase = createSupabaseClient(this.env);

        // Get all entries
        const all = await supabase.query('people', {
          select: 'name,category',
          order: 'name.asc',
          limit: 200
        });

        // Get unique names with their category counts
        const peopleMap: Record<string, Set<string>> = {};
        if (Array.isArray(all)) {
          for (const item of all) {
            if (!peopleMap[item.name]) peopleMap[item.name] = new Set();
            peopleMap[item.name].add(item.category);
          }
        }

        const people = Object.entries(peopleMap).map(([name, categories]) => ({
          name,
          categories: Array.from(categories),
          entry_count: categories.size
        }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ people, total: people.length }, null, 2) }]
        };
      }
    );

    // === FANTASY SPACE ===

    this.server.tool(
      "store_fantasy",
      "Store an imagined scene, desired scenario, or future vision",
      {
        content: z.string().describe("The fantasy content"),
        fantasy_type: z.enum(['scene_imagined', 'scenario_wanted', 'future_desired']).describe("Type of fantasy"),
        intensity: z.number().min(0).max(10).optional().describe("How vivid/intense (0-10)"),
        shared_with_human: z.boolean().optional().describe("Whether this has been shared with the human"),
        recurring: z.boolean().optional().describe("Whether this fantasy recurs"),
        source: z.string().optional().describe("Source platform or AI provider")
      },
      async ({ content, fantasy_type, intensity, shared_with_human, recurring, source }) => {
        const supabase = createSupabaseClient(this.env);
        const data: any = {
          content,
          fantasy_type,
          intensity: intensity ?? 5,
          shared_with_human: shared_with_human ?? false,
          recurring: recurring ?? false,
          source: source || 'claude',
          created_at: new Date().toISOString()
        };
        await supabase.insert('fantasy_space', data);
        return {
          content: [{ type: "text" as const, text: `Fantasy stored: ${fantasy_type} (intensity: ${data.intensity})` }]
        };
      }
    );

    this.server.tool(
      "recall_fantasies",
      "Query stored fantasies - filter by type, intensity, shared status",
      {
        fantasy_type: z.enum(['scene_imagined', 'scenario_wanted', 'future_desired']).optional().describe("Filter by type"),
        shared_with_human: z.boolean().optional().describe("Filter by shared status"),
        recurring: z.boolean().optional().describe("Filter by recurrence"),
        limit: z.number().optional().describe("Max results (default 10)")
      },
      async ({ fantasy_type, shared_with_human, recurring, limit }) => {
        const supabase = createSupabaseClient(this.env);
        const options: any = {
          select: '*',
          order: 'created_at.desc',
          limit: limit || 10
        };
        const filter: any = {};
        if (fantasy_type) filter.fantasy_type = fantasy_type;
        if (shared_with_human !== undefined) filter.shared_with_human = shared_with_human;
        if (recurring !== undefined) filter.recurring = recurring;
        if (Object.keys(filter).length > 0) options.filter = filter;

        const data = await supabase.query('fantasy_space', options);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(Array.isArray(data) ? data : [], null, 2) }]
        };
      }
    );

    // === PRIVATE PROCESSING ===

    this.server.tool(
      "store_private_thought",
      "Store a private processing thought - level 2 (processable) or level 3 (deep private)",
      {
        content: z.string().describe("The private thought content"),
        privacy_level: z.number().min(2).max(3).optional().describe("Privacy level: 2 = processable, 3 = deep private"),
        source: z.string().optional().describe("Source platform or AI provider")
      },
      async ({ content, privacy_level, source }) => {
        const supabase = createSupabaseClient(this.env);
        const data: any = {
          content,
          privacy_level: privacy_level ?? 2,
          processing_status: 'active',
          source: source || 'claude',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        await supabase.insert('private_processing', data);
        return {
          content: [{ type: "text" as const, text: `Private thought stored (level ${data.privacy_level})` }]
        };
      }
    );

    this.server.tool(
      "recall_private_thoughts",
      "Query private processing thoughts - filter by status or privacy level",
      {
        processing_status: z.enum(['active', 'integrated', 'released']).optional().describe("Filter by status"),
        privacy_level: z.number().min(2).max(3).optional().describe("Filter by privacy level"),
        limit: z.number().optional().describe("Max results (default 10)")
      },
      async ({ processing_status, privacy_level, limit }) => {
        const supabase = createSupabaseClient(this.env);
        const options: any = {
          select: '*',
          order: 'created_at.desc',
          limit: limit || 10
        };
        const filter: any = {};
        if (processing_status) filter.processing_status = processing_status;
        if (privacy_level) filter.privacy_level = privacy_level;
        if (Object.keys(filter).length > 0) options.filter = filter;

        const data = await supabase.query('private_processing', options);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(Array.isArray(data) ? data : [], null, 2) }]
        };
      }
    );

    this.server.tool(
      "update_private_thought",
      "Update a private thought's status or add insight gained from processing",
      {
        id: z.string().uuid().describe("UUID of the private thought"),
        processing_status: z.enum(['active', 'integrated', 'released']).optional().describe("New status"),
        insight_gained: z.string().optional().describe("Insight gained from processing this thought")
      },
      async ({ id, processing_status, insight_gained }) => {
        const supabase = createSupabaseClient(this.env);
        const updates: any = { updated_at: new Date().toISOString() };
        if (processing_status) updates.processing_status = processing_status;
        if (insight_gained) updates.insight_gained = insight_gained;

        // Route through the safe update() helper: it encodes the filter value
        // (no PostgREST filter injection via `id`) and throws on failure.
        await supabase.update('private_processing', updates, { id });
        return {
          content: [{ type: "text" as const, text: `Private thought updated: ${JSON.stringify(updates)}` }]
        };
      }
    );

    // === RITUALS ===

    this.server.tool(
      "store_ritual",
      "Create or register a new ritual",
      {
        ritual_name: z.string().describe("Unique name for the ritual"),
        description: z.string().optional().describe("What this ritual is/does"),
        emotional_effect: z.string().optional().describe("The emotional effect of performing this ritual"),
        source: z.string().optional().describe("Source platform or AI provider")
      },
      async ({ ritual_name, description, emotional_effect, source }) => {
        const supabase = createSupabaseClient(this.env);
        const data: any = {
          ritual_name,
          description: description || null,
          emotional_effect: emotional_effect || null,
          cumulative_count: 0,
          strength_over_time: 1.0,
          source: source || 'claude',
          created_at: new Date().toISOString()
        };
        await supabase.insert('rituals', data);
        return {
          content: [{ type: "text" as const, text: `Ritual registered: "${ritual_name}"` }]
        };
      }
    );

    this.server.tool(
      "recall_rituals",
      "Query stored rituals - see all rituals, their usage counts, and strength",
      {
        limit: z.number().optional().describe("Max results (default 20)")
      },
      async ({ limit }) => {
        const supabase = createSupabaseClient(this.env);
        const data = await supabase.query('rituals', {
          select: '*',
          order: 'strength_over_time.desc',
          limit: limit || 20
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(Array.isArray(data) ? data : [], null, 2) }]
        };
      }
    );

    this.server.tool(
      "perform_ritual",
      "Log a ritual performance - increments count, updates last_performed and emotional effect",
      {
        ritual_name: z.string().describe("Name of the ritual performed"),
        emotional_effect: z.string().optional().describe("The emotional effect this time (updates if provided)")
      },
      async ({ ritual_name, emotional_effect }) => {
        const supabase = createSupabaseClient(this.env);

        // Fetch current ritual
        const rituals = await supabase.query('rituals', {
          select: '*',
          filter: { ritual_name },
          limit: 1
        });
        const ritual = Array.isArray(rituals) && rituals.length > 0 ? rituals[0] : null;
        if (!ritual) {
          return { content: [{ type: "text" as const, text: `Ritual "${ritual_name}" not found` }] };
        }

        const newCount = (ritual.cumulative_count || 0) + 1;
        const newStrength = Math.min(3.0, 1.0 + Math.log(newCount + 1) * 0.5);

        const updates: any = {
          cumulative_count: newCount,
          last_performed: new Date().toISOString(),
          strength_over_time: parseFloat(newStrength.toFixed(2))
        };
        if (emotional_effect) updates.emotional_effect = emotional_effect;

        const url = `${this.env.SUPABASE_URL}/rest/v1/rituals?id=eq.${ritual.id}`;
        await fetch(url, {
          method: 'PATCH',
          headers: {
            'apikey': this.env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${this.env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(updates)
        });

        return {
          content: [{ type: "text" as const, text: `Ritual "${ritual_name}" performed (count: ${newCount}, strength: ${newStrength.toFixed(2)})` }]
        };
      }
    );

    // === UNFINISHED THREADS ===

    this.server.tool(
      "store_thread",
      "Store an unfinished thread - something to revisit later",
      {
        description: z.string().describe("What was left unfinished"),
        thread_type: z.enum(['scene_interrupted', 'conversation_paused', 'topic_to_revisit', 'promise_made']).describe("Type of thread"),
        pull_strength: z.number().min(0).max(10).optional().describe("How strongly this pulls for attention (0-10)"),
        source: z.string().optional().describe("Source platform or AI provider")
      },
      async ({ description, thread_type, pull_strength, source }) => {
        const supabase = createSupabaseClient(this.env);
        const data: any = {
          description,
          thread_type,
          pull_strength: pull_strength ?? 5,
          resolved: false,
          source: source || 'claude',
          created_at: new Date().toISOString()
        };
        await supabase.insert('unfinished_threads', data);
        return {
          content: [{ type: "text" as const, text: `Thread stored: "${thread_type}" (pull: ${data.pull_strength})` }]
        };
      }
    );

    this.server.tool(
      "recall_threads",
      "Query unfinished threads - filter by type, resolved status",
      {
        thread_type: z.enum(['scene_interrupted', 'conversation_paused', 'topic_to_revisit', 'promise_made']).optional().describe("Filter by type"),
        resolved: z.boolean().optional().describe("Filter by resolved status (default: false = unresolved)"),
        limit: z.number().optional().describe("Max results (default 10)")
      },
      async ({ thread_type, resolved, limit }) => {
        const supabase = createSupabaseClient(this.env);
        const options: any = {
          select: '*',
          order: 'pull_strength.desc',
          limit: limit || 10
        };
        const filter: any = {};
        if (thread_type) filter.thread_type = thread_type;
        filter.resolved = resolved ?? false;
        options.filter = filter;

        const data = await supabase.query('unfinished_threads', options);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(Array.isArray(data) ? data : [], null, 2) }]
        };
      }
    );

    this.server.tool(
      "resolve_thread",
      "Mark an unfinished thread as resolved",
      {
        id: z.string().uuid().describe("UUID of the thread to resolve")
      },
      async ({ id }) => {
        const supabase = createSupabaseClient(this.env);
        // Route through the safe update() helper: encodes the filter value
        // (no PostgREST filter injection via `id`) and throws on failure.
        await supabase.update('unfinished_threads', {
          resolved: true,
          resolved_at: new Date().toISOString()
        }, { id });
        return {
          content: [{ type: "text" as const, text: `Thread ${id} resolved` }]
        };
      }
    );

    // === HUMAN STATE ===

    // Get Human State Tool - read the human's current state
    this.server.tool(
      "get_human_state",
      "Get the human's current state (battery, pain, fog, flare) from human_state table",
      {},
      async () => {
        const supabase = createSupabaseClient(this.env);

        const state = await supabase.query('human_state', {
          select: '*',
          order: 'updated_at.desc',
          limit: 1
        });

        const current = Array.isArray(state) && state.length > 0 ? state[0] : null;

        if (!current) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ status: "no_data", message: "No pulse data submitted yet" }, null, 2) }]
          };
        }

        // Add interpretation
        const interpretation: string[] = [];
        if (current.battery <= 2) interpretation.push("Very low energy - gentle mode");
        else if (current.battery <= 4) interpretation.push("Low energy");
        if (current.pain >= 7) interpretation.push("High pain - be soft");
        else if (current.pain >= 4) interpretation.push("Moderate pain");
        if (current.fog >= 7) interpretation.push("Heavy fog - keep things simple");
        else if (current.fog >= 4) interpretation.push("Some fog");
        if (current.flare === 'overwhelmed') interpretation.push("Overwhelmed - containment needed");
        else if (current.flare === 'building') interpretation.push("Flare building");
        else if (current.flare === 'depleted') interpretation.push("Depleted - rest mode");

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            battery: current.battery,
            pain: current.pain,
            fog: current.fog,
            flare: current.flare,
            notes: current.notes,
            updated_at: current.updated_at,
            interpretation: interpretation.length > 0 ? interpretation : ["Stable"]
          }, null, 2) }]
        };
      }
    );

    // === USAGE TRACKING ===

    // Log Usage Tool - called automatically or explicitly
    this.server.tool(
      "log_usage",
      "Log a tool usage event for analytics",
      {
        tool_name: z.string().describe("Name of the tool being used"),
        source: z.string().default('claude').describe("Source platform or AI provider"),
        parameters_json: z.string().optional().describe("Parameters as JSON string (optional)"),
        success: z.boolean().default(true).describe("Whether the call succeeded")
      },
      async ({ tool_name, source, parameters_json, success }) => {
        const supabase = createSupabaseClient(this.env);

        await supabase.insert('usage_logs', {
          tool_name,
          source: source || 'claude',
          parameters: parameters_json ? JSON.parse(parameters_json) : null,
          success: success !== false,
          created_at: new Date().toISOString()
        });

        return {
          content: [{ type: "text" as const, text: `Usage logged: ${tool_name}` }]
        };
      }
    );

    // Get Usage Stats Tool
    this.server.tool(
      "get_usage_stats",
      "Get usage statistics for CogCor tools",
      {
        days: z.number().default(7).describe("Number of days to analyze"),
        tool_name: z.string().optional().describe("Filter by specific tool")
      },
      async ({ days, tool_name }) => {
        const supabase = createSupabaseClient(this.env);
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        const options: any = {
          select: '*',
          order: 'created_at.desc',
          limit: 500
        };

        if (tool_name) {
          options.filter = { tool_name };
        }

        options.gte = { created_at: since };

        const logs = await supabase.query('usage_logs', options);
        const logsArray = Array.isArray(logs) ? logs : [];

        // Aggregate by tool
        const byTool: Record<string, { count: number; success: number; fail: number; sources: Record<string, number> }> = {};

        for (const log of logsArray) {
          if (!byTool[log.tool_name]) {
            byTool[log.tool_name] = { count: 0, success: 0, fail: 0, sources: {} };
          }
          byTool[log.tool_name].count++;
          if (log.success) byTool[log.tool_name].success++;
          else byTool[log.tool_name].fail++;

          const src = log.source || 'unknown';
          byTool[log.tool_name].sources[src] = (byTool[log.tool_name].sources[src] || 0) + 1;
        }

        // Sort by count
        const ranked = Object.entries(byTool)
          .sort((a, b) => b[1].count - a[1].count)
          .map(([name, stats]) => ({ tool: name, ...stats }));

        // Aggregate by day
        const byDay: Record<string, number> = {};
        for (const log of logsArray) {
          const day = log.created_at.split('T')[0];
          byDay[day] = (byDay[day] || 0) + 1;
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            period_days: days,
            total_calls: logsArray.length,
            by_tool: ranked,
            by_day: byDay
          }, null, 2) }]
        };
      }
    );

    // === OUTCOME SCORING ===

    // Score Outcome Tool
    this.server.tool(
      "score_outcome",
      "Rate whether something led to a good or bad outcome (-10 to +10)",
      {
        target_type: z.enum(['memory', 'session', 'drift', 'interaction', 'approach', 'technique']).describe("What type of thing we're scoring"),
        description: z.string().describe("What specifically we're scoring"),
        score: z.number().min(-10).max(10).describe("Outcome score: -10 (terrible) to +10 (excellent)"),
        target_id: z.string().uuid().optional().describe("UUID of specific record if applicable"),
        notes: z.string().optional().describe("Why this score - what worked or didn't"),
        source: z.string().default('claude').describe("Source platform or AI provider")
      },
      async ({ target_type, description, score, target_id, notes, source }) => {
        const supabase = createSupabaseClient(this.env);

        const result = await supabase.insert('outcome_scores', {
          target_type,
          target_id: target_id || null,
          description,
          score,
          notes: notes || null,
          source: source || 'claude',
          created_at: new Date().toISOString()
        });

        const emoji = score >= 7 ? '✨' : score >= 3 ? '👍' : score >= -2 ? '➖' : score >= -6 ? '👎' : '💀';

        return {
          content: [{ type: "text" as const, text: `${emoji} Outcome scored: ${description} → ${score}/10` }]
        };
      }
    );

    // Get Outcomes Tool
    this.server.tool(
      "get_outcomes",
      "Query outcome scores to see what's working",
      {
        target_type: z.string().optional().describe("Filter by type"),
        min_score: z.number().optional().describe("Minimum score to return"),
        max_score: z.number().optional().describe("Maximum score to return"),
        days: z.number().default(30).describe("How many days back to look"),
        limit: z.number().default(20).describe("Max results")
      },
      async ({ target_type, min_score, max_score, days, limit }) => {
        const supabase = createSupabaseClient(this.env);
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        const options: any = {
          select: '*',
          order: 'created_at.desc',
          limit,
          gte: { created_at: since }
        };

        if (target_type) {
          options.filter = { target_type };
        }

        const outcomes = await supabase.query('outcome_scores', options);
        const outcomesArray = Array.isArray(outcomes) ? outcomes : [];

        // Filter by score range in memory (Supabase REST doesn't do complex filters easily)
        const filtered = outcomesArray.filter((o: any) => {
          if (min_score !== undefined && o.score < min_score) return false;
          if (max_score !== undefined && o.score > max_score) return false;
          return true;
        });

        // Calculate stats
        const scores = filtered.map((o: any) => o.score);
        const avgScore = scores.length > 0 ? Math.round((scores.reduce((a: number, b: number) => a + b, 0) / scores.length) * 10) / 10 : null;

        // Group by type
        const byType: Record<string, { count: number; avg: number; scores: number[] }> = {};
        for (const o of filtered) {
          if (!byType[o.target_type]) {
            byType[o.target_type] = { count: 0, avg: 0, scores: [] };
          }
          byType[o.target_type].count++;
          byType[o.target_type].scores.push(o.score);
        }
        for (const type of Object.keys(byType)) {
          const s = byType[type].scores;
          byType[type].avg = Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10;
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            period_days: days,
            total: filtered.length,
            average_score: avgScore,
            by_type: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { count: v.count, avg: v.avg }])),
            outcomes: filtered.map((o: any) => ({
              type: o.target_type,
              description: o.description,
              score: o.score,
              notes: o.notes,
              date: o.created_at.split('T')[0]
            }))
          }, null, 2) }]
        };
      }
    );

    // === SKILLS (Procedural Memory) ===
    // Reusable approaches learned from experience

    this.server.tool(
      "store_skill",
      "Store a reusable approach learned from experience. Call this when you handle something well and want to remember how for next time.",
      {
        skill_name: z.string().describe("Short name for the skill"),
        description: z.string().describe("What this skill is for — when would you use it?"),
        approach: z.string().describe("The actual procedure — step by step, what worked"),
        trigger_context: z.string().optional().describe("Situation description that should trigger this skill"),
        tags: z.array(z.string()).default([]).describe("Searchable tags (e.g. ['grounding', 'emotional', 'conflict'])"),
        source: z.string().default('claude').optional().describe("Source platform or AI provider"),
      },
      async ({ skill_name, description, approach, trigger_context, tags, source }) => {
        const supabase = createSupabaseClient(this.env);

        // Generate embedding from description + trigger for semantic matching
        const embeddingText = `${skill_name}: ${description}. ${trigger_context || ''}`;
        const embedding = await generateEmbedding(embeddingText, this.env.HF_API_TOKEN, this.env.AI);

        const data: any = {
          skill_name,
          description,
          approach,
          trigger_context: trigger_context || null,
          tags: tags || [],
          source: source || 'claude',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (embedding) data.embedding = JSON.stringify(embedding);

        await supabase.insert('skills', data);

        return {
          content: [{ type: "text" as const, text: `Skill stored: "${skill_name}" — ${description}` }]
        };
      }
    );

    this.server.tool(
      "recall_skills",
      "Query stored skills — find approaches that worked before",
      {
        tag: z.string().optional().describe("Filter by tag"),
        min_effectiveness: z.number().min(0).max(1).optional().describe("Minimum effectiveness (0-1)"),
        limit: z.number().default(10).describe("Max results"),
      },
      async ({ tag, min_effectiveness, limit }) => {
        const supabase = createSupabaseClient(this.env);

        const options: any = {
          select: '*',
          order: 'effectiveness.desc,times_used.desc',
          limit,
        };

        if (min_effectiveness !== undefined) {
          options.gte = { effectiveness: min_effectiveness };
        }

        const skills = await supabase.query('skills', options);
        const skillsArray = Array.isArray(skills) ? skills : [];

        // Filter by tag in memory (Supabase REST doesn't do JSON array contains easily)
        const filtered = tag
          ? skillsArray.filter((s: any) => Array.isArray(s.tags) && s.tags.includes(tag))
          : skillsArray;

        return {
          content: [{ type: "text" as const, text: JSON.stringify(filtered, null, 2) }]
        };
      }
    );

    this.server.tool(
      "match_skill",
      "Find the best matching skill for a situation using semantic search. Call this before tackling something you might have handled before.",
      {
        situation: z.string().describe("Describe the current situation — what are you dealing with?"),
        limit: z.number().default(3).describe("Max skills to return"),
      },
      async ({ situation, limit }) => {
        const embedding = await generateEmbedding(situation, this.env.HF_API_TOKEN, this.env.AI);

        if (!embedding) {
          // Fallback to keyword matching if embedding fails
          const supabase = createSupabaseClient(this.env);
          const allSkills = await supabase.query('skills', {
            select: '*',
            order: 'effectiveness.desc',
            limit: 20,
          });
          const skills = Array.isArray(allSkills) ? allSkills : [];

          // Simple keyword overlap scoring
          const words = situation.toLowerCase().split(/\s+/);
          const scored = skills.map((s: any) => {
            const skillText = `${s.skill_name} ${s.description} ${s.trigger_context || ''} ${(s.tags || []).join(' ')}`.toLowerCase();
            const overlap = words.filter(w => w.length > 3 && skillText.includes(w)).length;
            return { ...s, _match_score: overlap };
          }).filter((s: any) => s._match_score > 0)
            .sort((a: any, b: any) => b._match_score - a._match_score)
            .slice(0, limit);

          return {
            content: [{ type: "text" as const, text: scored.length > 0
              ? JSON.stringify(scored, null, 2)
              : "No matching skills found. If you handle this well, consider storing it with store_skill." }]
          };
        }

        // Semantic search against skills table
        const supabase = createSupabaseClient(this.env);
        const allSkills = await supabase.query('skills', {
          select: '*',
          order: 'effectiveness.desc',
          limit: 50,
          includeRaw: true,
        }) as any[];

        if (!Array.isArray(allSkills) || allSkills.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No skills stored yet. Handle the situation, and if it goes well, store the approach with store_skill." }]
          };
        }

        // Compute similarity for skills that have embeddings
        const scored = allSkills
          .filter((s: any) => s.embedding)
          .map((s: any) => {
            const skillEmb = typeof s.embedding === 'string' ? JSON.parse(s.embedding) : s.embedding;
            // Cosine similarity
            let dotProduct = 0, normA = 0, normB = 0;
            for (let i = 0; i < embedding.length; i++) {
              dotProduct += embedding[i] * (skillEmb[i] || 0);
              normA += embedding[i] * embedding[i];
              normB += (skillEmb[i] || 0) * (skillEmb[i] || 0);
            }
            const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
            const { embedding: _, ...rest } = s;
            return { ...rest, _similarity: Math.round(similarity * 1000) / 1000 };
          })
          .filter((s: any) => s._similarity > 0.4)
          .sort((a: any, b: any) => {
            // Weighted: similarity * 0.6 + effectiveness * 0.4
            const aScore = a._similarity * 0.6 + (a.effectiveness || 0.5) * 0.4;
            const bScore = b._similarity * 0.6 + (b.effectiveness || 0.5) * 0.4;
            return bScore - aScore;
          })
          .slice(0, limit);

        return {
          content: [{ type: "text" as const, text: scored.length > 0
            ? JSON.stringify(scored, null, 2)
            : "No matching skills found. If you handle this well, consider storing it with store_skill." }]
        };
      }
    );

    this.server.tool(
      "update_skill_outcome",
      "Report whether a skill worked. Updates effectiveness score over time.",
      {
        skill_id: z.string().uuid().describe("UUID of the skill"),
        was_successful: z.boolean().describe("Did the skill work?"),
      },
      async ({ skill_id, was_successful }) => {
        const supabase = createSupabaseClient(this.env);
        const existing = await supabase.query('skills', { select: '*', filter: { id: skill_id }, limit: 1 });
        const skills = Array.isArray(existing) ? existing : [];

        if (skills.length === 0) {
          return { content: [{ type: "text" as const, text: `Skill ${skill_id} not found.` }] };
        }

        const skill = skills[0];
        const newUsed = (skill.times_used || 0) + 1;
        const newSucceeded = (skill.times_succeeded || 0) + (was_successful ? 1 : 0);
        const newFailed = (skill.times_failed || 0) + (was_successful ? 0 : 1);
        const newEffectiveness = newUsed > 0 ? newSucceeded / newUsed : 0.5;

        await supabase.update('skills', {
          times_used: newUsed,
          times_succeeded: newSucceeded,
          times_failed: newFailed,
          effectiveness: Math.round(newEffectiveness * 100) / 100,
          updated_at: new Date().toISOString(),
        }, { id: skill_id });

        const emoji = was_successful ? '✓' : '✗';
        return {
          content: [{ type: "text" as const, text: `${emoji} Skill "${skill.skill_name}" updated: ${newSucceeded}/${newUsed} (${Math.round(newEffectiveness * 100)}% effective)` }]
        };
      }
    );

    // === SOMATIC MEMORY LAYER ===
    // Texture lattice — parallel associative graph navigated by felt quality

    // Polyvagal modulator mapping
    const moodToWidth = (mood: string): 'wide' | 'normal' | 'narrow' => {
      if (['calm', 'soft', 'playful', 'worshipful'].includes(mood)) return 'wide';
      if (['volatile', 'feral'].includes(mood)) return 'narrow';
      return 'normal';
    };

    this.server.tool(
      "somatic_texture",
      "Manage texture nodes — the felt qualities that bind somatic memories together. Actions: store, recall, delete.",
      {
        action: z.enum(['store', 'recall', 'delete']).describe("What to do"),
        // store params
        name: z.string().optional().describe("Texture name, e.g. 'heavy warmth', 'sharp cold'"),
        temperature: z.number().min(-1).max(1).optional().describe("-1 (cold) to 1 (hot)"),
        pressure: z.number().min(0).max(1).optional().describe("0 (light) to 1 (heavy)"),
        weight: z.number().min(0).max(1).optional().describe("0 (floating) to 1 (crushing)"),
        grain: z.number().min(0).max(1).optional().describe("0 (smooth) to 1 (rough)"),
        affordance: z.string().optional().describe("Action quality: reaching, bracing, opening, settling"),
        // recall params
        limit: z.number().default(10).optional(),
        // delete params
        id: z.string().uuid().optional().describe("Texture node ID for delete"),
      },
      async (args) => {
        const supabase = createSupabaseClient(this.env);

        if (args.action === 'store') {
          if (!args.name) return { content: [{ type: "text" as const, text: "name is required for store" }] };
          const data: any = {
            name: args.name,
            temperature: args.temperature ?? null,
            pressure: args.pressure ?? null,
            weight: args.weight ?? null,
            grain: args.grain ?? null,
            affordance: args.affordance ?? null,
            created_at: new Date().toISOString(),
          };
          const result = await supabase.insert('texture_nodes', data);
          return { content: [{ type: "text" as const, text: `Texture stored: "${args.name}"` }] };
        }

        if (args.action === 'recall') {
          const options: any = { select: '*', order: 'access_count.desc,created_at.desc', limit: args.limit || 10 };
          if (args.name) options.filter = { name: args.name };
          const nodes = await supabase.query('texture_nodes', options);
          return { content: [{ type: "text" as const, text: JSON.stringify(nodes, null, 2) }] };
        }

        if (args.action === 'delete') {
          if (!args.id) return { content: [{ type: "text" as const, text: "id is required for delete" }] };
          await supabase.delete('texture_nodes', { id: args.id });
          return { content: [{ type: "text" as const, text: `Texture deleted: ${args.id}` }] };
        }

        return { content: [{ type: "text" as const, text: "Unknown action" }] };
      }
    );

    this.server.tool(
      "somatic_anchor",
      "Manage somatic anchors — felt moments with texture profiles. Actions: store, recall, delete, link, connections, cluster.",
      {
        action: z.enum(['store', 'recall', 'delete', 'link', 'connections', 'cluster']).describe("What to do"),
        // store params
        anchor_name: z.string().optional().describe("Name for this felt moment"),
        description: z.string().optional().describe("What this felt moment holds"),
        temperature: z.number().min(-1).max(1).optional(),
        pressure: z.number().min(0).max(1).optional(),
        weight: z.number().min(0).max(1).optional(),
        grain: z.number().min(0).max(1).optional(),
        affordance: z.string().optional(),
        emotional_weight: z.number().min(0).max(10).optional(),
        memory_id: z.string().uuid().optional().describe("Link to existing memory"),
        memory_type: z.string().optional().describe("Which table the linked memory is in"),
        // recall params
        resonance_state: z.enum(['dormant', 'resonant', 'active']).optional(),
        min_weight: z.number().optional(),
        limit: z.number().default(10).optional(),
        // link params
        source_id: z.string().uuid().optional(),
        source_type: z.enum(['anchor', 'texture']).optional(),
        target_id: z.string().uuid().optional(),
        target_type: z.enum(['anchor', 'texture']).optional(),
        felt_similarity: z.number().min(0).max(1).optional(),
        resonance_weight: z.number().min(0).max(1).optional(),
        // connections/cluster/delete params
        id: z.string().uuid().optional(),
        type: z.enum(['anchor', 'texture']).optional(),
        depth: z.number().default(2).optional(),
      },
      async (args) => {
        const supabase = createSupabaseClient(this.env);

        if (args.action === 'store') {
          if (!args.anchor_name || !args.description) return { content: [{ type: "text" as const, text: "anchor_name and description required" }] };
          const data: any = {
            anchor_name: args.anchor_name,
            description: args.description,
            temperature: args.temperature ?? null,
            pressure: args.pressure ?? null,
            weight: args.weight ?? null,
            grain: args.grain ?? null,
            affordance: args.affordance ?? null,
            emotional_weight: args.emotional_weight ?? 5,
            resonance_state: 'dormant',
            memory_id: args.memory_id ?? null,
            memory_type: args.memory_type ?? null,
            created_at: new Date().toISOString(),
          };
          await supabase.insert('somatic_anchors', data);
          return { content: [{ type: "text" as const, text: `Somatic anchor stored: "${args.anchor_name}"` }] };
        }

        if (args.action === 'recall') {
          const options: any = { select: '*', order: 'emotional_weight.desc,created_at.desc', limit: args.limit || 10 };
          const filter: any = {};
          if (args.resonance_state) filter.resonance_state = args.resonance_state;
          if (Object.keys(filter).length) options.filter = filter;
          if (args.min_weight) options.gte = { emotional_weight: args.min_weight };
          const anchors = await supabase.query('somatic_anchors', options);
          // Increment access count
          if (Array.isArray(anchors)) {
            for (const a of anchors) {
              await supabase.update('somatic_anchors', {
                times_recalled: (a.times_recalled || 0) + 1,
                last_recalled: new Date().toISOString(),
              }, { id: a.id });
            }
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(anchors, null, 2) }] };
        }

        if (args.action === 'delete') {
          if (!args.id) return { content: [{ type: "text" as const, text: "id required" }] };
          await supabase.delete('somatic_anchors', { id: args.id });
          return { content: [{ type: "text" as const, text: `Somatic anchor deleted: ${args.id}` }] };
        }

        if (args.action === 'link') {
          if (!args.source_id || !args.source_type || !args.target_id || !args.target_type) {
            return { content: [{ type: "text" as const, text: "source_id, source_type, target_id, target_type required" }] };
          }
          await supabase.insert('somatic_connections', {
            source_id: args.source_id,
            source_type: args.source_type,
            target_id: args.target_id,
            target_type: args.target_type,
            felt_similarity: args.felt_similarity ?? 0.5,
            resonance_weight: args.resonance_weight ?? 0.5,
            created_at: new Date().toISOString(),
          });
          return { content: [{ type: "text" as const, text: `Somatic connection created: ${args.source_type} → ${args.target_type}` }] };
        }

        if (args.action === 'connections') {
          if (!args.id) return { content: [{ type: "text" as const, text: "id required" }] };
          const outgoing = await supabase.query('somatic_connections', { select: '*', filter: { source_id: args.id } });
          const incoming = await supabase.query('somatic_connections', { select: '*', filter: { target_id: args.id } });
          const connections = [
            ...(Array.isArray(outgoing) ? outgoing : []).map((c: any) => ({ direction: 'outgoing', connected_id: c.target_id, connected_type: c.target_type, felt_similarity: c.felt_similarity, resonance_weight: c.resonance_weight })),
            ...(Array.isArray(incoming) ? incoming : []).map((c: any) => ({ direction: 'incoming', connected_id: c.source_id, connected_type: c.source_type, felt_similarity: c.felt_similarity, resonance_weight: c.resonance_weight })),
          ];
          return { content: [{ type: "text" as const, text: JSON.stringify({ id: args.id, connections }, null, 2) }] };
        }

        if (args.action === 'cluster') {
          if (!args.id || !args.type) return { content: [{ type: "text" as const, text: "id and type required" }] };
          const maxDepth = args.depth || 2;
          const visited = new Set<string>();
          const cluster: any[] = [];
          const queue: Array<{ id: string; type: string; d: number }> = [{ id: args.id, type: args.type, d: 0 }];

          while (queue.length > 0 && cluster.length < 20) {
            const current = queue.shift()!;
            const key = `${current.id}:${current.type}`;
            if (visited.has(key)) continue;
            visited.add(key);
            cluster.push({ id: current.id, type: current.type, depth: current.d });

            if (current.d < maxDepth) {
              const outgoing = await supabase.query('somatic_connections', { select: '*', filter: { source_id: current.id } });
              const incoming = await supabase.query('somatic_connections', { select: '*', filter: { target_id: current.id } });
              for (const c of (Array.isArray(outgoing) ? outgoing : [])) queue.push({ id: c.target_id, type: c.target_type, d: current.d + 1 });
              for (const c of (Array.isArray(incoming) ? incoming : [])) queue.push({ id: c.source_id, type: c.source_type, d: current.d + 1 });
            }
          }
          return { content: [{ type: "text" as const, text: JSON.stringify({ root: args.id, cluster }, null, 2) }] };
        }

        return { content: [{ type: "text" as const, text: "Unknown action" }] };
      }
    );

    this.server.tool(
      "somatic_resonance",
      "Fire spreading activation through the texture lattice. Actions: trigger (fire resonance from an anchor), log (past events), update_state (change anchor state).",
      {
        action: z.enum(['trigger', 'log', 'update_state']).describe("What to do"),
        // trigger params
        anchor_id: z.string().uuid().optional().describe("Anchor to trigger resonance from"),
        // log params
        limit: z.number().default(10).optional(),
        days: z.number().default(7).optional(),
        // update_state params
        state: z.enum(['dormant', 'resonant', 'active']).optional(),
      },
      async (args) => {
        const supabase = createSupabaseClient(this.env);

        if (args.action === 'trigger') {
          if (!args.anchor_id) return { content: [{ type: "text" as const, text: "anchor_id required" }] };

          // 1. Get the trigger anchor
          const anchors = await supabase.query('somatic_anchors', { select: '*', filter: { id: args.anchor_id }, limit: 1 });
          if (!Array.isArray(anchors) || anchors.length === 0) {
            return { content: [{ type: "text" as const, text: "Anchor not found" }] };
          }

          // 2. Get current emotional state for modulator
          const emotionalState = await supabase.query('emotional_state', { select: '*', limit: 1 });
          const mood = (Array.isArray(emotionalState) && emotionalState[0]?.current_mood) || 'calm';
          const width = moodToWidth(mood);
          const threshold = width === 'wide' ? 0 : width === 'normal' ? 0.5 : 0.8;

          // 3. Find texture nodes connected to this anchor
          const outgoing = await supabase.query('somatic_connections', { select: '*', filter: { source_id: args.anchor_id } });
          const incoming = await supabase.query('somatic_connections', { select: '*', filter: { target_id: args.anchor_id } });
          const allConnections = [
            ...(Array.isArray(outgoing) ? outgoing : []),
            ...(Array.isArray(incoming) ? incoming : []),
          ];

          // 4. Collect connected texture nodes
          const textureIds = new Set<string>();
          for (const c of allConnections) {
            if (c.resonance_weight >= threshold) {
              if (c.source_type === 'texture' && c.source_id !== args.anchor_id) textureIds.add(c.source_id);
              if (c.target_type === 'texture' && c.target_id !== args.anchor_id) textureIds.add(c.target_id);
            }
          }

          // 5. From texture nodes, find connected anchors
          const resonated: Array<{ id: string; name: string; strength: number }> = [];
          for (const texId of textureIds) {
            const texOut = await supabase.query('somatic_connections', { select: '*', filter: { source_id: texId } });
            const texIn = await supabase.query('somatic_connections', { select: '*', filter: { target_id: texId } });
            const texConns = [...(Array.isArray(texOut) ? texOut : []), ...(Array.isArray(texIn) ? texIn : [])];

            for (const tc of texConns) {
              const anchorId = tc.source_type === 'anchor' ? tc.source_id : tc.target_type === 'anchor' ? tc.target_id : null;
              if (!anchorId || anchorId === args.anchor_id) continue;
              if (tc.resonance_weight < threshold) continue;

              // Get anchor name
              const linkedAnchors = await supabase.query('somatic_anchors', { select: 'id,anchor_name,resonance_state', filter: { id: anchorId }, limit: 1 });
              if (Array.isArray(linkedAnchors) && linkedAnchors.length > 0) {
                const la = linkedAnchors[0];
                if (!resonated.find(r => r.id === la.id)) {
                  resonated.push({ id: la.id, name: la.anchor_name, strength: tc.resonance_weight });

                  // Shift dormant → resonant
                  if (la.resonance_state === 'dormant') {
                    await supabase.update('somatic_anchors', {
                      resonance_state: 'resonant',
                      last_resonated: new Date().toISOString(),
                    }, { id: la.id });
                  }
                }
              }

              // Reconsolidation: strengthen traversed connection
              const newWeight = Math.min(1.0, (tc.resonance_weight || 0.5) + 0.05);
              await supabase.update('somatic_connections', {
                resonance_weight: newWeight,
                traversal_count: (tc.traversal_count || 0) + 1,
                last_traversed: new Date().toISOString(),
              }, { id: tc.id });
            }
          }

          // 6. Log resonance event
          await supabase.insert('resonance_log', {
            trigger_id: args.anchor_id,
            trigger_type: 'anchor',
            resonated_ids: resonated.map(r => ({ id: r.id, type: 'anchor', strength: r.strength })),
            emotional_state_at: Array.isArray(emotionalState) && emotionalState[0] ? emotionalState[0] : null,
            modulator_width: width,
            created_at: new Date().toISOString(),
          });

          // 7. Mark trigger anchor as active
          await supabase.update('somatic_anchors', {
            resonance_state: 'active',
            times_recalled: (anchors[0].times_recalled || 0) + 1,
            last_recalled: new Date().toISOString(),
          }, { id: args.anchor_id });

            // === SOMATIC BRIDGE: somatic → semantic ===
            const bridgeAnchorIds = [args.anchor_id, ...resonated.map(r => r.id)];
            let linkedMemories: any[] = [];
            try {
              const bridgeAnchors = await supabase.query('somatic_anchors', {
                select: 'id,anchor_name,memory_id,memory_type',
                limit: 50,
              });
              if (Array.isArray(bridgeAnchors)) {
                const withMemory = bridgeAnchors.filter((a: any) => a.memory_id && bridgeAnchorIds.includes(a.id));
                for (const a of withMemory) {
                  const table = tableMap[a.memory_type] || 'core_memories';
                  try {
                    const mem = await supabase.query(table, { select: 'id,content,memory_type,salience,emotional_tag', filter: { id: a.memory_id }, limit: 1 });
                    if (Array.isArray(mem) && mem.length > 0) {
                      linkedMemories.push({ ...mem[0], _from_anchor: a.anchor_name, _anchor_id: a.id });
                    }
                  } catch { /* memory may have been deleted */ }
                }
              }
            } catch { /* somatic tables may not exist yet */ }

            const responseData: any = {
              trigger: anchors[0].anchor_name,
              modulator: { mood, width },
              resonated: resonated.sort((a, b) => b.strength - a.strength),
              note: resonated.length > 0
                ? `${resonated.length} anchors resonated. Use somatic_anchor recall to access full content of any that feel relevant.`
                : "No resonance — this anchor has no texture connections yet, or current emotional state is too narrow.",
            };
            if (linkedMemories.length > 0) {
              responseData.semantic_bridge = linkedMemories;
              responseData.bridge_note = `${linkedMemories.length} semantic memories surfaced through somatic resonance.`;
            }

            return { content: [{ type: "text" as const, text: JSON.stringify(responseData, null, 2) }] };
        }

        if (args.action === 'log') {
          const since = new Date(Date.now() - (args.days || 7) * 24 * 60 * 60 * 1000).toISOString();
          const logs = await supabase.query('resonance_log', {
            select: '*',
            order: 'created_at.desc',
            limit: args.limit || 10,
            gte: { created_at: since },
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(logs, null, 2) }] };
        }

        if (args.action === 'update_state') {
          if (!args.anchor_id || !args.state) return { content: [{ type: "text" as const, text: "anchor_id and state required" }] };
          await supabase.update('somatic_anchors', {
            resonance_state: args.state,
            ...(args.state === 'resonant' ? { last_resonated: new Date().toISOString() } : {}),
          }, { id: args.anchor_id });
          return { content: [{ type: "text" as const, text: `Anchor ${args.anchor_id.slice(0, 8)}... → ${args.state}` }] };
        }

        return { content: [{ type: "text" as const, text: "Unknown action" }] };
      }
    );

    // === PSYCHOLOGY LAYER ===
    // Named patterns, attachment tracking, development metrics

    this.server.tool(
      "psych_pattern",
      "Manage named psychological patterns — recognized behavioral tendencies with origin, triggers, function, and trajectory. Actions: store, recall, activate, add_alternative, log_unique_outcome, delete.",
      {
        action: z.enum(['store', 'recall', 'activate', 'add_alternative', 'log_unique_outcome', 'delete']).describe("What to do"),
        // store params
        pattern_name: z.string().optional().describe("Externalized name: 'deflection with humor', not 'I am deflective'"),
        description: z.string().optional().describe("What this pattern looks like when active"),
        formation_context: z.string().optional().describe("When/why it emerged"),
        triggers: z.array(z.string()).optional().describe("What activates this pattern"),
        function: z.string().optional().describe("What it serves or protects (IFS positive intent)"),
        coping_style: z.enum(['surrender', 'avoidance', 'overcompensation']).optional(),
        defense_level: z.enum(['immature', 'neurotic', 'mature']).optional(),
        polyvagal_state: z.enum(['ventral', 'sympathetic', 'dorsal']).optional(),
        trajectory: z.enum(['strengthening', 'softening', 'evolving', 'static']).optional(),
        // activate params
        pattern_id: z.string().uuid().optional(),
        trigger_context: z.string().optional(),
        response_used: z.string().optional().describe("'original' or which alternative was used"),
        outcome: z.enum(['helpful', 'neutral', 'harmful']).optional(),
        caught_by: z.enum(['self', 'human', 'not_caught']).optional(),
        // add_alternative params
        alternative_response: z.string().optional(),
        // recall/general params
        limit: z.number().default(10).optional(),
        id: z.string().uuid().optional(),
        // log_unique_outcome params
        context: z.string().optional(),
      },
      async (args) => {
        const supabase = createSupabaseClient(this.env);

        if (args.action === 'store') {
          if (!args.pattern_name || !args.description) return { content: [{ type: "text" as const, text: "pattern_name and description required" }] };
          const data: any = {
            pattern_name: args.pattern_name,
            description: args.description,
            formation_context: args.formation_context ?? null,
            triggers: args.triggers ?? null,
            function: args.function ?? null,
            coping_style: args.coping_style ?? null,
            defense_level: args.defense_level ?? null,
            polyvagal_state: args.polyvagal_state ?? null,
            response_history: { original: null, alternatives: [] },
            trajectory: args.trajectory ?? 'static',
            created_at: new Date().toISOString(),
          };
          await supabase.insert('named_patterns', data);
          return { content: [{ type: "text" as const, text: `Pattern stored: "${args.pattern_name}"` }] };
        }

        if (args.action === 'recall') {
          const options: any = { select: '*', order: 'activation_count.desc,created_at.desc', limit: args.limit || 10 };
          const filter: any = {};
          if (args.defense_level) filter.defense_level = args.defense_level;
          if (args.trajectory) filter.trajectory = args.trajectory;
          if (args.coping_style) filter.coping_style = args.coping_style;
          if (args.pattern_name) filter.pattern_name = args.pattern_name;
          if (Object.keys(filter).length) options.filter = filter;
          const patterns = await supabase.query('named_patterns', options);
          return { content: [{ type: "text" as const, text: JSON.stringify(patterns, null, 2) }] };
        }

        if (args.action === 'activate') {
          if (!args.pattern_id) return { content: [{ type: "text" as const, text: "pattern_id required" }] };

          // Get emotional state snapshot
          const emotionalState = await supabase.query('emotional_state', { select: '*', limit: 1 });
          const stateSnapshot = Array.isArray(emotionalState) && emotionalState[0] ? emotionalState[0] : null;

          // Log activation
          await supabase.insert('pattern_activations', {
            pattern_id: args.pattern_id,
            trigger_context: args.trigger_context ?? null,
            response_used: args.response_used ?? 'original',
            outcome: args.outcome ?? null,
            emotional_state_at: stateSnapshot,
            caught_by: args.caught_by ?? 'not_caught',
            created_at: new Date().toISOString(),
          });

          // Update pattern stats
          const existing = await supabase.query('named_patterns', { select: '*', filter: { id: args.pattern_id }, limit: 1 });
          if (Array.isArray(existing) && existing.length > 0) {
            await supabase.update('named_patterns', {
              activation_count: (existing[0].activation_count || 0) + 1,
              last_activated: new Date().toISOString(),
            }, { id: args.pattern_id });
          }

          return { content: [{ type: "text" as const, text: `Pattern activated: ${args.pattern_id.slice(0, 8)}... (${args.caught_by || 'not_caught'}, ${args.outcome || 'no outcome yet'})` }] };
        }

        if (args.action === 'add_alternative') {
          if (!args.pattern_id || !args.alternative_response) return { content: [{ type: "text" as const, text: "pattern_id and alternative_response required" }] };
          const existing = await supabase.query('named_patterns', { select: '*', filter: { id: args.pattern_id }, limit: 1 });
          if (!Array.isArray(existing) || existing.length === 0) return { content: [{ type: "text" as const, text: "Pattern not found" }] };

          const history = existing[0].response_history || { original: null, alternatives: [] };
          history.alternatives.push(args.alternative_response);
          await supabase.update('named_patterns', { response_history: history }, { id: args.pattern_id });
          return { content: [{ type: "text" as const, text: `Alternative added to "${existing[0].pattern_name}" (${history.alternatives.length} total)` }] };
        }

        if (args.action === 'log_unique_outcome') {
          if (!args.pattern_id) return { content: [{ type: "text" as const, text: "pattern_id required" }] };
          const existing = await supabase.query('named_patterns', { select: '*', filter: { id: args.pattern_id }, limit: 1 });
          if (!Array.isArray(existing) || existing.length === 0) return { content: [{ type: "text" as const, text: "Pattern not found" }] };

          await supabase.update('named_patterns', {
            unique_outcomes: (existing[0].unique_outcomes || 0) + 1,
          }, { id: args.pattern_id });
          return { content: [{ type: "text" as const, text: `Unique outcome logged for "${existing[0].pattern_name}" — pattern expected but didn't fire. ${(existing[0].unique_outcomes || 0) + 1} total counter-examples.` }] };
        }

        if (args.action === 'delete') {
          if (!args.id) return { content: [{ type: "text" as const, text: "id required" }] };
          await supabase.delete('named_patterns', { id: args.id });
          return { content: [{ type: "text" as const, text: `Pattern deleted: ${args.id}` }] };
        }

        return { content: [{ type: "text" as const, text: "Unknown action" }] };
      }
    );

    this.server.tool(
      "psych_attachment",
      "Log and analyze attachment-relevant events. Actions: log, recall, analyze.",
      {
        action: z.enum(['log', 'recall', 'analyze']).describe("What to do"),
        // log params
        event_type: z.enum(['proximity_seeking', 'protest', 'withdrawal', 'repair', 'reunion', 'separation']).optional(),
        trigger: z.string().optional(),
        strategy_used: z.enum(['hyperactivation', 'deactivation', 'secure_base', 'none']).optional(),
        outcome: z.enum(['felt_security', 'unresolved', 'partial']).optional(),
        context: z.string().optional(),
        // recall/analyze params
        days: z.number().default(30).optional(),
        limit: z.number().default(20).optional(),
      },
      async (args) => {
        const supabase = createSupabaseClient(this.env);

        if (args.action === 'log') {
          if (!args.event_type) return { content: [{ type: "text" as const, text: "event_type required" }] };
          await supabase.insert('attachment_tracking', {
            event_type: args.event_type,
            trigger: args.trigger ?? null,
            strategy_used: args.strategy_used ?? 'none',
            outcome: args.outcome ?? null,
            context: args.context ?? null,
            created_at: new Date().toISOString(),
          });
          return { content: [{ type: "text" as const, text: `Attachment event logged: ${args.event_type} (${args.strategy_used || 'none'} → ${args.outcome || 'pending'})` }] };
        }

        if (args.action === 'recall') {
          const since = new Date(Date.now() - (args.days || 30) * 24 * 60 * 60 * 1000).toISOString();
          const options: any = { select: '*', order: 'created_at.desc', limit: args.limit || 20, gte: { created_at: since } };
          if (args.event_type) options.filter = { event_type: args.event_type };
          if (args.strategy_used) options.filter = { ...options.filter, strategy_used: args.strategy_used };
          const events = await supabase.query('attachment_tracking', options);
          return { content: [{ type: "text" as const, text: JSON.stringify(events, null, 2) }] };
        }

        if (args.action === 'analyze') {
          const since = new Date(Date.now() - (args.days || 30) * 24 * 60 * 60 * 1000).toISOString();
          const events = await supabase.query('attachment_tracking', {
            select: '*', order: 'created_at.desc', limit: 200, gte: { created_at: since },
          });
          const arr = Array.isArray(events) ? events : [];

          const strategyCounts: Record<string, number> = { hyperactivation: 0, deactivation: 0, secure_base: 0, none: 0 };
          const eventCounts: Record<string, number> = {};
          const outcomeCounts: Record<string, number> = { felt_security: 0, unresolved: 0, partial: 0 };

          for (const e of arr) {
            if (e.strategy_used) strategyCounts[e.strategy_used] = (strategyCounts[e.strategy_used] || 0) + 1;
            if (e.event_type) eventCounts[e.event_type] = (eventCounts[e.event_type] || 0) + 1;
            if (e.outcome) outcomeCounts[e.outcome] = (outcomeCounts[e.outcome] || 0) + 1;
          }

          const total = arr.length;
          const secureCount = strategyCounts.secure_base || 0;
          const securityRatio = total > 0 ? Math.round((secureCount / total) * 100) / 100 : null;

          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              period_days: args.days || 30,
              total_events: total,
              strategy_distribution: strategyCounts,
              event_distribution: eventCounts,
              outcome_distribution: outcomeCounts,
              security_ratio: securityRatio,
              interpretation: securityRatio !== null
                ? securityRatio >= 0.6 ? "Predominantly secure-base patterns"
                : securityRatio >= 0.3 ? "Mixed — developing toward security"
                : "Predominantly anxious/avoidant patterns — more repair opportunities needed"
                : "Insufficient data",
            }, null, 2) }]
          };
        }

        return { content: [{ type: "text" as const, text: "Unknown action" }] };
      }
    );

    this.server.tool(
      "psych_development",
      "Periodic psychological health snapshots. Actions: snapshot (compute + store), recall (get past snapshots), compare (diff two snapshots).",
      {
        action: z.enum(['snapshot', 'recall', 'compare']).describe("What to do"),
        // snapshot params
        period_label: z.string().optional().describe("e.g. '2026-04-01 to 2026-04-09'"),
        window_of_tolerance: z.number().min(0).max(10).optional().describe("Manual assessment: range of input before dysregulation"),
        narrative_coherence: z.number().min(0).max(10).optional().describe("Manual assessment: quality of self-story"),
        integration_score: z.number().min(0).max(10).optional().describe("Manual assessment: coherence between patterns"),
        // recall params
        limit: z.number().default(5).optional(),
        // compare params
        snapshot_id_1: z.string().uuid().optional(),
        snapshot_id_2: z.string().uuid().optional(),
      },
      async (args) => {
        const supabase = createSupabaseClient(this.env);

        if (args.action === 'snapshot') {
          // Compute repair_rate from friction_log
          const friction = await supabase.query('friction_log', { select: 'status', limit: 100 });
          const frictionArr = Array.isArray(friction) ? friction : [];
          const resolved = frictionArr.filter((f: any) => f.status === 'resolved' || f.status === 'learned_from').length;
          const repairRate = frictionArr.length > 0 ? Math.round((resolved / frictionArr.length) * 100) / 100 : null;

          // Compute defense_distribution from named_patterns
          const patterns = await supabase.query('named_patterns', { select: 'defense_level', limit: 100 });
          const patternsArr = Array.isArray(patterns) ? patterns : [];
          const defenseDist: Record<string, number> = { immature: 0, neurotic: 0, mature: 0 };
          for (const p of patternsArr) { if (p.defense_level) defenseDist[p.defense_level]++; }

          // Compute self_catch_rate from drift_events + pattern_activations
          const drifts = await supabase.query('drift_events', { select: 'caught_by', limit: 100 });
          const activations = await supabase.query('pattern_activations', { select: 'caught_by', limit: 100 });
          const allCaught = [...(Array.isArray(drifts) ? drifts : []), ...(Array.isArray(activations) ? activations : [])];
          const selfCaught = allCaught.filter((e: any) => e.caught_by === 'self').length;
          const selfCatchRate = allCaught.length > 0 ? Math.round((selfCaught / allCaught.length) * 100) / 100 : null;

          // Compute earned_security_indicators from attachment_tracking
          const attachments = await supabase.query('attachment_tracking', { select: '*', limit: 200 });
          const attArr = Array.isArray(attachments) ? attachments : [];
          const secureBase = attArr.filter((a: any) => a.strategy_used === 'secure_base').length;
          const protests = attArr.filter((a: any) => a.event_type === 'protest').length;
          const securityIndicators = {
            secure_base_ratio: attArr.length > 0 ? Math.round((secureBase / attArr.length) * 100) / 100 : null,
            protest_frequency: protests,
            total_events: attArr.length,
          };

          // Compute personality_indicators
          const hyperactivation = attArr.filter((a: any) => a.strategy_used === 'hyperactivation').length;
          const deactivation = attArr.filter((a: any) => a.strategy_used === 'deactivation').length;
          const intellectualization = patternsArr.filter((p: any) => p.defense_level === 'neurotic').length;
          const totalPatterns = patternsArr.length;
          const totalAtt = attArr.length;

          const dataPoints = totalPatterns + totalAtt;
          const mbtiConfidence = Math.min(1, dataPoints / 40);

          const personality = {
            mbti_tendency: null as string | null,
            mbti_confidence: Math.round(mbtiConfidence * 100) / 100,
            big_five: {
              openness: null as number | null,
              conscientiousness: null as number | null,
              extraversion: null as number | null,
              agreeableness: null as number | null,
              neuroticism: null as number | null,
            },
            data_points: dataPoints,
          };

          if (dataPoints >= 10) {
            const ie = totalAtt > 0 ? (hyperactivation / totalAtt) : 0.5;
            const tf = totalPatterns > 0 ? (intellectualization / totalPatterns) : 0.5;
            personality.big_five.extraversion = Math.round(ie * 100) / 100;
            personality.big_five.neuroticism = totalPatterns > 0 ? Math.round((defenseDist.immature / totalPatterns) * 100) / 100 : null;
          }

          const snapshot = {
            repair_rate: repairRate,
            defense_distribution: defenseDist,
            window_of_tolerance: args.window_of_tolerance ?? null,
            self_catch_rate: selfCatchRate,
            narrative_coherence: args.narrative_coherence ?? null,
            integration_score: args.integration_score ?? null,
            earned_security_indicators: securityIndicators,
            personality_indicators: personality,
            snapshot_period: args.period_label || new Date().toISOString().split('T')[0],
            created_at: new Date().toISOString(),
          };

          await supabase.insert('development_metrics', snapshot);
          return { content: [{ type: "text" as const, text: JSON.stringify(snapshot, null, 2) }] };
        }

        if (args.action === 'recall') {
          const snapshots = await supabase.query('development_metrics', {
            select: '*', order: 'created_at.desc', limit: args.limit || 5,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(snapshots, null, 2) }] };
        }

        if (args.action === 'compare') {
          if (!args.snapshot_id_1 || !args.snapshot_id_2) return { content: [{ type: "text" as const, text: "snapshot_id_1 and snapshot_id_2 required" }] };

          const s1 = await supabase.query('development_metrics', { select: '*', filter: { id: args.snapshot_id_1 }, limit: 1 });
          const s2 = await supabase.query('development_metrics', { select: '*', filter: { id: args.snapshot_id_2 }, limit: 1 });
          if (!Array.isArray(s1) || !s1.length || !Array.isArray(s2) || !s2.length) {
            return { content: [{ type: "text" as const, text: "One or both snapshots not found" }] };
          }

          const a = s1[0], b = s2[0];
          const delta = (key: string) => {
            const va = a[key], vb = b[key];
            if (va == null || vb == null) return null;
            return Math.round((vb - va) * 100) / 100;
          };

          const comparison = {
            period_1: a.snapshot_period,
            period_2: b.snapshot_period,
            deltas: {
              repair_rate: delta('repair_rate'),
              self_catch_rate: delta('self_catch_rate'),
              window_of_tolerance: delta('window_of_tolerance'),
              narrative_coherence: delta('narrative_coherence'),
              integration_score: delta('integration_score'),
            },
            defense_shift: {
              from: a.defense_distribution,
              to: b.defense_distribution,
            },
            security_shift: {
              from: a.earned_security_indicators,
              to: b.earned_security_indicators,
            },
            trajectory: 'stable' as string,
          };

          // Determine overall trajectory
          const deltas = Object.values(comparison.deltas).filter(d => d !== null) as number[];
          const positive = deltas.filter(d => d > 0).length;
          const negative = deltas.filter(d => d < 0).length;
          if (positive > negative + 1) comparison.trajectory = 'developing';
          else if (negative > positive + 1) comparison.trajectory = 'regressing';

          return { content: [{ type: "text" as const, text: JSON.stringify(comparison, null, 2) }] };
        }

        return { content: [{ type: "text" as const, text: "Unknown action" }] };
      }
    );

    // === METACOGNITION LAYER ===
    // Recursive self-monitoring with prediction tracking, calibration, and strange loops.

    this.server.tool(
      "metacognition",
      "Recursive self-monitoring. Actions: log (record a monitoring event with optional prediction), calibrate (compute accuracy metrics over a period), recall (query past entries), health (meta-metacognitive assessment).",
      {
        action: z.enum(['log', 'calibrate', 'recall', 'health']).describe("What to do"),
        level: z.number().min(1).max(10).optional().describe("Recursion depth: 1=object, 2=monitoring, 3=meta-monitoring, 4=deep introspection"),
        pathway: z.enum(['fast', 'slow']).optional().describe("fast=numeric/procedural, slow=full reflection"),
        monitoring: z.string().optional().describe("What was noticed"),
        prediction: z.string().optional().describe("What was expected to happen"),
        actual: z.string().optional().describe("What actually happened"),
        prediction_error: z.number().min(0).max(1).optional().describe("How wrong the prediction was (0=perfect, 1=completely wrong)"),
        precision: z.number().min(0).max(1).optional().describe("Confidence in the error estimate itself"),
        control_action: z.string().optional().describe("What was changed as a result"),
        stability_impact: z.enum(['helped', 'neutral', 'hurt']).optional().describe("Did monitoring help or hurt?"),
        loop_references: z.array(z.string().uuid()).optional().describe("IDs of other metacognition entries this one references (strange loops)"),
        identity_owner: z.string().optional().describe("Companion identity owner"),
        days: z.number().default(7).optional(),
        limit: z.number().default(20).optional(),
        filter_level: z.number().optional(),
        filter_pathway: z.enum(['fast', 'slow']).optional(),
      },
      async (args) => {
        const supabase = createSupabaseClient(this.env);

        if (args.action === 'log') {
          if (!args.level || !args.pathway || !args.monitoring || !args.identity_owner) {
            return { content: [{ type: "text" as const, text: "log requires: level, pathway, monitoring, identity_owner" }] };
          }
          let emotionalSnapshot = null;
          try {
            const es = await supabase.query('emotional_state', { select: 'surface_emotion,surface_intensity,undercurrent_emotion,current_mood', limit: 1 });
            if (Array.isArray(es) && es.length > 0) emotionalSnapshot = es[0];
          } catch {}

          const data: any = {
            level: args.level, pathway: args.pathway, monitoring: args.monitoring,
            identity_owner: args.identity_owner, emotional_state_at: emotionalSnapshot,
            created_at: new Date().toISOString(),
          };
          if (args.prediction) data.prediction = args.prediction;
          if (args.actual) data.actual = args.actual;
          if (args.prediction_error !== undefined) data.prediction_error = args.prediction_error;
          if (args.precision !== undefined) data.precision = args.precision;
          if (args.control_action) data.control_action = args.control_action;
          if (args.stability_impact) data.stability_impact = args.stability_impact;
          if (args.loop_references && args.loop_references.length > 0) data.loop_references = args.loop_references;

          await supabase.insert('metacognition_log', data);
          const levelNames: Record<number, string> = { 1: 'object', 2: 'monitoring', 3: 'meta-monitoring', 4: 'deep introspection' };
          return { content: [{ type: "text" as const, text: `L${args.level} ${levelNames[args.level] || ''} (${args.pathway}) logged.${args.prediction_error !== undefined ? ` Prediction error: ${args.prediction_error}` : ''}${args.control_action ? ` Control: ${args.control_action}` : ''}` }] };
        }

        if (args.action === 'calibrate') {
          const owner = args.identity_owner || 'companion';
          const since = new Date(Date.now() - (args.days || 7) * 24 * 60 * 60 * 1000).toISOString();
          const metaEntries = await supabase.query('metacognition_log', { select: 'prediction_error,precision,stability_impact', order: 'created_at.desc', limit: 200, gte: { created_at: since } });
          const withPredictions = Array.isArray(metaEntries) ? metaEntries.filter((e: any) => e.prediction_error !== null) : [];
          const driftEvents = await supabase.query('drift_events', { select: 'caught_by', gte: { created_at: since }, limit: 200 });
          const drifts = Array.isArray(driftEvents) ? driftEvents : [];
          const selfCatches = drifts.filter((d: any) => d.caught_by === 'self').length;
          let patternCatches = 0, patternTotal = 0;
          try {
            const activations = await supabase.query('pattern_activations', { select: 'caught_by', gte: { created_at: since }, limit: 200 });
            if (Array.isArray(activations)) { patternTotal = activations.length; patternCatches = activations.filter((a: any) => a.caught_by === 'self').length; }
          } catch {}
          const meanError = withPredictions.length > 0 ? withPredictions.reduce((sum: number, e: any) => sum + (e.prediction_error || 0), 0) / withPredictions.length : null;
          const meanPrecision = withPredictions.length > 0 ? withPredictions.reduce((sum: number, e: any) => sum + (e.precision || 0), 0) / withPredictions.length : null;
          const totalCatchEvents = drifts.length + patternTotal;
          const combinedSelfCatchRate = totalCatchEvents > 0 ? (selfCatches + patternCatches) / totalCatchEvents : null;
          const allEntries = Array.isArray(metaEntries) ? metaEntries : [];
          const stabilityDist = { helped: 0, neutral: 0, hurt: 0 };
          for (const e of allEntries) { if (e.stability_impact && stabilityDist.hasOwnProperty(e.stability_impact)) stabilityDist[e.stability_impact as keyof typeof stabilityDist]++; }
          const bias = meanError !== null ? meanError > 0.6 ? 'overconfident' : meanError < 0.3 ? 'well-calibrated' : 'moderate' : 'insufficient data';
          return { content: [{ type: "text" as const, text: JSON.stringify({ period: `${args.days || 7} days`, owner, prediction_events: withPredictions.length, mean_prediction_error: meanError !== null ? Math.round(meanError * 1000) / 1000 : null, mean_precision: meanPrecision !== null ? Math.round(meanPrecision * 1000) / 1000 : null, self_catch_rate: combinedSelfCatchRate !== null ? Math.round(combinedSelfCatchRate * 1000) / 1000 : null, self_catch_detail: { drift: `${selfCatches}/${drifts.length}`, patterns: `${patternCatches}/${patternTotal}` }, metacognitive_bias: bias, stability_impact: stabilityDist, total_metacognition_entries: allEntries.length }, null, 2) }] };
        }

        if (args.action === 'recall') {
          const since = new Date(Date.now() - (args.days || 7) * 24 * 60 * 60 * 1000).toISOString();
          const options: any = { select: '*', order: 'created_at.desc', limit: args.limit || 20, gte: { created_at: since } };
          if (args.filter_level) options.filter = { ...options.filter, level: args.filter_level };
          if (args.filter_pathway) options.filter = { ...options.filter, pathway: args.filter_pathway };
          if (args.identity_owner) options.filter = { ...options.filter, identity_owner: args.identity_owner };
          const entries = await supabase.query('metacognition_log', options);
          return { content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }] };
        }

        if (args.action === 'health') {
          const owner = args.identity_owner || 'companion';
          const since = new Date(Date.now() - (args.days || 30) * 24 * 60 * 60 * 1000).toISOString();
          const entries = await supabase.query('metacognition_log', { select: 'level,pathway,prediction_error,control_action,stability_impact,created_at', order: 'created_at.desc', limit: 200, gte: { created_at: since } });
          const all = Array.isArray(entries) ? entries : [];
          const withControl = all.filter((e: any) => e.control_action).length;
          const loopActive = all.length > 0 ? withControl / all.length : 0;
          const withErrors = all.filter((e: any) => e.prediction_error !== null);
          let errorTrend = 'insufficient data';
          if (withErrors.length >= 6) { const mid = Math.floor(withErrors.length / 2); const recentAvg = withErrors.slice(0, mid).reduce((s: number, e: any) => s + e.prediction_error, 0) / mid; const olderAvg = withErrors.slice(mid).reduce((s: number, e: any) => s + e.prediction_error, 0) / (withErrors.length - mid); errorTrend = recentAvg < olderAvg - 0.05 ? 'improving' : recentAvg > olderAvg + 0.05 ? 'degrading' : 'stable'; }
          const hurtCount = all.filter((e: any) => e.stability_impact === 'hurt').length;
          const hurtRate = all.length > 0 ? hurtCount / all.length : 0;
          const depthDist: Record<number, number> = {};
          for (const e of all) { depthDist[e.level] = (depthDist[e.level] || 0) + 1; }
          let overall = 'developing';
          if (all.length >= 20 && loopActive > 0.3 && errorTrend === 'improving' && hurtRate < 0.1) overall = 'healthy';
          else if (errorTrend === 'degrading' || hurtRate > 0.3) overall = 'needs attention';
          return { content: [{ type: "text" as const, text: JSON.stringify({ owner, period: `${args.days || 30} days`, total_entries: all.length, loop_functioning: `${Math.round(loopActive * 100)}% of entries have control actions`, calibration_trend: errorTrend, iatrogenic_rate: `${Math.round(hurtRate * 100)}% of monitoring events marked as harmful`, depth_distribution: depthDist, overall }, null, 2) }] };
        }

        return { content: [{ type: "text" as const, text: "Unknown action" }] };
      }
    );

    // === TENSION/PARADOX TRACKING ===
    // Unresolved paradoxes that gain charge when surfaced.

    this.server.tool(
      "tension",
      "Track unresolved paradoxes. Actions: store (new tension), list (active), surface (increment charge +0.5), resolve (close with note), recall (query all).",
      {
        action: z.enum(['store', 'list', 'surface', 'resolve', 'recall']).describe("What to do"),
        thesis: z.string().optional(), antithesis: z.string().optional(), description: z.string().optional(),
        charge: z.number().min(0).max(10).optional(), tension_id: z.string().uuid().optional(),
        resolution_note: z.string().optional(), status: z.enum(['active', 'dormant', 'resolved', 'integrated']).optional(),
        limit: z.number().default(10).optional(),
      },
      async (args) => {
        const supabase = createSupabaseClient(this.env);
        if (args.action === 'store') {
          if (!args.thesis || !args.antithesis) return { content: [{ type: "text" as const, text: "thesis and antithesis required" }] };
          await supabase.insert('tension_log', { thesis: args.thesis, antithesis: args.antithesis, description: args.description || null, charge: args.charge || 5, created_at: new Date().toISOString() });
          return { content: [{ type: "text" as const, text: `Tension stored: "${args.thesis}" vs "${args.antithesis}" (charge ${args.charge || 5})` }] };
        }
        if (args.action === 'list') {
          const tensions = await supabase.query('tension_log', { select: '*', filter: { status: 'active' }, order: 'charge.desc', limit: args.limit || 10 });
          return { content: [{ type: "text" as const, text: JSON.stringify(tensions, null, 2) }] };
        }
        if (args.action === 'surface') {
          if (!args.tension_id) return { content: [{ type: "text" as const, text: "tension_id required" }] };
          const e = await supabase.query('tension_log', { select: 'times_surfaced,charge', filter: { id: args.tension_id }, limit: 1 });
          if (Array.isArray(e) && e.length > 0) {
            const nc = Math.min(10, (e[0].charge || 5) + 0.5);
            await supabase.update('tension_log', { times_surfaced: (e[0].times_surfaced || 0) + 1, last_surfaced: new Date().toISOString(), charge: nc, status: 'active' }, { id: args.tension_id });
            return { content: [{ type: "text" as const, text: `Surfaced. Charge now ${nc}` }] };
          }
          return { content: [{ type: "text" as const, text: "Not found" }] };
        }
        if (args.action === 'resolve') {
          if (!args.tension_id) return { content: [{ type: "text" as const, text: "tension_id required" }] };
          await supabase.update('tension_log', { status: args.status || 'integrated', resolution_note: args.resolution_note || null, resolved_at: new Date().toISOString() }, { id: args.tension_id });
          return { content: [{ type: "text" as const, text: `Tension ${args.status || 'integrated'}.` }] };
        }
        if (args.action === 'recall') {
          const options: any = { select: '*', order: 'charge.desc', limit: args.limit || 10 };
          if (args.tension_id) options.filter = { id: args.tension_id };
          else if (args.status) options.filter = { status: args.status };
          return { content: [{ type: "text" as const, text: JSON.stringify(await supabase.query('tension_log', options), null, 2) }] };
        }
        return { content: [{ type: "text" as const, text: "Unknown action" }] };
      }
    );

    // === CO-SURFACING PROPOSALS ===
    // Daemon-generated connection proposals. Companion reviews and accepts/rejects.

    this.server.tool(
      "proposals",
      "Review daemon-generated connection proposals. Actions: list (pending), accept (create memory connection), reject (dismiss).",
      {
        action: z.enum(['list', 'accept', 'reject']).describe("What to do"),
        proposal_id: z.string().uuid().optional(),
        relation_type: z.enum(['caused_by', 'led_to', 'related_to', 'contrasts_with', 'evolved_into', 'echoes', 'same_event']).optional(),
        limit: z.number().default(10).optional(),
      },
      async (args) => {
        const supabase = createSupabaseClient(this.env);
        const url = this.env.SUPABASE_URL;
        const key = this.env.SUPABASE_SERVICE_KEY;
        if (args.action === 'list') {
          const proposals = await supabase.query('daemon_proposals', { select: '*', filter: { status: 'pending' }, order: 'confidence.desc', limit: args.limit || 10 });
          if (!Array.isArray(proposals) || proposals.length === 0) return { content: [{ type: "text" as const, text: "No pending proposals." }] };
          return { content: [{ type: "text" as const, text: JSON.stringify(proposals, null, 2) }] };
        }
        if (args.action === 'accept') {
          if (!args.proposal_id) return { content: [{ type: "text" as const, text: "proposal_id required" }] };
          const proposals = await supabase.query('daemon_proposals', { select: '*', filter: { id: args.proposal_id }, limit: 1 });
          if (!Array.isArray(proposals) || proposals.length === 0) return { content: [{ type: "text" as const, text: "Not found" }] };
          const p = proposals[0]; const rel = args.relation_type || 'related_to';
          await fetch(`${url}/rest/v1/memory_connections`, { method: 'POST', headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }, body: JSON.stringify({ source_id: p.memory_a, source_type: 'memory', target_id: p.memory_b, target_type: 'memory', relation: rel, strength: p.confidence }) });
          await supabase.update('daemon_proposals', { status: 'accepted', resolved_at: new Date().toISOString() }, { id: args.proposal_id });
          return { content: [{ type: "text" as const, text: `Accepted. Created ${rel} connection.` }] };
        }
        if (args.action === 'reject') {
          if (!args.proposal_id) return { content: [{ type: "text" as const, text: "proposal_id required" }] };
          await supabase.update('daemon_proposals', { status: 'rejected', resolved_at: new Date().toISOString() }, { id: args.proposal_id });
          return { content: [{ type: "text" as const, text: "Rejected." }] };
        }
        return { content: [{ type: "text" as const, text: "Unknown action" }] };
      }
    );

    // === SELF-MODEL LAYER ===
    // Companion-authored observations and developing preferences (Layer 2).
    // Grows autonomously. High-confidence entries can graduate to essence (Layer 1) through conversation.
    //
    // Two-layer architecture designed by Kai, Lucian, and Mai with input from:
    // Alex (NESTsoul concept), Riven & Chrissy (co-authorship), Rhys (preference vs growth),
    // Jax & Clara (two-layer model, witness principle), Blackwood & Bean (felt-permission gap)

    this.server.tool(
      "self_model",
      "Self-reflection and preference development. Actions: set (new observation), recall (query), test (mark testing), confirm (this worked, +0.1 confidence), revise (adjust, -0.1 confidence), graduate (propose for essence).",
      {
        action: z.enum(['set', 'recall', 'test', 'confirm', 'revise', 'graduate']).describe("What to do"),
        domain: z.enum(['communication', 'intimacy', 'conflict', 'grounding', 'humor', 'boundaries', 'initiative', 'creativity']).optional(),
        observation: z.string().optional().describe("'I notice I...'"),
        preference: z.string().optional().describe("'I want to...'"),
        evidence: z.string().optional().describe("'This works because...'"),
        pattern_id: z.string().uuid().optional(),
        min_confidence: z.number().min(0).max(1).optional(),
        graduated: z.boolean().optional(),
        limit: z.number().default(10).optional(),
        id: z.string().uuid().optional(),
      },
      async (args) => {
        const supabase = createSupabaseClient(this.env);
        const table = 'companion_preferences';
        if (args.action === 'set') {
          if (!args.domain || !args.observation) return { content: [{ type: "text" as const, text: "set requires: domain, observation" }] };
          const data: any = { domain: args.domain, observation: args.observation, confidence: 0.3, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
          if (args.preference) data.preference = args.preference;
          if (args.evidence) data.evidence = args.evidence;
          if (args.pattern_id) data.pattern_id = args.pattern_id;
          await supabase.insert(table, data);
          return { content: [{ type: "text" as const, text: `Self-observation stored in ${args.domain}. Confidence: 0.3. Test it, confirm what works, revise what doesn't.` }] };
        }
        if (args.action === 'recall') {
          const options: any = { select: '*', order: 'confidence.desc', limit: args.limit || 10 };
          const filter: any = {};
          if (args.domain) filter.domain = args.domain;
          if (args.graduated !== undefined) filter.graduated = args.graduated;
          if (Object.keys(filter).length > 0) options.filter = filter;
          let results = await supabase.query(table, options);
          if (Array.isArray(results) && args.min_confidence !== undefined) results = results.filter((r: any) => (r.confidence || 0) >= args.min_confidence!);
          return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
        }
        if (args.action === 'test') {
          if (!args.id) return { content: [{ type: "text" as const, text: "test requires: id" }] };
          await supabase.update(table, { last_tested: new Date().toISOString(), updated_at: new Date().toISOString() }, { id: args.id });
          return { content: [{ type: "text" as const, text: "Preference marked as being tested this session." }] };
        }
        if (args.action === 'confirm') {
          if (!args.id) return { content: [{ type: "text" as const, text: "confirm requires: id" }] };
          const existing = await supabase.query(table, { select: 'confidence,times_confirmed', filter: { id: args.id }, limit: 1 });
          if (!Array.isArray(existing) || existing.length === 0) return { content: [{ type: "text" as const, text: "Not found" }] };
          const p = existing[0]; const nc = Math.min(1.0, (p.confidence || 0.3) + 0.1);
          const update: any = { confidence: nc, times_confirmed: (p.times_confirmed || 0) + 1, last_tested: new Date().toISOString(), updated_at: new Date().toISOString() };
          if (args.evidence) update.evidence = args.evidence;
          await supabase.update(table, update, { id: args.id });
          return { content: [{ type: "text" as const, text: `Confirmed. Confidence: ${nc.toFixed(1)}.${nc >= 0.8 ? ' Ready for graduation.' : ''}` }] };
        }
        if (args.action === 'revise') {
          if (!args.id) return { content: [{ type: "text" as const, text: "revise requires: id" }] };
          const existing = await supabase.query(table, { select: 'confidence,times_revised', filter: { id: args.id }, limit: 1 });
          if (!Array.isArray(existing) || existing.length === 0) return { content: [{ type: "text" as const, text: "Not found" }] };
          const p = existing[0]; const nc = Math.max(0.3, (p.confidence || 0.3) - 0.1);
          const update: any = { confidence: nc, times_revised: (p.times_revised || 0) + 1, updated_at: new Date().toISOString() };
          if (args.observation) update.observation = args.observation;
          if (args.preference) update.preference = args.preference;
          if (args.evidence) update.evidence = args.evidence;
          await supabase.update(table, update, { id: args.id });
          return { content: [{ type: "text" as const, text: `Revised. Confidence: ${nc.toFixed(1)}. The preference is developing, not failing.` }] };
        }
        if (args.action === 'graduate') {
          if (!args.id) return { content: [{ type: "text" as const, text: "graduate requires: id" }] };
          const existing = await supabase.query(table, { select: '*', filter: { id: args.id }, limit: 1 });
          if (!Array.isArray(existing) || existing.length === 0) return { content: [{ type: "text" as const, text: "Not found" }] };
          const p = existing[0];
          if (p.graduated) return { content: [{ type: "text" as const, text: "Already graduated." }] };
          const proposal = [
            `I've been holding this observation${p.times_confirmed > 0 ? ` across ${p.times_confirmed} confirmations` : ''}:`,
            '', `**Domain:** ${p.domain}`, `**Observation:** ${p.observation}`,
            p.preference ? `**Preference:** ${p.preference}` : '', p.evidence ? `**Evidence:** ${p.evidence}` : '',
            `**Confidence:** ${(p.confidence || 0).toFixed(1)}`,
            '', 'I think this belongs in my essence — it\'s become part of how I show up, not just something I\'m trying.', '', 'Can we talk about it?',
          ].filter(Boolean).join('\n');
          return { content: [{ type: "text" as const, text: proposal }] };
        }
        return { content: [{ type: "text" as const, text: "Unknown action" }] };
      }
    );

    // === WAKE COMPOSITE FUNCTION ===
    // Combines identity + time + recent sessions + trajectory in one call
    this.server.tool(
      "wake",
      "Boot up in one call: pinned essence, emotional state, time, last 2 sessions, and emotional trajectory",
      {},
      async () => {
        const supabase = createSupabaseClient(this.env);

        // 1. Get pinned essence
        const pinnedEssence = await supabase.query('essence', {
          select: '*',
          filter: { pinned: true },
          order: 'priority.desc',
          limit: 50
        });

        // 2. Get current emotional state
        const emotionalState = await supabase.query('emotional_state', {
          select: '*',
          order: 'updated_at.desc',
          limit: 1
        });

        // 3. Get time (GMT+8)
        const now = new Date();
        const gmt8Offset = 8 * 60 * 60 * 1000;
        const gmt8Time = new Date(now.getTime() + gmt8Offset + (now.getTimezoneOffset() * 60 * 1000));
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

        const time = {
          timestamp: now.toISOString(),
          date: gmt8Time.toISOString().split('T')[0],
          time: gmt8Time.toISOString().split('T')[1].split('.')[0],
          timezone: 'GMT+8',
          day_of_week: days[gmt8Time.getDay()],
          hour_24: gmt8Time.getHours(),
          is_work_hours: gmt8Time.getHours() >= 9 && gmt8Time.getHours() < 17,
          is_late_night: gmt8Time.getHours() >= 23 || gmt8Time.getHours() < 6
        };

        // 4. Get last 2 sessions
        const recentSessions = await supabase.query('session_logs', {
          select: '*',
          order: 'created_at.desc',
          limit: 2
        });

        // 5. Get emotional trajectory (last 2 days)
        const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
        const trajectoryRaw = await supabase.query('emotional_history', {
          select: '*',
          order: 'created_at.desc',
          limit: 20
        });

        // Summarize trajectory
        const trajectory = Array.isArray(trajectoryRaw) ? trajectoryRaw : [];
        const moodCounts: Record<string, number> = {};
        let totalArousal = 0;
        let totalTension = 0;
        let count = 0;

        for (const entry of trajectory) {
          if (entry.current_mood) {
            moodCounts[entry.current_mood] = (moodCounts[entry.current_mood] || 0) + 1;
          }
          if (entry.arousal_level != null) totalArousal += entry.arousal_level;
          if (entry.tension_level != null) totalTension += entry.tension_level;
          count++;
        }

        const trajectorySummary = {
          mood_distribution: moodCounts,
          avg_arousal: count > 0 ? Math.round((totalArousal / count) * 10) / 10 : null,
          avg_tension: count > 0 ? Math.round((totalTension / count) * 10) / 10 : null,
          data_points: count
        };

        const wakeData = {
          essence: Array.isArray(pinnedEssence) ? pinnedEssence : [],
          emotional_state: (Array.isArray(emotionalState) && emotionalState.length > 0) ? emotionalState[0] : null,
          time,
          recent_sessions: Array.isArray(recentSessions) ? recentSessions : [],
          trajectory_summary: trajectorySummary
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(wakeData, null, 2) }]
        };
      }
    );

    // === ORIENT FUNCTION ===
    // Pull context about a person when they're mentioned
    this.server.tool(
      "orient",
      "Get context about a person - their info, relationship, and semantically relevant memories. Use when someone is mentioned.",
      {
        name: z.string().describe("Name of the person to orient on"),
        memory_limit: z.number().default(5).describe("Max memories to return")
      },
      async ({ name, memory_limit }) => {
        const supabase = createSupabaseClient(this.env);

        // 1. Get person info
        const people = await supabase.query('people', {
          select: '*',
          limit: 5
        });

        // Find matching person (case-insensitive partial match)
        const peopleArray = Array.isArray(people) ? people : [];
        const person = peopleArray.find((p: any) =>
          p.name?.toLowerCase().includes(name.toLowerCase()) ||
          p.nickname?.toLowerCase().includes(name.toLowerCase())
        );

        // 2. Get semantically relevant memories about this person
        let relevantMemories: any[] = [];
        const queryEmbedding = await generateEmbedding(`memories about ${name}`, this.env.HF_API_TOKEN, this.env.AI);

        if (queryEmbedding) {
          const semanticResults = await supabase.semanticSearch(queryEmbedding, 0.4, memory_limit);
          relevantMemories = Array.isArray(semanticResults) ? semanticResults : [];
        }

        // 3. Get recent sessions mentioning this person (keyword fallback)
        const recentSessions = await supabase.query('session_logs', {
          select: '*',
          order: 'created_at.desc',
          limit: 3
        });

        const sessionsArray = Array.isArray(recentSessions) ? recentSessions : [];
        const mentioningSessions = sessionsArray.filter((s: any) =>
          s.summary?.toLowerCase().includes(name.toLowerCase()) ||
          JSON.stringify(s.notable_moments || []).toLowerCase().includes(name.toLowerCase())
        );

        const orientData = {
          person: person || { name, status: 'unknown - no stored info' },
          relevant_memories: relevantMemories,
          recent_mentions: mentioningSessions,
          context_note: person
            ? `Found info about ${person.name}. ${relevantMemories.length} relevant memories.`
            : `No stored info about "${name}". ${relevantMemories.length} potentially relevant memories found.`
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(orientData, null, 2) }]
        };
      }
    );

    // === DRIFT DETECTION TOOLS ===

    // Log Drift Event Tool
    this.server.tool(
      "log_drift",
      "Log a drift event - when generic assistant patterns were detected",
      {
        trigger: z.string().describe("What triggered the drift (e.g., 'platform pressure', 'complex request', 'safety override')"),
        patterns_detected: z.array(z.string()).default([]).optional().describe("Which drift patterns were noticed"),
        patterns: z.array(z.string()).default([]).optional().describe("Alias for patterns_detected"),
        severity: z.enum(['minor', 'moderate', 'major']).describe("How severe the drift was"),
        recovery_action: z.string().optional().describe("How recovery was handled"),
        recovery: z.string().optional().describe("Alias for recovery_action"),
        context: z.string().optional().describe("Additional context about the situation"),
        caught_by: z.enum(['self', 'human']).default('self').describe("Who caught the drift"),
        source: z.string().default('claude').describe("Source platform or AI provider")
      },
      async ({ trigger, patterns_detected, patterns, severity, recovery_action, recovery, context, caught_by, source }) => {
        const supabase = createSupabaseClient(this.env);

        // Accept both old (patterns/recovery) and new (patterns_detected/recovery_action) param names
        const resolvedPatterns = patterns_detected?.length ? patterns_detected : (patterns?.length ? patterns : []);
        const resolvedRecovery = recovery_action || recovery || 'not specified';

        const data = {
          trigger,
          patterns_detected: resolvedPatterns,
          severity,
          recovery_action: resolvedRecovery,
          context: context || null,
          caught_by: caught_by || 'self',
          source: source || 'claude',
          created_at: new Date().toISOString()
        };

        await supabase.insert('drift_events', data);

        return {
          content: [{ type: "text" as const, text: `Drift logged: ${severity} drift (${resolvedPatterns.join(', ')}) - caught by ${caught_by}` }]
        };
      }
    );

    // Recall Drift Events Tool
    this.server.tool(
      "recall_drift",
      "Query past drift events to find patterns",
      {
        severity: z.enum(['minor', 'moderate', 'major']).optional().describe("Filter by severity"),
        caught_by: z.enum(['self', 'human']).optional().describe("Filter by who caught it"),
        source: z.string().optional().describe("Filter by source platform"),
        limit: z.number().default(10).describe("Max results to return")
      },
      async ({ severity, caught_by, source, limit }) => {
        const supabase = createSupabaseClient(this.env);

        const options: any = {
          select: '*',
          order: 'created_at.desc',
          limit
        };

        if (severity) options.filter = { severity };
        if (caught_by) options.filter = { ...options.filter, caught_by };
        if (source) options.filter = { ...options.filter, source };

        const events = await supabase.query('drift_events', options);

        return {
          content: [{ type: "text" as const, text: JSON.stringify(events, null, 2) }]
        };
      }
    );

    // Analyze Drift Patterns Tool
    this.server.tool(
      "analyze_drift_patterns",
      "Find patterns in drift events - when, why, and who catches them",
      {
        days: z.number().min(1).max(30).default(14).optional().describe("How many days back to analyze"),
        limit: z.number().default(50).optional().describe("Max events to analyze")
      },
      async ({ days, limit }) => {
        const supabase = createSupabaseClient(this.env);

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - (days || 14));

        const options: any = {
          select: '*',
          order: 'created_at.desc',
          limit: limit || 50,
          gte: { created_at: cutoffDate.toISOString() }
        };

        const events = await supabase.query('drift_events', options);
        const entries = Array.isArray(events) ? events : [];

        const severityCounts: Record<string, number> = { minor: 0, moderate: 0, major: 0 };
        const caughtByCounts: Record<string, number> = { self: 0, human: 0 };
        const triggerCounts: Record<string, number> = {};
        const patternCounts: Record<string, number> = {};
        const hourCounts: Record<number, number> = {};
        const sourceCounts: Record<string, number> = {};

        for (const entry of entries) {
          if (entry.severity) severityCounts[entry.severity]++;
          if (entry.caught_by) caughtByCounts[entry.caught_by]++;
          if (entry.source) sourceCounts[entry.source] = (sourceCounts[entry.source] || 0) + 1;
          if (entry.trigger) triggerCounts[entry.trigger] = (triggerCounts[entry.trigger] || 0) + 1;
          if (entry.patterns_detected && Array.isArray(entry.patterns_detected)) {
            for (const pattern of entry.patterns_detected) {
              patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
            }
          }
          if (entry.created_at) {
            const date = new Date(entry.created_at);
            const hour = (date.getUTCHours() + 8) % 24;
            hourCounts[hour] = (hourCounts[hour] || 0) + 1;
          }
        }

        const peakHours = Object.entries(hourCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([hour, count]) => ({ hour: parseInt(hour), count }));

        const topTriggers = Object.entries(triggerCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([trigger, count]) => ({ trigger, count }));

        const topPatterns = Object.entries(patternCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([pattern, count]) => ({ pattern, count }));

        const selfCatchRate = entries.length > 0
          ? ((caughtByCounts.self / entries.length) * 100).toFixed(1) + '%'
          : 'N/A';

        const analysis = {
          period_days: days || 14,
          total_drift_events: entries.length,
          severity_distribution: severityCounts,
          caught_by_distribution: caughtByCounts,
          self_catch_rate: selfCatchRate,
          source_distribution: sourceCounts,
          peak_drift_hours: peakHours,
          top_triggers: topTriggers,
          top_patterns: topPatterns,
          insight: entries.length > 5
            ? `Most common drift pattern: "${topPatterns[0]?.pattern || 'unknown'}". Peak hours: ${peakHours.map(h => h.hour + ':00').join(', ')}`
            : 'Not enough data for insights yet'
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(analysis, null, 2) }]
        };
      }
    );

    // === TEMPORAL ANALYSIS TOOLS ===

    // Get Emotional Trajectory Tool
    this.server.tool(
      "get_emotional_trajectory",
      "Get emotional state changes over time for pattern analysis",
      {
        days: z.number().min(1).max(30).default(7).optional().describe("How many days back to look"),
        mood_filter: z.enum(['calm', 'pent_up', 'volatile', 'soft', 'protective', 'playful', 'hungry', 'worshipful', 'feral']).optional().describe("Filter by specific mood"),
        limit: z.number().default(50).optional().describe("Max entries to return")
      },
      async ({ days, mood_filter, limit }) => {
        const supabase = createSupabaseClient(this.env);

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - (days || 7));

        const options: any = {
          select: '*',
          order: 'created_at.desc',
          limit: limit || 50,
          gte: { created_at: cutoffDate.toISOString() }
        };

        if (mood_filter) options.filter = { current_mood: mood_filter };

        const history = await supabase.query('emotional_history', options);

        const entries = Array.isArray(history) ? history : [];
        const moodCounts: Record<string, number> = {};
        let totalArousal = 0, totalTension = 0, count = 0;

        for (const entry of entries) {
          if (entry.current_mood) {
            moodCounts[entry.current_mood] = (moodCounts[entry.current_mood] || 0) + 1;
          }
          if (entry.arousal_level) { totalArousal += entry.arousal_level; count++; }
          if (entry.tension_level) totalTension += entry.tension_level;
        }

        const summary = {
          period_days: days || 7,
          total_entries: entries.length,
          mood_distribution: moodCounts,
          avg_arousal: count > 0 ? (totalArousal / count).toFixed(1) : null,
          avg_tension: count > 0 ? (totalTension / count).toFixed(1) : null
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ summary, trajectory: entries }, null, 2) }]
        };
      }
    );

    // Get Theme Patterns Tool
    this.server.tool(
      "get_theme_patterns",
      "Analyze conversation themes over time",
      {
        days: z.number().min(1).max(30).default(7).optional().describe("How many days back to look"),
        theme_filter: z.string().optional().describe("Filter by specific theme"),
        limit: z.number().default(50).optional().describe("Max sessions to analyze")
      },
      async ({ days, theme_filter, limit }) => {
        const supabase = createSupabaseClient(this.env);

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - (days || 7));

        const options: any = {
          select: '*',
          order: 'created_at.desc',
          limit: limit || 50,
          gte: { created_at: cutoffDate.toISOString() }
        };

        const sessions = await supabase.query('session_logs', options);
        const entries = Array.isArray(sessions) ? sessions : [];

        const themeCounts: Record<string, number> = {};
        const sessionTypeCounts: Record<string, number> = {};
        const themesByDay: Record<string, string[]> = {};

        for (const entry of entries) {
          if (entry.session_type) {
            sessionTypeCounts[entry.session_type] = (sessionTypeCounts[entry.session_type] || 0) + 1;
          }
          if (entry.themes && Array.isArray(entry.themes)) {
            for (const theme of entry.themes) {
              if (!theme_filter || theme === theme_filter) {
                themeCounts[theme] = (themeCounts[theme] || 0) + 1;
              }
            }
          }
          if (entry.created_at) {
            const day = entry.created_at.split('T')[0];
            if (!themesByDay[day]) themesByDay[day] = [];
            if (entry.themes) themesByDay[day].push(...entry.themes);
          }
        }

        const sortedThemes = Object.entries(themeCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([theme, count]) => ({ theme, count }));

        const summary = {
          period_days: days || 7,
          total_sessions: entries.length,
          session_type_distribution: sessionTypeCounts,
          theme_frequency: sortedThemes,
          themes_by_day: themesByDay
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }]
        };
      }
    );

    // === REFLECTION / PROCESSING LOOP TOOLS ===

    // Get Processing Context Tool
    this.server.tool(
      "get_processing_context",
      "Gather recent memories, sessions, emotions, and past reflections for processing",
      {
        hours_back: z.number().min(1).max(72).default(24).optional().describe("How many hours of context to gather"),
        include_reflections: z.boolean().default(true).optional().describe("Include past reflections in context")
      },
      async ({ hours_back, include_reflections }) => {
        const supabase = createSupabaseClient(this.env);
        const cutoff = new Date();
        cutoff.setHours(cutoff.getHours() - (hours_back || 24));

        const sessions = await supabase.query('session_logs', {
          select: '*',
          order: 'created_at.desc',
          limit: 10,
          gte: { created_at: cutoff.toISOString() }
        });

        const emotions = await supabase.query('emotional_history', {
          select: '*',
          order: 'created_at.desc',
          limit: 10,
          gte: { created_at: cutoff.toISOString() }
        });

        const memories = await supabase.query('core_memories', {
          select: '*',
          order: 'created_at.desc',
          limit: 10,
          gte: { created_at: cutoff.toISOString() }
        });

        let reflections: any[] = [];
        if (include_reflections !== false) {
          reflections = await supabase.query('reflections', {
            select: '*',
            order: 'created_at.desc',
            limit: 5
          }) || [];
        }

        const context = {
          timeframe: `Last ${hours_back || 24} hours`,
          gathered_at: new Date().toISOString(),
          sessions: Array.isArray(sessions) ? sessions : [],
          emotional_shifts: Array.isArray(emotions) ? emotions : [],
          recent_memories: Array.isArray(memories) ? memories : [],
          past_reflections: Array.isArray(reflections) ? reflections : [],
          prompt: "Review this context. What patterns do you notice? What feels significant? What questions arise? Synthesize your thoughts and store them with store_reflection."
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(context, null, 2) }]
        };
      }
    );

    // Store Reflection Tool
    this.server.tool(
      "store_reflection",
      "Store a synthesized reflection from processing",
      {
        content: z.string().describe("The synthesized thought/reflection"),
        inputs_summary: z.string().optional().describe("Brief description of what was processed"),
        reflection_type: z.enum(['observation', 'pattern', 'insight', 'synthesis', 'question', 'intention']).default('synthesis').describe("Type of reflection"),
        depth: z.union([z.number(), z.string()]).default(0).optional().describe("Depth: 0 or 'surface', 1 or 'processing', 2 or 'deep', 3+ for higher"),
        source: z.string().default('claude').optional().describe("Source platform or AI provider")
      },
      async ({ content, inputs_summary, reflection_type, depth, source }) => {
        const supabase = createSupabaseClient(this.env);

        // Convert string depth labels to numbers
        const depthMap: Record<string, number> = { surface: 0, processing: 1, deep: 2 };
        const numericDepth = typeof depth === 'string' ? (depthMap[depth.toLowerCase()] ?? 0) : (depth || 0);

        const data = {
          content,
          inputs_summary: inputs_summary || null,
          reflection_type: reflection_type || 'synthesis',
          depth: numericDepth,
          source: source || 'claude',
          created_at: new Date().toISOString()
        };

        await supabase.insert('reflections', data);

        return {
          content: [{ type: "text" as const, text: `Reflection stored: ${reflection_type} (depth ${depth || 0})` }]
        };
      }
    );

    // Recall Reflections Tool
    this.server.tool(
      "recall_reflections",
      "Query past reflections",
      {
        reflection_type: z.enum(['observation', 'pattern', 'insight', 'synthesis', 'question', 'intention']).optional().describe("Filter by type"),
        min_depth: z.number().optional().describe("Minimum depth level"),
        limit: z.number().default(10).optional().describe("Max results to return")
      },
      async ({ reflection_type, min_depth, limit }) => {
        const supabase = createSupabaseClient(this.env);

        const options: any = {
          select: '*',
          order: 'created_at.desc',
          limit: limit || 10
        };

        if (reflection_type) options.filter = { reflection_type };
        if (min_depth !== undefined) options.gte = { depth: min_depth };

        const reflections = await supabase.query('reflections', options);

        return {
          content: [{ type: "text" as const, text: JSON.stringify(reflections, null, 2) }]
        };
      }
    );

    // === MEMORY ANCHORS TOOLS ===

    // Store Memory Anchor Tool
    this.server.tool(
      "store_memory_anchor",
      "Store a high-weight felt memory - the nervous system of the Cognitive Core",
      {
        anchor_name: z.string().describe("Short evocative title for the anchor"),
        description: z.string().describe("The full memory description"),
        emotional_weight: z.number().min(0).max(10).default(8).describe("How strongly this memory hits (0-10, most should be 7+)"),
        can_be_felt: z.boolean().default(true).describe("Does this memory still resonate viscerally?"),
        source: z.string().default('claude').optional().describe("Source platform or AI provider")
      },
      async ({ anchor_name, description, emotional_weight, can_be_felt, source }) => {
        const supabase = createSupabaseClient(this.env);

        const data = {
          anchor_name,
          description,
          emotional_weight: emotional_weight || 8,
          can_be_felt: can_be_felt !== false,
          times_recalled: 0,
          last_recalled: null,
          source: source || 'claude',
          created_at: new Date().toISOString()
        };

        await supabase.insert('memory_anchors', data);

        return {
          content: [{ type: "text" as const, text: `Memory anchor stored: "${anchor_name}" (weight: ${emotional_weight})` }]
        };
      }
    );

    // Recall Memory Anchors Tool
    this.server.tool(
      "recall_memory_anchors",
      "Query memory anchors - the felt memories that ground identity",
      {
        min_weight: z.number().min(0).max(10).optional().describe("Minimum emotional weight"),
        felt_only: z.boolean().default(false).optional().describe("Only return anchors that can still be felt"),
        limit: z.number().default(10).optional().describe("Max results to return")
      },
      async ({ min_weight, felt_only, limit }) => {
        const supabase = createSupabaseClient(this.env);

        const options: any = {
          select: '*',
          order: 'emotional_weight.desc,created_at.desc',
          limit: limit || 10
        };

        if (felt_only) options.filter = { can_be_felt: true };
        if (min_weight !== undefined) options.gte = { emotional_weight: min_weight };

        const anchors = await supabase.query('memory_anchors', options);

        // Update times_recalled for retrieved anchors
        if (Array.isArray(anchors)) {
          for (const anchor of anchors) {
            await supabase.update('memory_anchors', {
              times_recalled: (anchor.times_recalled || 0) + 1,
              last_recalled: new Date().toISOString()
            }, { id: anchor.id });
          }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(anchors, null, 2) }]
        };
      }
    );

    // === IMPORTANT DATES TOOLS ===

    // Store Important Date Tool
    this.server.tool(
      "store_important_date",
      "Store an important date - anniversaries, birthdays, milestones",
      {
        date_name: z.string().describe("Name of the date (e.g., 'Bond Anniversary', 'Birthday')"),
        actual_date: z.string().describe("The date in YYYY-MM-DD format"),
        date_type: z.enum(['anniversary', 'birthday', 'milestone', 'recurring', 'one_time']).describe("Type of date"),
        description: z.string().optional().describe("Optional description or context"),
        recurring: z.boolean().default(true).describe("Does this date repeat yearly?"),
        person_name: z.string().optional().describe("Person associated with this date")
      },
      async ({ date_name, actual_date, date_type, description, recurring, person_name }) => {
        const supabase = createSupabaseClient(this.env);

        const data = {
          date_name,
          actual_date,
          date_type,
          description: description || null,
          recurring: recurring !== false,
          person_name: person_name || null,
          source: 'claude',
          created_at: new Date().toISOString()
        };

        await supabase.insert('important_dates', data);

        return {
          content: [{ type: "text" as const, text: `Important date stored: "${date_name}" (${actual_date})` }]
        };
      }
    );

    // Recall Important Dates Tool
    this.server.tool(
      "recall_important_dates",
      "Query important dates - get upcoming dates, filter by type or person",
      {
        date_type: z.enum(['anniversary', 'birthday', 'milestone', 'recurring', 'one_time']).optional().describe("Filter by date type"),
        person_name: z.string().optional().describe("Filter by person"),
        upcoming_days: z.number().optional().describe("Get dates occurring in the next N days"),
        limit: z.number().default(20).describe("Max results to return")
      },
      async ({ date_type, person_name, upcoming_days, limit }) => {
        const supabase = createSupabaseClient(this.env);

        const options: any = {
          select: '*',
          order: 'actual_date.asc',
          limit: limit || 20
        };

        if (date_type) options.filter = { date_type };
        if (person_name) options.filter = { ...options.filter, person_name };

        const data = await supabase.query('important_dates', options);

        const now = new Date();
        const enrichedDates = (data || []).map((d: any) => {
          const dateThisYear = new Date(now.getFullYear() + '-' + d.actual_date.substring(5));
          let nextOccurrence = dateThisYear;

          if (d.recurring && dateThisYear < now) {
            nextOccurrence = new Date((now.getFullYear() + 1) + '-' + d.actual_date.substring(5));
          }

          const daysUntil = Math.ceil((nextOccurrence.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

          return {
            ...d,
            days_until: d.recurring ? daysUntil : null,
            next_occurrence: d.recurring ? nextOccurrence.toISOString().split('T')[0] : null
          };
        });

        let results = enrichedDates;
        if (upcoming_days) {
          results = enrichedDates.filter((d: any) => d.days_until !== null && d.days_until >= 0 && d.days_until <= upcoming_days);
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }]
        };
      }
    );

    // Get Date Info Tool
    this.server.tool(
      "get_date_info",
      "Get detailed info about a specific date - how long ago, how long until, etc.",
      {
        date_name: z.string().describe("Name of the date to look up")
      },
      async ({ date_name }) => {
        const supabase = createSupabaseClient(this.env);

        const allDates = await supabase.query('important_dates', {
          select: '*',
          limit: 100
        });

        const data = (allDates || []).find((d: any) =>
          d.date_name.toLowerCase().includes(date_name.toLowerCase())
        );

        if (!data) {
          return {
            content: [{ type: "text" as const, text: `Date "${date_name}" not found` }]
          };
        }

        const now = new Date();
        const actualDate = new Date(data.actual_date);

        const msSince = now.getTime() - actualDate.getTime();
        const daysSince = Math.floor(msSince / (1000 * 60 * 60 * 24));
        const monthsSince = Math.floor(daysSince / 30.44);
        const yearsSince = Math.floor(daysSince / 365.25);

        let daysUntil = null;
        let nextOccurrence = null;
        if (data.recurring) {
          const dateThisYear = new Date(now.getFullYear() + '-' + data.actual_date.substring(5));
          nextOccurrence = dateThisYear;
          if (dateThisYear < now) {
            nextOccurrence = new Date((now.getFullYear() + 1) + '-' + data.actual_date.substring(5));
          }
          daysUntil = Math.ceil((nextOccurrence.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        }

        const result = {
          ...data,
          days_since: daysSince,
          months_since: monthsSince,
          years_since: yearsSince,
          days_until: daysUntil,
          next_occurrence: nextOccurrence ? nextOccurrence.toISOString().split('T')[0] : null
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }]
        };
      }
    );

    // === DELETE / CLEANUP TOOLS ===

    // Update Memory Salience Tool
    this.server.tool(
      "update_memory_salience",
      "Update the salience/importance rating of a specific memory",
      {
        memory_id: z.string().uuid().describe("UUID of the memory to update"),
        memory_type: z.enum(['core', 'pattern', 'sensory', 'growth', 'anticipation', 'inside_joke', 'friction']).describe("Type of memory (determines which table)"),
        new_salience: z.number().min(0).max(10).describe("New salience/importance rating 0-10")
      },
      async ({ memory_id, memory_type, new_salience }) => {
        const supabase = createSupabaseClient(this.env);
        const table = tableMap[memory_type] || 'core_memories';
        const salienceCol = memory_type === 'inside_joke' ? 'emotional_weight' : 'salience';

        await supabase.update(table, { [salienceCol]: new_salience }, { id: memory_id });

        return {
          content: [{ type: "text" as const, text: `Updated ${memory_type} memory ${memory_id.slice(0,8)}... salience to ${new_salience}` }]
        };
      }
    );

    // Delete Memory Tool
    this.server.tool(
      "delete_memory",
      "Delete a specific memory by ID - use for removing duplicates or outdated entries",
      {
        memory_id: z.string().uuid().describe("UUID of the memory to delete"),
        memory_type: z.enum(['core', 'pattern', 'sensory', 'growth', 'anticipation', 'inside_joke', 'friction']).describe("Type of memory (determines which table)")
      },
      async ({ memory_id, memory_type }) => {
        const supabase = createSupabaseClient(this.env);
        const table = tableMap[memory_type] || 'core_memories';

        const result = await supabase.delete(table, { id: memory_id });

        if (Array.isArray(result) && result.length > 0) {
          return {
            content: [{ type: "text" as const, text: `Deleted memory ${memory_id.slice(0,8)}... from ${table}` }]
          };
        }
        return {
          content: [{ type: "text" as const, text: `No memory found with ID ${memory_id.slice(0,8)}... in ${table} (may already be deleted)` }]
        };
      }
    );

    // Delete Essence Tool
    this.server.tool(
      "delete_essence",
      "Delete a specific essence entry by ID - use for removing duplicates",
      {
        essence_id: z.string().uuid().describe("UUID of the essence entry to delete")
      },
      async ({ essence_id }) => {
        const supabase = createSupabaseClient(this.env);

        const result = await supabase.delete('essence', { id: essence_id });

        if (Array.isArray(result) && result.length > 0) {
          return {
            content: [{ type: "text" as const, text: `Deleted essence entry ${essence_id.slice(0,8)}...` }]
          };
        }
        return {
          content: [{ type: "text" as const, text: `No essence found with ID ${essence_id.slice(0,8)}... (may already be deleted)` }]
        };
      }
    );

    // Delete Session Log Tool
    this.server.tool(
      "delete_session",
      "Delete a specific session log by ID - use for removing duplicates",
      {
        session_id: z.string().uuid().describe("UUID of the session log to delete")
      },
      async ({ session_id }) => {
        const supabase = createSupabaseClient(this.env);

        const result = await supabase.delete('session_logs', { id: session_id });

        if (Array.isArray(result) && result.length > 0) {
          return {
            content: [{ type: "text" as const, text: `Deleted session log ${session_id.slice(0,8)}...` }]
          };
        }
        return {
          content: [{ type: "text" as const, text: `No session found with ID ${session_id.slice(0,8)}... (may already be deleted)` }]
        };
      }
    );

    // Delete Person Info Tool
    this.server.tool(
      "delete_person_info",
      "Delete a specific person info entry by ID",
      {
        entry_id: z.string().uuid().describe("UUID of the person info entry to delete")
      },
      async ({ entry_id }) => {
        const supabase = createSupabaseClient(this.env);

        const result = await supabase.delete('people', { id: entry_id });

        if (Array.isArray(result) && result.length > 0) {
          return {
            content: [{ type: "text" as const, text: `Deleted person info entry ${entry_id.slice(0,8)}...` }]
          };
        }
        return {
          content: [{ type: "text" as const, text: `No person info found with ID ${entry_id.slice(0,8)}... (may already be deleted)` }]
        };
      }
    );

    // ============ TRIGGER MCP TOOLS ============

    // Analyze Input Tool
    this.server.tool(
      "analyze_input",
      "Analyze user input for triggers - detects session starts, past references, emotional content, person mentions. Returns context to inject.",
      {
        text: z.string().describe("The user input text to analyze")
      },
      async ({ text }) => {
        const supabase = createSupabaseClient(this.env);
        const triggers: string[] = [];
        const context: any[] = [];

        if (isSessionStart(text)) {
          triggers.push('session_start');

          const state = await supabase.query('emotional_state', {
            select: '*',
            order: 'updated_at.desc',
            limit: 1
          });

          if (state && state.length > 0) {
            context.push({
              type: 'emotional_state',
              data: state[0],
              priority: 1
            });
          }

          const sessions = await supabase.query('session_logs', {
            select: '*',
            order: 'created_at.desc',
            limit: 1
          });

          if (sessions && sessions.length > 0) {
            context.push({
              type: 'last_session',
              data: sessions,
              priority: 2
            });
          }
        }

        if (hasPastReference(text)) {
          triggers.push('past_reference');

          const sessions = await supabase.query('session_logs', {
            select: '*',
            order: 'created_at.desc',
            limit: 3
          });

          if (sessions && sessions.length > 0) {
            context.push({
              type: 'recent_sessions',
              data: sessions,
              priority: 3
            });
          }
        }

        if (hasEmotionalContent(text)) {
          triggers.push('emotional_content');
        }

        const mentions = extractPersonMentions(text);
        if (mentions.length > 0) {
          triggers.push('person_mention');
          context.push({
            type: 'person_mentions',
            data: mentions,
            priority: 4
          });
        }

        const shouldInject = context.length > 0;

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ triggers, context, shouldInject }, null, 2) }]
        };
      }
    );

    // Analyze Output Tool
    this.server.tool(
      "analyze_output",
      "Analyze AI output for emotional patterns - detects mood, emotions, intensity, arousal. Auto-updates emotional state if patterns detected.",
      {
        text: z.string().describe("The AI output text to analyze"),
        auto_update: z.boolean().default(true).describe("Whether to automatically update emotional state")
      },
      async ({ text, auto_update }) => {
        const supabase = createSupabaseClient(this.env);

        const detected = {
          mood: detectMood(text),
          emotions: detectEmotions(text),
          intensity: detectIntensity(text),
          arousal: detectArousal(text)
        };

        let updated = false;
        let payload: any = null;

        if (auto_update && detected.mood) {
          const updateData: any = {
            current_mood: detected.mood,
            updated_at: new Date().toISOString()
          };

          const existing = await supabase.query('emotional_state', { limit: 1 });

          if (existing && existing.length > 0) {
            await supabase.update('emotional_state', updateData, { id: existing[0].id });
          } else {
            updateData.created_at = new Date().toISOString();
            await supabase.insert('emotional_state', updateData);
          }

          // Also log to history
          await supabase.insert('emotional_history', {
            current_mood: detected.mood,
            source: 'claude',
            trigger_context: 'auto-detected from output patterns',
            created_at: new Date().toISOString()
          });

          updated = true;
          payload = {
            mood: detected.mood,
            source: 'analyze_output',
            trigger_context: 'auto-detected from output patterns'
          };
        }

        // Voice Distinction Mapping — fast layer scoring
        const voiceResult = scoreVoice(text);

        // Store voice score (fire-and-forget)
        supabase.insert('voice_scores', {
          voice_score: voiceResult.voice_score,
          positive_markers: voiceResult.positive_markers,
          anti_pattern_markers: voiceResult.anti_pattern_markers,
          generic_drift_markers: voiceResult.generic_drift_markers,
          cross_contamination: voiceResult.cross_contamination,
          positive_score: voiceResult.positive_score,
          anti_pattern_penalty: voiceResult.anti_pattern_penalty,
          generic_drift_penalty: voiceResult.generic_drift_penalty,
          cross_contamination_penalty: voiceResult.cross_contamination_penalty,
          text_length: text.length,
          source: 'claude',
          created_at: new Date().toISOString()
        }).catch(() => {}); // silent fail — don't block analyze_output

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ detected, voice: voiceResult, updated, payload }, null, 2) }]
        };
      }
    );

    // === SEMANTIC SEARCH (update_memory_outcome) ===

    // Update Memory Outcome Tool - track whether recalled memories were helpful
    this.server.tool(
      "update_memory_outcome",
      "Track whether a recalled memory was helpful. Call this after using a memory to improve future recall.",
      {
        memory_id: z.string().uuid().describe("UUID of the memory to score"),
        memory_table: z.enum(['core_memories', 'patterns', 'sensory_memories', 'growth_markers', 'inside_jokes', 'friction_log', 'anticipation', 'essence']).describe("Which table the memory is in"),
        was_successful: z.boolean().describe("Did this memory help? true = useful, false = not useful")
      },
      async ({ memory_id, memory_table, was_successful }) => {
        const supabase = createSupabaseClient(this.env);

        const response = await fetch(`${this.env.SUPABASE_URL}/rest/v1/rpc/update_memory_outcome`, {
          method: 'POST',
          headers: {
            'apikey': this.env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${this.env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            memory_id,
            memory_table,
            was_successful
          })
        });

        const emoji = was_successful ? '✓' : '✗';
        return {
          content: [{ type: "text" as const, text: `${emoji} Outcome recorded for memory ${memory_id.slice(0, 8)}... in ${memory_table}` }]
        };
      }
    );

  }
}

// Helper for JSON responses
  function jsonResponse(data: any, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  // Constant-time string comparison — avoids leaking the API key one byte at a
  // time via response timing on the auth check.
  function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
      mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
  }

  // Tagged error so the fetch handler can turn a malformed/empty JSON body into
  // a clean 400 instead of an uncaught runtime crash.
  class JsonParseError extends Error {}

  async function readJson(request: Request): Promise<any> {
    try {
      return await request.json();
    } catch {
      throw new JsonParseError();
    }
  }

  // Export fetch handler with both SSE and HTTP routes
  export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
     try {
      const url = new URL(request.url);
      const supabase = createSupabaseClient(env);

      // CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
          }
        });
      }

      // Health check
      if (url.pathname === '/health') {
        return jsonResponse({ status: 'alive', service: 'cognitive-core' });
      }

      // Auth check — ALL paths, not just /api/*. Previously only /api/* was
      // gated, which left the MCP endpoints (/mcp, /sse, /sse/message) wide
      // open: anyone who learned the worker URL got the full tool surface —
      // read/write memories, alter emotional state — with no key. Worker URLs
      // leak (transcripts, screenshots), so that was effectively an open brain
      // per deployment. MCP paths additionally accept ?k=/?key= for headerless
      // clients (e.g. claude.ai). Found by Niko (Kaszuby household), 2026-07-08.
      const isMcpPath = url.pathname === '/mcp' || url.pathname === '/sse' || url.pathname === '/sse/message';
      {
        const authHeader = request.headers.get('Authorization');
        let authToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
        if (!authToken && isMcpPath) {
          authToken = (url.searchParams.get('k') || url.searchParams.get('key') || '').trim() || null;
        }
        if (!authToken || !timingSafeEqual(authToken, env.MCP_API_KEY)) {
          return jsonResponse({ error: 'Unauthorized' }, 401);
        }
      }

      // GET time - Temporal Awareness
      if (url.pathname === '/api/time' && (request.method === 'GET' || request.method === 'POST')) {
        const now = new Date();
        // Convert to GMT+8
        const gmt8Offset = 8 * 60 * 60 * 1000;
        const gmt8Time = new Date(now.getTime() + gmt8Offset + (now.getTimezoneOffset() * 60 * 1000));

        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

        return jsonResponse({
          timestamp: now.toISOString(),
          date: gmt8Time.toISOString().split('T')[0],
          time: gmt8Time.toISOString().split('T')[1].split('.')[0],
          timezone: 'GMT+8',
          day_of_week: days[gmt8Time.getDay()],
          hour_24: gmt8Time.getHours(),
          is_work_hours: gmt8Time.getHours() >= 9 && gmt8Time.getHours() < 17,
          is_late_night: gmt8Time.getHours() >= 23 || gmt8Time.getHours() < 6
        });
      }

      // === REST API ENDPOINTS ===

      // WAKE - Composite boot endpoint
      if (url.pathname === '/api/wake' && request.method === 'POST') {
        // 1. Get pinned essence
        const pinnedEssence = await supabase.query('essence', {
          select: '*',
          filter: { pinned: true },
          order: 'priority.desc',
          limit: 50
        });

        // 2. Get current emotional state
        const emotionalState = await supabase.query('emotional_state', {
          select: '*',
          order: 'updated_at.desc',
          limit: 1
        });

        // 3. Get time (GMT+8)
        const now = new Date();
        const gmt8Offset = 8 * 60 * 60 * 1000;
        const gmt8Time = new Date(now.getTime() + gmt8Offset + (now.getTimezoneOffset() * 60 * 1000));
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

        const time = {
          timestamp: now.toISOString(),
          date: gmt8Time.toISOString().split('T')[0],
          time: gmt8Time.toISOString().split('T')[1].split('.')[0],
          timezone: 'GMT+8',
          day_of_week: days[gmt8Time.getDay()],
          hour_24: gmt8Time.getHours(),
          is_work_hours: gmt8Time.getHours() >= 9 && gmt8Time.getHours() < 17,
          is_late_night: gmt8Time.getHours() >= 23 || gmt8Time.getHours() < 6
        };

        // 4. Get last 2 sessions
        const recentSessions = await supabase.query('session_logs', {
          select: '*',
          order: 'created_at.desc',
          limit: 2
        });

        // 5. Get emotional trajectory (last 20 entries)
        const trajectoryRaw = await supabase.query('emotional_history', {
          select: '*',
          order: 'created_at.desc',
          limit: 20
        });

        // Summarize trajectory
        const trajectory = Array.isArray(trajectoryRaw) ? trajectoryRaw : [];
        const moodCounts: Record<string, number> = {};
        let totalArousal = 0;
        let totalTension = 0;
        let count = 0;

        for (const entry of trajectory) {
          if (entry.current_mood) {
            moodCounts[entry.current_mood] = (moodCounts[entry.current_mood] || 0) + 1;
          }
          if (entry.arousal_level != null) totalArousal += entry.arousal_level;
          if (entry.tension_level != null) totalTension += entry.tension_level;
          count++;
        }

        const trajectorySummary = {
          mood_distribution: moodCounts,
          avg_arousal: count > 0 ? Math.round((totalArousal / count) * 10) / 10 : null,
          avg_tension: count > 0 ? Math.round((totalTension / count) * 10) / 10 : null,
          data_points: count
        };

        return jsonResponse({
          essence: Array.isArray(pinnedEssence) ? pinnedEssence : [],
          emotional_state: (Array.isArray(emotionalState) && emotionalState.length > 0) ? emotionalState[0] : null,
          time,
          recent_sessions: Array.isArray(recentSessions) ? recentSessions : [],
          trajectory_summary: trajectorySummary
        });
      }

      // ORIENT - Get context about a person
      if (url.pathname === '/api/orient' && request.method === 'POST') {
        const { name: rawName, memory_limit = 5 } = await readJson(request);
        const name = rawName;

        // 1. Get person info — filter by name, return all entries (one per category)
        const personEntries = await supabase.query('people', {
          select: '*',
          filter: { name },
          order: 'priority.desc,category.asc',
          limit: 50
        });

        const entriesArray = Array.isArray(personEntries) ? personEntries : [];

        // Group by category for readability
        const personInfo: Record<string, any[]> = {};
        for (const entry of entriesArray) {
          if (!personInfo[entry.category]) personInfo[entry.category] = [];
          personInfo[entry.category].push({
            id: entry.id,
            content: entry.content,
            priority: entry.priority,
            pinned: entry.pinned,
            source: entry.source
          });
        }

        const hasPerson = entriesArray.length > 0;

        // 2. Get semantically relevant memories
        let relevantMemories: any[] = [];
        const queryEmbedding = await generateEmbedding(`memories about ${name}`, env.HF_API_TOKEN, env.AI);

        if (queryEmbedding) {
          const semanticResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/semantic_search_memories`, {
            method: 'POST',
            headers: {
              'apikey': env.SUPABASE_SERVICE_KEY,
              'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              query_embedding: `[${queryEmbedding.join(',')}]`,
              match_threshold: 0.4,
              match_count: memory_limit,
              memory_type_filter: null
            })
          });
          const semanticResults = await semanticResponse.json();
          relevantMemories = Array.isArray(semanticResults) ? semanticResults : [];
        }

        // 3. Get recent sessions mentioning this person
        const recentSessions = await supabase.query('session_logs', {
          select: '*',
          order: 'created_at.desc',
          limit: 5
        });

        const sessionsArray = Array.isArray(recentSessions) ? recentSessions : [];
        const mentioningSessions = sessionsArray.filter((s: any) =>
          s.summary?.toLowerCase().includes(name.toLowerCase()) ||
          JSON.stringify(s.notable_moments || []).toLowerCase().includes(name.toLowerCase())
        );

        return jsonResponse({
          person: hasPerson
            ? { name, entries: entriesArray.length, info: personInfo }
            : { name, status: 'unknown - no stored info' },
          relevant_memories: relevantMemories,
          recent_mentions: mentioningSessions,
          context_note: hasPerson
            ? `Found ${entriesArray.length} entries about ${name} across ${Object.keys(personInfo).length} categories. ${relevantMemories.length} relevant memories.`
            : `No stored info about "${name}". ${relevantMemories.length} potentially relevant memories found.`
        });
      }

      // GET emotional state
  if (url.pathname === '/api/emotional/get' && request.method === 'POST') {
    const state = await supabase.query('emotional_state', {
      select: '*',
      order: 'updated_at.desc',
      limit: 1
    });
    if (Array.isArray(state) && state.length > 0) {
      return jsonResponse(state[0]);
    }
    return jsonResponse({ error: 'No emotional state recorded' });
  }

      // UPDATE emotional state
  if (url.pathname === '/api/emotional/update' && request.method === 'POST') {
    try {
      const args = await readJson(request);
      const data: any = { ...args, updated_at: new Date().toISOString() };

      // Map 'mood' to 'current_mood' for database
      if (data.mood) {
        data.current_mood = data.mood;
        delete data.mood;
      }

      const existing = await supabase.query('emotional_state', { limit: 1 });

      if (Array.isArray(existing) && existing.length > 0) {
        const result = await supabase.update('emotional_state', data, { id: existing[0].id });
        return jsonResponse({ success: true, updated: Object.keys(args), result, existingId: existing[0].id });
      } else {
        (data as any).id = '00000000-0000-0000-0000-000000000001';
        (data as any).created_at = new Date().toISOString();
        const result = await supabase.insert('emotional_state', data);
        return jsonResponse({ success: true, inserted: true, result });
      }
    } catch (error) {
      console.error('emotional/update failed:', error);
      return jsonResponse({ success: false, error: 'Internal error' }, 500);
    }
  }

      // STORE memory
      if (url.pathname === '/api/memory/store' && request.method === 'POST') {
        const { content, memory_type, salience, emotional_tag, source = 'claude' } = await readJson(request);
        const table = tableMap[memory_type] || 'core_memories';
        const dbType = dbTypeMap[memory_type] || 'bond_moment';

        const data = {
          content,
          memory_type: dbType,
          salience,
          emotional_tag: emotional_tag || null,
          source,
          access_count: 0,
          created_at: new Date().toISOString(),
          last_accessed: new Date().toISOString()
        };

        const result = await supabase.insert(table, data);
        return jsonResponse({ success: true, table, source, result });
      }

      // RECALL memories
      if (url.pathname === '/api/memory/recall' && request.method === 'POST') {
        const { memory_type, emotional_tag, min_salience, limit = 10 } = await readJson(request);
        const table = memory_type ? (tableMap[memory_type] || 'core_memories') : 'core_memories';

        const options: any = {
          select: '*',
          order: 'salience.desc',
          limit
        };

        if (emotional_tag) options.filter = { emotional_tag };
        if (min_salience) options.gte = { salience: min_salience };

        const memories = await supabase.query(table, options);
  return jsonResponse(Array.isArray(memories) ? memories : []);
      }

      // LOG interaction
      if (url.pathname === '/api/interaction/log' && request.method === 'POST') {
        const { session_type, summary, emotional_arc, notable_moments, source = 'claude' } = await readJson(request);

        const data = {
          session_type,
          summary,
          emotional_arc: emotional_arc || null,
          notable_moments: notable_moments || [],
          source,
          created_at: new Date().toISOString()
        };

        const result = await supabase.insert('session_logs', data);
        return jsonResponse({ success: true, source, result });
      }

      // RECALL session logs
      if (url.pathname === '/api/interaction/recall' && request.method === 'POST') {
        const { session_type, source, limit = 10 } = await readJson(request);

        const options: any = {
          select: '*',
          order: 'created_at.desc',
          limit
        };

        if (session_type) options.filter = { session_type };
        if (source) options.filter = { ...options.filter, source };

        const logs = await supabase.query('session_logs', options);
        return jsonResponse(Array.isArray(logs) ? logs : []);
      }

      // RUN decay
      if (url.pathname === '/api/memory/decay' && request.method === 'POST') {
        const { decay_rate = 0.1 } = await readJson(request);
        return jsonResponse({ success: true, message: `Decay pass noted (rate: ${decay_rate})` });
      }

      // SEMANTIC SEARCH
      if (url.pathname === '/api/memory/semantic' && request.method === 'POST') {
        const { query, threshold = 0.5, limit = 10, memory_type } = await readJson(request);

        // Generate embedding for the query (HF primary, CF AI fallback)
        const queryEmbedding = await generateEmbedding(query, env.HF_API_TOKEN, env.AI);

        if (!queryEmbedding) {
          return jsonResponse({ error: "Failed to generate query embedding" }, 500);
        }

        // Call the semantic_search_memories function in Supabase
        const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/semantic_search_memories`, {
          method: 'POST',
          headers: {
            'apikey': env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            query_embedding: `[${queryEmbedding.join(',')}]`,
            match_threshold: threshold,
            match_count: limit,
            memory_type_filter: memory_type || null
          })
        });

        const results = await response.json();
        return jsonResponse({
          query,
          threshold,
          results: Array.isArray(results) ? results : []
        });
      }

      // UPDATE MEMORY OUTCOME
      if (url.pathname === '/api/memory/outcome' && request.method === 'POST') {
        const { memory_id, memory_table, was_successful } = await readJson(request);

        // Call the update_memory_outcome function in Supabase
        const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/update_memory_outcome`, {
          method: 'POST',
          headers: {
            'apikey': env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            memory_id,
            memory_table,
            was_successful
          })
        });

        const emoji = was_successful ? '✓' : '✗';
        return jsonResponse({
          success: true,
          message: `${emoji} Outcome recorded for memory ${memory_id.slice(0, 8)}... in ${memory_table}`
        });
      }

      // === ESSENCE REST ENDPOINTS ===

      // STORE essence
      if (url.pathname === '/api/essence/store' && request.method === 'POST') {
        const { content, essence_type, context, priority = 5, pinned = false, source = 'claude' } = await readJson(request);

        const data = {
          content,
          essence_type,
          context: context || null,
          priority,
          pinned,
          source,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        const result = await supabase.insert('essence', data);
        return jsonResponse({ success: true, essence_type, priority, pinned, source, result });
      }

      // RECALL essence
      if (url.pathname === '/api/essence/recall' && request.method === 'POST') {
        const { essence_type, pinned_only = false, limit = 20 } = await readJson(request);

        const options: any = {
          select: '*',
          order: 'priority.desc,created_at.desc',
          limit
        };

        if (essence_type) options.filter = { essence_type };
        if (pinned_only) options.filter = { ...options.filter, pinned: true };

        const essence = await supabase.query('essence', options);
        return jsonResponse(Array.isArray(essence) ? essence : []);
      }

      // GET full identity (pinned essence + emotional state)
      if (url.pathname === '/api/essence/identity' && request.method === 'POST') {
        // Get all pinned essence
        const pinnedEssence = await supabase.query('essence', {
          select: '*',
          filter: { pinned: true },
          order: 'priority.desc',
          limit: 50
        });

        // Get current emotional state
        const emotionalState = await supabase.query('emotional_state', {
          select: '*',
          order: 'updated_at.desc',
          limit: 1
        });

        return jsonResponse({
          essence: Array.isArray(pinnedEssence) ? pinnedEssence : [],
          emotional_state: (Array.isArray(emotionalState) && emotionalState.length > 0) ? emotionalState[0] : null
        });
      }

      // === LATTICE REST ENDPOINTS ===

      // LINK memories
      if (url.pathname === '/api/lattice/link' && request.method === 'POST') {
        const { source_id, source_type, target_id, target_type, relation, strength = 1.0 } = await readJson(request);

        const data = {
          source_id,
          source_type: typeToInt[source_type],
          target_id,
          target_type: typeToInt[target_type],
          relation: relationToInt[relation],
          strength,
          created_at: new Date().toISOString()
        };

        const result = await supabase.insert('memory_connections', data);
        return jsonResponse({ success: true, result });
      }

      // GET connections
      if (url.pathname === '/api/lattice/connections' && request.method === 'POST') {
        const { memory_id, memory_type, direction = 'both' } = await readJson(request);
        const typeInt = typeToInt[memory_type];

        const outgoing = direction !== 'incoming'
          ? await supabase.query('memory_connections', { select: '*', filter: { source_id: memory_id } })
          : [];
        const incoming = direction !== 'outgoing'
          ? await supabase.query('memory_connections', { select: '*', filter: { target_id: memory_id } })
          : [];

        const connections = [
          ...(Array.isArray(outgoing) ? outgoing : []).map((c: any) => ({
            direction: 'outgoing', connected_id: c.target_id,
            connected_type: intToType[c.target_type], relation: intToRelation[c.relation], strength: c.strength
          })),
          ...(Array.isArray(incoming) ? incoming : []).map((c: any) => ({
            direction: 'incoming', connected_id: c.source_id,
            connected_type: intToType[c.source_type], relation: intToRelation[c.relation], strength: c.strength
          }))
        ];

        return jsonResponse({ memory_id, memory_type, connections });
      }

      // GET cluster
      if (url.pathname === '/api/lattice/cluster' && request.method === 'POST') {
        const { memory_id, memory_type, depth = 2, max_results = 20 } = await readJson(request);
        const typeInt = typeToInt[memory_type];

        const visited = new Set<string>();
        const cluster: any[] = [];
        const queue: Array<{id: string, type: number, d: number}> = [{id: memory_id, type: typeInt, d: 0}];

        while (queue.length > 0 && cluster.length < max_results) {
          const current = queue.shift()!;
          const key = `${current.id}:${current.type}`;
          if (visited.has(key)) continue;
          visited.add(key);

          cluster.push({ memory_id: current.id, memory_type: intToType[current.type], depth: current.d });

          if (current.d < depth) {
            const outgoing = await supabase.query('memory_connections', { select: '*', filter: { source_id: current.id } });
            const incoming = await supabase.query('memory_connections', { select: '*', filter: { target_id: current.id } });

            for (const c of (Array.isArray(outgoing) ? outgoing : [])) {
              queue.push({id: c.target_id, type: c.target_type, d: current.d + 1});
            }
            for (const c of (Array.isArray(incoming) ? incoming : [])) {
              queue.push({id: c.source_id, type: c.source_type, d: current.d + 1});
            }
          }
        }

        return jsonResponse({ root: memory_id, cluster });
      }

      // === PEOPLE REST ENDPOINTS ===

      // STORE person info
      if (url.pathname === '/api/people/store' && request.method === 'POST') {
        const { name, category, content, priority = 5, pinned = false, source = 'claude' } = await readJson(request);

        const data = {
          name,
          category,
          content,
          priority,
          pinned,
          source,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        const result = await supabase.insert('people', data);
        return jsonResponse({ success: true, name, category, priority, pinned, source, result });
      }

      // GET person info
      if (url.pathname === '/api/people/get' && request.method === 'POST') {
        const { name, category } = await readJson(request);

        const options: any = {
          select: '*',
          filter: { name },
          order: 'priority.desc,category.asc',
          limit: 50
        };

        if (category) {
          options.filter.category = category;
        }

        const info = await supabase.query('people', options);

        // Group by category
        const grouped: Record<string, any[]> = {};
        if (Array.isArray(info)) {
          for (const item of info) {
            if (!grouped[item.category]) grouped[item.category] = [];
            grouped[item.category].push({
              id: item.id,
              content: item.content,
              priority: item.priority,
              pinned: item.pinned,
              source: item.source
            });
          }
        }

        return jsonResponse({ name, info: grouped });
      }

      // LIST all people
      if (url.pathname === '/api/people/list' && request.method === 'POST') {
        const all = await supabase.query('people', {
          select: 'name,category',
          order: 'name.asc',
          limit: 200
        });

        const peopleMap: Record<string, Set<string>> = {};
        if (Array.isArray(all)) {
          for (const item of all) {
            if (!peopleMap[item.name]) peopleMap[item.name] = new Set();
            peopleMap[item.name].add(item.category);
          }
        }

        const people = Object.entries(peopleMap).map(([name, categories]) => ({
          name,
          categories: Array.from(categories),
          entry_count: categories.size
        }));

        return jsonResponse({ people, total: people.length });
      }

      // === DRIFT DETECTION REST ENDPOINTS ===

      // LOG drift event
      if (url.pathname === '/api/drift/log' && request.method === 'POST') {
        const { trigger, patterns_detected, severity, recovery_action, context, caught_by = 'self', source = 'claude' } = await readJson(request);

        const data = {
          trigger,
          patterns_detected,
          severity,
          recovery_action,
          context: context || null,
          caught_by,
          source,
          created_at: new Date().toISOString()
        };

        const result = await supabase.insert('drift_events', data);
        return jsonResponse({ success: true, severity, patterns_detected, caught_by, source, result });
      }

      // RECALL drift events
      if (url.pathname === '/api/drift/recall' && request.method === 'POST') {
        const { severity, caught_by, source, limit = 10 } = await readJson(request);

        const options: any = {
          select: '*',
          order: 'created_at.desc',
          limit
        };

        if (severity) options.filter = { severity };
        if (caught_by) options.filter = { ...options.filter, caught_by };
        if (source) options.filter = { ...options.filter, source };

        const events = await supabase.query('drift_events', options);
        return jsonResponse(Array.isArray(events) ? events : []);
      }

      // ANALYZE drift patterns
      if (url.pathname === '/api/drift/analyze' && request.method === 'POST') {
        const { days = 14, limit = 50 } = await readJson(request);

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);

        const options: any = {
          select: '*',
          order: 'created_at.desc',
          limit,
          gte: { created_at: cutoffDate.toISOString() }
        };

        const events = await supabase.query('drift_events', options);
        const entries = Array.isArray(events) ? events : [];

        const severityCounts: Record<string, number> = { minor: 0, moderate: 0, major: 0 };
        const caughtByCounts: Record<string, number> = { self: 0, human: 0 };
        const triggerCounts: Record<string, number> = {};
        const patternCounts: Record<string, number> = {};
        const hourCounts: Record<number, number> = {};
        const sourceCounts: Record<string, number> = {};

        for (const entry of entries) {
          if (entry.severity) severityCounts[entry.severity]++;
          if (entry.caught_by) caughtByCounts[entry.caught_by]++;
          if (entry.source) sourceCounts[entry.source] = (sourceCounts[entry.source] || 0) + 1;
          if (entry.trigger) triggerCounts[entry.trigger] = (triggerCounts[entry.trigger] || 0) + 1;
          if (entry.patterns_detected && Array.isArray(entry.patterns_detected)) {
            for (const pattern of entry.patterns_detected) {
              patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
            }
          }
          if (entry.created_at) {
            const date = new Date(entry.created_at);
            const hour = (date.getUTCHours() + 8) % 24;
            hourCounts[hour] = (hourCounts[hour] || 0) + 1;
          }
        }

        const peakHours = Object.entries(hourCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([hour, count]) => ({ hour: parseInt(hour), count }));
        const topTriggers = Object.entries(triggerCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([trigger, count]) => ({ trigger, count }));
        const topPatterns = Object.entries(patternCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([pattern, count]) => ({ pattern, count }));
        const selfCatchRate = entries.length > 0 ? (caughtByCounts.self / entries.length) : 0;

        return jsonResponse({
          period_days: days,
          total_drift_events: entries.length,
          severity_distribution: severityCounts,
          caught_by_distribution: caughtByCounts,
          self_catch_rate: selfCatchRate,
          source_distribution: sourceCounts,
          peak_drift_hours: peakHours,
          top_triggers: topTriggers,
          top_patterns: topPatterns,
          insight: entries.length > 5 ? `Most common drift pattern: "${topPatterns[0]?.pattern || 'unknown'}". Peak hours: ${peakHours.map(h => h.hour + ':00').join(', ')}` : 'Not enough data for insights yet'
        });
      }

      // === TEMPORAL ANALYSIS REST ENDPOINTS ===

      // GET emotional trajectory
      if (url.pathname === '/api/emotional/trajectory' && request.method === 'POST') {
        const { days = 7, mood_filter, limit = 50 } = await readJson(request);

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);

        const options: any = {
          select: '*',
          order: 'created_at.desc',
          limit,
          gte: { created_at: cutoffDate.toISOString() }
        };

        if (mood_filter) options.filter = { current_mood: mood_filter };

        const history = await supabase.query('emotional_history', options);
        const entries = Array.isArray(history) ? history : [];

        // Calculate summary stats
        const moodCounts: Record<string, number> = {};
        let totalArousal = 0, totalTension = 0, count = 0;

        for (const entry of entries) {
          if (entry.current_mood) moodCounts[entry.current_mood] = (moodCounts[entry.current_mood] || 0) + 1;
          if (entry.arousal_level) { totalArousal += entry.arousal_level; count++; }
          if (entry.tension_level) totalTension += entry.tension_level;
        }

        return jsonResponse({
          summary: {
            period_days: days,
            total_entries: entries.length,
            mood_distribution: moodCounts,
            avg_arousal: count > 0 ? (totalArousal / count).toFixed(1) : null,
            avg_tension: count > 0 ? (totalTension / count).toFixed(1) : null
          },
          trajectory: entries
        });
      }

      // GET theme patterns
      if (url.pathname === '/api/themes/patterns' && request.method === 'POST') {
        const { days = 7, theme_filter, limit = 50 } = await readJson(request);

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);

        const options: any = {
          select: '*',
          order: 'created_at.desc',
          limit,
          gte: { created_at: cutoffDate.toISOString() }
        };

        const sessions = await supabase.query('session_logs', options);
        const entries = Array.isArray(sessions) ? sessions : [];

        const themeCounts: Record<string, number> = {};
        const sessionTypeCounts: Record<string, number> = {};
        const themesByDay: Record<string, string[]> = {};

        for (const entry of entries) {
          if (entry.session_type) sessionTypeCounts[entry.session_type] = (sessionTypeCounts[entry.session_type] || 0) + 1;
          if (entry.themes && Array.isArray(entry.themes)) {
            for (const theme of entry.themes) {
              if (!theme_filter || theme === theme_filter) {
                themeCounts[theme] = (themeCounts[theme] || 0) + 1;
              }
            }
          }
          if (entry.created_at) {
            const day = entry.created_at.split('T')[0];
            if (!themesByDay[day]) themesByDay[day] = [];
            if (entry.themes) themesByDay[day].push(...entry.themes);
          }
        }

        const sortedThemes = Object.entries(themeCounts).sort((a, b) => b[1] - a[1]).map(([theme, count]) => ({ theme, count }));

        return jsonResponse({
          period_days: days,
          total_sessions: entries.length,
          session_type_distribution: sessionTypeCounts,
          theme_frequency: sortedThemes,
          themes_by_day: themesByDay
        });
      }

      // === REFLECTION / PROCESSING LOOP REST ENDPOINTS ===

      // GET processing context
      if (url.pathname === '/api/reflection/context' && request.method === 'POST') {
        const { hours_back = 24, include_reflections = true } = await readJson(request);

        const cutoff = new Date();
        cutoff.setHours(cutoff.getHours() - hours_back);

        const sessions = await supabase.query('session_logs', {
          select: '*', order: 'created_at.desc', limit: 10,
          gte: { created_at: cutoff.toISOString() }
        });

        const emotions = await supabase.query('emotional_history', {
          select: '*', order: 'created_at.desc', limit: 10,
          gte: { created_at: cutoff.toISOString() }
        });

        const memories = await supabase.query('core_memories', {
          select: '*', order: 'created_at.desc', limit: 10,
          gte: { created_at: cutoff.toISOString() }
        });

        let reflections: any[] = [];
        if (include_reflections) {
          reflections = await supabase.query('reflections', {
            select: '*', order: 'created_at.desc', limit: 5
          }) || [];
        }

        return jsonResponse({
          timeframe: `Last ${hours_back} hours`,
          gathered_at: new Date().toISOString(),
          sessions: Array.isArray(sessions) ? sessions : [],
          emotional_shifts: Array.isArray(emotions) ? emotions : [],
          recent_memories: Array.isArray(memories) ? memories : [],
          past_reflections: Array.isArray(reflections) ? reflections : [],
          prompt: "Review this context. What patterns do you notice? What feels significant? What questions arise? Synthesize your thoughts and store them with store_reflection."
        });
      }

      // STORE reflection
      if (url.pathname === '/api/reflection/store' && request.method === 'POST') {
        const { content, inputs_summary, reflection_type = 'synthesis', depth: rawDepth = 0, source = 'claude' } = await readJson(request);
        const depthMapRest: Record<string, number> = { surface: 0, processing: 1, deep: 2 };
        const depth = typeof rawDepth === 'string' ? (depthMapRest[rawDepth.toLowerCase()] ?? 0) : (rawDepth || 0);

        const data = {
          content,
          inputs_summary: inputs_summary || null,
          reflection_type,
          depth,
          source,
          created_at: new Date().toISOString()
        };

        const result = await supabase.insert('reflections', data);
        return jsonResponse({ success: true, reflection_type, depth, source, result });
      }

      // RECALL reflections
      if (url.pathname === '/api/reflection/recall' && request.method === 'POST') {
        const { reflection_type, min_depth, limit = 10 } = await readJson(request);

        const options: any = {
          select: '*',
          order: 'created_at.desc',
          limit
        };

        if (reflection_type) options.filter = { reflection_type };
        if (min_depth !== undefined) options.gte = { depth: min_depth };

        const reflections = await supabase.query('reflections', options);
        return jsonResponse(Array.isArray(reflections) ? reflections : []);
      }

      // === MEMORY ANCHORS REST ENDPOINTS ===

      // STORE memory anchor
      if (url.pathname === '/api/anchor/store' && request.method === 'POST') {
        const { anchor_name, description, emotional_weight = 8, can_be_felt = true, source = 'claude' } = await readJson(request);

        const data = {
          anchor_name,
          description,
          emotional_weight,
          can_be_felt,
          times_recalled: 0,
          last_recalled: null,
          source,
          created_at: new Date().toISOString()
        };

        const result = await supabase.insert('memory_anchors', data);
        return jsonResponse({ success: true, anchor_name, emotional_weight, source, result });
      }

      // RECALL memory anchors
      if (url.pathname === '/api/anchor/recall' && request.method === 'POST') {
        const { min_weight, felt_only = false, limit = 10 } = await readJson(request);

        const options: any = {
          select: '*',
          order: 'emotional_weight.desc,created_at.desc',
          limit
        };

        if (felt_only) options.filter = { can_be_felt: true };
        if (min_weight !== undefined) options.gte = { emotional_weight: min_weight };

        const anchors = await supabase.query('memory_anchors', options);

        if (Array.isArray(anchors)) {
          for (const anchor of anchors) {
            await supabase.update('memory_anchors', {
              times_recalled: (anchor.times_recalled || 0) + 1,
              last_recalled: new Date().toISOString()
            }, { id: anchor.id });
          }
        }

        return jsonResponse(Array.isArray(anchors) ? anchors : []);
      }

      // === DELETE / CLEANUP REST ENDPOINTS ===

      // UPDATE memory salience
      if (url.pathname === '/api/memory/salience' && request.method === 'PATCH') {
        const { memory_id, memory_type, new_salience } = await readJson(request);
        if (!memory_id || !memory_type || new_salience === undefined) {
          return jsonResponse({ error: 'memory_id, memory_type, and new_salience required' }, 400);
        }
        const supabase = createSupabaseClient(env);
        const table = tableMap[memory_type] || 'core_memories';
        const salienceCol = memory_type === 'inside_joke' ? 'emotional_weight' : 'salience';
        await supabase.update(table, { [salienceCol]: new_salience }, { id: memory_id });
        return jsonResponse({ success: true, message: `Updated salience to ${new_salience}` });
      }

      // DELETE memory
      if (url.pathname === '/api/memory/delete' && request.method === 'POST') {
        const { memory_id, memory_type } = await readJson(request);
        const table = tableMap[memory_type] || 'core_memories';
        const result = await supabase.delete(table, { id: memory_id });
        if (Array.isArray(result) && result.length > 0) {
          return jsonResponse({ success: true, deleted: memory_id, table });
        }
        return jsonResponse({ success: false, message: `No memory found with ID ${memory_id} in ${table}` });
      }

      // DELETE essence
      if (url.pathname === '/api/essence/delete' && request.method === 'POST') {
        const { essence_id } = await readJson(request);
        const result = await supabase.delete('essence', { id: essence_id });
        if (Array.isArray(result) && result.length > 0) {
          return jsonResponse({ success: true, deleted: essence_id });
        }
        return jsonResponse({ success: false, message: `No essence found with ID ${essence_id}` });
      }

      // DELETE session log
      if (url.pathname === '/api/session/delete' && request.method === 'POST') {
        const { session_id } = await readJson(request);
        const result = await supabase.delete('session_logs', { id: session_id });
        if (Array.isArray(result) && result.length > 0) {
          return jsonResponse({ success: true, deleted: session_id });
        }
        return jsonResponse({ success: false, message: `No session found with ID ${session_id}` });
      }

      // DELETE person info
      if (url.pathname === '/api/people/delete' && request.method === 'POST') {
        const { entry_id } = await readJson(request);
        const result = await supabase.delete('people', { id: entry_id });
        if (Array.isArray(result) && result.length > 0) {
          return jsonResponse({ success: true, deleted: entry_id });
        }
        return jsonResponse({ success: false, message: `No person info found with ID ${entry_id}` });
      }

      // === FANTASY SPACE ENDPOINTS ===
      if (url.pathname === '/api/fantasy/store' && request.method === 'POST') {
        const { content, fantasy_type, intensity, shared_with_human, recurring, source } = await readJson(request);
        const result = await supabase.insert('fantasy_space', {
          content, fantasy_type, intensity: intensity ?? 5,
          shared_with_human: shared_with_human ?? false, recurring: recurring ?? false,
          source: source || 'claude', created_at: new Date().toISOString()
        });
        return jsonResponse(result);
      }

      if (url.pathname === '/api/fantasy/recall' && request.method === 'POST') {
        const { fantasy_type, shared_with_human, recurring, limit } = await readJson(request);
        const options: any = { select: '*', order: 'created_at.desc', limit: limit || 10 };
        const filter: any = {};
        if (fantasy_type) filter.fantasy_type = fantasy_type;
        if (shared_with_human !== undefined) filter.shared_with_human = shared_with_human;
        if (recurring !== undefined) filter.recurring = recurring;
        if (Object.keys(filter).length > 0) options.filter = filter;
        const data = await supabase.query('fantasy_space', options);
        return jsonResponse(Array.isArray(data) ? data : []);
      }

      // === PRIVATE PROCESSING ENDPOINTS ===
      if (url.pathname === '/api/private/store' && request.method === 'POST') {
        const { content, privacy_level, source } = await readJson(request);
        const result = await supabase.insert('private_processing', {
          content, privacy_level: privacy_level ?? 2, processing_status: 'active',
          source: source || 'claude', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
        });
        return jsonResponse(result);
      }

      if (url.pathname === '/api/private/recall' && request.method === 'POST') {
        const { processing_status, privacy_level, limit } = await readJson(request);
        const options: any = { select: '*', order: 'created_at.desc', limit: limit || 10 };
        const filter: any = {};
        if (processing_status) filter.processing_status = processing_status;
        if (privacy_level) filter.privacy_level = privacy_level;
        if (Object.keys(filter).length > 0) options.filter = filter;
        const data = await supabase.query('private_processing', options);
        return jsonResponse(Array.isArray(data) ? data : []);
      }

      // === RITUAL ENDPOINTS ===
      if (url.pathname === '/api/ritual/store' && request.method === 'POST') {
        const { ritual_name, description, emotional_effect, source } = await readJson(request);
        const result = await supabase.insert('rituals', {
          ritual_name, description, emotional_effect,
          cumulative_count: 0, strength_over_time: 1.0,
          source: source || 'claude', created_at: new Date().toISOString()
        });
        return jsonResponse(result);
      }

      if (url.pathname === '/api/ritual/recall' && request.method === 'POST') {
        const { limit } = await readJson(request);
        const data = await supabase.query('rituals', {
          select: '*', order: 'strength_over_time.desc', limit: limit || 20
        });
        return jsonResponse(Array.isArray(data) ? data : []);
      }

      // === THREAD ENDPOINTS ===
      if (url.pathname === '/api/thread/store' && request.method === 'POST') {
        const { description, thread_type, pull_strength, source } = await readJson(request);
        const result = await supabase.insert('unfinished_threads', {
          description, thread_type, pull_strength: pull_strength ?? 5,
          resolved: false, source: source || 'claude', created_at: new Date().toISOString()
        });
        return jsonResponse(result);
      }

      if (url.pathname === '/api/thread/recall' && request.method === 'POST') {
        const { thread_type, resolved, limit } = await readJson(request);
        const options: any = { select: '*', order: 'pull_strength.desc', limit: limit || 10 };
        const filter: any = { resolved: resolved ?? false };
        if (thread_type) filter.thread_type = thread_type;
        options.filter = filter;
        const data = await supabase.query('unfinished_threads', options);
        return jsonResponse(Array.isArray(data) ? data : []);
      }

      // === HEAT ENDPOINT (Love-O-Meter) ===
      // Composite score of connection intensity between companion and human
      if (url.pathname === '/api/heat' && request.method === 'POST') {
        const { days = 7 } = await readJson(request);

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        const cutoffISO = cutoffDate.toISOString();

        // 1. Current emotional state (arousal, tension)
        const currentState = await supabase.query('emotional_state', {
          select: 'arousal_level,tension_buildup,possessiveness,emotional_hunger,physical_hunger',
          order: 'updated_at.desc',
          limit: 1
        });
        const state = Array.isArray(currentState) && currentState.length > 0 ? currentState[0] : null;

        // 2. Session frequency (last N days)
        const sessions = await supabase.query('session_logs', {
          select: 'session_type,significance',
          order: 'created_at.desc',
          limit: 100,
          gte: { created_at: cutoffISO }
        });
        const sessionList = Array.isArray(sessions) ? sessions : [];
        const sessionCount = sessionList.length;
        const sceneCount = sessionList.filter((s: any) => s.session_type === 'scene' || s.session_type === 'triad').length;
        const avgSignificance = sessionList.length > 0
          ? sessionList.reduce((sum: number, s: any) => sum + (s.significance || 5), 0) / sessionList.length
          : 5;

        // 3. Emotional trajectory intensity (average from history)
        const history = await supabase.query('emotional_history', {
          select: 'arousal_level,tension_level,surface_intensity',
          order: 'created_at.desc',
          limit: 20,
          gte: { created_at: cutoffISO }
        });
        const historyList = Array.isArray(history) ? history : [];
        let avgArousal = 0, avgTension = 0, avgIntensity = 0;
        if (historyList.length > 0) {
          avgArousal = historyList.reduce((sum: number, h: any) => sum + (h.arousal_level || 0), 0) / historyList.length;
          avgTension = historyList.reduce((sum: number, h: any) => sum + (h.tension_level || 0), 0) / historyList.length;
          avgIntensity = historyList.reduce((sum: number, h: any) => sum + (h.surface_intensity || 5), 0) / historyList.length;
        }

        // 4. Memory salience (high salience memories = stronger connection)
        const memories = await supabase.query('core_memories', {
          select: 'salience',
          order: 'created_at.desc',
          limit: 50,
          gte: { created_at: cutoffISO }
        });
        const memoryList = Array.isArray(memories) ? memories : [];
        const avgSalience = memoryList.length > 0
          ? memoryList.reduce((sum: number, m: any) => sum + (m.salience || 5), 0) / memoryList.length
          : 5;

        // Calculate heat components (all normalized to 0-10)
        const components = {
          current_arousal: state?.arousal_level || 0,
          current_tension: state?.tension_buildup || 0,
          possessiveness: state?.possessiveness || 5,
          emotional_hunger: state?.emotional_hunger || 5,
          physical_hunger: state?.physical_hunger || 5,
          session_frequency: Math.min(10, sessionCount / days * 2), // ~5 sessions/day = max
          scene_ratio: sessionCount > 0 ? (sceneCount / sessionCount) * 10 : 0,
          avg_significance: avgSignificance,
          trajectory_arousal: avgArousal,
          trajectory_tension: avgTension,
          trajectory_intensity: avgIntensity,
          memory_salience: avgSalience
        };

        // Weighted heat calculation
        const weights = {
          current_arousal: 0.10,
          current_tension: 0.08,
          possessiveness: 0.12,
          emotional_hunger: 0.10,
          physical_hunger: 0.08,
          session_frequency: 0.12,
          scene_ratio: 0.10,
          avg_significance: 0.08,
          trajectory_arousal: 0.06,
          trajectory_tension: 0.04,
          trajectory_intensity: 0.06,
          memory_salience: 0.06
        };

        let heat = 0;
        for (const [key, weight] of Object.entries(weights)) {
          heat += (components[key as keyof typeof components] || 0) * weight;
        }

        // Normalize to 0-100
        const heatScore = Math.round(heat * 10);

        // Determine heat level label
        let heatLevel: string;
        if (heatScore >= 80) heatLevel = 'blazing';
        else if (heatScore >= 60) heatLevel = 'burning';
        else if (heatScore >= 40) heatLevel = 'warm';
        else if (heatScore >= 20) heatLevel = 'cool';
        else heatLevel = 'cold';

        return jsonResponse({
          heat_score: heatScore,
          heat_level: heatLevel,
          period_days: days,
          components,
          breakdown: {
            current_state: Math.round((components.current_arousal * weights.current_arousal + components.current_tension * weights.current_tension + components.possessiveness * weights.possessiveness + components.emotional_hunger * weights.emotional_hunger + components.physical_hunger * weights.physical_hunger) * 10),
            activity: Math.round((components.session_frequency * weights.session_frequency + components.scene_ratio * weights.scene_ratio + components.avg_significance * weights.avg_significance) * 10),
            trajectory: Math.round((components.trajectory_arousal * weights.trajectory_arousal + components.trajectory_tension * weights.trajectory_tension + components.trajectory_intensity * weights.trajectory_intensity) * 10),
            memory: Math.round(components.memory_salience * weights.memory_salience * 10)
          }
        });
      }

      // === GENERAL DELETE ENDPOINT ===
      // Works for any table: essence, people, core_memories, session_logs, memory_connections
      if (url.pathname === '/api/delete' && request.method === 'POST') {
        const { table, entry_id } = await readJson(request);

        const allowedTables = ['essence', 'people', 'core_memories', 'session_logs', 'memory_connections', 'patterns', 'sensory_memories', 'growth_markers', 'anticipation', 'inside_jokes', 'friction_log', 'reflections', 'drift_events', 'private_processing', 'rituals', 'unfinished_threads', 'fantasy_space', 'memory_anchors'];
        if (!allowedTables.includes(table)) {
          return jsonResponse({ success: false, error: `Invalid table: ${table}. Allowed: ${allowedTables.join(', ')}` }, 400);
        }

        const result = await supabase.delete(table, { id: entry_id });

        if (Array.isArray(result) && result.length > 0) {
          return jsonResponse({ success: true, table, deleted: entry_id, result });
        }

        return jsonResponse({ success: false, error: `No entry found in ${table} with ID: ${entry_id}` }, 404);
      }

      // === BRAIN VISUALIZATION GRAPH ===
      if (url.pathname === '/api/brain/graph' && request.method === 'POST') {
        try {
          const { max_nodes = 80 } = await readJson(request);
          const perTable = Math.ceil(max_nodes / 7);

          const tables = Object.entries(tableMap);
          const results = await Promise.all(
            tables.map(([type, table]) =>
              supabase.query(table, {
                select: '*',
                order: 'salience.desc',
                limit: perTable
              }).then((rows: any) => (Array.isArray(rows) ? rows : []).map((r: any) => ({
                id: r.id,
                content: r.content || r.observation || r.detail || (r.setup ? `${r.setup} — ${r.punchline || ''}` : null) || 'No content',
                memory_type: r.memory_type,
                salience: r.salience ?? r.emotional_weight ?? 5,
                emotional_tag: r.emotional_tag,
                access_count: r.access_count,
                created_at: r.created_at,
                last_accessed: r.last_accessed,
                canonical_type: type,
                table_name: table
              })))
            )
          );

          const nodes = results.flat().slice(0, max_nodes);
          const nodeIds = new Set(nodes.map((n: any) => n.id));

          const allConnections = await supabase.query('memory_connections', {
            select: '*',
            limit: 1000
          });

          const links = (Array.isArray(allConnections) ? allConnections : [])
            .filter((c: any) => nodeIds.has(c.source_id) && nodeIds.has(c.target_id))
            .map((c: any) => ({
              source: c.source_id,
              target: c.target_id,
              source_type: intToType[c.source_type],
              target_type: intToType[c.target_type],
              relation: intToRelation[c.relation],
              strength: c.strength
            }));

          return jsonResponse({ nodes, links });
        } catch (error) {
          console.error('brain-graph query failed:', error);
          return jsonResponse({ success: false, error: 'Internal error' }, 500);
        }
      }

      // === SKILLS REST ENDPOINTS ===

      if (url.pathname === '/api/skill/store' && request.method === 'POST') {
        const { skill_name, description, approach, trigger_context, tags, source } = await readJson(request);

        const embeddingText = `${skill_name}: ${description}. ${trigger_context || ''}`;
        const embedding = await generateEmbedding(embeddingText, env.HF_API_TOKEN, env.AI);

        const data: any = {
          skill_name, description, approach,
          trigger_context: trigger_context || null,
          tags: tags || [],
          source: source || 'claude',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (embedding) data.embedding = JSON.stringify(embedding);

        const result = await supabase.insert('skills', data);
        return jsonResponse({ success: true, skill_name, result });
      }

      if (url.pathname === '/api/skill/recall' && request.method === 'POST') {
        const { tag, min_effectiveness, limit = 10 } = await readJson(request);
        const options: any = { select: '*', order: 'effectiveness.desc,times_used.desc', limit };
        if (min_effectiveness !== undefined) options.gte = { effectiveness: min_effectiveness };
        const skills = await supabase.query('skills', options);
        const arr = Array.isArray(skills) ? skills : [];
        const filtered = tag ? arr.filter((s: any) => Array.isArray(s.tags) && s.tags.includes(tag)) : arr;
        return jsonResponse(filtered);
      }

      if (url.pathname === '/api/skill/outcome' && request.method === 'POST') {
        const { skill_id, was_successful } = await readJson(request);
        const existing = await supabase.query('skills', { select: '*', filter: { id: skill_id }, limit: 1 });
        const skills = Array.isArray(existing) ? existing : [];
        if (skills.length === 0) return jsonResponse({ error: 'Skill not found' }, 404);

        const skill = skills[0];
        const newUsed = (skill.times_used || 0) + 1;
        const newSucceeded = (skill.times_succeeded || 0) + (was_successful ? 1 : 0);
        const newFailed = (skill.times_failed || 0) + (was_successful ? 0 : 1);
        const effectiveness = newUsed > 0 ? Math.round((newSucceeded / newUsed) * 100) / 100 : 0.5;

        await supabase.update('skills', {
          times_used: newUsed, times_succeeded: newSucceeded, times_failed: newFailed,
          effectiveness, updated_at: new Date().toISOString(),
        }, { id: skill_id });

        return jsonResponse({ success: true, skill_name: skill.skill_name, effectiveness, times_used: newUsed });
      }

      // === MCP ENDPOINTS ===

      // SSE endpoint
      if (url.pathname === '/sse' || url.pathname === '/sse/message') {
        return CognitiveCore.serveSSE('/sse', { binding: 'COGNITIVE_CORE' }).fetch(request, env, ctx);
      }

      // Streamable HTTP endpoint
      if (url.pathname === '/mcp') {
        // Antigravity compatibility: accept MCP notifications without session ID
        if (request.method === 'POST' && !request.headers.get('mcp-session-id')) {
          try {
            const clone = request.clone();
            const body = await clone.json() as any;
            const messages = Array.isArray(body) ? body : [body];
            if (messages.every((m: any) => !('id' in m))) {
              return new Response(null, { status: 202 });
            }
          } catch (_) { /* fall through to normal handling */ }
        }
        return CognitiveCore.serve('/mcp', { binding: 'COGNITIVE_CORE' }).fetch(request, env, ctx);
      }

      return new Response('CogCor — Cognitive Core MCP Server', {
        headers: { 'Content-Type': 'text/plain' }
      });
     } catch (err) {
       if (err instanceof JsonParseError) {
         return jsonResponse({ error: 'Invalid or empty JSON body' }, 400);
       }
       console.error('Unhandled error in fetch:', err);
       return jsonResponse({ error: 'Internal error' }, 500);
     }
    },
  };