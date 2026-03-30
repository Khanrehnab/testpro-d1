import { supabase } from "./supabase";
import React, {
  useState, useEffect, useRef, useCallback, useMemo, useContext,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ThemeProvider, createTheme, CssBaseline, alpha,
  Box, Stack, Paper, Typography, Button, IconButton,
  TextField, InputAdornment, Drawer, AppBar, Toolbar,
  List, ListItemButton, ListItemIcon, ListItemText,
  Chip, LinearProgress, Switch, Divider, Avatar,
  Dialog, DialogTitle, DialogContent, DialogActions,
  Alert, Select, MenuItem, FormControl, InputLabel,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
  Tooltip, Menu, CircularProgress, BottomNavigation,
  BottomNavigationAction, Collapse,
} from "@mui/material";
import {
  DashboardRounded, AssessmentRounded, PeopleRounded, HistoryRounded,
  CheckRounded, CloseRounded, UploadFileRounded, LogoutRounded,
  EditRounded, DeleteRounded, AddRounded, SearchRounded,
  ChevronRightRounded, KeyboardArrowDownRounded, ChevronLeftRounded,
  RefreshRounded, FileDownloadRounded, NotificationsRounded,
  LockRounded, LayersRounded, DescriptionRounded, ArrowBackRounded,
  MenuRounded, VisibilityRounded, VisibilityOffRounded,
  CheckCircleRounded, CancelRounded, GridViewRounded,
  PersonRounded, AdminPanelSettingsRounded, TaskAltRounded,
} from "@mui/icons-material";

// ── Storage ─────────────────────────────────────────────────────────────────────

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
      if (usersErr)  console.error("Load users error",   usersErr);
      if (modsErr)   console.error("Load modules error", modsErr);
      if (testsErr)  console.error("Load tests error",   testsErr);
      if (stepsErr)  console.error("Load steps error",   stepsErr);
      if (modsErr || testsErr || stepsErr) return { users: users || [], modules: {} };
      const stepsByTest = {};
      for (const s of steps || []) {
        if (!stepsByTest[s.test_id]) stepsByTest[s.test_id] = [];
        stepsByTest[s.test_id].push({ ...s, serialNo: s.serial_no, isDivider: s.is_divider ?? false });
      }
      const testsByModule = {};
      for (const t of tests || []) {
        if (!testsByModule[t.module_id]) testsByModule[t.module_id] = [];
        testsByModule[t.module_id].push({ ...t, serialNo: t.serial_no, steps: stepsByTest[t.id] || [] });
      }
      const modulesMap = {};
      for (const m of modules || []) modulesMap[m.id] = { ...m, tests: testsByModule[m.id] || [] };
      return { users: users || [], modules: modulesMap };
    } catch (e) { console.error("Load error", e); return { users: [], modules: {} }; }
  },
  async saveUsers(users) {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const toInsert = users.filter(u => !uuidRe.test(u.id));
    const toUpsert = users.filter(u =>  uuidRe.test(u.id));
    const liveUUIDs = toUpsert.map(u => u.id);
    if (liveUUIDs.length) {
      await supabase.from("users").delete().not("id", "in", `(${liveUUIDs.join(",")})`);
    } else if (!toInsert.length) {
      await supabase.from("users").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    }
    if (toInsert.length) {
      const rows = toInsert.map(({ id: _skip, ...rest }) => rest);
      const { data: inserted, error } = await supabase.from("users").insert(rows).select();
      if (error) { console.error("Insert users error", error); return; }
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
          ({ id, username, password, name, email, role, active })),
        { onConflict: "id" }
      );
      if (error) console.error("Upsert users error", error);
    }
  },
  async saveSteps(testId, moduleId, steps, testMeta) {
    const CHUNK = 500;
    if (moduleId) {
      const { error: modErr } = await supabase.from("modules")
        .upsert({ id: moduleId, name: testMeta?.moduleName ?? moduleId, position: 0 }, { onConflict: "id" });
      if (modErr) console.error("saveSteps: ensure module error:", modErr);
    }
    if (testMeta) {
      const { error: testErr } = await supabase.from("tests").upsert({
        id: testId, module_id: moduleId, serial_no: testMeta.serialNo ?? 0,
        name: testMeta.name ?? testId, description: testMeta.description ?? "",
      }, { onConflict: "id" });
      if (testErr) console.error("saveSteps: ensure test error:", testErr);
    }
    const stepsWithPosition = steps.map((s, position) => ({
      id: s.id, test_id: testId, position,
      serial_no: s.isDivider ? null : (s.serialNo ?? s.serial_no ?? null),
      action: s.action ?? "", result: s.result ?? "", remarks: s.remarks ?? "",
      status: s.status ?? "pending", is_divider: s.isDivider ?? false,
    }));
    for (let i = 0; i < stepsWithPosition.length; i += CHUNK) {
      const { error } = await supabase.from("steps")
        .upsert(stepsWithPosition.slice(i, i + CHUNK), { onConflict: "id" });
      if (error) { console.error("Upsert steps error:", error); return; }
    }
    if (stepsWithPosition.length > 0) {
      const liveIds = new Set(stepsWithPosition.map(s => s.id));
      const { data: existing, error: fetchErr } = await supabase.from("steps").select("id").eq("test_id", testId);
      if (fetchErr) { console.error("Fetch steps for cleanup error:", fetchErr); return; }
      const stale = (existing || []).map(r => r.id).filter(id => !liveIds.has(id));
      for (let i = 0; i < stale.length; i += CHUNK) {
        const { error } = await supabase.from("steps").delete().in("id", stale.slice(i, i + CHUNK));
        if (error) console.error("Delete stale steps error:", error);
      }
    } else {
      const { error } = await supabase.from("steps").delete().eq("test_id", testId);
      if (error) console.error("Delete all steps error:", error);
    }
  },
  async updateStepRemarksStatus(step) {
    if (!step || step.isDivider) return;
    const { error } = await supabase.from("steps")
      .update({ remarks: step.remarks ?? "", status: step.status ?? "pending" })
      .eq("id", step.id);
    if (error) console.error("updateStepRemarksStatus error:", error);
  },
  async saveModules(modulesMap) {
    const modules = Object.values(modulesMap);
    const allTests = modules.flatMap(m => m.tests.map(t => ({ ...t, module_id: m.id })));
    const allSteps = allTests.flatMap(t => (t.steps || []).map(s => ({ ...s, test_id: t.id })));
    const liveModuleIds = modules.map(m => m.id);
    const liveTestIds = allTests.map(t => t.id);
    const liveStepIds = allSteps.map(s => s.id);
    const CHUNK = 500;
    const deleteInChunks = async (table, ids) => {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const { error } = await supabase.from(table).delete().in("id", ids.slice(i, i + CHUNK));
        if (error) console.error(`Delete ${table} error`, error);
      }
    };
    const moduleRows = modules.map(({ id, name }, i) => ({ id, name, position: i }));
    for (let i = 0; i < moduleRows.length; i += CHUNK) {
      const { error } = await supabase.from("modules").upsert(moduleRows.slice(i, i + CHUNK), { onConflict: "id" });
      if (error) { console.error("Upsert modules error", error); return; }
    }
    if (allTests.length) {
      const testRows = allTests.map(t => ({
        id: t.id, module_id: t.module_id, serial_no: t.serial_no ?? t.serialNo ?? 0,
        name: t.name, description: t.description ?? "",
      }));
      for (let i = 0; i < testRows.length; i += CHUNK) {
        const { error } = await supabase.from("tests").upsert(testRows.slice(i, i + CHUNK), { onConflict: "id" });
        if (error) { console.error("Upsert tests error", error); return; }
      }
    }
    if (allSteps.length) {
      const testPositionCounters = {};
      const stepsWithPosition = allSteps.map(s => {
        if (testPositionCounters[s.test_id] === undefined) testPositionCounters[s.test_id] = 0;
        const position = testPositionCounters[s.test_id]++;
        return {
          id: s.id, test_id: s.test_id, position,
          serial_no: s.isDivider ? null : (s.serialNo ?? s.serial_no ?? null),
          action: s.action ?? "", result: s.result ?? "", remarks: s.remarks ?? "",
          status: s.status ?? "pending", is_divider: s.isDivider ?? false,
        };
      });
      for (let i = 0; i < stepsWithPosition.length; i += CHUNK) {
        const { error } = await supabase.from("steps").upsert(stepsWithPosition.slice(i, i + CHUNK), { onConflict: "id" });
        if (error) { console.error("Upsert steps error", error); return; }
      }
    }
    try {
      if (liveTestIds.length) {
        const existingStepIds = [];
        for (let i = 0; i < liveTestIds.length; i += CHUNK) {
          const { data } = await supabase.from("steps").select("id").in("test_id", liveTestIds.slice(i, i + CHUNK));
          if (data) existingStepIds.push(...data.map(r => r.id));
        }
        const liveStepSet = new Set(liveStepIds);
        const staleStepIds = existingStepIds.filter(id => !liveStepSet.has(id));
        if (staleStepIds.length) await deleteInChunks("steps", staleStepIds);
      }
      if (liveModuleIds.length) {
        const existingTestIds = [];
        for (let i = 0; i < liveModuleIds.length; i += CHUNK) {
          const { data } = await supabase.from("tests").select("id").in("module_id", liveModuleIds.slice(i, i + CHUNK));
          if (data) existingTestIds.push(...data.map(r => r.id));
        }
        const liveTestSet = new Set(liveTestIds);
        const staleTestIds = existingTestIds.filter(id => !liveTestSet.has(id));
        if (staleTestIds.length) await deleteInChunks("tests", staleTestIds);
      }
      const { data: existingMods } = await supabase.from("modules").select("id");
      const liveModSet = new Set(liveModuleIds);
      const staleMods = (existingMods || []).map(r => r.id).filter(id => !liveModSet.has(id));
      if (staleMods.length) await deleteInChunks("modules", staleMods);
    } catch (e) { console.error("Cleanup stale rows error", e); }
  },
  async addLog(entry) {
    await supabase.from("audit_log").insert({ user_name: entry.user, action: entry.action, type: entry.type });
  },
  async loadLog() {
    const { data } = await supabase.from("audit_log").select("*").order("created_at", { ascending: false }).limit(300);
    return (data || []).map(r => ({ ts: new Date(r.created_at).getTime(), user: r.user_name, action: r.action, type: r.type }));
  },
};

// ── Test Lock System ─────────────────────────────────────────────────────────────
const LOCK_TTL_MS  = 60_000;
const HEARTBEAT_MS = 25_000;
const lockStore = {
  async getAll() {
    try {
      const cutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
      const { data, error } = await supabase.from("test_locks").select("*").gt("locked_at", cutoff);
      if (error) return {};
      const out = {};
      for (const row of data || [])
        out[row.test_id] = { userId: row.user_id, userName: row.user_name, ts: new Date(row.locked_at).getTime() };
      return out;
    } catch { return {}; }
  },
  async acquire(testId, userId, userName) {
    try {
      const cutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
      const { data: existing } = await supabase.from("test_locks").select("*").eq("test_id", testId).gt("locked_at", cutoff).maybeSingle();
      if (existing && existing.user_id !== userId) return { ok: false, by: existing.user_name };
      const { error } = await supabase.from("test_locks").upsert(
        { test_id: testId, user_id: userId, user_name: userName, locked_at: new Date().toISOString() },
        { onConflict: "test_id" }
      );
      if (error) return { ok: false, by: "unknown" };
      return { ok: true };
    } catch { return { ok: true }; }
  },
  async heartbeat(testId, userId) {
    try { await supabase.from("test_locks").update({ locked_at: new Date().toISOString() }).eq("test_id", testId).eq("user_id", userId); } catch {}
  },
  async release(testId, userId) {
    try { await supabase.from("test_locks").delete().eq("test_id", testId).eq("user_id", userId); } catch {}
  },
  async releaseAll(userId) {
    try { await supabase.from("test_locks").delete().eq("user_id", userId); } catch {}
  },
};

// ── Seed Users ───────────────────────────────────────────────────────────────────
const SEED_USERS = [
  { id: "1", username: "admin", password: "admin123", role: "admin", name: "Administrator", email: "admin@testpro.io", active: true },
  { id: "2", username: "tester1", password: "test123", role: "tester", name: "Alex Johnson", email: "alex@testpro.io", active: true },
];

function makeStep(testId, n) {
  return { id: `${testId}_s${n}`, serialNo: n, action: "", result: "", remarks: "", status: "pending", isDivider: false };
}
function makeTest(modId, n, stepCount = 0) {
  const testId = `${modId}_t${n}`;
  return { id: testId, serialNo: n, name: `Test ${n}`, description: "", steps: Array.from({ length: stepCount }, (_, i) => makeStep(testId, i + 1)) };
}
function buildModules() {
  const out = {};
  for (let m = 1; m <= 120; m++) {
    const modId = `m${m}`;
    out[modId] = { id: modId, name: `Module ${m}`, tests: Array.from({ length: 5 }, (_, i) => makeTest(modId, i + 1, 0)) };
  }
  return out;
}

// ── MUI Theme ────────────────────────────────────────────────────────────────────
const muiTheme = createTheme({
  palette: {
    primary:    { main: "#ea580c", light: "#fb923c", dark: "#c2410c", contrastText: "#fff" },
    success:    { main: "#16a34a", light: "#dcfce7", dark: "#15803d" },
    error:      { main: "#dc2626", light: "#fee2e2", dark: "#b91c1c" },
    warning:    { main: "#d97706", light: "#fef3c7", dark: "#b45309" },
    background: { default: "#fdf5ee", paper: "#ffffff" },
    text:       { primary: "#1c0f07", secondary: "#57534e", disabled: "#a8a29e" },
    divider:    "#f5dece",
  },
  typography: {
    fontFamily: "'Plus Jakarta Sans', 'Segoe UI', system-ui, -apple-system, sans-serif",
    h1: { fontWeight: 800 }, h2: { fontWeight: 700 }, h3: { fontWeight: 700 },
    h4: { fontWeight: 700 }, h5: { fontWeight: 600 }, h6: { fontWeight: 600 },
    button: { fontWeight: 600, textTransform: "none" },
  },
  shape: { borderRadius: 12 },
  shadows: [
    "none",
    "0 1px 4px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
    "0 2px 10px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04)",
    "0 4px 20px rgba(0,0,0,0.10), 0 2px 6px rgba(0,0,0,0.05)",
    "0 8px 30px rgba(0,0,0,0.12), 0 4px 10px rgba(0,0,0,0.06)",
    "0 16px 40px rgba(0,0,0,0.14), 0 6px 14px rgba(0,0,0,0.08)",
    "0 24px 56px rgba(0,0,0,0.16), 0 10px 20px rgba(0,0,0,0.09)",
    ...Array(18).fill("none"),
  ],
  transitions: {
    duration: { shortest: 120, shorter: 160, short: 220, standard: 280, complex: 400 },
    easing: { easeInOut: "cubic-bezier(0.4, 0, 0.2, 1)", sharp: "cubic-bezier(0.4, 0, 0.6, 1)" },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: `
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap');
        * { box-sizing: border-box; }
        body { -webkit-font-smoothing: antialiased; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(234,88,12,0.2); border-radius: 10px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(234,88,12,0.38); }
        button { -webkit-tap-highlight-color: transparent; }
        ::selection { background: rgba(234,88,12,0.15); }
      `,
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 10, fontWeight: 600, letterSpacing: 0,
          transition: "all 0.18s cubic-bezier(0.4,0,0.2,1)",
          "&:active": { transform: "scale(0.97)" },
        },
        contained: {
          boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
          "&:hover": { boxShadow: "0 4px 16px rgba(0,0,0,0.18)", transform: "translateY(-1px)" },
        },
        sizeSmall: { fontSize: 12, padding: "4px 12px" },
        sizeMedium: { fontSize: 13, padding: "6px 16px" },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          transition: "all 0.16s cubic-bezier(0.4,0,0.2,1)",
          "&:active": { transform: "scale(0.88)" },
        },
      },
    },
    MuiTextField: {
      defaultProps: { size: "small" },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          transition: "box-shadow 0.18s, border-color 0.18s",
          "&.Mui-focused": { boxShadow: "0 0 0 3px rgba(234,88,12,0.12)" },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 600, fontFamily: "'JetBrains Mono', monospace",
          transition: "all 0.15s cubic-bezier(0.4,0,0.2,1)",
        },
      },
    },
    MuiPaper: { defaultProps: { elevation: 0 } },
    MuiLinearProgress: {
      styleOverrides: {
        root: { borderRadius: 99, height: 5, overflow: "hidden" },
        bar: { borderRadius: 99 },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        head: { fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.8px", color: "#a8a29e", fontFamily: "'JetBrains Mono', monospace" },
        root: { borderColor: "#f5dece" },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: { transition: "all 0.16s cubic-bezier(0.4,0,0.2,1)" },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: 12, fontWeight: 500 },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: { borderRadius: 16 },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: { borderRadius: 8, fontSize: 12, fontWeight: 500 },
      },
    },
  },
});

