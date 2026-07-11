import { CheckIcon, EyeIcon, EyeOffIcon, FolderPlusIcon, Loader2Icon, Trash2Icon, XIcon } from "lucide-react";
import * as React from "react";

import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Button } from "@frontend/components/ui/button";
import { Input } from "@frontend/components/ui/input";
import { Label } from "@frontend/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { Switch } from "@frontend/components/ui/switch";
import { THEME_PRESETS, loadAccent, saveAccent, applyAccent, loadTheme, saveTheme, applyTheme, type ThemeConfig } from "@frontend/lib/theme";

const SETTINGS_TABS = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "rootfolders", label: "Root Folders" },
  { id: "providers", label: "Providers" },
  { id: "indexers", label: "Indexers" },
  { id: "downloads", label: "Downloads" },
];

export function SettingsPage({ onDone: _onDone }: { onDone: () => void }) {
  const [tab, setTab] = React.useState("general");
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState<string | null>(null);
  const [saveMsg, setSaveMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const [config, setConfig] = React.useState<any>({});
  const [prowlarr, setProwlarr] = React.useState({ baseUrl: "", apiKey: "", syncLevel: "full", tags: [] as number[] });

  const [showProwlarrKey, setShowProwlarrKey] = React.useState(false);
  const [showTmdbKey, setShowTmdbKey] = React.useState(false);
  const [showTvdbKey, setShowTvdbKey] = React.useState(false);
  const [showTvdbPin, setShowTvdbPin] = React.useState(false);

  const [accent, setAccent] = React.useState(loadAccent);
  const [theme, setTheme] = React.useState<ThemeConfig | null>(null);

  const [prowlarrTesting, setProwlarrTesting] = React.useState(false);
  const [prowlarrStatus, setProwlarrStatus] = React.useState<{ ok: boolean; message?: string } | null>(null);

  const [indexers, setIndexers] = React.useState<any[] | null>(null);
  const [indexersLoading, setIndexersLoading] = React.useState(false);

  React.useEffect(() => {
    Promise.all([
      fetch("/api/config").then(r => r.json()),
      fetch("/api/settings").then(r => r.json()),
      loadTheme(),
    ]).then(([cfg, settings, loadedTheme]) => {
      setConfig(cfg);
      setTheme(loadedTheme);
      const prowlarrRaw = settings.find((s: any) => s.key === "prowlarr");
      if (prowlarrRaw) {
        try {
          const p = JSON.parse(prowlarrRaw.value);
          setProwlarr({ baseUrl: p.baseUrl || "", apiKey: p.apiKey || "", syncLevel: p.syncLevel || "full", tags: p.tags || [] });
        } catch {}
      }
      setLoading(false);
    });
  }, []);

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

  function updateApiKey(provider: string, value: string) {
    const newKeys = { ...(config.apiKeys || {}), [provider]: value || undefined };
    const clean = Object.fromEntries(Object.entries(newKeys).filter(([_, v]) => v));
    saveConfig({ apiKeys: clean });
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
                <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Library</h3>
                <p className="text-muted-foreground text-xs mt-0.5">Default library path (root folders are set under Root Folders tab)</p>
              </div>
              <FieldRow label="Library Path" description="Fallback directory if no root folder is set on a show">
                <Input
                  value={config.libraryPath || ""}
                  onChange={e => setConfig((prev: any) => ({ ...prev, libraryPath: e.target.value }))}
                  onBlur={() => saveConfig({ libraryPath: config.libraryPath || null })}
                  placeholder="/path/to/library"
                />
              </FieldRow>
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

        {tab === "rootfolders" && (
          <GlassPanel className="p-6 space-y-5">
            <div>
              <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Root Folders</h3>
              <p className="text-muted-foreground text-xs mt-0.5">Media directories for organizing shows. Each show is mapped to a root folder.</p>
            </div>
            <RootFolderManager />
          </GlassPanel>
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
              <div>
                <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Prowlarr Connection</h3>
                <p className="text-muted-foreground text-xs mt-0.5">Connect to Prowlarr to search torrent/usenet indexers</p>
              </div>
              <FieldRow label="Prowlarr URL" description="e.g. http://localhost:9696">
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
            </GlassPanel>

            <GlassPanel className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Configured Indexers</h3>
                  <p className="text-muted-foreground text-xs mt-0.5">Indexers currently registered in Prowlarr</p>
                </div>
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
                <p className="text-muted-foreground text-sm py-4">Click "Refresh" to load indexers.</p>
              ) : indexers.length === 0 ? (
                <p className="text-muted-foreground text-sm py-4">No indexers found in Prowlarr.</p>
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
            </GlassPanel>
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

        {tab === "downloads" && (
          <GlassPanel className="p-6 space-y-5">
            <div>
              <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Download Client</h3>
              <p className="text-muted-foreground text-xs mt-0.5">Configure how ShowFlow sends releases to your download client</p>
            </div>
            <FieldRow label="Client Type" description="How downloads are triggered">
              <Select
                value={config.downloadClient?.type || "blackhole"}
                onValueChange={v => saveConfig({ downloadClient: { ...config.downloadClient, type: v } })}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="blackhole">Blackhole</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </FieldRow>
            {config.downloadClient?.type === "blackhole" && (
              <FieldRow label="Watch Folder" description="Directory where completed downloads appear for import">
                <Input
                  value={config.downloadClient?.blackhole?.watchFolder || ""}
                  onChange={e => saveConfig({
                    downloadClient: {
                      ...config.downloadClient,
                      blackhole: { watchFolder: e.target.value || null },
                    },
                  })}
                  placeholder="/path/to/watch/folder"
                />
              </FieldRow>
            )}
          </GlassPanel>
        )}
      </div>
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

function RootFolderManager() {
  const [folders, setFolders] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [newPath, setNewPath] = React.useState("");
  const [adding, setAdding] = React.useState(false);

  function load() {
    setLoading(true);
    fetch("/api/rootfolders")
      .then(r => r.json())
      .then(data => { setFolders(Array.isArray(data) ? data : []); })
      .catch(() => setFolders([]))
      .finally(() => setLoading(false));
  }

  React.useEffect(load, []);

  function addFolder() {
    const path = newPath.trim();
    if (!path) return;
    setAdding(true);
    fetch("/api/rootfolders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }).then(r => {
      if (r.ok) {
        setNewPath("");
        load();
      }
    }).finally(() => setAdding(false));
  }

  function removeFolder(path: string) {
    fetch("/api/rootfolders/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }).then(r => {
      if (r.ok) load();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Input
          value={newPath}
          onChange={e => setNewPath(e.target.value)}
          placeholder="/path/to/media"
          onKeyDown={e => e.key === "Enter" && addFolder()}
        />
        <Button size="sm" onClick={addFolder} disabled={adding || !newPath.trim()}>
          {adding ? <Loader2Icon className="size-3.5 animate-spin" /> : <FolderPlusIcon className="size-3.5" />}
          Add
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : folders.length === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-sm">No root folders configured yet.</p>
      ) : (
        <div className="space-y-1.5">
          {folders.map(f => (
            <div key={f.path} className="flex items-center gap-3 rounded-lg px-4 py-3 bg-white/[0.03]">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-sm font-medium">{f.path}</div>
                <div className="text-muted-foreground mt-0.5 flex items-center gap-3 text-xs">
                  <span>{formatBytes(f.freeSpace)} free</span>
                  {f.unmappedFolders?.length > 0 && (
                    <span>{f.unmappedFolders.length} unmapped folder(s)</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => removeFolder(f.path)}
                className="text-muted-foreground hover:text-red-400 shrink-0 transition-colors"
              >
                <Trash2Icon className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}
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

function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}
