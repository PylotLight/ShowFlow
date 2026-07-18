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
  TvIcon,
  SearchIcon,
  ImportIcon,
  EyeIcon,
  SparklesIcon,
} from "lucide-react";
import { SonarrImportProgress } from "@frontend/components/showflow/SonarrImportProgress";
import type { StepProps, SonarrSeries } from "../types";

export function StepSonarrConnect({ data, setData, onNext, onSkip }: StepProps) {
  const [testing, setTesting] = React.useState(false);
  const [testStatus, setTestStatus] = React.useState<'idle' | 'ok' | 'fail'>('idle');
  const [testMsg, setTestMsg] = React.useState("");
  const [fetching, setFetching] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<number>>(new Set());

  const { sonarr } = data;

  const saveConfig = async () => {
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

  const testConnection = async () => {
    setTesting(true);
    setTestStatus('idle');
    setTestMsg("");
    try {
      await saveConfig();
      const res = await fetch("/api/sonarr/test");
      const d = await res.json();
      if (d.ok) { setTestStatus('ok'); setTestMsg("Sonarr connected"); }
      else { setTestStatus('fail'); setTestMsg(d.message ?? "Test failed"); }
    } catch { setTestStatus('fail'); setTestMsg("Connection error"); }
    finally { setTesting(false); }
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

  if (sonarr.importJobId && sonarr.importForkMode === 'watch') {
    return (
      <div className="py-4">
        <div className="mb-8">
          <h2 className="text-2xl font-bold tracking-tight mb-2">Importing Series</h2>
          <p className="text-muted-foreground">
            Your series are being imported from Sonarr.
          </p>
        </div>
        <SonarrImportProgress jobId={sonarr.importJobId} onDone={onNext} />
      </div>
    );
  }

  return (
    <div className="py-4">
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight mb-2">Sonarr Connect</h2>
        <p className="text-muted-foreground">
          Connect your Sonarr instance, fetch your series list, and import them
          into ShowFlow.
        </p>
      </div>

      <div className={cn(
        "p-5 rounded-2xl border transition-all",
        testStatus === 'ok'
          ? "border-green-500/30 bg-green-500/[0.03]"
          : "border-white/10 bg-white/[0.02]"
      )}>
        <div className="space-y-3">
          <div>
            <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">Sonarr URL</p>
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
                onClick={testConnection}
                disabled={!sonarr.baseUrl || !sonarr.apiKey || testing}
                className="gap-1.5"
              >
                {testing ? <Loader2Icon className="size-3.5 animate-spin" /> : <TvIcon className="size-3.5" />}
                Test
              </Button>
            </div>
            {testStatus === 'ok' && (
              <span className="flex items-center gap-1 text-xs text-green-400 pt-5">
                <CheckCircleIcon className="size-3.5" /> Connected
              </span>
            )}
            {testStatus === 'fail' && (
              <span className="flex items-center gap-1 text-xs text-red-400 pt-5">
                <XCircleIcon className="size-3.5" /> {testMsg}
              </span>
            )}
          </div>
        </div>
      </div>

      {testStatus === 'ok' && !sonarr.tested && (
        <div className="mt-4">
          <Button
            variant="outline"
            onClick={fetchSeries}
            disabled={fetching}
            className="gap-2 w-full h-12 rounded-xl"
          >
            {fetching ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <SearchIcon className="size-4" />
            )}
            Fetch series from Sonarr
          </Button>
        </div>
      )}

      {sonarr.series.length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60">
              {sonarr.series.length} series found
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelectedIds(new Set(sonarr.series.map(s => s.id)))}
                className="text-xs"
              >
                Select all
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelectedIds(new Set())}
                className="text-xs"
              >
                Clear
              </Button>
            </div>
          </div>

          <div className="max-h-48 overflow-y-auto space-y-0.5 rounded-xl border border-white/10">
            {sonarr.series.map(s => (
              <button
                key={s.id}
                onClick={() => toggleSeries(s.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-2 text-sm transition-colors text-left",
                  selectedIds.has(s.id) ? "bg-signal/[0.04]" : "hover:bg-white/[0.02]"
                )}
              >
                <div className={cn(
                  "size-4 rounded border flex items-center justify-center shrink-0 transition-colors",
                  selectedIds.has(s.id)
                    ? "bg-signal border-signal"
                    : "border-white/20"
                )}>
                  {selectedIds.has(s.id) && (
                    <CheckCircleIcon className="size-3 text-white" />
                  )}
                </div>
                <span className="flex-1 truncate">{s.title}</span>
                <span className="text-xs text-muted-foreground/50">{s.year}</span>
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3 mt-4">
            <button
              onClick={() => startImport('background')}
              disabled={selectedIds.size === 0 || importing}
              className={cn(
                "flex flex-col items-center gap-2 p-5 rounded-xl border transition-all text-left",
                "bg-white/[0.02] border-white/10 hover:bg-white/[0.05] hover:border-white/20",
                "disabled:opacity-40 disabled:pointer-events-none",
              )}
            >
              <SparklesIcon className="size-6 text-signal" />
              <div>
                <p className="text-sm font-semibold">Import in background</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Start importing and continue configuring
                </p>
              </div>
            </button>
            <button
              onClick={() => startImport('watch')}
              disabled={selectedIds.size === 0 || importing}
              className={cn(
                "flex flex-col items-center gap-2 p-5 rounded-xl border transition-all text-left",
                "bg-white/[0.02] border-white/10 hover:bg-white/[0.05] hover:border-white/20",
                "disabled:opacity-40 disabled:pointer-events-none",
              )}
            >
              <EyeIcon className="size-6 text-signal" />
              <div>
                <p className="text-sm font-semibold">Watch import progress</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Wait here and see each series imported
                </p>
              </div>
            </button>
          </div>
        </div>
      )}

      <div className="mt-8 flex items-center justify-between">
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
