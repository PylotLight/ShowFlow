import { createPortal } from "react-dom";
import { BugIcon, CheckIcon, ChevronRightIcon, DownloadIcon, EyeIcon, EyeOffIcon, FolderOpenIcon, Loader2Icon, PlusIcon, RefreshCwIcon, Trash2Icon, XIcon, ExternalLinkIcon, ClockIcon, PlayIcon, CalendarIcon } from "lucide-react";
import * as React from "react";

import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Button } from "@frontend/components/ui/button";
import { Input } from "@frontend/components/ui/input";
import { Label } from "@frontend/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { Switch } from "@frontend/components/ui/switch";

import { THEME_PRESETS, loadAccent, saveAccent, applyAccent, loadTheme, saveTheme, applyTheme, type ThemeConfig } from "@frontend/lib/theme";
import { QualityProfilesTab } from "@frontend/components/showflow/QualityProfiles";
import { DebugPage } from "@frontend/components/showflow/DebugPage";

const SETTINGS_TABS = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "providers", label: "Providers" },
  { id: "indexers", label: "Indexers" },
  { id: "sonarr", label: "Sonarr" },
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
      loadTheme(),
    ]).then(([cfg, settings, nativeMetaData, tasksData, loadedTheme]) => {
      setConfig(cfg);
      setTheme(loadedTheme);
      setNativeMeta(Array.isArray(nativeMetaData) ? nativeMetaData : []);
      setTasks(Array.isArray(tasksData) ? tasksData : []);
      const sonarrRaw = settings.find((s: any) => s.key === "sonarr");
      if (sonarrRaw) {
        try {
          const s = JSON.parse(sonarrRaw.value);
          setSonarr({ enabled: !!s.enabled, baseUrl: s.baseUrl || "", apiKey: s.apiKey || "", apiVersion: s.apiVersion === "v5" ? "v5" : "v3" });
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

  function updateTheme(updates: Partial<ThemeConfig>) {
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
    const next = nativeIndexers.map(n => n.id === id ? { ...n, enabled } : n);
    if (!next.find(n => n.id === id)) {
      next.push({ id, enabled, baseUrl: undefined });
    }
    saveNativeIndexers(next);
  }

  function updateNativeBaseUrl(id: string, baseUrl: string) {
    const next = nativeIndexers.map(n => n.id === id ? { ...n, baseUrl: baseUrl || undefined } : n);
    if (!next.find(n => n.id === id)) {
      next.push({ id, enabled: false, baseUrl: baseUrl || undefined });
    }
    saveNativeIndexers(next);
  }

  function testNativeIndexer(id: string) {
    setNativeTesting(prev => ({ ...prev, [id]: true }));
    setNativeStatuses(prev => ({ ...prev, [id]: undefined as any }));
    fetch(`/api/indexers/native/test/${id}`).then(r => r.json()).then(res => {
      setNativeStatuses(prev => ({ ...prev, [id]: res }));
    }).catch(() => setNativeStatuses(prev => ({ ...prev, [id]: { ok: false, message: "Connection failed" } })))
    .finally(() => setNativeTesting(prev => ({ ...prev, [id]: false })));
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
    setTaskRunning(prev => ({ ...prev, [name]: true }));
    setSaveMsg(null);
    fetch(`/api/tasks/${name}`, {
      method: "POST",
    }).then(r => r.json()).then(res => {
      setSaveMsg({ ok: res.success, text: res.message || "Task completed" });
      loadTasks();
    }).catch(() => setSaveMsg({ ok: false, text: "Failed to run task" }))
    .finally(() => setTaskRunning(prev => ({ ...prev, [name]: false })));
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
      {/* Header + Tabs */}
      <GlassPanel className="overflow-hidden">
        <div className="px-6 py-4 border-b border-white/5">
          <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-signal">
            // Settings
          </span>
          <div className="flex items-center justify-between mt-0.5">
            <h2 className="font-display text-2xl font-bold text-white">Configuration</h2>
            <div className="flex items-center gap-3">
              {saveMsg && (
                <span className={cn("flex items-center gap-1.5 text-xs",
                  saveMsg.ok ? "text-emerald-400" : "text-red-400"
                )}>
                  {saveMsg.ok ? <CheckIcon className="size-3.5" /> : <XIcon className="size-3.5" />}
                  {saveMsg.text}
                </span>
              )}
              {saving && <Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 px-6 py-3 overflow-x-auto">
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
      </GlassPanel>

      {/* Content */}
      <div className="space-y-6">
        {tab === "general" && (
          <>
            <GlassPanel className="p-6 space-y-5">
              <div>
                <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Accent Theme</h3>
                <p className="text-muted-foreground text-xs mt-0.5">Choose the accent color used throughout the interface</p>
              </div>
              <ColorDock current={accent} onChange={(color) => { setAccent(color); saveAccent(color); applyAccent(color); }} />
            </GlassPanel>

            <GlassPanel className="p-6 space-y-5">
              <div>
                <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Profiles &amp; Root Folders</h3>
                <p className="text-muted-foreground text-xs mt-0.5">Each profile maps to a root folder. Shows assigned to a profile are organized under its root folder.</p>
              </div>
              <ShowProfileManager />
            </GlassPanel>

            <GlassPanel className="p-6 space-y-5">
              <div>
                <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Defaults</h3>
                <p className="text-muted-foreground text-xs mt-0.5">Default behavior for new shows and file handling</p>
              </div>
              <FieldRow label="Default Provider" description="Metadata provider used when adding shows">
                <Select
                  value={config.defaultProvider || "tmdb"}
                  onValueChange={v => saveConfig({ defaultProvider: v })}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tmdb">TMDB</SelectItem>
                    <SelectItem value="tvdb">TVDB</SelectItem>
                    <SelectItem value="anilist">AniList</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="On Collision" description="What to do when a file already exists at the destination">
                <Select
                  value={config.onCollision || "skip"}
                  onValueChange={v => saveConfig({ onCollision: v })}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skip">Skip</SelectItem>
                    <SelectItem value="overwrite">Overwrite</SelectItem>
                    <SelectItem value="version">Version</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Dry Run" description="Log actions without actually moving files">
                <Switch
                  checked={!!config.dryRun}
                  onCheckedChange={v => saveConfig({ dryRun: v })}
                />
              </FieldRow>
            </GlassPanel>
          </>
        )}

        {tab === "providers" && (
          <GlassPanel className="p-6 space-y-5">
            <div>
              <h3 className="font-display text-base font-semibold tracking-wide text-white/90">API Keys</h3>
              <p className="text-muted-foreground text-xs mt-0.5">Credentials for metadata providers. These replace values in your .env file.</p>
            </div>
            <FieldRow label="TMDB API Key" description="themoviedb.org API key for show metadata">
              <div className="relative">
                <Input
                  type={showTmdbKey ? "text" : "password"}
                  value={config.apiKeys?.tmdb || ""}
                  onChange={e => updateApiKey("tmdb", e.target.value)}
                  placeholder="TMDB_API_KEY"
                />
                <button
                  type="button"
                  onClick={() => setShowTmdbKey(!showTmdbKey)}
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                >
                  {showTmdbKey ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
                </button>
              </div>
            </FieldRow>
            <FieldRow label="TVDB API Key" description="thetvdb.com API key for show metadata">
              <div className="relative">
                <Input
                  type={showTvdbKey ? "text" : "password"}
                  value={config.apiKeys?.tvdb || ""}
                  onChange={e => updateApiKey("tvdb", e.target.value)}
                  placeholder="TVDB_API_KEY"
                />
                <button
                  type="button"
                  onClick={() => setShowTvdbKey(!showTvdbKey)}
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                >
                  {showTvdbKey ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
                </button>
              </div>
            </FieldRow>
            <FieldRow label="TVDB PIN" description="PIN for TVDB v4 API authentication (optional)">
              <div className="relative">
                <Input
                  type={showTvdbPin ? "text" : "password"}
                  value={config.apiKeys?.tvdb_pin || ""}
                  onChange={e => updateApiKey("tvdb_pin", e.target.value)}
                  placeholder="TVDB_PIN"
                />
                <button
                  type="button"
                  onClick={() => setShowTvdbPin(!showTvdbPin)}
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                >
                  {showTvdbPin ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
                </button>
              </div>
            </FieldRow>
          </GlassPanel>
        )}

        {tab === "indexers" && (
          <>
            <GlassPanel className="p-6 space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Prowlarr Connection</h3>
                  <p className="text-muted-foreground text-xs mt-0.5">Connect to Prowlarr to search torrent/usenet indexers</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {prowlarr.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <Switch
                    checked={prowlarr.enabled}
                    onCheckedChange={v => {
                      setProwlarr(prev => {
                        const next = { ...prev, enabled: v };
                        saveProwlarrWithDefaults(next);
                        return next;
                      });
                    }}
                  />
                </div>
              </div>
              {prowlarr.enabled && (
              <><FieldRow label="Prowlarr URL" description="e.g. http://localhost:9696">
                <Input
                  value={prowlarr.baseUrl}
                  onChange={e => setProwlarr(prev => ({ ...prev, baseUrl: e.target.value }))}
                  placeholder="http://localhost:9696"
                />
              </FieldRow>
              <FieldRow label="API Key" description="Found in Prowlarr Settings > General">
                <div className="relative">
                  <Input
                    type={showProwlarrKey ? "text" : "password"}
                    value={prowlarr.apiKey}
                    onChange={e => setProwlarr(prev => ({ ...prev, apiKey: e.target.value }))}
                    placeholder="Prowlarr API key"
                  />
                  <button
                    type="button"
                    onClick={() => setShowProwlarrKey(!showProwlarrKey)}
                    className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                  >
                    {showProwlarrKey ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
                  </button>
                </div>
              </FieldRow>
              <FieldRow label="Sync Level" description="How indexers are synced from Prowlarr">
                <Select
                  value={prowlarr.syncLevel}
                  onValueChange={v => setProwlarr(prev => ({ ...prev, syncLevel: v }))}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="full">Full Sync</SelectItem>
                    <SelectItem value="addRemoveOnly">Add & Remove Only</SelectItem>
                    <SelectItem value="disabled">Disabled</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" onClick={saveProwlarr} disabled={saving === "prowlarr"}>
                  {saving === "prowlarr" ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : null}
                  Save Prowlarr Settings
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={testProwlarr}
                  disabled={prowlarrTesting || !prowlarr.baseUrl}
                >
                  {prowlarrTesting ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : null}
                  Test Connection
                </Button>
              </div>
              {prowlarrStatus && (
                <div className={cn(
                  "flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs",
                  prowlarrStatus.ok ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400",
                )}>
                  {prowlarrStatus.ok ? <CheckIcon className="size-3.5 shrink-0" /> : <XIcon className="size-3.5 shrink-0" />}
                  {prowlarrStatus.message || (prowlarrStatus.ok ? "Connected" : "Failed")}
                </div>
              )}
              {!prowlarr.enabled && (
                <p className="text-muted-foreground text-sm py-2">Prowlarr is disabled. Enable it above to configure.</p>
              )}
              </>)}
              {prowlarr.enabled && (
              <div className="border-t border-white/5 pt-4 mt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    Configured Indexers
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={loadIndexers}
                    disabled={indexersLoading}
                  >
                    {indexersLoading ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : null}
                    Refresh
                  </Button>
                </div>
                {indexers === null ? (
                  <p className="text-muted-foreground text-sm">Click "Refresh" to load indexers.</p>
                ) : indexers.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No indexers found in Prowlarr.</p>
                ) : (
                  <div className="space-y-1.5">
                    {indexers.map(ix => (
                      <div key={ix.id} className="flex items-center gap-3 rounded-lg px-4 py-3 bg-white/[0.03]">
                        <div className={cn("size-2 shrink-0 rounded-full", ix.enabled ? "bg-emerald-400" : "bg-muted-foreground/40")} />
                        <span className="font-mono flex-1 text-sm tracking-wide">{ix.name}</span>
                        <span className="text-muted-foreground text-caption font-mono uppercase tracking-wider">{ix.protocol}</span>
                        <span className="text-muted-foreground text-caption font-mono uppercase tracking-wider">{ix.privacy}</span>
                        <span className="text-muted-foreground font-mono text-caption">#{ix.id}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              )}
            </GlassPanel>

              <GlassPanel className="p-6 space-y-4">
                <div>
                  <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Native Indexers</h3>
                  <p className="text-muted-foreground text-xs mt-0.5">Built-in trackers — no Prowlarr required</p>
                </div>
                <div className="space-y-2">
                  {nativeMeta.map(meta => {
                    const cfg = nativeIndexers.find(n => n.id === meta.id);
                    const enabled = cfg?.enabled ?? false;
                    const baseUrl = cfg?.baseUrl ?? meta.defaultUrl;
                    const testing = nativeTesting[meta.id];
                    const status = nativeStatuses[meta.id];
                    return (
                      <div key={meta.id} className="rounded-lg px-4 py-3 bg-white/[0.03] space-y-2">
                        <div className="flex items-center gap-3">
                          <Switch
                            checked={enabled}
                            onCheckedChange={v => toggleNativeIndexer(meta.id, v)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-sm font-medium text-white/90">{meta.name}</span>
                              <span className="text-muted-foreground text-caption font-mono uppercase tracking-wider">{meta.protocol}</span>
                              <span className="text-muted-foreground text-caption font-mono uppercase tracking-wider">{meta.privacy}</span>
                            </div>
                            <p className="text-muted-foreground text-xs mt-px">{meta.description}</p>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => window.open(meta.defaultUrl, '_blank')}
                            title={`Open ${meta.name}`}
                          >
                            <ExternalLinkIcon className="size-3.5" />
                          </Button>
                        </div>
                        {enabled && (
                          <div className="flex items-center gap-2 pl-11">
                            <Input
                              value={baseUrl}
                              onChange={e => updateNativeBaseUrl(meta.id, e.target.value)}
                              placeholder={meta.defaultUrl}
                              className="flex-1 font-mono text-xs"
                            />
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => testNativeIndexer(meta.id)}
                              disabled={testing}
                            >
                              {testing ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                              Test
                            </Button>
                          </div>
                        )}
                        {status && (
                          <div className={cn(
                            "flex items-center gap-2 rounded-lg px-4 py-2 text-xs ml-11",
                            status.ok ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400",
                          )}>
                            {status.ok ? <CheckIcon className="size-3.5 shrink-0" /> : <XIcon className="size-3.5 shrink-0" />}
                            {status.message || (status.ok ? "Connected" : "Failed")}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {nativeSaving && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2Icon className="size-3.5 animate-spin" />
                    Saving...
                  </div>
                )}
              </GlassPanel>
            </>
          )}

        {tab === "sonarr" && (
          <>
            <GlassPanel className="p-6 space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Sonarr Connection</h3>
                  <p className="text-muted-foreground text-xs mt-0.5">Connect to Sonarr to import existing series and tracking data</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {sonarr.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <Switch
                    checked={sonarr.enabled}
                    onCheckedChange={v => setSonarr(prev => ({ ...prev, enabled: v }))}
                  />
                </div>
              </div>
              {sonarr.enabled && (
              <>
                <FieldRow label="Sonarr URL" description="e.g. http://localhost:8989">
                  <Input
                    value={sonarr.baseUrl}
                    onChange={e => setSonarr(prev => ({ ...prev, baseUrl: e.target.value }))}
                    placeholder="http://localhost:8989"
                  />
                </FieldRow>
                <FieldRow label="API Key" description="Found in Sonarr Settings > General">
                  <div className="relative">
                    <Input
                      type={showSonarrKey ? "text" : "password"}
                      value={sonarr.apiKey}
                      onChange={e => setSonarr(prev => ({ ...prev, apiKey: e.target.value }))}
                      placeholder="Sonarr API key"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSonarrKey(!showSonarrKey)}
                      className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                    >
                      {showSonarrKey ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
                    </button>
                  </div>
                </FieldRow>
                <FieldRow label="API Version" description="Sonarr v3/v4 use v3, v5 uses v5">
                  <Select
                    value={sonarr.apiVersion}
                    onValueChange={v => setSonarr(prev => ({ ...prev, apiVersion: v as "v3" | "v5" }))}
                  >
                    <SelectTrigger className="w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="v3">v3</SelectItem>
                      <SelectItem value="v5">v5</SelectItem>
                    </SelectContent>
                  </Select>
                </FieldRow>
                <div className="flex items-center gap-2 pt-1">
                  <Button size="sm" onClick={() => {
                    setSaving("sonarr");
                    setSaveMsg(null);
                    fetch("/api/settings", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ key: "sonarr", value: sonarr }),
                    }).then(r => {
                      setSaveMsg(r.ok ? { ok: true, text: "Saved" } : { ok: false, text: "Failed to save" });
                    }).catch(() => setSaveMsg({ ok: false, text: "Network error" }))
                    .finally(() => setSaving(null));
                  }} disabled={saving === "sonarr"}>
                    {saving === "sonarr" ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : null}
                    Save Sonarr Settings
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSonarrTesting(true);
                      setSonarrStatus(null);
                      fetch("/api/sonarr/test").then(r => r.json()).then(res => {
                        setSonarrStatus(res);
                      }).catch(() => setSonarrStatus({ ok: false, message: "Connection failed" }))
                      .finally(() => setSonarrTesting(false));
                    }}
                    disabled={sonarrTesting || !sonarr.baseUrl}
                  >
                    {sonarrTesting ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : null}
                    Test Connection
                  </Button>
                </div>
                {sonarrStatus && (
                  <div className={cn(
                    "flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs",
                    sonarrStatus.ok ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400",
                  )}>
                    {sonarrStatus.ok ? <CheckIcon className="size-3.5 shrink-0" /> : <XIcon className="size-3.5 shrink-0" />}
                    {sonarrStatus.message || (sonarrStatus.ok ? `Connected v${sonarrStatus.version}` : "Failed")}
                  </div>
                )}
              </>
              )}
            </GlassPanel>

            {sonarr.enabled && sonarr.baseUrl && sonarr.apiKey && (
              <>
              <GlassPanel className="p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Import Series</h3>
                    <p className="text-muted-foreground text-xs mt-0.5">Select series from Sonarr to import into ShowFlow</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSonarrSeriesLoading(true);
                        setSonarrSeries(null);
                        setSonarrImportResults([]);
                        setSonarrImportTotal(0);
                        setSelectedSonarrSeries(new Set());
                        fetch("/api/sonarr/series").then(r => r.json()).then(res => {
                          setSonarrSeries(Array.isArray(res) ? res : []);
                        }).catch(() => setSonarrSeries([]))
                        .finally(() => setSonarrSeriesLoading(false));
                      }}
                      disabled={sonarrSeriesLoading}
                    >
                      {sonarrSeriesLoading ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : null}
                      Fetch Series
                    </Button>
                    {sonarrSeries && sonarrSeries.length > 0 && sonarrImportResults.length === 0 && (
                      <Button
                        size="sm"
                        onClick={async () => {
                          const ids = [...selectedSonarrSeries];
                          const toImport = ids.length > 0
                            ? sonarrSeries.filter((s: any) => ids.includes(s.id))
                            : sonarrSeries;
                          setSonarrImporting(true);
                          setSonarrImportResults([]);
                          setSonarrImportTotal(toImport.length);

                          for (const s of toImport) {
                            try {
                              const res = await fetch("/api/sonarr/import", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ seriesIds: [s.id] }),
                              });
                              const data = await res.json();
                              const result = data.results?.[0] || { title: s.title, status: 'error', message: 'No result' };
                              setSonarrImportResults(prev => [...prev, result]);
                            } catch {
                              setSonarrImportResults(prev => [...prev, { title: s.title, status: 'error' as const, message: 'Import request failed' }]);
                            }
                            await new Promise(r => setTimeout(r, 150));
                          }

                          setSonarrImporting(false);
                          setSonarrSeries(null);
                          setSelectedSonarrSeries(new Set());
                        }}
                        disabled={sonarrImporting}
                      >
                        {sonarrImporting ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : null}
                        Import {selectedSonarrSeries.size > 0 ? `(${selectedSonarrSeries.size})` : `All ${sonarrSeries.length}`}
                      </Button>
                    )}
                  </div>
                </div>

                {sonarrImportResults.length > 0 || sonarrImporting ? (
                  <div className="rounded-lg border border-white/10 overflow-hidden">
                    <div className="h-1 bg-white/5">
                      <div
                        className="h-full bg-signal transition-all duration-300"
                        style={{ width: `${sonarrImportTotal > 0 ? (sonarrImportResults.length / sonarrImportTotal) * 100 : 0}%` }}
                      />
                    </div>
                    <div className="flex flex-col divide-y divide-white/5 max-h-80 overflow-y-auto">
                      {sonarrImportResults.map((r: any, i: number) => (
                        <div key={i} className="flex items-center gap-3 p-3">
                          {r.status === "imported" || r.status === "existing" ? (
                            <CheckIcon className="size-4 text-emerald-500 shrink-0" />
                          ) : r.status === "error" ? (
                            <XIcon className="size-4 text-red-400 shrink-0" />
                          ) : (
                            <Loader2Icon className="size-4 text-muted-foreground animate-spin shrink-0" />
                          )}
                          <span className="text-sm font-mono truncate flex-1">{r.title}</span>
                          {r.status === "error" && r.message && (
                            <span className="text-[10px] text-red-400 font-mono truncate max-w-[160px] shrink-0">{r.message}</span>
                          )}
                          {r.status === "existing" && (
                            <span className="text-[10px] text-blue-400 font-mono shrink-0">Already in library</span>
                          )}
                          {r.status === "imported" && r.message && (
                            <span className="text-[10px] text-emerald-400 font-mono shrink-0">{r.message}</span>
                          )}
                        </div>
                      ))}
                      {sonarrImporting && (
                        <div className="flex items-center gap-3 p-3">
                          <Loader2Icon className="size-4 text-muted-foreground animate-spin shrink-0" />
                          <span className="text-sm font-mono text-muted-foreground">Processing next series...</span>
                        </div>
                      )}
                    </div>
                    {!sonarrImporting && sonarrImportResults.length > 0 && (
                      <div className="border-t border-white/5 px-3 py-2 text-xs font-mono text-muted-foreground">
                        {sonarrImportResults.filter((r: any) => r.status === "imported" || r.status === "existing").length} of {sonarrImportResults.length} imported
                      </div>
                    )}
                  </div>
                ) : sonarrSeries === null && !sonarrSeriesLoading ? (
                  <p className="text-muted-foreground text-sm">Click "Fetch Series" to load series from Sonarr.</p>
                ) : sonarrSeriesLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : sonarrSeries && sonarrSeries.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No series found in Sonarr.</p>
                ) : sonarrSeries && sonarrSeries.length > 0 && (
                  <div className="max-h-96 overflow-y-auto space-y-1.5">
                    {sonarrSeries.map((s: any) => {
                      const selected = selectedSonarrSeries.has(s.id);
                      return (
                        <div
                          key={s.id}
                          className={cn(
                            "flex items-center gap-3 rounded-lg px-4 py-3 cursor-pointer transition-colors",
                            selected ? "bg-signal/10 ring-1 ring-signal/30" : "bg-white/[0.03] hover:bg-white/[0.06]",
                          )}
                          onClick={() => {
                            setSelectedSonarrSeries(prev => {
                              const next = new Set(prev);
                              if (next.has(s.id)) next.delete(s.id);
                              else next.add(s.id);
                              return next;
                            });
                          }}
                        >
                          <div className={cn(
                            "size-4 shrink-0 rounded border-2 transition-colors flex items-center justify-center",
                            selected ? "border-signal bg-signal" : "border-white/20",
                          )}>
                            {selected && <CheckIcon className="size-3 text-white" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="font-mono text-sm truncate">{s.title}</div>
                            <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
                              {s.year > 0 && <span>{s.year}</span>}
                              <span className={cn(
                                "uppercase tracking-wider font-mono",
                                s.status === "continuing" ? "text-emerald-400" : s.status === "ended" ? "text-amber-400" : "text-muted-foreground",
                              )}>{s.status}</span>
                              {s.network && <span>{s.network}</span>}
                              {s.seasons && <span>{s.seasons.length} seasons</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="font-mono text-[10px] text-muted-foreground">TVDB: {s.tvdbId}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </GlassPanel>
              </>
            )}
          </>
        )}

        {tab === "appearance" && theme && (
          <>
            <GlassPanel className="p-6 space-y-5">
              <div>
                <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Colors</h3>
                <p className="text-muted-foreground text-xs mt-0.5">Accent colors used throughout the interface</p>
              </div>
              <FieldRow label="Signal / Accent" description="Primary accent color for highlights and active states">
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={theme.signal}
                    onChange={e => updateTheme({ signal: e.target.value })}
                    className="size-8 rounded cursor-pointer bg-transparent border border-white/10"
                  />
                  <span className="font-mono text-xs text-muted-foreground">{theme.signal}</span>
                </div>
              </FieldRow>
              <FieldRow label="Warn / Amber" description="Warning and pending state color">
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={theme.accentAmber}
                    onChange={e => updateTheme({ accentAmber: e.target.value })}
                    className="size-8 rounded cursor-pointer bg-transparent border border-white/10"
                  />
                  <span className="font-mono text-xs text-muted-foreground">{theme.accentAmber}</span>
                </div>
              </FieldRow>
              <div className="border-t border-white/5 pt-4">
                <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Presets</span>
                <ColorDock current={accent} onChange={(color) => { setAccent(color); saveAccent(color); applyAccent(color); }} />
              </div>
            </GlassPanel>

            <GlassPanel className="p-6 space-y-5">
              <div>
                <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Typography</h3>
                <p className="text-muted-foreground text-xs mt-0.5">Font families and base sizes for the interface</p>
              </div>
              <FieldRow label="Display Font" description="Headings and display text (e.g. 'Barlow Condensed')">
                <Input
                  value={theme.fontDisplay}
                  onChange={e => updateTheme({ fontDisplay: e.target.value })}
                  placeholder='"Barlow Condensed", sans-serif'
                />
              </FieldRow>
              <FieldRow label="Mono Font" description="Code, episode chips, stats (e.g. 'JetBrains Mono')">
                <Input
                  value={theme.fontMono}
                  onChange={e => updateTheme({ fontMono: e.target.value })}
                  placeholder='"JetBrains Mono", monospace'
                />
              </FieldRow>
              <FieldRow label="Sans Font" description="Body text (e.g. 'Inter')">
                <Input
                  value={theme.fontSans}
                  onChange={e => updateTheme({ fontSans: e.target.value })}
                  placeholder='"Inter", sans-serif'
                />
              </FieldRow>
            </GlassPanel>

            <GlassPanel className="p-6 space-y-5">
              <div>
                <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Sizes &amp; Spacing</h3>
                <p className="text-muted-foreground text-xs mt-0.5">Font size scale and corner rounding</p>
              </div>
              <FieldRow label="Caption Size" description="Smallest text (labels, timestamps)">
                <Input
                  value={theme.fontSizeCaption}
                  onChange={e => updateTheme({ fontSizeCaption: e.target.value })}
                  placeholder="0.75rem"
                  className="w-32 font-mono"
                />
              </FieldRow>
              <FieldRow label="Sub Size" description="Secondary text">
                <Input
                  value={theme.fontSizeSub}
                  onChange={e => updateTheme({ fontSizeSub: e.target.value })}
                  placeholder="0.8125rem"
                  className="w-32 font-mono"
                />
              </FieldRow>
              <FieldRow label="Small Size" description="Small body text">
                <Input
                  value={theme.fontSizeSm}
                  onChange={e => updateTheme({ fontSizeSm: e.target.value })}
                  placeholder="0.9375rem"
                  className="w-32 font-mono"
                />
              </FieldRow>
              <FieldRow label="Base Size" description="Standard body text">
                <Input
                  value={theme.fontSizeBase}
                  onChange={e => updateTheme({ fontSizeBase: e.target.value })}
                  placeholder="1rem"
                  className="w-32 font-mono"
                />
              </FieldRow>
              <FieldRow label="Border Radius" description="Corner rounding for panels and cards">
                <Input
                  value={theme.radius}
                  onChange={e => updateTheme({ radius: e.target.value })}
                  placeholder="0.625rem"
                  className="w-32 font-mono"
                />
              </FieldRow>
            </GlassPanel>
          </>
        )}

        {tab === "quality" && <QualityProfilesTab />}

        {tab === "downloads" && (
          <>
            <GlassPanel className="p-6 space-y-5">
              <div>
                <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Import Folder</h3>
                <p className="text-muted-foreground text-xs mt-0.5">
                  Every finished download lands here — from TorBox, from an external torrent client, or dropped in by
                  hand. ShowFlow watches it, resolves each file's show and episode, and moves it into your library.
                  This is the one folder that always matters, regardless of which download client you use below.
                </p>
              </div>
              <FieldRow label="Watch Folder" description="Directory ShowFlow watches for completed downloads to import">
                <FolderPicker
                  value={config.downloadClient?.blackhole?.watchFolder || ""}
                  onChange={v => saveConfig({
                    downloadClient: {
                      ...config.downloadClient,
                      blackhole: { ...(config.downloadClient?.blackhole || {}), watchFolder: v || null },
                    },
                  })}
                />
              </FieldRow>
              {!config.downloadClient?.blackhole?.watchFolder && (
                <p className="text-amber-400/80 text-xs">
                  Not set — the watcher can't start and grabbed releases will never get imported until this is configured.
                </p>
              )}
            </GlassPanel>

            <GlassPanel className="p-6 space-y-5">
              <div>
                <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Season Folder Format</h3>
                <p className="text-muted-foreground text-xs mt-0.5">
                  Controls how season folders are named in your library. Uses <code className="mx-1 rounded bg-white/[0.06] px-1 py-0.5 font-mono">{'{season}'}</code> as the season number placeholder.
                </p>
              </div>
              <FieldRow label="Format Template" description="e.g. Season {season} or Season {season:02}">
                <Input
                  value={config.seasonFolderFormat || "Season {season}"}
                  onChange={e => saveConfig({ seasonFolderFormat: e.target.value })}
                  placeholder="Season {season}"
                  className="w-64 font-mono text-xs"
                />
              </FieldRow>
              <p className="text-muted-foreground text-[10px]">
                Example: <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono">Season 1</code> (default), <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono">Season 01</code> (<code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono">{'season:02'}</code>), <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono">S{'{season}'}</code>, etc.
              </p>
            </GlassPanel>

            <GlassPanel className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-display text-base font-semibold tracking-wide text-white/90">TorBox</h3>
                  <p className="text-muted-foreground text-xs mt-0.5">
                    Cloud-based download client. Grabbed releases go straight to TorBox, which downloads them and
                    drops the finished file into your Import Folder above — automatically.
                  </p>
                </div>
                <Switch
                  checked={!!config.downloadClient?.torbox?.apiKey}
                  onCheckedChange={on => {
                    if (on) {
                      saveConfig({ downloadClient: { ...config.downloadClient, torbox: { apiKey: '' } } });
                    } else {
                      const { torbox, ...rest } = config.downloadClient || {};
                      saveConfig({ downloadClient: Object.keys(rest).length ? rest : undefined });
                    }
                  }}
                />
              </div>
              {config.downloadClient?.torbox?.apiKey !== undefined && (
                <>
                  <FieldRow label="API Key" description="TorBox API key for authentication">
                    <div className="relative">
                      <Input
                        type={showTorboxKey ? "text" : "password"}
                        value={config.downloadClient?.torbox?.apiKey || ""}
                        onChange={e => saveConfig({
                          downloadClient: {
                            ...config.downloadClient,
                            torbox: { ...(config.downloadClient?.torbox || {}), apiKey: e.target.value || null },
                          },
                        })}
                        placeholder="torbox_api_key"
                        className="pr-8 font-mono text-xs w-72"
                      />
                      <button
                        type="button"
                        onClick={() => setShowTorboxKey(!showTorboxKey)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70"
                      >
                        {showTorboxKey ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
                      </button>
                    </div>
                  </FieldRow>
                  <FieldRow label="Concurrency" description="Max concurrent downloads (default 3)">
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      value={config.downloadClient?.torbox?.concurrency ?? 3}
                      onChange={e => saveConfig({
                        downloadClient: {
                          ...config.downloadClient,
                          torbox: { ...(config.downloadClient?.torbox || {}), concurrency: parseInt(e.target.value) || 3 },
                        },
                      })}
                      className="w-20"
                    />
                  </FieldRow>

                  <details className="group pt-1">
                    <summary className="cursor-pointer select-none font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors">
                      Advanced
                    </summary>
                    <div className="mt-4 space-y-4 border-l border-white/10 pl-4">
                      <FieldRow label="Base URL" description="TorBox API base URL — only change this for a self-hosted/alternate endpoint">
                        <Input
                          value={config.downloadClient?.torbox?.baseUrl || ""}
                          onChange={e => saveConfig({
                            downloadClient: {
                              ...config.downloadClient,
                              torbox: { ...(config.downloadClient?.torbox || {}), baseUrl: e.target.value || null },
                            },
                          })}
                          placeholder="https://api.torbox.app"
                          className="w-72 font-mono text-xs"
                        />
                      </FieldRow>
                      <FieldRow label="Output Folder Override" description="Leave blank to use the Import Folder above (recommended). Only set this if TorBox downloads should land somewhere else.">
                        <FolderPicker
                          value={config.downloadClient?.torbox?.outputFolder || ""}
                          onChange={v => saveConfig({
                            downloadClient: {
                              ...config.downloadClient,
                              torbox: { ...(config.downloadClient?.torbox || {}), outputFolder: v || null },
                            },
                          })}
                        />
                      </FieldRow>
                      <FieldRow label="Manual Drop Folder" description="Optional: drop a .torrent/.magnet file here yourself and TorBox will pick it up. Not needed for normal grabs — those go directly to TorBox.">
                        <FolderPicker
                          value={config.downloadClient?.torbox?.inputFolder || ""}
                          onChange={v => saveConfig({
                            downloadClient: {
                              ...config.downloadClient,
                              torbox: { ...(config.downloadClient?.torbox || {}), inputFolder: v || null },
                            },
                          })}
                        />
                      </FieldRow>
                    </div>
                  </details>
                </>
              )}
            </GlassPanel>

            <GlassPanel className="p-6 space-y-4">
              <details className="group">
                <summary className="cursor-pointer select-none">
                  <h3 className="inline font-display text-base font-semibold tracking-wide text-white/90">External Download Client</h3>
                  <p className="text-muted-foreground text-xs mt-0.5">
                    For a separate torrent app (e.g. qBittorrent) or Prowlarr's own configured download client, instead of TorBox
                  </p>
                </summary>
                <div className="mt-4 space-y-4 border-l border-white/10 pl-4">
                  <p className="text-muted-foreground text-xs">
                    Native indexer grabs (and Prowlarr's, if you point its download client here) write a
                    <code className="mx-1 rounded bg-white/[0.06] px-1 py-0.5 font-mono">.torrent</code>/
                    <code className="mx-1 rounded bg-white/[0.06] px-1 py-0.5 font-mono">.magnet</code> file to this
                    folder. Whatever's watching it — TorBox's Manual Drop Folder above, or a real torrent client —
                    should ultimately save the finished video into your Import Folder.
                  </p>
                  <FieldRow label="Drop Folder" description="Directory where grabbed .torrent/.magnet files are placed">
                    <FolderPicker
                      value={config.downloadClient?.blackhole?.outputFolder || ""}
                      onChange={v => saveConfig({
                        downloadClient: {
                          ...config.downloadClient,
                          blackhole: { ...(config.downloadClient?.blackhole || {}), outputFolder: v || null },
                        },
                      })}
                    />
                  </FieldRow>
                </div>
              </details>
            </GlassPanel>
          </>
        )}
        {tab === "tasks" && <TasksPanel tasks={tasks} loading={tasksLoading} onRunTask={runTaskNow} onUpdateTask={updateTaskConfig} taskRunning={taskRunning} saving={saving} />}
        {tab === "backup" && <BackupPanel />}
        {tab === "debug" && <DebugSettings />}
      </div>
    </div>
  );
}

function BackupPanel() {
  const [backups, setBackups] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [confirmRestore, setConfirmRestore] = React.useState<string | null>(null);
  const [restoring, setRestoring] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  function load() {
    setLoading(true);
    fetch('/api/backup').then(r => r.json()).then(setBackups).finally(() => setLoading(false));
  }

  React.useEffect(() => { load(); }, []);

  function createBackup() {
    setCreating(true);
    fetch('/api/backup', { method: 'POST' }).then(r => r.json()).then(data => {
      if (data.entries) setBackups(data.entries);
    }).finally(() => setCreating(false));
  }

  function handleUpload(file: File) {
    setUploading(true);
    const form = new FormData();
    form.append('file', file);
    fetch('/api/backups/upload', { method: 'POST', body: form })
      .then(r => r.json()).then(() => load())
      .finally(() => setUploading(false));
  }

  function handleRestore() {
    if (!confirmRestore) return;
    setRestoring(true);
    fetch(`/api/backups/${confirmRestore}/restore`, { method: 'POST' })
      .then(r => r.json()).then(data => {
        if (data.ok) {
          window.location.reload();
        }
      }).finally(() => {
        setRestoring(false);
        setConfirmRestore(null);
      });
  }

  return (
    <>
      <GlassPanel className="p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Database Backups</h3>
            <p className="text-muted-foreground text-xs mt-0.5">Full snapshots of your database and settings — used for recovery or seeding fresh instances</p>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".db,.sql"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }}
            />
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? <Loader2Icon className="size-3.5 animate-spin" /> : <DownloadIcon className="size-3.5 rotate-180" />}
              Upload
            </Button>
            <Button size="sm" onClick={createBackup} disabled={creating}>
              {creating ? <Loader2Icon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
              Create Backup
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : backups.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">No backups yet. Create your first one above.</p>
        ) : (
          <div className="space-y-1.5">
            {backups.map(b => (
              <div key={b.name} className="flex items-center gap-3 rounded-lg px-4 py-3 bg-white/[0.03]">
                <div className="size-8 rounded-lg bg-signal/10 grid place-items-center shrink-0">
                  <span className="text-signal font-mono text-[10px] font-bold leading-none">DB</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm font-medium truncate">{b.name}</div>
                  <div className="text-muted-foreground mt-0.5 flex items-center gap-3 text-xs">
                    <span>{formatBytes(b.size)}</span>
                    <span>{new Date(b.date).toLocaleString()}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => setConfirmRestore(b.name)}
                    title="Restore from this backup"
                    className="text-amber-500/60 hover:text-amber-400"
                  >
                    <RefreshCwIcon className="size-3.5" />
                  </Button>
                  <a
                    href={`/api/backups/${b.name}`}
                    download
                    className="text-muted-foreground hover:text-foreground transition-colors p-1.5"
                    title="Download .db"
                  >
                    <DownloadIcon className="size-4" />
                  </a>
                  {b.hasSql && (
                    <a
                      href={`/api/backups/${b.name.replace(/\.db$/, '.sql')}`}
                      download
                      className="text-muted-foreground hover:text-foreground transition-colors p-1.5"
                      title="Download seed SQL"
                    >
                      <span className="text-[10px] font-mono font-bold px-1">SQL</span>
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </GlassPanel>

      {confirmRestore && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-xl border border-white/10 bg-[#0a0a0f] p-6 shadow-2xl space-y-4">
            <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Restore Backup</h3>
            <p className="text-muted-foreground text-sm">
              This will replace your current database with <span className="font-mono text-white/70">{confirmRestore}</span>. 
              Current data will be lost. The page will reload after restoration.
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setConfirmRestore(null)} disabled={restoring}>
                Cancel
              </Button>
              <Button size="sm" variant="destructive" onClick={handleRestore} disabled={restoring}>
                {restoring ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                Restore
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function DebugSettings() {
  const [debugEnabled, setDebugEnabled] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    fetch("/api/settings")
      .then(r => r.json())
      .then(settings => {
        const raw = settings.find((s: any) => s.key === "debug_enabled");
        setDebugEnabled(raw?.value === "true");
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  function toggleDebug(v: boolean) {
    setDebugEnabled(v);
    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "debug_enabled", value: v }),
    }).catch(() => setDebugEnabled(!v));
  }

  if (loading) {
    return (
      <GlassPanel className="p-6 flex items-center justify-center py-12">
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
      </GlassPanel>
    );
  }

  return (
    <div className="space-y-5">
      <GlassPanel className="p-6 space-y-5">
        <div>
          <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Debug Mode</h3>
          <p className="text-muted-foreground text-xs mt-0.5">Capture API calls, system events, and provider activity for live inspection</p>
        </div>

        <FieldRow label="Debug Enabled" description="When on, all API calls and system events are logged to the live console below">
          <Switch
            checked={debugEnabled}
            onCheckedChange={toggleDebug}
          />
        </FieldRow>
      </GlassPanel>

      {debugEnabled && (
        <div className="rounded-lg border border-white/5 overflow-hidden h-[600px]">
          <DebugPage onDone={() => {}} />
        </div>
      )}
    </div>
  );
}

function FieldRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0 shrink-0 pt-2.5" style={{ width: 170 }}>
        <Label className="font-mono text-sub font-bold uppercase tracking-widest text-foreground/80">{label}</Label>
        <p className="text-muted-foreground mt-0.5 text-sub leading-tight">{description}</p>
      </div>
      <div className="min-w-0 flex-1 max-w-lg">{children}</div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

function FolderPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [currentPath, setCurrentPath] = React.useState(value || "/");
  const [dirs, setDirs] = React.useState<string[]>([]);
  const [parentPath, setParentPath] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [position, setPosition] = React.useState<{ top: number; left: number; width: number } | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);

  function loadDir(dirPath: string) {
    setLoading(true);
    setError(null);
    fetch(`/api/files/browse?path=${encodeURIComponent(dirPath)}`)
      .then(r => {
        if (!r.ok) return r.json().then(d => { throw new Error(d.error || "Failed to load directory"); });
        return r.json();
      })
      .then(data => {
        setCurrentPath(data.path);
        setDirs(data.directories);
        setParentPath(data.parentPath);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }

  function openPanel() {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setPosition({ top: rect.bottom + 6, left: rect.left, width: rect.width });
    }
    setOpen(true);
    loadDir(value || "/");
  }

  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node) &&
          containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClick);
      window.addEventListener('scroll', () => setOpen(false), { once: true });
    }
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div className="relative flex-1" ref={containerRef}>
      <div className="flex items-center gap-2">
        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="/path/to/root/folder"
          className="flex-1 font-mono h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
        />
        <button
          type="button"
          onClick={openPanel}
          className="flex items-center gap-1.5 rounded-md border border-input bg-transparent hover:bg-white/[0.04] text-muted-foreground hover:text-foreground h-9 px-3 font-mono text-xs uppercase tracking-wider transition-colors shrink-0"
        >
          <FolderOpenIcon className="size-3.5" />
          Browse
        </button>
      </div>

      {open && position && createPortal(
        <div ref={panelRef} className="fixed z-[9999] rounded-lg border border-white/10 bg-[#15181f] shadow-xl p-2 max-h-60 overflow-y-auto"
          style={{ top: position.top, left: position.left, width: position.width, backdropFilter: "blur(16px)" }}>
          <div className="px-2 py-1 font-mono text-caption text-muted-foreground/60 truncate" title={currentPath}>
            {currentPath}
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="px-2 py-3 text-xs text-red-400">{error}</div>
          ) : dirs.length === 0 && !parentPath ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">No subdirectories</div>
          ) : (
            <div className="mt-1 space-y-0.5">
              {parentPath && (
                <button
                  onClick={() => loadDir(parentPath!)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/[0.04] text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronRightIcon className="size-3.5 -rotate-90" />
                  ..
                </button>
              )}
              {dirs.map(dir => (
                <button
                  key={dir}
                  onClick={() => loadDir(`${currentPath.replace(/\/$/, "")}/${dir}`)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/[0.04] text-sm text-foreground/80 hover:text-foreground transition-colors text-left"
                >
                  <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{dir}</span>
                </button>
              ))}
            </div>
          )}
          <div className="mt-1.5 flex items-center gap-2 border-t border-white/5 pt-1.5">
            <button
              type="button"
              onClick={() => { onChange(currentPath); setOpen(false); }}
              className="flex-1 rounded-md bg-signal/15 text-signal hover:bg-signal/25 text-sm font-medium py-1.5 transition-colors"
            >
              Select this folder
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground text-sm py-1.5 px-3 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function TasksPanel({ tasks, loading, onRunTask, onUpdateTask, taskRunning, saving }: {
  tasks: any[];
  loading: boolean;
  onRunTask: (name: string) => void;
  onUpdateTask: (name: string, updates: any) => void;
  taskRunning: Record<string, boolean>;
  saving: string | null;
}) {
  const [editing, setEditing] = React.useState<string | null>(null);
  const [editInterval, setEditInterval] = React.useState<number>(60);

  const groupedTasks = React.useMemo(() => {
    const groups: Record<string, any[]> = {
      sync: [],
      maintenance: [],
      downloading: [],
      system: [],
    };
    tasks.forEach((task: any) => {
      const cat = task.category as keyof typeof groups;
      if (cat in groups) {
        groups[cat]!.push(task);
      } else {
        groups.system!.push(task);
      }
    });
    return groups;
  }, [tasks]);

  const categoryLabels: Record<string, { label: string; icon: any }> = {
    sync: { label: "Sync Tasks", icon: RefreshCwIcon },
    maintenance: { label: "Maintenance", icon: CalendarIcon },
    downloading: { label: "Downloading", icon: DownloadIcon },
    system: { label: "System", icon: ClockIcon },
  };

  function formatInterval(minutes: number): string {
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
    return `${Math.floor(minutes / 1440)}d`;
  }

  function formatLastExecution(task: any): string {
    if (!task.lastExecution) return "Never";
    const date = new Date(task.lastExecution);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return `${Math.floor(diffMins / 1440)}d ago`;
  }

  function formatNextExecution(task: any): string {
    if (!task.nextExecution) return "Not scheduled";
    const date = new Date(task.nextExecution);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins <= 0) return "Due now";
    if (diffMins < 60) return `In ${diffMins}m`;
    if (diffMins < 1440) return `In ${Math.floor(diffMins / 60)}h`;
    return `In ${Math.floor(diffMins / 1440)}d`;
  }

  function startEdit(task: any) {
    setEditing(task.name);
    setEditInterval(task.intervalMinutes);
  }

  function saveEdit(task: any) {
    onUpdateTask(task.name, { intervalMinutes: editInterval });
    setEditing(null);
  }

  function cancelEdit() {
    setEditing(null);
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
      {Object.entries(groupedTasks).map(([category, categoryTasks]) => {
        if (categoryTasks.length === 0) return null;
        const { label, icon: Icon } = categoryLabels[category] || { label: category, icon: ClockIcon };
        
        return (
          <GlassPanel key={category} className="overflow-hidden">
            <div className="px-6 py-4 border-b border-white/5">
              <div className="flex items-center gap-2">
                <Icon className="size-4 text-signal" />
                <h3 className="font-display text-lg font-bold text-white">{label}</h3>
              </div>
            </div>
            <div className="divide-y divide-white/5">
              {categoryTasks.map(task => (
                <div key={task.name} className="px-6 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h4 className="font-mono text-sm font-medium text-white">{task.displayName}</h4>
                        {!task.enabled && (
                          <span className="px-2 py-0.5 rounded-full bg-white/5 text-muted-foreground text-[10px] font-mono uppercase">
                            Disabled
                          </span>
                        )}
                      </div>
                      <p className="text-muted-foreground text-xs mt-1">{task.description}</p>
                      <div className="flex items-center gap-4 mt-3 text-xs font-mono text-muted-foreground">
                        <span className="flex items-center gap-1.5">
                          <ClockIcon className="size-3" />
                          Interval: {editing === task.name ? (
                            <div className="flex items-center gap-2">
                              <input
                                type="number"
                                value={editInterval}
                                onChange={e => setEditInterval(parseInt(e.target.value) || 1)}
                                className="w-16 bg-white/5 border border-white/10 rounded px-2 py-0.5 text-foreground"
                                min="1"
                              />
                              <span>minutes</span>
                              <button
                                onClick={() => saveEdit(task)}
                                disabled={saving === `task-${task.name}`}
                                className="text-emerald-400 hover:text-emerald-300"
                              >
                                <CheckIcon className="size-3" />
                              </button>
                              <button
                                onClick={cancelEdit}
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <XIcon className="size-3" />
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => startEdit(task)}
                              className="hover:text-foreground transition-colors"
                            >
                              {formatInterval(task.intervalMinutes)}
                            </button>
                          )}
                        </span>
                        <span className="flex items-center gap-1.5">
                          Last run: {formatLastExecution(task)}
                        </span>
                        <span className="flex items-center gap-1.5">
                          Next run: {formatNextExecution(task)}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Switch
                        checked={task.enabled}
                        onCheckedChange={(checked) => onUpdateTask(task.name, { enabled: checked })}
                        disabled={saving === `task-${task.name}`}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onRunTask(task.name)}
                        disabled={taskRunning[task.name] || !task.enabled}
                        className="h-8 px-2"
                      >
                        {taskRunning[task.name] ? (
                          <Loader2Icon className="size-4 animate-spin" />
                        ) : (
                          <PlayIcon className="size-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </GlassPanel>
        );
      })}
    </div>
  );
}

function ShowProfileManager() {
  const [profiles, setProfiles] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newPath, setNewPath] = React.useState("");

  function load() {
    setLoading(true);
    fetch("/api/show-profiles")
      .then(r => r.json())
      .then(data => { setProfiles(Array.isArray(data) ? data : []); })
      .catch(() => setProfiles([]))
      .finally(() => setLoading(false));
  }

  React.useEffect(load, []);

  function saveProfile(id: string, name: string, rootFolderPath: string) {
    setSaving(id);
    fetch("/api/show-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name, rootFolderPath }),
    }).then(r => { if (r.ok) load(); })
    .finally(() => setSaving(null));
  }

  function removeProfile(id: string) {
    setSaving(id);
    fetch(`/api/show-profiles/${id}`, { method: "DELETE" })
      .then(r => { if (r.ok) load(); })
      .finally(() => setSaving(null));
  }

  function slugify(name: string) {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || crypto.randomUUID().slice(0, 8);
  }

  function createProfile() {
    if (!newName.trim() || !newPath.trim()) return;
    const id = slugify(newName);
    saveProfile(id, newName.trim(), newPath.trim());
    setNewName("");
    setNewPath("");
    setAdding(false);
  }

  return (
    <div className="space-y-3">
      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {profiles.length > 0 && (
            <div className="space-y-2">
              {profiles.map(p => (
                <ProfileRow
                  key={p.id}
                  profile={p}
                  saving={saving === p.id}
                  onSave={(name, path) => saveProfile(p.id, name, path)}
                  onRemove={() => removeProfile(p.id)}
                />
              ))}
            </div>
          )}

          {!adding ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="flex items-center gap-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.08] border border-white/5 px-3 py-1.5 font-mono text-xs text-foreground/80 transition-colors"
              >
                <PlusIcon className="size-3" />
                {profiles.length === 0 ? "Add a profile" : "Add profile"}
              </button>
            </div>
          ) : (
            <div className="space-y-2 rounded-lg px-4 py-3 bg-white/[0.04]">
              <div className="flex items-center gap-2">
                <Input
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="Profile name (e.g. TV Shows)"
                  className="w-48"
                />
                <FolderPicker value={newPath} onChange={setNewPath} />
                <Button size="sm" onClick={createProfile} disabled={saving !== null || !newName.trim() || !newPath.trim()}>
                  {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />}
                  Add
                </Button>
                <button
                  type="button"
                  onClick={() => { setAdding(false); setNewName(""); setNewPath(""); }}
                  className="text-muted-foreground hover:text-foreground transition-colors p-1.5"
                >
                  <XIcon className="size-4" />
                </button>
              </div>
            </div>
          )}

          {profiles.length === 0 && !adding && (
            <p className="text-muted-foreground py-2 text-center text-xs">
              No profiles yet. Create one above to start organizing your shows.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function ProfileRow({ profile, saving, onSave, onRemove }: {
  profile: { id: string; name: string; root_folder_path: string };
  saving: boolean;
  onSave: (name: string, path: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(profile.name);
  const [path, setPath] = React.useState(profile.root_folder_path);

  React.useEffect(() => {
    setName(profile.name);
    setPath(profile.root_folder_path);
  }, [profile.name, profile.root_folder_path]);

  if (!editing) {
    return (
      <div className="flex items-center gap-3 rounded-lg px-4 py-3 bg-white/[0.03]">
        <div className="size-8 rounded-lg bg-signal/10 grid place-items-center shrink-0">
          <span className="text-signal font-mono text-[10px] font-bold uppercase leading-none">{profile.id.slice(0, 2)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-medium">{profile.name}</div>
          <div className="text-muted-foreground mt-0.5 font-mono text-xs truncate">{profile.root_folder_path}</div>
        </div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-muted-foreground hover:text-foreground text-xs font-mono uppercase tracking-wider transition-colors"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onRemove}
          disabled={saving}
          className="text-muted-foreground hover:text-red-400 shrink-0 transition-colors"
        >
          <Trash2Icon className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg px-4 py-3 bg-white/[0.04]">
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Profile name"
          className="w-32"
        />
        <FolderPicker value={path} onChange={setPath} />
        <Button size="sm" onClick={() => { onSave(name, path); setEditing(false); }} disabled={saving || !name.trim() || !path.trim()}>
          {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
        </Button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="text-muted-foreground hover:text-foreground transition-colors p-1.5"
        >
          <XIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}

function ColorDock({ current, onChange }: { current: string; onChange: (c: string) => void }) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const isCustom = !THEME_PRESETS.some(p => p.color === current);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-1.5 bg-white/[0.04] rounded-full p-1 border border-white/5">
        {THEME_PRESETS.map(({ color, label }) => (
          <button
            key={color}
            onClick={() => onChange(color)}
            className={`size-6 rounded-full transition-all ${
              current === color ? "ring-2 ring-white/80 scale-110" : "ring-1 ring-white/10 hover:scale-105"
            }`}
            style={{ background: color }}
            aria-label={label}
          />
        ))}
        <div className="w-px h-5 bg-white/10 mx-0.5" />
        <button
          onClick={() => inputRef.current?.click()}
          className={`size-6 rounded-full ring-1 transition-all grid place-items-center hover:scale-105 ${
            isCustom ? "ring-white/60" : "ring-white/10"
          }`}
          style={isCustom ? { background: current } : undefined}
          aria-label="Pick custom color"
        >
          <input
            ref={inputRef}
            type="color"
            value={current.startsWith('#') ? current : '#19b7a6'}
            onChange={(e) => onChange(e.target.value)}
            className="absolute opacity-0 size-full cursor-pointer"
          />
          {!isCustom && <span className="text-xs text-muted-foreground leading-none">+</span>}
        </button>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
        <span className="size-3 rounded-full" style={{ background: current }} />
        {current}
      </div>
    </div>
  );
}
