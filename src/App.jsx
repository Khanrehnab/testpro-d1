import { supabase } from "./supabase";
import React, {
  useState, useEffect, useRef, useCallback, useMemo, useContext, createContext,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard, BarChart3, Users, History, Check, X, LogOut,
  Pencil, Trash2, Plus, Search, ChevronRight, ChevronDown, ChevronLeft,
  RefreshCw, Download, Lock, Layers, FileText, ArrowLeft,
  Menu, Eye, EyeOff, CheckCircle, XCircle, User, ShieldCheck,
  CheckSquare, Loader2, AlertTriangle, Bell, Activity,
  TrendingUp, MoreHorizontal, Terminal, Zap, Filter,
} from "lucide-react";

// ── ShadCN Components ─────────────────────────────────────────────────────────
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

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

// ── Design System ─────────────────────────────────────────────────────────────────
const MONO = "'IBM Plex Mono', 'JetBrains Mono', monospace";

// ── Mobile Detection ───────────────────────────────────────────────────────────────
function useIsMobile(breakpoint = 768) {
  const [mobile, setMobile] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    const handler = () => setMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [breakpoint]);
  return mobile;
}
const MobileMenuCtx = createContext(null);

// ── Motion Variants ───────────────────────────────────────────────────────────────
const pageVariants = {
  initial: { opacity: 0, y: 12, scale: 0.99 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.28, ease: [0.16, 1, 0.3, 1] } },
  exit:    { opacity: 0, y: -8, scale: 0.99, transition: { duration: 0.16, ease: "easeIn" } },
};
const cardVariants = {
  initial: { opacity: 0, y: 18 },
  animate: (i) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.035, type: "spring", stiffness: 320, damping: 28 },
  }),
};
const listItem = {
  initial: { opacity: 0, x: -10 },
  animate: { opacity: 1, x: 0, transition: { type: "spring", stiffness: 340, damping: 30 } },
};

// ── Global Styles Injection ────────────────────────────────────────────────────────
function useGlobalStyles() {
  useEffect(() => {
    const style = document.createElement("style");
    style.innerHTML = `
      @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Syne:wght@400;600;700;800&family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap');
      :root {
        --tp-bg: #06090f;
        --tp-surface: #0b1120;
        --tp-card: #0f1729;
        --tp-elevated: #131f38;
        --tp-border: #1a2d4a;
        --tp-border-strong: #243a5e;
        --tp-accent: #38bdf8;
        --tp-accent-dim: rgba(56,189,248,0.12);
        --tp-pass: #34d399;
        --tp-fail: #fb7185;
        --tp-warn: #fbbf24;
        --tp-text: #e2e8f0;
        --tp-text-2: #94a3b8;
        --tp-text-3: #4a5568;
      }
      html, body { background: var(--tp-bg); color: var(--tp-text); }
      * { box-sizing: border-box; }
      body { font-family: 'Plus Jakarta Sans', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
      ::-webkit-scrollbar { width: 4px; height: 4px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(56,189,248,0.18); border-radius: 99px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(56,189,248,0.32); }
      ::selection { background: rgba(56,189,248,0.20); }
      button { -webkit-tap-highlight-color: transparent; }
    `;
    document.head.appendChild(style);
    document.documentElement.classList.add("dark");
    return () => document.head.removeChild(style);
  }, []);
}

