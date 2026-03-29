import { supabase } from "./supabase";
import React, { useState, useEffect, useRef, useCallback, useMemo, useContext } from "react";

// ── Storage ────────────────────────────────────────────────────────────────────

const store = {
  async loadAll() {
    try {
      const [
        { data: users,   error: usersErr },
        { data: modules, error: modsErr  },
        { data: tests,   error: testsErr },
        { data: steps,   error: stepsErr },
      ] = await Promise.all([
        supabase.from("users").select("*").limit(10_000),
        supabase.from("modules").select("*").order("position").limit(10_000),
        supabase.from("tests").select("*").order("serial_no").limit(100_000),
        supabase.from("steps").select("*").order("position").limit(10_000_000),
      ]);

      // Surface Supabase errors so they are not silently swallowed
      if (usersErr)  console.error("Load users error",   usersErr);
      if (modsErr)   console.error("Load modules error", modsErr);
      if (testsErr)  console.error("Load tests error",   testsErr);
      if (stepsErr)  console.error("Load steps error",   stepsErr);

      // If any critical table fails, return empty so App falls back to seed
      if (modsErr || testsErr || stepsErr) {
        return { users: users || [], modules: {} };
      }

      // Rebuild nested structure: modules → tests → steps
      const stepsByTest = {};
      for (const s of steps || []) {
        if (!stepsByTest[s.test_id]) stepsByTest[s.test_id] = [];
        stepsByTest[s.test_id].push({
          ...s,
          serialNo:  s.serial_no,
          isDivider: s.is_divider ?? false,
        });
      }

      const testsByModule = {};
      for (const t of tests || []) {
        if (!testsByModule[t.module_id]) testsByModule[t.module_id] = [];
        testsByModule[t.module_id].push({
          ...t,
          serialNo: t.serial_no,  // normalise snake_case → camelCase for local usage
          steps: stepsByTest[t.id] || [],
        });
      }

      const modulesMap = {};
      for (const m of modules || []) {
        modulesMap[m.id] = { ...m, tests: testsByModule[m.id] || [] };
      }

      return { users: users || [], modules: modulesMap };
    } catch (e) {
      console.error("Load error", e);
      return { users: [], modules: {} };
    }
  },

  async saveUsers(users) {
    // Split into new vs existing — new users have no valid UUID yet
    // We identify "new" rows as those whose id is NOT a UUID (e.g. temp Date.now() ids)
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const toInsert = users.filter(u => !uuidRe.test(u.id));
    const toUpsert = users.filter(u =>  uuidRe.test(u.id));

    // Delete users that have been removed from local state but still exist in DB.
    // Only attempt if there are surviving UUID users to use as the exclusion list.
    const liveUUIDs = toUpsert.map(u => u.id);
    if (liveUUIDs.length) {
      await supabase
        .from("users")
        .delete()
        .not("id", "in", `(${liveUUIDs.join(",")})`);
    } else if (!toInsert.length) {
      // No live users at all — wipe the table (edge case: all users deleted)
      await supabase.from("users").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    }

    if (toInsert.length) {
      // Let Supabase generate the UUID — omit the client-side id entirely
      const rows = toInsert.map(({ id: _skip, ...rest }) => rest);
      const { data: inserted, error } = await supabase.from("users").insert(rows).select();
      if (error) { console.error("Insert users error", error); return; }
      // Patch local state ids back to the real UUIDs Supabase assigned
      if (inserted) {
        for (const row of inserted) {
          const u = toInsert.find(x => x.username === row.username);
          if (u) u.id = row.id;
        }
      }
    }

    if (toUpsert.length) {
      const { error } = await supabase.from("users").upsert(
        toUpsert.map(({ id, username, password, name, email, role, active }) =>
          ({ id, username, password, name, email, role, active })
        ),
        { onConflict: "id" }
      );
      if (error) console.error("Upsert users error", error);
    }
  },

  // ── saveSteps: surgical save for a single test's steps ─────────────────────
  // Called by commit() in TestDetail — only touches the one test that changed.
  // Much faster than saveModules which would rebuild all 120 modules.
  async saveSteps(testId, moduleId, steps, testMeta) {
    const CHUNK = 500;

    // 1. Ensure parent module + test rows exist in DB (FK constraints require them).
    //    These are lightweight no-ops if the rows already exist.
    if (moduleId) {
      const { error: modErr } = await supabase
        .from("modules")
        .upsert({ id: moduleId, name: testMeta?.moduleName ?? moduleId, position: 0 }, { onConflict: "id" });
      if (modErr) console.error("saveSteps: ensure module error:", modErr);
    }
    if (testMeta) {
      const { error: testErr } = await supabase
        .from("tests")
        .upsert({
          id:          testId,
          module_id:   moduleId,
          serial_no:   testMeta.serialNo ?? 0,
          name:        testMeta.name ?? testId,
          description: testMeta.description ?? "",
        }, { onConflict: "id" });
      if (testErr) console.error("saveSteps: ensure test error:", testErr);
    }

    // 2. Build step rows
    const stepsWithPosition = steps.map((s, position) => ({
      id:         s.id,
      test_id:    testId,
      position,
      serial_no:  s.isDivider ? null : (s.serialNo ?? s.serial_no ?? null),
      action:     s.action   ?? "",
      result:     s.result   ?? "",
      remarks:    s.remarks  ?? "",
      status:     s.status   ?? "pending",
      is_divider: s.isDivider ?? false,
    }));

    // 3. Upsert all steps for this test
    for (let i = 0; i < stepsWithPosition.length; i += CHUNK) {
      const { error } = await supabase
        .from("steps")
        .upsert(stepsWithPosition.slice(i, i + CHUNK), { onConflict: "id" });
      if (error) {
        console.error("Upsert steps error:", error);
        return;
      }
    }

    // 4. Delete steps that are no longer in the current list (e.g. after reset/reimport)
    if (stepsWithPosition.length > 0) {
      const liveIds = new Set(stepsWithPosition.map((s) => s.id));
      const { data: existing, error: fetchErr } = await supabase
        .from("steps")
        .select("id")
        .eq("test_id", testId);
      if (fetchErr) { console.error("Fetch steps for cleanup error:", fetchErr); return; }
      const stale = (existing || []).map((r) => r.id).filter((id) => !liveIds.has(id));
      for (let i = 0; i < stale.length; i += CHUNK) {
        const { error } = await supabase
          .from("steps")
          .delete()
          .in("id", stale.slice(i, i + CHUNK));
        if (error) console.error("Delete stale steps error:", error);
      }
    } else {
      // All steps removed — wipe the test's steps entirely
      const { error } = await supabase
        .from("steps")
        .delete()
        .eq("test_id", testId);
      if (error) console.error("Delete all steps error:", error);
    }
  },

  // ── saveModules: full save used for structural changes (add/delete/rename module or test) ──
  async saveModules(modulesMap) {
    const modules = Object.values(modulesMap);
    const allTests = modules.flatMap((m) =>
      m.tests.map((t) => ({ ...t, module_id: m.id }))
    );
    const allSteps = allTests.flatMap((t) =>
      (t.steps || []).map((s) => ({ ...s, test_id: t.id }))
    );

    const liveModuleIds = modules.map((m) => m.id);
    const liveTestIds   = allTests.map((t) => t.id);
    const liveStepIds   = allSteps.map((s) => s.id);

    const CHUNK = 500;

    const deleteInChunks = async (table, ids) => {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const { error } = await supabase
          .from(table).delete().in("id", ids.slice(i, i + CHUNK));
        if (error) console.error(`Delete ${table} error`, error);
      }
    };

    // ── 1. Upsert modules ────────────────────────────────────────────────────
    const moduleRows = modules.map(({ id, name }, i) => ({ id, name, position: i }));
    for (let i = 0; i < moduleRows.length; i += CHUNK) {
      const { error } = await supabase
        .from("modules")
        .upsert(moduleRows.slice(i, i + CHUNK), { onConflict: "id" });
      if (error) { console.error("Upsert modules error", error); return; }
    }

    // ── 2. Upsert tests ──────────────────────────────────────────────────────
    if (allTests.length) {
      const testRows = allTests.map((t) => ({
        id:          t.id,
        module_id:   t.module_id,
        serial_no:   t.serial_no ?? t.serialNo ?? 0,
        name:        t.name,
        description: t.description ?? "",
      }));
      for (let i = 0; i < testRows.length; i += CHUNK) {
        const { error } = await supabase
          .from("tests")
          .upsert(testRows.slice(i, i + CHUNK), { onConflict: "id" });
        if (error) { console.error("Upsert tests error", error); return; }
      }
    }

    // ── 3. Upsert steps ──────────────────────────────────────────────────────
    if (allSteps.length) {
      const testPositionCounters = {};
      const stepsWithPosition = allSteps.map((s) => {
        if (testPositionCounters[s.test_id] === undefined) testPositionCounters[s.test_id] = 0;
        const position = testPositionCounters[s.test_id]++;
        return {
          id:         s.id,
          test_id:    s.test_id,
          position,
          serial_no:  s.isDivider ? null : (s.serialNo ?? s.serial_no ?? null),
          action:     s.action   ?? "",
          result:     s.result   ?? "",
          remarks:    s.remarks  ?? "",
          status:     s.status   ?? "pending",
          is_divider: s.isDivider ?? false,
        };
      });
      for (let i = 0; i < stepsWithPosition.length; i += CHUNK) {
        const { error } = await supabase
          .from("steps")
          .upsert(stepsWithPosition.slice(i, i + CHUNK), { onConflict: "id" });
        if (error) { console.error("Upsert steps error", error); return; }
      }
    }

    // ── 4. Delete stale rows after upserts succeed ───────────────────────────
    try {
      if (liveTestIds.length) {
        const existingStepIds = [];
        for (let i = 0; i < liveTestIds.length; i += CHUNK) {
          const { data } = await supabase
            .from("steps").select("id")
            .in("test_id", liveTestIds.slice(i, i + CHUNK));
          if (data) existingStepIds.push(...data.map((r) => r.id));
        }
        const liveStepSet  = new Set(liveStepIds);
        const staleStepIds = existingStepIds.filter((id) => !liveStepSet.has(id));
        if (staleStepIds.length) await deleteInChunks("steps", staleStepIds);
      }
      if (liveModuleIds.length) {
        const existingTestIds = [];
        for (let i = 0; i < liveModuleIds.length; i += CHUNK) {
          const { data } = await supabase
            .from("tests").select("id")
            .in("module_id", liveModuleIds.slice(i, i + CHUNK));
          if (data) existingTestIds.push(...data.map((r) => r.id));
        }
        const liveTestSet  = new Set(liveTestIds);
        const staleTestIds = existingTestIds.filter((id) => !liveTestSet.has(id));
        if (staleTestIds.length) await deleteInChunks("tests", staleTestIds);
      }
      const { data: existingMods } = await supabase.from("modules").select("id");
      const liveModSet = new Set(liveModuleIds);
      const staleMods  = (existingMods || []).map((r) => r.id).filter((id) => !liveModSet.has(id));
      if (staleMods.length) await deleteInChunks("modules", staleMods);
    } catch (e) {
      console.error("Cleanup stale rows error", e);
    }
  },

  async addLog(entry) {
    await supabase.from("audit_log").insert({
      user_name: entry.user,
      action: entry.action,
      type: entry.type,
    });
  },

  async loadLog() {
    const { data } = await supabase
      .from("audit_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(300);
    return (data || []).map((r) => ({
      ts: new Date(r.created_at).getTime(),
      user: r.user_name,
      action: r.action,
      type: r.type,
    }));
  },
};


// ── Test Lock System (Supabase-backed, TTL + Heartbeat) ───────────────────────
//
// Strategy:
//   - Normal close  → beforeunload fires → releaseAll() called immediately
//   - Crash/force close → heartbeat stops → lock expires after LOCK_TTL_MS (60s)
//   - Active user sends heartbeat every HEARTBEAT_MS (25s) to refresh locked_at
//   - getAll() and acquire() ignore locks whose locked_at is older than LOCK_TTL_MS
//
// SQL to create the table (run ONCE in Supabase SQL editor):
//
//   CREATE TABLE IF NOT EXISTS test_locks (
//     test_id   text PRIMARY KEY,
//     user_id   text NOT NULL,
//     user_name text NOT NULL,
//     locked_at timestamptz DEFAULT now()
//   );
//   ALTER TABLE test_locks ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "allow_all" ON test_locks FOR ALL USING (true) WITH CHECK (true);
//
const LOCK_TTL_MS  = 60_000; // lock treated as dead after 60s of no heartbeat
const HEARTBEAT_MS = 25_000; // active user refreshes every 25s

const lockStore = {
  // Returns only LIVE locks — stale ones (locked_at > 60s ago) are ignored
  async getAll() {
    try {
      const cutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
      const { data, error } = await supabase
        .from("test_locks")
        .select("*")
        .gt("locked_at", cutoff);
      if (error) return {};
      const out = {};
      for (const row of data || []) {
        out[row.test_id] = {
          userId:   row.user_id,
          userName: row.user_name,
          ts:       new Date(row.locked_at).getTime(),
        };
      }
      return out;
    } catch {
      return {};
    }
  },

  // Try to acquire lock. Returns { ok: true } or { ok: false, by: userName }
  async acquire(testId, userId, userName) {
    try {
      const cutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
      // Only treat as locked if the row is still fresh (within TTL)
      const { data: existing } = await supabase
        .from("test_locks")
        .select("*")
        .eq("test_id", testId)
        .gt("locked_at", cutoff)
        .maybeSingle();
      if (existing && existing.user_id !== userId) {
        return { ok: false, by: existing.user_name };
      }
      const { error } = await supabase.from("test_locks").upsert(
        {
          test_id:   testId,
          user_id:   userId,
          user_name: userName,
          locked_at: new Date().toISOString(),
        },
        { onConflict: "test_id" }
      );
      if (error) return { ok: false, by: "unknown" };
      return { ok: true };
    } catch {
      return { ok: true }; // fail-open — app stays usable if Supabase is unreachable
    }
  },

  // Refresh locked_at to prove the user is still alive (heartbeat tick)
  async heartbeat(testId, userId) {
    try {
      await supabase
        .from("test_locks")
        .update({ locked_at: new Date().toISOString() })
        .eq("test_id", testId)
        .eq("user_id", userId);
    } catch {}
  },

  // Release a specific lock (only if owned by userId)
  async release(testId, userId) {
    try {
      await supabase
        .from("test_locks")
        .delete()
        .eq("test_id", testId)
        .eq("user_id", userId);
    } catch {}
  },

  // Release ALL locks held by userId (logout / window close / deactivation)
  async releaseAll(userId) {
    try {
      await supabase.from("test_locks").delete().eq("user_id", userId);
    } catch {}
  },
};

// ── Seed Users ─────────────────────────────────────────────────────────────────
const SEED_USERS = [
  {
    id: "1",
    username: "admin",
    password: "admin123",
    role: "admin",
    name: "Administrator",
    email: "admin@testpro.io",
    active: true,
  },
  {
    id: "2",
    username: "tester1",
    password: "test123",
    role: "tester",
    name: "Alex Johnson",
    email: "alex@testpro.io",
    active: true,
  },
];

// ── Data Model ─────────────────────────────────────────────────────────────────
// Module → Tests[] → Steps[]
// Each Test is a sub-module with its own name, description, and up to 100,000 steps per test.
// Each Step has: id, serialNo, action, result, remarks, status

function makeStep(testId, n) {
  return {
    id: `${testId}_s${n}`,
    serialNo: n,
    action: "",
    result: "",
    remarks: "",
    status: "pending",
    isDivider: false,
  };
}

function makeTest(modId, n, stepCount = 0) {
  const testId = `${modId}_t${n}`;
  return {
    id: testId,
    serialNo: n,
    name: `Test ${n}`,
    description: "",
    steps: Array.from({ length: stepCount }, (_, i) => makeStep(testId, i + 1)),
  };
}

function buildModules() {
  const out = {};
  for (let m = 1; m <= 120; m++) {
    const modId = `m${m}`;
    const tests = Array.from({ length: 5 }, (_, i) =>
      makeTest(modId, i + 1, 0)
    );
    out[modId] = { id: modId, name: `Module ${m}`, tests };
  }
  return out;
}

// ── Design Tokens — Orange Theme ───────────────────────────────────────────────
const C = {

// ── Design Tokens — Dark Mission Control ──────────────────────────────────────
const C = {
  bg:  "#070b12",
  s1:  "#0c1220",
  s2:  "#101828",
  s3:  "#162136",
  b1:  "rgba(30,50,80,0.7)",
  b2:  "rgba(40,65,100,0.9)",
  ac:  "#38bdf8",   // sky-400
  gr:  "#34d399",   // emerald-400
  re:  "#fb7185",   // rose-400
  am:  "#fbbf24",   // amber-400
  t1:  "#e2e8f0",   // slate-200
  t2:  "#94a3b8",   // slate-400
  t3:  "#475569",   // slate-600
  grd: "rgba(52,211,153,0.09)",
  red: "rgba(251,113,133,0.09)",
  amd: "rgba(251,191,36,0.09)",
  acd: "rgba(56,189,248,0.09)",
};

const F = {
  sans: "'Plus Jakarta Sans', -apple-system, sans-serif",
  mono: "'IBM Plex Mono', 'SF Mono', monospace",
  head: "'Syne', 'Plus Jakarta Sans', sans-serif",
};

// ── Mobile detection ──────────────────────────────────────────────────────────
function useIsMobile(breakpoint = 768) {
  const [mobile, setMobile] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    const h = () => setMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, [breakpoint]);
  return mobile;
}

const MobileMenuCtx = React.createContext(null);

