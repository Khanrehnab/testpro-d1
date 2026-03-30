-- ═══════════════════════════════════════════════════════════════════
-- TestPro — Supabase SQL Setup Script
-- Run this once in the Supabase SQL Editor (safe to re-run)
-- ═══════════════════════════════════════════════════════════════════


-- ── 1. MODULES ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS modules (
  id       text PRIMARY KEY,
  name     text NOT NULL,
  position integer NOT NULL DEFAULT 0
);


-- ── 2. TESTS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tests (
  id          text PRIMARY KEY,
  module_id   text NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  serial_no   integer NOT NULL DEFAULT 0,
  name        text NOT NULL,
  description text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS tests_module_id_idx ON tests(module_id);


-- ── 3. STEPS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS steps (
  id         text PRIMARY KEY,
  test_id    text NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  position   integer NOT NULL DEFAULT 0,
  serial_no  integer,                          -- NULL for divider rows
  action     text NOT NULL DEFAULT '',
  result     text NOT NULL DEFAULT '',
  remarks    text NOT NULL DEFAULT '',
  status     text NOT NULL DEFAULT 'pending'   -- 'pending' | 'pass' | 'fail'
               CHECK (status IN ('pending', 'pass', 'fail')),
  is_divider boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS steps_test_id_idx ON steps(test_id);


-- ── 4. USERS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  password text NOT NULL,
  name     text NOT NULL,
  email    text NOT NULL DEFAULT '',
  role     text NOT NULL DEFAULT 'tester'      -- 'admin' | 'tester'
             CHECK (role IN ('admin', 'tester')),
  active   boolean NOT NULL DEFAULT true
);


-- ── 5. TEST LOCKS ────────────────────────────────────────────────────
-- Prevents two testers from editing the same test simultaneously.
-- Locks expire after 60s of no heartbeat (TTL handled in app code).
CREATE TABLE IF NOT EXISTS test_locks (
  test_id   text PRIMARY KEY,
  user_id   text NOT NULL,
  user_name text NOT NULL,
  locked_at timestamptz DEFAULT now()
);

-- RLS must be ENABLED on test_locks (it's the only table that needs it)
ALTER TABLE test_locks ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated and anonymous operations (app handles auth itself)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'test_locks' AND policyname = 'allow_all'
  ) THEN
    CREATE POLICY "allow_all" ON test_locks
      FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;


-- ── 6. AUDIT LOG ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_name  text NOT NULL,
  action     text NOT NULL,
  type       text NOT NULL DEFAULT 'info'      -- 'info' | 'pass' | 'fail'
               CHECK (type IN ('info', 'pass', 'fail')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log(created_at DESC);


-- ── 7. REALTIME ──────────────────────────────────────────────────────
-- Add tables to the realtime publication one at a time.
-- Safe to run even if already added (DO block suppresses duplicate errors).
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE modules;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE tests;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE steps;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE users;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE test_locks;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── 8. RLS — DISABLE ON APP TABLES ──────────────────────────────────
-- TestPro handles its own auth (username/password in users table).
-- RLS is intentionally OFF on these tables so the app can read/write freely.
ALTER TABLE modules   DISABLE ROW LEVEL SECURITY;
ALTER TABLE tests     DISABLE ROW LEVEL SECURITY;
ALTER TABLE steps     DISABLE ROW LEVEL SECURITY;
ALTER TABLE users     DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY;


-- ── 9. SAMPLE SEED DATA (optional — delete if importing your own CSVs) ──
-- Uncomment the block below ONLY if you want a quick test dataset.
-- If you are importing via CSV, skip this section entirely.

/*
INSERT INTO modules (id, name, position) VALUES
  ('m1', 'Authentication Module', 0),
  ('m2', 'Dashboard Module',      1),
  ('m3', 'User Management Module',2)
ON CONFLICT (id) DO NOTHING;

INSERT INTO tests (id, module_id, serial_no, name, description) VALUES
  ('m1_t1', 'm1', 1, 'Login Flow',      'Verify all login scenarios'),
  ('m1_t2', 'm1', 2, 'Logout Flow',     'Verify session termination'),
  ('m1_t3', 'm1', 3, 'Password Reset',  'Verify password reset via email'),
  ('m1_t4', 'm1', 4, 'Remember Me',     'Verify persistent session cookie'),
  ('m1_t5', 'm1', 5, 'Account Lockout', 'Verify lockout after failed attempts'),
  ('m2_t1', 'm2', 1, 'Dashboard Load',      'Verify dashboard renders correctly'),
  ('m2_t2', 'm2', 2, 'Stats Cards',         'Verify statistics display accurately'),
  ('m2_t3', 'm2', 3, 'Module Navigation',   'Verify module list and navigation'),
  ('m2_t4', 'm2', 4, 'Search Functionality','Verify module search filter'),
  ('m2_t5', 'm2', 5, 'Responsive Layout',   'Verify layout on mobile viewport'),
  ('m3_t1', 'm3', 1, 'Create User',    'Verify admin can create new users'),
  ('m3_t2', 'm3', 2, 'Edit User',      'Verify admin can edit user details'),
  ('m3_t3', 'm3', 3, 'Deactivate User','Verify admin can deactivate accounts'),
  ('m3_t4', 'm3', 4, 'Role Assignment','Verify role change takes effect'),
  ('m3_t5', 'm3', 5, 'User Listing',   'Verify user list loads and filters')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (username, password, name, email, role, active) VALUES
  ('admin',   'admin123', 'Administrator', 'admin@testpro.io', 'admin',  true),
  ('tester1', 'test123',  'Alex Johnson',  'alex@testpro.io',  'tester', true),
  ('tester2', 'test123',  'Priya Sharma',  'priya@testpro.io', 'tester', true)
ON CONFLICT (username) DO NOTHING;
*/

-- ═══════════════════════════════════════════════════════════════════
-- Done. Your TestPro schema is ready.
-- Import your data via: Supabase → Table Editor → Insert → Import CSV
-- Order: modules → tests → steps → users
-- ═══════════════════════════════════════════════════════════════════
