import { supabase } from "./supabase";
import React, { useState, useEffect, useRef, useCallback, useMemo, useContext } from "react";

// ── Storage ────────────────────────────────────────────────────────────────────

const store = {
  async loadAll() {
    try {
      const [
        { data: users },
        { data: modules },
        { data: tests },
        { data: steps },
      ] = await Promise.all([
        supabase.from("users").select("*").limit(10_000),
        supabase.from("modules").select("*").order("position").limit(10_000),
        supabase.from("tests").select("*").order("serial_no").limit(100_000),
        supabase.from("steps").select("*").order("position").limit(10_000_000),
      ]);

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
      return { users: SEED_USERS, modules: buildModules() };
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
      // Fetch all existing user IDs, delete any not in our live set
      const { data: existing } = await supabase.from("users").select("id");
      const liveSet = new Set(liveUUIDs);
      const stale = (existing || []).map(r => r.id).filter(id => !liveSet.has(id));
      for (let i = 0; i < stale.length; i += 500) {
        await supabase.from("users").delete().in("id", stale.slice(i, i + 500));
      }
    } else if (!toInsert.length) {
      // No live users at all — wipe the table
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

    // ── Delete removed rows BEFORE upserting ────────────────────────────────
    // Steps first (FK child), then tests (FK parent).
    // For large step counts the .not("id","in","(...)") string exceeds URL limits.
    // Strategy: fetch all existing IDs for live tests, then delete any not in
    // the current live set using chunked .in() calls instead of .not().

    const CHUNK = 500;

    // Helper: delete rows whose id IS in a list, in chunks
    const deleteInChunks = async (table, ids) => {
      for (let i = 0; i < ids.length; i += CHUNK) {
        await supabase.from(table).delete().in("id", ids.slice(i, i + CHUNK));
      }
    };

    // 0 & 1. For steps: fetch existing step IDs under live tests, find stale ones, delete
    if (liveTestIds.length) {
      // Fetch in chunks to avoid URL-length issues on the IN filter too
      const existingStepIds = [];
      for (let i = 0; i < liveTestIds.length; i += CHUNK) {
        const { data } = await supabase
          .from("steps")
          .select("id")
          .in("test_id", liveTestIds.slice(i, i + CHUNK))
          .limit(1_000_000);
        if (data) existingStepIds.push(...data.map((r) => r.id));
      }
      const liveStepSet = new Set(liveStepIds);
      const staleStepIds = existingStepIds.filter((id) => !liveStepSet.has(id));
      if (staleStepIds.length) await deleteInChunks("steps", staleStepIds);
    }

    // 2. For tests: fetch existing test IDs under live modules, find stale ones, delete
    if (liveModuleIds.length) {
      const existingTestIds = [];
      for (let i = 0; i < liveModuleIds.length; i += CHUNK) {
        const { data } = await supabase
          .from("tests")
          .select("id")
          .in("module_id", liveModuleIds.slice(i, i + CHUNK));
        if (data) existingTestIds.push(...data.map((r) => r.id));
      }
      const liveTestSet = new Set(liveTestIds);
      const staleTestIds = existingTestIds.filter((id) => !liveTestSet.has(id));
      if (staleTestIds.length) await deleteInChunks("tests", staleTestIds);
    }

    // 3. Delete module rows that no longer exist in local state
    if (liveModuleIds.length) {
      const { data: existingMods } = await supabase.from("modules").select("id");
      const liveModSet = new Set(liveModuleIds);
      const staleMods = (existingMods || []).map((r) => r.id).filter((id) => !liveModSet.has(id));
      if (staleMods.length) await deleteInChunks("modules", staleMods);
    }

    // ── Upsert surviving rows ────────────────────────────────────────────────
    const { error: modErr } = await supabase
      .from("modules")
      .upsert(modules.map(({ id, name }, i) => ({ id, name, position: i })), { onConflict: "id" });
    if (modErr) { console.error("Upsert modules error", modErr); return; }

    if (allTests.length) {
      const testRows = allTests.map((t) => ({
        id:          t.id,
        module_id:   t.module_id,
        serial_no:   t.serial_no ?? t.serialNo ?? 0,
        name:        t.name,
        description: t.description ?? "",
      }));
      for (let i = 0; i < testRows.length; i += CHUNK) {
        const { error: testErr } = await supabase
          .from("tests")
          .upsert(testRows.slice(i, i + CHUNK), { onConflict: "id" });
        if (testErr) { console.error("Upsert tests error", testErr); return; }
      }
    }

    if (allSteps.length) {
      // Track per-test position counters so each step gets its correct array
      // index within its own test. This is stored in `position` and used for
      // DB ordering on reload — keeps dividers in their correct slots.
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
      // Chunk into batches of 500 so any number of steps persists correctly.
      for (let i = 0; i < stepsWithPosition.length; i += CHUNK) {
        const chunk = stepsWithPosition.slice(i, i + CHUNK);
        const { error: stepErr } = await supabase
          .from("steps")
          .upsert(chunk, { onConflict: "id" });
        if (stepErr) { console.error("Upsert steps error", stepErr); break; }
      }
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

// ── CSV parse helper ───────────────────────────────────────────────────────────
function csvParse(line) {
  const cols = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } // escaped quote ""
      else q = !q;
    } else if (c === "," && !q) {
      cols.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cols.push(cur.trim());
  return cols;
}

// ── Design Tokens — Light Mode ─────────────────────────────────────────────────
const C = {
  bg: "#f0f2f5",
  s1: "#ffffff",
  s2: "#f6f8fa",
  s3: "#edf0f4",
  b1: "#dde2ea",
  b2: "#c8d0db",
  ac: "#0070f3",
  gr: "#16a34a",
  re: "#dc2626",
  am: "#d97706",
  t1: "#111827",
  t2: "#4b5563",
  t3: "#9ca3af",
  grd: "rgba(22,163,74,0.10)",
  red: "rgba(220,38,38,0.10)",
  amd: "rgba(217,119,6,0.10)",
};

// ── Style Helpers ──────────────────────────────────────────────────────────────
const F = {
  sans: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
  mono: "'SF Mono','Fira Code','Fira Mono',monospace",
};
// ── Mobile detection ───────────────────────────────────────────────────────────
function useIsMobile(breakpoint = 768) {
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" && window.innerWidth < breakpoint
  );
  useEffect(() => {
    const handler = () => setMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [breakpoint]);
  return mobile;
}

// ── Mobile menu context — avoids prop-drilling onMenuClick to every Topbar ──────
const MobileMenuCtx = React.createContext(null);

const btn = (x = {}) => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "6px 13px",
  borderRadius: 7,
  border: `1px solid ${C.b2}`,
  background: C.s1,
  color: C.t2,
  fontFamily: F.sans,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
  lineHeight: 1,
  ...x,
});
const acBtn = (x = {}) =>
  btn({ background: "#eff6ff", borderColor: "#bfdbfe", color: C.ac, ...x });
const grBtn = (x = {}) =>
  btn({ background: C.grd, borderColor: "#bbf7d0", color: C.gr, ...x });
const reBtn = (x = {}) =>
  btn({ background: C.red, borderColor: "#fecaca", color: C.re, ...x });
const amBtn = (x = {}) =>
  btn({ background: C.amd, borderColor: "#fde68a", color: C.am, ...x });
const smBtn = (x = {}) => btn({ padding: "4px 10px", fontSize: 11, ...x });
const iBtn = (x = {}) =>
  btn({
    padding: "5px 7px",
    border: "none",
    background: "transparent",
    color: C.t3,
    ...x,
  });

// ── Icons ──────────────────────────────────────────────────────────────────────
const PATHS = {
  check: [["M20 6 9 17 4 12"]],
  x: [["M18 6 6 18"], ["M6 6l12 12"]],
  upload: [
    ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"],
    ["M17 8l-5-5-5 5"],
    ["M12 3v12"],
  ],
  logout: [
    ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"],
    ["M16 17l5-5-5-5"],
    ["M21 12H9"],
  ],
  grid: [
    ["M3 3h7v7H3z"],
    ["M14 3h7v7h-7z"],
    ["M14 14h7v7h-7z"],
    ["M3 14h7v7H3z"],
  ],
  edit: [
    ["M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"],
    ["M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"],
  ],
  trash: [
    ["M3 6h18"],
    ["M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"],
    ["M10 6V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2"],
  ],
  plus: [["M12 5v14"], ["M5 12h14"]],
  search: [["M21 21l-4.35-4.35"], ["M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"]],
  dash: [["M22 12h-4l-3 9L9 3l-3 9H2"]],
  report: [
    ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"],
    ["M14 2v6h6"],
    ["M16 13H8"],
    ["M16 17H8"],
  ],
  users: [
    ["M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"],
    ["M9 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0"],
    ["M23 21v-2a4 4 0 0 0-3-3.87"],
    ["M16 3.13a4 4 0 0 1 0 7.75"],
  ],
  log: [
    [
      "M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z",
    ],
    ["M22 6l-10 7L2 6"],
  ],
  chevR: [["M9 18l6-6-6-6"]],
  chevD: [["M6 9l6 6 6-6"]],
  chevL: [["M15 18l-6-6 6-6"]],
  reset: [["M1 4v6h6"], ["M3.51 15a9 9 0 1 0 .49-3.2"]],
  down: [
    ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"],
    ["M7 10l5 5 5-5"],
    ["M12 15V3"],
  ],
  bell: [
    ["M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"],
    ["M13.73 21a2 2 0 0 1-3.46 0"],
  ],
  lock: [
    [
      "M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2z",
    ],
    ["M7 11V7a5 5 0 0 1 10 0v4"],
  ],
  layers: [
    ["M12 2 2 7l10 5 10-5-10-5z"],
    ["M2 17l10 5 10-5"],
    ["M2 12l10 5 10-5"],
  ],
  file: [
    ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"],
    ["M14 2v6h6"],
  ],
  back: [["M19 12H5"], ["M12 5l-7 7 7 7"]],
};

function Ico({ n, s = 15 }) {
  const paths = PATHS[n] || [["M0 0"]];
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      {paths.map((d, i) => (
        <path key={i} d={d[0]} />
      ))}
    </svg>
  );
}

