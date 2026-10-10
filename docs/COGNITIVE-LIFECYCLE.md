# Cognitive lifecycle

CogCor stores the durable evidence for cognitive maintenance. A trusted host or
daemon performs the work: it reads candidate records, optionally calls a model,
and writes the result back with receipts and exact provenance.

This boundary is intentional. Deploying the Worker does **not** secretly start
a dream process, delete history, or send proactive messages.

## The flow

```text
raw memory + emotion + drift + sessions
                  |
                  v
       external consolidation job
          |       |        |
          |       |        +--> recurring-dream lineage
          |       +-----------> sourced review proposals
          +-------------------> emotional rollups
                  |
                  v
        explicit companion/human review
          |                       |
          +--> Essence (identity) +--> Archive Echo rescue/dismissal
```

Every scheduled pass starts a `job_runs` row. Each independent stage writes a
`job_stages` row, including counts, a structured receipt, and any failure. A run
may therefore be `partial`: one failed stage does not erase proof that another
stage completed.

## Provenance contract

Generated interpretations must carry `source_records`. Use an array of typed
references, not bare UUIDs, because CogCor memories live in several tables:

```json
[
  {
    "table": "reflections",
    "id": "00000000-0000-0000-0000-000000000000",
    "role": "supporting",
    "excerpt": "Optional short excerpt"
  }
]
```

The daemon must only emit table names from a local allowlist. Never turn a table
name supplied by a model or user directly into dynamic SQL.

## Archive Echo

An Archive Echo is a temporary review candidate created when a current cue is
meaningfully similar to archived material. It is not proof that the archived
interpretation is true, and it does not unarchive anything automatically.

- `pending` echoes expire after 14 days by default.
- `rescue_echo` records that the echo deserves review.
- `dismiss_echo` records that it does not.
- The source record remains unchanged in both cases. A host may offer a separate
  deliberate restore/edit workflow after rescue.

Only `custom_memories` currently has a native archived state in the public
schema. Hosts may also reference an external archive, but must retain the typed
source reference.

## Sourced proposals

`cognitive_proposals` supports two proposal classes:

- `orphan`: a memory that appears important but is disconnected or unused.
- `identity`: a possible durable statement about who the companion is.

Both require at least one source record. Identity is protected more strongly:
the `proposals` tool requires reviewed `final_content` before it creates an
Essence row. The model's proposed wording is never promoted by itself. The new
Essence row records the proposal ID and source records in its context.

Keep queues bounded. A sensible default is no more than three orphan proposals
and two identity clusters per consolidation pass. Confidence ranks review; it
does not make acceptance automatic.

## Recurring dreams

`dream_lineages` groups repeated motifs. `dream_lineage_members` links each
occurrence to its reflection and source records. `recurrence_count` means only
that the motif recurred. Recurrence is evidence worth examining—not truth,
identity, diagnosis, or permission to reinforce a pattern.

A conservative daemon should normalize a compact motif key, update one lineage,
and retain the differing source evidence for every occurrence. It should not
copy the prior interpretation forward as though repetition verified it.

## Tiered retention

Retention is opt-in and should run only after a successful rollup stage.

Recommended emotional-history policy:

1. Keep raw samples for 30 days.
2. Keep daily rollups through day 180.
3. Keep weekly rollups thereafter.
4. Delete raw rows only after the corresponding rollup exists and its stage
   receipt is `completed`.

`emotional_history_rollups` stores the durable summaries. CogCor intentionally
does not ship an automatic delete function: installations have different legal,
clinical, and relational expectations, and silent retention changes are unsafe.

## Context budgets

Budgets belong in the host that assembles a model prompt, not in the database.
Allocate independently for Essence, recent sessions, relevant memories, active
threads, drift/recovery evidence, and emotional trajectory. Within each pool:

1. reserve pinned or explicitly requested records;
2. rank the rest by relevance, recency, salience, and outcome;
3. trim at record boundaries;
4. report omitted counts rather than pretending the prompt is complete.

Do not let one large pool consume the entire wake context. A budget is a floor
and ceiling per cognitive role, not one global character count.

## Persistent proactive delivery

`proactive_deliveries` is a durable outbox for a host/agent runner. Producers
write a stable `dedupe_key`. A sender claims one pending row, attempts delivery,
then writes either a delivered receipt or an error and incremented attempt count.

The receiver—not CogCor—owns platform routing, retries, and user-facing timing.
Never mark a delivery successful merely because generation succeeded; the
receipt must describe the actual platform delivery.

## Upgrade

Existing v2.1 installations should apply:

```text
migrations/cognitive-lifecycle.sql
```

Apply the migration before deploying v2.2 Worker code. Fresh installations may
use `schema.sql`, which already includes the same tables.