// ── Style Helpers ─────────────────────────────────────────────────────────────
const btn = (x = {}) => ({
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "6px 14px", borderRadius: 8,
  border: `1px solid ${C.b2}`, background: C.s2,
  color: C.t2, fontFamily: F.sans, fontSize: 12,
  fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap",
  flexShrink: 0, lineHeight: 1, transition: "all .15s", ...x,
});
const acBtn = (x = {}) => btn({ background: "rgba(56,189,248,0.1)", borderColor: "rgba(56,189,248,0.35)", color: C.ac, ...x });
const grBtn = (x = {}) => btn({ background: "rgba(52,211,153,0.1)", borderColor: "rgba(52,211,153,0.35)", color: C.gr, ...x });
const reBtn = (x = {}) => btn({ background: "rgba(251,113,133,0.1)", borderColor: "rgba(251,113,133,0.35)", color: C.re, ...x });
const amBtn = (x = {}) => btn({ background: "rgba(251,191,36,0.1)",  borderColor: "rgba(251,191,36,0.35)",  color: C.am, ...x });
const smBtn = (x = {}) => btn({ padding: "4px 10px", fontSize: 11, ...x });
const iBtn  = (x = {}) => btn({ padding: "5px 7px", border: "none", background: "transparent", color: C.t3, ...x });

// ── Icons ─────────────────────────────────────────────────────────────────────
const PATHS = {
  check:  [["M20 6 9 17 4 12"]],
  x:      [["M18 6 6 18"], ["M6 6l12 12"]],
  upload: [["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"],["M17 8l-5-5-5 5"],["M12 3v12"]],
  logout: [["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"],["M16 17l5-5-5-5"],["M21 12H9"]],
  grid:   [["M3 3h7v7H3z"],["M14 3h7v7h-7z"],["M14 14h7v7h-7z"],["M3 14h7v7H3z"]],
  edit:   [["M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"],["M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"]],
  trash:  [["M3 6h18"],["M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"],["M10 6V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2"]],
  plus:   [["M12 5v14"],["M5 12h14"]],
  search: [["M11 11m-6 0a6 6 0 1 0 12 0 6 6 0 0 0-12 0"],["M21 21l-3.5-3.5"]],
  dash:   [["M22 12h-4l-3 9L9 3l-3 9H2"]],
  report: [["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"],["M14 2v6h6"],["M16 13H8"],["M16 17H8"]],
  users:  [["M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"],["M9 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0"],["M23 21v-2a4 4 0 0 0-3-3.87"],["M16 3.13a4 4 0 0 1 0 7.75"]],
  log:    [["M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"],["M22 6l-10 7L2 6"]],
  chevR:  [["M9 18l6-6-6-6"]],
  chevD:  [["M6 9l6 6 6-6"]],
  chevL:  [["M15 18l-6-6 6-6"]],
  reset:  [["M1 4v6h6"],["M3.51 15a9 9 0 1 0 .49-3.2"]],
  down:   [["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"],["M7 10l5 5 5-5"],["M12 15V3"]],
  bell:   [["M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"],["M13.73 21a2 2 0 0 1-3.46 0"]],
  lock:   [["M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2z"],["M7 11V7a5 5 0 0 1 10 0v4"]],
  layers: [["M12 2 2 7l10 5 10-5-10-5z"],["M2 17l10 5 10-5"],["M2 12l10 5 10-5"]],
  file:   [["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"],["M14 2v6h6"]],
  back:   [["M19 12H5"],["M12 5l-7 7 7 7"]],
};
function Ico({ n, s = 15 }) {
  const paths = PATHS[n] || [["M0 0"]];
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      {paths.map((d, i) => <path key={i} d={d[0]} />)}
    </svg>
  );
}

// ── Shared UI ─────────────────────────────────────────────────────────────────
function PBar({ pct, fail }) {
  return (
    <div style={{ height: 4, background: C.s3, borderRadius: 2, overflow: "hidden" }}>
      <div style={{
        height: "100%", width: `${pct}%`,
        background: fail ? C.am : C.gr,
        transition: "width .4s", borderRadius: 2,
      }} />
    </div>
  );
}

function Badge({ type }) {
  const map = {
    admin:    { bg: "rgba(56,189,248,0.12)",  color: C.ac, border: "rgba(56,189,248,0.3)" },
    tester:   { bg: "rgba(251,191,36,0.12)",  color: C.am, border: "rgba(251,191,36,0.3)" },
    active:   { bg: "rgba(52,211,153,0.12)",  color: C.gr, border: "rgba(52,211,153,0.3)" },
    inactive: { bg: "rgba(251,113,133,0.12)", color: C.re, border: "rgba(251,113,133,0.3)" },
  };
  const s = map[type] || { bg: C.s3, color: C.t2, border: C.b1 };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "2px 9px", borderRadius: 20,
      fontSize: 10, fontFamily: F.mono, fontWeight: 700,
      textTransform: "uppercase", letterSpacing: "0.5px",
      background: s.bg, color: s.color,
      border: `1px solid ${s.border}`,
    }}>
      {type}
    </span>
  );
}

function Chip({ label, color, bg }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      padding: "2px 8px", borderRadius: 12,
      fontSize: 10, fontFamily: F.mono,
      background: bg, color,
    }}>
      {label}
    </span>
  );
}

function Toggle({ on, onClick }) {
  return (
    <div onClick={onClick} style={{
      width: 34, height: 18, borderRadius: 9,
      background: on ? "rgba(52,211,153,0.2)" : C.s3,
      border: `1px solid ${on ? "rgba(52,211,153,0.5)" : C.b2}`,
      position: "relative", cursor: "pointer", flexShrink: 0, transition: "all .2s",
    }}>
      <div style={{
        position: "absolute", top: 2, left: on ? 18 : 2,
        width: 12, height: 12, borderRadius: "50%",
        background: on ? C.gr : C.t3, transition: "left .2s",
      }} />
    </div>
  );
}

// ── Export Menu ───────────────────────────────────────────────────────────────
function ExportMenu({ onCSV, onPDF }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button style={smBtn()} onClick={() => setOpen(o => !o)}>
        <Ico n="down" s={12} /> Export <span style={{ fontSize: 9, marginLeft: 2 }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", right: 0,
          background: C.s1, border: `1px solid ${C.b2}`,
          borderRadius: 10, boxShadow: "0 16px 48px rgba(0,0,0,.5)",
          overflow: "hidden", minWidth: 140, zIndex: 50,
        }}>
          {[["CSV export", onCSV], ["PDF / Print", onPDF]].map(([label, fn]) => (
            <button key={label} onClick={() => { fn(); setOpen(false); }} style={{
              display: "flex", alignItems: "center", gap: 8,
              width: "100%", padding: "10px 16px",
              background: "transparent", border: "none",
              color: C.t1, fontFamily: F.sans, fontSize: 12,
              cursor: "pointer", textAlign: "left",
              borderBottom: `1px solid ${C.b1}`,
              transition: "background .1s",
            }}
              onMouseEnter={e => e.currentTarget.style.background = C.s2}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <Ico n={label.startsWith("CSV") ? "file" : "report"} s={13} />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Search Box ────────────────────────────────────────────────────────────────
function SearchBox({ value, onChange, placeholder = "Search…", width = 190 }) {
  return (
    <div style={{ position: "relative", flexShrink: 0, width }}>
      <div style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: C.t3, pointerEvents: "none" }}>
        <Ico n="search" s={12} />
      </div>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%", padding: "6px 10px 6px 28px",
          background: C.s2, border: `1px solid ${C.b1}`,
          borderRadius: 8, color: C.t1,
          fontFamily: F.mono, fontSize: 11,
          outline: "none", transition: "border-color .15s",
        }}
      />
    </div>
  );
}