// ── Design tokens (kept for complex components) ──────────────────────────────────
const C = {
  bg: "#fdf5ee", s1: "#ffffff", s2: "#fef9f5", s3: "#fdf0e6",
  b1: "#f5dece", b2: "#ecc9a8", ac: "#ea580c",
  gr: "#16a34a", re: "#dc2626", am: "#d97706",
  t1: "#1c0f07", t2: "#57534e", t3: "#a8a29e",
  grd: "rgba(22,163,74,0.10)", red: "rgba(220,38,38,0.10)",
  amd: "rgba(217,119,6,0.10)", acd: "rgba(234,88,12,0.10)",
};
const MONO = "'JetBrains Mono', 'Fira Code', monospace";

// ── Mobile detection ──────────────────────────────────────────────────────────────
function useIsMobile(breakpoint = 768) {
  const [mobile, setMobile] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    const handler = () => setMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [breakpoint]);
  return mobile;
}
const MobileMenuCtx = React.createContext(null);

// ── Framer Motion Variants ────────────────────────────────────────────────────────
const pageVariants = {
  initial: { opacity: 0, y: 14, scale: 0.99 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] } },
  exit:    { opacity: 0, y: -8, scale: 0.99, transition: { duration: 0.18, ease: "easeIn" } },
};
const cardVariants = {
  initial: { opacity: 0, y: 20 },
  animate: (i) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.04, type: "spring", stiffness: 320, damping: 28 },
  }),
};
const listStagger = {
  animate: { transition: { staggerChildren: 0.04 } },
};
const listItem = {
  initial: { opacity: 0, x: -12 },
  animate: { opacity: 1, x: 0, transition: { type: "spring", stiffness: 340, damping: 30 } },
};

// ── MUI Icon Map ─────────────────────────────────────────────────────────────────
const ICO_MAP = {
  check:  CheckRounded,
  x:      CloseRounded,
  upload: UploadFileRounded,
  logout: LogoutRounded,
  grid:   GridViewRounded,
  edit:   EditRounded,
  trash:  DeleteRounded,
  plus:   AddRounded,
  search: SearchRounded,
  dash:   DashboardRounded,
  report: AssessmentRounded,
  users:  PeopleRounded,
  log:    HistoryRounded,
  chevR:  ChevronRightRounded,
  chevD:  KeyboardArrowDownRounded,
  chevL:  ChevronLeftRounded,
  reset:  RefreshRounded,
  down:   FileDownloadRounded,
  bell:   NotificationsRounded,
  lock:   LockRounded,
  layers: LayersRounded,
  file:   DescriptionRounded,
  back:   ArrowBackRounded,
  audit:  HistoryRounded,
  person: PersonRounded,
  admin:  AdminPanelSettingsRounded,
  task:   TaskAltRounded,
};
function Ico({ n, s = 15, color = "currentColor" }) {
  const MuiIcon = ICO_MAP[n];
  if (MuiIcon) return <MuiIcon sx={{ fontSize: s, color, flexShrink: 0, display: "block" }} />;
  return <span style={{ width: s, height: s, flexShrink: 0, display: "inline-block" }} />;
}

