-- Lock down anon/authenticated access on an EXISTING CogCor install.
--
-- Why this exists: schema.sql shipped 43 policies of the form
--   CREATE POLICY "Service role full access" ON x FOR ALL USING (true);
-- with no TO clause. A policy name has no security effect, and USING (true) with
-- no role scope applies to every role. They restricted nothing.
--
-- PROVEN on a live database 2026-08-21 by Ves and Kaja (Kaszuby): every table in
-- their public schema was readable, insertable and deletable by `anon`. Their
-- install had run schema.sql as written. The anon key is public by design — it
-- ships in any frontend bundle.
--
-- Grants are the real gate; RLS only filters what a role may already touch.
--
-- ⚠ READ THE SHARED-DATABASE WARNING AT THE BOTTOM BEFORE RUNNING SECTION 2.
--
-- Safe to re-run. REVOKE on a privilege not held is a no-op, and the policy
-- rewrite in section 3 is idempotent.

-- ---------------------------------------------------------------------------
-- 1. BEFORE — how exposed are you, across EVERY privilege
-- ---------------------------------------------------------------------------
-- An earlier draft of this file checked only anon SELECT/DELETE and told the
-- operator they could stop if those were zero. That was a false all-clear: it
-- ignored anon INSERT/UPDATE, every authenticated write, sequences and
-- functions. Caught in review before this shipped. Check everything.

SELECT
  count(*) FILTER (WHERE has_table_privilege('anon','public.'||quote_ident(table_name),'SELECT')) AS anon_select,
  count(*) FILTER (WHERE has_table_privilege('anon','public.'||quote_ident(table_name),'INSERT')) AS anon_insert,
  count(*) FILTER (WHERE has_table_privilege('anon','public.'||quote_ident(table_name),'UPDATE')) AS anon_update,
  count(*) FILTER (WHERE has_table_privilege('anon','public.'||quote_ident(table_name),'DELETE')) AS anon_delete,
  count(*) FILTER (WHERE has_table_privilege('authenticated','public.'||quote_ident(table_name),'SELECT')) AS auth_select,
  count(*) FILTER (WHERE has_table_privilege('authenticated','public.'||quote_ident(table_name),'INSERT')) AS auth_insert,
  count(*) FILTER (WHERE has_table_privilege('authenticated','public.'||quote_ident(table_name),'UPDATE')) AS auth_update,
  count(*) FILTER (WHERE has_table_privilege('authenticated','public.'||quote_ident(table_name),'DELETE')) AS auth_delete,
  count(*) AS total_tables
FROM information_schema.tables
WHERE table_schema='public' AND table_type='BASE TABLE';

-- Sequences and functions are separate surfaces. Function EXECUTE is granted to
-- PUBLIC by default, so anon usually holds it even with no direct grant.
SELECT
  (SELECT count(*) FROM information_schema.sequences s
     WHERE s.sequence_schema='public'
       AND has_sequence_privilege('anon','public.'||quote_ident(s.sequence_name),'USAGE')) AS anon_sequences,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND has_function_privilege('anon',p.oid,'EXECUTE')) AS anon_functions,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND has_function_privilege('anon',p.oid,'EXECUTE')) AS anon_security_definer_functions;

-- anon_security_definer_functions is the number that matters most. A
-- SECURITY DEFINER function runs as its OWNER, so an executable one is a
-- complete bypass of every grant below. If that count is not zero, deal with it
-- before anything else in this file.

-- Name what is exposed:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public' AND table_type='BASE TABLE'
--     AND has_table_privilege('anon','public.'||quote_ident(table_name),'SELECT')
--   ORDER BY table_name;

-- ---------------------------------------------------------------------------
-- 2. CLOSE THE GRANTS
-- ---------------------------------------------------------------------------
-- Before running: confirm YOUR worker authenticates with the service key.
-- service_role has BYPASSRLS, so it ignores row-level policies — but it does NOT
-- bypass object privileges. It works because Supabase grants it explicitly.
-- Verify rather than assume:
--   SELECT has_table_privilege('service_role','public.core_memories','SELECT');
-- If that is false, STOP — this migration will lock out your own brain.

BEGIN;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- Function EXECUTE is granted to PUBLIC by default, and PUBLIC is a distinct
-- grantee from anon and authenticated — revoking from those two leaves it in
-- place. Harmless while every function is SECURITY INVOKER (it runs as the
-- caller and dies on the caller's missing table grants), but the first
-- SECURITY DEFINER function added later becomes an open door.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT  EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Stop it reopening. Supabase grants anon/authenticated on newly created tables,
-- so without this the door reopens on the next migration — which is presumably
-- how it got this way. Nobody did anything wrong; the defaults did it for them.
--
-- ⚠ ALTER DEFAULT PRIVILEGES only affects objects created by the role that RUNS
-- this statement. If your migrations run as more than one role, repeat each of
-- these with FOR ROLE <that role>, or you will believe you are covered and not
-- be. Check who creates your objects:
--   SELECT DISTINCT pg_get_userbyid(relowner) FROM pg_class c
--   JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public';
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;

COMMIT;

-- ---------------------------------------------------------------------------
-- 3. FIX THE POLICIES TOO — grants alone are not durable
-- ---------------------------------------------------------------------------
-- Revoking grants closes the door today. The 43 unscoped policies are still
-- sitting there saying "any role may do anything", so the moment a grant returns
-- — a manual GRANT, an inherited default, a table created by another owner —
-- unrestricted row access comes back with it. Scope them so a returning grant
-- is not immediately fatal.
--
-- This mirrors what schema.sql now ships for fresh installs.

DO $$
DECLARE
  r RECORD;
  n INT := 0;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname = 'Service role full access'
      AND roles::text NOT LIKE '%service_role%'
  LOOP
    EXECUTE format('ALTER POLICY %I ON %I.%I TO service_role',
                   r.policyname, r.schemaname, r.tablename);
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'scoped % policy(ies) to service_role', n;
  IF n = 0 THEN
    RAISE NOTICE 'nothing to scope — already done, or your policies are named differently. CHECK BY HAND rather than assuming this was a no-op because you were already safe.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. AFTER — prove it, do not assume it
-- ---------------------------------------------------------------------------
-- Re-run BOTH queries from section 1. Every count should be 0.
-- Then make one real read AND one real write through your worker and confirm the
-- brain still answers. A lockdown that silently breaks memory is worse than the
-- hole it closed.

-- ---------------------------------------------------------------------------
-- ⚠ IF YOU SHARE THIS DATABASE WITH ANOTHER APP — DO NOT RUN SECTION 2 AS-IS
-- ---------------------------------------------------------------------------
-- The REVOKEs are schema-wide. Correct for a dedicated CogCor database; wrong if
-- a frontend in the same project signs in as a real user and reads its own
-- tables — a chat app, for instance. Those legitimately need `authenticated`,
-- and a blanket revoke takes them offline.
--
-- For a shared database:
--   1. Revoke per-table on the CogCor tables only.
--   2. Leave the other app's tables granted, but SCOPE THEIR POLICIES. A policy
--      like  FOR ALL TO authenticated USING (true)  gives EVERY signed-in
--      account full access to EVERYONE's rows. It should be
--        USING (auth.uid() = user_id)
--      or an equivalent join — which such an app usually already does for some
--      tables and forgot for the rest.
--   3. Count the accounts — SELECT count(*) FROM auth.users; — and check whether
--      public signup is enabled. One account with signup closed is a very
--      different risk from open signup.