// ── Shared UI ──────────────────────────────────────────────────────────────────
function PBar({ pct, fail }) {
  return (
    <div
      style={{
        height: 4,
        background: C.s3,
        borderRadius: 2,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${pct}%`,
          background: fail ? C.am : C.gr,
          transition: "width .4s",
          borderRadius: 2,
        }}
      />
    </div>
  );
}

function Badge({ type }) {
  const map = {
    admin: { bg: "#dbeafe", color: C.ac },
    tester: { bg: C.amd, color: C.am },
    active: { bg: C.grd, color: C.gr },
    inactive: { bg: C.red, color: C.re },
  };
  const s = map[type] || { bg: C.s3, color: C.t2 };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 9px",
        borderRadius: 20,
        fontSize: 10,
        fontFamily: F.mono,
        fontWeight: 700,
        textTransform: "uppercase",
        background: s.bg,
        color: s.color,
      }}
    >
      {type}
    </span>
  );
}

function Chip({ label, color, bg }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        padding: "2px 8px",
        borderRadius: 12,
        fontSize: 10,
        fontFamily: F.mono,
        background: bg,
        color,
      }}
    >
      {label}
    </span>
  );
}

function Toggle({ on, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        width: 34,
        height: 18,
        borderRadius: 9,
        background: on ? "#dcfce7" : C.s3,
        border: `1px solid ${on ? "#86efac" : C.b2}`,
        position: "relative",
        cursor: "pointer",
        flexShrink: 0,
        transition: "all .2s",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 2,
          left: on ? 18 : 2,
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: on ? C.gr : C.t3,
          transition: "left .2s",
        }}
      />
    </div>
  );
}

// ── Export Menu — dropdown with CSV and PDF options ────────────────────────────
function ExportMenu({ onCSV, onPDF }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button style={smBtn()} onClick={() => setOpen((o) => !o)}>
        <Ico n="down" s={12} /> Export{" "}
        <span style={{ fontSize: 9, marginLeft: 2 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            background: C.s1,
            border: `1px solid ${C.b1}`,
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,.12)",
            minWidth: 140,
            zIndex: 50,
            overflow: "hidden",
          }}
        >
          <button
            onClick={() => {
              onCSV();
              setOpen(false);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "9px 14px",
              border: "none",
              background: "transparent",
              color: C.t1,
              fontFamily: F.sans,
              fontSize: 13,
              cursor: "pointer",
              textAlign: "left",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = C.s2)}
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            <Ico n="down" s={13} /> Export CSV
          </button>
          <div style={{ height: 1, background: C.b1 }} />
          <button
            onClick={() => {
              onPDF();
              setOpen(false);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "9px 14px",
              border: "none",
              background: "transparent",
              color: C.t1,
              fontFamily: F.sans,
              fontSize: 13,
              cursor: "pointer",
              textAlign: "left",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = C.s2)}
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            <Ico n="report" s={13} /> Export PDF
          </button>
        </div>
      )}
    </div>
  );
}

function SearchBox({ value, onChange, placeholder = "Search…", width = 190 }) {
  return (
    <div style={{ position: "relative", width }}>
      <div
        style={{
          position: "absolute",
          left: 10,
          top: "50%",
          transform: "translateY(-50%)",
          color: C.t3,
          pointerEvents: "none",
        }}
      >
        <Ico n="search" s={13} />
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          padding: "8px 12px 8px 30px",
          background: C.s1,
          border: `1px solid ${C.b2}`,
          borderRadius: 7,
          color: C.t1,
          fontFamily: F.sans,
          fontSize: 13,
          outline: "none",
          width: "100%",
          boxShadow: "inset 0 1px 2px rgba(0,0,0,.04)",
        }}
      />
    </div>
  );
}

function Topbar({ title, sub, children }) {
  const isMobile = useIsMobile();
  const onMenuClick = useContext(MobileMenuCtx);
  return (
    <div
      style={{
        height: 58,
        padding: "0 22px",
        flexShrink: 0,
        background: C.s1,
        borderBottom: `1px solid ${C.b1}`,
        display: "flex",
        alignItems: "center",
        gap: 10,
        boxShadow: "0 1px 3px rgba(0,0,0,.06)",
      }}
    >
      {isMobile && onMenuClick && (
        <button
          onClick={onMenuClick}
          style={{ ...iBtn(), padding: "6px 8px", marginLeft: -8 }}
          title="Menu"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6"/>
            <line x1="3" y1="12" x2="21" y2="12"/>
            <line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: C.t1,
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
          }}
        >
          {title}
        </div>
        {sub && (
          <div
            style={{
              fontSize: 12,
              color: C.t3,
              marginTop: 1,
              fontFamily: F.mono,
            }}
          >
            {sub}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

const inputSty = {
  width: "100%",
  padding: "10px 13px",
  background: C.s1,
  border: `1px solid ${C.b2}`,
  borderRadius: 7,
  color: C.t1,
  fontFamily: F.sans,
  fontSize: 14,
  outline: "none",
  boxShadow: `0 1px 2px rgba(0,0,0,.04)`,
};

function Modal({ title, sub, onClose, children, width = 460 }) {
  const isMobile = useIsMobile();
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,.35)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: isMobile ? "flex-end" : "center",
        justifyContent: "center",
        zIndex: 200,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: isMobile ? "100%" : width,
          background: C.s1,
          border: `1px solid ${C.b1}`,
          borderRadius: isMobile ? "14px 14px 0 0" : 14,
          padding: isMobile ? "24px 20px" : "28px 30px",
          boxShadow: "0 16px 48px rgba(0,0,0,.12)",
          maxHeight: isMobile ? "90vh" : "90vh",
          overflowY: "auto",
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>
          {title}
        </div>
        {sub && (
          <div
            style={{
              fontSize: 12,
              color: C.t2,
              marginBottom: 20,
              lineHeight: 1.5,
            }}
          >
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
    <div
      style={{
        display: "flex",
        gap: 8,
        justifyContent: "flex-end",
        marginTop: 22,
      }}
    >
      {children}
    </div>
  );
}
function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <label
        style={{
          display: "block",
          fontSize: 10,
          fontFamily: F.mono,
          color: C.t2,
          textTransform: "uppercase",
          letterSpacing: "1.2px",
          marginBottom: 7,
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

// ── Toast ──────────────────────────────────────────────────────────────────────
function useToast() {
  const [list, setList] = useState([]);
  const push = useCallback((msg, type = "info") => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, msg, type }]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), 3000);
  }, []);
  const cols = {
    success: { bg: "#f0fdf4", border: "rgba(22,163,74,.4)", color: C.gr },
    error: { bg: "#fef2f2", border: "rgba(220,38,38,.4)", color: C.re },
    info: { bg: "#eff6ff", border: "rgba(0,112,243,.4)", color: C.ac },
  };
  const Host = () => (
    <div
      style={{
        position: "fixed",
        bottom: 20,
        right: 20,
        zIndex: 999,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        pointerEvents: "none",
      }}
    >
      {list.map((t) => {
        const c = cols[t.type] || cols.info;
        return (
          <div
            key={t.id}
            style={{
              padding: "10px 16px",
              borderRadius: 6,
              border: `1px solid ${c.border}`,
              background: c.bg,
              color: c.color,
              fontFamily: F.mono,
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              gap: 8,
              boxShadow: "0 4px 16px rgba(0,0,0,.10)",
            }}
          >
            <Ico
              n={
                t.type === "success"
                  ? "check"
                  : t.type === "error"
                  ? "x"
                  : "bell"
              }
              s={12}
            />
            {t.msg}
          </div>
        );
      })}
    </div>
  );
  return { push, Host };
}

// ── Login ──────────────────────────────────────────────────────────────────────
function LoginPage({ users, onLogin }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const isMobile = useIsMobile();
  const go = () => {
    const found = users.find(
      (x) => x.username === u.trim() && x.password === p && x.active
    );
    found ? onLogin(found) : setErr("Invalid credentials or account inactive.");
  };
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: isMobile ? "flex-start" : "center",
        justifyContent: "center",
        background: `linear-gradient(160deg,#e8f0fe 0%,#f0f2f5 60%)`,
        padding: isMobile ? "40px 16px" : 0,
        overflowY: "auto",
      }}
    >
      <div
        style={{
          width: isMobile ? "100%" : 390,
          maxWidth: 420,
          padding: isMobile ? "36px 24px" : "48px 40px",
          background: C.s1,
          border: `1px solid ${C.b1}`,
          borderRadius: 16,
          boxShadow: "0 8px 40px rgba(0,0,0,.10)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 38,
          }}
        >
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: 10,
              background: "linear-gradient(135deg,#00b4d8,#0077b6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: F.mono,
              fontWeight: 700,
              fontSize: 14,
              color: "#fff",
            }}
          >
            TP
          </div>
          <div
            style={{
              fontFamily: F.mono,
              fontSize: 20,
              fontWeight: 700,
              color: C.t1,
            }}
          >
            Test<span style={{ color: C.ac }}>Pro</span>
          </div>
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>
          Sign in
        </div>
        <div style={{ fontSize: 13, color: C.t2, marginBottom: 30 }}>
          Access your testing workspace
        </div>
        <Field label="Username">
          <input
            style={inputSty}
            value={u}
            onChange={(e) => setU(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go()}
            autoFocus
          />
        </Field>
        <Field label="Password">
          <input
            style={inputSty}
            type="password"
            value={p}
            onChange={(e) => setP(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go()}
          />
        </Field>
        <button
          onClick={go}
          style={{
            width: "100%",
            padding: 13,
            border: "none",
            borderRadius: 6,
            background: C.ac,
            color: "#fff",
            fontFamily: F.mono,
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            boxShadow: `0 2px 8px rgba(0,112,243,.3)`,
          }}
        >
          Sign In →
        </button>
        {err && (
          <div
            style={{
              color: C.re,
              fontSize: 12,
              textAlign: "center",
              marginTop: 14,
              fontFamily: F.mono,
            }}
          >
            {err}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────────────────
function Sidebar({
  session,
  view,
  setView,
  modules,
  selMod,
  setSelMod,
  collapsed,
  setCollapsed,
  onLogout,
  locked,        // true while a tester holds an unreleased lock
  mobileOpen,    // mobile drawer open state
  onMobileClose, // close mobile drawer
}) {
  const isMobile = useIsMobile();
  const [search, setSearch] = useState("");
  const modList = useMemo(() => Object.values(modules), [modules]);
  const filtered = useMemo(
    () =>
      modList.filter((m) =>
        m.name.toLowerCase().includes(search.toLowerCase())
      ),
    [modList, search]
  );

  // Aggregate pass/fail across all tests→steps for each module (dividers excluded)
  const modStats = useMemo(() => {
    const s = {};
    modList.forEach((m) => {
      const allSteps = m.tests.flatMap((t) => t.steps).filter((s) => !s.isDivider);
      s[m.id] = {
        pass: allSteps.filter((s) => s.status === "pass").length,
        fail: allSteps.filter((s) => s.status === "fail").length,
        total: allSteps.length,
      };
    });
    return s;
  }, [modList]);

  const navRow = (id, icon, label) => {
    const active = view === id;
    const isLocked = locked && !active; // locked & trying to leave current view
    return (
      <div
        key={id}
        onClick={() => {
          if (isLocked) return;
          setView(id);
          if (onMobileClose) onMobileClose();
        }}
        title={isLocked ? "Finish the current test first to navigate away" : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 16px",
          cursor: isLocked ? "not-allowed" : "pointer",
          fontSize: 13,
          fontWeight: 500,
          color: active ? C.ac : isLocked ? C.t3 : C.t2,
          background: active ? "#eff6ff" : "transparent",
          borderLeft: `2px solid ${active ? C.ac : "transparent"}`,
          opacity: isLocked ? 0.45 : 1,
          transition: "all .15s",
        }}
      >
        <Ico n={icon} s={15} />
        {!collapsed && <span style={{ flex: 1 }}>{label}</span>}
        {isLocked && !collapsed && (
          <Ico n="lock" s={10} />
        )}
      </div>
    );
  };

  return (
    <>
      {/* Mobile overlay backdrop */}
      {isMobile && mobileOpen && (
        <div
          onClick={onMobileClose}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,.35)",
            backdropFilter: "blur(2px)",
            zIndex: 300,
          }}
        />
      )}
    <div
      style={{
        width: isMobile ? 280 : (collapsed ? 54 : 250),
        flexShrink: 0,
        background: C.s1,
        borderRight: `1px solid ${C.b1}`,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        transition: isMobile ? "transform .25s" : "width .2s",
        // Mobile: slide in/out as a drawer
        ...(isMobile ? {
          position: "fixed",
          top: 0,
          left: 0,
          height: "100%",
          zIndex: 301,
          transform: mobileOpen ? "translateX(0)" : "translateX(-100%)",
        } : {}),
      }}
    >
      <div
        style={{
          padding: "14px",
          borderBottom: `1px solid ${C.b1}`,
          display: "flex",
          alignItems: "center",
          gap: 10,
          minHeight: 54,
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 7,
            background: "linear-gradient(135deg,#00b4d8,#0077b6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: F.mono,
            fontWeight: 700,
            fontSize: 11,
            color: "#fff",
            flexShrink: 0,
          }}
        >
          TP
        </div>
        {!collapsed && (
          <span
            style={{
              fontFamily: F.mono,
              fontWeight: 700,
              fontSize: 14,
              color: C.t1,
            }}
          >
            Test<span style={{ color: C.ac }}>Pro</span>
          </span>
        )}
        <button
          onClick={() => setCollapsed((c) => !c)}
          style={{ ...iBtn(), marginLeft: "auto", padding: 4 }}
        >
          <Ico n={collapsed ? "chevR" : "chevL"} s={13} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", paddingTop: 8 }}>
        {!collapsed && (
          <div
            style={{
              padding: "5px 16px 3px",
              fontSize: 10,
              fontFamily: F.mono,
              textTransform: "uppercase",
              letterSpacing: "1.5px",
              color: C.t3,
            }}
          >
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
            <div
              style={{
                padding: "5px 16px 4px",
                fontSize: 10,
                fontFamily: F.mono,
                textTransform: "uppercase",
                letterSpacing: "1.5px",
                color: C.t3,
              }}
            >
              Modules ({filtered.length})
            </div>
            <div style={{ padding: "4px 10px 8px", position: "relative" }}>
              <div
                style={{
                  position: "absolute",
                  left: 20,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: C.t3,
                  pointerEvents: "none",
                }}
              >
                <Ico n="search" s={12} />
              </div>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search modules…"
                style={{
                  width: "100%",
                  padding: "6px 8px 6px 28px",
                  background: C.s2,
                  border: `1px solid ${C.b1}`,
                  borderRadius: 6,
                  color: C.t1,
                  fontFamily: F.mono,
                  fontSize: 11,
                  outline: "none",
                }}
              />
            </div>
            {filtered.map((m) => {
              const st = modStats[m.id] || {};
              const active = selMod === m.id && view === "mod";
              return (
                <div
                  key={m.id}
                  onClick={() => {
                    if (locked && !(selMod === m.id && view === "mod")) return;
                    setSelMod(m.id);
                    setView("mod");
                    if (onMobileClose) onMobileClose();
                  }}
                  title={locked && !(selMod === m.id && view === "mod") ? "Finish the current test first" : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 16px",
                    cursor: locked && !(selMod === m.id && view === "mod") ? "not-allowed" : "pointer",
                    fontSize: 13,
                    color: active ? C.ac : locked && !(selMod === m.id && view === "mod") ? C.t3 : C.t2,
                    opacity: locked && !(selMod === m.id && view === "mod") ? 0.45 : 1,
                    background: active ? "#eff6ff" : "transparent",
                    borderLeft: `2px solid ${active ? C.ac : "transparent"}`,
                    transition: "all .12s",
                  }}
                >
                  <Ico n="layers" s={12} />
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {m.name}
                  </span>
                  {st.fail > 0 && (
                    <span
                      style={{
                        fontSize: 9,
                        fontFamily: F.mono,
                        background: C.red,
                        color: C.re,
                        padding: "1px 5px",
                        borderRadius: 8,
                      }}
                    >
                      ✗{st.fail}
                    </span>
                  )}
                  {st.fail === 0 && st.pass === st.total && st.pass > 0 && (
                    <span
                      style={{
                        fontSize: 9,
                        background: C.grd,
                        color: C.gr,
                        padding: "1px 5px",
                        borderRadius: 8,
                        fontFamily: F.mono,
                      }}
                    >
                      ✓
                    </span>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>

      <div
        style={{
          padding: "12px 14px",
          borderTop: `1px solid ${C.b1}`,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: "50%",
            background: "linear-gradient(135deg,#dbeafe,#bfdbfe)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: F.mono,
            fontSize: 12,
            fontWeight: 700,
            color: C.ac,
            flexShrink: 0,
            border: `1px solid ${C.b1}`,
          }}
        >
          {(session.name || "?")[0]}
        </div>
        {!collapsed && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {session.name}
            </div>
            <div style={{ fontSize: 10, fontFamily: F.mono, color: C.t2 }}>
              {session.role}
            </div>
          </div>
        )}
        <button
          onClick={onLogout}
          style={{ ...iBtn(), padding: 5, flexShrink: 0 }}
          title="Logout"
        >
          <Ico n="logout" s={14} />
        </button>
      </div>
    </div>
    </>
  );
}

// ── Dashboard ──────────────────────────────────────────────────────────────────
function Dashboard({ modules, session, onSelect, saveMods, addLog, toast }) {
  const isAdmin = session.role === "admin";
  const isMobile = useIsMobile();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [confirmDel, setConfirmDel] = useState(null); // module id to delete
  const modList = useMemo(() => Object.values(modules), [modules]);

  const modStats = useMemo(
    () =>
      modList.map((m) => {
        const allSteps = m.tests.flatMap((t) => t.steps).filter((s) => !s.isDivider);
        const pass = allSteps.filter((s) => s.status === "pass").length;
        const fail = allSteps.filter((s) => s.status === "fail").length;
        return {
          ...m,
          pass,
          fail,
          total: allSteps.length,
          testCount: m.tests.length,
        };
      }),
    [modList]
  );

  const totalPass = modStats.reduce((a, m) => a + m.pass, 0);
  const totalFail = modStats.reduce((a, m) => a + m.fail, 0);
  const total = modStats.reduce((a, m) => a + m.total, 0);
  const pending = total - totalPass - totalFail;

  const filtered = useMemo(() => {
    let l = modStats.filter((m) =>
      m.name.toLowerCase().includes(search.toLowerCase())
    );
    if (filter === "pass")
      l = l.filter((m) => m.pass === m.total && m.total > 0);
    if (filter === "fail") l = l.filter((m) => m.fail > 0);
    if (filter === "active")
      l = l.filter((m) => m.pass + m.fail > 0 && m.pass + m.fail < m.total);
    if (filter === "empty") l = l.filter((m) => m.pass + m.fail === 0);
    return l;
  }, [modStats, search, filter]);

  const addModule = () => {
    const keys = Object.keys(modules);
    // Find next available number
    let n = keys.length + 1;
    while (modules[`m${n}`]) n++;
    const modId = `m${n}`;
    const tests = Array.from({ length: 5 }, (_, i) =>
      makeTest(modId, i + 1, 10)
    );
    const newMod = { id: modId, name: `Module ${n}`, tests };
    saveMods({ ...modules, [modId]: newMod });
    toast(`Module ${n} added`, "success");
    addLog({
      ts: Date.now(),
      user: session.name,
      action: `Added Module ${n}`,
      type: "info",
    });
  };

  const deleteModule = (id) => {
    if (Object.keys(modules).length <= 1) {
      toast("Cannot delete the last module", "error");
      return;
    }
    const updated = { ...modules };
    delete updated[id];
    saveMods(updated);
    toast("Module deleted", "info");
    addLog({
      ts: Date.now(),
      user: session.name,
      action: `Deleted module "${modules[id]?.name}"`,
      type: "warn",
    });
    setConfirmDel(null);
  };

  const sc = (label, val, color, meta) => (
    <div
      style={{
        background: C.s1,
        border: `1px solid ${C.b1}`,
        borderRadius: 10,
        padding: "16px 20px",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: `linear-gradient(90deg,${color},transparent)`,
        }}
      />
      <div
        style={{
          fontSize: 12,
          fontFamily: F.sans,
          fontWeight: 500,
          color: C.t2,
          textTransform: "uppercase",
          letterSpacing: ".5px",
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 32, fontFamily: F.mono, fontWeight: 700, color }}>
        {val.toLocaleString()}
      </div>
      <div style={{ fontSize: 12, color: C.t3, marginTop: 6 }}>{meta}</div>
    </div>
  );

  return (
    <>
      <Topbar
        title="Dashboard"
        sub={`Hello ${
          session.name.split(" ")[0]
        } · ${new Date().toLocaleDateString("en-GB", {
          weekday: "long",
          day: "numeric",
          month: "short",
        })}`}
      >
        {!isMobile && (
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Search modules…"
            width={200}
          />
        )}
        {isAdmin && (
          <button style={acBtn(smBtn())} onClick={addModule}>
            <Ico n="plus" s={12} /> {isMobile ? "" : "Add Module"}
          </button>
        )}
      </Topbar>
      <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? 12 : 20 }}>
        {isMobile && (
          <div style={{ marginBottom: 12 }}>
            <SearchBox
              value={search}
              onChange={setSearch}
              placeholder="Search modules…"
              width="100%"
            />
          </div>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "repeat(2,1fr)" : "repeat(4,1fr)",
            gap: isMobile ? 10 : 14,
            marginBottom: isMobile ? 14 : 20,
          }}
        >
          {sc("Total Steps", total, C.ac, `Across ${modList.length} modules`)}
          {sc(
            "Passed",
            totalPass,
            C.gr,
            `${total ? Math.round((totalPass / total) * 100) : 0}% pass rate`
          )}
          {sc(
            "Failed",
            totalFail,
            C.re,
            `${modStats.filter((m) => m.fail > 0).length} modules affected`
          )}
          {sc(
            "Pending",
            pending,
            C.am,
            `${
              modStats.filter((m) => m.pass + m.fail === m.total && m.total > 0)
                .length
            } modules complete`
          )}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: isMobile ? "flex-start" : "center",
            flexDirection: isMobile ? "column" : "row",
            justifyContent: "space-between",
            marginBottom: 14,
            gap: isMobile ? 8 : 0,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            Modules{" "}
            <span
              style={{
                color: C.t3,
                fontFamily: F.mono,
                fontWeight: 400,
                fontSize: 12,
              }}
            >
              ({filtered.length})
            </span>
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {[
              ["all", "All"],
              ["active", "In Progress"],
              ["pass", "All Pass"],
              ["fail", "Has Failures"],
              ["empty", "Not Started"],
            ].map(([k, l]) => (
              <button
                key={k}
                onClick={() => setFilter(k)}
                style={{
                  padding: "5px 10px",
                  borderRadius: 20,
                  border: `1px solid ${filter === k ? C.b2 : C.b1}`,
                  background: filter === k ? C.s3 : "transparent",
                  color: filter === k ? C.t1 : C.t2,
                  fontFamily: F.mono,
                  fontSize: 10,
                  cursor: "pointer",
                }}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((m) => {
            const pct = Math.round((m.pass / Math.max(m.total, 1)) * 100);
            const passW = m.total ? (m.pass / m.total) * 100 : 0;
            const failW = m.total ? (m.fail / m.total) * 100 : 0;
            const borderColor =
              m.fail > 0
                ? "#fca5a5"
                : m.pass === m.total && m.total > 0
                ? "#86efac"
                : C.b1;
            return (
              <div
                key={m.id}
                style={{
                  background: C.s1,
                  border: `1px solid ${borderColor}`,
                  borderRadius: 8,
                  overflow: "hidden",
                  transition: "border-color .15s",
                }}
              >
                <div
                  style={{
                    padding: "12px 16px",
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    cursor: "pointer",
                  }}
                  onClick={() => onSelect(m.id)}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {m.name}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        fontFamily: F.mono,
                        color: C.t3,
                        marginTop: 2,
                      }}
                    >
                      {m.testCount} test{m.testCount !== 1 ? "s" : ""} ·{" "}
                      {m.total} step{m.total !== 1 ? "s" : ""}
                    </div>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                      flexShrink: 0,
                    }}
                  >
                    {m.pass > 0 && (
                      <span
                        style={{
                          fontSize: 11,
                          fontFamily: F.mono,
                          color: C.gr,
                        }}
                      >
                        ✓ {m.pass}
                      </span>
                    )}
                    {m.fail > 0 && (
                      <span
                        style={{
                          fontSize: 11,
                          fontFamily: F.mono,
                          color: C.re,
                        }}
                      >
                        ✗ {m.fail}
                      </span>
                    )}
                    {m.total - m.pass - m.fail > 0 && (
                      <span
                        style={{
                          fontSize: 11,
                          fontFamily: F.mono,
                          color: C.t3,
                        }}
                      >
                        ⟳ {m.total - m.pass - m.fail}
                      </span>
                    )}
                  </div>

                  <div
                    style={{
                      fontSize: 12,
                      fontFamily: F.mono,
                      color: pct === 100 ? C.gr : m.fail > 0 ? C.am : C.t2,
                      flexShrink: 0,
                      minWidth: 38,
                      textAlign: "right",
                    }}
                  >
                    {pct}%
                  </div>

                  {isAdmin && (
                    <button
                      style={reBtn({ padding: "4px 8px", fontSize: 10 })}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDel(m.id);
                      }}
                      title="Delete module"
                    >
                      <Ico n="trash" s={11} />
                    </button>
                  )}
                  <Ico n="chevR" s={13} />
                </div>

                <div style={{ height: 5, background: C.s3, display: "flex" }}>
                  <div
                    style={{
                      width: `${passW}%`,
                      background: C.gr,
                      transition: "width .5s",
                    }}
                  />
                  <div
                    style={{
                      width: `${failW}%`,
                      background: C.re,
                      transition: "width .5s",
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
                padding: "40px 0",
                color: C.t3,
                fontFamily: F.mono,
                fontSize: 12,
              }}
            >
              No modules match.
            </div>
          )}
        </div>
      </div>

      {confirmDel && (
        <Modal
          title="Delete Module?"
          sub={`Delete "${modules[confirmDel]?.name}"? All its tests and steps will be permanently removed.`}
          onClose={() => setConfirmDel(null)}
          width={380}
        >
          <ModalActions>
            <button style={btn()} onClick={() => setConfirmDel(null)}>
              Cancel
            </button>
            <button style={reBtn()} onClick={() => deleteModule(confirmDel)}>
              <Ico n="trash" s={12} /> Delete
            </button>
          </ModalActions>
        </Modal>
      )}
    </>
  );
}

// ── CSV Import Modal (Tests → Steps only) ──────────────────────────────────────
function CsvImportModal({ onImport, onClose }) {
  const [drag, setDrag] = useState(false);
  const fileRef = useRef();
  const handleFile = (f) => {
    if (!f.name.match(/\.(csv|txt)$/i)) {
      alert("Please select a .csv or .txt file");
      return;
    }
    const r = new FileReader();
    r.onload = (e) => onImport(e.target.result);
    r.onerror = () => alert("Failed to read file — please try again");
    r.readAsText(f);
  };
  return (
    <Modal
      title="Import CSV"
      sub="Serial No · Action · Expected Result. Existing remarks and status are preserved."
      onClose={onClose}
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
        }}
        onClick={() => fileRef.current.click()}
        style={{
          border: `2px dashed ${drag ? C.ac : C.b2}`,
          borderRadius: 10,
          padding: 28,
          textAlign: "center",
          cursor: "pointer",
          background: drag ? "#eff6ff" : "transparent",
          marginBottom: 14,
          transition: "all .2s",
        }}
      >
        <div style={{ color: C.t3, marginBottom: 10 }}>
          <Ico n="upload" s={32} />
        </div>
        <div style={{ fontSize: 13, color: C.t2 }}>
          Drop CSV file here or click to browse
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.txt"
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files[0]) handleFile(e.target.files[0]);
        }}
      />
      <div
        style={{
          background: C.s2,
          border: `1px solid ${C.b1}`,
          borderRadius: 6,
          padding: "10px 14px",
          fontFamily: F.mono,
          fontSize: 11,
          color: C.t2,
          lineHeight: 1.9,
        }}
      >
        <div>1,Navigate to login page,Login page loads correctly</div>
        <div>2,Enter valid credentials,Fields accept input</div>
        <div>3,Click Submit,User is redirected to dashboard</div>
        <div style={{color:"#9ca3af",marginTop:4}}>$$$Section Title — creates a divider row</div>
      </div>
      <ModalActions>
        <button style={btn()} onClick={onClose}>
          Cancel
        </button>
      </ModalActions>
    </Modal>
  );
}