// ── Toast System ──────────────────────────────────────────────────────────────────
function useToast() {
  const [queue, setQueue] = useState([]);
  const push = useCallback((msg, type = "info") => {
    const id = Date.now() + Math.random();
    setQueue(q => [...q, { id, msg, type }]);
    setTimeout(() => setQueue(q => q.filter(x => x.id !== id)), 3500);
  }, []);

  const Host = useCallback(() => {
    const isMobile = useIsMobile();
    const iconMap = {
      success: <CheckCircle className="w-4 h-4 text-emerald-400" />,
      error: <XCircle className="w-4 h-4 text-rose-400" />,
      info: <Bell className="w-4 h-4 text-sky-400" />,
      warning: <AlertTriangle className="w-4 h-4 text-amber-400" />,
    };
    const colorMap = {
      success: "border-emerald-500/30 bg-emerald-950/80",
      error: "border-rose-500/30 bg-rose-950/80",
      info: "border-sky-500/30 bg-sky-950/80",
      warning: "border-amber-500/30 bg-amber-950/80",
    };
    const textMap = {
      success: "text-emerald-100",
      error: "text-rose-100",
      info: "text-sky-100",
      warning: "text-amber-100",
    };
    return (
      <div className={cn(
        "fixed z-[9999] flex flex-col gap-2 pointer-events-none",
        isMobile ? "bottom-[76px] left-3 right-3" : "bottom-6 right-6"
      )}>
        <AnimatePresence>
          {queue.map(t => (
            <motion.div key={t.id}
              initial={{ opacity: 0, y: 20, scale: 0.9, x: isMobile ? 0 : 16 }}
              animate={{ opacity: 1, y: 0, scale: 1, x: 0 }}
              exit={{ opacity: 0, y: 6, scale: 0.95 }}
              transition={{ type: "spring", stiffness: 400, damping: 32 }}
            >
              <div className={cn(
                "flex items-center gap-2.5 px-4 py-3 rounded-xl border backdrop-blur-xl shadow-2xl",
                !isMobile && "min-w-[280px]",
                colorMap[t.type] || colorMap.info
              )}>
                {iconMap[t.type] || iconMap.info}
                <span className={cn("text-sm font-semibold", textMap[t.type] || textMap.info)}>{t.msg}</span>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    );
  }, [queue]);

  return { push, Host };
}

// ── Shared: SearchBox ─────────────────────────────────────────────────────────────
function SearchBox({ value, onChange, placeholder = "Search…", className }) {
  return (
    <div className={cn("relative", className)}>
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
      <Input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-8 h-8 text-xs bg-slate-900 border-slate-700 text-slate-200 placeholder:text-slate-600 focus:border-sky-500/60 focus:ring-sky-500/20 w-full"
      />
    </div>
  );
}

// ── Shared: Topbar ─────────────────────────────────────────────────────────────────
function Topbar({ title, sub, children }) {
  const isMobile = useIsMobile();
  const onMenuClick = useContext(MobileMenuCtx);
  return (
    <div className="flex items-center gap-2 px-4 border-b border-slate-800 bg-slate-950/80 backdrop-blur-xl flex-shrink-0 min-h-[56px]">
      {isMobile && onMenuClick && (
        <button onClick={onMenuClick} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors mr-0.5">
          <Menu className="w-5 h-5" />
        </button>
      )}
      <div className="flex-1 min-w-0">
        <div className="font-bold text-slate-100 text-sm truncate" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{title}</div>
        {sub && <div className="text-[10px] text-slate-500 truncate" style={{ fontFamily: MONO }}>{sub}</div>}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {children}
      </div>
    </div>
  );
}

// ── Shared: Progress Bar ───────────────────────────────────────────────────────────
function PBar({ pct, fail }) {
  return (
    <div className="h-1 rounded-full bg-slate-800 overflow-hidden">
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.7, ease: [0.4, 0, 0.2, 1] }}
        className={cn("h-full rounded-full", fail ? "bg-gradient-to-r from-amber-500 to-rose-500" : "bg-gradient-to-r from-sky-500 to-emerald-400")}
      />
    </div>
  );
}

// ── Shared: ExportMenu ────────────────────────────────────────────────────────────
function ExportMenu({ onCSV, onPDF }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 text-xs border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 hover:text-slate-100 gap-1.5">
          <Download className="w-3.5 h-3.5" /> Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="bg-slate-900 border-slate-700 text-slate-200">
        <DropdownMenuItem onClick={onCSV} className="text-xs gap-2 hover:bg-slate-800 cursor-pointer">
          <Download className="w-3.5 h-3.5 text-slate-400" /> Export CSV
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onPDF} className="text-xs gap-2 hover:bg-slate-800 cursor-pointer">
          <FileText className="w-3.5 h-3.5 text-slate-400" /> Export PDF
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Shared: ConfirmDialog ──────────────────────────────────────────────────────────
function ConfirmDialog({ open, title, description, onConfirm, onCancel, confirmLabel = "Delete", destructive = true }) {
  return (
    <Dialog open={open} onOpenChange={v => !v && onCancel()}>
      <DialogContent className="bg-slate-900 border-slate-700 text-slate-100 max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-slate-100 font-bold">{title}</DialogTitle>
          <DialogDescription className="text-slate-400 text-sm">{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel} className="border-slate-700 text-slate-300 hover:bg-slate-800">Cancel</Button>
          <Button
            onClick={onConfirm}
            className={destructive
              ? "bg-rose-600 hover:bg-rose-700 text-white border-0"
              : "bg-sky-600 hover:bg-sky-700 text-white border-0"
            }
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Shared: FormDialog ────────────────────────────────────────────────────────────
function FormDialog({ open, onClose, title, subtitle, children, actions }) {
  const isMobile = useIsMobile();
  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className={cn(
        "bg-slate-900 border-slate-700 text-slate-100",
        isMobile ? "max-w-full h-full rounded-none" : "max-w-md"
      )}>
        <DialogHeader>
          <DialogTitle className="text-slate-100 font-bold">{title}</DialogTitle>
          {subtitle && <DialogDescription className="text-slate-400 text-sm">{subtitle}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-0">{children}</div>
        <DialogFooter className="gap-2">{actions}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Shared: FormField ─────────────────────────────────────────────────────────────
function FormField({ label, value, onChange, type = "text", autoFocus = false }) {
  return (
    <div className="mb-4">
      <Label className="text-slate-300 text-xs font-medium mb-1.5 block">{label}</Label>
      <Input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        autoFocus={autoFocus}
        className="bg-slate-800 border-slate-700 text-slate-100 placeholder:text-slate-600 focus:border-sky-500/60 focus:ring-sky-500/20 h-9"
      />
    </div>
  );
}

// ── Login Page ─────────────────────────────────────────────────────────────────────
function LoginPage({ users, onLogin }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const pwRef = useRef();

  const go = () => {
    if (!u.trim() || !p) { setErr("Please enter your username and password."); return; }
    setLoading(true);
    setTimeout(() => {
      const found = users.find(x => x.username === u.trim() && x.password === p && x.active);
      if (found) { onLogin(found); }
      else { setErr("Invalid credentials or account inactive."); setLoading(false); }
    }, 150);
  };

  return (
    <div className="min-h-dvh flex items-center justify-center relative overflow-hidden" style={{ background: "var(--tp-bg)" }}>
      {/* Animated grid background */}
      <div className="absolute inset-0 pointer-events-none" style={{
        backgroundImage: `
          linear-gradient(rgba(56,189,248,0.04) 1px, transparent 1px),
          linear-gradient(90deg, rgba(56,189,248,0.04) 1px, transparent 1px)
        `,
        backgroundSize: "40px 40px",
      }} />

      {/* Glow orbs */}
      {[
        { top: "-20%", left: "-10%", size: 500, color: "rgba(56,189,248,0.06)", blur: 80, duration: 14 },
        { bottom: "-15%", right: "-8%", size: 420, color: "rgba(99,102,241,0.07)", blur: 70, duration: 18 },
        { top: "30%", right: "5%", size: 250, color: "rgba(52,211,153,0.05)", blur: 60, duration: 11 },
      ].map((orb, i) => (
        <motion.div key={i}
          className="absolute rounded-full pointer-events-none"
          style={{ width: orb.size, height: orb.size, background: `radial-gradient(circle, ${orb.color}, transparent)`, filter: `blur(${orb.blur}px)`, ...orb }}
          animate={{ x: [0, 25 + i * 8, -12, 0], y: [0, -18 - i * 6, 12, 0], scale: [1, 1.06, 0.96, 1] }}
          transition={{ duration: orb.duration, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}

      {/* Scan line effect */}
      <motion.div
        className="absolute inset-x-0 h-[1px] pointer-events-none z-[1]"
        style={{ background: "linear-gradient(90deg, transparent, rgba(56,189,248,0.3), transparent)" }}
        animate={{ top: ["-2%", "102%"] }}
        transition={{ duration: 5, repeat: Infinity, ease: "linear", repeatDelay: 3 }}
      />

      {/* Login Card */}
      <motion.div
        initial={{ opacity: 0, y: 28, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 w-full max-w-[400px] mx-4"
      >
        {/* Glowing border */}
        <div className="absolute -inset-px rounded-2xl pointer-events-none" style={{
          background: "linear-gradient(135deg, rgba(56,189,248,0.3), rgba(99,102,241,0.2), rgba(52,211,153,0.15))",
          filter: "blur(0.5px)",
        }} />

        <div className="relative rounded-2xl border border-slate-800 overflow-hidden"
          style={{ background: "rgba(11,17,32,0.92)", backdropFilter: "blur(32px)" }}>

          {/* Card header strip */}
          <div className="h-px w-full bg-gradient-to-r from-transparent via-sky-500/60 to-transparent" />

          {/* Shimmer */}
          <motion.div
            className="absolute inset-0 pointer-events-none z-0"
            style={{ background: "linear-gradient(105deg, transparent 40%, rgba(56,189,248,0.04) 50%, transparent 60%)" }}
            animate={{ x: ["-120%", "220%"] }}
            transition={{ duration: 3, repeat: Infinity, repeatDelay: 4, ease: "easeInOut" }}
          />

          <div className="relative z-10 p-8">
            {/* Logo */}
            <div className="mb-6">
              <motion.div
                animate={{ boxShadow: ["0 0 20px rgba(56,189,248,0.2)", "0 0 40px rgba(56,189,248,0.4)", "0 0 20px rgba(56,189,248,0.2)"] }}
                transition={{ duration: 2.5, repeat: Infinity }}
                className="inline-flex"
              >
                <div className="w-12 h-12 rounded-xl flex items-center justify-center"
                  style={{ background: "linear-gradient(135deg, #0ea5e9, #6366f1)" }}>
                  <CheckSquare className="w-6 h-6 text-white" />
                </div>
              </motion.div>

              {/* System label */}
              <div className="mt-4 flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-[10px] font-mono text-emerald-400 tracking-[0.2em] uppercase">System Online</span>
              </div>
              <h1 className="mt-1 text-2xl font-extrabold text-slate-100" style={{ fontFamily: "'Syne', sans-serif" }}>
                Mission Control
              </h1>
              <p className="text-xs text-slate-500 mt-0.5" style={{ fontFamily: MONO }}>
                TestPro // QA Management Platform
              </p>
            </div>

            {/* Error */}
            <AnimatePresence>
              {err && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                  <div className="flex items-center gap-2 mb-4 p-3 rounded-lg border border-rose-500/30 bg-rose-950/40">
                    <XCircle className="w-4 h-4 text-rose-400 flex-shrink-0" />
                    <p className="text-xs text-rose-300">{err}</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Fields */}
            <div className="space-y-3">
              <div>
                <Label className="text-[11px] font-mono text-slate-500 uppercase tracking-wider mb-1.5 block">Username</Label>
                <Input
                  value={u}
                  onChange={e => { setU(e.target.value); setErr(""); }}
                  onKeyDown={e => e.key === "Enter" && pwRef.current?.focus()}
                  autoComplete="username"
                  placeholder="Enter username"
                  className="bg-slate-800/60 border-slate-700 text-slate-100 placeholder:text-slate-600 focus:border-sky-500/70 focus:ring-1 focus:ring-sky-500/30 h-10 font-mono text-sm"
                />
              </div>
              <div>
                <Label className="text-[11px] font-mono text-slate-500 uppercase tracking-wider mb-1.5 block">Password</Label>
                <div className="relative">
                  <Input
                    ref={pwRef}
                    type={showPw ? "text" : "password"}
                    value={p}
                    onChange={e => { setP(e.target.value); setErr(""); }}
                    onKeyDown={e => e.key === "Enter" && go()}
                    autoComplete="current-password"
                    placeholder="Enter password"
                    className="bg-slate-800/60 border-slate-700 text-slate-100 placeholder:text-slate-600 focus:border-sky-500/70 focus:ring-1 focus:ring-sky-500/30 h-10 font-mono text-sm pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <motion.div whileTap={{ scale: 0.98 }} className="pt-1">
                <button
                  onClick={go}
                  disabled={loading}
                  className="w-full h-11 rounded-lg font-bold text-sm text-white relative overflow-hidden disabled:opacity-60 transition-all hover:opacity-90 active:scale-[0.98]"
                  style={{ background: "linear-gradient(135deg, #0ea5e9, #6366f1)" }}
                >
                  <div className="relative z-10 flex items-center justify-center gap-2">
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                    {loading ? "Authenticating…" : "Sign In"}
                  </div>
                  <motion.div
                    className="absolute inset-0"
                    style={{ background: "linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.1) 50%, transparent 60%)" }}
                    animate={{ x: ["-120%", "220%"] }}
                    transition={{ duration: 2, repeat: Infinity, repeatDelay: 2, ease: "easeInOut" }}
                  />
                </button>
              </motion.div>
            </div>

            {/* Footer */}
            <div className="mt-5 pt-4 border-t border-slate-800 flex items-center justify-between">
              <span className="text-[10px] font-mono text-slate-600">TestPro v2.0</span>
              <span className="text-[10px] font-mono text-slate-600">Secure Access Only</span>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
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
    { id: "dash", icon: <LayoutDashboard className="w-4 h-4" />, label: "Dashboard" },
    { id: "report", icon: <BarChart3 className="w-4 h-4" />, label: "Test Report" },
    ...(session.role === "admin" ? [
      { id: "users", icon: <Users className="w-4 h-4" />, label: "Users" },
      { id: "audit", icon: <History className="w-4 h-4" />, label: "Audit Log" },
    ] : []),
  ];

  const content = (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: "var(--tp-surface)" }}>
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3 py-3.5 border-b border-slate-800 flex-shrink-0 min-h-[56px]">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: "linear-gradient(135deg, #0ea5e9, #6366f1)", boxShadow: "0 0 14px rgba(14,165,233,0.35)" }}>
          <CheckSquare className="w-4 h-4 text-white" />
        </div>
        {(!collapsed || isMobile) && (
          <span className="font-extrabold text-slate-100 flex-1 text-sm tracking-tight" style={{ fontFamily: "'Syne', sans-serif" }}>
            Test<span className="text-sky-400">Pro</span>
          </span>
        )}
        {!isMobile && (
          <button onClick={() => setCollapsed(c => !c)}
            className="p-1 rounded text-slate-600 hover:text-slate-300 hover:bg-slate-800 transition-colors ml-auto">
            {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>

      {/* Nav */}
      <div className="pt-2 px-2 flex-shrink-0">
        {(!collapsed || isMobile) && (
          <div className="text-[9px] font-mono text-slate-600 uppercase tracking-[0.18em] px-2 mb-1">Navigation</div>
        )}
        {navItems.map(item => {
          const active = view === item.id;
          return (
            <button
              key={item.id}
              onClick={() => { setView(item.id); if (onMobileClose) onMobileClose(); }}
              className={cn(
                "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg mb-0.5 text-sm font-medium transition-all",
                active
                  ? "bg-sky-500/15 text-sky-300 border border-sky-500/25"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent"
              )}
            >
              <span className={active ? "text-sky-400" : "text-slate-500"}>{item.icon}</span>
              {(!collapsed || isMobile) && <span className="text-[13px]">{item.label}</span>}
            </button>
          );
        })}
      </div>

      {(!collapsed || isMobile) && (
        <>
          <div className="h-px bg-slate-800 mx-3 my-2 flex-shrink-0" />
          {/* Modules */}
          <div className="px-4 mb-1.5 flex-shrink-0">
            <div className="text-[9px] font-mono text-slate-600 uppercase tracking-[0.18em] mb-2">
              Modules ({modList.length})
            </div>
            <SearchBox value={search} onChange={setSearch} placeholder="Search modules…" className="w-full" />
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {modList.map(m => {
              const st = modStats[m.id] || {};
              const active = selMod === m.id && view === "mod";
              const hasFail = st.fail > 0;
              const hasPass = st.pass > 0;
              return (
                <motion.div key={m.id} variants={listItem} initial="initial" animate="animate">
                  <button
                    onClick={() => {
                      if (locked && !(selMod === m.id && view === "mod")) return;
                      setSelMod(m.id); setView("mod");
                      if (onMobileClose) onMobileClose();
                    }}
                    disabled={locked && !(selMod === m.id && view === "mod")}
                    className={cn(
                      "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg mb-0.5 text-left transition-all",
                      active
                        ? "bg-sky-500/10 border-l-2 border-sky-400 text-sky-300"
                        : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 border-l-2 border-transparent",
                      "disabled:opacity-40 disabled:cursor-not-allowed"
                    )}
                  >
                    <Layers className={cn("w-3 h-3 flex-shrink-0", active ? "text-sky-400" : "text-slate-600")} />
                    <span className="text-[12px] flex-1 truncate font-medium">{m.name}</span>
                    {hasFail && (
                      <Badge className="h-4 text-[9px] px-1 bg-rose-900/60 text-rose-400 border-rose-500/30 font-mono">✗{st.fail}</Badge>
                    )}
                    {!hasFail && hasPass && (
                      <CheckCircle className="w-3 h-3 text-emerald-500" />
                    )}
                  </button>
                </motion.div>
              );
            })}
          </div>
        </>
      )}

      {/* Footer */}
      <div className={cn(
        "border-t border-slate-800 p-3 flex-shrink-0 flex items-center gap-2.5",
        "bg-gradient-to-t from-slate-900/50"
      )}>
        <Avatar className="w-8 h-8 flex-shrink-0 ring-1 ring-sky-500/30">
          <AvatarFallback className="text-xs font-bold text-sky-300" style={{ background: "linear-gradient(135deg, #0c1f3a, #0f2a50)" }}>
            {session.name?.[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
        {(!collapsed || isMobile) && (
          <>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-bold text-slate-200 truncate">{session.name}</div>
              <Badge className={cn(
                "text-[9px] h-4 px-1.5 font-mono border-0",
                session.role === "admin"
                  ? "bg-sky-900/60 text-sky-400"
                  : "bg-amber-900/40 text-amber-400"
              )}>
                {session.role === "admin" ? <ShieldCheck className="w-2.5 h-2.5 mr-1" /> : <User className="w-2.5 h-2.5 mr-1" />}
                {session.role}
              </Badge>
            </div>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={onLogout}
                    className="p-1.5 rounded-lg text-slate-600 hover:text-rose-400 hover:bg-rose-900/30 transition-colors">
                    <LogOut className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" className="bg-slate-800 border-slate-700 text-slate-200 text-xs">Logout</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </>
        )}
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <Sheet open={mobileOpen} onOpenChange={v => !v && onMobileClose?.()}>
        <SheetContent side="left" className="p-0 w-72 border-slate-800 bg-transparent">
          {content}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div className={cn("flex-shrink-0 border-r border-slate-800 transition-all duration-300 overflow-hidden", collapsed ? "w-[52px]" : "w-64")}
      style={{ background: "var(--tp-surface)" }}>
      {content}
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────────
function Dashboard({ modules, session, onSelect, saveMods, addLog, toast }) {
  const isMobile = useIsMobile();
  const isAdmin = session.role === "admin";
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [confirmDel, setConfirmDel] = useState(null);

  const modList = useMemo(() => Object.values(modules), [modules]);
  const modStats = useMemo(() => modList.map(m => {
    const all = m.tests.flatMap(t => t.steps.filter(s => !s.isDivider));
    return { ...m, testCount: m.tests.length, pass: all.filter(s => s.status === "pass").length, fail: all.filter(s => s.status === "fail").length, total: all.length };
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

  const deleteModule = (id) => {
    const m = { ...modules }; delete m[id];
    saveMods(m, true);
    addLog({ ts: Date.now(), user: session.name, action: `Deleted module "${modules[id].name}"`, type: "warn" });
    toast(`Module "${modules[id].name}" deleted`, "info");
    setConfirmDel(null);
  };

  const addModule = () => {
    const n = prompt("Module name:");
    if (!n?.trim()) return;
    const id = `m_${Date.now()}`;
    const updated = { ...modules, [id]: { id, name: n.trim(), tests: [makeTest(id, 1, 0)] } };
    saveMods(updated, true);
    addLog({ ts: Date.now(), user: session.name, action: `Created module "${n.trim()}"`, type: "info" });
    toast(`Module "${n.trim()}" created`, "success");
  };

  const statCards = [
    { label: "Total Steps", value: total, icon: <Activity className="w-5 h-5" />, accent: "#38bdf8", bg: "rgba(56,189,248,0.06)", border: "rgba(56,189,248,0.15)", sub: `${modList.length} modules` },
    { label: "Passed", value: totalPass, icon: <CheckCircle className="w-5 h-5" />, accent: "#34d399", bg: "rgba(52,211,153,0.06)", border: "rgba(52,211,153,0.15)", sub: `${total ? Math.round((totalPass / total) * 100) : 0}% rate` },
    { label: "Failed", value: totalFail, icon: <XCircle className="w-5 h-5" />, accent: "#fb7185", bg: "rgba(251,113,133,0.06)", border: "rgba(251,113,133,0.15)", sub: `${modStats.filter(m => m.fail > 0).length} modules` },
    { label: "Pending", value: pending, icon: <RefreshCw className="w-5 h-5" />, accent: "#fbbf24", bg: "rgba(251,191,36,0.06)", border: "rgba(251,191,36,0.15)", sub: `${modStats.filter(m => m.pass + m.fail === m.total && m.total > 0).length} complete` },
  ];

  const filters = [["all","All"], ["active","In Progress"], ["pass","All Pass"], ["fail","Has Failures"], ["empty","Not Started"]];

  return (
    <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit"
      className="flex flex-col flex-1 overflow-hidden">
      <Topbar title="Dashboard" sub={`Welcome back, ${session.name}`}>
        {!isMobile && <SearchBox value={search} onChange={setSearch} placeholder="Search modules…" className="w-48" />}
        {isAdmin && (
          <Button size="sm" onClick={addModule}
            className="h-8 text-xs bg-sky-600 hover:bg-sky-700 text-white border-0 gap-1.5">
            <Plus className="w-3.5 h-3.5" /> Add Module
          </Button>
        )}
      </Topbar>

      <div className="flex-1 overflow-y-auto p-4">
        {isMobile && <div className="mb-3"><SearchBox value={search} onChange={setSearch} placeholder="Search modules…" className="w-full" /></div>}

        {/* Stat cards */}
        <div className={cn("grid gap-3 mb-5", isMobile ? "grid-cols-2" : "grid-cols-4")}>
          {statCards.map((card, i) => (
            <motion.div key={card.label} custom={i} variants={cardVariants} initial="initial" animate="animate">
              <div className="rounded-xl border overflow-hidden relative p-4"
                style={{ background: card.bg, borderColor: card.border }}>
                <div className="absolute top-0 left-0 right-0 h-0.5 rounded-t-xl"
                  style={{ background: `linear-gradient(90deg, transparent, ${card.accent}, transparent)` }} />
                <div className="flex items-start justify-between mb-2">
                  <div className="text-[9px] font-mono uppercase tracking-[0.15em]" style={{ color: card.accent }}>{card.label}</div>
                  {!isMobile && <span style={{ color: card.accent, opacity: 0.7 }}>{card.icon}</span>}
                </div>
                <div className="text-3xl font-extrabold" style={{ color: card.accent, fontFamily: "'Syne', sans-serif" }}>
                  {card.value.toLocaleString()}
                </div>
                <div className="text-[10px] font-mono text-slate-600 mt-0.5">{card.sub}</div>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Filter bar */}
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <div className="text-sm font-bold text-slate-200">
            Modules <span className="font-mono font-normal text-slate-600 text-xs">({filtered.length})</span>
          </div>
          <div className="flex gap-1 flex-wrap">
            {filters.map(([k, l]) => (
              <button key={k} onClick={() => setFilter(k)}
                className={cn(
                  "text-[10px] font-mono px-2.5 py-1 rounded-full border transition-all",
                  filter === k
                    ? "bg-sky-500/20 border-sky-500/40 text-sky-300 font-bold"
                    : "border-slate-800 text-slate-500 hover:text-slate-300 hover:border-slate-700"
                )}>
                {l}
              </button>
            ))}
          </div>
        </div>

        {/* Module cards */}
        <div className="space-y-2">
          {filtered.map((m, i) => {
            const pct = Math.round((m.pass / Math.max(m.total, 1)) * 100);
            const passW = m.total ? (m.pass / m.total) * 100 : 0;
            const failW = m.total ? (m.fail / m.total) * 100 : 0;
            const isDone = m.pass === m.total && m.total > 0;
            const hasFail = m.fail > 0;
            const borderColor = hasFail ? "rgba(251,113,133,0.3)" : isDone ? "rgba(52,211,153,0.3)" : "rgba(30,45,74,1)";
            const statusColor = hasFail ? "#fb7185" : isDone ? "#34d399" : m.pass > 0 ? "#fbbf24" : "#1e2d4a";
            return (
              <motion.div key={m.id} custom={i} variants={cardVariants} initial="initial" animate="animate"
                whileHover={{ y: -2, boxShadow: "0 12px 32px rgba(0,0,0,0.3)" }}
                transition={{ type: "spring", stiffness: 360, damping: 28 }}>
                <div
                  className="rounded-xl border overflow-hidden cursor-pointer transition-colors"
                  style={{ borderColor, background: "var(--tp-card)" }}
                  onClick={() => onSelect(m.id)}
                >
                  <div className={cn("flex items-center gap-3 px-4 py-3", isMobile ? "flex-wrap" : "")}>
                    {/* Status dot */}
                    <div className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: statusColor, boxShadow: isDone || hasFail ? `0 0 0 3px ${statusColor}22` : "none" }} />
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-slate-100 text-sm truncate">{m.name}</div>
                      <div className="text-[10px] font-mono text-slate-500">
                        {m.testCount} tests · {m.total} steps
                        {m.pass > 0 && <span className="text-emerald-500 ml-1.5 font-bold">✓{m.pass}</span>}
                        {m.fail > 0 && <span className="text-rose-500 ml-1 font-bold">✗{m.fail}</span>}
                        {m.total - m.pass - m.fail > 0 && <span className="text-slate-600 ml-1">·{m.total - m.pass - m.fail}</span>}
                      </div>
                    </div>
                    <Badge className={cn(
                      "font-mono text-[10px] font-extrabold h-5 px-2 border",
                      pct === 100 ? "bg-emerald-900/50 text-emerald-400 border-emerald-500/30"
                        : hasFail ? "bg-rose-900/50 text-rose-400 border-rose-500/30"
                        : "bg-sky-900/50 text-sky-400 border-sky-500/30"
                    )}>
                      {pct}%
                    </Badge>
                    {isAdmin && (
                      <button onClick={e => { e.stopPropagation(); setConfirmDel(m.id); }}
                        className="p-1 rounded text-slate-600 hover:text-rose-400 hover:bg-rose-900/30 transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <ChevronRight className="w-4 h-4 text-slate-600" />
                  </div>
                  {/* Dual progress bar */}
                  <div className="h-1 flex bg-slate-800">
                    <motion.div initial={{ width: 0 }} animate={{ width: `${passW}%` }} transition={{ duration: 0.7, ease: [0.4,0,0.2,1] }}
                      style={{ background: "linear-gradient(90deg, #10b981, #34d399)", minWidth: 0 }} />
                    <motion.div initial={{ width: 0 }} animate={{ width: `${failW}%` }} transition={{ duration: 0.7, ease: [0.4,0,0.2,1], delay: 0.1 }}
                      style={{ background: "linear-gradient(90deg, #f43f5e, #fb7185)", minWidth: 0 }} />
                  </div>
                </div>
              </motion.div>
            );
          })}
          {filtered.length === 0 && (
            <div className="text-center py-16 text-slate-600">
              <Layers className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <div className="font-mono text-sm">No modules match.</div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(confirmDel)}
        title="Delete Module?"
        description={`Delete "${modules[confirmDel]?.name}"? All its tests and steps will be permanently removed.`}
        onConfirm={() => deleteModule(confirmDel)}
        onCancel={() => setConfirmDel(null)}
      />
    </motion.div>
  );
}

// ── Divider Row ───────────────────────────────────────────────────────────────────
function DividerRow({ label }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-800" style={{ background: "rgba(14,165,233,0.04)" }}>
      <div className="w-1.5 h-1.5 rounded-full bg-sky-400 flex-shrink-0" />
      <span className="text-[9px] font-mono font-bold text-sky-400 uppercase tracking-[0.18em] whitespace-nowrap">{label}</span>
      <div className="flex-1 h-px bg-gradient-to-r from-sky-500/20 to-transparent" />
    </div>
  );
}

// ── Step Row ──────────────────────────────────────────────────────────────────────
function StepRow({ step, idx, onChange, onStatusToggle, isActive, onActivate, rowRef }) {
  const isMobile = useIsMobile();
  const rowBg = step.status === "fail"
    ? "rgba(251,113,133,0.05)"
    : step.status === "pass"
    ? "rgba(52,211,153,0.05)"
    : isActive
    ? "rgba(56,189,248,0.04)"
    : "transparent";

  const PassBtn = (
    <button
      onClick={e => { e.stopPropagation(); onStatusToggle(idx, "pass"); }}
      className={cn(
        "flex items-center justify-center gap-1 px-2 py-1 rounded-full text-[10px] font-mono font-bold flex-1 border transition-all",
        step.status === "pass"
          ? "bg-emerald-500 border-emerald-500 text-white shadow-[0_0_12px_rgba(52,211,153,0.3)]"
          : "border-slate-700 text-slate-500 hover:border-emerald-500/50 hover:text-emerald-400 hover:bg-emerald-900/20"
      )}>
      <Check className="w-3 h-3" /> PASS
    </button>
  );

  const FailBtn = (
    <button
      onClick={e => { e.stopPropagation(); onStatusToggle(idx, "fail"); }}
      className={cn(
        "flex items-center justify-center gap-1 px-2 py-1 rounded-full text-[10px] font-mono font-bold flex-1 border transition-all",
        step.status === "fail"
          ? "bg-rose-500 border-rose-500 text-white shadow-[0_0_12px_rgba(251,113,133,0.3)]"
          : "border-slate-700 text-slate-500 hover:border-rose-500/50 hover:text-rose-400 hover:bg-rose-900/20"
      )}>
      <X className="w-3 h-3" /> FAIL
    </button>
  );

  if (isMobile) {
    return (
      <div ref={rowRef} onClick={onActivate}
        className="border-b border-slate-800 p-3 transition-all"
        style={{ background: rowBg, outline: isActive ? "1px solid rgba(56,189,248,0.4)" : "none", outlineOffset: -1 }}>
        <div className="flex items-center gap-2 mb-2">
          <span className="font-mono text-[10px] font-bold text-slate-500 min-w-[28px]">
            {isActive && <span className="text-sky-400 mr-0.5">●</span>}
            {step.serialNo != null ? `#${step.serialNo}` : "—"}
          </span>
          <div className="flex-1" />
          <div className="flex gap-1.5 w-[156px]">{PassBtn}{FailBtn}</div>
        </div>
        {step.action
          ? <p className="text-sm text-slate-300 leading-relaxed mb-1.5 whitespace-pre-wrap break-words">{step.action}</p>
          : <p className="text-xs font-mono text-slate-600 italic mb-1.5">No action</p>}
        {step.result && (
          <div className="pl-2.5 border-l border-slate-700 mb-2">
            <div className="text-[9px] font-mono text-slate-600 mb-0.5">Expected</div>
            <div className="text-xs text-slate-400 leading-relaxed whitespace-pre-wrap">{step.result}</div>
          </div>
        )}
        <Textarea
          value={step.remarks} placeholder="Add remarks…" rows={2}
          onChange={e => onChange(idx, "remarks", e.target.value)}
          onClick={e => e.stopPropagation()}
          className="text-xs bg-slate-800 border-slate-700 text-slate-300 placeholder:text-slate-600 resize-none focus:border-sky-500/50"
        />
      </div>
    );
  }

  return (
    <div ref={rowRef} onClick={onActivate}
      className="grid border-b border-slate-800 transition-all cursor-default"
      style={{
        gridTemplateColumns: "50px 1fr 1fr 180px 110px",
        background: rowBg,
        outline: isActive ? "1px solid rgba(56,189,248,0.35)" : "none",
        outlineOffset: -1,
      }}>
      {/* Serial */}
      <div className="px-2 py-1.5 flex items-center justify-center border-r border-slate-800">
        {isActive && <div className="w-1 h-1 rounded-full bg-sky-400 mr-1 flex-shrink-0" />}
        <span className="font-mono text-[11px] font-semibold text-slate-500">
          {step.serialNo != null && step.serialNo !== "" ? step.serialNo : "—"}
        </span>
      </div>
      {/* Action */}
      <div className="px-2.5 py-1.5 border-r border-slate-800 flex items-start min-h-[40px]">
        {step.action
          ? <p className="text-[12px] text-slate-200 leading-relaxed whitespace-pre-wrap break-words">{step.action}</p>
          : <span className="text-[11px] font-mono text-slate-700 italic">—</span>}
      </div>
      {/* Result */}
      <div className="px-2.5 py-1.5 border-r border-slate-800 flex items-start">
        {step.result
          ? <p className="text-[12px] text-slate-400 leading-relaxed whitespace-pre-wrap break-words">{step.result}</p>
          : <span className="text-[11px] font-mono text-slate-700 italic">—</span>}
      </div>
      {/* Remarks */}
      <div className="p-1 border-r border-slate-800">
        <Textarea
          value={step.remarks} placeholder="Remarks…" rows={2}
          onChange={e => onChange(idx, "remarks", e.target.value)}
          onClick={e => e.stopPropagation()}
          className="text-[12px] bg-transparent border-0 resize-none text-slate-400 placeholder:text-slate-700 focus:ring-0 p-1 min-h-0 h-full shadow-none"
        />
      </div>
      {/* Buttons */}
      <div className="p-1.5 flex flex-col gap-1">
        {PassBtn}{FailBtn}
      </div>
    </div>
  );
}

// ── Test Detail ────────────────────────────────────────────────────────────────────
function TestDetail({ mod, test, testIdx, allModules, session, saveMods, addLog, toast, onBack, onFinish, modIdx, modTotal, onNav, navLocked }) {
  const isAdmin = session.role === "admin";
  const isMobile = useIsMobile();
  const [steps, setSteps] = useState(test.steps);
  const [search, setSearch] = useState("");
  const [fStat, setFStat] = useState("all");
  const [addCount, setAddCount] = useState(10);
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
      if (relTop < 0 || relTop > container.clientHeight * 0.35)
        container.scrollTo({ top: Math.max(0, container.scrollTop + relTop - 60), behavior: "smooth" });
    }, 30);
    return () => clearTimeout(t);
  }, [activeIdx]);

  useEffect(() => {
    latestStepsRef.current = test.steps;
    if (stepsTimerRef.current) { clearTimeout(stepsTimerRef.current); stepsTimerRef.current = null; }
  }, [test.id]); // eslint-disable-line

  const commit = useCallback((newSteps, newName, newDesc) => {
    localCommitRef.current = true;
    const updTest = { ...test, steps: newSteps, name: newName ?? test.name, description: newDesc ?? test.description };
    const updTests = mod.tests.map((t, i) => i === testIdx ? updTest : t);
    saveMods({ ...allModules, [mod.id]: { ...mod, tests: updTests } });
    latestStepsRef.current = newSteps;
    if (stepsTimerRef.current) clearTimeout(stepsTimerRef.current);
    stepsTimerRef.current = setTimeout(() => {
      store.saveSteps(test.id, mod.id, latestStepsRef.current, {
        moduleName: mod.name, serialNo: test.serialNo ?? test.serial_no ?? 0,
        name: newName ?? test.name, description: newDesc ?? test.description ?? "",
      }).catch(e => console.error("saveSteps error:", e));
    }, 400);
  }, [mod, test, testIdx, allModules, saveMods]);

  const setField = (i, f, v) => { const ns = [...steps]; ns[i] = { ...ns[i], [f]: v }; setSteps(ns); commit(ns); };

  const setStatusToggle = (i, status) => {
    const ns = [...steps]; const newStatus = ns[i].status === status ? "pending" : status;
    ns[i] = { ...ns[i], status: newStatus }; setSteps(ns); commit(ns);
    if (newStatus !== "pending")
      addLog({ ts: Date.now(), user: session.name, action: `${mod.name} › ${test.name} · Step ${ns[i].serialNo} → ${newStatus.toUpperCase()}`, type: newStatus });
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

  const addSteps = () => {
    if (steps.length >= 100_000) { toast("Maximum 100,000 steps per test", "error"); return; }
    const n = Math.min(addCount, 100_000 - steps.length);
    const start = steps.length + 1;
    const ns = [...steps, ...Array.from({ length: n }, (_, i) => makeStep(test.id, start + i))];
    setSteps(ns); commit(ns); toast(`Added ${n} step${n > 1 ? "s" : ""}`, "success");
  };

  const resetAll = () => {
    const ns = steps.map(s => s.isDivider ? s : { ...s, status: "pending" });
    setSteps(ns); commit(ns); setActiveIdx(0); toast("Steps reset", "info");
    addLog({ ts: Date.now(), user: session.name, action: `Reset ${mod.name} › ${test.name}`, type: "info" });
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
    const sc = s => s === "pass" ? "#10b981" : s === "fail" ? "#ef4444" : "#9ca3af";
    const sb = s => s === "pass" ? "#f0fdf4" : s === "fail" ? "#fff5f5" : "#ffffff";
    const stepRows = steps.map(s => s.isDivider
      ? `<tr><td colspan="5" style="padding:6px 12px;background:#f0f9ff;font-size:11px;font-family:monospace;font-weight:700;color:#0ea5e9;text-transform:uppercase;letter-spacing:1px">${s.action}</td></tr>`
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
      <table style="width:100%;border-collapse:collapse"><thead><tr>
        ${["S.No","Action","Expected Result","Remarks","Status"].map(h=>`<th style="padding:6px 8px;background:#f9fafb;border:1px solid #e5e7eb;font-size:10px;font-family:monospace;text-transform:uppercase;letter-spacing:1px;color:#6b7280">${h}</th>`).join("")}
      </tr></thead><tbody>${stepRows}</tbody></table></body></html>`;
    const w = window.open("", "_blank"); w.document.write(html); w.document.close();
    w.focus(); setTimeout(() => w.print(), 500); toast("PDF ready", "info");
  };

  const importCSV = (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const lines = ev.target.result.split("\n").filter(l => l.trim());
        const start = lines[0]?.toLowerCase().includes("serial") ? 1 : 0;
        const newSteps = []; let sno = 1;
        for (let i = start; i < lines.length; i++) {
          const cols = lines[i].split(",").map(c => c.trim().replace(/^"|"$/g, "").replace(/""/g, '"'));
          if (cols[0]?.startsWith("$$$")) {
            newSteps.push({ id: `${test.id}_div_${Date.now()}_${i}`, isDivider: true, action: cols[0].slice(3), serialNo: null, result: "", remarks: "", status: "pending" });
          } else {
            const sn = parseInt(cols[0]); const serialNo = !isNaN(sn) ? sn : sno;
            newSteps.push({ id: `${test.id}_s${serialNo}`, serialNo, action: cols[1] || "", result: cols[2] || "", remarks: cols[3] || "", status: cols[4]?.trim() || "pending", isDivider: false });
            sno++;
          }
        }
        setSteps(newSteps); commit(newSteps);
        toast(`Imported ${newSteps.filter(s => !s.isDivider).length} steps`, "success");
        addLog({ ts: Date.now(), user: session.name, action: `Imported CSV → ${mod.name} › ${test.name}`, type: "info" });
      } catch { toast("CSV parse error", "error"); }
    };
    reader.readAsText(file); e.target.value = "";
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

  const statFilters = [["all","All"],["pass","Pass"],["fail","Fail"],["pending","Pending"]];

  return (
    <div className="flex flex-col flex-1 overflow-hidden" style={{ background: "var(--tp-bg)" }}>
      {/* Header Row 1 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800 flex-shrink-0 min-h-[52px]"
        style={{ background: "var(--tp-surface)" }}>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={onBack} className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors">
                <ArrowLeft className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="bg-slate-800 border-slate-700 text-slate-200 text-xs">Back to tests</TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <div className="flex-1 min-w-0">
          <div className="font-bold text-slate-100 text-sm truncate">{test.name}</div>
          <div className="text-[10px] font-mono text-slate-600">{mod.name}</div>
        </div>

        {/* Progress pill */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-slate-800 flex-shrink-0"
          style={{ background: "var(--tp-card)" }}>
          {!isMobile && (
            <>
              <span className="font-mono text-[11px] font-bold text-emerald-400">{pass}✓</span>
              {fail > 0 && <span className="font-mono text-[11px] font-bold text-rose-400">{fail}✗</span>}
              <span className="font-mono text-[11px] text-slate-600">{pending}…</span>
              <div className="w-px h-3 bg-slate-700" />
            </>
          )}
          <span className={cn(
            "font-mono text-[12px] font-extrabold",
            pct === 100 ? "text-emerald-400" : fail > 0 ? "text-rose-400" : "text-sky-400"
          )}>{pct}%</span>
        </div>

        {/* Nav arrows */}
        {!isMobile && modIdx !== undefined && (
          <div className="flex items-center gap-1">
            <button onClick={() => onNav?.(-1)} disabled={modIdx === 0 || navLocked}
              className="p-1 rounded text-slate-600 hover:text-slate-300 hover:bg-slate-800 disabled:opacity-30 transition-colors">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="font-mono text-[10px] text-slate-600">{modIdx+1}/{modTotal}</span>
            <button onClick={() => onNav?.(1)} disabled={modIdx === modTotal - 1 || navLocked}
              className="p-1 rounded text-slate-600 hover:text-slate-300 hover:bg-slate-800 disabled:opacity-30 transition-colors">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}

        {onFinish && (
          <Button size="sm" onClick={onFinish}
            className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 border-0 text-white gap-1">
            <CheckCircle className="w-3 h-3" /> Finish
          </Button>
        )}
      </div>

      {/* Header Row 2: controls */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800 flex-shrink-0 flex-wrap"
        style={{ background: "var(--tp-surface)" }}>
        <SearchBox value={search} onChange={setSearch} placeholder="Search steps…" className="w-44" />

        {/* Status filter */}
        <div className="flex gap-1">
          {statFilters.map(([k, l]) => (
            <button key={k} onClick={() => setFStat(k)}
              className={cn(
                "text-[10px] font-mono px-2 py-1 rounded border transition-all",
                fStat === k
                  ? k === "pass" ? "bg-emerald-900/50 border-emerald-500/40 text-emerald-300"
                    : k === "fail" ? "bg-rose-900/50 border-rose-500/40 text-rose-300"
                    : k === "pending" ? "bg-amber-900/40 border-amber-500/40 text-amber-300"
                    : "bg-sky-900/40 border-sky-500/40 text-sky-300"
                  : "border-slate-800 text-slate-600 hover:text-slate-400 hover:border-slate-700"
              )}>
              {l}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {isAdmin && (
          <>
            <label className="cursor-pointer">
              <input type="file" accept=".csv" onChange={importCSV} className="hidden" />
              <div className="flex items-center gap-1.5 text-[11px] font-mono text-slate-500 hover:text-slate-300 border border-slate-800 hover:border-slate-700 px-2.5 py-1 rounded-lg transition-colors cursor-pointer">
                <Download className="w-3.5 h-3.5" /> Import CSV
              </div>
            </label>
            <ExportMenu onCSV={exportCSV} onPDF={exportPDF} />
          </>
        )}
        {!isAdmin && <ExportMenu onCSV={exportCSV} onPDF={exportPDF} />}

        <button onClick={resetAll}
          className="flex items-center gap-1.5 text-[11px] font-mono text-slate-500 hover:text-amber-400 border border-slate-800 hover:border-amber-500/40 px-2.5 py-1 rounded-lg transition-colors">
          <RefreshCw className="w-3 h-3" /> Reset
        </button>
      </div>

      {/* Table header (desktop) */}
      {!isMobile && (
        <div className="grid flex-shrink-0 border-b border-slate-800"
          style={{ gridTemplateColumns: "50px 1fr 1fr 180px 110px", background: "var(--tp-elevated)" }}>
          {["S.No","Action","Expected Result","Remarks","Status"].map(h => (
            <div key={h} className="px-2.5 py-2 text-[9px] font-mono font-bold text-slate-600 uppercase tracking-[0.15em] border-r border-slate-800 last:border-r-0">
              {h}
            </div>
          ))}
        </div>
      )}

      {/* Steps */}
      <div ref={tableRef} className="flex-1 overflow-y-auto">
        {visible.map(s => s.isDivider ? (
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
            rowRef={el => rowRefs.current[s._i] = el}
          />
        ))}
        {visible.length === 0 && (
          <div className="text-center py-16 text-slate-600">
            <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <div className="font-mono text-sm">No steps match.</div>
          </div>
        )}
      </div>

      {/* Footer: add steps */}
      {isAdmin && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-slate-800 flex-shrink-0"
          style={{ background: "var(--tp-surface)" }}>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-mono text-slate-600">Add</span>
            <Input
              type="number" value={addCount} min={1} max={10000}
              onChange={e => setAddCount(Math.max(1, Math.min(10000, parseInt(e.target.value) || 1)))}
              className="w-16 h-7 text-xs text-center bg-slate-800 border-slate-700 text-slate-200 font-mono"
            />
            <span className="text-[11px] font-mono text-slate-600">steps</span>
          </div>
          <Button size="sm" onClick={addSteps}
            className="h-7 text-xs bg-sky-600 hover:bg-sky-700 border-0 text-white gap-1.5">
            <Plus className="w-3 h-3" /> Add Steps
          </Button>
          <div className="flex-1" />
          <span className="text-[10px] font-mono text-slate-700">{steps.length} total</span>
        </div>
      )}
    </div>
  );
}

// ── Module View ───────────────────────────────────────────────────────────────────
function ModuleView({ mod, allModules, session, saveMods, addLog, toast, onLockChange, onNav, modIdx, modTotal }) {
  const isAdmin = session.role === "admin";
  const isMobile = useIsMobile();
  const [selTestIdx, setSelTestIdx] = useState(null);
  const [search, setSearch] = useState("");
  const [locks, setLocks] = useState({});
  const activeTestIdRef = useRef(null);
  const heartbeatRef = useRef(null);
  const uiLocked = !isAdmin && activeTestIdRef.current !== null;

  useEffect(() => {
    let alive = true;
    lockStore.getAll().then(l => { if (alive) setLocks(l); });
    const iv = setInterval(() => lockStore.getAll().then(l => { if (alive) setLocks(l); }), 8000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const openTest = async (idx) => {
    if (!isAdmin) {
      const t = mod.tests[idx];
      const res = await lockStore.acquire(t.id, session.id, session.name);
      if (!res.ok) { toast(`Test locked by ${res.by}`, "error"); return; }
      activeTestIdRef.current = t.id;
      onLockChange?.(true);
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      heartbeatRef.current = setInterval(() => lockStore.heartbeat(t.id, session.id), HEARTBEAT_MS);
    }
    setSelTestIdx(idx);
  };

  const finishTest = async () => {
    if (activeTestIdRef.current) {
      await lockStore.release(activeTestIdRef.current, session.id);
      if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
      activeTestIdRef.current = null;
      onLockChange?.(false);
    }
    setSelTestIdx(null);
  };

  useEffect(() => () => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    if (activeTestIdRef.current && !isAdmin) lockStore.release(activeTestIdRef.current, session.id);
  }, []); // eslint-disable-line

  const addTest = () => {
    const n = prompt("Test name:");
    if (!n?.trim()) return;
    const nextSno = mod.tests.length ? Math.max(...mod.tests.map(t => t.serialNo || 0)) + 1 : 1;
    const newTest = { ...makeTest(mod.id, nextSno, 0), name: n.trim() };
    const updated = { ...allModules, [mod.id]: { ...mod, tests: [...mod.tests, newTest] } };
    saveMods(updated, true);
    toast(`Test "${n.trim()}" created`, "success");
  };

  const deleteTest = (idx) => {
    const t = mod.tests[idx];
    const updated = { ...allModules, [mod.id]: { ...mod, tests: mod.tests.filter((_, i) => i !== idx) } };
    saveMods(updated, true);
    addLog({ ts: Date.now(), user: session.name, action: `Deleted test "${t.name}" from ${mod.name}`, type: "warn" });
    toast(`Test "${t.name}" deleted`, "info");
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
      className="flex flex-col flex-1 overflow-hidden">
      <Topbar
        title={mod.name}
        sub={`${mod.tests.length} tests · ${mod.tests.flatMap(t => t.steps).filter(s => s.status === "pass").length} passed`}
      >
        {!isMobile && <SearchBox value={search} onChange={setSearch} placeholder="Search tests…" className="w-44" />}
        {isAdmin && (
          <Button size="sm" onClick={addTest}
            className="h-8 text-xs bg-sky-600 hover:bg-sky-700 border-0 text-white gap-1.5">
            <Plus className="w-3.5 h-3.5" /> Add Test
          </Button>
        )}
        {!isMobile && modIdx !== undefined && (
          <div className="flex items-center gap-1">
            <button onClick={() => onNav?.(-1)} disabled={modIdx === 0 || uiLocked}
              className="p-1 rounded text-slate-600 hover:text-slate-300 hover:bg-slate-800 disabled:opacity-30 transition-colors">
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="font-mono text-[10px] text-slate-600">{modIdx+1}/{modTotal}</span>
            <button onClick={() => onNav?.(1)} disabled={modIdx === modTotal - 1 || uiLocked}
              className="p-1 rounded text-slate-600 hover:text-slate-300 hover:bg-slate-800 disabled:opacity-30 transition-colors">
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </Topbar>

      {isMobile && (
        <div className="p-3 border-b border-slate-800 flex-shrink-0" style={{ background: "var(--tp-surface)" }}>
          <SearchBox value={search} onChange={setSearch} placeholder="Search tests…" className="w-full" />
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-2">
          {filtered.map((t, i) => {
            const realIdx = t._i;
            const realSteps = t.steps.filter(s => !s.isDivider);
            const pass = t.steps.filter(s => s.status === "pass").length;
            const fail = t.steps.filter(s => s.status === "fail").length;
            const pending = realSteps.filter(s => s.status === "pending").length;
            const pct = realSteps.length ? Math.round((pass / realSteps.length) * 100) : 0;
            const lock = locks[t.id];
            const lockedByOther = lock && lock.userId !== session.id;
            const isMyLockedTest = !isAdmin && activeTestIdRef.current === t.id;
            const blockedByMyLock = !isAdmin && uiLocked && !isMyLockedTest;
            const passW = realSteps.length ? (pass / realSteps.length) * 100 : 0;
            const failW = realSteps.length ? (fail / realSteps.length) * 100 : 0;

            const borderColor = lockedByOther ? "rgba(251,191,36,0.3)"
              : isMyLockedTest ? "rgba(52,211,153,0.3)"
              : fail > 0 ? "rgba(251,113,133,0.25)"
              : pass > 0 && pass === realSteps.length ? "rgba(52,211,153,0.25)"
              : "rgba(30,45,74,1)";

            return (
              <motion.div key={t.id} custom={i} variants={cardVariants} initial="initial" animate="animate"
                whileHover={!(lockedByOther || blockedByMyLock) ? { y: -2, boxShadow: "0 10px 28px rgba(0,0,0,0.35)" } : {}}
                transition={{ type: "spring", stiffness: 360, damping: 28 }}>
                <div
                  className={cn(
                    "rounded-xl border overflow-hidden transition-all",
                    lockedByOther || blockedByMyLock ? "opacity-60 cursor-not-allowed" : "cursor-pointer"
                  )}
                  style={{ borderColor, background: "var(--tp-card)" }}
                  onClick={() => !(lockedByOther || blockedByMyLock) && openTest(realIdx)}
                >
                  <div className={cn("flex items-center gap-3 px-4 py-3", isMobile && "flex-col items-start")}>
                    <div className="flex items-center gap-3 w-full">
                      {/* Serial badge */}
                      <div className={cn(
                        "w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center text-sm font-extrabold border",
                        lockedByOther ? "border-amber-500/40 text-amber-400 bg-amber-900/20"
                          : isMyLockedTest ? "border-emerald-500/40 text-emerald-400 bg-emerald-900/20"
                          : "border-slate-700 text-slate-400 bg-slate-800/50",
                      )} style={{ fontFamily: MONO }}>
                        {lockedByOther ? <Lock className="w-4 h-4" /> : isMyLockedTest ? <CheckCircle className="w-4 h-4" /> : t.serialNo}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-bold text-slate-100 text-sm truncate">{t.name}</div>
                        {lockedByOther && (
                          <Badge className="text-[9px] h-4 px-1.5 font-mono bg-amber-900/40 text-amber-400 border-amber-500/30 mt-0.5">
                            <Lock className="w-2.5 h-2.5 mr-1" /> In use by {lock.userName}
                          </Badge>
                        )}
                        {isMyLockedTest && (
                          <Badge className="text-[9px] h-4 px-1.5 font-mono bg-emerald-900/40 text-emerald-400 border-emerald-500/30 mt-0.5">
                            <CheckCircle className="w-2.5 h-2.5 mr-1" /> Your active test
                          </Badge>
                        )}
                        {t.description && (
                          <div className="text-[11px] text-slate-500 truncate">{t.description}</div>
                        )}
                        <div className="text-[10px] font-mono text-slate-600">
                          {t.steps.length} steps
                          {pass > 0 && <span className="text-emerald-500 ml-1.5 font-bold">·{pass}✓</span>}
                          {fail > 0 && <span className="text-rose-500 ml-1 font-bold">{fail}✗</span>}
                          {pending > 0 && <span className="text-slate-600 ml-1">{pending} pending</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0" onClick={e => e.stopPropagation()}>
                        {isAdmin && !isMobile && (
                          <button onClick={() => deleteTest(realIdx)}
                            className="p-1 rounded text-slate-600 hover:text-rose-400 hover:bg-rose-900/30 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {lockedByOther ? (
                          <span className="text-[10px] font-mono text-amber-400 border border-amber-500/30 bg-amber-900/20 px-2 py-1 rounded-full">
                            <Lock className="w-3 h-3 inline mr-1" />Locked
                          </span>
                        ) : isMyLockedTest ? (
                          <Button size="sm" onClick={() => openTest(realIdx)}
                            className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 border-0 text-white gap-1">
                            <ArrowLeft className="w-3 h-3" /> Return
                          </Button>
                        ) : blockedByMyLock ? (
                          <span className="p-1 text-slate-700"><Lock className="w-3.5 h-3.5" /></span>
                        ) : (
                          <Button size="sm" onClick={() => openTest(realIdx)}
                            className="h-7 text-xs bg-sky-600 hover:bg-sky-700 border-0 text-white gap-1">
                            {!isMobile && "Open"} <ChevronRight className="w-3 h-3" />
                          </Button>
                        )}
                        {isAdmin && isMobile && (
                          <button onClick={() => deleteTest(realIdx)}
                            className="p-1 rounded text-slate-600 hover:text-rose-400 hover:bg-rose-900/30 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      {!isMobile && (
                        <div className="w-20 flex-shrink-0">
                          <PBar pct={pct} fail={fail > 0} />
                          <div className="text-[10px] font-mono text-slate-600 text-right mt-0.5">{pct}%</div>
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Dual progress bar */}
                  <div className="h-1 flex bg-slate-800">
                    <motion.div initial={{ width: 0 }} animate={{ width: `${passW}%` }} transition={{ duration: 0.65, ease: [0.4,0,0.2,1] }}
                      style={{ background: "linear-gradient(90deg, #10b981, #34d399)", minWidth: 0 }} />
                    <motion.div initial={{ width: 0 }} animate={{ width: `${failW}%` }} transition={{ duration: 0.65, ease: [0.4,0,0.2,1], delay: 0.1 }}
                      style={{ background: "linear-gradient(90deg, #f43f5e, #fb7185)", minWidth: 0 }} />
                  </div>
                </div>
              </motion.div>
            );
          })}
          {filtered.length === 0 && (
            <div className="text-center py-16 text-slate-600">
              <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <div className="font-mono text-sm">No tests match.</div>
            </div>
          )}
        </div>
      </div>
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

  const toggleExp = id => setExp(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const statusColor = s => s === "pass" ? "text-emerald-400" : s === "fail" ? "text-rose-400" : "text-slate-500";
  const statusBg = s => s === "pass" ? "bg-emerald-900/30" : s === "fail" ? "bg-rose-900/30" : "";

  return (
    <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit"
      className="flex flex-col flex-1 overflow-hidden">
      <Topbar title="Test Report" sub={`${pass} passed · ${fail} failed · ${total - pass - fail} pending`}>
        {!isMobile && <SearchBox value={search} onChange={setSearch} placeholder="Search modules…" className="w-44" />}
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-slate-500">Failures only</span>
          <Switch checked={failOnly} onCheckedChange={setFailOnly} className="scale-75" />
        </div>
        <Button size="sm" variant="outline" onClick={exportAllCSV}
          className="h-8 text-xs border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 gap-1.5">
          <Download className="w-3.5 h-3.5" /> Export All
        </Button>
      </Topbar>

      {isMobile && (
        <div className="p-3 border-b border-slate-800 flex-shrink-0" style={{ background: "var(--tp-surface)" }}>
          <SearchBox value={search} onChange={setSearch} placeholder="Search modules…" className="w-full" />
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {/* Summary */}
        <div className={cn("grid gap-3 mb-5", isMobile ? "grid-cols-2" : "grid-cols-4")}>
          {[
            { label: "Total Steps", value: total, color: "#38bdf8", bg: "rgba(56,189,248,0.06)", border: "rgba(56,189,248,0.15)" },
            { label: "Passed", value: pass, color: "#34d399", bg: "rgba(52,211,153,0.06)", border: "rgba(52,211,153,0.15)" },
            { label: "Failed", value: fail, color: "#fb7185", bg: "rgba(251,113,133,0.06)", border: "rgba(251,113,133,0.15)" },
            { label: "Pending", value: total - pass - fail, color: "#fbbf24", bg: "rgba(251,191,36,0.06)", border: "rgba(251,191,36,0.15)" },
          ].map((c, i) => (
            <motion.div key={c.label} custom={i} variants={cardVariants} initial="initial" animate="animate">
              <div className="rounded-xl border p-4 relative overflow-hidden"
                style={{ background: c.bg, borderColor: c.border }}>
                <div className="absolute top-0 left-0 right-0 h-0.5"
                  style={{ background: `linear-gradient(90deg, transparent, ${c.color}, transparent)` }} />
                <div className="text-[9px] font-mono uppercase tracking-[0.15em] mb-2" style={{ color: c.color }}>{c.label}</div>
                <div className="text-3xl font-extrabold" style={{ color: c.color, fontFamily: "'Syne', sans-serif" }}>
                  {c.value.toLocaleString()}
                </div>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Module list */}
        <div className="space-y-2">
          {filtered.map((m, i) => {
            const pct = Math.round((m.pass / Math.max(m.total, 1)) * 100);
            const isExp = exp.has(m.id);
            const hasFail = m.fail > 0;
            const isDone = m.pass === m.total && m.total > 0;
            return (
              <motion.div key={m.id} custom={i} variants={cardVariants} initial="initial" animate="animate">
                <div className="rounded-xl border overflow-hidden"
                  style={{
                    borderColor: hasFail ? "rgba(251,113,133,0.3)" : isDone ? "rgba(52,211,153,0.3)" : "rgba(30,45,74,1)",
                    background: "var(--tp-card)"
                  }}>
                  <button
                    onClick={() => toggleExp(m.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-800/30 transition-colors text-left"
                  >
                    <motion.span animate={{ rotate: isExp ? 90 : 0 }} transition={{ type: "spring", stiffness: 300, damping: 25 }}>
                      <ChevronRight className="w-4 h-4 text-slate-500" />
                    </motion.span>
                    <span className="font-bold text-slate-100 flex-1 text-sm">{m.name}</span>
                    <div className="flex gap-1.5 items-center">
                      {m.pass > 0 && <Badge className="text-[9px] h-4 px-1.5 font-mono bg-emerald-900/50 text-emerald-400 border-emerald-500/30">{m.pass} passed</Badge>}
                      {m.fail > 0 && <Badge className="text-[9px] h-4 px-1.5 font-mono bg-rose-900/50 text-rose-400 border-rose-500/30">{m.fail} failed</Badge>}
                      <Badge className={cn(
                        "text-[10px] h-4 px-1.5 font-mono font-bold",
                        pct === 100 ? "bg-emerald-900/50 text-emerald-400 border-emerald-500/30"
                          : hasFail ? "bg-rose-900/50 text-rose-400 border-rose-500/30"
                          : "bg-sky-900/50 text-sky-400 border-sky-500/30"
                      )}>{pct}%</Badge>
                    </div>
                    <div className="w-24"><PBar pct={pct} fail={hasFail} /></div>
                  </button>

                  <AnimatePresence>
                    {isExp && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="border-t border-slate-800 overflow-hidden"
                      >
                        {m.tests.map(t => {
                          const tp = t.steps.filter(s => !s.isDivider && s.status === "pass").length;
                          const tf = t.steps.filter(s => !s.isDivider && s.status === "fail").length;
                          if (t.steps.length === 0) return null;
                          return (
                            <div key={t.id}>
                              <div className="flex items-center gap-2 px-4 py-2" style={{ background: "var(--tp-elevated)" }}>
                                <span className="font-semibold text-slate-300 text-xs flex-1">{t.name}</span>
                                <span className="font-mono text-[10px] text-slate-500">✓{tp} ✗{tf} ⟳{t.steps.filter(s => !s.isDivider).length-tp-tf}</span>
                              </div>
                              {!isMobile && (
                                <Table>
                                  <TableHeader>
                                    <TableRow className="border-slate-800 hover:bg-transparent">
                                      {["S.No","Action","Expected Result","Remarks","Status"].map(h => (
                                        <TableHead key={h} className="text-[9px] font-mono text-slate-600 uppercase tracking-[0.12em] py-1.5 border-b border-slate-800">
                                          {h}
                                        </TableHead>
                                      ))}
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {t.steps.map(s => s.isDivider ? (
                                      <TableRow key={s.id} className="border-slate-800">
                                        <TableCell colSpan={5} className="py-1.5 font-mono text-[10px] text-sky-400 uppercase tracking-wider"
                                          style={{ background: "rgba(14,165,233,0.04)" }}>
                                          {s.action}
                                        </TableCell>
                                      </TableRow>
                                    ) : (
                                      <TableRow key={s.id} className={cn("border-slate-800", statusBg(s.status))}>
                                        <TableCell className="font-mono text-[11px] text-slate-500 text-center w-14">{s.serialNo || "—"}</TableCell>
                                        <TableCell className="text-[12px] text-slate-300">{s.action}</TableCell>
                                        <TableCell className="text-[12px] text-slate-500">{s.result}</TableCell>
                                        <TableCell className="text-[12px] text-slate-600">{s.remarks}</TableCell>
                                        <TableCell className="w-20">
                                          <Badge className={cn(
                                            "text-[9px] h-4 px-1.5 font-mono font-bold",
                                            s.status === "pass" ? "bg-emerald-900/50 text-emerald-400 border-emerald-500/30"
                                              : s.status === "fail" ? "bg-rose-900/50 text-rose-400 border-rose-500/30"
                                              : "bg-slate-800 text-slate-500 border-slate-700"
                                          )}>
                                            {s.status.toUpperCase()}
                                          </Badge>
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              )}
                            </div>
                          );
                        })}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            );
          })}
          {filtered.length === 0 && (
            <div className="text-center py-12 font-mono text-sm text-slate-600">No modules match.</div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ── Audit View ─────────────────────────────────────────────────────────────────────
function AuditView({ log }) {
  const fmt = ts => new Date(ts).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const dotColor = { pass: "#34d399", fail: "#fb7185", warn: "#fbbf24", info: "#38bdf8" };
  const dotGlow = { pass: "rgba(52,211,153,0.2)", fail: "rgba(251,113,133,0.2)", warn: "rgba(251,191,36,0.2)", info: "rgba(56,189,248,0.2)" };

  return (
    <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit"
      className="flex flex-col flex-1 overflow-hidden">
      <Topbar title="Audit Log" sub={`${log.length} events recorded`} />
      <div className="flex-1 overflow-y-auto p-4">
        <div className="rounded-xl border border-slate-800 overflow-hidden" style={{ background: "var(--tp-card)" }}>
          {log.length === 0 && (
            <div className="p-12 text-center font-mono text-sm text-slate-600">No events yet.</div>
          )}
          {log.map((e, i) => (
            <motion.div key={i}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: Math.min(i * 0.015, 0.3), type: "spring", stiffness: 320, damping: 28 }}
              className="flex items-start gap-3 px-4 py-3 border-b border-slate-800 hover:bg-slate-800/30 transition-colors last:border-b-0"
            >
              <div className="w-2 h-2 rounded-full flex-shrink-0 mt-1.5"
                style={{
                  background: dotColor[e.type] || dotColor.info,
                  boxShadow: `0 0 0 3px ${dotGlow[e.type] || dotGlow.info}`,
                }} />
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium text-slate-300">{e.action}</div>
                <div className="text-[10px] font-mono text-slate-600">{e.user}</div>
              </div>
              <div className="text-[10px] font-mono text-slate-600 flex-shrink-0">{fmt(e.ts)}</div>
            </motion.div>
          ))}
        </div>
      </div>
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

  return (
    <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit"
      className="flex flex-col flex-1 overflow-hidden">
      <Topbar title="User Management" sub={`${users.length} users · ${users.filter(u => u.active).length} active`}>
        {!isMobile && <SearchBox value={search} onChange={setSearch} placeholder="Search users…" className="w-44" />}
        <Button size="sm" onClick={openAdd}
          className="h-8 text-xs bg-sky-600 hover:bg-sky-700 border-0 text-white gap-1.5">
          <Plus className="w-3.5 h-3.5" />{!isMobile && "Add User"}
        </Button>
      </Topbar>

      {isMobile && (
        <div className="p-3 border-b border-slate-800 flex-shrink-0" style={{ background: "var(--tp-surface)" }}>
          <SearchBox value={search} onChange={setSearch} placeholder="Search users…" className="w-full" />
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-2">
          {filtered.map((u, i) => (
            <motion.div key={u.id} custom={i} variants={cardVariants} initial="initial" animate="animate"
              whileHover={{ y: -2, boxShadow: "0 8px 24px rgba(0,0,0,0.3)" }}
              transition={{ type: "spring", stiffness: 360, damping: 28 }}>
              <div className={cn(
                "rounded-xl border p-4 transition-all",
                u.active ? "border-slate-800" : "border-rose-500/20"
              )} style={{ background: "var(--tp-card)", opacity: u.active ? 1 : 0.7 }}>
                <div className={cn("flex gap-3", isMobile ? "flex-col" : "items-center")}>
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <Avatar className="w-11 h-11 flex-shrink-0 ring-2 ring-offset-2 ring-offset-slate-900"
                      style={{ '--tw-ring-color': u.role === "admin" ? "rgba(56,189,248,0.4)" : "rgba(251,191,36,0.3)" }}>
                      <AvatarFallback className="text-sm font-bold"
                        style={{ background: u.role === "admin" ? "linear-gradient(135deg, #0c2a50, #0f3d6e)" : "linear-gradient(135deg, #1c1a0f, #2d2510)", color: u.role === "admin" ? "#38bdf8" : "#fbbf24" }}>
                        {u.name?.[0]?.toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-bold text-slate-100 text-sm">{u.name}</span>
                        <Badge className={cn(
                          "text-[9px] h-4 px-1.5 font-mono",
                          u.role === "admin" ? "bg-sky-900/50 text-sky-400 border-sky-500/30" : "bg-amber-900/40 text-amber-400 border-amber-500/30"
                        )}>
                          {u.role === "admin" ? <ShieldCheck className="w-2.5 h-2.5 mr-1" /> : <User className="w-2.5 h-2.5 mr-1" />}
                          {u.role}
                        </Badge>
                        <Badge className={cn(
                          "text-[9px] h-4 px-1.5 font-mono",
                          u.active ? "bg-emerald-900/50 text-emerald-400 border-emerald-500/30" : "bg-rose-900/50 text-rose-400 border-rose-500/30"
                        )}>
                          {u.active ? "active" : "inactive"}
                        </Badge>
                      </div>
                      <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                        @{u.username}{u.email ? ` · ${u.email}` : ""}
                      </div>
                    </div>
                    {isMobile && (
                      <div className="flex gap-1 ml-auto">
                        <button onClick={() => openEdit(u)}
                          className="p-1.5 rounded-lg text-sky-400 hover:bg-sky-900/30 transition-colors">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        {u.id !== session.id && (
                          <button onClick={() => setConfirm(u)}
                            className="p-1.5 rounded-lg text-rose-400 hover:bg-rose-900/30 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className={cn("flex items-center gap-3", isMobile ? "w-full" : "flex-shrink-0")}>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-slate-600">Active</span>
                      <Switch checked={u.active} onCheckedChange={() => toggle(u)} disabled={u.id === session.id} className="scale-75" />
                    </div>
                    {!isMobile && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => openEdit(u)}
                          className="h-7 text-xs border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 gap-1.5">
                          <Pencil className="w-3 h-3" /> Edit
                        </Button>
                        {u.id !== session.id && (
                          <Button size="sm" variant="outline" onClick={() => setConfirm(u)}
                            className="h-7 text-xs border-rose-500/30 text-rose-400 hover:bg-rose-900/30 gap-1.5">
                            <Trash2 className="w-3 h-3" /> Delete
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
          {filtered.length === 0 && (
            <div className="text-center py-16 text-slate-600">
              <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <div className="font-mono text-sm">No users match.</div>
            </div>
          )}
        </div>
      </div>

      {/* Add/Edit Dialog */}
      <FormDialog
        open={Boolean(modal)}
        onClose={() => setModal(null)}
        title={modal === "add" ? "Add User" : "Edit User"}
        subtitle={modal === "add" ? "Create a new team member account" : undefined}
        actions={
          <>
            <Button variant="outline" onClick={() => setModal(null)}
              className="border-slate-700 text-slate-300 hover:bg-slate-800">Cancel</Button>
            <Button onClick={save} className="bg-sky-600 hover:bg-sky-700 border-0 text-white">
              {modal === "add" ? "Create User" : "Save Changes"}
            </Button>
          </>
        }
      >
        <FormField label="Full Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} autoFocus />
        <FormField label="Username" value={form.username} onChange={v => setForm(f => ({ ...f, username: v }))} />
        <FormField label="Email (optional)" value={form.email || ""} onChange={v => setForm(f => ({ ...f, email: v }))} type="email" />
        <FormField label="Password" value={form.password} onChange={v => setForm(f => ({ ...f, password: v }))} type="password" />
        <div className="mb-4">
          <Label className="text-slate-300 text-xs font-medium mb-1.5 block">Role</Label>
          <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v }))}>
            <SelectTrigger className="bg-slate-800 border-slate-700 text-slate-100 h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700 text-slate-200">
              <SelectItem value="tester" className="hover:bg-slate-700 cursor-pointer">Tester</SelectItem>
              <SelectItem value="admin" className="hover:bg-slate-700 cursor-pointer">Admin</SelectItem>
            </SelectContent>
          </Select>
        </div>
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
  useGlobalStyles();

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

  // Loading screen
  if (!users || !modules) return (
    <div className="h-dvh flex items-center justify-center flex-col gap-3" style={{ background: "var(--tp-bg)" }}>
      <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.4, repeat: Infinity, ease: "linear" }}>
        <div className="w-12 h-12 rounded-xl flex items-center justify-center"
          style={{ background: "linear-gradient(135deg, #0ea5e9, #6366f1)", boxShadow: "0 0 24px rgba(14,165,233,0.4)" }}>
          <CheckSquare className="w-6 h-6 text-white" />
        </div>
      </motion.div>
      <span className="text-[11px] font-mono text-slate-600 tracking-wider">Loading TestPro…</span>
    </div>
  );

  if (!session) return (
    <LoginPage
      users={users}
      onLogin={u => {
        setSession(u);
        addLog({ ts: Date.now(), user: u.name, action: "Logged in", type: "info" });
      }}
    />
  );

  const modKeys = Object.keys(modules);
  const modIdx = selMod ? modKeys.indexOf(selMod) : -1;

  const mobileNavItems = [
    { id: "dash", icon: <LayoutDashboard className="w-5 h-5" />, label: "Dashboard" },
    { id: "report", icon: <BarChart3 className="w-5 h-5" />, label: "Report" },
    ...(session.role === "admin"
      ? [{ id: "users", icon: <Users className="w-5 h-5" />, label: "Users" }, { id: "audit", icon: <History className="w-5 h-5" />, label: "Audit" }]
      : []),
    { id: "_modules", icon: <Layers className="w-5 h-5" />, label: "Modules" },
  ];

  const currentMobileNavVal = view === "mod" ? "_modules" : view;

  return (
    <TooltipProvider>
      <MobileMenuCtx.Provider value={() => setMobileDrawerOpen(true)}>
        <div className="flex h-dvh overflow-hidden" style={{ background: "var(--tp-bg)" }}>
          {/* Sidebar */}
          <Sidebar
            session={session} view={view} setView={setView} modules={modules}
            selMod={selMod}
            setSelMod={id => {
              if (session.role !== "admin" && hasLock && !(selMod === id && view === "mod")) {
                toast("Finish the current test first", "error"); return;
              }
              setSelMod(id); setView("mod");
            }}
            collapsed={sideColl} setCollapsed={setSideColl}
            locked={session.role !== "admin" && hasLock}
            mobileOpen={mobileDrawerOpen} onMobileClose={() => setMobileDrawerOpen(false)}
            onLogout={() => { addLog({ ts: Date.now(), user: session.name, action: "Logged out", type: "info" }); handleLogout(session); }}
          />

          {/* Main content */}
          <div className="flex-1 flex flex-col overflow-hidden min-w-0"
            style={{ paddingBottom: isMobile ? "calc(58px + env(safe-area-inset-bottom, 0px))" : 0 }}>
            <AnimatePresence mode="wait">
              {view === "dash" && (
                <Dashboard key="dash" modules={modules} session={session}
                  onSelect={id => {
                    if (session.role !== "admin" && hasLock) { toast("Finish the current test first", "error"); return; }
                    setSelMod(id); setView("mod");
                  }}
                  saveMods={saveMods} addLog={addLog} toast={toast}
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
          </div>

          {/* Mobile bottom nav */}
          {isMobile && (
            <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-slate-800 pb-safe"
              style={{ background: "rgba(11,17,32,0.96)", backdropFilter: "blur(24px)" }}>
              <div className="flex items-center h-[58px]">
                {mobileNavItems.map(item => {
                  const isActive = currentMobileNavVal === item.id;
                  return (
                    <button key={item.id}
                      onClick={() => {
                        if (item.id === "_modules") { setMobileDrawerOpen(true); return; }
                        if (session.role !== "admin" && hasLock && item.id !== view) { toast("Finish the current test first", "error"); return; }
                        setView(item.id);
                      }}
                      className={cn(
                        "flex-1 flex flex-col items-center justify-center gap-1 py-2 transition-all",
                        isActive ? "text-sky-400" : "text-slate-600"
                      )}>
                      <span className={isActive ? "text-sky-400" : "text-slate-600"}>{item.icon}</span>
                      <span className={cn("text-[9px] font-mono", isActive ? "font-bold" : "")}>{item.label}</span>
                    </button>
                  );
                })}
                <button
                  onClick={() => { addLog({ ts: Date.now(), user: session.name, action: "Logged out", type: "info" }); handleLogout(session); }}
                  className="flex-1 flex flex-col items-center justify-center gap-1 py-2 text-rose-500 border-l border-slate-800 transition-colors hover:text-rose-400">
                  <LogOut className="w-5 h-5" />
                  <span className="text-[9px] font-mono">Logout</span>
                </button>
              </div>
            </div>
          )}

          <ToastHost />
        </div>
      </MobileMenuCtx.Provider>
    </TooltipProvider>
  );
}