// ── Topbar ────────────────────────────────────────────────────────────────────
function Topbar({ title, sub, children }) {
  const isMobile = useIsMobile();
  const onMenuClick = useContext(MobileMenuCtx);
  return (
    <div style={{
      minHeight: 56, padding: isMobile ? "10px 14px" : "0 24px",
      flexShrink: 0, display: "flex", alignItems: "center", gap: 10,
      background: "rgba(7,11,18,0.85)",
      backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
      borderBottom: `1px solid ${C.b1}`,
      boxShadow: "0 1px 0 rgba(56,189,248,0.04)",
    }}>
      {isMobile && onMenuClick && (
        <button onClick={onMenuClick} style={{ ...iBtn(), padding: "6px 8px", marginLeft: -4, flexShrink: 0 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: isMobile ? 14 : 16, fontWeight: 700,
          color: C.t1, fontFamily: F.head,
          display: "flex", alignItems: "center", gap: 6, overflow: "hidden",
        }}>
          {title}
        </div>
        {sub && (
          <div style={{
            fontSize: 11, color: C.t3, marginTop: 1,
            fontFamily: F.mono, overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {sub}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

const inputSty = {
  width: "100%", padding: "10px 14px",
  background: C.s2, border: `1px solid ${C.b2}`,
  borderRadius: 8, color: C.t1,
  fontFamily: F.sans, fontSize: 14, outline: "none",
  boxShadow: "inset 0 1px 2px rgba(0,0,0,.2)",
  transition: "border-color .15s",
};

// ── Modal ─────────────────────────────────────────────────────────────────────
function Modal({ title, sub, onClose, children, width = 460 }) {
  const isMobile = useIsMobile();
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0,
      background: "rgba(0,0,0,.65)",
      backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
      display: "flex",
      alignItems: isMobile ? "flex-end" : "center",
      justifyContent: "center", zIndex: 200,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: isMobile ? "100%" : width,
        background: C.s1,
        border: `1px solid ${C.b2}`,
        borderRadius: isMobile ? "16px 16px 0 0" : 14,
        padding: isMobile ? "24px 20px" : "28px 30px",
        boxShadow: "0 24px 80px rgba(0,0,0,.7)",
        maxHeight: "90vh", overflowY: "auto",
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.t1, fontFamily: F.head, marginBottom: 4 }}>
          {title}
        </div>
        {sub && (
          <div style={{ fontSize: 12, color: C.t3, marginBottom: 20, lineHeight: 1.6 }}>
            {sub}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
function ModalActions({ children }) {
  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 24 }}>
      {children}
    </div>
  );
}
function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <label style={{
        display: "block", fontSize: 10, fontFamily: F.mono,
        color: C.t3, textTransform: "uppercase",
        letterSpacing: "1.2px", marginBottom: 7,
      }}>
        {label}
      </label>
      {children}
    </div>
  );
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function useToast() {
  const [list, setList] = useState([]);
  const push = useCallback((msg, type = "info") => {
    const id = Date.now() + Math.random();
    setList(l => [...l, { id, msg, type }]);
    setTimeout(() => setList(l => l.filter(x => x.id !== id)), 3000);
  }, []);
  const cols = {
    success: { bg: "rgba(52,211,153,0.12)",  border: "rgba(52,211,153,0.35)",  color: C.gr },
    error:   { bg: "rgba(251,113,133,0.12)", border: "rgba(251,113,133,0.35)", color: C.re },
    info:    { bg: "rgba(56,189,248,0.12)",  border: "rgba(56,189,248,0.35)",  color: C.ac },
  };
  const Host = () => {
    const isMobile = useIsMobile();
    return (
      <div style={{
        position: "fixed", bottom: isMobile ? 70 : 22,
        right: isMobile ? 12 : 22, left: isMobile ? 12 : "auto",
        zIndex: 999, display: "flex", flexDirection: "column", gap: 8, pointerEvents: "none",
      }}>
        {list.map(t => {
          const c = cols[t.type] || cols.info;
          return (
            <div key={t.id} style={{
              padding: "10px 16px", borderRadius: 10,
              border: `1px solid ${c.border}`, background: c.bg,
              backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
              color: c.color, fontFamily: F.mono,
              fontSize: isMobile ? 13 : 12,
              display: "flex", alignItems: "center", gap: 8,
              boxShadow: "0 8px 32px rgba(0,0,0,.4)",
            }}>
              <Ico n={t.type === "success" ? "check" : t.type === "error" ? "x" : "bell"} s={12} />
              {t.msg}
            </div>
          );
        })}
      </div>
    );
  };
  return { push, Host };
}

// ── Login ─────────────────────────────────────────────────────────────────────
const LOGIN_KF = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=Plus+Jakarta+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; background: #070b12; font-family: 'Plus Jakarta Sans', sans-serif; }
::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(30,50,80,0.8); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(40,65,100,0.9); }
textarea, input, select { font-family: inherit; box-sizing: border-box; }
@keyframes fadeUp { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }
@keyframes gridScroll { from { transform:translateY(0); } to { transform:translateY(-60px); } }
@keyframes orb1 { 0%,100% { transform:translate(0,0) scale(1); } 50% { transform:translate(30px,-20px) scale(1.08); } }
@keyframes orb2 { 0%,100% { transform:translate(0,0) scale(1); } 33% { transform:translate(-25px,18px) scale(1.05); } 66% { transform:translate(18px,-10px) scale(0.97); } }
@keyframes orb3 { 0%,100% { transform:translate(0,0) scale(1); } 50% { transform:translate(15px,22px) scale(1.06); } }
@keyframes scanline { 0% { top:-2px; } 100% { top:100%; } }
@keyframes pulse { 0%,100% { opacity:0.5; } 50% { opacity:1; } }
`;

function LoginPage({ users, onLogin }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uFocus, setUFocus] = useState(false);
  const [pFocus, setPFocus] = useState(false);
  const isMobile = useIsMobile();
  const pwRef = useRef();

  const go = () => {
    if (!u.trim() || !p) { setErr("Please enter your credentials."); return; }
    setLoading(true);
    setTimeout(() => {
      const found = users.find(x => x.username === u.trim() && x.password === p && x.active);
      if (found) { onLogin(found); }
      else { setErr("Invalid credentials or account inactive."); setLoading(false); }
    }, 120);
  };

  const EyeIcon = ({ open }) => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {open ? (<><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>) : (<><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></>)}
    </svg>
  );

  const fld = (focused, hasErr) => ({
    width: "100%", padding: "13px 14px",
    background: focused ? "rgba(16,24,40,0.95)" : "rgba(12,18,32,0.8)",
    border: `1px solid ${hasErr ? "rgba(251,113,133,0.5)" : focused ? "rgba(56,189,248,0.6)" : "rgba(30,50,80,0.9)"}`,
    borderRadius: 10, color: C.t1, fontFamily: F.sans,
    fontSize: 15, outline: "none", transition: "all .18s",
    boxShadow: focused ? `0 0 0 3px ${hasErr ? "rgba(251,113,133,.1)" : "rgba(56,189,248,.1)"}` : "none",
  });

  return (
    <div style={{
      minHeight: "100dvh", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      background: "radial-gradient(ellipse at 20% 50%, rgba(14,30,60,0.8) 0%, #070b12 60%)",
      padding: isMobile ? "20px 16px" : "40px 20px",
      position: "relative", overflow: "hidden",
    }}>
      <style>{LOGIN_KF}</style>

      {/* Grid background */}
      <div style={{
        position: "absolute", inset: 0, zIndex: 0, overflow: "hidden",
        backgroundImage: `linear-gradient(rgba(30,50,80,0.15) 1px, transparent 1px), linear-gradient(90deg, rgba(30,50,80,0.15) 1px, transparent 1px)`,
        backgroundSize: "40px 40px",
        animation: "gridScroll 8s linear infinite",
        maskImage: "radial-gradient(ellipse at center, black 30%, transparent 80%)",
      }} />

      {/* Orbs */}
      {[
        { top: "-15%", left: "-10%", w: 500, h: 500, c: "rgba(56,189,248,0.08)", a: "orb1 18s ease-in-out infinite" },
        { bottom: "-15%", right: "-8%", w: 420, h: 420, c: "rgba(52,211,153,0.06)", a: "orb2 22s ease-in-out infinite" },
        { top: "30%", right: "5%", w: 240, h: 240, c: "rgba(56,189,248,0.05)", a: "orb3 14s ease-in-out infinite" },
      ].map((orb, i) => (
        <div key={i} style={{
          position: "absolute", width: orb.w, height: orb.h,
          borderRadius: "50%", background: `radial-gradient(circle, ${orb.c} 0%, transparent 70%)`,
          filter: "blur(60px)", animation: orb.a, pointerEvents: "none", zIndex: 0,
          top: orb.top, left: orb.left, bottom: orb.bottom, right: orb.right,
        }} />
      ))}

      {/* Card */}
      <div style={{
        width: "100%", maxWidth: 420, position: "relative", zIndex: 2,
        background: "rgba(10,16,28,0.85)",
        border: `1px solid rgba(56,189,248,0.15)`,
        borderRadius: 20, padding: isMobile ? "32px 24px" : "40px 40px",
        backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
        boxShadow: "0 0 0 1px rgba(56,189,248,0.05), 0 32px 80px rgba(0,0,0,.7)",
        animation: "fadeUp .5s ease both",
      }}>
        {/* Scanline accent */}
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, borderRadius: "20px 20px 0 0", overflow: "hidden" }}>
          <div style={{ height: "100%", background: "linear-gradient(90deg, transparent, rgba(56,189,248,0.8), rgba(52,211,153,0.6), transparent)", animation: "pulse 3s ease-in-out infinite" }} />
        </div>

        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10, flexShrink: 0,
            background: "linear-gradient(135deg, rgba(56,189,248,0.15), rgba(52,211,153,0.1))",
            border: "1px solid rgba(56,189,248,0.3)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <img src="/testpro_logo.svg" width="22" height="22" alt="TestPro" draggable="false" />
          </div>
          <div>
            <div style={{ fontFamily: F.head, fontWeight: 800, fontSize: 20, color: C.t1, letterSpacing: "-0.5px" }}>
              Test<span style={{ color: C.ac }}>Pro</span>
            </div>
            <div style={{ fontFamily: F.mono, fontSize: 10, color: C.t3, letterSpacing: "1.5px", marginTop: 1 }}>
              QA MANAGEMENT PLATFORM
            </div>
          </div>
        </div>

        <div style={{ fontFamily: F.head, fontSize: 22, fontWeight: 700, color: C.t1, marginBottom: 6 }}>
          Sign in
        </div>
        <div style={{ fontFamily: F.sans, fontSize: 13, color: C.t3, marginBottom: 28 }}>
          Enter your credentials to continue
        </div>

        {/* Username */}
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: "block", fontSize: 11, fontFamily: F.mono, color: C.t3, letterSpacing: "0.8px", marginBottom: 7 }}>
            USERNAME
          </label>
          <input
            value={u} onChange={e => setU(e.target.value)}
            onFocus={() => setUFocus(true)} onBlur={() => setUFocus(false)}
            onKeyDown={e => e.key === "Enter" && pwRef.current?.focus()}
            placeholder="your_username"
            style={fld(uFocus, !!err)}
            autoComplete="username"
          />
        </div>

        {/* Password */}
        <div style={{ marginBottom: 24, position: "relative" }}>
          <label style={{ display: "block", fontSize: 11, fontFamily: F.mono, color: C.t3, letterSpacing: "0.8px", marginBottom: 7 }}>
            PASSWORD
          </label>
          <div style={{ position: "relative" }}>
            <input
              ref={pwRef}
              value={p} onChange={e => setP(e.target.value)}
              type={showPw ? "text" : "password"}
              onFocus={() => setPFocus(true)} onBlur={() => setPFocus(false)}
              onKeyDown={e => e.key === "Enter" && go()}
              placeholder="••••••••"
              style={{ ...fld(pFocus, !!err), paddingRight: 44 }}
              autoComplete="current-password"
            />
            <button onClick={() => setShowPw(v => !v)} style={{
              position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
              background: "none", border: "none", color: C.t3, cursor: "pointer", padding: 4,
            }}>
              <EyeIcon open={showPw} />
            </button>
          </div>
        </div>

        {err && (
          <div style={{
            padding: "10px 14px", borderRadius: 8, marginBottom: 20,
            background: "rgba(251,113,133,0.1)", border: "1px solid rgba(251,113,133,0.3)",
            color: C.re, fontFamily: F.mono, fontSize: 12,
            display: "flex", alignItems: "center", gap: 8,
          }}>
            <Ico n="x" s={12} /> {err}
          </div>
        )}

        <button
          onClick={go}
          disabled={loading}
          style={{
            width: "100%", padding: "13px 0",
            background: loading ? C.s2 : "linear-gradient(135deg, rgba(56,189,248,0.2), rgba(52,211,153,0.15))",
            border: `1px solid ${loading ? C.b1 : "rgba(56,189,248,0.4)"}`,
            borderRadius: 10, color: loading ? C.t3 : C.ac,
            fontFamily: F.head, fontSize: 15, fontWeight: 700,
            cursor: loading ? "not-allowed" : "pointer",
            letterSpacing: "0.3px",
            transition: "all .2s",
          }}
        >
          {loading ? "Signing in…" : "Sign In"}
        </button>

        <div style={{
          marginTop: 28, paddingTop: 20,
          borderTop: `1px solid ${C.b1}`,
          fontFamily: F.mono, fontSize: 10,
          color: C.t3, textAlign: "center", letterSpacing: "0.5px",
        }}>
          TESTPRO · SECURE QA PLATFORM
        </div>
      </div>
    </div>
  );
}


// ── Sidebar ───────────────────────────────────────────────────────────────────
function Sidebar({ session, view, setView, modules, selMod, setSelMod, collapsed, setCollapsed, onLogout, locked, mobileOpen, onMobileClose }) {
  const isMobile = useIsMobile();
  const [search, setSearch] = useState("");
  const modList = useMemo(() => Object.values(modules), [modules]);
  const filtered = useMemo(
    () => modList.filter(m => m.name.toLowerCase().includes(search.toLowerCase())),
    [modList, search]
  );
  const modStats = useMemo(() => {
    const s = {};
    modList.forEach(m => {
      const all = m.tests.flatMap(t => t.steps);
      s[m.id] = { pass: all.filter(s => s.status === "pass").length, fail: all.filter(s => s.status === "fail").length, total: all.length };
    });
    return s;
  }, [modList]);

  const navRow = (id, icon, label) => {
    const active = view === id;
    const isLocked = locked && !active;
    return (
      <div key={id} onClick={() => { if (isLocked) return; setView(id); if (onMobileClose) onMobileClose(); }}
        title={isLocked ? "Finish the current test first" : undefined}
        style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "9px 16px", cursor: isLocked ? "not-allowed" : "pointer",
          fontSize: 13, fontWeight: 500, fontFamily: F.sans,
          color: active ? C.ac : isLocked ? C.t3 : C.t2,
          background: active ? "rgba(56,189,248,0.08)" : "transparent",
          borderLeft: `2px solid ${active ? C.ac : "transparent"}`,
          opacity: isLocked ? 0.4 : 1, transition: "all .15s",
        }}
      >
        <Ico n={icon} s={15} />
        {!collapsed && <span style={{ flex: 1 }}>{label}</span>}
        {isLocked && !collapsed && <Ico n="lock" s={10} />}
      </div>
    );
  };

  return (
    <>
      {isMobile && mobileOpen && (
        <div onClick={onMobileClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", zIndex: 300 }} />
      )}
      <div style={{
        width: isMobile ? 280 : (collapsed ? 54 : 256),
        flexShrink: 0,
        background: "rgba(8,12,20,0.96)",
        backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
        borderRight: `1px solid ${C.b1}`,
        display: "flex", flexDirection: "column",
        overflow: "hidden", transition: isMobile ? "transform .25s" : "width .2s",
        ...(isMobile ? {
          position: "fixed", top: 0, left: 0, height: "100%", zIndex: 301,
          transform: mobileOpen ? "translateX(0)" : "translateX(-100%)",
        } : {}),
      }}>
        {/* Header */}
        <div style={{ padding: "14px 14px", borderBottom: `1px solid ${C.b1}`, display: "flex", alignItems: "center", gap: 10, minHeight: 56 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8, flexShrink: 0,
            background: "linear-gradient(135deg, rgba(56,189,248,0.15), rgba(52,211,153,0.1))",
            border: "1px solid rgba(56,189,248,0.25)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <img src="/testpro_logo.svg" width="20" height="20" alt="" draggable="false" />
          </div>
          {!collapsed && (
            <span style={{ fontFamily: F.head, fontWeight: 800, fontSize: 15, color: C.t1, letterSpacing: "-0.3px" }}>
              Test<span style={{ color: C.ac }}>Pro</span>
            </span>
          )}
          <button onClick={() => setCollapsed(c => !c)} style={{ ...iBtn(), marginLeft: "auto", padding: 4 }}>
            <Ico n={collapsed ? "chevR" : "chevL"} s={13} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", paddingTop: 8 }}>
          {!collapsed && (
            <div style={{ padding: "5px 16px 3px", fontSize: 9, fontFamily: F.mono, textTransform: "uppercase", letterSpacing: "2px", color: C.t3 }}>
              Navigation
            </div>
          )}
          {navRow("dash", "dash", "Dashboard")}
          {navRow("report", "report", "Test Report")}
          {session.role === "admin" && navRow("users", "users", "Users")}
          {session.role === "admin" && navRow("audit", "log", "Audit Log")}

          {!collapsed && (
            <>
              <div style={{ height: 1, background: C.b1, margin: "8px 0" }} />
              <div style={{ padding: "5px 16px 4px", fontSize: 9, fontFamily: F.mono, textTransform: "uppercase", letterSpacing: "2px", color: C.t3 }}>
                Modules ({filtered.length})
              </div>
              <div style={{ padding: "4px 10px 8px", position: "relative" }}>
                <div style={{ position: "absolute", left: 20, top: "50%", transform: "translateY(-50%)", color: C.t3, pointerEvents: "none" }}>
                  <Ico n="search" s={12} />
                </div>
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search modules…" style={{
                  width: "100%", padding: "6px 8px 6px 28px",
                  background: C.s2, border: `1px solid ${C.b1}`,
                  borderRadius: 6, color: C.t1,
                  fontFamily: F.mono, fontSize: 11, outline: "none",
                }} />
              </div>
              {filtered.map(m => {
                const st = modStats[m.id] || {};
                const active = selMod === m.id && view === "mod";
                const isLocked = locked && !(selMod === m.id && view === "mod");
                return (
                  <div key={m.id}
                    onClick={() => { if (isLocked) return; setSelMod(m.id); setView("mod"); if (onMobileClose) onMobileClose(); }}
                    title={isLocked ? "Finish the current test first" : undefined}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "7px 16px", cursor: isLocked ? "not-allowed" : "pointer",
                      fontSize: 12, fontFamily: F.sans,
                      color: active ? C.ac : isLocked ? C.t3 : C.t2,
                      opacity: isLocked ? 0.4 : 1,
                      background: active ? "rgba(56,189,248,0.07)" : "transparent",
                      borderLeft: `2px solid ${active ? C.ac : "transparent"}`,
                      transition: "all .12s",
                    }}
                  >
                    <Ico n="layers" s={12} />
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {m.name}
                    </span>
                    {st.fail > 0 && (
                      <span style={{ fontSize: 9, fontFamily: F.mono, background: C.red, color: C.re, padding: "1px 5px", borderRadius: 8, border: `1px solid rgba(251,113,133,0.2)` }}>✗{st.fail}</span>
                    )}
                    {st.fail === 0 && st.pass === st.total && st.pass > 0 && (
                      <span style={{ fontSize: 9, background: C.grd, color: C.gr, padding: "1px 5px", borderRadius: 8, fontFamily: F.mono, border: `1px solid rgba(52,211,153,0.2)` }}>✓</span>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 14px", borderTop: `1px solid ${C.b1}`, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
            background: "linear-gradient(135deg, rgba(56,189,248,0.15), rgba(56,189,248,0.05))",
            border: `1px solid rgba(56,189,248,0.25)`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: F.mono, fontSize: 12, fontWeight: 700, color: C.ac,
          }}>
            {session.name[0]}
          </div>
          {!collapsed && (
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.t1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {session.name}
              </div>
              <div style={{ fontSize: 10, fontFamily: F.mono, color: C.t3 }}>{session.role}</div>
            </div>
          )}
          <button onClick={onLogout} style={{ ...iBtn(), padding: 5, flexShrink: 0 }} title="Logout">
            <Ico n="logout" s={14} />
          </button>
        </div>
      </div>
    </>
  );
}


// ── Dashboard ─────────────────────────────────────────────────────────────────
function Dashboard({ modules, session, onSelect, saveMods, addLog, toast }) {
  const isAdmin = session.role === "admin";
  const isMobile = useIsMobile();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [confirmDel, setConfirmDel] = useState(null);
  const modList = useMemo(() => Object.values(modules), [modules]);

  const modStats = useMemo(() => modList.map(m => {
    const all = m.tests.flatMap(t => t.steps);
    const pass = all.filter(s => s.status === "pass").length;
    const fail = all.filter(s => s.status === "fail").length;
    return { ...m, pass, fail, total: all.length, testCount: m.tests.length };
  }), [modList]);

  const totalPass = modStats.reduce((a, m) => a + m.pass, 0);
  const totalFail = modStats.reduce((a, m) => a + m.fail, 0);
  const total = modStats.reduce((a, m) => a + m.total, 0);
  const pending = total - totalPass - totalFail;

  const filtered = useMemo(() => {
    let l = modStats.filter(m => m.name.toLowerCase().includes(search.toLowerCase()));
    if (filter === "pass") l = l.filter(m => m.pass === m.total && m.total > 0);
    if (filter === "fail") l = l.filter(m => m.fail > 0);
    if (filter === "active") l = l.filter(m => m.pass + m.fail > 0 && m.pass + m.fail < m.total);
    if (filter === "empty") l = l.filter(m => m.pass + m.fail === 0);
    return l;
  }, [modStats, search, filter]);

  const addModule = () => {
    const keys = Object.keys(modules);
    let n = keys.length + 1;
    while (modules[`m${n}`]) n++;
    const modId = `m${n}`, modName = `Module ${n}`;
    const tests = Array.from({ length: 5 }, (_, i) => makeTest(modId, i + 1, 10));
    const newMod = { id: modId, name: modName, tests };
    saveMods({ ...modules, [modId]: newMod }, true);
    tests.forEach(t => store.saveSteps(t.id, modId, t.steps, { moduleName: modName, serialNo: t.serialNo ?? 0, name: t.name, description: t.description ?? "" }).catch(e => console.error(e)));
    toast(`Module ${n} added`, "success");
    addLog({ ts: Date.now(), user: session.name, action: `Added Module ${n}`, type: "info" });
  };

  const deleteModule = (id) => {
    if (Object.keys(modules).length <= 1) { toast("Cannot delete the last module", "error"); return; }
    const updated = { ...modules };
    delete updated[id];
    saveMods(updated, true);
    toast("Module deleted", "info");
    addLog({ ts: Date.now(), user: session.name, action: `Deleted module "${modules[id]?.name}"`, type: "info" });
    setConfirmDel(null);
  };

  const StatCard = ({ label, val, color, meta, icon }) => (
    <div style={{
      background: C.s1, border: `1px solid ${C.b1}`,
      borderRadius: 12, padding: "18px 20px",
      position: "relative", overflow: "hidden",
    }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg, ${color}, transparent)` }} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontFamily: F.mono, color: C.t3, textTransform: "uppercase", letterSpacing: "1.5px" }}>{label}</div>
        <div style={{ width: 28, height: 28, borderRadius: 7, background: `${color}15`, border: `1px solid ${color}30`, display: "flex", alignItems: "center", justifyContent: "center", color }}>
          <Ico n={icon} s={13} />
        </div>
      </div>
      <div style={{ fontSize: 30, fontFamily: F.mono, fontWeight: 700, color, lineHeight: 1 }}>{val.toLocaleString()}</div>
      <div style={{ fontSize: 11, color: C.t3, marginTop: 8, fontFamily: F.sans }}>{meta}</div>
    </div>
  );

  return (
    <>
      <Topbar title="Dashboard" sub={`Hello ${session.name.split(" ")[0]} · ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}`}>
        {!isMobile && <SearchBox value={search} onChange={setSearch} placeholder="Search modules…" width={200} />}
        {isAdmin && (
          <button style={acBtn(smBtn())} onClick={addModule}>
            <Ico n="plus" s={12} /> {isMobile ? "" : "Add Module"}
          </button>
        )}
      </Topbar>
      <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? 12 : 22 }}>
        {isMobile && <div style={{ marginBottom: 12 }}><SearchBox value={search} onChange={setSearch} placeholder="Search modules…" width="100%" /></div>}

        {/* Stat cards */}
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2,1fr)" : "repeat(4,1fr)", gap: isMobile ? 10 : 14, marginBottom: isMobile ? 16 : 24 }}>
          <StatCard label="Total Steps" val={total}     color={C.ac} meta={`Across ${modList.length} modules`} icon="layers" />
          <StatCard label="Passed"      val={totalPass} color={C.gr} meta={`${total ? Math.round((totalPass/total)*100) : 0}% pass rate`} icon="check" />
          <StatCard label="Failed"      val={totalFail} color={C.re} meta={`${modStats.filter(m => m.fail > 0).length} modules affected`} icon="x" />
          <StatCard label="Pending"     val={pending}   color={C.am} meta={`${modStats.filter(m => m.pass+m.fail===m.total && m.total>0).length} modules complete`} icon="reset" />
        </div>

        {/* Filter row */}
        <div style={{ display: "flex", alignItems: isMobile ? "flex-start" : "center", flexDirection: isMobile ? "column" : "row", justifyContent: "space-between", marginBottom: 14, gap: isMobile ? 8 : 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, fontFamily: F.head, color: C.t1 }}>
            Modules <span style={{ color: C.t3, fontFamily: F.mono, fontWeight: 400, fontSize: 12 }}>({filtered.length})</span>
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {[["all","All"],["active","In Progress"],["pass","All Pass"],["fail","Has Failures"],["empty","Not Started"]].map(([k, l]) => (
              <button key={k} onClick={() => setFilter(k)} style={{
                padding: "5px 11px", borderRadius: 20,
                border: `1px solid ${filter===k ? "rgba(56,189,248,0.35)" : C.b1}`,
                background: filter===k ? "rgba(56,189,248,0.08)" : "transparent",
                color: filter===k ? C.ac : C.t3,
                fontFamily: F.mono, fontSize: 10, cursor: "pointer",
              }}>{l}</button>
            ))}
          </div>
        </div>

        {/* Module list */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(m => {
            const pct = Math.round((m.pass / Math.max(m.total, 1)) * 100);
            const passW = m.total ? (m.pass / m.total) * 100 : 0;
            const failW = m.total ? (m.fail / m.total) * 100 : 0;
            const borderCol = m.fail > 0 ? "rgba(251,113,133,0.25)" : m.pass===m.total && m.total>0 ? "rgba(52,211,153,0.25)" : C.b1;
            return (
              <div key={m.id} style={{ background: C.s1, border: `1px solid ${borderCol}`, borderRadius: 10, overflow: "hidden", transition: "border-color .15s" }}>
                <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }} onClick={() => onSelect(m.id)}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.t1, fontFamily: F.sans, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</div>
                    <div style={{ fontSize: 10, fontFamily: F.mono, color: C.t3, marginTop: 3 }}>
                      {m.testCount}t · {m.total}s
                      {m.pass > 0 && <span style={{ color: C.gr, marginLeft: 6 }}>✓{m.pass}</span>}
                      {m.fail > 0 && <span style={{ color: C.re, marginLeft: 4 }}>✗{m.fail}</span>}
                      {m.total - m.pass - m.fail > 0 && <span style={{ color: C.t3, marginLeft: 4 }}>⟳{m.total-m.pass-m.fail}</span>}
                    </div>
                  </div>
                  <div style={{ fontSize: 13, fontFamily: F.mono, fontWeight: 700, color: pct===100 ? C.gr : m.fail>0 ? C.re : C.t2, flexShrink: 0 }}>{pct}%</div>
                  {isAdmin && (
                    <button style={reBtn({ padding: "4px 7px", fontSize: 10 })} onClick={e => { e.stopPropagation(); setConfirmDel(m.id); }} title="Delete module">
                      <Ico n="trash" s={11} />
                    </button>
                  )}
                  <Ico n="chevR" s={13} style={{ color: C.t3 }} />
                </div>
                <div style={{ height: 3, background: C.s3, display: "flex" }}>
                  <div style={{ width: `${passW}%`, background: C.gr, transition: "width .5s" }} />
                  <div style={{ width: `${failW}%`, background: C.re, transition: "width .5s" }} />
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ textAlign: "center", padding: "60px 0", color: C.t3, fontFamily: F.mono, fontSize: 12 }}>No modules match.</div>
          )}
        </div>
      </div>

      {confirmDel && (
        <Modal title="Delete Module?" sub={`Delete "${modules[confirmDel]?.name}"? All tests and steps will be permanently removed.`} onClose={() => setConfirmDel(null)} width={380}>
          <ModalActions>
            <button style={btn()} onClick={() => setConfirmDel(null)}>Cancel</button>
            <button style={reBtn()} onClick={() => deleteModule(confirmDel)}><Ico n="trash" s={12} /> Delete</button>
          </ModalActions>
        </Modal>
      )}
    </>
  );
}


