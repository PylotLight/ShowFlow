import * as React from "react";
import { Button } from "@frontend/components/ui/button";
import { Input } from "@frontend/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@frontend/components/ui/select";
import { cn } from "@frontend/lib/utils";
import {
  ArrowRightIcon,
  CheckCircleIcon,
  XCircleIcon,
  Loader2Icon,
  CableIcon,
  DatabaseIcon,
  DownloadIcon,
  TvIcon,
  SearchIcon,
  EyeIcon,
  EyeOffIcon,
  SparklesIcon,
} from "lucide-react";
import { SonarrImportProgress } from "@frontend/components/showflow/SonarrImportProgress";
import type { StepProps, SonarrSeries } from "../types";
import { TIMEZONE_PRESETS } from "@frontend/lib/timezones";
import { GlobeIcon } from "lucide-react";

export function StepIntegrations({ data, setData, onNext, onSkip, sonarrPanelOpen, setSonarrPanelOpen }: StepProps) {
  const [tvdbKey, setTvdbKey] = React.useState("");
  const [tvdbPin, setTvdbPin] = React.useState("");
  const [tmdbKey, setTmdbKey] = React.useState("");
  const [showTvdbKey, setShowTvdbKey] = React.useState(false);
  const [showTvdbPin, setShowTvdbPin] = React.useState(false);
  const [showTmdbKey, setShowTmdbKey] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/config").then(r => r.json()).then(cfg => {
      const keys = cfg.apiKeys || {};
      setTvdbKey(keys.tvdb || "");
      setTvdbPin(keys.tvdb_pin || "");
      setTmdbKey(keys.tmdb || "");
    }).catch(() => {});
  }, []);

  const hasMetadataKey = !!(tvdbKey.trim() || tmdbKey.trim());

  const saveMetadataKeys = (tvdb: string, pin: string, tmdb: string) => {
    const payload: Record<string, string | undefined> = {};
    if (tvdb) payload.tvdb = tvdb;
    if (pin) payload.tvdb_pin = pin;
    if (tmdb) payload.tmdb = tmdb;
    fetch("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKeys: payload }),
    }).catch(() => {});
  };

  const [prowlarrEnabled, setProwlarrEnabled] = React.useState(!!data.prowlarr.baseUrl);
  const [testingProwlarr, setTestingProwlarr] = React.useState(false);
  const [prowlarrStatus, setProwlarrStatus] = React.useState<'idle' | 'ok' | 'fail'>('idle');
  const [prowlarrMsg, setProwlarrMsg] = React.useState("");

  const [sonarrEnabled, setSonarrEnabled] = React.useState(!!data.sonarr.baseUrl);
  const [testingSonarr, setTestingSonarr] = React.useState(false);
  const [sonarrStatus, setSonarrStatus] = React.useState<'idle' | 'ok' | 'fail'>('idle');
  const [sonarrMsg, setSonarrMsg] = React.useState("");

  const [metaPanelOpen, setMetaPanelOpen] = React.useState(false);
  const [dcEnabled, setDcEnabled] = React.useState(data.downloadClient.type !== 'none');
  const [fetching, setFetching] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<number>>(new Set());
  const [libraryTypes, setLibraryTypes] = React.useState<{ id: string; name: string; is_default?: boolean }[]>([]);
  const [typeFilter, setTypeFilter] = React.useState<string | null>(null);

  const { sonarr, prowlarr, downloadClient } = data;

  const [fallbackTimeZone, setFallbackTimeZone] = React.useState("America/New_York");

  React.useEffect(() => {
    fetch("/api/config").then(r => r.json()).then(cfg => {
      if (cfg.fallbackTimeZone) setFallbackTimeZone(cfg.fallbackTimeZone);
    }).catch(() => {});
  }, []);

  const saveFallbackTimeZone = (tz: string) => {
    setFallbackTimeZone(tz);
    fetch("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fallbackTimeZone: tz }),
    }).catch(() => {});
  };

  // Maps Sonarr series types (Anime, Standard) to library type IDs
  const [sonarrTypeMapping, setSonarrTypeMapping] = React.useState<Record<string, string>>({});

  // Unique seriesType values present in Sonarr's data
  const seriesTypes = React.useMemo(() => {
    const types = new Set(sonarr.series.map(s => s.seriesType));
    return [...types];
  }, [sonarr.series]);

  // Auto-select first seriesType when data arrives and no filter is set
  React.useEffect(() => {
    if (seriesTypes.length > 0 && !typeFilter) {
      const first = seriesTypes[0];
      if (first) setTypeFilter(first);
    }
  }, [seriesTypes]);

  // Series filtered by the selected seriesType
  const filteredSeries = React.useMemo(() => {
    if (!typeFilter) return sonarr.series;
    return sonarr.series.filter(s => s.seriesType === typeFilter);
  }, [sonarr.series, typeFilter]);

  // Load library types on mount
  React.useEffect(() => {
    fetch("/api/library-types").then(res => res.json()).then(setLibraryTypes).catch(() => {});
  }, []);

  // Seed Sonarr type mapping; never reset existing selections
  React.useEffect(() => {
    const defaultId = data.libraryTypeId ?? (libraryTypes.find(lt => lt.is_default) ?? libraryTypes[0])?.id ?? '';
    setSonarrTypeMapping(prev => {
      const next = { ...prev };
      let changed = false;
      for (const st of seriesTypes) {
        if (!next[st]) { next[st] = defaultId; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [seriesTypes, data.libraryTypeId, libraryTypes]);

  // Watch-mode import takes over the page. The job itself lives only in an
  // in-memory registry on the server (see /api/background-jobs) — it is NOT
  // persisted in the database. So if the server restarted, or the DB was
  // wiped, the job referenced by a leftover importJobId is gone for good,
  // but the wizard's own persisted state (localStorage / the
  // "onboarding.wizard" setting) has no way of knowing that on its own.
  // Without this check, the takeover screen below polls a job that 404s
  // forever and just sits on "Starting import...". Verify the job is real
  // before trusting it, and silently drop back to the normal config form
  // if it isn't.
  const [importJobMissing, setImportJobMissing] = React.useState(false);
  React.useEffect(() => {
    if (!sonarr.importJobId || sonarr.importForkMode !== 'watch') return;
    let cancelled = false;
    fetch(`/api/background-jobs/${sonarr.importJobId}`)
      .then(res => { if (!cancelled && !res.ok) setImportJobMissing(true); })
      .catch(() => { if (!cancelled) setImportJobMissing(true); });
    return () => { cancelled = true; };
  }, [sonarr.importJobId, sonarr.importForkMode]);

  React.useEffect(() => {
    if (importJobMissing) {
      setData({ sonarr: { ...sonarr, importJobId: null, importForkMode: null } });
      setImportJobMissing(false);
    }
  }, [importJobMissing]);

  if (sonarr.importJobId && sonarr.importForkMode === 'watch' && !importJobMissing) {
    return (
      <div className="py-4">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight mb-2">Importing Series</h2>
            <p className="text-muted-foreground">Your series are being imported from Sonarr.</p>
          </div>
          <button
            onClick={() => setData({ sonarr: { ...sonarr, importJobId: null, importForkMode: null } })}
            className="shrink-0 text-xs text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors italic whitespace-nowrap pt-1"
          >
            Cancel and reconfigure
          </button>
        </div>
        <SonarrImportProgress
          jobId={sonarr.importJobId}
          onDone={() => {
            // Clear the job flags so this takeover screen doesn't reappear the
            // next time this step is rendered (e.g. after going back/forward,
            // or on a later run of onboarding).
            setData({ sonarr: { ...sonarr, importJobId: null, importForkMode: null } });
            onNext();
          }}
        />
      </div>
    );
  }

  const testProwlarr = async () => {
    setTestingProwlarr(true);
    setProwlarrStatus('idle');
    setProwlarrMsg("");
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "prowlarr",
          value: { enabled: true, baseUrl: prowlarr.baseUrl, apiKey: prowlarr.apiKey, syncLevel: prowlarr.syncLevel, tags: [] },
        }),
      });
      if (!res.ok) { setProwlarrStatus('fail'); setProwlarrMsg("Failed to save"); return; }
      const testRes = await fetch("/api/indexers/prowlarr/status");
      const testData = await testRes.json();
      if (testData.ok) {
        setProwlarrStatus('ok');
        setProwlarrMsg("Connection successful");
      } else {
        setProwlarrStatus('fail');
        setProwlarrMsg(testData.message ?? "Connection failed");
      }
    } catch {
      setProwlarrStatus('fail');
      setProwlarrMsg("Connection error");
    } finally {
      setTestingProwlarr(false);
    }
  };

  const saveSonarrConfig = async () => {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "sonarr",
        value: { enabled: true, baseUrl: sonarr.baseUrl, apiKey: sonarr.apiKey, apiVersion: sonarr.apiVersion },
      }),
    });
    return res.ok;
  };

  const testSonarr = async () => {
    setTestingSonarr(true);
    setSonarrStatus('idle');
    setSonarrMsg("");
    try {
      await saveSonarrConfig();
      const res = await fetch("/api/sonarr/test");
      const d = await res.json();
      if (d.ok) { setSonarrStatus('ok'); setSonarrMsg("Sonarr connected"); }
      else { setSonarrStatus('fail'); setSonarrMsg(d.message ?? "Test failed"); }
    } catch { setSonarrStatus('fail'); setSonarrMsg("Connection error"); }
    finally { setTestingSonarr(false); }
  };

  const fetchSeries = async () => {
    setFetching(true);
    try {
      const res = await fetch("/api/sonarr/series");
      if (res.ok) {
        const series: SonarrSeries[] = await res.json();
        setData({ sonarr: { ...sonarr, series, tested: true } });
        setSelectedIds(new Set(series.map(s => s.id)));
      }
    } catch {} finally { setFetching(false); }
  };

  const toggleSeries = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const startImport = async (mode: 'background' | 'watch') => {
    setImporting(true);
    try {
      const ids = [...selectedIds];
      const mapping: Record<string, { libraryTypeId: string }> = {};
      seriesTypes.forEach(st => {
        const libId = sonarrTypeMapping[st] ?? data.libraryTypeId ?? '';
        if (libId) mapping[st] = { libraryTypeId: libId };
      });
      const res = await fetch("/api/sonarr/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seriesIds: ids, typeMapping: mapping }),
      });
      if (res.ok) {
        const result = await res.json();
        setData({ sonarr: { ...sonarr, importJobId: result.jobId, importForkMode: mode } });
        if (mode === 'background') {
          onNext();
        }
      }
    } catch {} finally { setImporting(false); }
  };

  return (
    <div className="relative py-2">
      <div className="mb-6">
        <h2 className="text-xl font-bold tracking-tight mb-1">Integrations</h2>
        <p className="text-sm text-muted-foreground">
          Connect the services ShowFlow integrates with. Metadata providers are required — everything else is optional.
        </p>
      </div>

      <div className="space-y-3">

        {/* ├─ Metadata Providers (required) ────────────────────── */}
        <div className={cn(
          "p-4 rounded-2xl border transition-all",
          hasMetadataKey
            ? "border-green-500/30 bg-green-500/[0.03]"
            : "border-amber-500/30 bg-amber-500/[0.03]"
        )}>
          <div className="flex items-center gap-3">
            <div className={cn(
              "size-5 rounded-md border-2 flex items-center justify-center shrink-0",
              hasMetadataKey ? "bg-green-500 border-green-500" : "border-amber-500"
            )}>
              {hasMetadataKey && <CheckCircleIcon className="size-3.5 text-white" />}
            </div>
            <DatabaseIcon className={cn("size-4", hasMetadataKey ? "text-green-400" : "text-amber-400")} />
            <div className="flex-1">
              <p className="text-sm font-semibold">Metadata Providers</p>
              <p className="text-xs text-muted-foreground">
                TVDB or TMDB API key required for show metadata
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMetaPanelOpen(true)}
              className="gap-1.5 shrink-0"
            >
              <EyeIcon className="size-3.5" />
              {hasMetadataKey ? "View keys" : "Configure"}
            </Button>
          </div>
        </div>

        {/* ├─ Fallback Timezone ──────────────────────────────────── */}
        <div className="p-4 rounded-2xl border border-white/10 bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <GlobeIcon className="size-4 text-signal" />
            <div className="flex-1">
              <p className="text-sm font-semibold">Broadcast Timezone Fallback</p>
              <p className="text-xs text-muted-foreground">
                Used when TVDB can't pin an airtime to a country's timezone
              </p>
            </div>
            <Select value={fallbackTimeZone} onValueChange={saveFallbackTimeZone}>
              <SelectTrigger className="w-44 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONE_PRESETS.map(tz => (
                  <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* ├─ Prowlarr ─────────────────────────────────────────── */}
        <div className={cn(
          "p-4 rounded-2xl border transition-all",
          prowlarrStatus === 'ok'
            ? "border-green-500/30 bg-green-500/[0.03]"
            : "border-white/10 bg-white/[0.02]"
        )}>
          <button
            onClick={() => setProwlarrEnabled(!prowlarrEnabled)}
            className="flex items-center gap-3 w-full text-left"
          >
            <div className={cn(
              "size-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors",
              prowlarrEnabled ? "bg-signal border-signal" : "border-white/20"
            )}>
              {prowlarrEnabled && <CheckCircleIcon className="size-3.5 text-white" />}
            </div>
            <CableIcon className={cn("size-4", prowlarrEnabled ? "text-signal" : "text-muted-foreground/40")} />
            <div className="flex-1">
              <p className={cn("text-sm font-semibold", !prowlarrEnabled && "text-muted-foreground/50")}>
                Prowlarr (Indexer)
              </p>
              <p className="text-xs text-muted-foreground">
                Search and grab releases from your indexers
              </p>
            </div>
          </button>

          {prowlarrEnabled && (
            <div className="mt-3 space-y-2 pl-10">
              <div>
                <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">URL</p>
                <Input
                  value={prowlarr.baseUrl}
                  onChange={e => setData({ prowlarr: { ...prowlarr, baseUrl: e.target.value } })}
                  placeholder="http://localhost:9696"
                  className="font-mono"
                />
              </div>
              <div>
                <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">API Key</p>
                <Input
                  value={prowlarr.apiKey}
                  onChange={e => setData({ prowlarr: { ...prowlarr, apiKey: e.target.value } })}
                  type="password"
                  placeholder="Your Prowlarr API key"
                  className="font-mono"
                />
              </div>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={testProwlarr}
                  disabled={!prowlarr.baseUrl || !prowlarr.apiKey || testingProwlarr}
                  className="gap-1.5"
                >
                  {testingProwlarr ? <Loader2Icon className="size-3.5 animate-spin" /> : <CableIcon className="size-3.5" />}
                  Test connection
                </Button>
                {prowlarrStatus === 'ok' && (
                  <span className="flex items-center gap-1 text-xs text-green-400">
                    <CheckCircleIcon className="size-3.5" /> {prowlarrMsg}
                  </span>
                )}
                {prowlarrStatus === 'fail' && (
                  <span className="flex items-center gap-1 text-xs text-red-400">
                    <XCircleIcon className="size-3.5" /> {prowlarrMsg}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ├─ Sonarr ───────────────────────────────────────────── */}
        <div className={cn(
          "p-4 rounded-2xl border transition-all",
          !hasMetadataKey && "opacity-40 pointer-events-none",
          sonarrStatus === 'ok'
            ? "border-green-500/30 bg-green-500/[0.03]"
            : "border-white/10 bg-white/[0.02]"
        )}>
          <button
            onClick={() => { if (!hasMetadataKey) return; setSonarrEnabled(!sonarrEnabled); if (!sonarrEnabled) setSonarrStatus('idle'); }}
            className="flex items-center gap-3 w-full text-left"
          >
            <div className={cn(
              "size-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors",
              sonarrEnabled ? "bg-signal border-signal" : "border-white/20"
            )}>
              {sonarrEnabled && <CheckCircleIcon className="size-3.5 text-white" />}
            </div>
            <TvIcon className={cn("size-4", sonarrEnabled ? "text-signal" : "text-muted-foreground/40")} />
            <div className="flex-1">
              <p className={cn("text-sm font-semibold", !sonarrEnabled && "text-muted-foreground/50")}>
                Sonarr
              </p>
              <p className="text-xs text-muted-foreground">
                {hasMetadataKey ? "Sync your existing series and imports" : "Configure a metadata provider key above first"}
              </p>
            </div>
          </button>

          {sonarrEnabled && (
            <div className="mt-3 space-y-2 pl-10">
              <div>
                <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">URL</p>
                <Input
                  value={sonarr.baseUrl}
                  onChange={e => setData({ sonarr: { ...sonarr, baseUrl: e.target.value, tested: false } })}
                  placeholder="http://localhost:8989"
                  className="font-mono"
                />
              </div>
              <div>
                <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">API Key</p>
                <Input
                  value={sonarr.apiKey}
                  onChange={e => setData({ sonarr: { ...sonarr, apiKey: e.target.value, tested: false } })}
                  type="password"
                  placeholder="Your Sonarr API key"
                  className="font-mono"
                />
              </div>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">API Version</p>
                  <Select
                    value={sonarr.apiVersion}
                    onValueChange={(v) => setData({ sonarr: { ...sonarr, apiVersion: v as any, tested: false } })}
                  >
                    <SelectTrigger size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="v3">v3</SelectItem>
                      <SelectItem value="v5">v5</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="pt-5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={testSonarr}
                    disabled={!sonarr.baseUrl || !sonarr.apiKey || testingSonarr}
                    className="gap-1.5"
                  >
                    {testingSonarr ? <Loader2Icon className="size-3.5 animate-spin" /> : <TvIcon className="size-3.5" />}
                    Test
                  </Button>
                </div>
                {sonarrStatus === 'ok' && (
                  <span className="flex items-center gap-1 text-xs text-green-400 pt-5">
                    <CheckCircleIcon className="size-3.5" /> Connected
                  </span>
                )}
                {sonarrStatus === 'fail' && (
                  <span className="flex items-center gap-1 text-xs text-red-400 pt-5">
                    <XCircleIcon className="size-3.5" /> {sonarrMsg}
                  </span>
                )}
              </div>

              {sonarrStatus === 'ok' && (
                <div className="mt-2">
                  <Button
                    variant="glass"
                    onClick={() => { if (!sonarr.tested) fetchSeries(); setSonarrPanelOpen(true); }}
                    disabled={fetching}
                    className="gap-2 w-full h-11 rounded-xl"
                  >
                    {fetching ? <Loader2Icon className="size-4 animate-spin" /> : <SearchIcon className="size-4" />}
                    {sonarr.series.length > 0 ? `Manage Import (${sonarr.series.length} series)` : "Fetch series from Sonarr"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ├─ Download Client ──────────────────────────────────── */}
        <div className="p-4 rounded-2xl border border-white/10 bg-white/[0.02]">
          <button
            onClick={() => { setDcEnabled(!dcEnabled); if (!dcEnabled) setData({ downloadClient: { type: 'none', config: {} } }); }}
            className="flex items-center gap-3 w-full text-left"
          >
            <div className={cn(
              "size-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors",
              dcEnabled ? "bg-signal border-signal" : "border-white/20"
            )}>
              {dcEnabled && <CheckCircleIcon className="size-3.5 text-white" />}
            </div>
            <DownloadIcon className={cn("size-4", dcEnabled ? "text-signal" : "text-muted-foreground/40")} />
            <div className="flex-1">
              <p className={cn("text-sm font-semibold", !dcEnabled && "text-muted-foreground/50")}>
                Download Client
              </p>
              <p className="text-xs text-muted-foreground">
                Start downloading right away
              </p>
            </div>
          </button>

          {dcEnabled && (
            <div className="mt-3 space-y-2 pl-10">
              <div>
                <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">Type</p>
                <Select
                  value={downloadClient.type}
                  onValueChange={(v) => setData({ downloadClient: { type: v as any, config: {} } })}
                >
                  <SelectTrigger size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="blackhole">Blackhole</SelectItem>
                    <SelectItem value="torbox">TorBox</SelectItem>
                    <SelectItem value="sabnzbd">SABnzbd</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {downloadClient.type === 'blackhole' && (
                <div>
                  <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">Output Folder</p>
                  <Input
                    value={downloadClient.config.outputFolder ?? ''}
                    onChange={e => setData({ downloadClient: { ...downloadClient, config: { ...downloadClient.config, outputFolder: e.target.value } } })}
                    placeholder="/path/to/nzb/folder"
                    className="font-mono"
                  />
                </div>
              )}
              {downloadClient.type === 'torbox' && (
                <div>
                  <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">API Key</p>
                  <Input
                    value={downloadClient.config.apiKey ?? ''}
                    onChange={e => setData({ downloadClient: { ...downloadClient, config: { ...downloadClient.config, apiKey: e.target.value } } })}
                    type="password"
                    className="font-mono"
                  />
                </div>
              )}
              {downloadClient.type === 'sabnzbd' && (
                <div className="space-y-3">
                  <div>
                    <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">URL</p>
                    <Input
                      value={downloadClient.config.url ?? ''}
                      onChange={e => setData({ downloadClient: { ...downloadClient, config: { ...downloadClient.config, url: e.target.value } } })}
                      placeholder="http://localhost:8080"
                      className="font-mono"
                    />
                  </div>
                  <div>
                    <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">API Key</p>
                    <Input
                      value={downloadClient.config.apiKey ?? ''}
                      onChange={e => setData({ downloadClient: { ...downloadClient, config: { ...downloadClient.config, apiKey: e.target.value } } })}
                      type="password"
                      className="font-mono"
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Slide-out Metadata Providers panel — same right-edge docking pattern
          as the Sonarr panel below. */}
      <div
        className={cn(
          "absolute left-full top-1/2 -translate-y-1/2 ml-4 w-[420px] max-h-[min(800px,90vh)] z-50",
          "bg-[#15181f] border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden",
          "transition-all duration-300 ease-out",
          metaPanelOpen ? "opacity-100 translate-x-0 pointer-events-auto" : "opacity-0 translate-x-4 pointer-events-none"
        )}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-3">
            <DatabaseIcon className="size-5 text-signal" />
            <div>
              <p className="text-sm font-semibold">Metadata Providers</p>
              <p className="text-xs text-muted-foreground">TVDB or TMDB API key required</p>
            </div>
          </div>
          <button onClick={() => setMetaPanelOpen(false)} className="size-8 flex items-center justify-center rounded-lg hover:bg-white/[0.04] text-muted-foreground/60 hover:text-foreground transition-colors">
            <XCircleIcon className="size-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
          <div>
            <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">TVDB API Key</p>
            <div className="relative">
              <Input
                type={showTvdbKey ? "text" : "password"}
                value={tvdbKey}
                onChange={e => { setTvdbKey(e.target.value); saveMetadataKeys(e.target.value, tvdbPin, tmdbKey); }}
                placeholder="TVDB_API_KEY"
                className="font-mono pr-8"
              />
              <button
                type="button"
                onClick={() => setShowTvdbKey(!showTvdbKey)}
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
              >
                {showTvdbKey ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
              </button>
            </div>
          </div>
          <div>
            <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">TVDB PIN</p>
            <div className="relative">
              <Input
                type={showTvdbPin ? "text" : "password"}
                value={tvdbPin}
                onChange={e => { setTvdbPin(e.target.value); saveMetadataKeys(tvdbKey, e.target.value, tmdbKey); }}
                placeholder="TVDB_PIN (optional)"
                className="font-mono pr-8"
              />
              <button
                type="button"
                onClick={() => setShowTvdbPin(!showTvdbPin)}
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
              >
                {showTvdbPin ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
              </button>
            </div>
          </div>
          <div>
            <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">TMDB API Key</p>
            <div className="relative">
              <Input
                type={showTmdbKey ? "text" : "password"}
                value={tmdbKey}
                onChange={e => { setTmdbKey(e.target.value); saveMetadataKeys(tvdbKey, tvdbPin, e.target.value); }}
                placeholder="TMDB_API_KEY"
                className="font-mono pr-8"
              />
              <button
                type="button"
                onClick={() => setShowTmdbKey(!showTmdbKey)}
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
              >
                {showTmdbKey ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
              </button>
            </div>
          </div>
        </div>
        <div className="shrink-0 px-6 pb-6">
          <Button
            variant="glass"
            className="w-full gap-2 h-11 rounded-xl"
            onClick={() => setMetaPanelOpen(false)}
          >
            <CheckCircleIcon className="size-4" />
            Done
          </Button>
        </div>
      </div>

      {/* Slide-out Sonarr import manager panel — docked to the right edge of this
          card (not the browser viewport), so it opens up right where the card
          slides away from, and its height is capped so it can never run below
          the viewport. */}
      <div
        className={cn(
          "absolute left-full top-1/2 -translate-y-1/2 ml-4 w-[480px] max-h-[min(800px,90vh)] z-50",
          "bg-[#15181f] border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden",
          "transition-all duration-300 ease-out",
          sonarrPanelOpen ? "opacity-100 translate-x-0 pointer-events-auto" : "opacity-0 translate-x-4 pointer-events-none"
        )}
      >
        {/* Panel header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-3">
            <TvIcon className="size-5 text-signal" />
          <div>
            <p className="text-sm font-semibold">Sonarr Import</p>
            <p className="text-xs text-muted-foreground">{selectedIds.size} of {sonarr.series.length} series selected</p>
          </div>
          </div>
          <button onClick={() => setSonarrPanelOpen(false)} className="size-8 flex items-center justify-center rounded-lg hover:bg-white/[0.04] text-muted-foreground/60 hover:text-foreground transition-colors">
            <XCircleIcon className="size-4" />
          </button>
        </div>

        {/* Fetch button */}
        <div className="px-6 py-3 shrink-0">
          {!sonarr.tested ? (
            <Button
              variant="glass"
              className="w-full gap-2 h-11 rounded-xl"
              onClick={async () => { await fetchSeries(); }}
              disabled={fetching}
            >
              {fetching ? <Loader2Icon className="size-4 animate-spin" /> : <SearchIcon className="size-4" />}
              Fetch series from Sonarr
            </Button>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60">
                {filteredSeries.length} of {sonarr.series.length} series
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set(filteredSeries.map(s => s.id)))} className="text-xs">
                  Select all
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())} className="text-xs">
                  Clear
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* SeriesType filter tabs */}
        {sonarr.tested && seriesTypes.length > 0 && (
          <div className="flex gap-1.5 px-6 pb-2 shrink-0">
            <button
              onClick={() => setTypeFilter(null)}
              className={cn(
                "text-xs px-2.5 py-1 rounded-lg font-medium transition-colors",
                !typeFilter
                  ? "bg-white/10 text-foreground"
                  : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-white/[0.04]"
              )}
            >
              All
            </button>
            {seriesTypes.map(st => (
              <button
                key={st}
                onClick={() => setTypeFilter(typeFilter === st ? null : st)}
                className={cn(
                  "text-xs px-2.5 py-1 rounded-lg font-medium transition-colors",
                  typeFilter === st
                    ? "bg-white/10 text-foreground"
                    : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-white/[0.04]"
                )}
              >
                {st.charAt(0).toUpperCase() + st.slice(1)}
              </button>
            ))}
          </div>
        )}

        {/* Series list — flexes to fill whatever space is left between the
            header/fetch row above and the type-mapping/import actions below,
            so it scrolls internally instead of pushing the panel taller than
            its capped max-height. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-3 space-y-0.5">
          {filteredSeries.map(s => (
            <button
              key={s.id}
              onClick={() => toggleSeries(s.id)}
               className={cn(
                 "w-full flex items-center gap-3 px-4 py-1.5 rounded-xl text-sm transition-colors text-left",
                 selectedIds.has(s.id) ? "bg-signal/[0.06] ring-1 ring-signal/20" : "hover:bg-white/[0.03]"
               )}
            >
              <div className={cn(
                "size-4 rounded border flex items-center justify-center shrink-0 transition-colors",
                selectedIds.has(s.id) ? "bg-signal border-signal" : "border-white/20"
              )}>
                {selectedIds.has(s.id) && <CheckCircleIcon className="size-3 text-white" />}
              </div>
              <span className="flex-1 truncate">{s.title}</span>
              <span className="text-xs text-muted-foreground/50 shrink-0">{s.year}</span>
            </button>
          ))}
          {sonarr.tested && filteredSeries.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">No {typeFilter ? `${typeFilter} ` : ''}series found</div>
          )}
        </div>

        {/* Type mapping + Import actions */}
        <div className="shrink-0 space-y-3">
          {seriesTypes.length > 0 && (
            <div className="mx-6 px-5 py-4 rounded-lg bg-white/[0.02] border border-white/10">
              <div className="flex items-center gap-2 mb-3">
                <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/40">
                  Type Routing
                </p>
                <span className="text-xs text-muted-foreground/30">— Route Sonarr series types into your libraries</span>
              </div>
              {libraryTypes.length > 0 ? (
              <div className="space-y-2.5 max-h-40 overflow-y-auto pr-1">
              {seriesTypes.map(st => {
                const currentLibId = sonarrTypeMapping[st] ?? '';
                return (
                  <div key={st} className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-2">
                    <div className="font-mono text-[10px] text-muted-foreground/40 shrink-0">SONARR</div>
                    <span className="text-sm font-mono text-muted-foreground/70 capitalize">{st}</span>
                    <div className="text-muted-foreground/40">→</div>
                    <Select
                      value={currentLibId}
                      onValueChange={(v) => {
                        setSonarrTypeMapping(prev => ({ ...prev, [st]: v }));
                      }}
                    >
                      <SelectTrigger className="h-8 w-40 text-sm">
                        <SelectValue placeholder="Choose library" />
                      </SelectTrigger>
                      <SelectContent>
                        {libraryTypes.map(lt => (
                          <SelectItem key={lt.id} value={lt.id}>
                            {lt.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
              </div>
              ) : (
                <p className="text-sm text-muted-foreground/40 italic">
                  Complete the Create Libraries step first
                </p>
              )}
            </div>
          )}
          <div className="px-6 pb-6 grid grid-cols-2 gap-3">
            <button
              onClick={() => startImport('background')}
              disabled={selectedIds.size === 0 || importing}
              className={cn(
                "flex flex-col items-center gap-2 p-4 rounded-xl border transition-all text-left",
                "bg-white/[0.02] border-white/10 hover:bg-white/[0.05] hover:border-white/20",
                "disabled:opacity-40 disabled:pointer-events-none",
              )}
            >
              <SparklesIcon className="size-5 text-signal" />
              <div>
                <p className="text-sm font-semibold">Import in background</p>
                <p className="text-xs text-muted-foreground mt-0.5">Continue configuring</p>
              </div>
            </button>
            <button
              onClick={() => startImport('watch')}
              disabled={selectedIds.size === 0 || importing}
              className={cn(
                "flex flex-col items-center gap-2 p-4 rounded-xl border transition-all text-left",
                "bg-white/[0.02] border-white/10 hover:bg-white/[0.05] hover:border-white/20",
                "disabled:opacity-40 disabled:pointer-events-none",
              )}
            >
              <EyeIcon className="size-5 text-signal" />
              <div>
                <p className="text-sm font-semibold">Watch import</p>
                <p className="text-xs text-muted-foreground mt-0.5">See each series imported</p>
              </div>
            </button>
          </div>
        </div>
      </div>

      <div className={cn(
        "mt-6 flex items-center justify-between transition-all duration-300",
        (sonarrPanelOpen || metaPanelOpen) && "opacity-0 pointer-events-none"
      )}>
        <button onClick={onSkip} className="text-xs text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors italic">
          Skip and set up manually
        </button>
        <Button variant="glass" onClick={onNext} disabled={!hasMetadataKey} className="gap-2 h-10 px-5 rounded-xl">
          {!hasMetadataKey ? "Enter a metadata provider key" : "Continue"}
          <ArrowRightIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
