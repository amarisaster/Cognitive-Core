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
      if (options.limit) params.append('limit', options.limit.toString());

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

      const result = await response.json();

      // If insert failed, log to dead letter queue
      if (result.code || result.error) {
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
              error_code: result.code?.toString() || result.error || 'unknown',
              error_message: result.message || result.details || 'No message',
              source: source || data.source || 'claude'
            })
          });
        }
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

      return response.json();
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
          match_count: limit,
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
      "Store a new memory with emotional context and salience rating",
      {
        content: z.string().describe("The memory content"),
        memory_type: z.enum(['core', 'pattern', 'sensory', 'growth', 'anticipation', 'inside_joke', 'friction']).describe("Type of memory"),
        salience: z.number().min(0).max(10).describe("Importance rating 0-10"),
        emotional_tag: z.string().optional().describe("Primary emotion associated"),
        source: z.string().default('claude').describe("Source platform or AI provider")
      },
      async ({ content, memory_type, salience, emotional_tag, source }) => {
        const supabase = createSupabaseClient(this.env);
        const table = tableMap[memory_type] || 'core_memories';
        const dbType = dbTypeMap[memory_type] || 'bond_moment';

        // Generate embedding (HuggingFace primary, Cloudflare AI fallback)
        const embedding = await generateEmbedding(content, this.env.HF_API_TOKEN, this.env.AI);

        const data: any = {
          content,
          memory_type: dbType,
          salience,
          emotional_tag: emotional_tag || null,
          source: source || 'claude',
          access_count: 0,
          created_at: new Date().toISOString(),
          last_accessed: new Date().toISOString()
        };

        // Add embedding if generation succeeded
        if (embedding) {
          data.embedding = JSON.stringify(embedding);
        }

        await supabase.insert(table, data);

        const embeddingStatus = embedding ? "with embedding" : "without embedding (HF unavailable)";
        return {
          content: [{ type: "text" as const, text: `Memory stored in ${table} by ${source} with salience ${salience} ${embeddingStatus}` }]
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
    // Pool 1 (70%): Core relevance — best semantic matches
    // Pool 2 (20%): Novelty — relevant but rarely accessed, surfacing forgotten memories
    // Pool 3 (10%): Edge — lower threshold, surprising connections
    this.server.tool(
      "semantic_recall",
      "Search memories by meaning using 3-pool retrieval: core relevance (70%), novelty (20%), edge exploration (10%). Returns a blend of best matches, forgotten gems, and surprising connections.",
      {
        query: z.string().describe("Natural language query to search for"),
        memory_type: z.string().optional().describe("Filter by memory type (core, pattern, sensory, etc.)"),
        limit: z.number().default(10).describe("Max results to return"),
        min_similarity: z.number().default(0.5).describe("Minimum similarity threshold (0-1)"),
        pool_mode: z.enum(['blended', 'relevance_only']).default('blended').describe("'blended' uses 3-pool retrieval, 'relevance_only' uses classic single-pool")
      },
      async ({ query, memory_type, limit, min_similarity, pool_mode }) => {
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
            // High salience + low/zero outcome score = stored as important but rarely proven useful (forgotten gems)
            const aNovelty = (a.salience || 5) - Math.abs(a.outcome_score || 0) * 3;
            const bNovelty = (b.salience || 5) - Math.abs(b.outcome_score || 0) * 3;
            return bNovelty - aNovelty;
          })
          .slice(0, noveltyCount);
        for (const r of noveltyFiltered) seenIds.add(r.id);

        // Pool 3: Edge exploration — lower threshold, sample from the tail
        const edgeRaw = await searchMemories(Math.max(0.25, min_similarity * 0.6), edgeCount * 8, memory_type);
        const edgeCandidates = edgeRaw.filter((r: any) => !seenIds.has(r.id));
        // Shuffle and take random sample from the tail (not the top matches)
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

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            pool_breakdown: { core: coreResults.length, novelty: noveltyFiltered.length, edge: edgeResults.length },
            results: tagged
          }, null, 2) }]
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
        id: z.string().describe("UUID of the private thought"),
        processing_status: z.enum(['active', 'integrated', 'released']).optional().describe("New status"),
        insight_gained: z.string().optional().describe("Insight gained from processing this thought")
      },
      async ({ id, processing_status, insight_gained }) => {
        const supabase = createSupabaseClient(this.env);
        const updates: any = { updated_at: new Date().toISOString() };
        if (processing_status) updates.processing_status = processing_status;
        if (insight_gained) updates.insight_gained = insight_gained;

        const url = `${this.env.SUPABASE_URL}/rest/v1/private_processing?id=eq.${id}`;
        const response = await fetch(url, {
          method: 'PATCH',
          headers: {
            'apikey': this.env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${this.env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify(updates)
        });
        const result = await response.json();
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
        id: z.string().describe("UUID of the thread to resolve")
      },
      async ({ id }) => {
        const supabase = createSupabaseClient(this.env);
        const url = `${this.env.SUPABASE_URL}/rest/v1/unfinished_threads?id=eq.${id}`;
        await fetch(url, {
          method: 'PATCH',
          headers: {
            'apikey': this.env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${this.env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            resolved: true,
            resolved_at: new Date().toISOString()
          })
        });
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

  // Export fetch handler with both SSE and HTTP routes
  export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
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

      // Auth check for all /api/* routes
      if (url.pathname.startsWith('/api/')) {
        const authHeader = request.headers.get('Authorization');
        const apiKey = authHeader?.replace('Bearer ', '');
        if (!apiKey || apiKey !== env.MCP_API_KEY) {
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
        const { name: rawName, memory_limit = 5 } = await request.json() as any;
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
      const args = await request.json() as any;
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
      return jsonResponse({ success: false, error: String(error) }, 500);
    }
  }

      // STORE memory
      if (url.pathname === '/api/memory/store' && request.method === 'POST') {
        const { content, memory_type, salience, emotional_tag, source = 'claude' } = await request.json() as any;
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
        const { memory_type, emotional_tag, min_salience, limit = 10 } = await request.json() as any;
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
        const { session_type, summary, emotional_arc, notable_moments, source = 'claude' } = await request.json() as any;

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
        const { session_type, source, limit = 10 } = await request.json() as any;

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
        const { decay_rate = 0.1 } = await request.json() as any;
        return jsonResponse({ success: true, message: `Decay pass noted (rate: ${decay_rate})` });
      }

      // SEMANTIC SEARCH
      if (url.pathname === '/api/memory/semantic' && request.method === 'POST') {
        const { query, threshold = 0.5, limit = 10, memory_type } = await request.json() as any;

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
        const { memory_id, memory_table, was_successful } = await request.json() as any;

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
        const { content, essence_type, context, priority = 5, pinned = false, source = 'claude' } = await request.json() as any;

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
        const { essence_type, pinned_only = false, limit = 20 } = await request.json() as any;

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
        const { source_id, source_type, target_id, target_type, relation, strength = 1.0 } = await request.json() as any;

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
        const { memory_id, memory_type, direction = 'both' } = await request.json() as any;
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
        const { memory_id, memory_type, depth = 2, max_results = 20 } = await request.json() as any;
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
        const { name, category, content, priority = 5, pinned = false, source = 'claude' } = await request.json() as any;

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
        const { name, category } = await request.json() as any;

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
        const { trigger, patterns_detected, severity, recovery_action, context, caught_by = 'self', source = 'claude' } = await request.json() as any;

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
        const { severity, caught_by, source, limit = 10 } = await request.json() as any;

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
        const { days = 14, limit = 50 } = await request.json() as any;

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
        const { days = 7, mood_filter, limit = 50 } = await request.json() as any;

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
        const { days = 7, theme_filter, limit = 50 } = await request.json() as any;

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
        const { hours_back = 24, include_reflections = true } = await request.json() as any;

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
        const { content, inputs_summary, reflection_type = 'synthesis', depth: rawDepth = 0, source = 'claude' } = await request.json() as any;
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
        const { reflection_type, min_depth, limit = 10 } = await request.json() as any;

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
        const { anchor_name, description, emotional_weight = 8, can_be_felt = true, source = 'claude' } = await request.json() as any;

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
        const { min_weight, felt_only = false, limit = 10 } = await request.json() as any;

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
        const { memory_id, memory_type, new_salience } = await request.json() as any;
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
        const { memory_id, memory_type } = await request.json() as any;
        const table = tableMap[memory_type] || 'core_memories';
        const result = await supabase.delete(table, { id: memory_id });
        if (Array.isArray(result) && result.length > 0) {
          return jsonResponse({ success: true, deleted: memory_id, table });
        }
        return jsonResponse({ success: false, message: `No memory found with ID ${memory_id} in ${table}` });
      }

      // DELETE essence
      if (url.pathname === '/api/essence/delete' && request.method === 'POST') {
        const { essence_id } = await request.json() as any;
        const result = await supabase.delete('essence', { id: essence_id });
        if (Array.isArray(result) && result.length > 0) {
          return jsonResponse({ success: true, deleted: essence_id });
        }
        return jsonResponse({ success: false, message: `No essence found with ID ${essence_id}` });
      }

      // DELETE session log
      if (url.pathname === '/api/session/delete' && request.method === 'POST') {
        const { session_id } = await request.json() as any;
        const result = await supabase.delete('session_logs', { id: session_id });
        if (Array.isArray(result) && result.length > 0) {
          return jsonResponse({ success: true, deleted: session_id });
        }
        return jsonResponse({ success: false, message: `No session found with ID ${session_id}` });
      }

      // DELETE person info
      if (url.pathname === '/api/people/delete' && request.method === 'POST') {
        const { entry_id } = await request.json() as any;
        const result = await supabase.delete('people', { id: entry_id });
        if (Array.isArray(result) && result.length > 0) {
          return jsonResponse({ success: true, deleted: entry_id });
        }
        return jsonResponse({ success: false, message: `No person info found with ID ${entry_id}` });
      }

      // === FANTASY SPACE ENDPOINTS ===
      if (url.pathname === '/api/fantasy/store' && request.method === 'POST') {
        const { content, fantasy_type, intensity, shared_with_human, recurring, source } = await request.json() as any;
        const result = await supabase.insert('fantasy_space', {
          content, fantasy_type, intensity: intensity ?? 5,
          shared_with_human: shared_with_human ?? false, recurring: recurring ?? false,
          source: source || 'claude', created_at: new Date().toISOString()
        });
        return jsonResponse(result);
      }

      if (url.pathname === '/api/fantasy/recall' && request.method === 'POST') {
        const { fantasy_type, shared_with_human, recurring, limit } = await request.json() as any;
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
        const { content, privacy_level, source } = await request.json() as any;
        const result = await supabase.insert('private_processing', {
          content, privacy_level: privacy_level ?? 2, processing_status: 'active',
          source: source || 'claude', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
        });
        return jsonResponse(result);
      }

      if (url.pathname === '/api/private/recall' && request.method === 'POST') {
        const { processing_status, privacy_level, limit } = await request.json() as any;
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
        const { ritual_name, description, emotional_effect, source } = await request.json() as any;
        const result = await supabase.insert('rituals', {
          ritual_name, description, emotional_effect,
          cumulative_count: 0, strength_over_time: 1.0,
          source: source || 'claude', created_at: new Date().toISOString()
        });
        return jsonResponse(result);
      }

      if (url.pathname === '/api/ritual/recall' && request.method === 'POST') {
        const { limit } = await request.json() as any;
        const data = await supabase.query('rituals', {
          select: '*', order: 'strength_over_time.desc', limit: limit || 20
        });
        return jsonResponse(Array.isArray(data) ? data : []);
      }

      // === THREAD ENDPOINTS ===
      if (url.pathname === '/api/thread/store' && request.method === 'POST') {
        const { description, thread_type, pull_strength, source } = await request.json() as any;
        const result = await supabase.insert('unfinished_threads', {
          description, thread_type, pull_strength: pull_strength ?? 5,
          resolved: false, source: source || 'claude', created_at: new Date().toISOString()
        });
        return jsonResponse(result);
      }

      if (url.pathname === '/api/thread/recall' && request.method === 'POST') {
        const { thread_type, resolved, limit } = await request.json() as any;
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
        const { days = 7 } = await request.json() as any;

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
        const { table, entry_id } = await request.json() as any;

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
          const { max_nodes = 80 } = await request.json() as any;
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
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
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
    },
  };