// ── Divider Row — full-width section separator ($$$ CSV rows) ─────────────────
function DividerRow({ label }) {
  return (
    <div style={{
      gridColumn: "1 / -1",
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "6px 14px",
      background: "linear-gradient(90deg,#eff6ff,#f8faff)",
      borderBottom: `1px solid ${C.b1}`,
    }}>
      <div style={{ height: 1, width: 10, background: C.b2, flexShrink: 0 }} />
      <span style={{
        fontSize: 10,
        fontFamily: F.mono,
        fontWeight: 700,
        color: C.ac,
        textTransform: "uppercase",
        letterSpacing: "1.2px",
        whiteSpace: "nowrap",
      }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: C.b2 }} />
    </div>
  );
}

function StepRow({
  step,
  idx,
  onChange,
  onStatusToggle,
  isActive,
  onActivate,
  rowRef,
}) {
  const readonlyCell = (text, color) => (
    <div
      style={{
        padding: "8px 10px",
        display: "flex",
        alignItems: "flex-start",
        borderRight: `1px solid ${C.b1}`,
        minHeight: 40,
      }}
    >
      {text ? (
        <span
          style={{
            fontSize: 12,
            color,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {text}
        </span>
      ) : (
        <span
          style={{
            fontSize: 11,
            color: C.t3,
            fontStyle: "italic",
            fontFamily: F.mono,
          }}
        >
          —
        </span>
      )}
    </div>
  );

  const rowBg =
    step.status === "fail"
      ? "#fff5f5"
      : step.status === "pass"
      ? "#f0fdf4"
      : isActive
      ? "#eff6ff"
      : "transparent";

  return (
    <div
      ref={rowRef}
      onClick={onActivate}
      style={{
        display: "grid",
        gridTemplateColumns: "50px 1fr 1fr 180px 110px",
        gap: 0,
        borderBottom: `1px solid ${C.b1}`,
        background: rowBg,
        outline: isActive ? `2px solid ${C.ac}` : "none",
        outlineOffset: -2,
        transition: "background .15s, outline .15s",
        cursor: "default",
      }}
    >
      <div
        style={{
          padding: "8px 10px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRight: `1px solid ${C.b1}`,
        }}
      >
        {isActive && (
          <div
            style={{
              width: 4,
              height: 4,
              borderRadius: "50%",
              background: C.ac,
              marginRight: 4,
              flexShrink: 0,
            }}
          />
        )}
        <span
          style={{
            fontFamily: F.mono,
            fontSize: 12,
            fontWeight: 600,
            color: step.serialNo != null && step.serialNo !== "" ? C.t2 : C.t3,
          }}
        >
          {step.serialNo != null && step.serialNo !== "" ? step.serialNo : "—"}
        </span>
      </div>

      {readonlyCell(step.action, C.t1)}
      {readonlyCell(step.result, C.t2)}

      <div style={{ padding: "4px 8px", borderRight: `1px solid ${C.b1}` }}>
        <textarea
          value={step.remarks}
          onChange={(e) => onChange(idx, "remarks", e.target.value)}
          placeholder="Remarks…"
          rows={2}
          onClick={(e) => e.stopPropagation()}
          style={{
            width: "100%",
            background: "transparent",
            border: "none",
            color: C.t2,
            fontFamily: F.sans,
            fontSize: 12,
            resize: "vertical",
            outline: "none",
            lineHeight: 1.5,
            minHeight: 36,
          }}
        />
      </div>

      <div
        style={{
          padding: "6px 8px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
        }}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            onStatusToggle(idx, "pass");
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "4px 10px",
            borderRadius: 20,
            border: `1px solid ${step.status === "pass" ? "#86efac" : C.b2}`,
            background: step.status === "pass" ? C.grd : "transparent",
            color: step.status === "pass" ? C.gr : C.t3,
            fontFamily: F.mono,
            fontSize: 10,
            fontWeight: 700,
            cursor: "pointer",
            width: "100%",
            justifyContent: "center",
            transition: "all .15s",
          }}
        >
          <Ico n="check" s={10} /> PASS
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onStatusToggle(idx, "fail");
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "4px 10px",
            borderRadius: 20,
            border: `1px solid ${step.status === "fail" ? "#fca5a5" : C.b2}`,
            background: step.status === "fail" ? C.red : "transparent",
            color: step.status === "fail" ? C.re : C.t3,
            fontFamily: F.mono,
            fontSize: 10,
            fontWeight: 700,
            cursor: "pointer",
            width: "100%",
            justifyContent: "center",
            transition: "all .15s",
          }}
        >
          <Ico n="x" s={10} /> FAIL
        </button>
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
  const [csvOpen, setCsvOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [fStat, setFStat] = useState("all");
  const [addCount, setAddCount] = useState(10);
  const [renaming, setRenaming] = useState(false);
  const [renVal, setRenVal] = useState(test.name);
  const [descVal, setDescVal] = useState(test.description || "");
  const [activeIdx, setActiveIdx] = useState(0); // tracks the highlighted row (original step index)
  const renRef = useRef();
  const rowRefs = useRef({}); // keyed by original step index
  const tableRef = useRef();

  // Track whether the last setSteps came from a local commit (vs RT push).
  // When it's local we skip the sync-from-parent echo a few ms later.
  const localCommitRef = useRef(false);

  // Re-sync steps when the parent test identity changes (new test opened).
  useEffect(() => {
    setSteps(test.steps);
    setRenVal(test.name);
    setDescVal(test.description || "");
    const firstPending = test.steps.findIndex((s) => !s.isDivider && s.status === "pending");
    setActiveIdx(firstPending >= 0 ? firstPending : 0);
    localCommitRef.current = false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [test.id]);

  // Re-sync steps when a remote RT update arrives (different user changed a step).
  // Skips if we just committed locally (to avoid overwriting in-progress remarks).
  const testStepsFingerprint = test.steps
    .map((s) => s.id + ":" + s.status + ":" + (s.remarks || ""))
    .join("|");
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
      saveMods({ ...allModules, [mod.id]: updMod });
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

  // CSV import — SN col[0], Action col[1], Result col[2]
  // Rows whose first column starts with $$$ become section dividers.
  // IDs are matched by serialNo so they stay stable across re-imports,
  // preserving tester remarks/status and preventing duplicate DB rows.
  //
  // Cross-module sync: after importing, the same Action/Result/divider
  // structure is pushed to the same test-index in every other module,
  // preserving each module's own existing remarks and status values.
  const importCSV = (text) => {
    const lines = text.trim().split(/\r?\n/);
    const start = lines[0].toLowerCase().match(/serial|action|no/) ? 1 : 0;
    const dataLines = lines.slice(start).slice(0, 100_000);

    // Helper: build a steps array for a given target test, using the parsed
    // CSV rows but preserving any existing remarks/status from that test.
    const buildStepsForTest = (targetTest, targetTestId) => {
      const existingBySN = {};
      (targetTest.steps || []).forEach((s) => {
        if (!s.isDivider && s.serialNo !== "" && s.serialNo != null) {
          existingBySN[String(s.serialNo)] = s;
        }
      });

      let stepCounter = 0;
      const result = [];

      dataLines.forEach((line, i) => {
        const cols = csvParse(line);
        const rawFirst = (cols[0] || "").trim();

        if (rawFirst.startsWith("$$$")) {
          const label =
            rawFirst.slice(3).trim() ||
            cols.slice(1).map((c) => c.trim()).filter(Boolean).join(" ") ||
            "Section";
          const stableLabel = label.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 40);
          const divId = `${targetTestId}_div_${stableLabel}_${i}`;
          result.push({
            id: divId,
            serialNo: null,
            action: label,
            result: "",
            remarks: "",
            status: "pending",
            isDivider: true,
          });
        } else {
          stepCounter++;
          const csvSN =
            rawFirst !== ""
              ? isNaN(Number(rawFirst)) ? rawFirst : Number(rawFirst)
              : stepCounter;

          const existing = existingBySN[String(csvSN)];
          const stableId = existing?.id || `${targetTestId}_s${csvSN}`;

          result.push({
            ...(existing || {}),
            id: stableId,
            isDivider: false,
            serialNo: csvSN,
            action: cols[1] !== undefined ? cols[1] : (existing?.action ?? ""),
            result: cols[2] !== undefined ? cols[2] : (existing?.result ?? ""),
            // Preserve each module's tester remarks + status — never overwrite
            remarks: existing?.remarks ?? "",
            status:  existing?.status  ?? "pending",
          });
        }
      });

      return result;
    };

    // Build steps for the current test (to update local state immediately)
    const ns = buildStepsForTest(test, test.id);
    setSteps(ns);

    // Now propagate to ALL modules at the same test-index (testIdx)
    localCommitRef.current = true;
    const updatedModules = {};
    for (const [modId, m] of Object.entries(allModules)) {
      const targetTest = m.tests[testIdx];
      if (!targetTest) {
        // Module doesn't have a test at this index — leave it unchanged
        updatedModules[modId] = m;
        continue;
      }
      const targetSteps = buildStepsForTest(targetTest, targetTest.id);
      const updTests = m.tests.map((t, i) =>
        i === testIdx ? { ...t, steps: targetSteps } : t
      );
      updatedModules[modId] = { ...m, tests: updTests };
    }

    saveMods(updatedModules);
    setCsvOpen(false);

    const modCount = Object.values(allModules).filter((m) => m.tests[testIdx]).length;
    toast(
      `Imported ${dataLines.length} row${dataLines.length !== 1 ? "s" : ""} → synced to ${modCount} module${modCount !== 1 ? "s" : ""}`,
      "success"
    );
    addLog({
      ts: Date.now(),
      user: session.name,
      action: `CSV imported into Test ${testIdx + 1} across ${modCount} modules (${dataLines.length} rows each)`,
      type: "info",
    });
  };

  const exportCSV = () => {
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["Serial No", "Action", "Result", "Remarks", "Status"]];
    steps.forEach((s) => {
      if (s.isDivider) {
        rows.push([esc(`$$$${s.action}`), "", "", "", ""]);
      } else {
        rows.push([s.serialNo ?? "", esc(s.action), esc(s.result), esc(s.remarks), s.status]);
      }
    });
    const b = new Blob([rows.map((r) => r.join(",")).join("\n")], {
      type: "text/csv",
    });
    const url = URL.createObjectURL(b);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${mod.name}_${test.name}.csv`.replace(/\s+/g, "_");
    a.click();
    URL.revokeObjectURL(url);
    toast("CSV exported", "success");
  };

  const exportPDF = () => {
    const he = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    const statusColor = (s) =>
      s === "pass" ? "#16a34a" : s === "fail" ? "#dc2626" : "#9ca3af";
    const statusBg = (s) =>
      s === "pass" ? "#f0fdf4" : s === "fail" ? "#fff5f5" : "#f9fafb";
    const rows = steps
      .map(
        (s) => `
      <tr style="background:${statusBg(s.status)}">
        <td style="padding:7px 10px;border:1px solid #e5e7eb;font-family:monospace;font-size:12px;text-align:center;white-space:nowrap">${
          s.serialNo || "—"
        }</td>
        <td style="padding:7px 10px;border:1px solid #e5e7eb;font-size:13px">${he(s.action)}</td>
        <td style="padding:7px 10px;border:1px solid #e5e7eb;font-size:13px;color:#4b5563">${he(s.result)}</td>
        <td style="padding:7px 10px;border:1px solid #e5e7eb;font-size:13px;color:#6b7280">${he(s.remarks)}</td>
        <td style="padding:7px 10px;border:1px solid #e5e7eb;font-family:monospace;font-size:11px;font-weight:700;text-align:center;color:${statusColor(
          s.status
        )}">${s.status.toUpperCase()}</td>
      </tr>`
      )
      .join("");

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <title>${he(mod.name)} — ${he(test.name)}</title>
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
      <h1>${he(mod.name)} — ${he(test.name)}</h1>
      ${test.description ? `<h2>${he(test.description)}</h2>` : ""}
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
    if (!w) {
      toast("Pop-up blocked — please allow pop-ups for this site", "error");
      return;
    }
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
            padding: isMobile ? "10px 14px 8px" : "12px 22px 10px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            borderBottom: `1px solid ${C.b1}`,
          }}
        >
          {/* Hamburger on mobile */}
          {isMobile && onMenuClick && (
            <button onClick={onMenuClick} style={{ ...iBtn(), padding: "5px 6px", marginLeft: -6 }}>
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
            }}
          >
            <Ico n="chevL" s={11} />
            <span style={{ maxWidth: isMobile ? 80 : 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {mod.name}
            </span>
          </button>

          <span style={{ color: C.t3, fontSize: 12, flexShrink: 0 }}>›</span>

          {/* Test name (editable) */}
          {renaming ? (
            <input
              ref={renRef}
              value={renVal}
              onChange={(e) => setRenVal(e.target.value)}
              onBlur={() => { commit(steps, renVal || test.name, descVal); setRenaming(false); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { commit(steps, renVal || test.name, descVal); setRenaming(false); }
                if (e.key === "Escape") setRenaming(false);
              }}
              autoFocus
              style={{
                background: "none", border: "none",
                borderBottom: `2px solid ${C.ac}`,
                color: C.t1, fontFamily: F.sans,
                fontSize: isMobile ? 14 : 15,
                fontWeight: 700, padding: "0 2px",
                outline: "none", minWidth: 0, flex: 1,
              }}
            />
          ) : (
            <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
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
              {isAdmin && (
                <button
                  onClick={() => { setRenaming(true); setTimeout(() => renRef.current?.select(), 20); }}
                  style={{ ...iBtn(), padding: 3, flexShrink: 0 }}
                  title="Rename test"
                >
                  <Ico n="edit" s={11} />
                </button>
              )}
            </div>
          )}

          {/* Progress pill — always visible */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
            background: C.s2,
            border: `1px solid ${C.b1}`,
            borderRadius: 20,
            padding: "4px 12px",
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
          padding: isMobile ? "6px 14px" : "6px 22px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: C.s2,
          borderBottom: `1px solid ${C.b1}`,
        }}>
          <input
            value={descVal}
            onChange={(e) => { setDescVal(e.target.value); commit(steps, renVal, e.target.value); }}
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
          padding: isMobile ? "8px 14px" : "8px 22px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
        }}>
          {isAdmin ? (
            <button style={acBtn(smBtn())} onClick={() => setCsvOpen(true)}>
              <Ico n="upload" s={12} /> {isMobile ? "Import" : "Import CSV"}
            </button>
          ) : (
            <span style={{ ...smBtn(), opacity: 0.3, cursor: "not-allowed", display: "inline-flex", alignItems: "center", gap: 5 }}>
              <Ico n="lock" s={12} /> {isMobile ? "Import" : "Import CSV"}
            </span>
          )}
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
                marginLeft: "auto",
                padding: isMobile ? "7px 16px" : "6px 14px",
                fontSize: isMobile ? 13 : 12,
                fontWeight: 600,
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
              <Ico n="check" s={12} /> Finish Test
            </button>
          )}
          {/* Spacer if admin (no Finish button) */}
          {isAdmin && <div style={{ flex: 1 }} />}
        </div>
      </div>

      <div
        style={{
          padding: "8px 16px",
          background: C.s1,
          borderBottom: `1px solid ${C.b1}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", gap: 4 }}>
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
                padding: "4px 9px",
                borderRadius: 20,
                border: `1px solid ${fStat === k ? C.b2 : C.b1}`,
                background: fStat === k ? C.s3 : "transparent",
                color: fStat === k ? C.t1 : C.t2,
                fontFamily: F.mono,
                fontSize: 10,
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
          width={170}
        />
        {isAdmin && (
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 6,
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
              }}
            >
              {[1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000].map((n) => (
                <option key={n} value={n}>
                  +{n}
                </option>
              ))}
            </select>
            <button
              style={grBtn(smBtn())}
              onClick={addSteps}
              disabled={steps.length >= 100_000}
            >
              <Ico n="plus" s={11} /> Add Steps
            </button>
          </div>
        )}
      </div>

      <div ref={tableRef} style={{ flex: 1, overflowY: "auto", overflowX: "auto" }}>
        <div style={{ minWidth: 680 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "50px 1fr 1fr 180px 110px",
            background: C.s2,
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

      {csvOpen && isAdmin && (
        <CsvImportModal
          onImport={importCSV}
          onClose={() => setCsvOpen(false)}
        />
      )}
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
  const [selTestIdx, setSelTestIdx] = useState(null); // null = list, number = test detail
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renVal, setRenVal] = useState(mod.name);
  const [locks, setLocks] = useState({});
  const renRef = useRef();

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
  }, [selTestIdx, isAdmin, session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // beforeunload: best-effort release on normal tab/window close (testers only).
  // Uses activeTestIdRef so it always sees the latest open test id.
  useEffect(() => {
    if (isAdmin) return;
    const onUnload = () => {
      const testId = activeTestIdRef.current;
      if (!testId) return;
      try {
        // keepalive fetch survives page unload and sends proper headers
        const url = `${supabase.supabaseUrl}/rest/v1/test_locks?test_id=eq.${encodeURIComponent(testId)}&user_id=eq.${encodeURIComponent(session.id)}`;
        fetch(url, {
          method: "DELETE",
          keepalive: true,
          headers: {
            apikey: supabase.supabaseKey,
            Authorization: `Bearer ${supabase.supabaseKey}`,
          },
        });
      } catch {
        // best-effort — TTL will expire the lock within 60s anyway
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
    setRenVal(mod.name);
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
    saveMods({ ...allModules, [mod.id]: { ...mod, name } });
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
    saveMods({ ...allModules, [mod.id]: updated });
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
        .map((t, i) => ({ ...t, serialNo: i + 1, serial_no: i + 1 })),
    };
    saveMods({ ...allModules, [mod.id]: updated });
    toast("Test deleted", "info");
    addLog({
      ts: Date.now(),
      user: session.name,
      action: `Deleted test from ${mod.name}`,
      type: "warn",
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
        onNav={onNav}
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
          renaming ? (
            <input
              ref={renRef}
              value={renVal}
              onChange={(e) => setRenVal(e.target.value)}
              onBlur={() => {
                saveModName(renVal || mod.name);
                setRenaming(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  saveModName(renVal || mod.name);
                  setRenaming(false);
                }
                if (e.key === "Escape") setRenaming(false);
              }}
              autoFocus
              style={{
                background: "none",
                border: "none",
                borderBottom: `1px solid ${C.ac}`,
                color: C.t1,
                fontFamily: F.sans,
                fontSize: 15,
                fontWeight: 700,
                padding: "0 2px",
                outline: "none",
                width: 220,
              }}
            />
          ) : (
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {mod.name}
              {isAdmin && (
                <button
                  onClick={() => {
                    setRenaming(true);
                    setTimeout(() => renRef.current?.select(), 20);
                  }}
                  style={{ ...iBtn(), padding: 3 }}
                  title="Rename module"
                >
                  <Ico n="edit" s={12} />
                </button>
              )}
            </span>
          )
        }
        sub={`${mod.tests.length} test${
          mod.tests.length !== 1 ? "s" : ""
        } · click a test to open its steps`}
      >
        <button
          style={smBtn()}
          onClick={() => onNav(-1)}
          disabled={modIdx === 0 || uiLocked}
          title={uiLocked ? "Finish the current test first" : undefined}
        >
          <Ico n="chevL" s={12} />
        </button>
        <span style={{ fontSize: 10, fontFamily: F.mono, color: C.t3 }}>
          {modIdx + 1}/{modTotal}
        </span>
        <button
          style={smBtn()}
          onClick={() => onNav(1)}
          disabled={modIdx === modTotal - 1 || uiLocked}
          title={uiLocked ? "Finish the current test first" : undefined}
        >
          <Ico n="chevR" s={12} />
        </button>
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search tests…"
          width={170}
        />
        {isAdmin && (
          <button style={grBtn(smBtn())} onClick={addTest}>
            <Ico n="plus" s={12} /> Add Test
          </button>
        )}
      </Topbar>

      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
                  background: lockedByOther ? "#fefce8"
                    : isMyLockedTest ? "#f0fdf4"
                    : blockedByMyLock ? "#f8fafc"
                    : C.s1,
                  border: `1px solid ${
                    lockedByOther ? "#fde68a"
                      : isMyLockedTest ? "#86efac"
                      : blockedByMyLock ? C.b1
                      : fail > 0 ? "#fca5a5"
                      : pass === t.steps.length && t.steps.length > 0 ? "#bbf7d0"
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
                    padding: "14px 18px",
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                  }}
                >
                  {/* Serial badge */}
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 9,
                      background: lockedByOther ? "#fef3c7" : isMyLockedTest ? "#dcfce7" : C.s3,
                      border: `1px solid ${lockedByOther ? "#fcd34d" : isMyLockedTest ? "#86efac" : C.b2}`,
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
                    {lockedByOther ? <Ico n="lock" s={16} />
                      : isMyLockedTest ? <Ico n="check" s={16} />
                      : t.serialNo}
                  </div>
                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: C.t1,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      {t.name}
                      {lockInfo && (
                        <span style={{
                          fontSize: 10, fontFamily: F.mono, background: "#fef3c7",
                          color: C.am, padding: "2px 8px", borderRadius: 10,
                          border: `1px solid #fcd34d`, fontWeight: 700,
                        }}>
                          🔒 In use by {lockInfo.userName}
                        </span>
                      )}
                      {isMyLockedTest && (
                        <span style={{
                          fontSize: 10, fontFamily: F.mono, background: "#dcfce7",
                          color: C.gr, padding: "2px 8px", borderRadius: 10,
                          border: `1px solid #86efac`, fontWeight: 700,
                        }}>
                          ▶ Your active test
                        </span>
                      )}
                    </div>
                    {t.description && (
                      <div
                        style={{
                          fontSize: 11,
                          color: C.t2,
                          marginTop: 2,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {t.description}
                      </div>
                    )}
                    <div
                      style={{
                        fontSize: 11,
                        fontFamily: F.mono,
                        color: C.t3,
                        marginTop: 4,
                      }}
                    >
                      {t.steps.length} step{t.steps.length !== 1 ? "s" : ""} ·{" "}
                      {pass} pass · {fail} fail · {pending} pending
                    </div>
                  </div>
                  {/* Progress */}
                  <div style={{ width: 80, flexShrink: 0 }}>
                    <PBar pct={pct} fail={fail > 0} />
                    <div
                      style={{
                        fontSize: 10,
                        color: C.t3,
                        fontFamily: F.mono,
                        textAlign: "right",
                        marginTop: 3,
                      }}
                    >
                      {pct}%
                    </div>
                  </div>
                  {/* Status chips */}
                  <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
                    {pass > 0 && (
                      <Chip label={`✓${pass}`} color={C.gr} bg={C.grd} />
                    )}
                    {fail > 0 && (
                      <Chip label={`✗${fail}`} color={C.re} bg={C.red} />
                    )}
                    {pending > 0 && (
                      <Chip label={`⟳${pending}`} color={C.am} bg={C.amd} />
                    )}
                  </div>
                  {/* Actions */}
                  <div
                    style={{ display: "flex", gap: 6, flexShrink: 0 }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {isAdmin && (
                      <button
                        style={reBtn(smBtn())}
                        onClick={() => deleteTest(realIdx)}
                        title="Delete test"
                      >
                        <Ico n="trash" s={11} />
                      </button>
                    )}
                    {lockedByOther ? (
                      <button style={amBtn(smBtn())} disabled title={`Locked by ${lock.userName}`}>
                        <Ico n="lock" s={11} /> Locked
                      </button>
                    ) : isMyLockedTest ? (
                      <button style={grBtn(smBtn())} onClick={() => openTest(realIdx)}
                        title="Return to your test">
                        <Ico n="back" s={11} /> Return
                      </button>
                    ) : blockedByMyLock ? (
                      <button style={smBtn({ opacity: 0.4, cursor: "not-allowed" })} disabled
                        title="Finish your current test first">
                        <Ico n="lock" s={11} /> Finish first
                      </button>
                    ) : (
                      <button style={acBtn(smBtn())} onClick={() => openTest(realIdx)}>
                        <Ico n="chevR" s={11} /> Open
                      </button>
                    )}
                  </div>
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
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [
      ["Module", "Test", "Step", "Action", "Result", "Remarks", "Status"],
    ];
    modList.forEach((m) =>
      m.tests.forEach((t) =>
        t.steps.forEach((s) => {
          if (s.isDivider) return; // skip section dividers
          rows.push([
            esc(m.name),
            esc(t.name),
            s.serialNo ?? "",
            esc(s.action),
            esc(s.result),
            esc(s.remarks),
            s.status,
          ]);
        })
      )
    );
    const b = new Blob([rows.map((r) => r.join(",")).join("\n")], {
      type: "text/csv",
    });
    const url = URL.createObjectURL(b);
    const a = document.createElement("a");
    a.href = url;
    a.download = `TestPro_Report_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast("CSV exported", "success");
  };

  const exportAllPDF = () => {
    const he = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    const sc = (s) =>
      s === "pass" ? "#16a34a" : s === "fail" ? "#dc2626" : "#9ca3af";
    const sb = (s) =>
      s === "pass" ? "#f0fdf4" : s === "fail" ? "#fff5f5" : "#ffffff";

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
            <td style="padding:5px 8px;border:1px solid #e5e7eb;font-size:12px">${he(s.action)}</td>
            <td style="padding:5px 8px;border:1px solid #e5e7eb;font-size:12px;color:#4b5563">${he(s.result)}</td>
            <td style="padding:5px 8px;border:1px solid #e5e7eb;font-size:12px;color:#6b7280">${he(s.remarks)}</td>
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
    if (!w) {
      toast("Pop-up blocked — please allow pop-ups for this site", "error");
      return;
    }
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
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search modules…"
          width={190}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Toggle on={failOnly} onClick={() => setFailOnly((f) => !f)} />
          <span
            style={{
              fontSize: 11,
              fontFamily: F.mono,
              color: C.t2,
              whiteSpace: "nowrap",
            }}
          >
            Failures only
          </span>
        </div>
        <ExportMenu onCSV={exportAllCSV} onPDF={exportAllPDF} />
      </Topbar>
      <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
        <div
          style={{
            display: "flex",
            gap: 8,
            marginBottom: 16,
            flexWrap: "wrap",
          }}
        >
          <Chip
            label={`${total.toLocaleString()} steps`}
            color={C.ac}
            bg="#eff6ff"
          />
          <Chip
            label={`✓ ${pass.toLocaleString()} passed (${
              total ? Math.round((pass / total) * 100) : 0
            }%)`}
            color={C.gr}
            bg={C.grd}
          />
          <Chip
            label={`✗ ${fail.toLocaleString()} failed (${
              total ? Math.round((fail / total) * 100) : 0
            }%)`}
            color={C.re}
            bg={C.red}
          />
          <Chip
            label={`⟳ ${(total - pass - fail).toLocaleString()} pending`}
            color={C.am}
            bg={C.amd}
          />
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <button
            style={smBtn()}
            onClick={() => setExp(new Set(modList.map((m) => m.id)))}
          >
            Expand All
          </button>
          <button style={smBtn()} onClick={() => setExp(new Set())}>
            Collapse All
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filtered.map((m) => {
            const pct = Math.round((m.pass / Math.max(m.total, 1)) * 100);
            const open = exp.has(m.id);
            return (
              <div
                key={m.id}
                style={{
                  background: C.s1,
                  border: `1px solid ${C.b1}`,
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              >
                <div
                  onClick={() => {
                    const s = new Set(exp);
                    s.has(m.id) ? s.delete(m.id) : s.add(m.id);
                    setExp(s);
                  }}
                  style={{
                    padding: "11px 16px",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    cursor: "pointer",
                  }}
                >
                  <Ico n={open ? "chevD" : "chevR"} s={13} />
                  <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>
                    {m.name}
                  </div>
                  <span
                    style={{ fontSize: 11, fontFamily: F.mono, color: C.t3 }}
                  >
                    {m.tests.length} tests · {m.total} steps
                  </span>
                  {m.pass > 0 && (
                    <Chip label={`✓${m.pass}`} color={C.gr} bg={C.grd} />
                  )}
                  {m.fail > 0 && (
                    <Chip label={`✗${m.fail}`} color={C.re} bg={C.red} />
                  )}
                  {m.total - m.pass - m.fail > 0 && (
                    <Chip
                      label={`⟳${m.total - m.pass - m.fail}`}
                      color={C.am}
                      bg={C.amd}
                    />
                  )}
                  <span
                    style={{ fontSize: 11, fontFamily: F.mono, color: C.t3 }}
                  >
                    {pct}%
                  </span>
                  <div style={{ width: 60 }}>
                    <PBar pct={pct} fail={m.fail > 0} />
                  </div>
                </div>
                {open && (
                  <div style={{ borderTop: `1px solid ${C.b1}` }}>
                    {m.tests.map((t) => {
                      const tp = t.steps.filter(
                        (s) => s.status === "pass"
                      ).length;
                      const tf = t.steps.filter(
                        (s) => s.status === "fail"
                      ).length;
                      const tpct = Math.round(
                        (tp / Math.max(t.steps.length, 1)) * 100
                      );
                      return (
                        <div key={t.id}>
                          <div
                            style={{
                              padding: "8px 16px 8px 28px",
                              background: C.s2,
                              borderBottom: `1px solid ${C.b1}`,
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                            }}
                          >
                            <Ico n="file" s={11} />
                            <span
                              style={{ fontSize: 12, fontWeight: 600, flex: 1 }}
                            >
                              {t.name}
                            </span>
                            {t.description && (
                              <span
                                style={{
                                  fontSize: 11,
                                  color: C.t2,
                                  flex: 2,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {t.description}
                              </span>
                            )}
                            <span
                              style={{
                                fontSize: 11,
                                fontFamily: F.mono,
                                color: C.t3,
                              }}
                            >
                              {t.steps.length} steps · {tpct}%
                            </span>
                            {tp > 0 && (
                              <Chip label={`✓${tp}`} color={C.gr} bg={C.grd} />
                            )}
                            {tf > 0 && (
                              <Chip label={`✗${tf}`} color={C.re} bg={C.red} />
                            )}
                          </div>
                          {t.steps.map((s) => {
                            const c =
                              s.status === "pass"
                                ? C.gr
                                : s.status === "fail"
                                ? C.re
                                : C.am;
                            const bg2 =
                              s.status === "pass"
                                ? C.grd
                                : s.status === "fail"
                                ? C.red
                                : C.amd;
                            return (
                              <div
                                key={s.id}
                                style={{
                                  padding: "7px 16px 7px 40px",
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 10,
                                  borderBottom: `1px solid ${C.b1}`,
                                  fontSize: 12,
                                  background:
                                    s.status === "fail"
                                      ? "#fff5f5"
                                      : "transparent",
                                }}
                              >
                                <span
                                  style={{
                                    fontFamily: F.mono,
                                    fontSize: 10,
                                    color: C.t3,
                                    width: 24,
                                    flexShrink: 0,
                                  }}
                                >
                                  {s.serialNo}
                                </span>
                                <span style={{ flex: 1 }}>
                                  {s.action || (
                                    <span style={{ color: C.t3 }}>—</span>
                                  )}
                                </span>
                                <span style={{ flex: 1, color: C.t2 }}>
                                  {s.result || (
                                    <span style={{ color: C.t3 }}>—</span>
                                  )}
                                </span>
                                <span
                                  style={{
                                    width: 100,
                                    fontSize: 11,
                                    color: C.t2,
                                  }}
                                >
                                  {s.remarks}
                                </span>
                                <span
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    padding: "2px 8px",
                                    borderRadius: 12,
                                    fontSize: 10,
                                    fontFamily: F.mono,
                                    background: bg2,
                                    color: c,
                                    flexShrink: 0,
                                  }}
                                >
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
            <div
              style={{
                textAlign: "center",
                padding: "48px 0",
                color: C.t3,
                fontFamily: F.mono,
                fontSize: 12,
              }}
            >
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
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 20px" }}>
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
              key={`${e.ts}-${i}`}
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
      type: "warn",
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
      type: "warn",
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
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search users…"
          width={190}
        />
        <button style={acBtn(smBtn())} onClick={openAdd}>
          <Ico n="plus" s={13} /> Add User
        </button>
      </Topbar>
      <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
        <div style={{ display: "grid", gap: 10 }}>
          {filtered.map((u) => (
            <div
              key={u.id}
              style={{
                background: C.s1,
                border: `1px solid ${C.b1}`,
                borderRadius: 10,
                padding: "14px 18px",
                display: "flex",
                alignItems: "center",
                gap: 14,
              }}
            >
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
                {(u.name || "?")[0].toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{u.name}</div>
                <div
                  style={{
                    fontSize: 11,
                    color: C.t2,
                    fontFamily: F.mono,
                    marginTop: 2,
                  }}
                >
                  {u.username}
                  {u.email ? ` · ${u.email}` : ""}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <Badge type={u.role} />
                  <Badge type={u.active ? "active" : "inactive"} />
                  {u.id === session.id && (
                    <span
                      style={{
                        fontSize: 10,
                        fontFamily: F.mono,
                        background: "#f3f0ff",
                        color: "#7c3aed",
                        padding: "2px 9px",
                        borderRadius: 20,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        border: "1px solid #ede9fe",
                      }}
                    >
                      You
                    </span>
                  )}
                </div>
              </div>
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
    let alive = true;
    (async () => {
      const { users, modules } = await store.loadAll();
      const log = await store.loadLog();
      if (!alive) return;
      setUsers(users.length ? users : SEED_USERS);
      setModules(Object.keys(modules).length ? modules : buildModules());
      setLog(log);
    })();
    return () => { alive = false; };
  }, []);

  const saveUsers = useCallback(async (u) => {
    setUsers(u);
    await store.saveUsers(u);
    // Reload from Supabase so new users get their real UUID (replaces temp new_XXXX id)
    const { data: fresh } = await supabase.from("users").select("*").limit(10_000);
    if (fresh && fresh.length) setUsers(fresh);
  }, []);

  // Always keep a ref to the latest modules so the debounced DB write
  // never uses a stale snapshot captured in an old closure.
  const latestModulesRef = useRef(null);
  const saveModsTimerRef = useRef(null);
  // Clear pending debounce on unmount to prevent setState-after-unmount
  useEffect(() => () => { if (saveModsTimerRef.current) clearTimeout(saveModsTimerRef.current); }, []);
  const saveMods = useCallback((m) => {
    setModules(m);
    latestModulesRef.current = m; // always track the very latest value
    // Debounce DB writes — cancels previous timer so only the final state
    // in a burst of rapid calls (e.g. keystrokes) is persisted.
    if (saveModsTimerRef.current) clearTimeout(saveModsTimerRef.current);
    saveModsTimerRef.current = setTimeout(() => {
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
                    (a, b) => (a.position ?? 0) - (b.position ?? 0)
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
          background: C.bg,
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
        background: C.bg,
        color: C.t1,
        fontFamily: F.sans,
        fontSize: 14,
        lineHeight: 1.5,
      }}
    >
      <style>{`*{box-sizing:border-box;margin:0;padding:0}body{font-family:${F.sans};-webkit-font-smoothing:antialiased}::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#d1d5db;border-radius:6px}::-webkit-scrollbar-thumb:hover{background:#9ca3af}textarea{font-family:${F.sans}}input,select,textarea{-webkit-font-smoothing:antialiased}`}</style>
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
          paddingBottom: isMobile ? 56 : 0,
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
            height: 56,
            background: C.s1,
            borderTop: `1px solid ${C.b1}`,
            display: "flex",
            alignItems: "center",
            zIndex: 200,
            boxShadow: "0 -2px 10px rgba(0,0,0,.07)",
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
                  gap: 3,
                  border: "none",
                  background: "transparent",
                  color: isActive ? C.ac : C.t3,
                  fontFamily: F.sans,
                  fontSize: 9,
                  fontWeight: isActive ? 600 : 400,
                  cursor: "pointer",
                  padding: "4px 0",
                  height: "100%",
                }}
              >
                <Ico n={icon} s={18} />
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
              gap: 3,
              border: "none",
              borderLeft: `1px solid ${C.b1}`,
              background: "transparent",
              color: C.re,
              fontFamily: F.sans,
              fontSize: 9,
              fontWeight: 400,
              cursor: "pointer",
              padding: "4px 0",
              height: "100%",
            }}
          >
            <Ico n="logout" s={18} />
            Logout
          </button>
        </div>
      )}
      <ToastHost />
    </div>
    </MobileMenuCtx.Provider>
  );
}
