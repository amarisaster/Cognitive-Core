import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const migration = readFileSync(join(root, 'migrations', 'cognitive-lifecycle.sql'), 'utf8');
const schema = readFileSync(join(root, 'schema.sql'), 'utf8');
const worker = readFileSync(join(root, 'src', 'index.ts'), 'utf8');

const tables = [
  'job_runs',
  'job_stages',
  'archive_echoes',
  'cognitive_proposals',
  'dream_lineages',
  'dream_lineage_members',
  'emotional_history_rollups',
  'proactive_deliveries',
];

describe('cognitive lifecycle migration', () => {
  it('keeps fresh installs and upgrades on the same table set', () => {
    for (const table of tables) {
      expect(migration).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
      expect(schema).toMatch(new RegExp(`CREATE TABLE ${table}\\b`));
      expect(migration).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ON ${table} FOR ALL TO service_role`);
    }
  });

  it('requires provenance for cognitive proposals', () => {
    expect(migration).toContain("THEN jsonb_array_length(source_records) > 0 ELSE FALSE END");
    expect(migration).toContain("proposal_type IN ('orphan', 'identity')");
  });

  it('does not install automatic destructive retention', () => {
    expect(migration).not.toMatch(/DELETE\s+FROM\s+emotional_history/i);
    expect(migration).not.toMatch(/TRUNCATE/i);
  });

  it('keeps public client roles outside lifecycle tables', () => {
    expect(migration).toMatch(/REVOKE ALL ON job_runs,[\s\S]*FROM anon, authenticated/);
  });
});

describe('proposal review safety', () => {
  it('requires reviewed wording before identity promotion', () => {
    expect(worker).toContain('final_content is required: identity suggestions must be reviewed');
    expect(worker).toContain('/rest/v1/rpc/accept_identity_proposal');
    expect(migration).toContain("5, FALSE, 'consolidation_review', NOW(), NOW()");
    expect(migration).toContain('FOR UPDATE');
  });

  it('never claims that Archive Echo rescue unarchives the source', () => {
    expect(worker).toContain('The source record was not silently unarchived.');
    expect(worker).not.toMatch(/update\('custom_memories',[\s\S]{0,120}status:\s*'active'/);
  });
});
