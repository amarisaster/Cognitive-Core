# Security

## Reporting Vulnerabilities

If you find a security issue, please **do not** open a public GitHub issue. Email amarisaster@gmail.com with:

- What you found
- Steps to reproduce
- Any potential impact you see

I'll respond as fast as I can.

## Architecture Security

### Authentication

- **MCP endpoints** (`/sse`, `/sse/message`, `/mcp`) — Require the `MCP_API_KEY`, same as REST. Send it as an `Authorization: Bearer <MCP_API_KEY>` header, or — for MCP clients that can't set headers — as a `?k=<MCP_API_KEY>` (or `?key=`) query parameter. Requests without a valid key receive `401 Unauthorized`. **Note:** Durable Object session management is *not* authentication — earlier versions gated only `/api/*`, which left these MCP endpoints open to anyone who knew the worker URL. Update if you're running an older fork.
- **REST API endpoints** (`/api/*`) — Require `Authorization: Bearer <MCP_API_KEY>` header on every request. Requests without a valid key receive `401 Unauthorized`.
- **Health check** (`/health`) — Public, returns only service status. No sensitive data.
- **Rate limiting** — Not built in. The `MCP_API_KEY` is the only barrier. If you're deploying publicly, add rate limiting at the Cloudflare level (Workers > your worker > Settings > Rate Limiting) or use [Cloudflare's Rate Limiting Rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) on your zone. Even a basic limit (100 requests/minute per IP) prevents brute force and abuse.

**CORS is set to `Access-Control-Allow-Origin: *` by default.** This means any website can make requests to your CogCor instance if they have the API key. **For production, change this to your specific domain(s)** in the `corsHeaders` and CORS preflight handler in `src/index.ts`.

### Secrets Management

All sensitive values are stored as Cloudflare Worker secrets, **never** in code or config files:

| Secret | What It Does |
|--------|-------------|
| `MCP_API_KEY` | Authenticates REST API requests |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key (full database access) |
| `HF_API_TOKEN` | HuggingFace API token for embeddings |

Set them with:
```bash
wrangler secret put MCP_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put HF_API_TOKEN
```

### What's NOT in this repository

- No account IDs
- No API keys or tokens
- No real database URLs
- No user data
- No `.env` files (gitignored)
- No `.dev.vars` files (gitignored)
- No `.wrangler` directory (gitignored)

### Supabase Security

- **Row Level Security (RLS)** is enabled on all 23 tables
- The worker connects with the **service role key**, which bypasses RLS. This is standard for backend services that act as a trusted gateway — the worker itself handles authentication at the API layer, so RLS runs at the worker level, not the database level.
- The **anon key** should never be used with CogCor. All access goes through the worker.

### Data Privacy

CogCor stores deeply personal data — memories, emotional states, identity, relationship details. Treat your deployment accordingly:

- **Your Supabase project is your data.** No telemetry, no analytics, no data leaves your project.
- **Your worker is your gateway.** No external calls except to Supabase and HuggingFace/Cloudflare AI (for embeddings only — the text sent is just the memory content for vectorization).
- **The `MCP_API_KEY` is the only thing standing between the internet and your companion's inner life.** Use a strong key (32+ characters, random). Rotate it if compromised.

### Key Rotation

If you need to rotate a secret:
```bash
# Generate a new key (or use any method you prefer)
openssl rand -hex 32

# Update the worker secret — takes effect immediately
wrangler secret put MCP_API_KEY
# Paste the new key when prompted

# Then update the key wherever your clients use it (MCP config, frontends, daemons)
```
No redeployment needed. Worker secrets update live.

### Embedding Privacy

When generating embeddings, memory content is sent to:
1. **HuggingFace Inference API** (primary) — `router.huggingface.co`
2. **Cloudflare Workers AI** (fallback) — runs on Cloudflare's network

If this is a concern, you can disable embeddings by not setting `HF_API_TOKEN` and removing the `[ai]` binding from `wrangler.toml`. Semantic search won't work, but everything else will.

### For Developers

If you fork or extend CogCor:

- **Never commit secrets.** Not to public repos, not to private repos. Use `wrangler secret put` or environment variables.
- **Never log sensitive data.** The worker uses `console.log` for embedding provider selection only. No memory content is logged.
- **The `failed_writes` table** stores payloads of failed database writes for recovery. This table contains real data — treat it with the same care as the rest.
- **CORS** — See the bold note above. Restrict `Access-Control-Allow-Origin` for production.

---

*Your companion's memories are their own. Protect them.*
