import * as React from "react";
import { CheckIcon, XIcon, Loader2Icon } from "lucide-react";

import { HeaderActions } from "@frontend/lib/header-actions";

import { loadAccent, saveAccent, applyAccent, loadTheme, saveTheme, applyTheme, type ThemeConfig } from "@frontend/lib/theme";
import { QualityProfilesTab } from "@frontend/components/showflow/QualityProfiles";

import { GeneralTab } from "./GeneralTab";
import { ProvidersTab } from "./ProvidersTab";
import { IndexersTab } from "./IndexersTab";
import { IntegrationsTab } from "./IntegrationsTab";
import { AppearanceTab } from "./AppearanceTab";
import { DownloadsTab } from "./DownloadsTab";
import { TasksPanel } from "./TasksPanel";
import { BackupPanel } from "./BackupPanel";
import { DebugSettings } from "./DebugSettings";
import { cn } from "./SettingsShared";

const SETTINGS_TABS = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "providers", label: "Providers" },
  { id: "indexers", label: "Indexers" },
  { id: "integrations", label: "Integrations" },
  { id: "quality", label: "Quality" },
  { id: "downloads", label: "Downloads" },
  { id: "tasks", label: "Tasks" },
  { id: "backup", label: "Backup" },
  { id: "debug", label: "Debug" },
];