// ── Toast (MUI Snackbar) ──────────────────────────────────────────────────────────
function useToast() {
  const [queue, setQueue] = useState([]);
  const push = useCallback((msg, type = "info") => {
    const id = Date.now() + Math.random();
    setQueue(q => [...q, { id, msg, type }]);
    setTimeout(() => setQueue(q => q.filter(x => x.id !== id)), 3500);
  }, []);
  const Host = () => {
    const isMobile = useIsMobile();
    return (
      <Box sx={{ position: "fixed", bottom: isMobile ? 72 : 24, right: isMobile ? 12 : 24,
        left: isMobile ? 12 : "auto", zIndex: 9999, display: "flex", flexDirection: "column", gap: 1, pointerEvents: "none" }}>
        <AnimatePresence>
          {queue.map(t => (
            <motion.div key={t.id}
              initial={{ opacity: 0, y: 24, scale: 0.88, x: isMobile ? 0 : 20 }}
              animate={{ opacity: 1, y: 0, scale: 1, x: 0 }}
              exit={{ opacity: 0, y: 8, scale: 0.94 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
            >
              <Alert severity={t.type === "info" ? "info" : t.type === "success" ? "success" : "error"}
                sx={{
                  borderRadius: 3, boxShadow: "0 8px 32px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.08)",
                  fontWeight: 600, fontSize: 13, minWidth: isMobile ? "auto" : 280,
                  backdropFilter: "blur(16px)", border: "1px solid",
                  borderColor: t.type === "success" ? "rgba(22,163,74,0.25)" : t.type === "error" ? "rgba(220,38,38,0.25)" : "rgba(234,88,12,0.25)",
                  bgcolor: t.type === "success" ? "rgba(240,253,244,0.95)" : t.type === "error" ? "rgba(254,242,242,0.95)" : "rgba(255,247,237,0.95)",
                }}
                iconMapping={{
                  success: <CheckCircleRounded sx={{ fontSize: 18 }} />,
                  error: <CancelRounded sx={{ fontSize: 18 }} />,
                  info: <NotificationsRounded sx={{ fontSize: 18 }} />,
                }}
              >
                {t.msg}
              </Alert>
            </motion.div>
          ))}
        </AnimatePresence>
      </Box>
    );
  };
  return { push, Host };
}

// ── Shared: SearchBox ─────────────────────────────────────────────────────────────
function SearchBox({ value, onChange, placeholder = "Search…", width = 200, fullWidth = false }) {
  return (
    <TextField
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      size="small"
      fullWidth={fullWidth}
      sx={{ width: fullWidth ? undefined : width }}
      InputProps={{
        startAdornment: (
          <InputAdornment position="start">
            <Ico n="search" s={14} color={C.t3} />
          </InputAdornment>
        ),
        sx: { borderRadius: 2, bgcolor: "background.paper", fontSize: 13 },
      }}
    />
  );
}

// ── Shared: Topbar ────────────────────────────────────────────────────────────────
function Topbar({ title, sub, children }) {
  const isMobile = useIsMobile();
  const onMenuClick = useContext(MobileMenuCtx);
  return (
    <AppBar position="static" elevation={0} sx={{
      bgcolor: "rgba(255,255,255,0.90)", backdropFilter: "blur(20px)",
      WebkitBackdropFilter: "blur(20px)",
      borderBottom: `1px solid rgba(245,222,206,0.8)`,
      color: "text.primary", flexShrink: 0,
      boxShadow: "0 1px 0 rgba(245,222,206,0.8), 0 4px 20px rgba(234,88,12,0.04)",
    }}>
      <Toolbar sx={{ minHeight: 58, gap: 1, px: isMobile ? 1.5 : 2.5 }}>
        {isMobile && onMenuClick && (
          <IconButton onClick={onMenuClick} size="small" sx={{ mr: 0.5, color: "text.secondary" }}>
            <MenuRounded sx={{ fontSize: 22 }} />
          </IconButton>
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body1" fontWeight={700} sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: isMobile ? 15 : 16 }}>
            {title}
          </Typography>
          {sub && (
            <Typography variant="caption" sx={{ color: "text.disabled", fontFamily: MONO, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {sub}
            </Typography>
          )}
        </Box>
        <Stack direction="row" alignItems="center" gap={1} sx={{ flexShrink: 0 }}>
          {children}
        </Stack>
      </Toolbar>
    </AppBar>
  );
}

// ── Shared: Progress Bar ──────────────────────────────────────────────────────────
function PBar({ pct, fail }) {
  return (
    <LinearProgress
      variant="determinate" value={pct}
      sx={{ height: 5, borderRadius: 99, bgcolor: C.s3,
        "& .MuiLinearProgress-bar": {
          background: fail
            ? "linear-gradient(90deg, #f59e0b, #dc2626)"
            : "linear-gradient(90deg, #22c55e, #16a34a)",
          borderRadius: 99, transition: "transform 0.6s cubic-bezier(0.4,0,0.2,1)",
        }
      }}
    />
  );
}

// ── Shared: ExportMenu ────────────────────────────────────────────────────────────
function ExportMenu({ onCSV, onPDF }) {
  const [anchor, setAnchor] = useState(null);
  return (
    <>
      <Button size="small" variant="outlined" startIcon={<FileDownloadRounded sx={{ fontSize: 15 }} />}
        onClick={e => setAnchor(e.currentTarget)}
        sx={{ borderColor: C.b2, color: "text.secondary", bgcolor: "background.paper",
          "&:hover": { borderColor: C.ac, color: "primary.main", bgcolor: alpha("#ea580c", 0.04) } }}
      >
        Export
      </Button>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}
        PaperProps={{ sx: { borderRadius: 2.5, boxShadow: "0 8px 30px rgba(0,0,0,0.12)", border: `1px solid ${C.b1}`, minWidth: 160 } }}
        transformOrigin={{ horizontal: "right", vertical: "top" }}
        anchorOrigin={{ horizontal: "right", vertical: "bottom" }}
      >
        <MenuItem onClick={() => { onCSV(); setAnchor(null); }} sx={{ gap: 1.5, fontSize: 13, borderRadius: 1.5, mx: 0.5, my: 0.25 }}>
          <FileDownloadRounded sx={{ fontSize: 16, color: C.t3 }} /> Export CSV
        </MenuItem>
        <MenuItem onClick={() => { onPDF(); setAnchor(null); }} sx={{ gap: 1.5, fontSize: 13, borderRadius: 1.5, mx: 0.5, my: 0.25 }}>
          <AssessmentRounded sx={{ fontSize: 16, color: C.t3 }} /> Export PDF
        </MenuItem>
      </Menu>
    </>
  );
}

// ── Shared: Confirm Dialog ────────────────────────────────────────────────────────
function ConfirmDialog({ open, title, description, onConfirm, onCancel, confirmLabel = "Delete", confirmColor = "error" }) {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth
      PaperProps={{ component: motion.div, initial: { scale: 0.92, opacity: 0 }, animate: { scale: 1, opacity: 1 }, transition: { duration: 0.18 }, sx: { borderRadius: 3 } }}>
      <DialogTitle sx={{ fontWeight: 700, pb: 1 }}>{title}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary">{description}</Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5, gap: 1 }}>
        <Button onClick={onCancel} variant="outlined" sx={{ borderColor: C.b2, color: "text.secondary" }}>Cancel</Button>
        <Button onClick={onConfirm} variant="contained" color={confirmColor}>{confirmLabel}</Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Shared: FormDialog ────────────────────────────────────────────────────────────
function FormDialog({ open, onClose, title, subtitle, children, actions, width = 460 }) {
  const isMobile = useIsMobile();
  return (
    <Dialog open={open} onClose={onClose} maxWidth={false} fullScreen={isMobile}
      PaperProps={{ component: motion.div, initial: { scale: 0.92, opacity: 0, y: 10 }, animate: { scale: 1, opacity: 1, y: 0 }, transition: { duration: 0.2 },
        sx: { borderRadius: isMobile ? 0 : 3, width: isMobile ? "100%" : width } }}>
      <DialogTitle sx={{ fontWeight: 700, pb: 0.5 }}>
        {title}
        {subtitle && <Typography variant="caption" display="block" color="text.secondary" sx={{ fontWeight: 400, mt: 0.5 }}>{subtitle}</Typography>}
      </DialogTitle>
      <DialogContent sx={{ pt: "8px !important" }}>{children}</DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5, gap: 1 }}>{actions}</DialogActions>
    </Dialog>
  );
}

// ── Login Page ────────────────────────────────────────────────────────────────────
function LoginPage({ users, onLogin }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const isMobile = useIsMobile();

  const go = () => {
    if (!u.trim() || !p) { setErr("Please enter your username and password."); return; }
    setLoading(true);
    setTimeout(async () => {
      const found = users.find(x => x.username === u.trim() && x.password === p && x.active);
      if (found) {
        // Set session-level GUC so RLS policies can read the role for this connection.
        await supabase.rpc("set_app_role", { p_role: found.role }).catch(() => {});
        onLogin(found);
      } else { setErr("Invalid credentials or account inactive."); setLoading(false); }
    }, 150);
  };

  return (
    <Box sx={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center",
      position: "relative", overflow: "hidden",
      background: "linear-gradient(135deg,#fde8d0 0%,#fddbb4 30%,#fef3e2 60%,#ffe0cc 80%,#fdf0dc 100%)",
      backgroundSize: "400% 400%",
      animation: "tpGradShift 12s ease infinite",
    }}>
      <style>{`
        @keyframes tpGradShift { 0%{background-position:0% 50%} 50%{background-position:100% 50%} 100%{background-position:0% 50%} }
      `}</style>

      {/* Animated orbs */}
      {[
        { top: "-15%", left: "-10%", size: 420, colors: "rgba(251,146,60,0.58),rgba(249,115,22,0.24)", duration: 14 },
        { bottom: "-12%", right: "-8%", size: 380, colors: "rgba(253,186,116,0.52),rgba(251,146,60,0.20)", duration: 17 },
        { top: "18%", right: "6%", size: 220, colors: "rgba(234,88,12,0.32),rgba(253,186,116,0.14)", duration: 11 },
        { bottom: "14%", left: "10%", size: 160, colors: "rgba(254,215,170,0.50),transparent", duration: 19 },
      ].map((orb, i) => (
        <motion.div key={i}
          style={{ position: "absolute", borderRadius: "50%", width: orb.size, height: orb.size,
            background: `radial-gradient(circle,${orb.colors})`,
            filter: `blur(${40 + i * 6}px)`, pointerEvents: "none", zIndex: 0,
            ...orb }}
          animate={{ x: [0, 30 + i * 10, -15, 0], y: [0, -20 - i * 8, 15, 0], scale: [1, 1.08, 0.95, 1] }}
          transition={{ duration: orb.duration, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}

      {/* Login Card */}
      <motion.div
        initial={{ opacity: 0, y: 32, scale: 0.94 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
        style={{ position: "relative", zIndex: 2, width: "100%", maxWidth: 420, padding: isMobile ? "0 16px" : 0 }}
      >
        {/* Glowing border ring */}
        <motion.div
          animate={{ opacity: [0.6, 1, 0.6] }}
          transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
          style={{ position: "absolute", inset: -2, borderRadius: 20,
            background: "linear-gradient(135deg,#f97316,#ea580c,#dc2626,#f97316)",
            backgroundSize: "300% 300%", filter: "blur(1px)", zIndex: -1,
            animation: "tpGradShift 5s ease infinite",
          }}
        />

        <Paper elevation={0} sx={{
          borderRadius: "18px", overflow: "hidden", position: "relative",
          bgcolor: "rgba(255,255,255,0.88)", backdropFilter: "blur(28px)",
          WebkitBackdropFilter: "blur(28px)", border: "1px solid rgba(255,255,255,0.6)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.10)",
        }}>
          {/* Shimmer sweep */}
          <motion.div
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 1,
              background: "linear-gradient(105deg,transparent 40%,rgba(255,255,255,0.45) 50%,transparent 60%)",
              pointerEvents: "none" }}
            animate={{ x: ["-120%", "220%"] }}
            transition={{ duration: 2.5, repeat: Infinity, repeatDelay: 3, ease: "easeInOut" }}
          />

          <Box sx={{ p: isMobile ? 3 : 4, position: "relative", zIndex: 2 }}>
            {/* Logo */}
            <motion.div
              animate={{ boxShadow: ["0 4px 14px rgba(234,88,12,.30)", "0 4px 28px rgba(234,88,12,.60)", "0 4px 14px rgba(234,88,12,.30)"] }}
              transition={{ duration: 2.5, repeat: Infinity }}
              style={{ display: "inline-flex", borderRadius: 16, marginBottom: 20 }}
            >
              <Box sx={{ width: 56, height: 56, borderRadius: 3.5, background: "linear-gradient(135deg,#fb923c,#ea580c)",
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: "0 4px 14px rgba(234,88,12,.30)" }}>
                <TaskAltRounded sx={{ fontSize: 30, color: "#fff" }} />
              </Box>
            </motion.div>

            <Typography variant="h5" fontWeight={800} gutterBottom>
              Sign in to <Box component="span" sx={{ color: "primary.main" }}>TestPro</Box>
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3.5 }}>
              Quality management platform
            </Typography>

            <AnimatePresence>
              {err && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                  <Alert severity="error" sx={{ mb: 2, borderRadius: 2, fontSize: 13 }}>{err}</Alert>
                </motion.div>
              )}
            </AnimatePresence>

            <Stack gap={2}>
              <TextField
                label="Username" value={u}
                onChange={e => { setU(e.target.value); setErr(""); }}
                onKeyDown={e => e.key === "Enter" && document.getElementById("tp-pw-input")?.focus()}
                fullWidth size="medium" autoComplete="username"
                sx={{ "& .MuiOutlinedInput-root": { borderRadius: 2.5 } }}
              />
              <TextField
                id="tp-pw-input"
                label="Password" type={showPw ? "text" : "password"} value={p}
                onChange={e => { setP(e.target.value); setErr(""); }}
                onKeyDown={e => e.key === "Enter" && go()}
                fullWidth size="medium" autoComplete="current-password"
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton size="small" onClick={() => setShowPw(v => !v)} edge="end">
                        {showPw ? <VisibilityOffRounded sx={{ fontSize: 18 }} /> : <VisibilityRounded sx={{ fontSize: 18 }} />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
                sx={{ "& .MuiOutlinedInput-root": { borderRadius: 2.5 } }}
              />
              <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                <Button fullWidth size="large" variant="contained" onClick={go} disabled={loading}
                  sx={{ mt: 0.5, py: 1.5, borderRadius: 2.5, fontSize: 15, fontWeight: 700, boxShadow: "0 4px 16px rgba(234,88,12,.35)" }}>
                  {loading ? <CircularProgress size={20} sx={{ color: "white" }} /> : "Sign In"}
                </Button>
              </motion.div>
            </Stack>
          </Box>
        </Paper>
      </motion.div>
    </Box>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────────
function Sidebar({ session, view, setView, modules, selMod, setSelMod, collapsed, setCollapsed, locked, mobileOpen, onMobileClose, onLogout }) {
  const isMobile = useIsMobile();
  const [search, setSearch] = useState("");

  const modList = useMemo(() => Object.values(modules || {})
    .filter(m => m.name.toLowerCase().includes(search.toLowerCase())), [modules, search]);

  const modStats = useMemo(() => {
    const out = {};
    for (const m of Object.values(modules || {})) {
      const all = m.tests.flatMap(t => t.steps);
      out[m.id] = { pass: all.filter(s => s.status === "pass").length, fail: all.filter(s => s.status === "fail").length };
    }
    return out;
  }, [modules]);

  const navItems = [
    { id: "dash", icon: "dash", label: "Dashboard" },
    { id: "report", icon: "report", label: "Test Report" },
    ...(session.role === "admin" ? [{ id: "users", icon: "users", label: "Users" }, { id: "audit", icon: "log", label: "Audit Log" }] : []),
  ];

  const navRow = (item) => {
    const active = view === item.id;
    return (
      <motion.div key={item.id} whileHover={{ x: active ? 0 : 3 }} transition={{ type: "spring", stiffness: 400, damping: 30 }}>
        <ListItemButton
          onClick={() => { setView(item.id); if (onMobileClose) onMobileClose(); }}
          sx={{
            borderRadius: 2.5, mx: 0.75, mb: 0.4, py: 0.85,
            bgcolor: active ? "primary.main" : "transparent",
            color: active ? "#fff" : "text.secondary",
            boxShadow: active ? "0 4px 14px rgba(234,88,12,0.35)" : "none",
            "&:hover": { bgcolor: active ? "primary.dark" : alpha("#000", 0.04) },
            transition: "all 0.2s cubic-bezier(0.4,0,0.2,1)",
          }}
        >
          <ListItemIcon sx={{ minWidth: collapsed && !isMobile ? 0 : 36, color: "inherit" }}>
            <Ico n={item.icon} s={18} />
          </ListItemIcon>
          {(!collapsed || isMobile) && (
            <ListItemText primary={item.label} primaryTypographyProps={{ fontSize: 13, fontWeight: active ? 700 : 500 }} />
          )}
        </ListItemButton>
      </motion.div>
    );
  };

  const drawerWidth = isMobile ? 280 : collapsed ? 60 : 256;

  const content = (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 1.5, py: 1.5, borderBottom: `1px solid ${C.b1}`, minHeight: 58, flexShrink: 0,
        background: "linear-gradient(135deg, rgba(255,247,237,0.8) 0%, rgba(255,255,255,0.9) 100%)" }}>
        <Box sx={{ width: 32, height: 32, borderRadius: 2, background: "linear-gradient(135deg,#fb923c,#ea580c)",
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          boxShadow: "0 3px 10px rgba(234,88,12,0.38)" }}>
          <TaskAltRounded sx={{ fontSize: 18, color: "#fff" }} />
        </Box>
        {(!collapsed || isMobile) && (
          <Typography fontWeight={800} sx={{ fontFamily: MONO, fontSize: 15, flex: 1, letterSpacing: "-0.5px" }}>
            Test<Box component="span" sx={{ color: "primary.main" }}>Pro</Box>
          </Typography>
        )}
        {!isMobile && (
          <IconButton size="small" onClick={() => setCollapsed(c => !c)} sx={{ ml: "auto", color: "text.disabled", "&:hover": { color: "primary.main", bgcolor: alpha("#ea580c", 0.08) } }}>
            <Ico n={collapsed ? "chevR" : "chevL"} s={16} />
          </IconButton>
        )}
      </Box>

      {/* Nav */}
      <Box sx={{ pt: 0.75, flexShrink: 0 }}>
        {(!collapsed || isMobile) && (
          <Typography variant="caption" sx={{ px: 2, fontFamily: MONO, color: "text.disabled", fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", display: "block", mb: 0.5 }}>
            Navigation
          </Typography>
        )}
        <List dense disablePadding>{navItems.map(navRow)}</List>
      </Box>

      {(!collapsed || isMobile) && (
        <>
          <Divider sx={{ my: 1, borderColor: C.b1 }} />
          {/* Module list */}
          <Typography variant="caption" sx={{ px: 2, fontFamily: MONO, color: "text.disabled", fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", display: "block", mb: 1 }}>
            Modules ({modList.length})
          </Typography>
          <Box sx={{ px: 1, mb: 1, flexShrink: 0 }}>
            <TextField value={search} onChange={e => setSearch(e.target.value)} placeholder="Search modules…"
              size="small" fullWidth
              InputProps={{
                startAdornment: <InputAdornment position="start"><Ico n="search" s={12} color={C.t3} /></InputAdornment>,
                sx: { fontSize: 12, borderRadius: 2, bgcolor: C.s2 },
              }}
            />
          </Box>

          <Box sx={{ flex: 1, overflowY: "auto", px: 0.75, pb: 1 }}>
            <motion.div variants={listStagger} initial="initial" animate="animate">
              {modList.map(m => {
                const st = modStats[m.id] || {};
                const active = selMod === m.id && view === "mod";
                return (
                  <motion.div key={m.id} variants={listItem}>
                    <ListItemButton
                      onClick={() => {
                        if (locked && !(selMod === m.id && view === "mod")) return;
                        setSelMod(m.id); setView("mod");
                        if (onMobileClose) onMobileClose();
                      }}
                      disabled={locked && !(selMod === m.id && view === "mod")}
                      sx={{
                        borderRadius: 2, mb: 0.25, py: 0.7,
                        bgcolor: active ? alpha("#ea580c", 0.10) : "transparent",
                        color: active ? "primary.main" : "text.secondary",
                        borderLeft: active ? "3px solid" : "3px solid transparent",
                        borderLeftColor: active ? "primary.main" : "transparent",
                        "&:hover": { bgcolor: active ? alpha("#ea580c", 0.12) : alpha("#000", 0.04) },
                        "&.Mui-disabled": { opacity: 0.38 },
                        transition: "all 0.16s cubic-bezier(0.4,0,0.2,1)",
                      }}
                    >
                      <ListItemIcon sx={{ minWidth: 26, color: "inherit", opacity: active ? 1 : 0.6 }}>
                        <LayersRounded sx={{ fontSize: 14 }} />
                      </ListItemIcon>
                      <ListItemText
                        primary={m.name}
                        primaryTypographyProps={{ fontSize: 12, fontWeight: active ? 700 : 400, noWrap: true }}
                      />
                      {st.fail > 0 && (
                        <Chip label={`✗${st.fail}`} size="small" sx={{ height: 17, fontSize: 9, fontFamily: MONO, bgcolor: C.red, color: C.re, ml: 0.5, border: `1px solid ${alpha(C.re, 0.25)}` }} />
                      )}
                      {!st.fail && st.pass > 0 && (
                        <CheckCircleRounded sx={{ fontSize: 14, color: C.gr, ml: 0.5 }} />
                      )}
                    </ListItemButton>
                  </motion.div>
                );
              })}
            </motion.div>
          </Box>
        </>
      )}

      {/* Footer */}
      <Box sx={{ borderTop: `1px solid ${C.b1}`, p: 1.5, flexShrink: 0, display: "flex", alignItems: "center", gap: 1.5,
        background: "linear-gradient(135deg, rgba(255,247,237,0.5) 0%, rgba(255,255,255,0.8) 100%)" }}>
        <Avatar sx={{ width: 32, height: 32, background: "linear-gradient(135deg,#ea580c,#c2410c)", color: "#fff", fontSize: 14, fontWeight: 700, boxShadow: "0 2px 8px rgba(234,88,12,0.35)" }}>
          {session.name?.[0]?.toUpperCase()}
        </Avatar>
        {(!collapsed || isMobile) && (
          <>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="caption" fontWeight={700} sx={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{session.name}</Typography>
              <Chip label={session.role} size="small" sx={{ height: 16, fontSize: 9, fontFamily: MONO, fontWeight: 700,
                bgcolor: session.role === "admin" ? alpha("#ea580c", 0.12) : C.amd,
                color: session.role === "admin" ? C.ac : C.am,
                border: `1px solid ${session.role === "admin" ? alpha("#ea580c", 0.25) : "transparent"}` }} />
            </Box>
            <Tooltip title="Logout">
              <IconButton size="small" onClick={onLogout} sx={{ color: "error.main", "&:hover": { bgcolor: alpha("#dc2626", 0.08) } }}>
                <LogoutRounded sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
          </>
        )}
      </Box>
    </Box>
  );

  if (isMobile) {
    return (
      <Drawer anchor="left" open={mobileOpen} onClose={onMobileClose}
        PaperProps={{ sx: { width: 280, bgcolor: "rgba(255,255,255,0.95)", backdropFilter: "blur(16px)" } }}>
        {content}
      </Drawer>
    );
  }

  return (
    <Box sx={{
      width: drawerWidth, flexShrink: 0, display: "flex", flexDirection: "column",
      bgcolor: "rgba(255,255,255,0.92)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
      borderRight: `1px solid rgba(245,222,206,0.8)`,
      boxShadow: "2px 0 20px rgba(234,88,12,0.04)",
      overflow: "hidden",
      transition: "width 0.25s cubic-bezier(0.4,0,0.2,1)",
    }}>
      {content}
    </Box>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────────
function Dashboard({ modules, session, onSelect }) {
  const isMobile = useIsMobile();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");

  const modList = useMemo(() => Object.values(modules), [modules]);
  const modStats = useMemo(() => modList.map(m => {
    const all = m.tests.flatMap(t => t.steps);
    const pass = all.filter(s => s.status === "pass").length;
    const fail = all.filter(s => s.status === "fail").length;
    return { ...m, pass, fail, total: all.length, testCount: m.tests.length };
  }), [modList]);

  const total = modStats.reduce((a, m) => a + m.total, 0);
  const totalPass = modStats.reduce((a, m) => a + m.pass, 0);
  const totalFail = modStats.reduce((a, m) => a + m.fail, 0);
  const pending = total - totalPass - totalFail;

  const filtered = useMemo(() => {
    let l = modStats.filter(m => m.name.toLowerCase().includes(search.toLowerCase()));
    if (filter === "active") l = l.filter(m => m.pass + m.fail > 0 && m.pass + m.fail < m.total);
    else if (filter === "pass") l = l.filter(m => m.pass === m.total && m.total > 0);
    else if (filter === "fail") l = l.filter(m => m.fail > 0);
    else if (filter === "empty") l = l.filter(m => m.total === 0 || (m.pass + m.fail === 0));
    return l;
  }, [modStats, filter, search]);

  const statCards = [
    { label: "Total Steps", value: total, color: "primary.main", bgColor: "#fff7ed", borderColor: alpha("#ea580c", 0.2), icon: <LayersRounded sx={{ fontSize: 22, color: "#ea580c" }} />, sub: `${modList.length} modules` },
    { label: "Passed", value: totalPass, color: "success.main", bgColor: "#f0fdf4", borderColor: alpha("#16a34a", 0.2), icon: <CheckCircleRounded sx={{ fontSize: 22, color: "#16a34a" }} />, sub: `${total ? Math.round((totalPass / total) * 100) : 0}% rate` },
    { label: "Failed", value: totalFail, color: "error.main", bgColor: "#fff5f5", borderColor: alpha("#dc2626", 0.2), icon: <CancelRounded sx={{ fontSize: 22, color: "#dc2626" }} />, sub: `${modStats.filter(m => m.fail > 0).length} modules` },
    { label: "Pending", value: pending, color: "warning.main", bgColor: "#fffbeb", borderColor: alpha("#d97706", 0.2), icon: <RefreshRounded sx={{ fontSize: 22, color: "#d97706" }} />, sub: `${modStats.filter(m => m.pass + m.fail === m.total && m.total > 0).length} complete` },
  ];

  return (
    <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit"
      style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      <Topbar title="Dashboard" sub={`Welcome back, ${session.name}`}>
        {!isMobile && <SearchBox value={search} onChange={setSearch} placeholder="Search modules…" />}
      </Topbar>

      <Box sx={{ flex: 1, overflowY: "auto", p: isMobile ? 1.5 : 2.5 }}>
        {/* Search on mobile */}
        {isMobile && <Box sx={{ mb: 1.5 }}><SearchBox value={search} onChange={setSearch} placeholder="Search modules…" fullWidth /></Box>}

        {/* Stat cards */}
        <Box sx={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: isMobile ? 1 : 1.5, mb: isMobile ? 2 : 2.5 }}>
          {statCards.map((card, i) => (
            <motion.div key={card.label} custom={i} variants={cardVariants} initial="initial" animate="animate">
              <motion.div whileHover={{ y: -4, boxShadow: "0 12px 32px rgba(0,0,0,0.12)" }} transition={{ type: "spring", stiffness: 360, damping: 28 }}>
                <Paper elevation={0} sx={{
                  p: isMobile ? 1.5 : 2, borderRadius: 3, overflow: "hidden",
                  border: `1px solid ${card.borderColor}`,
                  bgcolor: card.bgColor,
                  cursor: "default",
                  position: "relative",
                }}>
                  <Box sx={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, bgcolor: card.color, opacity: 0.7, borderRadius: "3px 3px 0 0" }} />
                  <Stack direction="row" alignItems="flex-start" justifyContent="space-between" mb={0.5}>
                    <Typography variant="caption" sx={{ color: "text.disabled", fontFamily: MONO, fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", display: "block" }}>
                      {card.label}
                    </Typography>
                    {!isMobile && card.icon}
                  </Stack>
                  <Typography variant="h4" fontWeight={800} sx={{ color: card.color, lineHeight: 1.1, mb: 0.5 }}>{card.value.toLocaleString()}</Typography>
                  <Typography variant="caption" sx={{ color: "text.disabled", fontFamily: MONO }}>{card.sub}</Typography>
                </Paper>
              </motion.div>
            </motion.div>
          ))}
        </Box>

        {/* Filter bar */}
        <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1} sx={{ mb: 2 }}>
          <Typography variant="body2" fontWeight={700} sx={{ color: "text.primary" }}>
            Modules{" "}
            <Box component="span" sx={{ color: "text.disabled", fontFamily: MONO, fontWeight: 400, fontSize: 12 }}>({filtered.length})</Box>
          </Typography>
          <Stack direction="row" gap={0.5} flexWrap="wrap">
            {[["all","All"],["active","In Progress"],["pass","All Pass"],["fail","Has Failures"],["empty","Not Started"]].map(([k,l]) => (
              <Chip key={k} label={l} size="small" clickable
                onClick={() => setFilter(k)}
                sx={{
                  fontFamily: MONO, fontSize: 10, height: 26,
                  bgcolor: filter === k ? "primary.main" : "transparent",
                  color: filter === k ? "#fff" : "text.secondary",
                  border: `1px solid ${filter === k ? "transparent" : C.b1}`,
                  fontWeight: filter === k ? 700 : 500,
                  boxShadow: filter === k ? "0 2px 8px rgba(234,88,12,0.30)" : "none",
                  "&:hover": { bgcolor: filter === k ? "primary.dark" : alpha("#000", 0.04) },
                  transition: "all 0.18s cubic-bezier(0.4,0,0.2,1)",
                }}
              />
            ))}
          </Stack>
        </Stack>

        {/* Module cards */}
        <Stack gap={isMobile ? 1 : 1.25}>
          {filtered.map((m, i) => {
            const pct = Math.round((m.pass / Math.max(m.total, 1)) * 100);
            const passW = m.total ? (m.pass / m.total) * 100 : 0;
            const failW = m.total ? (m.fail / m.total) * 100 : 0;
            const isDone = m.pass === m.total && m.total > 0;
            const hasFail = m.fail > 0;
            const borderColor = hasFail ? "#fca5a5" : isDone ? "#86efac" : C.b1;
            return (
              <motion.div key={m.id} custom={i} variants={cardVariants} initial="initial" animate="animate"
                whileHover={{ y: -3, boxShadow: "0 12px 32px rgba(0,0,0,0.10)" }} transition={{ type: "spring", stiffness: 360, damping: 28 }}>
                <Paper elevation={0} sx={{
                  border: `1px solid ${borderColor}`, borderRadius: 3, overflow: "hidden",
                  transition: "border-color 0.2s, box-shadow 0.2s",
                  bgcolor: hasFail ? "rgba(255,245,245,0.6)" : isDone ? "rgba(240,253,244,0.6)" : "background.paper",
                }}>
                  <Box sx={{ p: isMobile ? "12px 14px" : "14px 18px", display: "flex", alignItems: "center", gap: 1.5, cursor: "pointer" }}
                    onClick={() => onSelect(m.id)}>
                    {/* Status dot */}
                    <Box sx={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                      bgcolor: hasFail ? C.re : isDone ? C.gr : m.pass > 0 ? C.am : C.b2,
                      boxShadow: hasFail ? `0 0 0 3px ${alpha(C.re,0.15)}` : isDone ? `0 0 0 3px ${alpha(C.gr,0.15)}` : "none",
                    }} />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography fontWeight={700} sx={{ fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</Typography>
                      <Typography variant="caption" sx={{ fontFamily: MONO, color: "text.disabled" }}>
                        {m.testCount} tests · {m.total} steps
                        {m.pass > 0 && <Box component="span" sx={{ color: C.gr, ml: 1, fontWeight: 700 }}>✓{m.pass}</Box>}
                        {m.fail > 0 && <Box component="span" sx={{ color: C.re, ml: 0.5, fontWeight: 700 }}>✗{m.fail}</Box>}
                        {m.total - m.pass - m.fail > 0 && <Box component="span" sx={{ color: "text.disabled", ml: 0.5 }}>·{m.total - m.pass - m.fail}</Box>}
                      </Typography>
                    </Box>
                    <Chip label={`${pct}%`} size="small" sx={{
                      fontFamily: MONO, fontWeight: 800, fontSize: 11, height: 24,
                      bgcolor: pct === 100 ? alpha(C.gr, 0.12) : hasFail ? alpha(C.re, 0.10) : alpha("#ea580c", 0.10),
                      color: pct === 100 ? C.gr : hasFail ? C.re : "primary.main",
                      border: `1px solid ${pct === 100 ? alpha(C.gr, 0.25) : hasFail ? alpha(C.re, 0.25) : alpha("#ea580c", 0.25)}`,
                    }} />
                    <ChevronRightRounded sx={{ fontSize: 18, color: C.t3 }} />
                  </Box>
                  {/* Dual-color progress strip */}
                  <Box sx={{ height: 4, display: "flex", bgcolor: C.s3 }}>
                    <motion.div initial={{ width: 0 }} animate={{ width: `${passW}%` }} transition={{ duration: 0.7, ease: [0.4,0,0.2,1] }}
                      style={{ background: `linear-gradient(90deg, #22c55e, #16a34a)`, minWidth: 0 }} />
                    <motion.div initial={{ width: 0 }} animate={{ width: `${failW}%` }} transition={{ duration: 0.7, ease: [0.4,0,0.2,1], delay: 0.1 }}
                      style={{ background: `linear-gradient(90deg, #f87171, #dc2626)`, minWidth: 0 }} />
                  </Box>
                </Paper>
              </motion.div>
            );
          })}
          {filtered.length === 0 && (
            <Box sx={{ textAlign: "center", py: 8, color: "text.disabled" }}>
              <LayersRounded sx={{ fontSize: 40, mb: 1.5, opacity: 0.3 }} />
              <Typography sx={{ fontFamily: MONO, fontSize: 13 }}>No modules match.</Typography>
            </Box>
          )}
        </Stack>
      </Box>
    </motion.div>
  );
}

// ── Divider Row ───────────────────────────────────────────────────────────────────
function DividerRow({ label }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 0.85,
      background: "linear-gradient(90deg,#fff7ed 0%,#fef9f5 60%,rgba(255,255,255,0) 100%)",
      borderBottom: `1px solid ${C.b1}` }}>
      <Box sx={{ width: 4, height: 4, borderRadius: "50%", bgcolor: "primary.main", flexShrink: 0 }} />
      <Typography variant="caption" sx={{ fontFamily: MONO, fontWeight: 700, color: "primary.main", textTransform: "uppercase", letterSpacing: "1.5px", whiteSpace: "nowrap", fontSize: 10 }}>
        {label}
      </Typography>
      <Box sx={{ flex: 1, height: 1, background: `linear-gradient(90deg, ${C.b2} 0%, transparent 100%)` }} />
    </Box>
  );
}

// ── Step Row ──────────────────────────────────────────────────────────────────────
function StepRow({ step, idx, onChange, onStatusToggle, isActive, onActivate, rowRef }) {
  const isMobile = useIsMobile();
  const rowBg = step.status === "fail" ? "#fff5f5" : step.status === "pass" ? "#f0fdf4" : isActive ? "#fff7ed" : "transparent";

  const PassBtn = (
    <Button size="small" variant={step.status === "pass" ? "contained" : "outlined"}
      onClick={e => { e.stopPropagation(); onStatusToggle(idx, "pass"); }}
      sx={{
        borderRadius: 6, px: 1.5, py: 0.4, fontSize: 10, fontFamily: MONO, fontWeight: 700, flex: 1,
        minWidth: 0, gap: 0.4,
        ...(step.status === "pass"
          ? { bgcolor: "#16a34a", color: "#fff", borderColor: "#16a34a", boxShadow: "0 2px 8px rgba(22,163,74,.30)", "&:hover": { bgcolor: "#15803d" } }
          : { color: C.t3, borderColor: C.b2, bgcolor: "transparent", "&:hover": { bgcolor: C.grd, borderColor: "#86efac", color: C.gr } }),
      }}>
      <CheckRounded sx={{ fontSize: 12 }} /> PASS
    </Button>
  );
  const FailBtn = (
    <Button size="small" variant={step.status === "fail" ? "contained" : "outlined"}
      onClick={e => { e.stopPropagation(); onStatusToggle(idx, "fail"); }}
      sx={{
        borderRadius: 6, px: 1.5, py: 0.4, fontSize: 10, fontFamily: MONO, fontWeight: 700, flex: 1,
        minWidth: 0, gap: 0.4,
        ...(step.status === "fail"
          ? { bgcolor: "#dc2626", color: "#fff", borderColor: "#dc2626", boxShadow: "0 2px 8px rgba(220,38,38,.30)", "&:hover": { bgcolor: "#b91c1c" } }
          : { color: C.t3, borderColor: C.b2, bgcolor: "transparent", "&:hover": { bgcolor: C.red, borderColor: "#fca5a5", color: C.re } }),
      }}>
      <CloseRounded sx={{ fontSize: 12 }} /> FAIL
    </Button>
  );

  if (isMobile) {
    return (
      <motion.div ref={rowRef} onClick={onActivate} layout
        style={{ borderBottom: `1px solid ${C.b1}`, background: rowBg, padding: "10px 12px",
          outline: isActive ? `2px solid ${C.ac}` : "none", outlineOffset: -2 }}>
        <Stack direction="row" alignItems="center" gap={1} mb={1}>
          <Typography variant="caption" sx={{ fontFamily: MONO, fontWeight: 700, color: C.t3, minWidth: 28 }}>
            {isActive && <Box component="span" sx={{ color: "primary.main", mr: 0.3 }}>●</Box>}
            {step.serialNo != null && step.serialNo !== "" ? `#${step.serialNo}` : "—"}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Stack direction="row" gap={0.75} sx={{ width: 160 }}>{PassBtn}{FailBtn}</Stack>
        </Stack>
        {step.action
          ? <Typography variant="body2" sx={{ lineHeight: 1.6, mb: 0.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{step.action}</Typography>
          : <Typography variant="caption" sx={{ color: C.t3, fontStyle: "italic", fontFamily: MONO, display: "block", mb: 0.5 }}>No action</Typography>}
        {step.result && (
          <Box sx={{ pl: 1, borderLeft: `2px solid ${C.b2}`, mb: 0.75 }}>
            <Typography variant="caption" sx={{ fontFamily: MONO, color: C.t3, display: "block", mb: 0.3 }}>Expected</Typography>
            <Typography variant="caption" sx={{ color: C.t2, lineHeight: 1.5, display: "block", whiteSpace: "pre-wrap" }}>{step.result}</Typography>
          </Box>
        )}
        <TextField
          value={step.remarks} multiline rows={2} placeholder="Add remarks…" fullWidth size="small"
          onChange={e => onChange(idx, "remarks", e.target.value)}
          onClick={e => e.stopPropagation()}
          InputProps={{ sx: { fontSize: 12, bgcolor: C.s2, borderRadius: 1.5 } }}
        />
      </motion.div>
    );
  }

  // Desktop grid row
  const cell = (text, color) => (
    <Box sx={{ p: "7px 10px", display: "flex", alignItems: "flex-start", borderRight: `1px solid ${C.b1}`, minHeight: 42 }}>
      {text
        ? <Typography variant="caption" sx={{ color, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12 }}>{text}</Typography>
        : <Typography variant="caption" sx={{ color: C.t3, fontStyle: "italic", fontFamily: MONO }}>—</Typography>}
    </Box>
  );

  return (
    <motion.div ref={rowRef} onClick={onActivate} layout
      style={{ display: "grid", gridTemplateColumns: "50px 1fr 1fr 180px 110px",
        borderBottom: `1px solid ${C.b1}`, background: rowBg,
        outline: isActive ? `2px solid ${C.ac}` : "none", outlineOffset: -2, cursor: "default" }}>
      <Box sx={{ p: "7px 10px", display: "flex", alignItems: "center", justifyContent: "center", borderRight: `1px solid ${C.b1}` }}>
        {isActive && <Box sx={{ width: 4, height: 4, borderRadius: "50%", bgcolor: "primary.main", mr: 0.5, flexShrink: 0 }} />}
        <Typography variant="caption" sx={{ fontFamily: MONO, fontWeight: 600, color: step.serialNo != null ? C.t2 : C.t3, fontSize: 12 }}>
          {step.serialNo != null && step.serialNo !== "" ? step.serialNo : "—"}
        </Typography>
      </Box>
      {cell(step.action, C.t1)}
      {cell(step.result, C.t2)}
      <Box sx={{ p: "4px 8px", borderRight: `1px solid ${C.b1}` }}>
        <TextField
          value={step.remarks} multiline rows={2} placeholder="Remarks…" fullWidth
          onChange={e => onChange(idx, "remarks", e.target.value)}
          onClick={e => e.stopPropagation()}
          variant="standard"
          InputProps={{ disableUnderline: true, sx: { fontSize: 12, color: C.t2, bgcolor: "transparent" } }}
        />
      </Box>
      <Box sx={{ p: "6px 8px", display: "flex", flexDirection: "column", alignItems: "stretch", justifyContent: "center", gap: 0.5 }}>
        {PassBtn}{FailBtn}
      </Box>
    </motion.div>
  );
}

// ── Test Detail ────────────────────────────────────────────────────────────────────
function TestDetail({ mod, test, testIdx, allModules, session, saveMods, addLog, toast, onBack, onFinish, modIdx, modTotal, onNav, navLocked }) {
  const isAdmin = session.role === "admin";
  const isMobile = useIsMobile();
  const [steps, setSteps] = useState(test.steps);
  const [search, setSearch] = useState("");
  const [fStat, setFStat] = useState("all");
  const [activeIdx, setActiveIdx] = useState(0);
  const rowRefs = useRef({});
  const tableRef = useRef();
  const localCommitRef = useRef(false);
  const stepsTimerRef = useRef(null);
  const latestStepsRef = useRef(test.steps);

  useEffect(() => {
    setSteps(test.steps);
    const firstPending = test.steps.findIndex(s => !s.isDivider && s.status === "pending");
    setActiveIdx(firstPending >= 0 ? firstPending : 0);
    localCommitRef.current = false;
  }, [test.id]); // eslint-disable-line

  const testStepsFingerprint = useMemo(
    () => test.steps.map(s => s.id + ":" + s.status + ":" + (s.remarks || "")).join("|"),
    [test.steps] // eslint-disable-line
  );
  useEffect(() => {
    if (localCommitRef.current) { localCommitRef.current = false; return; }
    setSteps(test.steps);
  }, [testStepsFingerprint]); // eslint-disable-line

  useEffect(() => {
    const el = rowRefs.current[activeIdx]; const container = tableRef.current;
    if (!el || !container) return;
    const t = setTimeout(() => {
      const elRect = el.getBoundingClientRect(); const ctRect = container.getBoundingClientRect();
      const relTop = elRect.top - ctRect.top;
      if (relTop < 0 || relTop > container.clientHeight * 0.35) {
        container.scrollTo({ top: Math.max(0, container.scrollTop + relTop - 60), behavior: "smooth" });
      }
    }, 30);
    return () => clearTimeout(t);
  }, [activeIdx]);

  useEffect(() => {
    latestStepsRef.current = test.steps;
    if (stepsTimerRef.current) { clearTimeout(stepsTimerRef.current); stepsTimerRef.current = null; }
  }, [test.id]); // eslint-disable-line

  const commit = useCallback((newSteps, changedStepId = null) => {
    localCommitRef.current = true;
    const updTest = { ...test, steps: newSteps };
    const updTests = mod.tests.map((t, i) => i === testIdx ? updTest : t);
    saveMods({ ...allModules, [mod.id]: { ...mod, tests: updTests } });
    latestStepsRef.current = newSteps;
    if (stepsTimerRef.current) clearTimeout(stepsTimerRef.current);
    stepsTimerRef.current = setTimeout(() => {
      if (isAdmin) {
        store.saveSteps(test.id, mod.id, latestStepsRef.current, {
          moduleName: mod.name, serialNo: test.serialNo ?? test.serial_no ?? 0,
          name: test.name, description: test.description ?? "",
        }).catch(e => console.error("saveSteps error:", e));
      } else {
        // Tester: only persist the remarks/status of the one step that changed.
        const changedStep = changedStepId
          ? latestStepsRef.current.find(s => s.id === changedStepId)
          : null;
        if (changedStep && !changedStep.isDivider) {
          store.updateStepRemarksStatus(changedStep)
            .catch(e => console.error("updateStepRemarksStatus error:", e));
        }
      }
    }, 400);
  }, [mod, test, testIdx, allModules, saveMods, isAdmin]);

  const setField = (i, f, v) => { const ns = [...steps]; ns[i] = { ...ns[i], [f]: v }; setSteps(ns); commit(ns, ns[i].id); };

  const setStatusToggle = (i, status) => {
    const ns = [...steps]; const newStatus = ns[i].status === status ? "pending" : status;
    ns[i] = { ...ns[i], status: newStatus }; setSteps(ns); commit(ns, ns[i].id);
    if (newStatus !== "pending") {
      addLog({ ts: Date.now(), user: session.name, action: `${mod.name} › ${test.name} · Step ${ns[i].serialNo} → ${newStatus.toUpperCase()}`, type: newStatus });
    }
    if (newStatus !== "pending") {
      const updVisible = ns.map((s, idx) => ({ ...s, _i: idx })).filter(s => {
        if (s.isDivider) return false;
        if (fStat !== "all" && s.status !== fStat) return false;
        if (search) { const q = search.toLowerCase(); return (s.action||"").toLowerCase().includes(q)||(s.result||"").toLowerCase().includes(q)||(s.remarks||"").toLowerCase().includes(q)||String(s.serialNo).includes(q); }
        return true;
      });
      const curPos = updVisible.findIndex(s => s._i === i);
      const nextPending = updVisible.slice(curPos + 1).find(s => s.status === "pending");
      if (nextPending) setActiveIdx(nextPending._i);
      else { const fp = updVisible.find(s => s.status === "pending"); if (fp) setActiveIdx(fp._i); }
    }
  };

  const exportCSV = () => {
    const rows = [["Serial No", "Action", "Result", "Remarks", "Status"]];
    steps.forEach(s => {
      if (s.isDivider) rows.push([`"$$$${s.action}"`, "", "", "", ""]);
      else rows.push([s.serialNo, `"${s.action}"`, `"${s.result}"`, `"${s.remarks}"`, s.status]);
    });
    const b = new Blob([rows.map(r => r.join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(b);
    a.download = `${mod.name}_${test.name}.csv`.replace(/\s+/g, "_"); a.click();
    toast("CSV exported", "success");
  };

  const exportPDF = () => {
    const sc = s => s === "pass" ? "#16a34a" : s === "fail" ? "#dc2626" : "#9ca3af";
    const sb = s => s === "pass" ? "#f0fdf4" : s === "fail" ? "#fff5f5" : "#ffffff";
    const stepRows = steps.map(s => s.isDivider
      ? `<tr><td colspan="5" style="padding:6px 12px;background:#fff7ed;font-size:11px;font-family:monospace;font-weight:700;color:#ea580c;text-transform:uppercase;letter-spacing:1px">${s.action}</td></tr>`
      : `<tr style="background:${sb(s.status)}">
          <td style="padding:5px 8px;border:1px solid #e5e7eb;font-family:monospace;font-size:11px;text-align:center">${s.serialNo||"—"}</td>
          <td style="padding:5px 8px;border:1px solid #e5e7eb;font-size:12px">${s.action||""}</td>
          <td style="padding:5px 8px;border:1px solid #e5e7eb;font-size:12px;color:#4b5563">${s.result||""}</td>
          <td style="padding:5px 8px;border:1px solid #e5e7eb;font-size:12px;color:#6b7280">${s.remarks||""}</td>
          <td style="padding:5px 8px;border:1px solid #e5e7eb;font-family:monospace;font-size:10px;font-weight:700;text-align:center;color:${sc(s.status)}">${s.status.toUpperCase()}</td>
        </tr>`
    ).join("");
    const pass = steps.filter(s => !s.isDivider && s.status === "pass").length;
    const fail = steps.filter(s => !s.isDivider && s.status === "fail").length;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${mod.name} — ${test.name}</title>
      <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;color:#111;padding:28px;font-size:14px}h1{font-size:20px;font-weight:700;margin-bottom:4px}.meta{font-family:monospace;font-size:11px;color:#6b7280;margin-bottom:20px}@page{margin:14mm}@media print{body{padding:0}}</style></head>
      <body><h1>${mod.name} › ${test.name}</h1><div class="meta">✓${pass} ✗${fail} ⟳${steps.length-pass-fail} · Generated ${new Date().toLocaleString()}</div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          ${["S.No","Action","Expected Result","Remarks","Status"].map(h=>`<th style="padding:6px 8px;background:#f9fafb;border:1px solid #e5e7eb;font-size:10px;font-family:monospace;text-transform:uppercase;letter-spacing:1px;color:#6b7280">${h}</th>`).join("")}
        </tr></thead><tbody>${stepRows}</tbody>
      </table></body></html>`;
    const w = window.open("", "_blank"); w.document.write(html); w.document.close();
    w.focus(); setTimeout(() => w.print(), 500); toast("PDF ready", "info");
  };

  const realSteps = steps.filter(s => !s.isDivider);
  const pass = realSteps.filter(s => s.status === "pass").length;
  const fail = realSteps.filter(s => s.status === "fail").length;
  const pending = realSteps.filter(s => s.status === "pending").length;
  const pct = realSteps.length ? Math.round((pass / realSteps.length) * 100) : 0;

  const visible = steps.map((s, i) => ({ ...s, _i: i })).filter(s => {
    if (s.isDivider) return true;
    if (fStat !== "all" && s.status !== fStat) return false;
    if (search) { const q = search.toLowerCase(); return (s.action||"").toLowerCase().includes(q)||(s.result||"").toLowerCase().includes(q)||(s.remarks||"").toLowerCase().includes(q)||String(s.serialNo).includes(q); }
    return true;
  });

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      {/* Header */}
      <Box sx={{ flexShrink: 0, bgcolor: "background.paper", borderBottom: `1px solid ${C.b1}` }}>
        {/* Row 1: title + nav */}
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: isMobile ? 1.5 : 2.5, py: 1, minHeight: 52 }}>
          <Tooltip title="Back to tests">
            <IconButton size="small" onClick={onBack} sx={{ color: "text.secondary" }}>
              <Ico n="back" s={16} />
            </IconButton>
          </Tooltip>
          <Box sx={{ flex: 1, display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
            <Typography fontWeight={700} sx={{ fontSize: isMobile ? 14 : 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {test.name}
            </Typography>
          </Box>
          {/* Progress pill */}
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexShrink: 0, bgcolor: C.s2, border: `1px solid ${C.b1}`, borderRadius: 5, px: 1.5, py: 0.5 }}>
            {!isMobile && (
              <>
                <Typography variant="caption" sx={{ fontFamily: MONO, fontWeight: 700, color: C.gr }}>{pass}✓</Typography>
                {fail > 0 && <Typography variant="caption" sx={{ fontFamily: MONO, fontWeight: 700, color: C.re }}>{fail}✗</Typography>}
                <Typography variant="caption" sx={{ fontFamily: MONO, color: C.t3 }}>{pending}…</Typography>
                <Box sx={{ width: 1, height: 12, bgcolor: C.b2 }} />
              </>
            )}
            <Typography variant="caption" sx={{ fontFamily: MONO, fontWeight: 800, color: pct === 100 ? C.gr : fail > 0 ? C.re : "primary.main" }}>
              {pct}%
            </Typography>
          </Box>
          {/* Module nav */}
          {!isMobile && modIdx !== undefined && (
            <Stack direction="row" alignItems="center" gap={0.5} sx={{ flexShrink: 0 }}>
              <IconButton size="small" onClick={() => !navLocked && onNav?.(-1)} disabled={modIdx === 0 || navLocked} sx={{ opacity: navLocked ? 0.4 : 1 }}>
                <Ico n="chevL" s={14} />
              </IconButton>
              <Typography variant="caption" sx={{ fontFamily: MONO, color: C.t3, whiteSpace: "nowrap", mx: 0.25 }}>{modIdx + 1}/{modTotal}</Typography>
              <IconButton size="small" onClick={() => !navLocked && onNav?.(1)} disabled={modIdx === modTotal - 1 || navLocked} sx={{ opacity: navLocked ? 0.4 : 1 }}>
                <Ico n="chevR" s={14} />
              </IconButton>
            </Stack>
          )}
        </Box>

        {/* Row 2: description + progress bar */}
        <Box sx={{ px: isMobile ? 1.5 : 2.5, py: 0.75, display: "flex", alignItems: "center", gap: 1.5, bgcolor: C.s2, borderBottom: `1px solid ${C.b1}` }}>
          <Typography variant="body2" sx={{ flex: 1, fontSize: 12, color: test.description ? C.t2 : C.t3, fontStyle: test.description ? "normal" : "italic" }}>
            {test.description || "No description"}
          </Typography>
          <Box sx={{ width: isMobile ? 80 : 120, flexShrink: 0 }}>
            <PBar pct={pct} fail={fail > 0} />
          </Box>
        </Box>

        {/* Row 3: action buttons */}
        <Box sx={{ px: isMobile ? 1.5 : 2.5, py: 1, display: "flex", alignItems: "center", gap: 1, flexWrap: isMobile ? "wrap" : "nowrap" }}>
          <ExportMenu onCSV={exportCSV} onPDF={exportPDF} />
          {!isAdmin && onFinish && (
            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} style={{ marginLeft: "auto", display: isMobile ? "block" : undefined, flex: isMobile ? 1 : undefined }}>
              <Button variant="contained" color="success" size={isMobile ? "medium" : "small"}
                startIcon={<Ico n="check" s={13} />}
                onClick={() => { commit(steps); addLog({ ts: Date.now(), user: session.name, action: `Finished ${mod.name} › ${test.name}`, type: "info" }); toast("Test finished — progress saved & lock released", "success"); onFinish(steps); }}
                sx={{ fontWeight: 700, boxShadow: "0 3px 10px rgba(22,163,74,.28)", ...(isMobile ? { width: "100%", py: 1.2, fontSize: 14 } : {}) }}>
                Finish Test
              </Button>
            </motion.div>
          )}
        </Box>
      </Box>

      {/* Filter bar */}
      <Box sx={{ px: isMobile ? 1.5 : 2, py: 1, bgcolor: "background.paper", borderBottom: `1px solid ${C.b1}`,
        display: "flex", alignItems: isMobile ? "flex-start" : "center", flexDirection: isMobile ? "column" : "row", gap: 1, flexShrink: 0 }}>
        <Stack direction="row" gap={0.5} flexWrap="wrap" sx={{ flex: 1 }}>
          {[["all","All",realSteps.length],["pass","Pass",pass],["fail","Fail",fail],["pending","Pending",pending]].map(([k,l,c]) => (
            <Chip key={k} label={`${l} (${c})`} size="small" clickable onClick={() => setFStat(k)}
              sx={{ fontFamily: MONO, fontSize: isMobile ? 11 : 10, height: isMobile ? 26 : 22,
                bgcolor: fStat === k ? C.s3 : "transparent", color: fStat === k ? C.t1 : C.t2,
                border: `1px solid ${fStat === k ? C.b2 : C.b1}`, fontWeight: fStat === k ? 700 : 400,
              }}
            />
          ))}
          <SearchBox value={search} onChange={setSearch} placeholder="Search steps…" width={isMobile ? "100%" : 170} fullWidth={isMobile} />
        </Stack>
      </Box>

      {/* Step Table */}
      <Box ref={tableRef} sx={{ flex: 1, overflowY: "auto", overflowX: isMobile ? "hidden" : "auto" }}>
        <Box sx={{ minWidth: isMobile ? undefined : 680 }}>
          {!isMobile && (
            <Box sx={{ display: "grid", gridTemplateColumns: "50px 1fr 1fr 180px 110px",
              bgcolor: "rgba(246,248,250,0.95)", backdropFilter: "blur(10px)",
              borderBottom: `1px solid ${C.b2}`, position: "sticky", top: 0, zIndex: 2 }}>
              {["S.No", "Action", "Expected Result", "Remarks", "Status"].map((h, i) => (
                <Typography key={i} variant="caption" sx={{ p: "8px 10px", fontFamily: MONO, textTransform: "uppercase", letterSpacing: "1px", color: C.t3, borderRight: i < 4 ? `1px solid ${C.b1}` : "none", display: "block" }}>
                  {h}
                </Typography>
              ))}
            </Box>
          )}
          {visible.length === 0 && (
            <Box sx={{ textAlign: "center", py: 6, color: "text.disabled", fontFamily: MONO, fontSize: 12 }}>
              {steps.length === 0 ? "No steps available." : "No steps match."}
            </Box>
          )}
          {visible.map(s => s.isDivider ? <DividerRow key={s.id} label={s.action} /> : (
            <StepRow key={s.id} step={s} idx={s._i} onChange={setField} onStatusToggle={setStatusToggle}
              isActive={activeIdx === s._i} onActivate={() => setActiveIdx(s._i)}
              rowRef={el => { rowRefs.current[s._i] = el; }}
            />
          ))}
        </Box>
      </Box>
    </Box>
  );
}

// ── Module View ────────────────────────────────────────────────────────────────────
function ModuleView({ mod, allModules, session, saveMods, addLog, toast, onNav, onLockChange, modIdx, modTotal }) {
  const isAdmin = session.role === "admin";
  const isMobile = useIsMobile();
  const [selTestIdx, setSelTestIdx] = useState(null);
  const [search, setSearch] = useState("");
  const [locks, setLocks] = useState({});
  const activeTestIdRef = useRef(null);
  const selTestIdxRef = useRef(null);
  const modTestsRef = useRef(mod.tests);
  selTestIdxRef.current = selTestIdx;
  modTestsRef.current = mod.tests;
  const [uiLocked, setUiLocked] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => { const l = await lockStore.getAll(); if (alive) setLocks(l); };
    poll(); const id = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    if (isAdmin || selTestIdx === null) return;
    const test = mod.tests[selTestIdx]; if (!test) return;
    const beat = setInterval(() => lockStore.heartbeat(test.id, session.id), HEARTBEAT_MS);
    return () => clearInterval(beat);
  }, [selTestIdx, isAdmin]); // eslint-disable-line

  useEffect(() => {
    if (isAdmin) return;
    const onUnload = () => {
      const testId = activeTestIdRef.current; if (!testId) return;
      try {
        const baseUrl = supabase.supabaseUrl || supabase.storageUrl?.replace("/storage/v1", "") || "";
        if (baseUrl) {
          const url = `${baseUrl}/rest/v1/test_locks?test_id=eq.${encodeURIComponent(testId)}&user_id=eq.${encodeURIComponent(session.id)}`;
          const sent = navigator.sendBeacon(url + "&_method=DELETE", null);
          if (!sent) lockStore.release(testId, session.id);
        } else lockStore.release(testId, session.id);
      } catch { lockStore.release(testId, session.id); }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [isAdmin, session.id]);

  useEffect(() => {
    const testId = activeTestIdRef.current;
    if (!isAdmin && testId) { lockStore.release(testId, session.id); activeTestIdRef.current = null; if (onLockChange) onLockChange(false); setUiLocked(false); }
    setSelTestIdx(null); setSearch("");
  }, [mod.id]); // eslint-disable-line

  const openTest = async (idx) => {
    const test = mod.tests[idx]; if (!test) return;
    if (!isAdmin) {
      const result = await lockStore.acquire(test.id, session.id, session.name);
      if (!result.ok) { toast(`"${test.name}" is in use by ${result.by}`, "error"); return; }
      activeTestIdRef.current = test.id; setUiLocked(true); if (onLockChange) onLockChange(true);
    }
    setSelTestIdx(idx);
  };

  const finishTest = async (newSteps) => {
    const testId = activeTestIdRef.current;
    if (testId) { await lockStore.release(testId, session.id); activeTestIdRef.current = null; }
    setUiLocked(false); if (onLockChange) onLockChange(false); setSelTestIdx(null);
  };

  const filtered = useMemo(() => {
    if (!search) return mod.tests.map((t, i) => ({ ...t, _i: i }));
    const q = search.toLowerCase();
    return mod.tests.map((t, i) => ({ ...t, _i: i })).filter(t => t.name.toLowerCase().includes(q) || (t.description || "").toLowerCase().includes(q));
  }, [mod.tests, search]);

  if (selTestIdx !== null && mod.tests[selTestIdx]) {
    return (
      <TestDetail
        mod={mod} test={mod.tests[selTestIdx]} testIdx={selTestIdx} allModules={allModules}
        session={session} saveMods={saveMods} addLog={addLog} toast={toast}
        onBack={() => setSelTestIdx(null)} onFinish={!isAdmin ? finishTest : undefined}
        modIdx={modIdx} modTotal={modTotal} onNav={onNav} navLocked={uiLocked}
      />
    );
  }

  return (
    <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit"
      style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      <Topbar
        title={mod.name}
        sub={`${mod.tests.length} tests · ${mod.tests.flatMap(t => t.steps).filter(s => s.status === "pass").length} passed`}
      >
        {!isMobile && <SearchBox value={search} onChange={setSearch} placeholder="Search tests…" width={190} />}
        {!isMobile && modIdx !== undefined && (
          <Stack direction="row" alignItems="center" gap={0.5}>
            <IconButton size="small" onClick={() => onNav?.(-1)} disabled={modIdx === 0 || uiLocked}><Ico n="chevL" s={14} /></IconButton>
            <Typography variant="caption" sx={{ fontFamily: MONO, color: C.t3 }}>{modIdx+1}/{modTotal}</Typography>
            <IconButton size="small" onClick={() => onNav?.(1)} disabled={modIdx === modTotal - 1 || uiLocked}><Ico n="chevR" s={14} /></IconButton>
          </Stack>
        )}
      </Topbar>

      {isMobile && (
        <Box sx={{ p: 1.5, borderBottom: `1px solid ${C.b1}`, bgcolor: "background.paper", flexShrink: 0 }}>
          <SearchBox value={search} onChange={setSearch} placeholder="Search tests…" fullWidth />
        </Box>
      )}

      <Box sx={{ flex: 1, overflowY: "auto", p: isMobile ? 1.5 : 2 }}>
        <Stack gap={isMobile ? 1 : 1.25}>
          {filtered.map((t, i) => {
            const realIdx = t._i;
            const pass = t.steps.filter(s => s.status === "pass").length;
            const fail = t.steps.filter(s => s.status === "fail").length;
            const pending = t.steps.filter(s => !s.isDivider && s.status === "pending").length;
            const pct = t.steps.length ? Math.round((pass / Math.max(t.steps.filter(s => !s.isDivider).length, 1)) * 100) : 0;
            const lock = locks[t.id];
            const lockedByOther = lock && lock.userId !== session.id;
            const isMyLockedTest = !isAdmin && activeTestIdRef.current === t.id;
            const blockedByMyLock = !isAdmin && uiLocked && !isMyLockedTest;
            const cardBlocked = lockedByOther || blockedByMyLock;
            const passW = t.steps.length ? (pass / Math.max(t.steps.filter(s => !s.isDivider).length, 1)) * 100 : 0;
            const failW = t.steps.length ? (fail / Math.max(t.steps.filter(s => !s.isDivider).length, 1)) * 100 : 0;

            const borderColor = lockedByOther ? "#fde68a" : isMyLockedTest ? "#86efac" : blockedByMyLock ? C.b1 : fail > 0 ? "#fca5a5" : pass > 0 && pass === t.steps.filter(s => !s.isDivider).length ? "#bbf7d0" : C.b1;
            const bgColor = lockedByOther ? "#fefce8" : isMyLockedTest ? "#f0fdf4" : blockedByMyLock ? "#f8fafc" : "background.paper";

            return (
              <motion.div key={t.id} custom={i} variants={cardVariants} initial="initial" animate="animate"
                whileHover={!cardBlocked ? { y: -3, boxShadow: "0 10px 28px rgba(0,0,0,0.09)" } : {}} transition={{ type: "spring", stiffness: 360, damping: 28 }}>
                <Paper elevation={0} sx={{ border: `1px solid ${borderColor}`, borderRadius: 3, overflow: "hidden",
                  bgcolor: bgColor, opacity: lockedByOther ? 0.88 : blockedByMyLock ? 0.5 : 1,
                  cursor: cardBlocked ? "not-allowed" : "pointer",
                  transition: "border-color 0.2s, box-shadow 0.2s, opacity 0.2s" }}
                  onClick={() => !cardBlocked && openTest(realIdx)}>
                  <Box sx={{ p: isMobile ? "12px 14px" : "14px 18px", display: "flex", alignItems: isMobile ? "flex-start" : "center", gap: isMobile ? 1 : 1.5, flexDirection: isMobile ? "column" : "row" }}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, width: "100%" }}>
                      {/* Serial badge */}
                      <Box sx={{ width: 38, height: 38, borderRadius: 2.5, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                        background: lockedByOther ? "linear-gradient(135deg,#fef9c3,#fef3c7)" : isMyLockedTest ? "linear-gradient(135deg,#dcfce7,#bbf7d0)" : "linear-gradient(135deg,#fef3e2,#fde8d0)",
                        border: `1.5px solid ${lockedByOther ? "#fcd34d" : isMyLockedTest ? "#86efac" : C.b2}`,
                        fontFamily: MONO, fontSize: 14, fontWeight: 800,
                        color: lockedByOther ? C.am : isMyLockedTest ? C.gr : C.t2,
                        boxShadow: isMyLockedTest ? "0 2px 8px rgba(22,163,74,0.20)" : "none",
                      }}>
                        {lockedByOther ? <LockRounded sx={{ fontSize: 17 }} /> : isMyLockedTest ? <CheckCircleRounded sx={{ fontSize: 17 }} /> : t.serialNo}
                      </Box>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography fontWeight={700} sx={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</Typography>
                        {(lock && lock.userId !== session.id || isMyLockedTest) && (
                          <Box mt={0.3}>
                            {lockedByOther && <Chip icon={<LockRounded sx={{ fontSize: 11, ml: "6px !important" }} />} label={`In use by ${lock.userName}`} size="small" sx={{ fontSize: 10, height: 20, bgcolor: "#fef3c7", color: C.am, fontFamily: MONO, fontWeight: 700, border: `1px solid #fcd34d` }} />}
                            {isMyLockedTest && <Chip icon={<TaskAltRounded sx={{ fontSize: 11, ml: "6px !important" }} />} label="Your active test" size="small" sx={{ fontSize: 10, height: 20, bgcolor: "#dcfce7", color: C.gr, fontFamily: MONO, fontWeight: 700, border: `1px solid #86efac` }} />}
                          </Box>
                        )}
                        {t.description && <Typography variant="caption" sx={{ color: C.t2, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.description}</Typography>}
                        <Typography variant="caption" sx={{ fontFamily: MONO, color: C.t3 }}>
                          {t.steps.length} steps
                          {pass > 0 && <Box component="span" sx={{ color: C.gr, ml: 0.75, fontWeight: 700 }}>· {pass}✓</Box>}
                          {fail > 0 && <Box component="span" sx={{ color: C.re, ml: 0.5, fontWeight: 700 }}>{fail}✗</Box>}
                          {pending > 0 && <Box component="span" sx={{ color: C.t3, ml: 0.5 }}>{pending} pending</Box>}
                        </Typography>
                      </Box>
                      <Stack direction="row" gap={0.75} sx={{ flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                        {lockedByOther ? (
                          <Button size="small" variant="outlined" disabled sx={{ borderColor: "#fcd34d", color: C.am, borderRadius: 2 }}>
                            <LockRounded sx={{ fontSize: 13 }} />{!isMobile && <Box component="span" sx={{ ml: 0.5 }}>Locked</Box>}
                          </Button>
                        ) : isMyLockedTest ? (
                          <Button size="small" variant="contained" color="success" onClick={() => openTest(realIdx)} sx={{ borderRadius: 2 }}
                            startIcon={<ArrowBackRounded sx={{ fontSize: 14 }} />}>
                            Return
                          </Button>
                        ) : blockedByMyLock ? (
                          <Button size="small" variant="outlined" disabled sx={{ opacity: 0.4, borderRadius: 2 }}><LockRounded sx={{ fontSize: 13 }} /></Button>
                        ) : (
                          <Button size="small" variant="contained" onClick={() => openTest(realIdx)}
                            endIcon={<ChevronRightRounded sx={{ fontSize: 15 }} />} sx={{ borderRadius: 2, px: 1.5 }}>
                            {!isMobile && "Open"}
                          </Button>
                        )}
                      </Stack>
                      {!isMobile && (
                        <Box sx={{ width: 80, flexShrink: 0 }}>
                          <PBar pct={pct} fail={fail > 0} />
                          <Typography variant="caption" sx={{ fontFamily: MONO, color: C.t3, display: "block", textAlign: "right", mt: 0.25 }}>{pct}%</Typography>
                        </Box>
                      )}
                    </Box>
                  </Box>
                  <Box sx={{ height: 4, display: "flex", bgcolor: C.s3 }}>
                    <motion.div initial={{ width: 0 }} animate={{ width: `${passW}%` }} transition={{ duration: 0.65, ease: [0.4,0,0.2,1] }}
                      style={{ background: "linear-gradient(90deg, #22c55e, #16a34a)", minWidth: 0 }} />
                    <motion.div initial={{ width: 0 }} animate={{ width: `${failW}%` }} transition={{ duration: 0.65, ease: [0.4,0,0.2,1], delay: 0.1 }}
                      style={{ background: "linear-gradient(90deg, #f87171, #dc2626)", minWidth: 0 }} />
                  </Box>
                </Paper>
              </motion.div>
            );
          })}
          {filtered.length === 0 && (
            <Box sx={{ textAlign: "center", py: 8, color: "text.disabled" }}>
              <DescriptionRounded sx={{ fontSize: 40, mb: 1.5, opacity: 0.3 }} />
              <Typography sx={{ fontFamily: MONO, fontSize: 12 }}>No tests match.</Typography>
            </Box>
          )}
        </Stack>
      </Box>
    </motion.div>
  );
}

// ── Report View ────────────────────────────────────────────────────────────────────
function ReportView({ modules, toast }) {
  const isMobile = useIsMobile();
  const [search, setSearch] = useState("");
  const [failOnly, setFailOnly] = useState(false);
  const [exp, setExp] = useState(new Set());
  const modList = useMemo(() => Object.values(modules), [modules]);

  const modStats = useMemo(() => modList.map(m => {
    const all = m.tests.flatMap(t => t.steps.filter(s => !s.isDivider));
    return { ...m, pass: all.filter(s => s.status === "pass").length, fail: all.filter(s => s.status === "fail").length, total: all.length };
  }), [modList]);

  const pass = modStats.reduce((a, m) => a + m.pass, 0);
  const fail = modStats.reduce((a, m) => a + m.fail, 0);
  const total = modStats.reduce((a, m) => a + m.total, 0);

  const filtered = useMemo(() => {
    let l = modStats.filter(m => m.name.toLowerCase().includes(search.toLowerCase()));
    if (failOnly) l = l.filter(m => m.fail > 0);
    return l;
  }, [modStats, search, failOnly]);

  const exportAllCSV = () => {
    const rows = [["Module","Test","Step","Action","Result","Remarks","Status"]];
    modList.forEach(m => m.tests.forEach(t => t.steps.forEach(s => rows.push([`"${m.name}"`,`"${t.name}"`,s.serialNo,`"${s.action}"`,`"${s.result}"`,`"${s.remarks}"`,s.status]))));
    const b = new Blob([rows.map(r => r.join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(b);
    a.download = `TestPro_Report_${new Date().toISOString().slice(0,10)}.csv`; a.click();
    toast("CSV exported", "success");
  };

  const statusColor = s => ({ pass: C.gr, fail: C.re, pending: C.t3 }[s] || C.t3);
  const statusBg = s => ({ pass: "#f0fdf4", fail: "#fff5f5", pending: "#ffffff" }[s] || "#fff");

  const toggleExp = id => setExp(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit"
      style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      <Topbar title="Test Report" sub={`${pass} passed · ${fail} failed · ${total - pass - fail} pending`}>
        {!isMobile && <SearchBox value={search} onChange={setSearch} placeholder="Search modules…" />}
        <Stack direction="row" alignItems="center" gap={1}>
          <Typography variant="caption" sx={{ fontFamily: MONO, color: C.t3 }}>Failures only</Typography>
          <Switch size="small" checked={failOnly} onChange={e => setFailOnly(e.target.checked)} color="primary" />
        </Stack>
        <Button size="small" variant="outlined" startIcon={<FileDownloadRounded sx={{ fontSize: 15 }} />} onClick={exportAllCSV}
          sx={{ borderColor: C.b2, color: "text.secondary", "&:hover": { borderColor: C.ac, color: "primary.main" } }}>
          Export All
        </Button>
      </Topbar>

      {isMobile && (
        <Box sx={{ p: 1.5, borderBottom: `1px solid ${C.b1}`, bgcolor: "background.paper", flexShrink: 0 }}>
          <SearchBox value={search} onChange={setSearch} placeholder="Search modules…" fullWidth />
        </Box>
      )}

      <Box sx={{ flex: 1, overflowY: "auto", p: isMobile ? 1.5 : 2 }}>
        {/* Summary */}
        <Box sx={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4,1fr)", gap: 1.5, mb: 2.5 }}>
          {[
            ["Total Steps", total, "primary.main", alpha("#ea580c",0.10), alpha("#ea580c",0.2)],
            ["Passed", pass, "success.main", "#f0fdf4", alpha("#16a34a",0.2)],
            ["Failed", fail, "error.main", "#fff5f5", alpha("#dc2626",0.2)],
            ["Pending", total-pass-fail, "warning.main", "#fffbeb", alpha("#d97706",0.2)],
          ].map(([l,v,c,bg,border],i) => (
            <motion.div key={l} custom={i} variants={cardVariants} initial="initial" animate="animate">
              <Paper elevation={0} sx={{ p: isMobile ? 1.5 : 2, borderRadius: 3, border: `1px solid ${border}`, bgcolor: bg, position: "relative", overflow: "hidden" }}>
                <Box sx={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, bgcolor: c, opacity: 0.7 }} />
                <Typography variant="caption" sx={{ fontFamily: MONO, color: "text.disabled", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.8px", display: "block", mb: 0.5 }}>{l}</Typography>
                <Typography variant="h5" fontWeight={800} sx={{ color: c }}>{v.toLocaleString()}</Typography>
              </Paper>
            </motion.div>
          ))}
        </Box>

        <Stack gap={1.25}>
          {filtered.map((m, i) => {
            const pct = Math.round((m.pass / Math.max(m.total, 1)) * 100);
            const isExp = exp.has(m.id);
            const hasFail = m.fail > 0;
            const isDone = m.pass === m.total && m.total > 0;
            return (
              <motion.div key={m.id} custom={i} variants={cardVariants} initial="initial" animate="animate">
                <Paper elevation={0} sx={{ border: `1px solid ${hasFail ? "#fca5a5" : isDone ? "#86efac" : C.b1}`, borderRadius: 3, overflow: "hidden",
                  bgcolor: hasFail ? "rgba(255,245,245,0.5)" : isDone ? "rgba(240,253,244,0.5)" : "background.paper" }}>
                  <Box sx={{ p: "13px 18px", display: "flex", alignItems: "center", gap: 1.5, cursor: "pointer",
                    "&:hover": { bgcolor: alpha("#000",0.015) }, transition: "background 0.15s" }} onClick={() => toggleExp(m.id)}>
                    <motion.div animate={{ rotate: isExp ? 90 : 0 }} transition={{ type: "spring", stiffness: 300, damping: 25 }}>
                      <ChevronRightRounded sx={{ fontSize: 18, color: C.t3 }} />
                    </motion.div>
                    <Typography fontWeight={700} sx={{ flex: 1, fontSize: 14 }}>{m.name}</Typography>
                    <Stack direction="row" gap={0.75} alignItems="center">
                      {m.pass > 0 && <Chip label={`${m.pass} passed`} size="small" sx={{ height: 22, fontSize: 10, fontFamily: MONO, fontWeight: 700, bgcolor: alpha(C.gr,0.10), color: C.gr, border: `1px solid ${alpha(C.gr,0.25)}` }} />}
                      {m.fail > 0 && <Chip label={`${m.fail} failed`} size="small" sx={{ height: 22, fontSize: 10, fontFamily: MONO, fontWeight: 700, bgcolor: alpha(C.re,0.10), color: C.re, border: `1px solid ${alpha(C.re,0.25)}` }} />}
                      <Chip label={`${pct}%`} size="small" sx={{ height: 22, fontSize: 11, fontFamily: MONO, fontWeight: 800,
                        bgcolor: pct === 100 ? alpha(C.gr,0.10) : hasFail ? alpha(C.re,0.08) : alpha("#ea580c",0.08),
                        color: pct === 100 ? C.gr : hasFail ? C.re : "primary.main" }} />
                    </Stack>
                    <Box sx={{ width: 90 }}><PBar pct={pct} fail={hasFail} /></Box>
                  </Box>
                  <Collapse in={isExp} timeout="auto">
                    <Box sx={{ borderTop: `1px solid ${C.b1}` }}>
                      {m.tests.map(t => {
                        const tp = t.steps.filter(s => !s.isDivider && s.status === "pass").length;
                        const tf = t.steps.filter(s => !s.isDivider && s.status === "fail").length;
                        if (t.steps.length === 0) return null;
                        return (
                          <Box key={t.id}>
                            <Box sx={{ px: 2, py: 0.75, bgcolor: C.s2, display: "flex", alignItems: "center", gap: 1 }}>
                              <Typography fontWeight={600} sx={{ fontSize: 12, flex: 1 }}>{t.name}</Typography>
                              <Typography variant="caption" sx={{ fontFamily: MONO, color: C.t3 }}>✓{tp} ✗{tf} ⟳{t.steps.filter(s => !s.isDivider).length-tp-tf}</Typography>
                            </Box>
                            {!isMobile && (
                              <TableContainer>
                                <Table size="small" sx={{ tableLayout: "fixed" }}>
                                  <TableHead>
                                    <TableRow sx={{ bgcolor: C.s2 }}>
                                      {["S.No","Action","Expected Result","Remarks","Status"].map(h => <TableCell key={h}>{h}</TableCell>)}
                                    </TableRow>
                                  </TableHead>
                                  <TableBody>
                                    {t.steps.map(s => s.isDivider ? (
                                      <TableRow key={s.id} sx={{ bgcolor: "#fff7ed" }}>
                                        <TableCell colSpan={5} sx={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: "primary.main", textTransform: "uppercase", letterSpacing: "1px" }}>{s.action}</TableCell>
                                      </TableRow>
                                    ) : (
                                      <TableRow key={s.id} sx={{ bgcolor: statusBg(s.status) }}>
                                        <TableCell sx={{ fontFamily: MONO, fontSize: 11, width: 55, textAlign: "center" }}>{s.serialNo || "—"}</TableCell>
                                        <TableCell sx={{ fontSize: 12 }}>{s.action}</TableCell>
                                        <TableCell sx={{ fontSize: 12, color: C.t2 }}>{s.result}</TableCell>
                                        <TableCell sx={{ fontSize: 12, color: C.t3 }}>{s.remarks}</TableCell>
                                        <TableCell sx={{ width: 70 }}>
                                          <Chip label={s.status.toUpperCase()} size="small"
                                            sx={{ height: 18, fontSize: 9, fontFamily: MONO, fontWeight: 700,
                                              color: statusColor(s.status), bgcolor: statusBg(s.status),
                                              border: `1px solid ${statusColor(s.status)}30` }} />
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </TableContainer>
                            )}
                          </Box>
                        );
                      })}
                    </Box>
                  </Collapse>
                </Paper>
              </motion.div>
            );
          })}
          {filtered.length === 0 && (
            <Box sx={{ textAlign: "center", py: 6, color: "text.disabled", fontFamily: MONO, fontSize: 13 }}>No modules match.</Box>
          )}
        </Stack>
      </Box>
    </motion.div>
  );
}

// ── Audit View ─────────────────────────────────────────────────────────────────────
function AuditView({ log }) {
  const isMobile = useIsMobile();
  const fmt = ts => new Date(ts).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const dotColor = { pass: C.gr, fail: C.re, warn: C.am, info: "primary.main" };
  const alertSeverity = { pass: "success", fail: "error", warn: "warning", info: "info" };

  return (
    <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit"
      style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      <Topbar title="Audit Log" sub={`${log.length} events recorded`} />
      <Box sx={{ flex: 1, overflowY: "auto", p: isMobile ? 1.5 : 2 }}>
        <Paper elevation={0} sx={{ border: `1px solid ${C.b1}`, borderRadius: 3, overflow: "hidden" }}>
          {log.length === 0 && (
            <Box sx={{ p: 5, textAlign: "center", color: "text.disabled", fontFamily: MONO, fontSize: 12 }}>No events yet.</Box>
          )}
          {log.map((e, i) => (
            <motion.div key={i} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i * 0.018, 0.35), type: "spring", stiffness: 320, damping: 28 }}>
              <Box sx={{ px: 2.5, py: 1.25, borderBottom: `1px solid ${C.b1}`, display: "flex", alignItems: "flex-start", gap: 1.5,
                "&:hover": { bgcolor: alpha("#ea580c", 0.025) }, transition: "background 0.15s" }}>
                <Box sx={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, mt: 0.6,
                  bgcolor: e.type === "pass" ? C.gr : e.type === "fail" ? C.re : e.type === "warn" ? C.am : "#ea580c",
                  boxShadow: `0 0 0 2px ${e.type === "pass" ? alpha(C.gr,0.2) : e.type === "fail" ? alpha(C.re,0.2) : e.type === "warn" ? alpha(C.am,0.2) : alpha("#ea580c",0.2)}`,
                }} />
                <Box sx={{ flex: 1 }}>
                  <Typography variant="body2" sx={{ fontSize: 12, fontWeight: 500 }}>{e.action}</Typography>
                  <Typography variant="caption" sx={{ fontFamily: MONO, color: "text.disabled" }}>{e.user}</Typography>
                </Box>
                <Typography variant="caption" sx={{ fontFamily: MONO, color: "text.disabled", flexShrink: 0 }}>{fmt(e.ts)}</Typography>
              </Box>
            </motion.div>
          ))}
        </Paper>
      </Box>
    </motion.div>
  );
}

// ── Users Panel ────────────────────────────────────────────────────────────────────
function UsersPanel({ users, session, saveUsers, addLog, toast }) {
  const isMobile = useIsMobile();
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ name: "", username: "", email: "", password: "", role: "tester", active: true });
  const [search, setSearch] = useState("");
  const [confirm, setConfirm] = useState(null);

  const filtered = users.filter(u =>
    u.name.toLowerCase().includes(search.toLowerCase()) ||
    u.username.toLowerCase().includes(search.toLowerCase()) ||
    (u.email || "").toLowerCase().includes(search.toLowerCase())
  );

  const openAdd = () => { setForm({ name: "", username: "", email: "", password: "", role: "tester", active: true }); setModal("add"); };
  const openEdit = u => { setForm({ ...u }); setModal(u); };

  const save = () => {
    if (!form.name.trim() || !form.username.trim() || !form.password.trim()) { toast("Name, username & password required", "error"); return; }
    if (modal === "add" && users.find(u => u.username === form.username.trim())) { toast("Username already exists", "error"); return; }
    const updated = modal === "add"
      ? [...users, { ...form, id: `new_${Date.now()}` }]
      : users.map(u => u.id === form.id ? { ...form } : u);
    saveUsers(updated); setModal(null);
    toast(modal === "add" ? `User "${form.name}" created` : `"${form.name}" updated`, "success");
    addLog({ ts: Date.now(), user: session.name, action: modal === "add" ? `Created user "${form.name}" (${form.role})` : `Updated user "${form.name}"`, type: "info" });
  };

  const del = u => {
    saveUsers(users.filter(x => x.id !== u.id));
    toast(`"${u.name}" deleted`, "info"); setConfirm(null);
    addLog({ ts: Date.now(), user: session.name, action: `Deleted user "${u.name}"`, type: "info" });
  };

  const toggle = u => {
    if (u.id === session.id) return;
    saveUsers(users.map(x => x.id === u.id ? { ...x, active: !x.active } : x));
    toast(`${u.name} ${u.active ? "deactivated" : "activated"}`, "info");
    addLog({ ts: Date.now(), user: session.name, action: `${u.active ? "Deactivated" : "Activated"} "${u.name}"`, type: "info" });
  };

  const fld = (label, key, type = "text", opts = {}) => (
    <TextField label={label} type={type} value={form[key] || ""}
      onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
      fullWidth size="medium" sx={{ mb: 2 }}
      InputProps={{ sx: { borderRadius: 2 } }}
      {...opts}
    />
  );

  return (
    <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit"
      style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      <Topbar title="User Management" sub={`${users.length} users · ${users.filter(u => u.active).length} active`}>
        {!isMobile && <SearchBox value={search} onChange={setSearch} placeholder="Search users…" />}
        <Button variant="contained" size="small" startIcon={<Ico n="plus" s={13} />} onClick={openAdd}>
          {isMobile ? "" : "Add User"}
        </Button>
      </Topbar>

      {isMobile && (
        <Box sx={{ p: 1.5, borderBottom: `1px solid ${C.b1}`, bgcolor: "background.paper", flexShrink: 0 }}>
          <SearchBox value={search} onChange={setSearch} placeholder="Search users…" fullWidth />
        </Box>
      )}

      <Box sx={{ flex: 1, overflowY: "auto", p: isMobile ? 1.5 : 2 }}>
        <Stack gap={isMobile ? 1 : 1.25}>
          {filtered.map((u, i) => (
            <motion.div key={u.id} custom={i} variants={cardVariants} initial="initial" animate="animate"
              whileHover={{ y: -2, boxShadow: "0 8px 24px rgba(0,0,0,0.08)" }} transition={{ type: "spring", stiffness: 360, damping: 28 }}>
              <Paper elevation={0} sx={{ border: `1px solid ${u.active ? C.b1 : "#fecaca"}`, borderRadius: 3, p: isMobile ? 1.5 : 2,
                opacity: u.active ? 1 : 0.72, transition: "opacity 0.2s, box-shadow 0.2s" }}>
                <Stack direction={isMobile ? "column" : "row"} alignItems={isMobile ? "flex-start" : "center"} gap={1.5}>
                  <Stack direction="row" alignItems="center" gap={1.5} sx={{ width: isMobile ? "100%" : undefined }}>
                    <Avatar sx={{ width: 42, height: 42, background: u.role === "admin"
                      ? "linear-gradient(135deg,#fb923c,#ea580c)"
                      : "linear-gradient(135deg,#dbeafe,#bfdbfe)",
                      color: u.role === "admin" ? "#fff" : "#1d4ed8",
                      fontWeight: 700, fontSize: 16, flexShrink: 0,
                      boxShadow: u.role === "admin" ? "0 3px 10px rgba(234,88,12,0.32)" : "0 2px 6px rgba(59,130,246,0.18)" }}>
                      {u.name?.[0]?.toUpperCase()}
                    </Avatar>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Stack direction="row" alignItems="center" gap={0.75} flexWrap="wrap">
                        <Typography fontWeight={700} sx={{ fontSize: 14 }}>{u.name}</Typography>
                        <Chip label={u.role} size="small"
                          sx={{ height: 20, fontSize: 9, fontFamily: MONO, fontWeight: 700,
                            bgcolor: u.role === "admin" ? alpha("#ea580c",0.10) : C.amd,
                            color: u.role === "admin" ? C.ac : C.am,
                            border: `1px solid ${u.role === "admin" ? alpha("#ea580c",0.25) : "transparent"}` }} />
                        <Chip label={u.active ? "active" : "inactive"} size="small"
                          sx={{ height: 20, fontSize: 9, fontFamily: MONO, fontWeight: 700,
                            bgcolor: u.active ? alpha(C.gr,0.10) : alpha(C.re,0.10),
                            color: u.active ? C.gr : C.re,
                            border: `1px solid ${u.active ? alpha(C.gr,0.25) : alpha(C.re,0.25)}` }} />
                      </Stack>
                      <Typography variant="caption" sx={{ fontFamily: MONO, color: "text.disabled", display: "block" }}>
                        @{u.username}{u.email ? ` · ${u.email}` : ""}
                      </Typography>
                    </Box>
                    {isMobile && (
                      <Stack direction="row" gap={0.5} sx={{ ml: "auto" }}>
                        <IconButton size="small" onClick={() => openEdit(u)} sx={{ color: "primary.main", bgcolor: alpha("#ea580c",0.06) }}>
                          <EditRounded sx={{ fontSize: 16 }} />
                        </IconButton>
                        {u.id !== session.id && <IconButton size="small" onClick={() => setConfirm(u)} sx={{ color: "error.main", bgcolor: alpha("#dc2626",0.06) }}>
                          <DeleteRounded sx={{ fontSize: 16 }} />
                        </IconButton>}
                      </Stack>
                    )}
                  </Stack>
                  {!isMobile && (
                    <Stack direction="row" alignItems="center" gap={1} sx={{ ml: "auto", flexShrink: 0 }}>
                      <Typography variant="caption" sx={{ fontFamily: MONO, color: "text.disabled" }}>Active</Typography>
                      <Switch size="small" checked={u.active} onChange={() => toggle(u)} disabled={u.id === session.id} color="success" />
                      <Button size="small" variant="outlined" startIcon={<EditRounded sx={{ fontSize: 14 }} />} onClick={() => openEdit(u)}
                        sx={{ borderColor: C.b2, color: "text.secondary", "&:hover": { borderColor: C.ac, color: "primary.main" } }}>Edit</Button>
                      {u.id !== session.id && (
                        <Button size="small" variant="outlined" color="error" startIcon={<DeleteRounded sx={{ fontSize: 14 }} />} onClick={() => setConfirm(u)}
                          sx={{ borderColor: "#fca5a5" }}>Delete</Button>
                      )}
                    </Stack>
                  )}
                  {isMobile && (
                    <Stack direction="row" alignItems="center" gap={1} sx={{ width: "100%" }}>
                      <Typography variant="caption" sx={{ fontFamily: MONO, color: "text.disabled" }}>Active</Typography>
                      <Switch size="small" checked={u.active} onChange={() => toggle(u)} disabled={u.id === session.id} color="success" />
                    </Stack>
                  )}
                </Stack>
              </Paper>
            </motion.div>
          ))}
          {filtered.length === 0 && (
            <Box sx={{ textAlign: "center", py: 8, color: "text.disabled" }}>
              <PeopleRounded sx={{ fontSize: 40, mb: 1.5, opacity: 0.3 }} />
              <Typography sx={{ fontFamily: MONO, fontSize: 13 }}>No users match.</Typography>
            </Box>
          )}
        </Stack>
      </Box>

      {/* Add/Edit Dialog */}
      <FormDialog
        open={Boolean(modal)}
        onClose={() => setModal(null)}
        title={modal === "add" ? "Add User" : "Edit User"}
        subtitle={modal === "add" ? "Create a new team member account" : undefined}
        actions={
          <>
            <Button variant="outlined" onClick={() => setModal(null)} sx={{ borderColor: C.b2, color: "text.secondary" }}>Cancel</Button>
            <Button variant="contained" onClick={save}>{modal === "add" ? "Create User" : "Save Changes"}</Button>
          </>
        }
      >
        {fld("Full Name", "name", "text", { autoFocus: true })}
        {fld("Username", "username")}
        {fld("Email (optional)", "email", "email")}
        {fld("Password", "password", "password")}
        <FormControl fullWidth sx={{ mb: 2 }} size="medium">
          <InputLabel>Role</InputLabel>
          <Select value={form.role} label="Role" onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
            sx={{ borderRadius: 2 }}>
            <MenuItem value="tester">Tester</MenuItem>
            <MenuItem value="admin">Admin</MenuItem>
          </Select>
        </FormControl>
      </FormDialog>

      <ConfirmDialog
        open={Boolean(confirm)}
        title="Delete User?"
        description={`Delete "${confirm?.name}"? This cannot be undone.`}
        onConfirm={() => del(confirm)}
        onCancel={() => setConfirm(null)}
      />
    </motion.div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────────────
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
      const logData = await store.loadLog();
      let finalUsers = dbUsers;
      if (!dbUsers.length) {
        const { data: inserted, error: seedErr } = await supabase.from("users").insert(SEED_USERS.map(({ id: _skip, ...rest }) => rest)).select();
        if (seedErr) { console.error("Seed users error:", seedErr); finalUsers = SEED_USERS; }
        else finalUsers = inserted || SEED_USERS;
      }
      let finalModules = dbModules;
      if (!Object.keys(dbModules).length) {
        const seedModules = buildModules();
        finalModules = seedModules;
        store.saveModules(seedModules).catch(e => console.error("Seed modules error:", e));
      }
      setUsers(finalUsers); setModules(finalModules); setLog(logData);
    })();
  }, []); // eslint-disable-line

  const saveUsers = useCallback(async u => {
    setUsers(u); await store.saveUsers(u);
    const { data: fresh } = await supabase.from("users").select("*");
    if (fresh && fresh.length) setUsers(fresh);
  }, []);

  const latestModulesRef = useRef(null);
  const saveModsTimerRef = useRef(null);
  const structuralFlagRef = useRef(false);

  const saveMods = useCallback((m, structural = false) => {
    setModules(m); latestModulesRef.current = m;
    if (structural) structuralFlagRef.current = true;
    if (!structuralFlagRef.current) return;
    if (saveModsTimerRef.current) clearTimeout(saveModsTimerRef.current);
    saveModsTimerRef.current = setTimeout(() => {
      structuralFlagRef.current = false;
      store.saveModules(latestModulesRef.current);
    }, 400);
  }, []);

  const addLog = useCallback(async e => {
    setLog(l => [e, ...l].slice(0, 300));
    await store.addLog(e);
  }, []);

  // Realtime subscriptions
  useEffect(() => {
    if (!modules) return;
    const uid = Date.now();
    const stepsSub = supabase.channel(`rt-steps-${uid}`).on("postgres_changes", { event: "*", schema: "public", table: "steps" }, payload => {
      const { eventType, new: row, old: oldRow } = payload;
      setModules(prev => {
        if (!prev) return prev;
        const next = { ...prev };
        if (eventType === "UPDATE") {
          for (const modId in next) {
            const mod = next[modId]; const testIdx = mod.tests.findIndex(t => t.id === row.test_id);
            if (testIdx === -1) continue;
            const test = mod.tests[testIdx]; const stepIdx = test.steps.findIndex(s => s.id === row.id);
            if (stepIdx === -1) continue;
            const updatedSteps = [...test.steps];
            updatedSteps[stepIdx] = { ...updatedSteps[stepIdx], status: row.status, remarks: row.remarks, action: row.action, result: row.result, serialNo: row.serial_no, isDivider: row.is_divider ?? false };
            const updatedTests = [...mod.tests]; updatedTests[testIdx] = { ...test, steps: updatedSteps };
            next[modId] = { ...mod, tests: updatedTests }; break;
          }
        }
        if (eventType === "INSERT") {
          for (const modId in next) {
            const mod = next[modId]; const testIdx = mod.tests.findIndex(t => t.id === row.test_id);
            if (testIdx === -1) continue;
            const test = mod.tests[testIdx];
            if (test.steps.some(s => s.id === row.id)) break;
            const updatedTests = [...mod.tests];
            const normRow = { ...row, serialNo: row.serial_no, isDivider: row.is_divider ?? false };
            updatedTests[testIdx] = { ...test, steps: [...test.steps, normRow].sort((a,b) => (a.serialNo??0)-(b.serialNo??0)) };
            next[modId] = { ...mod, tests: updatedTests }; break;
          }
        }
        if (eventType === "DELETE") {
          const deletedId = oldRow?.id; if (!deletedId) return prev;
          for (const modId in next) {
            const mod = next[modId]; let changed = false;
            const updatedTests = mod.tests.map(t => { if (!t.steps.some(s => s.id === deletedId)) return t; changed = true; return { ...t, steps: t.steps.filter(s => s.id !== deletedId) }; });
            if (changed) { next[modId] = { ...mod, tests: updatedTests }; break; }
          }
        }
        return next;
      });
    }).subscribe();

    const testsSub = supabase.channel(`rt-tests-${uid}`).on("postgres_changes", { event: "*", schema: "public", table: "tests" }, payload => {
      const { eventType, new: row, old: oldRow } = payload;
      setModules(prev => {
        if (!prev) return prev;
        const next = { ...prev };
        if (eventType === "UPDATE") { const mod = next[row.module_id]; if (!mod) return prev; next[row.module_id] = { ...mod, tests: mod.tests.map(t => t.id === row.id ? { ...t, name: row.name, description: row.description, serial_no: row.serial_no, serialNo: row.serial_no } : t) }; }
        if (eventType === "INSERT") { const mod = next[row.module_id]; if (!mod) return prev; if (mod.tests.some(t => t.id === row.id)) return prev; next[row.module_id] = { ...mod, tests: [...mod.tests, { ...row, serialNo: row.serial_no, steps: [] }].sort((a,b) => (a.serial_no??0)-(b.serial_no??0)) }; }
        if (eventType === "DELETE") { for (const modId in next) { const mod = next[modId]; if (!mod.tests.some(t => t.id === oldRow?.id)) continue; next[modId] = { ...mod, tests: mod.tests.filter(t => t.id !== oldRow.id) }; break; } }
        return next;
      });
    }).subscribe();

    const modulesSub = supabase.channel(`rt-modules-${uid}`).on("postgres_changes", { event: "*", schema: "public", table: "modules" }, payload => {
      const { eventType, new: row, old: oldRow } = payload;
      setModules(prev => {
        if (!prev) return prev;
        const next = { ...prev };
        if (eventType === "UPDATE") { if (!next[row.id]) return prev; next[row.id] = { ...next[row.id], name: row.name, position: row.position }; }
        if (eventType === "INSERT") { if (next[row.id]) return prev; next[row.id] = { ...row, tests: [] }; }
        if (eventType === "DELETE") { if (!next[oldRow?.id]) return prev; const n2 = { ...next }; delete n2[oldRow.id]; return n2; }
        return next;
      });
    }).subscribe();

    return () => { supabase.removeChannel(stepsSub); supabase.removeChannel(testsSub); supabase.removeChannel(modulesSub); };
  }, [!!modules]); // eslint-disable-line

  useEffect(() => {
    if (!session || !users) return;
    if (session.role === "admin") return;
    const currentUser = users.find(u => u.id === session.id);
    if (!currentUser || !currentUser.active) { lockStore.releaseAll(session.id); setSession(null); setView("dash"); setSelMod(null); setHasLock(false); }
  }, [users, session]);

  const handleLogout = useCallback(u => {
    setSession(null); setView("dash"); setSelMod(null); setHasLock(false);
    if (u && u.role !== "admin") lockStore.releaseAll(u.id);
  }, []);

  useEffect(() => {
    if (!session || session.role === "admin") return;
    const onUnload = () => lockStore.releaseAll(session.id);
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [session]);

  // Loading
  if (!users || !modules) return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      <Box sx={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", bgcolor: "background.default", flexDirection: "column", gap: 2 }}>
        <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}>
          <Box sx={{ width: 44, height: 44, borderRadius: 2.5, background: "linear-gradient(135deg,#fb923c,#ea580c)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 16px rgba(234,88,12,.38)" }}>
            <TaskAltRounded sx={{ fontSize: 24, color: "#fff" }} />
          </Box>
        </motion.div>
        <Typography variant="body2" sx={{ fontFamily: MONO, color: "text.disabled" }}>Loading TestPro…</Typography>
      </Box>
    </ThemeProvider>
  );

  if (!session) return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      <LoginPage users={users} onLogin={u => { setSession(u); addLog({ ts: Date.now(), user: u.name, action: "Logged in", type: "info" }); }} />
    </ThemeProvider>
  );

  const modKeys = Object.keys(modules);
  const modIdx = selMod ? modKeys.indexOf(selMod) : -1;

  const mobileNavItems = [
    { id: "dash", icon: "dash", label: "Dashboard" },
    { id: "report", icon: "report", label: "Report" },
    ...(session.role === "admin" ? [{ id: "users", icon: "users", label: "Users" }, { id: "audit", icon: "log", label: "Audit" }] : []),
    { id: "_modules", icon: "layers", label: "Modules" },
  ];

  const currentMobileNavVal = view === "mod" ? "_modules" : view;

  return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      <MobileMenuCtx.Provider value={() => setMobileDrawerOpen(true)}>
        <Box sx={{ display: "flex", height: "100vh", overflow: "hidden", bgcolor: "background.default", color: "text.primary" }}>
          {/* Desktop Sidebar */}
          {!isMobile && (
            <Sidebar
              session={session} view={view} setView={setView} modules={modules}
              selMod={selMod}
              setSelMod={id => {
                if (session.role !== "admin" && hasLock && !(selMod === id && view === "mod")) { toast("Finish the current test first", "error"); return; }
                setSelMod(id); setView("mod");
              }}
              collapsed={sideColl} setCollapsed={setSideColl}
              locked={session.role !== "admin" && hasLock}
              onLogout={() => { addLog({ ts: Date.now(), user: session.name, action: "Logged out", type: "info" }); handleLogout(session); }}
            />
          )}

          {/* Mobile Drawer */}
          {isMobile && (
            <Sidebar
              session={session} view={view}
              setView={v => { setView(v); setMobileDrawerOpen(false); }}
              modules={modules} selMod={selMod}
              setSelMod={id => {
                if (session.role !== "admin" && hasLock && !(selMod === id && view === "mod")) { toast("Finish the current test first", "error"); return; }
                setSelMod(id); setView("mod"); setMobileDrawerOpen(false);
              }}
              collapsed={false} setCollapsed={() => {}}
              locked={session.role !== "admin" && hasLock}
              mobileOpen={mobileDrawerOpen} onMobileClose={() => setMobileDrawerOpen(false)}
              onLogout={() => { addLog({ ts: Date.now(), user: session.name, action: "Logged out", type: "info" }); handleLogout(session); }}
            />
          )}

          {/* Main Content */}
          <Box sx={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0,
            pb: isMobile ? "calc(58px + env(safe-area-inset-bottom, 0px))" : 0 }}>
            <AnimatePresence mode="wait">
              {view === "dash" && (
                <Dashboard key="dash" modules={modules} session={session}
                  onSelect={id => {
                    if (session.role !== "admin" && hasLock) { toast("Finish the current test first", "error"); return; }
                    setSelMod(id); setView("mod");
                  }}
                />
              )}
              {view === "mod" && selMod && modules[selMod] && (
                <ModuleView key={selMod} mod={modules[selMod]} allModules={modules} session={session}
                  saveMods={saveMods} addLog={addLog} toast={toast}
                  onLockChange={locked => setHasLock(locked)}
                  onNav={dir => { if (hasLock) return; const nk = modKeys[modIdx + dir]; if (nk) setSelMod(nk); }}
                  modIdx={modIdx} modTotal={modKeys.length}
                />
              )}
              {view === "report" && <ReportView key="report" modules={modules} toast={toast} />}
              {view === "users" && session.role === "admin" && (
                <UsersPanel key="users" users={users} session={session} saveUsers={saveUsers} addLog={addLog} toast={toast} />
              )}
              {view === "audit" && session.role === "admin" && (
                <AuditView key="audit" log={log} />
              )}
            </AnimatePresence>
          </Box>

          {/* Mobile Bottom Navigation */}
          {isMobile && (
            <Paper elevation={0} sx={{
              position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 200,
              bgcolor: "rgba(255,255,255,0.92)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
              borderTop: `1px solid rgba(245,222,206,0.7)`,
              boxShadow: "0 -4px 24px rgba(234,88,12,0.07), 0 -1px 0 rgba(245,222,206,0.6)",
              pb: "env(safe-area-inset-bottom, 0px)",
            }}>
              <BottomNavigation value={currentMobileNavVal} showLabels
                sx={{ bgcolor: "transparent", height: 58 }}
                onChange={(_, newVal) => {
                  if (newVal === "_modules") { setMobileDrawerOpen(true); return; }
                  if (session.role !== "admin" && hasLock && newVal !== view) { toast("Finish the current test first", "error"); return; }
                  setView(newVal);
                }}>
                {mobileNavItems.map(item => (
                  <BottomNavigationAction key={item.id} value={item.id} label={item.label}
                    icon={<Ico n={item.icon} s={20} />}
                    sx={{
                      color: currentMobileNavVal === item.id ? "primary.main" : "text.disabled",
                      fontFamily: MONO, fontSize: 10, minWidth: 0,
                      "& .MuiBottomNavigationAction-label": { fontSize: "10px !important", fontFamily: MONO, fontWeight: currentMobileNavVal === item.id ? 700 : 400 },
                      "&.Mui-selected": { color: "primary.main" },
                    }}
                  />
                ))}
                <BottomNavigationAction label="Logout" value="_logout"
                  icon={<Ico n="logout" s={20} color={C.re} />}
                  onClick={() => { addLog({ ts: Date.now(), user: session.name, action: "Logged out", type: "info" }); handleLogout(session); }}
                  sx={{ color: "error.main", minWidth: 0, borderLeft: `1px solid ${C.b1}`,
                    "& .MuiBottomNavigationAction-label": { fontSize: "10px !important", fontFamily: MONO, color: "error.main" } }}
                />
              </BottomNavigation>
            </Paper>
          )}

          <ToastHost />
        </Box>
      </MobileMenuCtx.Provider>
    </ThemeProvider>
  );
}
