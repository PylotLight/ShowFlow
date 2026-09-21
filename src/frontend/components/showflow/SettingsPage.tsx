import * as React from "react";
import {
  CheckIcon, XIcon, Loader2Icon,
  ChevronRight, ArrowLeft,
  Settings2, Palette, KeyRound, Database, Plug, Gauge,
  FileText, Download, Clock, Archive, BarChart3, Bug,
} from "lucide-react";

import { HeaderActions } from "@frontend/lib/header-actions";

import { loadAccent, saveAccent, applyAccent, loadTheme, saveTheme, applyTheme, type ThemeConfig } from "@frontend/lib/theme";
import { QualityProfilesTab } from "@frontend/components/showflow/QualityProfiles";

import { GeneralTab } from "./GeneralTab";
import { ProvidersTab } from "./ProvidersTab";
import { IndexersTab } from "./IndexersTab";
import { IntegrationsTab } from "./IntegrationsTab";
import { AppearanceTab } from "./AppearanceTab";
import { DownloadsTab } from "./DownloadsTab";
import { NamingTab } from "./NamingTab";
import { TasksPanel } from "./TasksPanel";
import { BackupPanel } from "./BackupPanel";
import { AnalyticsPanel } from "./AnalyticsPanel";
import { DebugSettings } from "./DebugSettings";
import { cn } from "./SettingsShared";

const SETTINGS_TABS: { id: string; label: string; icon: React.ComponentType<{ className?: string }>; mobileStyle: "sheet" | "drill" }[] = [
  { id: "general", label: "General", icon: Settings2, mobileStyle: "sheet" },
  { id: "appearance", label: "Appearance", icon: Palette, mobileStyle: "drill" },
  { id: "providers", label: "Providers", icon: KeyRound, mobileStyle: "sheet" },
  { id: "indexers", label: "Indexers", icon: Database, mobileStyle: "sheet" },
  { id: "integrations", label: "Integrations", icon: Plug, mobileStyle: "sheet" },
  { id: "quality", label: "Quality", icon: Gauge, mobileStyle: "sheet" },
  { id: "naming", label: "Naming", icon: FileText, mobileStyle: "drill" },
  { id: "downloads", label: "Downloads", icon: Download, mobileStyle: "drill" },
  { id: "tasks", label: "Tasks", icon: Clock, mobileStyle: "drill" },
  { id: "backup", label: "Backup", icon: Archive, mobileStyle: "drill" },
  { id: "analytics", label: "Analytics", icon: BarChart3, mobileStyle: "drill" },
  { id: "debug", label: "Debug", icon: Bug, mobileStyle: "drill" },
];

