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
  DownloadIcon,
  TvIcon,
  SearchIcon,
  EyeIcon,
  SparklesIcon,
} from "lucide-react";
import { SonarrImportProgress } from "@frontend/components/showflow/SonarrImportProgress";
import type { StepProps, SonarrSeries } from "../types";

export function StepIntegrations({ data, setData, onNext, onSkip }: StepProps) {
  const [prowlarrEnabled, setProwlarrEnabled] = React.useState(!!data.prowlarr.baseUrl);
  const [testingProwlarr, setTestingProwlarr] = React.useState(false);
  const [prowlarrStatus, setProwlarrStatus] = React.useState<'idle' | 'ok' | 'fail'>('idle');
  const [prowlarrMsg, setProwlarrMsg] = React.useState("");

  const [sonarrEnabled, setSonarrEnabled] = React.useState(!!data.sonarr.baseUrl);
  const [testingSonarr, setTestingSonarr] = React.useState(false);
  const [sonarrStatus, setSonarrStatus] = React.useState<'idle' | 'ok' | 'fail'>('idle');
  const [sonarrMsg, setSonarrMsg] = React.useState("");

  const [dcEnabled, setDcEnabled] = React.useState(data.downloadClient.type !== 'none');
  const [sonarrPanelOpen, setSonarrPanelOpen] = React.useState(false);
  const [fetching, setFetching] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<number>>(new Set());
  const [libraryTypes, setLibraryTypes] = React.useState<{ id: string; name: string; is_default?: boolean }[]>([]);

  const { sonarr, prowlarr, downloadClient } = data;

  // Per-folder type mapping (rootFolder -> libraryTypeId)
  const [typeMapping, setTypeMapping] = React.useState<Record<string, string>>({});

  // Load library types on mount
  React.useEffect(() => {
    fetch("/api/library-types").then(res => res.json()).then(setLibraryTypes).catch(() => {});
  }, []);

  // Seed new folders only; never reset existing selections
  React.useEffect(() => {
    const defaultId = data.libraryTypeId ?? (libraryTypes.find(lt => lt.is_default) ?? libraryTypes[0])?.id ?? '';
    setTypeMapping(prev => {
      const next = { ...prev };
      let changed = false;
      for (const folder of data.rootFolders) {
        if (!next[folder]) { next[folder] = defaultId; changed = true; }
      }
      // Remove entries for folders that no longer exist
      for (const key of Object.keys(next)) {
        if (!data.rootFolders.includes(key)) { delete next[key]; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [data.rootFolders, data.libraryTypeId, libraryTypes.length]);

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
      const mapping: Record<string, string> = {};
      data.rootFolders.forEach(folder => {
        mapping[folder] = typeMapping[folder] ?? data.libraryTypeId ?? 'standard';
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
    <div className={cn(
      "relative py-2 transition-transform duration-300 ease-out",
      sonarrPanelOpen && "-translate-x-[218px]"
    )}>
      <div className="mb-6">
        <h2 className="text-xl font-bold tracking-tight mb-1">Integrations</h2>
        <p className="text-sm text-muted-foreground">
          Connect the services ShowFlow integrates with. Each one is optional —
          enable and configure what you need.
        </p>
      </div>

      <div className="space-y-3">

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
          sonarrStatus === 'ok'
            ? "border-green-500/30 bg-green-500/[0.03]"
            : "border-white/10 bg-white/[0.02]"
        )}>
          <button
            onClick={() => { setSonarrEnabled(!sonarrEnabled); if (!sonarrEnabled) setSonarrStatus('idle'); }}
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
                Sync your existing series and imports
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

      {/* Slide-out Sonarr import manager panel — docked to the right edge of this
          card (not the browser viewport), so it opens up right where the card
          slides away from, and its height is capped so it can never run below
          the viewport. */}
      <div
        className={cn(
          "absolute left-full top-0 ml-4 w-[420px] max-h-[min(680px,85vh)] z-50",
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
              <p className="text-xs text-muted-foreground">{sonarr.series.length} series from {sonarr.baseUrl || "Sonarr"}</p>
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
                {sonarr.series.length} series found
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set(sonarr.series.map(s => s.id)))} className="text-xs">
                  Select all
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())} className="text-xs">
                  Clear
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Series list — flexes to fill whatever space is left between the
            header/fetch row above and the type-mapping/import actions below,
            so it scrolls internally instead of pushing the panel taller than
            its capped max-height. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-3 space-y-0.5">
          {sonarr.series.map(s => (
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
          {sonarr.tested && sonarr.series.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">No series found</div>
          )}
        </div>

        {/* Type mapping + Import actions */}
        <div className="shrink-0 space-y-3">
          {data.rootFolders.length > 0 && (
            <div className="mx-6 px-4 py-3 rounded-lg bg-white/[0.02] border border-white/10">
              <p className="text-[10px] font-mono font-bold uppercase tracking-widest text-muted-foreground/40 mb-2">
                Type mapping
              </p>
              {libraryTypes.length > 0 ? (
              <div className="space-y-2 max-h-32 overflow-y-auto pr-1">
              {data.rootFolders.map(folder => {
                const folderName = folder.split('/').pop() ?? folder;
                const currentTypeId = typeMapping[folder];
                return (
                  <div key={folder} className="flex items-center gap-3">
                    <span className="text-xs font-mono text-muted-foreground/60 truncate flex-1">
                      {folderName}
                    </span>
                    <Select
                      value={currentTypeId}
                      onValueChange={(v) => {
                        setTypeMapping(prev => ({ ...prev, [folder]: v }));
                      }}
                    >
                      <SelectTrigger className="h-7 w-36 text-xs">
                        <SelectValue />
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
                <p className="text-xs text-muted-foreground/40 italic">
                  Complete the Library & Quality step first
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
        sonarrPanelOpen && "opacity-0 pointer-events-none"
      )}>
        <button onClick={onSkip} className="text-xs text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors italic">
          Skip and set up manually
        </button>
        <Button variant="glass" onClick={onNext} className="gap-2 h-10 px-5 rounded-xl">
          Continue
          <ArrowRightIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
