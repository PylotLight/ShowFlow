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

  const { sonarr, prowlarr, downloadClient } = data;

  // Watch-mode import takes over the page
  if (sonarr.importJobId && sonarr.importForkMode === 'watch') {
    return (
      <div className="py-4">
        <div className="mb-8">
          <h2 className="text-2xl font-bold tracking-tight mb-2">Importing Series</h2>
          <p className="text-muted-foreground">Your series are being imported from Sonarr.</p>
        </div>
        <SonarrImportProgress jobId={sonarr.importJobId} onDone={onNext} />
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
      const res = await fetch("/api/sonarr/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seriesIds: ids, typeMapping: { default: data.libraryTypeId ?? 'standard' } }),
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
      "py-4 transition-all duration-300",
      sonarrPanelOpen && "-translate-x-[260px]"
    )}>
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight mb-2">Integrations</h2>
        <p className="text-muted-foreground">
          Connect the services ShowFlow integrates with. Each one is optional —
          enable and configure what you need.
        </p>
      </div>

      <div className="space-y-4">

        {/* ├─ Prowlarr ─────────────────────────────────────────── */}
        <div className={cn(
          "p-5 rounded-2xl border transition-all",
          prowlarrStatus === 'ok'
            ? "border-green-500/30 bg-green-500/[0.03]"
            : "border-white/10 bg-white/[0.02]"
        )}>
          <button
            onClick={() => setProwlarrEnabled(!prowlarrEnabled)}
            className="flex items-center gap-3 w-full text-left mb-1"
          >
            <div className={cn(
              "size-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors",
              prowlarrEnabled ? "bg-signal border-signal" : "border-white/20"
            )}>
              {prowlarrEnabled && <CheckCircleIcon className="size-3.5 text-white" />}
            </div>
            <CableIcon className={cn("size-5", prowlarrEnabled ? "text-signal" : "text-muted-foreground/40")} />
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
            <div className="mt-4 space-y-3 pl-10">
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
          "p-5 rounded-2xl border transition-all",
          sonarrStatus === 'ok'
            ? "border-green-500/30 bg-green-500/[0.03]"
            : "border-white/10 bg-white/[0.02]"
        )}>
          <button
            onClick={() => { setSonarrEnabled(!sonarrEnabled); if (!sonarrEnabled) setSonarrStatus('idle'); }}
            className="flex items-center gap-3 w-full text-left mb-1"
          >
            <div className={cn(
              "size-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors",
              sonarrEnabled ? "bg-signal border-signal" : "border-white/20"
            )}>
              {sonarrEnabled && <CheckCircleIcon className="size-3.5 text-white" />}
            </div>
            <TvIcon className={cn("size-5", sonarrEnabled ? "text-signal" : "text-muted-foreground/40")} />
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
            <div className="mt-4 space-y-3 pl-10">
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
        <div className="p-5 rounded-2xl border border-white/10 bg-white/[0.02]">
          <button
            onClick={() => { setDcEnabled(!dcEnabled); if (!dcEnabled) setData({ downloadClient: { type: 'none', config: {} } }); }}
            className="flex items-center gap-3 w-full text-left mb-1"
          >
            <div className={cn(
              "size-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors",
              dcEnabled ? "bg-signal border-signal" : "border-white/20"
            )}>
              {dcEnabled && <CheckCircleIcon className="size-3.5 text-white" />}
            </div>
            <DownloadIcon className={cn("size-5", dcEnabled ? "text-signal" : "text-muted-foreground/40")} />
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
            <div className="mt-4 space-y-3 pl-10">
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

      {/* Slide-out Sonarr import manager panel */}
      <div
        className={cn(
          "fixed right-0 top-0 h-full w-[520px] z-50 bg-[#15181f] border-l border-white/10 shadow-2xl flex flex-col transition-transform duration-300 ease-out",
          sonarrPanelOpen ? "translate-x-0" : "translate-x-full"
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
        <div className="px-6 py-4 shrink-0">
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

        {/* Series list */}
        <div className="flex-1 overflow-y-auto px-6 pb-4 space-y-0.5">
          {sonarr.series.map(s => (
            <button
              key={s.id}
              onClick={() => toggleSeries(s.id)}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm transition-colors text-left",
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

        {/* Import actions */}
        <div className="px-6 py-4 border-t border-white/5 shrink-0 space-y-3">
          {data.rootFolders.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-mono font-bold uppercase tracking-widest text-muted-foreground/40">Type mapping</p>
              {data.rootFolders.map(folder => (
                <div key={folder} className="flex items-center gap-2 text-xs font-mono text-muted-foreground/60">
                  <span className="truncate flex-1">{folder.split('/').pop()}</span>
                  <span className="text-signal shrink-0">{data.libraryTypeId ?? 'Standard'}</span>
                </div>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
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
        "mt-8 flex items-center justify-between transition-all duration-300",
        sonarrPanelOpen && "opacity-0 pointer-events-none"
      )}>
        <button onClick={onSkip} className="text-xs text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors italic">
          Skip and set up manually
        </button>
        <Button variant="glass" onClick={onNext} className="gap-2 h-11 px-6 rounded-xl">
          Continue
          <ArrowRightIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