export function SettingsPage({ onDone: _onDone, initialTab }: { onDone: () => void; initialTab?: string }) {
  const [tab, setTab] = React.useState(initialTab || "general");
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
  const [sonarrImportResults, setSonarrImportResults] = React.useState<any[]>([]);
  const [sonarrImportTotal, setSonarrImportTotal] = React.useState(0);
  const [selectedSonarrSeries, setSelectedSonarrSeries] = React.useState<Set<number>>(new Set());

  const [showProfilesList, setShowProfilesList] = React.useState<any[]>([]);
  const [qualityProfilesList, setQualityProfilesList] = React.useState<any[]>([]);
  const [sonarrTypeConfig, setSonarrTypeConfig] = React.useState<Record<string, { included: boolean; showProfileId: string; qualityProfileId: string }>>({});

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
    Promise.all([
      fetch("/api/config").then(r => r.json()),
      fetch("/api/settings").then(r => r.json()),
      fetch("/api/indexers/native/meta").then(r => r.json()),
      fetch("/api/tasks").then(r => r.json()),
      fetch("/api/show-profiles").then(r => r.json()).catch(() => []),
      fetch("/api/profiles").then(r => r.json()).catch(() => []),
      loadTheme(),
    ]).then(([cfg, settings, nativeMetaData, tasksData, showProfilesData, qualityProfilesData, loadedTheme]) => {
      setConfig(cfg);
      setTheme(loadedTheme);
      setNativeMeta(Array.isArray(nativeMetaData) ? nativeMetaData : []);
      setTasks(Array.isArray(tasksData) ? tasksData : []);
      setShowProfilesList(Array.isArray(showProfilesData) ? showProfilesData : []);
      setQualityProfilesList(Array.isArray(qualityProfilesData) ? qualityProfilesData : []);
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
    setSonarrImportResults([]);
    fetch("/api/sonarr/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seriesIds: [...selectedSonarrSeries], typeMapping: sonarrTypeConfig }),
    }).then(r => r.json()).then(data => {
      setSonarrImportResults(data.results || []);
      if (data.results) {
        setSonarrImportTotal(data.results.length);
      }
    }).catch(() => setSonarrImportResults([{ status: 'error', title: 'Import request failed' }]))
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

  return (
    <div className="space-y-6">
      {/* Tabs + save status — both live in the global header, replacing the
          old standalone tab-strip panel so everything sits in one place. */}
      <HeaderActions>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
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

      {/* Content */}
      <div className="space-y-6">
        {tab === "general" && (
          <GeneralTab
            config={config}
            saveConfig={saveConfig}
            accent={accent}
            setAccent={handleAccentChange}
          />
        )}

        {tab === "providers" && (
          <ProvidersTab
            config={config}
            updateApiKey={updateApiKey}
            showTmdbKey={showTmdbKey}
            setShowTmdbKey={setShowTmdbKey}
            showTvdbKey={showTvdbKey}
            setShowTvdbKey={setShowTvdbKey}
            showTvdbPin={showTvdbPin}
            setShowTvdbPin={setShowTvdbPin}
          />
        )}

        {tab === "indexers" && (
          <IndexersTab
            prowlarr={prowlarr}
            setProwlarr={setProwlarr}
            saveProwlarr={saveProwlarr}
            saveProwlarrWithDefaults={saveProwlarrWithDefaults}
            testProwlarr={testProwlarr}
            prowlarrTesting={prowlarrTesting}
            prowlarrStatus={prowlarrStatus}
            loadIndexers={loadIndexers}
            indexers={indexers}
            indexersLoading={indexersLoading}
            showProwlarrKey={showProwlarrKey}
            setShowProwlarrKey={setShowProwlarrKey}
            nativeIndexers={nativeIndexers}
            nativeMeta={nativeMeta}
            nativeSaving={nativeSaving}
            nativeTesting={nativeTesting}
            nativeStatuses={nativeStatuses}
            toggleNativeIndexer={toggleNativeIndexer}
            updateNativeBaseUrl={updateNativeBaseUrl}
            testNativeIndexer={testNativeIndexer}
            saving={saving}
          />
        )}

        {tab === "integrations" && (
          <IntegrationsTab
            sonarr={sonarr}
            setSonarr={setSonarr}
            showSonarrKey={showSonarrKey}
            setShowSonarrKey={setShowSonarrKey}
            sonarrTesting={sonarrTesting}
            sonarrStatus={sonarrStatus}
            sonarrTestingFn={testSonarr}
            sonarrSeries={sonarrSeries}
            sonarrSeriesLoading={sonarrSeriesLoading}
            sonarrFetchSeries={fetchSonarrSeries}
            sonarrImporting={sonarrImporting}
            sonarrImportResults={sonarrImportResults}
            sonarrImportTotal={sonarrImportTotal}
            selectedSonarrSeries={selectedSonarrSeries}
            setSelectedSonarrSeries={setSelectedSonarrSeries}
            showProfilesList={showProfilesList}
            qualityProfilesList={qualityProfilesList}
            sonarrTypeConfig={sonarrTypeConfig}
            setSonarrTypeConfig={setSonarrTypeConfig}
            sonarrTypesPresent={sonarrTypesPresent}
            visibleSonarrSeries={visibleSonarrSeries}
            sonarrImportFn={importSonarrSeries}
            jellyfin={jellyfin}
            setJellyfin={setJellyfin}
            showJellyfinKey={showJellyfinKey}
            setShowJellyfinKey={setShowJellyfinKey}
            jellyfinTesting={jellyfinTesting}
            jellyfinStatus={jellyfinStatus}
            jellyfinTestingFn={testJellyfin}
            jellyfinSyncing={jellyfinSyncing}
            jellyfinSyncResult={jellyfinSyncResult}
            jellyfinSyncFn={syncJellyfin}
            saveSonarr={saveSonarr}
          />
        )}

        {tab === "appearance" && theme && (
          <AppearanceTab
            theme={theme}
            accent={accent}
            updateTheme={updateTheme}
            setAccent={handleAccentChange}
          />
        )}

        {tab === "quality" && <QualityProfilesTab />}

        {tab === "downloads" && (
          <DownloadsTab
            config={config}
            saveConfig={saveConfig}
            showTorboxKey={showTorboxKey}
            setShowTorboxKey={setShowTorboxKey}
          />
        )}

        {tab === "tasks" && (
          <TasksPanel
            tasks={tasks}
            loading={tasksLoading}
            onRunTask={runTaskNow}
            onUpdateTask={updateTaskConfig}
            taskRunning={taskRunning}
            saving={saving}
          />
        )}

        {tab === "backup" && <BackupPanel />}
        {tab === "debug" && <DebugSettings />}
      </div>
    </div>
  );
}