export function SettingsPage({ onDone: _onDone, initialTab, scrollToSection, onReRunWizard }: { onDone: () => void; initialTab?: string; scrollToSection?: string; onReRunWizard?: () => void }) {
  const [tab, setTab] = React.useState(initialTab || "general");
  const [mobileSection, setMobileSection] = React.useState<string | null>(initialTab || null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState<string | null>(null);
  const [saveMsg, setSaveMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const [config, setConfig] = React.useState<any>({});
  const [prowlarr, setProwlarr] = React.useState({ enabled: true, baseUrl: "", apiKey: "", syncLevel: "full", tags: [] as number[] });

  const [sonarr, setSonarr] = React.useState({ enabled: false, baseUrl: "", apiKey: "", apiVersion: "v3" as "v3" | "v5" });
  const [showSonarrKey, setShowSonarrKey] = React.useState(false);

  const [jellyfin, setJellyfin] = React.useState({ enabled: false, baseUrl: "", apiKey: "" });
  const [showJellyfinKey, setShowJellyfinKey] = React.useState(false);
  const [jellyfinTesting, setJellyfinTesting] = React.useState(false);
  const [jellyfinStatus, setJellyfinStatus] = React.useState<{ ok: boolean; message?: string; version?: string } | null>(null);
  const [jellyfinSyncing, setJellyfinSyncing] = React.useState(false);
  const [jellyfinSyncResult, setJellyfinSyncResult] = React.useState<{ totalEpisodes?: number; matchedEpisodes?: number; errors?: string[] } | null>(null);

  const [showProwlarrKey, setShowProwlarrKey] = React.useState(false);
  const [showTmdbKey, setShowTmdbKey] = React.useState(false);
  const [showTvdbKey, setShowTvdbKey] = React.useState(false);
  const [showTvdbPin, setShowTvdbPin] = React.useState(false);
  const [showTorboxKey, setShowTorboxKey] = React.useState(false);

  const [accent, setAccent] = React.useState(loadAccent);
  const [theme, setTheme] = React.useState<ThemeConfig | null>(null);

  const [sonarrTesting, setSonarrTesting] = React.useState(false);
  const [sonarrStatus, setSonarrStatus] = React.useState<{ ok: boolean; message?: string; version?: string } | null>(null);
  const [sonarrSeries, setSonarrSeries] = React.useState<any[] | null>(null);
  const [sonarrSeriesLoading, setSonarrSeriesLoading] = React.useState(false);
  const [sonarrImporting, setSonarrImporting] = React.useState(false);
  const [sonarrImportJobId, setSonarrImportJobId] = React.useState<string | null>(null);
  const [selectedSonarrSeries, setSelectedSonarrSeries] = React.useState<Set<number>>(new Set());

  const [showProfilesList, setShowProfilesList] = React.useState<any[]>([]);
  const [qualityProfilesList, setQualityProfilesList] = React.useState<any[]>([]);
  const [libraryTypesList, setLibraryTypesList] = React.useState<any[]>([]);
  const [sonarrTypeConfig, setSonarrTypeConfig] = React.useState<Record<string, { included: boolean; showProfileId: string; qualityProfileId: string; libraryTypeId: string }>>({});

  const visibleSonarrSeries = React.useMemo(() => {
    if (!sonarrSeries) return [];
    return sonarrSeries.filter((s: any) => sonarrTypeConfig[s.seriesType || 'standard']?.included !== false);
  }, [sonarrSeries, sonarrTypeConfig]);

  const sonarrTypesPresent = React.useMemo(() => {
    if (!sonarrSeries) return [];
    const counts: Record<string, number> = {};
    for (const s of sonarrSeries) {
      const t = s.seriesType || 'standard';
      counts[t] = (counts[t] || 0) + 1;
    }
    return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  }, [sonarrSeries]);

  const [prowlarrTesting, setProwlarrTesting] = React.useState(false);
  const [prowlarrStatus, setProwlarrStatus] = React.useState<{ ok: boolean; message?: string } | null>(null);

  const [indexers, setIndexers] = React.useState<any[] | null>(null);
  const [indexersLoading, setIndexersLoading] = React.useState(false);

  const [nativeIndexers, setNativeIndexers] = React.useState<any[]>([]);
  const [nativeMeta, setNativeMeta] = React.useState<any[]>([]);
  const [nativeSaving, setNativeSaving] = React.useState(false);
  const [nativeTesting, setNativeTesting] = React.useState<Record<string, boolean>>({});
  const [nativeStatuses, setNativeStatuses] = React.useState<Record<string, { ok: boolean; message?: string }>>({});

  const [tasks, setTasks] = React.useState<any[]>([]);
  const [tasksLoading, setTasksLoading] = React.useState(false);
  const [taskRunning, setTaskRunning] = React.useState<Record<string, boolean>>({});

  React.useEffect(() => {
    if (!mobileSection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileSection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileSection]);

  React.useEffect(() => {
    Promise.all([
      fetch("/api/config").then(r => r.json()),
      fetch("/api/settings").then(r => r.json()),
      fetch("/api/indexers/native/meta").then(r => r.json()),
      fetch("/api/tasks").then(r => r.json()),
      fetch("/api/show-profiles").then(r => r.json()).catch(() => []),
      fetch("/api/profiles").then(r => r.json()).catch(() => []),
      fetch("/api/library-types").then(r => r.json()).catch(() => []),
      loadTheme(),
    ]).then(([cfg, settings, nativeMetaData, tasksData, showProfilesData, qualityProfilesData, libraryTypesData, loadedTheme]) => {
      setConfig(cfg);
      setTheme(loadedTheme);
      setNativeMeta(Array.isArray(nativeMetaData) ? nativeMetaData : []);
      setTasks(Array.isArray(tasksData) ? tasksData : []);
      setShowProfilesList(Array.isArray(showProfilesData) ? showProfilesData : []);
      setQualityProfilesList(Array.isArray(qualityProfilesData) ? qualityProfilesData : []);
      setLibraryTypesList(Array.isArray(libraryTypesData) ? libraryTypesData : []);
      const sonarrRaw = settings.find((s: any) => s.key === "sonarr");
      if (sonarrRaw) {
        try {
          const s = JSON.parse(sonarrRaw.value);
          setSonarr({ enabled: !!s.enabled, baseUrl: s.baseUrl || "", apiKey: s.apiKey || "", apiVersion: s.apiVersion === "v5" ? "v5" : "v3" });
        } catch {}
      }

      const jellyfinRaw = settings.find((s: any) => s.key === "jellyfin");
      if (jellyfinRaw) {
        try {
          const j = JSON.parse(jellyfinRaw.value);
          setJellyfin({ enabled: !!j.enabled, baseUrl: j.baseUrl || "", apiKey: j.apiKey || "" });
        } catch {}
      }

      const prowlarrRaw = settings.find((s: any) => s.key === "prowlarr");
      if (prowlarrRaw) {
        try {
          const p = JSON.parse(prowlarrRaw.value);
          setProwlarr({ enabled: p.enabled !== false, baseUrl: p.baseUrl || "", apiKey: p.apiKey || "", syncLevel: p.syncLevel || "full", tags: p.tags || [] });
        } catch {}
      }
      const nativeRaw = settings.find((s: any) => s.key === "nativeIndexers");
      if (nativeRaw) {
        try {
          setNativeIndexers(JSON.parse(nativeRaw.value));
        } catch {}
      }
      setLoading(false);
    });
  }, []);

  function loadTasks() {
    setTasksLoading(true);
    fetch("/api/tasks").then(r => r.json()).then(data => {
      setTasks(Array.isArray(data) ? data : []);
    }).catch(() => setTasks([]))
    .finally(() => setTasksLoading(false));
  }

  function updateTheme(updates: Record<string, any>) {
    if (!theme) return;
    const next = { ...theme, ...updates };
    setTheme(next);
    applyTheme(next);
    saveTheme(next);
  }

  function saveConfig(updates: Record<string, any>) {
    setSaving("config");
    setSaveMsg(null);
    fetch("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    }).then(r => {
      if (r.ok) {
        setSaveMsg({ ok: true, text: "Saved" });
        setConfig((prev: any) => ({ ...prev, ...updates }));
      } else {
        setSaveMsg({ ok: false, text: "Failed to save" });
      }
    }).catch(() => setSaveMsg({ ok: false, text: "Network error" }))
    .finally(() => setSaving(null));
  }

  function saveProwlarr() {
    setSaving("prowlarr");
    setSaveMsg(null);
    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "prowlarr", value: prowlarr }),
    }).then(r => {
      setSaveMsg(r.ok ? { ok: true, text: "Saved" } : { ok: false, text: "Failed to save" });
    }).catch(() => setSaveMsg({ ok: false, text: "Network error" }))
    .finally(() => setSaving(null));
  }

  function saveProwlarrWithDefaults(overrides: any) {
    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "prowlarr", value: overrides }),
    }).catch(() => {});
  }

  function testProwlarr() {
    setProwlarrTesting(true);
    setProwlarrStatus(null);
    fetch("/api/indexers/prowlarr/status").then(r => r.json()).then(res => {
      setProwlarrStatus(res);
    }).catch(() => setProwlarrStatus({ ok: false, message: "Connection failed" }))
    .finally(() => setProwlarrTesting(false));
  }

  function loadIndexers() {
    setIndexersLoading(true);
    setIndexers(null);
    fetch("/api/indexers/prowlarr/indexers").then(r => r.json()).then(res => {
      setIndexers(Array.isArray(res) ? res : []);
    }).catch(() => setIndexers([]))
    .finally(() => setIndexersLoading(false));
  }

  function saveNativeIndexers(configs: any[]) {
    setNativeSaving(true);
    setSaveMsg(null);
    setNativeIndexers(configs);
    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "nativeIndexers", value: configs }),
    }).then(r => {
      setSaveMsg(r.ok ? { ok: true, text: "Saved" } : { ok: false, text: "Failed to save" });
    }).catch(() => setSaveMsg({ ok: false, text: "Network error" }))
    .finally(() => setNativeSaving(false));
  }

  function toggleNativeIndexer(id: string, enabled: boolean) {
    const next = nativeIndexers.map((n: any) => n.id === id ? { ...n, enabled } : n);
    if (!next.find((n: any) => n.id === id)) {
      next.push({ id, enabled, baseUrl: undefined });
    }
    saveNativeIndexers(next);
  }

  function updateNativeBaseUrl(id: string, baseUrl: string) {
    const next = nativeIndexers.map((n: any) => n.id === id ? { ...n, baseUrl: baseUrl || undefined } : n);
    if (!next.find((n: any) => n.id === id)) {
      next.push({ id, enabled: false, baseUrl: baseUrl || undefined });
    }
    saveNativeIndexers(next);
  }

  function testNativeIndexer(id: string) {
    setNativeTesting((prev: any) => ({ ...prev, [id]: true }));
    setNativeStatuses((prev: any) => ({ ...prev, [id]: undefined as any }));
    fetch(`/api/indexers/native/test/${id}`).then(r => r.json()).then(res => {
      setNativeStatuses((prev: any) => ({ ...prev, [id]: res }));
    }).catch(() => setNativeStatuses((prev: any) => ({ ...prev, [id]: { ok: false, message: "Connection failed" } })))
    .finally(() => setNativeTesting((prev: any) => ({ ...prev, [id]: false })));
  }

  function updateApiKey(provider: string, value: string) {
    const newKeys = { ...(config.apiKeys || {}), [provider]: value || undefined };
    const clean = Object.fromEntries(Object.entries(newKeys).filter(([_, v]) => v));
    saveConfig({ apiKeys: clean });
  }

  function saveImdb(imdb: any) {
    saveConfig({ imdb });
  }

  function updateTaskConfig(name: string, updates: { enabled?: boolean; intervalMinutes?: number }) {
    setSaving(`task-${name}`);
    setSaveMsg(null);
    fetch(`/api/tasks/${name}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    }).then(r => {
      if (r.ok) {
        setSaveMsg({ ok: true, text: "Task updated" });
        loadTasks();
      } else {
        setSaveMsg({ ok: false, text: "Failed to update task" });
      }
    }).catch(() => setSaveMsg({ ok: false, text: "Network error" }))
    .finally(() => setSaving(null));
  }

  function runTaskNow(name: string) {
    setTaskRunning((prev: any) => ({ ...prev, [name]: true }));
    setSaveMsg(null);
    fetch(`/api/tasks/${name}`, {
      method: "POST",
    }).then(r => r.json()).then(res => {
      setSaveMsg({ ok: res.success, text: res.message || "Task completed" });
      loadTasks();
    }).catch(() => setSaveMsg({ ok: false, text: "Failed to run task" }))
    .finally(() => setTaskRunning((prev: any) => ({ ...prev, [name]: false })));
  }

  function saveSonarr() {
    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "sonarr", value: sonarr }),
    }).then(() => {});
  }

  function testSonarr() {
    setSonarrTesting(true);
    setSonarrStatus(null);
    fetch("/api/sonarr/test").then(r => r.json()).then(res => {
      setSonarrStatus(res);
    }).catch(() => setSonarrStatus({ ok: false, message: "Connection failed" }))
    .finally(() => setSonarrTesting(false));
  }

  function fetchSonarrSeries() {
    setSonarrSeriesLoading(true);
    setSonarrSeries(null);
    setSelectedSonarrSeries(new Set());
    fetch("/api/sonarr/series").then(r => r.json()).then(res => {
      if (Array.isArray(res)) setSonarrSeries(res);
      else setSonarrSeries([]);
    }).catch(() => setSonarrSeries([]))
    .finally(() => setSonarrSeriesLoading(false));
  }

  function importSonarrSeries() {
    setSonarrImporting(true);
    setSonarrImportJobId(null);
    fetch("/api/sonarr/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seriesIds: [...selectedSonarrSeries], typeMapping: sonarrTypeConfig }),
    }).then(r => r.json()).then(data => {
      if (data.jobId) setSonarrImportJobId(data.jobId);
    }).catch(() => {})
    .finally(() => setSonarrImporting(false));
  }

  function testJellyfin() {
    setJellyfinTesting(true);
    setJellyfinStatus(null);
    fetch("/api/jellyfin/test").then(r => r.json()).then(res => {
      setJellyfinStatus(res);
    }).catch(() => setJellyfinStatus({ ok: false, message: "Connection failed" }))
    .finally(() => setJellyfinTesting(false));
  }

  function syncJellyfin() {
    setJellyfinSyncing(true);
    setJellyfinSyncResult(null);
    fetch("/api/jellyfin/sync", { method: "POST" }).then(r => r.json()).then(res => {
      setJellyfinSyncResult(res);
    }).catch(() => setJellyfinSyncResult({ totalEpisodes: 0, matchedEpisodes: 0, errors: ["Sync request failed"] }))
    .finally(() => setJellyfinSyncing(false));
  }

  function handleAccentChange(color: string) {
    setAccent(color);
    saveAccent(color);
    applyAccent(color);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  /* ----- helper: renders the tab body for a given id ----- */
  function renderTabContent(id: string) {
    switch (id) {
      case "general":
        return (
          <>
            <GeneralTab config={config} saveConfig={saveConfig} scrollToSection={scrollToSection} />
            {onReRunWizard && (
              <div className="p-5 rounded-2xl border border-white/10 bg-white/[0.02]">
                <p className="text-sm font-medium mb-1">Setup Wizard</p>
                <p className="text-xs text-muted-foreground mb-3">Re-run the onboarding wizard to reconfigure from scratch.</p>
                <button onClick={onReRunWizard} className="text-sm text-signal hover:underline">Re-run setup wizard</button>
              </div>
            )}
          </>
        );
      case "providers":
        return (
          <ProvidersTab config={config} updateApiKey={updateApiKey} showTmdbKey={showTmdbKey} setShowTmdbKey={setShowTmdbKey} showTvdbKey={showTvdbKey} setShowTvdbKey={setShowTvdbKey} showTvdbPin={showTvdbPin} setShowTvdbPin={setShowTvdbPin} saveImdb={saveImdb} />
        );
      case "indexers":
        return (
          <IndexersTab prowlarr={prowlarr} setProwlarr={setProwlarr} saveProwlarr={saveProwlarr} saveProwlarrWithDefaults={saveProwlarrWithDefaults} testProwlarr={testProwlarr} prowlarrTesting={prowlarrTesting} prowlarrStatus={prowlarrStatus} loadIndexers={loadIndexers} indexers={indexers} indexersLoading={indexersLoading} showProwlarrKey={showProwlarrKey} setShowProwlarrKey={setShowProwlarrKey} nativeIndexers={nativeIndexers} nativeMeta={nativeMeta} nativeSaving={nativeSaving} nativeTesting={nativeTesting} nativeStatuses={nativeStatuses} toggleNativeIndexer={toggleNativeIndexer} updateNativeBaseUrl={updateNativeBaseUrl} testNativeIndexer={testNativeIndexer} saving={saving} />
        );
      case "integrations":
        return (
          <IntegrationsTab sonarr={sonarr} setSonarr={setSonarr} showSonarrKey={showSonarrKey} setShowSonarrKey={setShowSonarrKey} sonarrTesting={sonarrTesting} sonarrStatus={sonarrStatus} sonarrTestingFn={testSonarr} sonarrSeries={sonarrSeries} sonarrSeriesLoading={sonarrSeriesLoading} sonarrFetchSeries={fetchSonarrSeries} sonarrImporting={sonarrImporting} sonarrImportJobId={sonarrImportJobId} onSonarrImportDone={() => setSonarrImportJobId(null)} selectedSonarrSeries={selectedSonarrSeries} setSelectedSonarrSeries={setSelectedSonarrSeries} showProfilesList={showProfilesList} qualityProfilesList={qualityProfilesList} libraryTypesList={libraryTypesList} sonarrTypeConfig={sonarrTypeConfig} setSonarrTypeConfig={setSonarrTypeConfig} sonarrTypesPresent={sonarrTypesPresent} visibleSonarrSeries={visibleSonarrSeries} sonarrImportFn={importSonarrSeries} jellyfin={jellyfin} setJellyfin={setJellyfin} showJellyfinKey={showJellyfinKey} setShowJellyfinKey={setShowJellyfinKey} jellyfinTesting={jellyfinTesting} jellyfinStatus={jellyfinStatus} jellyfinTestingFn={testJellyfin} jellyfinSyncing={jellyfinSyncing} jellyfinSyncResult={jellyfinSyncResult} jellyfinSyncFn={syncJellyfin} saveSonarr={saveSonarr} config={config} updateApiKey={updateApiKey} />
        );
      case "appearance":
        return theme ? <AppearanceTab theme={theme} accent={accent} updateTheme={updateTheme} setAccent={handleAccentChange} /> : null;
      case "quality":
        return <QualityProfilesTab />;
      case "naming":
        return <NamingTab config={config} saveConfig={saveConfig} />;
      case "downloads":
        return <DownloadsTab config={config} saveConfig={saveConfig} showTorboxKey={showTorboxKey} setShowTorboxKey={setShowTorboxKey} />;
      case "tasks":
        return <TasksPanel tasks={tasks} loading={tasksLoading} onRunTask={runTaskNow} onUpdateTask={updateTaskConfig} taskRunning={taskRunning} saving={saving} />;
      case "backup":
        return <BackupPanel />;
      case "analytics":
        return <AnalyticsPanel />;
      case "debug":
        return <DebugSettings />;
      default:
        return null;
    }
  }

  const activeMobileTab = SETTINGS_TABS.find(t => t.id === mobileSection);
  const ActiveMobileIcon = activeMobileTab?.icon;

  return (
    <div className="space-y-6">
      {/* Tabs + save status — both live in the global header, replacing the
          old standalone tab-strip panel so everything sits in one place. */}
      <HeaderActions>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {/* Mobile: show the active section label if a panel is open, otherwise nothing (the list below serves as nav). */}
          {mobileSection && (
            <div className="flex min-w-0 flex-1 items-center gap-1 sm:hidden">
              <span className="truncate font-mono text-xs font-semibold text-white">{activeMobileTab?.label ?? "Settings"}</span>
            </div>
          )}
          {/* Desktop: pill tabs. */}
          <div className="hidden min-w-0 flex-1 items-center gap-1.5 overflow-x-auto sm:flex">
            {SETTINGS_TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`shrink-0 rounded-full px-4 py-1.5 font-mono text-[11px] transition-all ${
                  tab === t.id
                    ? "bg-signal/15 text-signal shadow-[inset_0_0_0_0.5px_var(--signal)] font-semibold"
                    : "text-muted-foreground hover:text-foreground bg-white/[0.04] hover:bg-white/[0.07]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {(saveMsg || saving) && (
            <div className="flex shrink-0 items-center gap-2 pl-2">
              {saveMsg && (
                <span className={cn("flex shrink-0 items-center gap-1.5 text-xs",
                  saveMsg.ok ? "text-emerald-400" : "text-red-400"
                )}>
                  {saveMsg.ok ? <CheckIcon className="size-3.5" /> : <XIcon className="size-3.5" />}
                  {saveMsg.text}
                </span>
              )}
              {saving && <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />}
            </div>
          )}
        </div>
      </HeaderActions>

      {/* ── Mobile: tappable section list (visible when no section is open) ── */}
      <div className={cn("sm:hidden", mobileSection && "hidden")}>
        <div className="space-y-1">
          {SETTINGS_TABS.map(t => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => { setTab(t.id); setMobileSection(t.id); }}
                className="flex w-full items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3.5 text-left transition-colors hover:bg-white/[0.05] active:bg-white/[0.08]"
              >
                <Icon className="size-5 shrink-0 text-muted-foreground" />
                <span className="flex-1 font-sans text-sm font-medium text-white">{t.label}</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground/50" />
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Mobile: Sheet overlay (Approach A) ── */}
      {mobileSection && activeMobileTab?.mobileStyle === "sheet" && (
        <div className="fixed inset-0 z-50 sm:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/60 animate-[fadeIn_0.15s_ease-out]"
            onClick={() => setMobileSection(null)}
          />
          <div
            className="mobile-nav-safe absolute inset-x-0 bottom-0 flex flex-col rounded-t-2xl border-t border-white/10 bg-[#1c2028] shadow-2xl"
            style={{ maxHeight: "92vh", animation: "slideUp 0.25s ease-out" }}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-2 pb-1">
              <div className="h-1 w-8 rounded-full bg-white/20" />
            </div>
            {/* Header */}
            <div className="flex items-center justify-between px-4 pb-3">
              <div className="flex items-center gap-2">
                {ActiveMobileIcon && <ActiveMobileIcon className="size-4 text-signal" />}
                <span className="font-mono text-sm font-bold text-white">{activeMobileTab?.label}</span>
              </div>
              <button
                onClick={() => setMobileSection(null)}
                aria-label="Close"
                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-white/[0.05] hover:text-white"
              >
                <XIcon className="size-4" />
              </button>
            </div>
            {/* Content */}
            <div className="flex-1 overflow-y-auto px-4 pb-6">
              <div className="space-y-6">
                {renderTabContent(mobileSection)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Mobile: Drill-down overlay (Approach B) ── */}
      {mobileSection && activeMobileTab?.mobileStyle === "drill" && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-[#1c2028] sm:hidden"
          role="dialog"
          aria-modal="true"
          style={{ animation: "slideInRight 0.25s ease-out", paddingTop: "env(safe-area-inset-top, 0px)" }}
        >
          {/* Header */}
          <div className="flex h-14 items-center gap-3 border-b border-white/10 px-4">
            <button
              onClick={() => setMobileSection(null)}
              aria-label="Back"
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-white/[0.05] hover:text-white"
            >
              <ArrowLeft className="size-5" />
            </button>
            {ActiveMobileIcon && <ActiveMobileIcon className="size-4 text-signal" />}
            <span className="font-mono text-sm font-bold text-white">{activeMobileTab?.label}</span>
          </div>
          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4">
            <div className="space-y-6">
              {renderTabContent(mobileSection)}
            </div>
          </div>
        </div>
      )}

      {/* ── Desktop: inline content (unchanged) ── */}
      <div className="hidden sm:block">
        <div className="space-y-6">
          {renderTabContent(tab)}
        </div>
      </div>
    </div>
  );
}