// ── Divider Row ───────────────────────────────────────────────────────────────
function DividerRow({ label }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "8px 16px",
      background: "linear-gradient(90deg, rgba(56,189,248,0.06), rgba(56,189,248,0.02))",
      borderBottom: `1px solid ${C.b1}`,
    }}>
      <div style={{ width: 16, height: 1, background: "rgba(56,189,248,0.4)", flexShrink: 0 }} />
      <span style={{
        fontSize: 10, fontFamily: F.mono, fontWeight: 600,
        color: C.ac, textTransform: "uppercase", letterSpacing: "1.5px", whiteSpace: "nowrap",
      }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: "rgba(56,189,248,0.15)" }} />
    </div>
  );
}

// ── Step Row ──────────────────────────────────────────────────────────────────
function StepRow({ step, idx, onChange, onStatusToggle, isActive, onActivate, rowRef }) {
  const isMobile = useIsMobile();
  const rowBg = step.status === "fail" ? "rgba(251,113,133,0.06)" : step.status === "pass" ? "rgba(52,211,153,0.06)" : isActive ? "rgba(56,189,248,0.05)" : "transparent";

  const passBtn = (
    <button onClick={e => { e.stopPropagation(); onStatusToggle(idx, "pass"); }} style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: isMobile ? "7px 0" : "4px 10px", borderRadius: 20,
      border: `1px solid ${step.status === "pass" ? "rgba(52,211,153,0.5)" : C.b2}`,
      background: step.status === "pass" ? "rgba(52,211,153,0.12)" : "transparent",
      color: step.status === "pass" ? C.gr : C.t3,
      fontFamily: F.mono, fontSize: isMobile ? 11 : 10, fontWeight: 700,
      cursor: "pointer", flex: 1, justifyContent: "center", transition: "all .15s",
    }}>
      <Ico n="check" s={isMobile ? 12 : 10} /> PASS
    </button>
  );
  const failBtn = (
    <button onClick={e => { e.stopPropagation(); onStatusToggle(idx, "fail"); }} style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: isMobile ? "7px 0" : "4px 10px", borderRadius: 20,
      border: `1px solid ${step.status === "fail" ? "rgba(251,113,133,0.5)" : C.b2}`,
      background: step.status === "fail" ? "rgba(251,113,133,0.12)" : "transparent",
      color: step.status === "fail" ? C.re : C.t3,
      fontFamily: F.mono, fontSize: isMobile ? 11 : 10, fontWeight: 700,
      cursor: "pointer", flex: 1, justifyContent: "center", transition: "all .15s",
    }}>
      <Ico n="x" s={isMobile ? 12 : 10} /> FAIL
    </button>
  );

  if (isMobile) {
    return (
      <div ref={rowRef} onClick={onActivate} style={{
        borderBottom: `1px solid ${C.b1}`, background: rowBg,
        outline: isActive ? `2px solid rgba(56,189,248,0.5)` : "none",
        outlineOffset: -2, transition: "background .15s", padding: "10px 12px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontFamily: F.mono, fontSize: 11, fontWeight: 700, color: C.t3, minWidth: 28, flexShrink: 0 }}>
            {isActive && <span style={{ color: C.ac, marginRight: 2 }}>●</span>}
            {step.serialNo != null && step.serialNo !== "" ? `#${step.serialNo}` : "—"}
          </span>
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", gap: 6, width: 160 }}>{passBtn}{failBtn}</div>
        </div>
        {step.action ? (
          <div style={{ fontSize: 13, color: C.t1, lineHeight: 1.5, marginBottom: 4, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{step.action}</div>
        ) : (
          <div style={{ fontSize: 12, color: C.t3, fontStyle: "italic", fontFamily: F.mono, marginBottom: 4 }}>No action</div>
        )}
        {step.result ? (
          <div style={{ fontSize: 12, color: C.t2, lineHeight: 1.5, marginBottom: 6, paddingLeft: 10, borderLeft: `2px solid rgba(56,189,248,0.25)`, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            <span style={{ fontSize: 10, fontFamily: F.mono, color: C.t3, display: "block", marginBottom: 2 }}>Expected</span>
            {step.result}
          </div>
        ) : null}
        <textarea
          value={step.remarks} onChange={e => onChange(idx, "remarks", e.target.value)}
          placeholder="Add remarks…" rows={2} onClick={e => e.stopPropagation()}
          style={{ width: "100%", background: C.s2, border: `1px solid ${C.b1}`, borderRadius: 6, color: C.t2, fontFamily: F.sans, fontSize: 12, resize: "vertical", outline: "none", lineHeight: 1.5, padding: "6px 8px", minHeight: 36 }}
        />
      </div>
    );
  }

  const readCell = (text, col) => (
    <div style={{ padding: "8px 12px", display: "flex", alignItems: "flex-start", borderRight: `1px solid ${C.b1}`, minHeight: 40 }}>
      {text ? (
        <span style={{ fontSize: 12, color: col, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{text}</span>
      ) : (
        <span style={{ fontSize: 11, color: C.t3, fontStyle: "italic", fontFamily: F.mono }}>—</span>
      )}
    </div>
  );

  return (
    <div ref={rowRef} onClick={onActivate} style={{
      display: "grid", gridTemplateColumns: "50px 1fr 1fr 180px 110px",
      borderBottom: `1px solid ${C.b1}`, background: rowBg,
      outline: isActive ? `2px solid rgba(56,189,248,0.4)` : "none",
      outlineOffset: -2, transition: "background .15s", cursor: "default",
    }}>
      <div style={{ padding: "8px 10px", display: "flex", alignItems: "center", justifyContent: "center", borderRight: `1px solid ${C.b1}` }}>
        {isActive && <div style={{ width: 4, height: 4, borderRadius: "50%", background: C.ac, marginRight: 4, flexShrink: 0 }} />}
        <span style={{ fontFamily: F.mono, fontSize: 12, fontWeight: 600, color: step.serialNo != null && step.serialNo !== "" ? C.t2 : C.t3 }}>
          {step.serialNo != null && step.serialNo !== "" ? step.serialNo : "—"}
        </span>
      </div>
      {readCell(step.action, C.t1)}
      {readCell(step.result, C.t2)}
      <div style={{ padding: "4px 10px", borderRight: `1px solid ${C.b1}` }}>
        <textarea
          value={step.remarks} onChange={e => onChange(idx, "remarks", e.target.value)}
          placeholder="Remarks…" rows={2} onClick={e => e.stopPropagation()}
          style={{ width: "100%", background: "transparent", border: "none", color: C.t2, fontFamily: F.sans, fontSize: 12, resize: "vertical", outline: "none", lineHeight: 1.5, minHeight: 36 }}
        />
      </div>
      <div style={{ padding: "6px 8px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4 }}>
        {passBtn}{failBtn}
      </div>
    </div>
  );
}

// ── Test Detail — shown when a single test is open (its steps table) ───────────
function TestDetail({
  mod,
  test,
  testIdx,
  allModules,
  session,
  saveMods,
  addLog,
  toast,
  onBack,
  onFinish,
  modIdx,
  modTotal,
  onNav,
  navLocked,  // true when tester holds lock and must click Finish before navigating
}) {
  const isAdmin = session.role === "admin";
  const [steps, setSteps] = useState(test.steps);
  const [search, setSearch] = useState("");
  const [fStat, setFStat] = useState("all");
  const [addCount, setAddCount] = useState(10);
  const [descVal, setDescVal] = useState(test.description || "");
  const [activeIdx, setActiveIdx] = useState(0); // tracks the highlighted row (original step index)
  const rowRefs = useRef({}); // keyed by original step index
  const tableRef = useRef();

  // Track whether the last setSteps came from a local commit (vs RT push).
  // When it's local we skip the sync-from-parent echo a few ms later.
  const localCommitRef = useRef(false);

  // Re-sync steps when the parent test identity changes (new test opened).
  useEffect(() => {
    setSteps(test.steps);
    setDescVal(test.description || "");
    const firstPending = test.steps.findIndex((s) => !s.isDivider && s.status === "pending");
    setActiveIdx(firstPending >= 0 ? firstPending : 0);
    localCommitRef.current = false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [test.id]);

  // Re-sync steps when a remote RT update arrives (different user changed a step).
  // Skips if we just committed locally (to avoid overwriting in-progress remarks).
  const testStepsFingerprint = useMemo(
    () =>
      test.steps
        .map((s) => s.id + ":" + s.status + ":" + (s.remarks || ""))
        .join("|"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [test.steps]
  );
  useEffect(() => {
    if (localCommitRef.current) {
      localCommitRef.current = false;
      return;
    }
    setSteps(test.steps);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testStepsFingerprint]);

  // When activeIdx changes, bring that row into prominent view at top of container
  useEffect(() => {
    const el = rowRefs.current[activeIdx];
    const container = tableRef.current;
    if (!el || !container) return;
    // Use a small delay so React has finished painting the updated rows
    const t = setTimeout(() => {
      const elRect = el.getBoundingClientRect();
      const ctRect = container.getBoundingClientRect();
      const relTop = elRect.top - ctRect.top; // row's position inside the visible container
      // If row is not already near the top, scroll it to ~60px from the top
      if (relTop < 0 || relTop > container.clientHeight * 0.35) {
        const target = container.scrollTop + relTop - 60;
        container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
      }
    }, 30);
    return () => clearTimeout(t);
  }, [activeIdx]);

  // Debounce ref for step saves — keeps DB write rate sane during rapid changes
  const stepsTimerRef = useRef(null);
  const latestStepsRef = useRef(test.steps);

  // Reset step ref whenever we open a different test — prevents stale data bleed
  useEffect(() => {
    latestStepsRef.current = test.steps;
    if (stepsTimerRef.current) {
      clearTimeout(stepsTimerRef.current);
      stepsTimerRef.current = null;
    }
  }, [test.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = useCallback(
    (newSteps, newName, newDesc) => {
      localCommitRef.current = true; // suppress next RT echo (it's our own save)
      const updTest = {
        ...test,
        steps: newSteps,
        name: newName ?? test.name,
        description: newDesc ?? test.description,
      };
      const updTests = mod.tests.map((t, i) => (i === testIdx ? updTest : t));
      const updMod = { ...mod, tests: updTests };

      // Update React state immediately (always)
      saveMods({ ...allModules, [mod.id]: updMod });

      // ── Surgical step save: only write steps for THIS test ──────────────
      // Debounced so rapid keystrokes / status toggles don't flood Supabase.
      latestStepsRef.current = newSteps;
      if (stepsTimerRef.current) clearTimeout(stepsTimerRef.current);
      stepsTimerRef.current = setTimeout(() => {
        store.saveSteps(test.id, mod.id, latestStepsRef.current, {
          moduleName:  mod.name,
          serialNo:    test.serialNo ?? test.serial_no ?? 0,
          name:        newName ?? test.name,
          description: newDesc ?? test.description ?? "",
        }).catch((e) => console.error("saveSteps error:", e));
      }, 400);
    },
    [mod, test, testIdx, allModules, saveMods]
  );

  const setField = (i, f, v) => {
    const ns = [...steps];
    ns[i] = { ...ns[i], [f]: v };
    setSteps(ns);
    commit(ns);
  };

  const setStatusToggle = (i, status) => {
    const ns = [...steps];
    const newStatus = ns[i].status === status ? "pending" : status;
    ns[i] = { ...ns[i], status: newStatus };
    setSteps(ns);
    commit(ns);
    if (newStatus !== "pending") {
      addLog({
        ts: Date.now(),
        user: session.name,
        action: `${mod.name} › ${test.name} · Step ${
          ns[i].serialNo
        } → ${newStatus.toUpperCase()}`,
        type: newStatus,
      });
    }
    // Auto-advance: find next pending step after current in the visible list
    if (newStatus !== "pending") {
      // Build current visible list from updated steps
      const updVisible = ns
        .map((s, idx) => ({ ...s, _i: idx }))
        .filter((s) => {
          if (s.isDivider) return false;
          if (fStat !== "all" && s.status !== fStat) return false;
          if (search) {
            const q = search.toLowerCase();
            return (
              (s.action || "").toLowerCase().includes(q) ||
              (s.result || "").toLowerCase().includes(q) ||
              (s.remarks || "").toLowerCase().includes(q) ||
              String(s.serialNo).includes(q)
            );
          }
          return true;
        });
      // Find current position in visible list
      const curPos = updVisible.findIndex((s) => s._i === i);
      // Look for the next pending step after current position
      const nextPending = updVisible
        .slice(curPos + 1)
        .find((s) => s.status === "pending");
      if (nextPending) {
        setActiveIdx(nextPending._i);
      } else {
        // No more pending after this — wrap to first pending anywhere in visible list
        const firstPending = updVisible.find((s) => s.status === "pending");
        if (firstPending) setActiveIdx(firstPending._i);
        // else all done — keep current
      }
    }
  };

  const addSteps = () => {
    if (steps.length >= 100_000) {
      toast("Maximum 100,000 steps per test", "error");
      return;
    }
    const n = Math.min(addCount, 100_000 - steps.length);
    const start = steps.length + 1;
    const ns = [
      ...steps,
      ...Array.from({ length: n }, (_, i) => makeStep(test.id, start + i)),
    ];
    setSteps(ns);
    commit(ns);
    toast(
      `Added ${n} step${n > 1 ? "s" : ""}`,
      steps.length + n >= 100_000 ? "info" : "success"
    );
  };

  const resetAll = () => {
    const ns = steps.map((s) => s.isDivider ? s : { ...s, status: "pending" });
    setSteps(ns);
    commit(ns);
    setActiveIdx(0);
    toast("Steps reset", "info");
    addLog({
      ts: Date.now(),
      user: session.name,
      action: `Reset ${mod.name} › ${test.name}`,
      type: "info",
    });
  };

  const exportCSV = () => {
    const rows = [["Serial No", "Action", "Result", "Remarks", "Status"]];
    steps.forEach((s) => {
      if (s.isDivider) {
        rows.push([`"$$$${s.action}"`, "", "", "", ""]);
      } else {
        rows.push([s.serialNo, `"${s.action}"`, `"${s.result}"`, `"${s.remarks}"`, s.status]);
      }
    });
    const b = new Blob([rows.map((r) => r.join(",")).join("\n")], {
      type: "text/csv",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = `${mod.name}_${test.name}.csv`.replace(/\s+/g, "_");
    a.click();
    toast("CSV exported", "success");
  };

  const exportPDF = () => {
    const statusColor = (s) =>
      s === "pass" ? "#16a34a" : s === "fail" ? "#dc2626" : "#9ca3af";
    const statusBg = (s) =>
      s === "pass" ? "rgba(52,211,153,0.08)" : s === "fail" ? "rgba(251,113,133,0.08)" : "rgba(10,16,28,0.9)";
    const rows = steps
      .map(
        (s) => `
      <tr style="background:${statusBg(s.status)}">
        <td style="padding:7px 10px;border:1px solid #e5e7eb;font-family:monospace;font-size:12px;text-align:center;white-space:nowrap">${
          s.serialNo || "—"
        }</td>
        <td style="padding:7px 10px;border:1px solid #e5e7eb;font-size:13px">${
          s.action || ""
        }</td>
        <td style="padding:7px 10px;border:1px solid #e5e7eb;font-size:13px;color:#4b5563">${
          s.result || ""
        }</td>
        <td style="padding:7px 10px;border:1px solid #e5e7eb;font-size:13px;color:#6b7280">${
          s.remarks || ""
        }</td>
        <td style="padding:7px 10px;border:1px solid #e5e7eb;font-family:monospace;font-size:11px;font-weight:700;text-align:center;color:${statusColor(
          s.status
        )}">${s.status.toUpperCase()}</td>
      </tr>`
      )
      .join("");

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <title>${mod.name} — ${test.name}</title>
      <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;padding:32px}
        h1{font-size:20px;font-weight:700;margin-bottom:4px}
        h2{font-size:14px;font-weight:500;color:#6b7280;margin-bottom:16px}
        .meta{display:flex;gap:20px;font-size:12px;color:#6b7280;font-family:monospace;margin-bottom:20px;padding:10px 14px;background:#f9fafb;border-radius:6px;border:1px solid #e5e7eb}
        .meta span{font-weight:600;color:#111827}
        table{width:100%;border-collapse:collapse}
        thead th{padding:8px 10px;background:#f3f4f6;border:1px solid #e5e7eb;font-size:11px;font-family:monospace;text-transform:uppercase;letter-spacing:1px;color:#6b7280;text-align:left}
        @page{margin:16mm}
        @media print{body{padding:0}}
      </style></head><body>
      <h1>${mod.name} — ${test.name}</h1>
      ${test.description ? `<h2>${test.description}</h2>` : ""}
      <div class="meta">
        <div>Total <span>${steps.length}</span></div>
        <div>Pass <span style="color:#16a34a">${pass}</span></div>
        <div>Fail <span style="color:#dc2626">${fail}</span></div>
        <div>Pending <span style="color:#d97706">${pending}</span></div>
        <div>Progress <span>${pct}%</span></div>
        <div>Exported <span>${new Date().toLocaleString()}</span></div>
      </div>
      <table>
        <thead><tr><th style="width:60px">S.No</th><th>Action</th><th>Expected Result</th><th>Remarks</th><th style="width:80px">Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </body></html>`;

    const w = window.open("", "_blank");
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => {
      w.print();
    }, 400);
    toast("PDF ready — use browser print dialog", "info");
  };

  const realSteps = useMemo(() => steps.filter((s) => !s.isDivider), [steps]);
  const pass    = realSteps.filter((s) => s.status === "pass").length;
  const fail    = realSteps.filter((s) => s.status === "fail").length;
  const pending = realSteps.length - pass - fail;
  const pct     = Math.round((pass / Math.max(realSteps.length, 1)) * 100);

  const visible = useMemo(
    () =>
      steps
        .map((s, i) => ({ ...s, _i: i }))
        .filter((s) => {
          if (s.isDivider) return true; // always show dividers
          if (fStat !== "all" && s.status !== fStat) return false;
          if (search) {
            const q = search.toLowerCase();
            return (
              (s.action || "").toLowerCase().includes(q) ||
              (s.result || "").toLowerCase().includes(q) ||
              (s.remarks || "").toLowerCase().includes(q) ||
              String(s.serialNo).includes(q)
            );
          }
          return true;
        }),
    [steps, fStat, search]
  );

  const isMobile = useIsMobile();
  const onMenuClick = useContext(MobileMenuCtx);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* ── Test header: redesigned 2-row layout ─────────────────────────── */}
      <div
        style={{
          background: C.s1,
          borderBottom: `1px solid ${C.b1}`,
          flexShrink: 0,
          boxShadow: "0 1px 4px rgba(0,0,0,.06)",
        }}
      >
        {/* Row 1 — breadcrumb + title + progress */}
        <div
          style={{
            padding: isMobile ? "10px 12px 8px" : "12px 22px 10px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderBottom: `1px solid ${C.b1}`,
            minHeight: 50,
          }}
        >
          {/* Hamburger on mobile */}
          {isMobile && onMenuClick && (
            <button onClick={onMenuClick} style={{ ...iBtn(), padding: "5px 6px", marginLeft: -4, flexShrink: 0 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            </button>
          )}

          {/* Back breadcrumb */}
          <button
            onClick={onBack}
            style={{
              ...smBtn(),
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              background: C.s2,
              borderColor: C.b1,
              color: C.t2,
              flexShrink: 0,
              maxWidth: isMobile ? 90 : 160,
            }}
          >
            <Ico n="chevL" s={11} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {mod.name}
            </span>
          </button>

          <span style={{ color: C.t3, fontSize: 12, flexShrink: 0 }}>›</span>

          {/* Test name (static) */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{
                fontSize: isMobile ? 14 : 15,
                fontWeight: 700,
                color: C.t1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {test.name}
              </span>
            </div>

          {/* Progress pill — always visible */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexShrink: 0,
            background: C.s2,
            border: `1px solid ${C.b1}`,
            borderRadius: 20,
            padding: isMobile ? "4px 10px" : "4px 12px",
          }}>
            {!isMobile && (
              <>
                <span style={{ fontSize: 10, fontFamily: F.mono, color: C.gr, fontWeight: 600 }}>{pass}✓</span>
                {fail > 0 && <span style={{ fontSize: 10, fontFamily: F.mono, color: C.re, fontWeight: 600 }}>{fail}✗</span>}
                <span style={{ fontSize: 10, fontFamily: F.mono, color: C.t3 }}>{pending}…</span>
                <div style={{ width: 1, height: 12, background: C.b2 }} />
              </>
            )}
            <span style={{ fontSize: 11, fontFamily: F.mono, fontWeight: 700,
              color: pct === 100 ? C.gr : fail > 0 ? C.re : C.ac }}>
              {pct}%
            </span>
          </div>

          {/* Module nav arrows */}
          {!isMobile && modIdx !== undefined && modTotal !== undefined && (
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
              <button
                style={smBtn(navLocked ? { opacity: 0.4, cursor: "not-allowed" } : {})}
                onClick={() => !navLocked && onNav && onNav(-1)}
                disabled={modIdx === 0 || navLocked}
                title={navLocked ? "Finish your test first" : "Previous module"}
              >
                <Ico n="chevL" s={12} />
              </button>
              <span style={{ fontSize: 10, fontFamily: F.mono, color: C.t3, whiteSpace: "nowrap" }}>
                {modIdx + 1}/{modTotal}
              </span>
              <button
                style={smBtn(navLocked ? { opacity: 0.4, cursor: "not-allowed" } : {})}
                onClick={() => !navLocked && onNav && onNav(1)}
                disabled={modIdx === modTotal - 1 || navLocked}
                title={navLocked ? "Finish your test first" : "Next module"}
              >
                <Ico n="chevR" s={12} />
              </button>
            </div>
          )}
        </div>

        {/* Row 2 — description + progress bar */}
        <div style={{
          padding: isMobile ? "6px 12px" : "6px 22px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: C.s2,
          borderBottom: `1px solid ${C.b1}`,
        }}>
          <input
            value={descVal}
            onChange={(e) => { setDescVal(e.target.value); commit(steps, test.name, e.target.value); }}
            placeholder="Add a description…"
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              color: C.t2,
              fontFamily: F.sans,
              fontSize: 12,
              outline: "none",
            }}
          />
          <div style={{ width: isMobile ? 80 : 120, flexShrink: 0 }}>
            <PBar pct={pct} fail={fail > 0} />
          </div>
        </div>

        {/* Row 3 — action buttons */}
        <div style={{
          padding: isMobile ? "8px 12px" : "8px 22px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: isMobile ? "wrap" : "nowrap",
        }}>
          <ExportMenu onCSV={exportCSV} onPDF={exportPDF} />
          {isAdmin && (
            <button style={reBtn(smBtn())} onClick={resetAll}>
              <Ico n="reset" s={12} /> Reset
            </button>
          )}
          {/* Finish test button — prominent for testers */}
          {!isAdmin && onFinish && (
            <button
              style={{
                ...grBtn(smBtn()),
                marginLeft: isMobile ? 0 : "auto",
                flex: isMobile ? 1 : "none",
                justifyContent: "center",
                padding: isMobile ? "9px 0" : "6px 14px",
                fontSize: isMobile ? 14 : 12,
                fontWeight: 700,
                boxShadow: "0 2px 8px rgba(22,163,74,.25)",
              }}
              onClick={() => {
                commit(steps);
                addLog({ ts: Date.now(), user: session.name,
                  action: `Finished ${mod.name} › ${test.name}`, type: "info" });
                toast("Test finished — progress saved & lock released", "success");
                onFinish(steps);
              }}
              title="Save progress and release the lock so others can continue"
            >
              <Ico n="check" s={14} /> Finish Test
            </button>
          )}
          {/* Spacer if admin (no Finish button) */}
          {isAdmin && <div style={{ flex: 1 }} />}
        </div>
      </div>

      <div
        style={{
          padding: isMobile ? "8px 12px" : "8px 16px",
          background: C.s1,
          borderBottom: `1px solid ${C.b1}`,
          display: "flex",
          alignItems: isMobile ? "flex-start" : "center",
          flexDirection: isMobile ? "column" : "row",
          gap: isMobile ? 8 : 8,
          flexShrink: 0,
        }}
      >
        {/* Filter pills + search row */}
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {[
            ["all", "All", realSteps.length],
            ["pass", "Pass", pass],
            ["fail", "Fail", fail],
            ["pending", "Pending", pending],
          ].map(([k, l, c]) => (
            <button
              key={k}
              onClick={() => setFStat(k)}
              style={{
                padding: isMobile ? "6px 11px" : "4px 9px",
                borderRadius: 20,
                border: `1px solid ${fStat === k ? C.b2 : C.b1}`,
                background: fStat === k ? C.s3 : "transparent",
                color: fStat === k ? C.t1 : C.t2,
                fontFamily: F.mono,
                fontSize: isMobile ? 11 : 10,
                cursor: "pointer",
              }}
            >
              {l} ({c})
            </button>
          ))}
          </div>
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Search steps…"
            width={isMobile ? "100%" : 170}
          />
        </div>
        {isAdmin && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              width: isMobile ? "100%" : "auto",
            }}
          >
            <select
              value={addCount}
              onChange={(e) => setAddCount(Number(e.target.value))}
              style={{
                padding: "4px 6px",
                background: C.s2,
                border: `1px solid ${C.b1}`,
                borderRadius: 5,
                color: C.t1,
                fontFamily: F.mono,
                fontSize: 11,
                outline: "none",
                flex: isMobile ? 1 : "none",
              }}
            >
              {[1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000].map((n) => (
                <option key={n} value={n}>
                  +{n}
                </option>
              ))}
            </select>
            <button
              style={isMobile ? grBtn({ ...smBtn(), flex: 1, justifyContent: "center", padding: "8px 0" }) : grBtn(smBtn())}
              onClick={addSteps}
              disabled={steps.length >= 100_000}
            >
              <Ico n="plus" s={11} /> Add Steps
            </button>
          </div>
        )}
      </div>

      <div ref={tableRef} style={{ flex: 1, overflowY: "auto", overflowX: isMobile ? "hidden" : "auto" }}>
        <div style={isMobile ? {} : { minWidth: 680 }}>
        {/* Desktop column headers */}
        {!isMobile && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "50px 1fr 1fr 180px 110px",
            background: "rgba(10,16,28,0.9)",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            borderBottom: `1px solid ${C.b2}`,
            position: "sticky",
            top: 0,
            zIndex: 2,
          }}
        >
          {["S.No", "Action", "Expected Result", "Remarks", "Status"].map(
            (h, i) => (
              <div
                key={i}
                style={{
                  padding: "8px 10px",
                  fontSize: 10,
                  fontFamily: F.mono,
                  textTransform: "uppercase",
                  letterSpacing: "1px",
                  color: C.t3,
                  borderRight: i < 4 ? `1px solid ${C.b1}` : "none",
                }}
              >
                {h}
              </div>
            )
          )}
        </div>
        )}

        {visible.length === 0 && (
          <div
            style={{
              textAlign: "center",
              padding: "48px 0",
              color: C.t3,
              fontFamily: F.mono,
              fontSize: 12,
            }}
          >
            {steps.length === 0
              ? isAdmin
                ? "No steps yet — import a CSV to add steps."
                : "No steps available."
              : "No steps match."}
          </div>
        )}
        {visible.map((s) =>
          s.isDivider ? (
            <DividerRow key={s.id} label={s.action} />
          ) : (
            <StepRow
              key={s.id}
              step={s}
              idx={s._i}
              onChange={setField}
              onStatusToggle={setStatusToggle}
              isActive={activeIdx === s._i}
              onActivate={() => setActiveIdx(s._i)}
              rowRef={(el) => { rowRefs.current[s._i] = el; }}
            />
          )
        )}
        </div>
      </div>

    </div>
  );
}
// ── Module View — shows test list for one module, one test at a time ───────────
function ModuleView({
  mod,
  allModules,
  session,
  saveMods,
  addLog,
  toast,
  onNav,
  onLockChange,  // callback(bool) — tells root App when a lock is acquired/released
  modIdx,
  modTotal,
}) {
  const isAdmin = session.role === "admin";
  const isMobile = useIsMobile();
  const [selTestIdx, setSelTestIdx] = useState(null); // null = list, number = test detail
  const [search, setSearch] = useState("");
  const [locks, setLocks] = useState({});

  // Refs to always have current values without stale closures
  const activeTestIdRef  = useRef(null);  // test id currently open (for heartbeat + beforeunload)
  const selTestIdxRef    = useRef(null);  // mirrors selTestIdx for use inside effects
  const modTestsRef      = useRef(mod.tests); // mirrors mod.tests for use in cleanup effects

  // Keep refs in sync with state/props on every render
  selTestIdxRef.current = selTestIdx;
  modTestsRef.current   = mod.tests;

  // UI convenience: true while this tester holds an unreleased lock on any test in this module
  const [uiLocked, setUiLocked] = useState(false);

  // Poll locks every 5 seconds so all users see live lock state
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const l = await lockStore.getAll();
      if (alive) setLocks(l);
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Heartbeat: while a tester has a test open, refresh locked_at every 25s.
  // activeTestIdRef is NOT cleared here — it persists across goBack() so that
  // beforeunload can still fire a beacon even when the tester is on the list view.
  // It is only cleared explicitly by finishTest() or the module-change effect.
  useEffect(() => {
    if (isAdmin || selTestIdx === null) return;
    const test = mod.tests[selTestIdx];
    if (!test) return;
    const beat = setInterval(() => {
      lockStore.heartbeat(test.id, session.id);
    }, HEARTBEAT_MS);
    return () => clearInterval(beat);
  }, [selTestIdx, isAdmin]);

  // beforeunload: best-effort release on normal tab/window close (testers only).
  // Uses activeTestIdRef so it always sees the latest open test id.
  useEffect(() => {
    if (isAdmin) return;
    const onUnload = () => {
      const testId = activeTestIdRef.current;
      if (!testId) return;
      try {
        // supabase.supabaseUrl is the correct property on @supabase/supabase-js v2
        const baseUrl = supabase.supabaseUrl || supabase.storageUrl?.replace("/storage/v1", "") || "";
        if (baseUrl) {
          const url = `${baseUrl}/rest/v1/test_locks?test_id=eq.${encodeURIComponent(testId)}&user_id=eq.${encodeURIComponent(session.id)}`;
          const sent = navigator.sendBeacon(url + "&_method=DELETE", null);
          if (!sent) lockStore.release(testId, session.id);
        } else {
          lockStore.release(testId, session.id);
        }
      } catch {
        lockStore.release(testId, session.id);
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [isAdmin, session.id]);

  // Module change: release lock for whatever test was open, then reset view.
  // Uses refs so this always sees the latest selTestIdx / mod.tests values
  // even though the effect only re-runs when mod.id changes.
  useEffect(() => {
    const testId = activeTestIdRef.current;
    if (!isAdmin && testId) {
      lockStore.release(testId, session.id);
      activeTestIdRef.current = null;
      if (onLockChange) onLockChange(false);
      setUiLocked(false);
    }
    setSelTestIdx(null);
    setSearch("");
  }, [mod.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const openTest = async (realIdx) => {
    const test = mod.tests[realIdx];
    if (!test) return;
    if (!isAdmin) {
      const result = await lockStore.acquire(test.id, session.id, session.name);
      if (!result.ok) {
        toast(`🔒 Locked by ${result.by} — they must click "Finish Test" first`, "error");
        return;
      }
      setLocks(await lockStore.getAll());
      // Track which test is locked so beforeunload can release it even from list view
      activeTestIdRef.current = test.id;
      if (onLockChange) onLockChange(true);
      setUiLocked(true);
    }
    setSelTestIdx(realIdx);
  };

  // Back button: return to test list WITHOUT releasing the lock.
  // The lock stays alive (heartbeat keeps it fresh) so the tester can come back.
  const goBack = () => {
    setSelTestIdx(null);
  };

  // Finish Test: saves, releases lock, clears ref, returns to test list.
  // This is the canonical way for a tester to hand off a test.
  const finishTest = async (finalSteps) => {
    if (!isAdmin && selTestIdx !== null && mod.tests[selTestIdx]) {
      await lockStore.release(mod.tests[selTestIdx].id, session.id);
      activeTestIdRef.current = null; // lock released — no need for beforeunload beacon
      setLocks(await lockStore.getAll());
      if (onLockChange) onLockChange(false);
      setUiLocked(false);
    }
    setSelTestIdx(null);
  };

  const saveModName = (name) => {
    saveMods({ ...allModules, [mod.id]: { ...mod, name } }, true);
    toast("Renamed", "success");
    addLog({
      ts: Date.now(),
      user: session.name,
      action: `Renamed module to "${name}"`,
      type: "info",
    });
  };

  const addTest = () => {
    const n = mod.tests.length + 1;
    const nt = makeTest(mod.id, n, 10);
    const updated = { ...mod, tests: [...mod.tests, nt] };
    saveMods({ ...allModules, [mod.id]: updated }, true);
    // saveModules only upserts test rows — save the new test's default steps surgically
    store.saveSteps(nt.id, mod.id, nt.steps, {
      moduleName:  mod.name,
      serialNo:    n,
      name:        nt.name,
      description: nt.description ?? "",
    }).catch((e) => console.error("addTest saveSteps error:", e));
    toast(`Test ${n} added`, "success");
    addLog({
      ts: Date.now(),
      user: session.name,
      action: `Added ${mod.name} › Test ${n}`,
      type: "info",
    });
  };

  const deleteTest = (idx) => {
    if (mod.tests.length <= 1) {
      toast("Cannot delete the last test", "error");
      return;
    }
    const updated = {
      ...mod,
      tests: mod.tests
        .filter((_, i) => i !== idx)
        .map((t, i) => ({ ...t, serialNo: i + 1, serial_no: i + 1, name: `Test ${i + 1}` })),
    };
    saveMods({ ...allModules, [mod.id]: updated }, true);
    toast("Test deleted", "info");
    addLog({
      ts: Date.now(),
      user: session.name,
      action: `Deleted test from ${mod.name}`,
      type: "info",
    });
  };

  // When inside a test, show TestDetail
  if (selTestIdx !== null && mod.tests[selTestIdx]) {
    return (
      <TestDetail
        mod={mod}
        test={mod.tests[selTestIdx]}
        testIdx={selTestIdx}
        allModules={allModules}
        session={session}
        saveMods={saveMods}
        addLog={addLog}
        toast={toast}
        onBack={goBack}
        onFinish={finishTest}
        modIdx={modIdx}
        modTotal={modTotal}
        onNav={!isAdmin ? null : onNav}
        navLocked={!isAdmin && uiLocked}
      />
    );
  }

  // Otherwise show module's test list
  const filtered = mod.tests.filter(
    (t) =>
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.description.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <Topbar
        title={
          <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, overflow: "hidden" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {mod.name}
              </span>
            </span>
        }
        sub={`${modIdx + 1}/${modTotal} · ${mod.tests.length} test${mod.tests.length !== 1 ? "s" : ""}`}
      >
        {!isMobile && (
          <>
            <button
              style={smBtn()}
              onClick={() => onNav(-1)}
              disabled={modIdx === 0 || uiLocked}
              title={uiLocked ? "Finish the current test first" : undefined}
            >
              <Ico n="chevL" s={12} />
            </button>
            <button
              style={smBtn()}
              onClick={() => onNav(1)}
              disabled={modIdx === modTotal - 1 || uiLocked}
              title={uiLocked ? "Finish the current test first" : undefined}
            >
              <Ico n="chevR" s={12} />
            </button>
          </>
        )}
        {!isMobile && (
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Search tests…"
            width={170}
          />
        )}
        {isAdmin && (
          <button style={grBtn(smBtn())} onClick={addTest}>
            <Ico n="plus" s={12} /> {isMobile ? "" : "Add Test"}
          </button>
        )}
      </Topbar>

      <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? 12 : 16 }}>
        {isMobile && (
          <div style={{ marginBottom: 10 }}>
            <SearchBox value={search} onChange={setSearch} placeholder="Search tests…" width="100%" />
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 10 : 8 }}>
          {filtered.map((t, visIdx) => {
            const realIdx = mod.tests.indexOf(t);
            const pass = t.steps.filter((s) => s.status === "pass").length;
            const fail = t.steps.filter((s) => s.status === "fail").length;
            const pct = Math.round((pass / Math.max(t.steps.length, 1)) * 100);
            const pending = t.steps.length - pass - fail;
            const lock = locks[t.id];
            const lockedByOther = !isAdmin && lock && lock.userId !== session.id;
            // This tester went Back from their own test — still holds the lock on it.
            // Every OTHER test card is blocked until they Finish their test.
            const myLockedTestId = !isAdmin && uiLocked ? activeTestIdRef.current : null;
            const blockedByMyLock = !isAdmin && uiLocked && t.id !== myLockedTestId;
            const isMyLockedTest  = !isAdmin && uiLocked && t.id === myLockedTestId;
            const lockInfo = lock && lock.userId !== session.id ? lock : null;

            const cardBlocked = lockedByOther || blockedByMyLock;
            return (
              <div
                key={t.id}
                style={{
                  background: lockedByOther ? "rgba(251,191,36,0.08)"
                    : isMyLockedTest ? "rgba(52,211,153,0.08)"
                    : blockedByMyLock ? "rgba(15,25,45,0.5)"
                    : C.s1,
                  border: `1px solid ${
                    lockedByOther ? "rgba(251,191,36,0.3)"
                      : isMyLockedTest ? "rgba(52,211,153,0.3)"
                      : blockedByMyLock ? C.b1
                      : fail > 0 ? "rgba(251,113,133,0.3)"
                      : pass === t.steps.length && t.steps.length > 0 ? "rgba(52,211,153,0.25)"
                      : C.b1
                  }`,
                  borderRadius: 10,
                  overflow: "hidden",
                  cursor: cardBlocked ? "not-allowed" : "pointer",
                  transition: "border-color .15s",
                  opacity: lockedByOther ? 0.85 : blockedByMyLock ? 0.5 : 1,
                }}
                onClick={() => !cardBlocked && openTest(realIdx)}
              >
                {/* Test header */}
                <div
                  style={{
                    padding: isMobile ? "12px 14px" : "14px 18px",
                    display: "flex",
                    alignItems: isMobile ? "flex-start" : "center",
                    gap: isMobile ? 10 : 14,
                    flexDirection: isMobile ? "column" : "row",
                  }}
                >
                  {/* Top row on mobile: badge + name + action */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%" }}>
                  {/* Serial badge */}
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 9,
                      background: lockedByOther ? "#fef3c7" : isMyLockedTest ? "#dcfce7" : C.s3,
                      border: `1px solid ${lockedByOther ? "rgba(251,191,36,0.5)" : isMyLockedTest ? "rgba(52,211,153,0.3)" : C.b2}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontFamily: F.mono,
                      fontSize: 14,
                      fontWeight: 700,
                      color: lockedByOther ? C.am : isMyLockedTest ? C.gr : C.t2,
                      flexShrink: 0,
                    }}
                  >
                    {lockedByOther ? <Ico n="lock" s={15} />
                      : isMyLockedTest ? <Ico n="check" s={15} />
                      : t.serialNo}
                  </div>
                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: C.t1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t.name}
                    </div>
                    {(lockInfo || isMyLockedTest) && (
                      <div style={{ marginTop: 3 }}>
                        {lockInfo && (
                          <span style={{
                            fontSize: 10, fontFamily: F.mono, background: "rgba(251,191,36,0.1)",
                            color: C.am, padding: "2px 8px", borderRadius: 10,
                            border: `1px solid #fcd34d`, fontWeight: 700,
                          }}>
                            🔒 In use by {lockInfo.userName}
                          </span>
                        )}
                        {isMyLockedTest && (
                          <span style={{
                            fontSize: 10, fontFamily: F.mono, background: "rgba(52,211,153,0.1)",
                            color: C.gr, padding: "2px 8px", borderRadius: 10,
                            border: `1px solid #86efac`, fontWeight: 700,
                          }}>
                            ▶ Your active test
                          </span>
                        )}
                      </div>
                    )}
                    {t.description && (
                      <div style={{ fontSize: 11, color: C.t2, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {t.description}
                      </div>
                    )}
                    <div style={{ fontSize: 11, fontFamily: F.mono, color: C.t3, marginTop: 3 }}>
                      {t.steps.length} step{t.steps.length !== 1 ? "s" : ""} · {pass}✓ {fail}✗ {pending}…
                    </div>
                  </div>
                  {/* Actions — always on the right of the top row */}
                  <div
                    style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {isAdmin && !isMobile && (
                      <button style={reBtn(smBtn())} onClick={() => deleteTest(realIdx)} title="Delete test">
                        <Ico n="trash" s={11} />
                      </button>
                    )}
                    {lockedByOther ? (
                      <button style={amBtn(smBtn())} disabled title={`Locked by ${lock.userName}`}>
                        <Ico n="lock" s={11} /> {!isMobile && "Locked"}
                      </button>
                    ) : isMyLockedTest ? (
                      <button style={grBtn(smBtn())} onClick={() => openTest(realIdx)} title="Return to your test">
                        <Ico n="back" s={11} /> Return
                      </button>
                    ) : blockedByMyLock ? (
                      <button style={smBtn({ opacity: 0.4, cursor: "not-allowed" })} disabled title="Finish your current test first">
                        <Ico n="lock" s={11} />
                      </button>
                    ) : (
                      <button style={acBtn(smBtn())} onClick={() => openTest(realIdx)}>
                        <Ico n="chevR" s={11} /> {!isMobile && "Open"}
                      </button>
                    )}
                    {isAdmin && isMobile && (
                      <button style={reBtn(smBtn())} onClick={() => deleteTest(realIdx)} title="Delete test">
                        <Ico n="trash" s={11} />
                      </button>
                    )}
                  </div>
                  </div>

                  {/* Bottom row: progress bar + chips (only when not locked-by-other on mobile) */}
                  {!isMobile && (
                  <>
                  {/* Progress */}
                  <div style={{ width: 80, flexShrink: 0 }}>
                    <PBar pct={pct} fail={fail > 0} />
                    <div style={{ fontSize: 10, color: C.t3, fontFamily: F.mono, textAlign: "right", marginTop: 3 }}>
                      {pct}%
                    </div>
                  </div>
                  {/* Status chips */}
                  <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
                    {pass > 0 && <Chip label={`✓${pass}`} color={C.gr} bg={C.grd} />}
                    {fail > 0 && <Chip label={`✗${fail}`} color={C.re} bg={C.red} />}
                    {pending > 0 && <Chip label={`⟳${pending}`} color={C.am} bg={C.amd} />}
                  </div>
                  </>
                  )}
                </div>

                {/* Mini progress strip */}
                <div style={{ height: 3, background: C.s3, display: "flex" }}>
                  <div
                    style={{
                      width: `${(pass / Math.max(t.steps.length, 1)) * 100}%`,
                      background: C.gr,
                      transition: "width .4s",
                    }}
                  />
                  <div
                    style={{
                      width: `${(fail / Math.max(t.steps.length, 1)) * 100}%`,
                      background: C.re,
                      transition: "width .4s",
                    }}
                  />
                </div>
              </div>
            );
          })}

          {filtered.length === 0 && (
            <div
              style={{
                textAlign: "center",
                padding: "48px 0",
                color: C.t3,
                fontFamily: F.mono,
                fontSize: 12,
              }}
            >
              No tests match.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
// ── Report View ────────────────────────────────────────────────────────────────
function ReportView({ modules, toast }) {
  const isMobile = useIsMobile();
  const [search, setSearch] = useState("");
  const [failOnly, setFailOnly] = useState(false);
  const [exp, setExp] = useState(new Set());
  const modList = useMemo(() => Object.values(modules), [modules]);

  const modStats = useMemo(
    () =>
      modList.map((m) => {
        const allSteps = m.tests.flatMap((t) => t.steps);
        const pass = allSteps.filter((s) => s.status === "pass").length;
        const fail = allSteps.filter((s) => s.status === "fail").length;
        return { ...m, pass, fail, total: allSteps.length };
      }),
    [modList]
  );

  const pass = modStats.reduce((a, m) => a + m.pass, 0);
  const fail = modStats.reduce((a, m) => a + m.fail, 0);
  const total = modStats.reduce((a, m) => a + m.total, 0);

  const filtered = useMemo(() => {
    let l = modStats.filter((m) =>
      m.name.toLowerCase().includes(search.toLowerCase())
    );
    if (failOnly) l = l.filter((m) => m.fail > 0);
    return l;
  }, [modStats, search, failOnly]);

  const exportAllCSV = () => {
    const rows = [
      ["Module", "Test", "Step", "Action", "Result", "Remarks", "Status"],
    ];
    modList.forEach((m) =>
      m.tests.forEach((t) =>
        t.steps.forEach((s) =>
          rows.push([
            `"${m.name}"`,
            `"${t.name}"`,
            s.serialNo,
            `"${s.action}"`,
            `"${s.result}"`,
            `"${s.remarks}"`,
            s.status,
          ])
        )
      )
    );
    const b = new Blob([rows.map((r) => r.join(",")).join("\n")], {
      type: "text/csv",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = `TestPro_Report_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    toast("CSV exported", "success");
  };

  const exportAllPDF = () => {
    const sc = (s) =>
      s === "pass" ? "#16a34a" : s === "fail" ? "#dc2626" : "#9ca3af";
    const sb = (s) =>
      s === "pass" ? "rgba(52,211,153,0.08)" : s === "fail" ? "rgba(251,113,133,0.08)" : "#0c1220";

    const modRows = filtered
      .map((m) => {
        const mp = m.tests
          .flatMap((t) => t.steps)
          .filter((s) => s.status === "pass").length;
        const mf = m.tests
          .flatMap((t) => t.steps)
          .filter((s) => s.status === "fail").length;
        const mt = m.tests.flatMap((t) => t.steps).length;
        const mpct = Math.round((mp / Math.max(mt, 1)) * 100);

        const testRows = m.tests
          .map((t) => {
            const tp = t.steps.filter((s) => s.status === "pass").length;
            const tf = t.steps.filter((s) => s.status === "fail").length;
            const stepRows = t.steps
              .map(
                (s) => `
          <tr style="background:${sb(s.status)}">
            <td style="padding:5px 8px;border:1px solid #e5e7eb;font-family:monospace;font-size:11px;text-align:center">${
              s.serialNo || "—"
            }</td>
            <td style="padding:5px 8px;border:1px solid #e5e7eb;font-size:12px">${
              s.action || ""
            }</td>
            <td style="padding:5px 8px;border:1px solid #e5e7eb;font-size:12px;color:#4b5563">${
              s.result || ""
            }</td>
            <td style="padding:5px 8px;border:1px solid #e5e7eb;font-size:12px;color:#6b7280">${
              s.remarks || ""
            }</td>
            <td style="padding:5px 8px;border:1px solid #e5e7eb;font-family:monospace;font-size:10px;font-weight:700;text-align:center;color:${sc(
              s.status
            )}">${s.status.toUpperCase()}</td>
          </tr>`
              )
              .join("");
            if (!t.steps.length) return "";
            return `
          <tr><td colspan="5" style="padding:6px 10px;background:#f9fafb;border:1px solid #e5e7eb;font-size:12px;font-weight:600">
            ${t.name}
            <span style="font-weight:400;color:#6b7280;margin-left:10px;font-family:monospace;font-size:11px">✓${tp} ✗${tf} ⟳${
              t.steps.length - tp - tf
            }</span>
          </td></tr>
          ${stepRows}`;
          })
          .join("");

        return `
        <div style="margin-bottom:28px;break-inside:avoid">
          <div style="background:#f3f4f6;padding:10px 14px;border-radius:6px 6px 0 0;border:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:15px;font-weight:700">${m.name}</span>
            <span style="font-family:monospace;font-size:11px;color:#6b7280">✓${mp} ✗${mf} ⟳${
          mt - mp - mf
        } · ${mpct}%</span>
          </div>
          ${
            mt > 0
              ? `<table style="width:100%;border-collapse:collapse">
            <thead><tr>
              <th style="padding:6px 8px;background:#f9fafb;border:1px solid #e5e7eb;font-size:10px;font-family:monospace;text-transform:uppercase;letter-spacing:1px;color:#6b7280;width:55px">S.No</th>
              <th style="padding:6px 8px;background:#f9fafb;border:1px solid #e5e7eb;font-size:10px;font-family:monospace;text-transform:uppercase;letter-spacing:1px;color:#6b7280">Action</th>
              <th style="padding:6px 8px;background:#f9fafb;border:1px solid #e5e7eb;font-size:10px;font-family:monospace;text-transform:uppercase;letter-spacing:1px;color:#6b7280">Expected Result</th>
              <th style="padding:6px 8px;background:#f9fafb;border:1px solid #e5e7eb;font-size:10px;font-family:monospace;text-transform:uppercase;letter-spacing:1px;color:#6b7280">Remarks</th>
              <th style="padding:6px 8px;background:#f9fafb;border:1px solid #e5e7eb;font-size:10px;font-family:monospace;text-transform:uppercase;letter-spacing:1px;color:#6b7280;width:70px">Status</th>
            </tr></thead>
            <tbody>${testRows}</tbody>
          </table>`
              : "<div style='padding:10px 14px;border:1px solid #e5e7eb;border-top:none;font-size:12px;color:#9ca3af;font-style:italic'>No steps</div>"
          }
        </div>`;
      })
      .join("");

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <title>TestPro Report — ${new Date().toLocaleDateString()}</title>
      <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;padding:32px;font-size:14px}
        h1{font-size:22px;font-weight:700;margin-bottom:6px}
        .summary{display:flex;gap:20px;font-size:12px;color:#6b7280;font-family:monospace;margin-bottom:28px;padding:10px 14px;background:#f9fafb;border-radius:6px;border:1px solid #e5e7eb}
        .summary span{font-weight:700;color:#111827}
        @page{margin:14mm}
        @media print{body{padding:0}}
      </style></head><body>
      <h1>Test Report</h1>
      <div class="summary">
        <div>Total Steps <span>${total}</span></div>
        <div>Passed <span style="color:#16a34a">${pass}</span></div>
        <div>Failed <span style="color:#dc2626">${fail}</span></div>
        <div>Pending <span style="color:#d97706">${
          total - pass - fail
        }</span></div>
        <div>Pass Rate <span>${
          total ? Math.round((pass / total) * 100) : 0
        }%</span></div>
        <div>Date <span>${new Date().toLocaleString()}</span></div>
      </div>
      ${modRows}
      </body></html>`;

    const w = window.open("", "_blank");
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => {
      w.print();
    }, 500);
    toast("PDF ready — use browser print dialog", "info");
  };

  return (
    <>
      <Topbar
        title="Test Report"
        sub={`${pass} passed · ${fail} failed · ${total - pass - fail} pending`}
      >
        {!isMobile && (
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Search modules…"
            width={190}
          />
        )}
        {!isMobile && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Toggle on={failOnly} onClick={() => setFailOnly((f) => !f)} />
            <span style={{ fontSize: 11, fontFamily: F.mono, color: C.t2, whiteSpace: "nowrap" }}>
              Failures only
            </span>
          </div>
        )}
        <ExportMenu onCSV={exportAllCSV} onPDF={exportAllPDF} />
      </Topbar>

      {/* Mobile-only filter bar */}
      {isMobile && (
        <div style={{
          padding: "10px 12px",
          background: C.s1,
          borderBottom: `1px solid ${C.b1}`,
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexShrink: 0,
        }}>
          <SearchBox value={search} onChange={setSearch} placeholder="Search modules…" width="100%" />
          <button
            onClick={() => setFailOnly((f) => !f)}
            style={{
              ...smBtn(failOnly ? { background: C.red, borderColor: "rgba(251,113,133,0.3)", color: C.re } : {}),
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            <Ico n="x" s={11} /> {failOnly ? "All" : "Failures"}
          </button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? "12px 12px" : 20 }}>

        {/* Summary stats */}
        {isMobile ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
            {[
              { label: "Total Steps", val: total.toLocaleString(), color: C.ac, bg: C.acd },
              { label: "Pass Rate", val: `${total ? Math.round((pass / total) * 100) : 0}%`, color: C.gr, bg: C.grd },
              { label: `Passed`, val: pass.toLocaleString(), color: C.gr, bg: C.grd },
              { label: `Failed`, val: fail.toLocaleString(), color: C.re, bg: C.red },
            ].map(({ label, val, color, bg }) => (
              <div key={label} style={{
                background: bg, borderRadius: 10, padding: "12px 14px",
                border: `1px solid ${color}22`,
              }}>
                <div style={{ fontSize: 11, fontFamily: F.mono, color, fontWeight: 600, marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 22, fontFamily: F.mono, fontWeight: 700, color }}>{val}</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            <Chip label={`${total.toLocaleString()} steps`} color={C.ac} bg={C.acd} />
            <Chip label={`✓ ${pass.toLocaleString()} passed (${total ? Math.round((pass / total) * 100) : 0}%)`} color={C.gr} bg={C.grd} />
            <Chip label={`✗ ${fail.toLocaleString()} failed (${total ? Math.round((fail / total) * 100) : 0}%)`} color={C.re} bg={C.red} />
            <Chip label={`⟳ ${(total - pass - fail).toLocaleString()} pending`} color={C.am} bg={C.amd} />
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <button style={smBtn()} onClick={() => setExp(new Set(modList.map((m) => m.id)))}>Expand All</button>
          <button style={smBtn()} onClick={() => setExp(new Set())}>Collapse All</button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 8 : 10 }}>
          {filtered.map((m) => {
            const pct = Math.round((m.pass / Math.max(m.total, 1)) * 100);
            const open = exp.has(m.id);
            const pendingM = m.total - m.pass - m.fail;
            return (
              <div key={m.id} style={{
                background: C.s1,
                border: `1px solid ${m.fail > 0 ? "rgba(251,113,133,0.3)" : m.pass === m.total && m.total > 0 ? "rgba(52,211,153,0.3)" : C.b1}`,
                borderRadius: 10,
                overflow: "hidden",
              }}>
                {/* Module header */}
                <div
                  onClick={() => { const s = new Set(exp); s.has(m.id) ? s.delete(m.id) : s.add(m.id); setExp(s); }}
                  style={{ padding: isMobile ? "12px 14px" : "11px 16px", cursor: "pointer" }}
                >
                  {/* Top line: chevron + name + pct */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Ico n={open ? "chevD" : "chevR"} s={13} />
                    <div style={{ fontSize: isMobile ? 14 : 13, fontWeight: 700, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {m.name}
                    </div>
                    <span style={{ fontSize: 12, fontFamily: F.mono, fontWeight: 700,
                      color: pct === 100 ? C.gr : m.fail > 0 ? C.re : C.t2, flexShrink: 0 }}>
                      {pct}%
                    </span>
                  </div>
                  {/* Second line: stats + mini bar */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, paddingLeft: 21 }}>
                    <span style={{ fontSize: 11, fontFamily: F.mono, color: C.t3 }}>
                      {m.tests.length}t · {m.total}s
                    </span>
                    {m.pass > 0 && <span style={{ fontSize: 10, fontFamily: F.mono, color: C.gr }}>✓{m.pass}</span>}
                    {m.fail > 0 && <span style={{ fontSize: 10, fontFamily: F.mono, color: C.re }}>✗{m.fail}</span>}
                    {pendingM > 0 && <span style={{ fontSize: 10, fontFamily: F.mono, color: C.am }}>⟳{pendingM}</span>}
                    <div style={{ flex: 1 }}>
                      <PBar pct={pct} fail={m.fail > 0} />
                    </div>
                  </div>
                </div>

                {open && (
                  <div style={{ borderTop: `1px solid ${C.b1}` }}>
                    {m.tests.map((t) => {
                      const tp = t.steps.filter((s) => s.status === "pass").length;
                      const tf = t.steps.filter((s) => s.status === "fail").length;
                      const tpct = Math.round((tp / Math.max(t.steps.length, 1)) * 100);
                      const tpending = t.steps.length - tp - tf;
                      return (
                        <div key={t.id}>
                          {/* Test sub-header */}
                          <div style={{
                            padding: isMobile ? "9px 14px 9px 22px" : "8px 16px 8px 28px",
                            background: C.s2,
                            borderBottom: `1px solid ${C.b1}`,
                          }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <Ico n="file" s={11} />
                              <span style={{ fontSize: 12, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {t.name}
                              </span>
                              <span style={{ fontSize: 11, fontFamily: F.mono, color: C.t3, flexShrink: 0 }}>
                                {tpct}%
                              </span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, paddingLeft: 19 }}>
                              <span style={{ fontSize: 10, fontFamily: F.mono, color: C.t3 }}>{t.steps.length} steps</span>
                              {tp > 0 && <span style={{ fontSize: 10, fontFamily: F.mono, color: C.gr }}>✓{tp}</span>}
                              {tf > 0 && <span style={{ fontSize: 10, fontFamily: F.mono, color: C.re }}>✗{tf}</span>}
                              {tpending > 0 && <span style={{ fontSize: 10, fontFamily: F.mono, color: C.am }}>⟳{tpending}</span>}
                              {t.description && !isMobile && (
                                <span style={{ fontSize: 11, color: C.t2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                                  {t.description}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Step rows */}
                          {t.steps.map((s) => {
                            const c = s.status === "pass" ? C.gr : s.status === "fail" ? C.re : C.am;
                            const bg2 = s.status === "pass" ? C.grd : s.status === "fail" ? C.red : C.amd;
                            const stepBg = s.status === "fail" ? "rgba(251,113,133,0.08)" : s.status === "pass" ? "rgba(52,211,153,0.05)" : "transparent";

                            if (isMobile) {
                              // Mobile: card layout per step
                              return (
                                <div key={s.id} style={{
                                  padding: "9px 14px 9px 22px",
                                  borderBottom: `1px solid ${C.b1}`,
                                  background: stepBg,
                                }}>
                                  {/* Top: serial + status */}
                                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: s.action ? 5 : 0 }}>
                                    <span style={{ fontFamily: F.mono, fontSize: 10, color: C.t3, flexShrink: 0, minWidth: 22 }}>
                                      {s.isDivider ? "" : `#${s.serialNo || "—"}`}
                                    </span>
                                    <span style={{
                                      display: "inline-flex", alignItems: "center",
                                      padding: "2px 8px", borderRadius: 12,
                                      fontSize: 10, fontFamily: F.mono, fontWeight: 700,
                                      background: bg2, color: c, flexShrink: 0,
                                    }}>
                                      {s.status.toUpperCase()}
                                    </span>
                                    {s.remarks ? (
                                      <span style={{ fontSize: 11, color: C.t3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, fontStyle: "italic" }}>
                                        {s.remarks}
                                      </span>
                                    ) : null}
                                  </div>
                                  {s.action && (
                                    <div style={{ fontSize: 12, color: C.t1, lineHeight: 1.5, wordBreak: "break-word" }}>
                                      {s.action}
                                    </div>
                                  )}
                                  {s.result && (
                                    <div style={{ fontSize: 11, color: C.t2, lineHeight: 1.4, marginTop: 3, paddingLeft: 8, borderLeft: `2px solid ${C.b2}`, wordBreak: "break-word" }}>
                                      {s.result}
                                    </div>
                                  )}
                                </div>
                              );
                            }

                            // Desktop: horizontal row
                            return (
                              <div key={s.id} style={{
                                padding: "7px 16px 7px 40px",
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                                borderBottom: `1px solid ${C.b1}`,
                                fontSize: 12,
                                background: stepBg,
                              }}>
                                <span style={{ fontFamily: F.mono, fontSize: 10, color: C.t3, width: 24, flexShrink: 0 }}>
                                  {s.serialNo}
                                </span>
                                <span style={{ flex: 1 }}>{s.action || <span style={{ color: C.t3 }}>—</span>}</span>
                                <span style={{ flex: 1, color: C.t2 }}>{s.result || <span style={{ color: C.t3 }}>—</span>}</span>
                                <span style={{ width: 100, fontSize: 11, color: C.t2 }}>{s.remarks}</span>
                                <span style={{
                                  display: "inline-flex", alignItems: "center",
                                  padding: "2px 8px", borderRadius: 12,
                                  fontSize: 10, fontFamily: F.mono,
                                  background: bg2, color: c, flexShrink: 0,
                                }}>
                                  {s.status}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ textAlign: "center", padding: "48px 0", color: C.t3, fontFamily: F.mono, fontSize: 12 }}>
              No modules match.
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Audit Log ──────────────────────────────────────────────────────────────────
function AuditView({ log }) {
  const isMobile = useIsMobile();
  const fmt = (ts) =>
    new Date(ts).toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  const dotColor = { pass: C.gr, fail: C.re, warn: C.am, info: C.ac };
  return (
    <>
      <Topbar title="Audit Log" sub={`${log.length} events recorded`} />
      <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? "10px 12px" : "12px 20px" }}>
        <div
          style={{
            background: C.s1,
            border: `1px solid ${C.b1}`,
            borderRadius: 10,
            overflow: "hidden",
          }}
        >
          {log.length === 0 && (
            <div
              style={{
                padding: 40,
                textAlign: "center",
                color: C.t3,
                fontFamily: F.mono,
                fontSize: 12,
              }}
            >
              No events yet.
            </div>
          )}
          {log.map((e, i) => (
            <div
              key={i}
              style={{
                padding: "10px 16px",
                borderBottom: `1px solid ${C.b1}`,
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                fontSize: 12,
              }}
            >
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: dotColor[e.type] || C.t3,
                  flexShrink: 0,
                  marginTop: 4,
                }}
              />
              <div style={{ flex: 1 }}>
                <div>{e.action}</div>
                <div
                  style={{
                    fontSize: 11,
                    color: C.t3,
                    fontFamily: F.mono,
                    marginTop: 2,
                  }}
                >
                  {e.user}
                </div>
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: C.t3,
                  fontFamily: F.mono,
                  flexShrink: 0,
                }}
              >
                {fmt(e.ts)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ── Users Panel ────────────────────────────────────────────────────────────────
function UsersPanel({ users, session, saveUsers, addLog, toast }) {
  const isMobile = useIsMobile();
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({
    name: "",
    username: "",
    email: "",
    password: "",
    role: "tester",
    active: true,
  });
  const [search, setSearch] = useState("");
  const [confirm, setConfirm] = useState(null);

  const filtered = users.filter(
    (u) =>
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.username.toLowerCase().includes(search.toLowerCase()) ||
      (u.email || "").toLowerCase().includes(search.toLowerCase())
  );
  const openAdd = () => {
    setForm({
      name: "",
      username: "",
      email: "",
      password: "",
      role: "tester",
      active: true,
    });
    setModal("add");
  };
  const openEdit = (u) => {
    setForm({ ...u });
    setModal(u);
  };

  const save = () => {
    if (!form.name.trim() || !form.username.trim() || !form.password.trim()) {
      toast("Name, username & password required", "error");
      return;
    }
    if (
      modal === "add" &&
      users.find((u) => u.username === form.username.trim())
    ) {
      toast("Username already exists", "error");
      return;
    }
    const updated =
      modal === "add"
        ? [...users, { ...form, id: `new_${Date.now()}` }]  // temp id — replaced by Supabase UUID in saveUsers
        : users.map((u) => (u.id === form.id ? { ...form } : u));
    saveUsers(updated);
    setModal(null);
    toast(
      modal === "add"
        ? `User "${form.name}" created`
        : `"${form.name}" updated`,
      "success"
    );
    addLog({
      ts: Date.now(),
      user: session.name,
      action:
        modal === "add"
          ? `Created user "${form.name}" (${form.role})`
          : `Updated user "${form.name}"`,
      type: "info",
    });
  };

  const del = (u) => {
    saveUsers(users.filter((x) => x.id !== u.id));
    toast(`"${u.name}" deleted`, "info");
    setConfirm(null);
    addLog({
      ts: Date.now(),
      user: session.name,
      action: `Deleted user "${u.name}"`,
      type: "info",
    });
  };
  const toggle = (u) => {
    if (u.id === session.id) return;
    saveUsers(
      users.map((x) => (x.id === u.id ? { ...x, active: !x.active } : x))
    );
    toast(`${u.name} ${u.active ? "deactivated" : "activated"}`, "info");
    addLog({
      ts: Date.now(),
      user: session.name,
      action: `${u.active ? "Deactivated" : "Activated"} "${u.name}"`,
      type: "info",
    });
  };

  return (
    <>
      <Topbar
        title="User Management"
        sub={`${users.length} users · ${
          users.filter((u) => u.active).length
        } active`}
      >
        {!isMobile && (
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Search users…"
            width={190}
          />
        )}
        <button style={acBtn(smBtn())} onClick={openAdd}>
          <Ico n="plus" s={13} /> {isMobile ? "" : "Add User"}
        </button>
      </Topbar>
      {isMobile && (
        <div style={{ padding: "10px 12px", background: C.s1, borderBottom: `1px solid ${C.b1}`, flexShrink: 0 }}>
          <SearchBox value={search} onChange={setSearch} placeholder="Search users…" width="100%" />
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? 12 : 20 }}>
        <div style={{ display: "grid", gap: isMobile ? 8 : 10 }}>
          {filtered.map((u) => (
            <div
              key={u.id}
              style={{
                background: C.s1,
                border: `1px solid ${C.b1}`,
                borderRadius: 10,
                padding: isMobile ? "12px 14px" : "14px 18px",
                display: "flex",
                alignItems: isMobile ? "flex-start" : "center",
                gap: isMobile ? 10 : 14,
                flexDirection: isMobile ? "column" : "row",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 10 : 14, width: "100%" }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  flexShrink: 0,
                  background: "linear-gradient(135deg,#dbeafe,#bfdbfe)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: F.mono,
                  fontSize: 13,
                  fontWeight: 700,
                  color: C.ac,
                  border: `1px solid ${C.b1}`,
                }}
              >
                {u.name[0].toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name}</div>
                <div
                  style={{
                    fontSize: 11,
                    color: C.t2,
                    fontFamily: F.mono,
                    marginTop: 2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {u.username}
                  {u.email ? ` · ${u.email}` : ""}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                  <Badge type={u.role} />
                  <Badge type={u.active ? "active" : "inactive"} />
                  {u.id === session.id && (
                    <span
                      style={{
                        fontSize: 10,
                        fontFamily: F.mono,
                        background: C.acd,
                        color: C.ac,
                        padding: "2px 9px",
                        borderRadius: 20,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        border: `1px solid ${C.b2}`,
                      }}
                    >
                      You
                    </span>
                  )}
                </div>
              </div>
              {!isMobile && (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {u.id !== session.id && (
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <Toggle on={u.active} onClick={() => toggle(u)} />
                    <span
                      style={{ fontSize: 10, fontFamily: F.mono, color: C.t2 }}
                    >
                      {u.active ? "Active" : "Off"}
                    </span>
                  </div>
                )}
                <button style={smBtn()} onClick={() => openEdit(u)}>
                  <Ico n="edit" s={12} /> Edit
                </button>
                {u.id !== session.id && (
                  <button style={reBtn(smBtn())} onClick={() => setConfirm(u)}>
                    <Ico n="trash" s={12} />
                  </button>
                )}
              </div>
              )}
              </div>
              {isMobile && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                {u.id !== session.id && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
                    <Toggle on={u.active} onClick={() => toggle(u)} />
                    <span style={{ fontSize: 10, fontFamily: F.mono, color: C.t2 }}>
                      {u.active ? "Active" : "Off"}
                    </span>
                  </div>
                )}
                <button style={smBtn({ flex: u.id !== session.id ? "none" : 1, justifyContent: "center" })} onClick={() => openEdit(u)}>
                  <Ico n="edit" s={12} /> Edit
                </button>
                {u.id !== session.id && (
                  <button style={reBtn(smBtn())} onClick={() => setConfirm(u)}>
                    <Ico n="trash" s={12} />
                  </button>
                )}
              </div>
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <div
              style={{
                textAlign: "center",
                padding: 40,
                color: C.t3,
                fontFamily: F.mono,
                fontSize: 12,
              }}
            >
              No users found.
            </div>
          )}
        </div>
      </div>

      {modal && (
        <Modal
          title={modal === "add" ? "Add User" : "Edit User"}
          sub={
            modal === "add" ? "Create a new account" : `Editing ${form.name}`
          }
          onClose={() => setModal(null)}
        >
          <Field label="Full Name">
            <input
              style={inputSty}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              autoFocus
            />
          </Field>
          <Field label="Username">
            <input
              style={inputSty}
              value={form.username}
              onChange={(e) =>
                setForm((f) => ({ ...f, username: e.target.value }))
              }
            />
          </Field>
          <Field label="Email (optional)">
            <input
              style={inputSty}
              value={form.email}
              onChange={(e) =>
                setForm((f) => ({ ...f, email: e.target.value }))
              }
            />
          </Field>
          <Field label="Password">
            <input
              style={inputSty}
              type="password"
              value={form.password}
              onChange={(e) =>
                setForm((f) => ({ ...f, password: e.target.value }))
              }
            />
          </Field>
          <Field label="Role">
            <select
              style={{ ...inputSty, appearance: "none" }}
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
            >
              <option value="tester">Tester</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          <ModalActions>
            <button style={btn()} onClick={() => setModal(null)}>
              Cancel
            </button>
            <button style={acBtn()} onClick={save}>
              {modal === "add" ? "Create User" : "Save Changes"}
            </button>
          </ModalActions>
        </Modal>
      )}
      {confirm && (
        <Modal
          title="Delete User?"
          sub={`Delete "${confirm.name}"? This cannot be undone.`}
          onClose={() => setConfirm(null)}
          width={360}
        >
          <ModalActions>
            <button style={btn()} onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button style={reBtn()} onClick={() => del(confirm)}>
              <Ico n="trash" s={12} /> Delete
            </button>
          </ModalActions>
        </Modal>
      )}
    </>
  );
}

// ── Root ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [users, setUsers] = useState(null);
  const [modules, setModules] = useState(null);
  const [log, setLog] = useState([]);
  const [session, setSession] = useState(null);
  const [view, setView] = useState("dash");
  const [selMod, setSelMod] = useState(null);
  const [sideColl, setSideColl] = useState(false);
  const [hasLock, setHasLock] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const isMobile = useIsMobile();
  const { push: toast, Host: ToastHost } = useToast();

  useEffect(() => {
    (async () => {
      const { users: dbUsers, modules: dbModules } = await store.loadAll();
      const log = await store.loadLog();

      // ── Users: seed DB if empty ──────────────────────────────────────────
      let finalUsers = dbUsers;
      if (!dbUsers.length) {
        // Insert seed users and reload so we get real UUIDs back
        const { data: inserted, error: seedErr } = await supabase
          .from("users")
          .insert(SEED_USERS.map(({ id: _skip, ...rest }) => rest))
          .select();
        if (seedErr) {
          console.error("Seed users error:", seedErr);
          toast(`DB connection error: ${seedErr.message}`, "error");
          finalUsers = SEED_USERS; // fall back to local only
        } else {
          finalUsers = inserted || SEED_USERS;
        }
      }

      // ── Modules: seed DB if empty ────────────────────────────────────────
      let finalModules = dbModules;
      if (!Object.keys(dbModules).length) {
        const seedModules = buildModules();
        finalModules = seedModules;
        // Save seed modules to DB in background (don't block render)
        store.saveModules(seedModules).catch((e) =>
          console.error("Seed modules error:", e)
        );
      }

      setUsers(finalUsers);
      setModules(finalModules);
      setLog(log);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveUsers = useCallback(async (u) => {
    setUsers(u);
    await store.saveUsers(u);
    // Reload from Supabase so new users get their real UUID (replaces temp new_XXXX id)
    const { data: fresh } = await supabase.from("users").select("*");
    if (fresh && fresh.length) setUsers(fresh);
  }, []);

  // Always keep a ref to the latest modules so the debounced DB write
  // never uses a stale snapshot captured in an old closure.
  const latestModulesRef   = useRef(null);
  const saveModsTimerRef   = useRef(null);
  const structuralFlagRef  = useRef(false); // true when a structural change needs saveModules

  // saveMods(m)             — step-only change: update React state, skip saveModules
  // saveMods(m, true)       — structural change (add/rename/delete module or test):
  //                           update React state AND debounce saveModules
  const saveMods = useCallback((m, structural = false) => {
    setModules(m);
    latestModulesRef.current = m;
    if (structural) structuralFlagRef.current = true; // latch: once set, stays true until timer fires

    // Only schedule a saveModules call when there is a structural change pending.
    // Step saves are handled surgically by saveSteps in commit().
    if (!structuralFlagRef.current) return;

    if (saveModsTimerRef.current) clearTimeout(saveModsTimerRef.current);
    saveModsTimerRef.current = setTimeout(() => {
      structuralFlagRef.current = false;
      store.saveModules(latestModulesRef.current); // use ref, never stale closure
    }, 400);
  }, []);

  const addLog = useCallback(async (e) => {
    setLog((l) => [e, ...l].slice(0, 300));
    await store.addLog(e);
  }, []);

  // ── Supabase Realtime: live progress for all users ────────────────────────────
  // Subscribes to INSERT/UPDATE/DELETE on steps, tests, and modules tables.
  // All derived stats (progress bars, pass/fail counts, dashboard) update
  // automatically because they read from `modules` state.
  //
  // Setup required (once in Supabase dashboard):
  //   1. Go to Database → Replication → Tables
  //   2. Enable Realtime for: steps, tests, modules
  //   OR run in SQL editor:
  //      ALTER PUBLICATION supabase_realtime ADD TABLE steps, tests, modules;
  //
  useEffect(() => {
    // Don't subscribe until initial load is done
    if (!modules) return;

    // Use a unique suffix so Supabase never gets duplicate channel names
    // if this effect fires more than once (e.g. in StrictMode double-invoke)
    const uid = Date.now();

    // ── steps changes ─────────────────────────────────────────────────────────
    const stepsSub = supabase
      .channel(`rt-steps-${uid}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "steps" },
        (payload) => {
          const { eventType, new: row, old: oldRow } = payload;
          // Always use functional updater — never close over `modules` directly
          setModules((prev) => {
            if (!prev) return prev;
            const next = { ...prev };

            if (eventType === "UPDATE") {
              for (const modId in next) {
                const mod = next[modId];
                const testIdx = mod.tests.findIndex((t) => t.id === row.test_id);
                if (testIdx === -1) continue;
                const test = mod.tests[testIdx];
                const stepIdx = test.steps.findIndex((s) => s.id === row.id);
                if (stepIdx === -1) continue;
                const updatedSteps = [...test.steps];
                updatedSteps[stepIdx] = {
                  ...updatedSteps[stepIdx],
                  status:    row.status,
                  remarks:   row.remarks,
                  action:    row.action,
                  result:    row.result,
                  serialNo:  row.serial_no,
                  isDivider: row.is_divider ?? false,
                };
                const updatedTests = [...mod.tests];
                updatedTests[testIdx] = { ...test, steps: updatedSteps };
                next[modId] = { ...mod, tests: updatedTests };
                break;
              }
            }

            if (eventType === "INSERT") {
              for (const modId in next) {
                const mod = next[modId];
                const testIdx = mod.tests.findIndex((t) => t.id === row.test_id);
                if (testIdx === -1) continue;
                const test = mod.tests[testIdx];
                if (test.steps.some((s) => s.id === row.id)) break; // already local
                const updatedTests = [...mod.tests];
                const normRow = { ...row, serialNo: row.serial_no, isDivider: row.is_divider ?? false };
                updatedTests[testIdx] = {
                  ...test,
                  steps: [...test.steps, normRow].sort(
                    (a, b) => (a.serialNo ?? 0) - (b.serialNo ?? 0)
                  ),
                };
                next[modId] = { ...mod, tests: updatedTests };
                break;
              }
            }

            if (eventType === "DELETE") {
              const deletedId = oldRow?.id;
              if (!deletedId) return prev;
              for (const modId in next) {
                const mod = next[modId];
                let changed = false;
                const updatedTests = mod.tests.map((t) => {
                  if (!t.steps.some((s) => s.id === deletedId)) return t;
                  changed = true;
                  return { ...t, steps: t.steps.filter((s) => s.id !== deletedId) };
                });
                if (changed) { next[modId] = { ...mod, tests: updatedTests }; break; }
              }
            }

            return next;
          });
        }
      )
      .subscribe();

    // ── tests changes ─────────────────────────────────────────────────────────
    const testsSub = supabase
      .channel(`rt-tests-${uid}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tests" },
        (payload) => {
          const { eventType, new: row, old: oldRow } = payload;
          setModules((prev) => {
            if (!prev) return prev;
            const next = { ...prev };

            if (eventType === "UPDATE") {
              const mod = next[row.module_id];
              if (!mod) return prev;
              next[row.module_id] = {
                ...mod,
                tests: mod.tests.map((t) =>
                  t.id === row.id
                    ? {
                        ...t,
                        name:        row.name,
                        description: row.description,
                        serial_no:   row.serial_no,
                        serialNo:    row.serial_no, // keep camelCase in sync
                      }
                    : t
                ),
              };
            }

            if (eventType === "INSERT") {
              const mod = next[row.module_id];
              if (!mod) return prev;
              if (mod.tests.some((t) => t.id === row.id)) return prev;
              const normTest = {
                ...row,
                serialNo: row.serial_no, // normalise for local usage
                steps: [],
              };
              next[row.module_id] = {
                ...mod,
                tests: [...mod.tests, normTest].sort(
                  (a, b) => (a.serial_no ?? 0) - (b.serial_no ?? 0)
                ),
              };
            }

            if (eventType === "DELETE") {
              for (const modId in next) {
                const mod = next[modId];
                if (!mod.tests.some((t) => t.id === oldRow?.id)) continue;
                next[modId] = { ...mod, tests: mod.tests.filter((t) => t.id !== oldRow.id) };
                break;
              }
            }

            return next;
          });
        }
      )
      .subscribe();

    // ── modules changes ───────────────────────────────────────────────────────
    const modulesSub = supabase
      .channel(`rt-modules-${uid}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "modules" },
        (payload) => {
          const { eventType, new: row, old: oldRow } = payload;
          setModules((prev) => {
            if (!prev) return prev;
            const next = { ...prev };

            if (eventType === "UPDATE") {
              if (!next[row.id]) return prev;
              next[row.id] = { ...next[row.id], name: row.name, position: row.position };
            }

            if (eventType === "INSERT") {
              if (next[row.id]) return prev;
              next[row.id] = { ...row, tests: [] };
            }

            if (eventType === "DELETE") {
              if (!next[oldRow?.id]) return prev;
              const n2 = { ...next };
              delete n2[oldRow.id];
              return n2;
            }

            return next;
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(stepsSub);
      supabase.removeChannel(testsSub);
      supabase.removeChannel(modulesSub);
    };
  // Run once after initial data load — `!!modules` flips false→true exactly once
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!modules]);

  // ── Session validity: if logged-in user gets deactivated/deleted, auto-logout ──
  useEffect(() => {
    if (!session || !users) return;
    if (session.role === "admin") return; // admin cannot be locked out this way
    const currentUser = users.find((u) => u.id === session.id);
    if (!currentUser || !currentUser.active) {
      lockStore.releaseAll(session.id);
      setSession(null);
      setView("dash");
      setSelMod(null);
      setHasLock(false);
    }
  }, [users, session]);

  const handleLogout = useCallback((u) => {
    // Clear session immediately (synchronous) so UI responds instantly
    setSession(null);
    setView("dash");
    setSelMod(null);
    setHasLock(false);
    // Release locks in background only for testers
    if (u && u.role !== "admin") lockStore.releaseAll(u.id);
  }, []);

  // Global beforeunload: release all locks if tester closes the window from
  // anywhere in the app (not just from inside a test). This covers Dashboard,
  // Report, and other views where ModuleView's own handler is not mounted.
  useEffect(() => {
    if (!session || session.role === "admin") return;
    const onUnload = () => lockStore.releaseAll(session.id);
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [session]);

  if (!users || !modules)
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: C.s1,
          color: C.ac,
          fontFamily: F.mono,
          fontSize: 13,
        }}
      >
        Loading TestPro…
      </div>
    );

  if (!session)
    return (
      <LoginPage
        users={users}
        onLogin={(u) => {
          setSession(u);
          addLog({
            ts: Date.now(),
            user: u.name,
            action: "Logged in",
            type: "info",
          });
        }}
      />
    );

  const modKeys = Object.keys(modules);
  const modIdx = selMod ? modKeys.indexOf(selMod) : -1;

  // Mobile bottom nav items
  const mobileNavItems = [
    { id: "dash", icon: "dash", label: "Dashboard" },
    { id: "report", icon: "report", label: "Report" },
    ...(session.role === "admin" ? [
      { id: "users", icon: "users", label: "Users" },
      { id: "audit", icon: "log", label: "Audit" },
    ] : []),
    { id: "_modules", icon: "layers", label: "Modules" },
  ];

  return (
    <MobileMenuCtx.Provider value={() => setMobileDrawerOpen(true)}>
    <div
      style={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        background: C.s1,
        color: C.t1,
        fontFamily: F.sans,
        fontSize: 14,
        lineHeight: 1.5,
      }}
    >
      <style>{`*{box-sizing:border-box;margin:0;padding:0}body{font-family:${F.sans};-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#d1d5db;border-radius:6px}::-webkit-scrollbar-thumb:hover{background:#9ca3af}textarea{font-family:${F.sans}}input,select,textarea{-webkit-font-smoothing:antialiased}button{-webkit-tap-highlight-color:transparent;touch-action:manipulation}a{-webkit-tap-highlight-color:transparent}@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      {/* Desktop sidebar — hidden on mobile (drawer handles it) */}
      {!isMobile && (
        <Sidebar
          session={session}
          view={view}
          setView={setView}
          modules={modules}
          selMod={selMod}
          setSelMod={(id) => {
            if (session.role !== "admin" && hasLock && !(selMod === id && view === "mod")) {
              toast("Finish the current test first", "error");
              return;
            }
            setSelMod(id);
            setView("mod");
          }}
          collapsed={sideColl}
          setCollapsed={setSideColl}
          locked={session.role !== "admin" && hasLock}
          onLogout={() => {
            addLog({ ts: Date.now(), user: session.name, action: "Logged out", type: "info" });
            handleLogout(session);
          }}
        />
      )}
      {/* Mobile drawer sidebar */}
      {isMobile && (
        <Sidebar
          session={session}
          view={view}
          setView={(v) => { setView(v); setMobileDrawerOpen(false); }}
          modules={modules}
          selMod={selMod}
          setSelMod={(id) => {
            if (session.role !== "admin" && hasLock && !(selMod === id && view === "mod")) {
              toast("Finish the current test first", "error");
              return;
            }
            setSelMod(id);
            setView("mod");
            setMobileDrawerOpen(false);
          }}
          collapsed={false}
          setCollapsed={() => {}}
          locked={session.role !== "admin" && hasLock}
          mobileOpen={mobileDrawerOpen}
          onMobileClose={() => setMobileDrawerOpen(false)}
          onLogout={() => {
            addLog({ ts: Date.now(), user: session.name, action: "Logged out", type: "info" });
            handleLogout(session);
          }}
        />
      )}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          minWidth: 0,
          // On mobile, add bottom padding for the nav bar
          paddingBottom: isMobile ? "calc(58px + env(safe-area-inset-bottom, 0px))" : 0,
        }}
      >
        {view === "dash" && (
          <Dashboard
            modules={modules}
            session={session}
            onSelect={(id) => {
              if (session.role !== "admin" && hasLock) {
                toast("Finish the current test first", "error");
                return;
              }
              setSelMod(id);
              setView("mod");
            }}
            saveMods={saveMods}
            addLog={addLog}
            toast={toast}
          />
        )}
        {view === "mod" && selMod && modules[selMod] && (
          <ModuleView
            key={selMod}
            mod={modules[selMod]}
            allModules={modules}
            session={session}
            saveMods={saveMods}
            addLog={addLog}
            toast={toast}
            onLockChange={(locked) => setHasLock(locked)}
            onNav={(dir) => {
              if (hasLock) return;
              const nk = modKeys[modIdx + dir];
              if (nk) setSelMod(nk);
            }}
            modIdx={modIdx}
            modTotal={modKeys.length}
          />
        )}
        {view === "report" && <ReportView modules={modules} toast={toast} />}
        {view === "users" && session.role === "admin" && (
          <UsersPanel
            users={users}
            session={session}
            saveUsers={saveUsers}
            addLog={addLog}
            toast={toast}
          />
        )}
        {view === "audit" && session.role === "admin" && (
          <AuditView log={log} />
        )}
      </div>
      {/* Mobile bottom navigation bar */}
      {isMobile && (
        <div
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            background: "rgba(7,11,18,0.92)",
            backdropFilter: "blur(18px)",
            WebkitBackdropFilter: "blur(18px)",
            borderTop: `1px solid rgba(221,226,234,0.6)`,
            display: "flex",
            alignItems: "stretch",
            zIndex: 200,
            boxShadow: "0 -2px 20px rgba(0,0,0,.07)",
            paddingBottom: "env(safe-area-inset-bottom, 0px)",
          }}
        >
          {mobileNavItems.map(({ id, icon, label }) => {
            const isActive = id === "_modules"
              ? view === "mod"
              : view === id;
            return (
              <button
                key={id}
                onClick={() => {
                  if (id === "_modules") {
                    setMobileDrawerOpen(true);
                  } else {
                    if (session.role !== "admin" && hasLock && id !== view) {
                      toast("Finish the current test first", "error");
                      return;
                    }
                    setView(id);
                  }
                }}
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 4,
                  border: "none",
                  borderTop: `2px solid ${isActive ? C.ac : "transparent"}`,
                  background: isActive ? "rgba(56,189,248,0.1)" : "transparent",
                  color: isActive ? C.ac : C.t3,
                  fontFamily: F.sans,
                  fontSize: 10,
                  fontWeight: isActive ? 700 : 400,
                  cursor: "pointer",
                  padding: "10px 0 8px",
                  minHeight: 58,
                  transition: "background .15s, color .15s",
                }}
              >
                <Ico n={icon} s={20} />
                {label}
              </button>
            );
          })}
          {/* Logout at end of bottom nav */}
          <button
            onClick={() => {
              addLog({ ts: Date.now(), user: session.name, action: "Logged out", type: "info" });
              handleLogout(session);
            }}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              border: "none",
              borderTop: "2px solid transparent",
              borderLeft: `1px solid ${C.b1}`,
              background: "transparent",
              color: C.re,
              fontFamily: F.sans,
              fontSize: 10,
              fontWeight: 400,
              cursor: "pointer",
              padding: "10px 0 8px",
              minHeight: 58,
            }}
          >
            <Ico n="logout" s={20} />
            Logout
          </button>
        </div>
      )}
      <ToastHost />
    </div>
    </MobileMenuCtx.Provider>
  );
}
