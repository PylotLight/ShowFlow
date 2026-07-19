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
} from "lucide-react";
import type { StepProps } from "../types";

export function StepProviderKeys({ data, setData, onNext, onSkip }: StepProps) {
  const [testingProwlarr, setTestingProwlarr] = React.useState(false);
  const [prowlarrStatus, setProwlarrStatus] = React.useState<'idle' | 'ok' | 'fail'>('idle');
  const [prowlarrMsg, setProwlarrMsg] = React.useState("");

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
          value: {
            enabled: true,
            baseUrl: data.prowlarr.baseUrl,
            apiKey: data.prowlarr.apiKey,
            syncLevel: data.prowlarr.syncLevel,
            tags: [],
          },
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

  return (
    <div className="py-4">
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight mb-2">Provider Keys</h2>
        <p className="text-muted-foreground">
          Connect your indexer and download client so ShowFlow can find and grab releases.
        </p>
      </div>

      <div className="space-y-6">
        <div className={cn(
          "p-5 rounded-2xl border transition-all",
          prowlarrStatus === 'ok'
            ? "border-green-500/30 bg-green-500/[0.03]"
            : "border-white/10 bg-white/[0.02]"
        )}>
          <div className="flex items-center gap-3 mb-4">
            <CableIcon className="size-5 text-signal" />
            <div>
              <p className="text-sm font-semibold">Prowlarr (Indexer)</p>
              <p className="text-xs text-muted-foreground">
                Optional — needed for searching and grabbing releases
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">URL</p>
              <Input
                value={data.prowlarr.baseUrl}
                onChange={e => setData({ prowlarr: { ...data.prowlarr, baseUrl: e.target.value } })}
                placeholder="http://localhost:9696"
                className="font-mono"
              />
            </div>
            <div>
              <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">API Key</p>
              <Input
                value={data.prowlarr.apiKey}
                onChange={e => setData({ prowlarr: { ...data.prowlarr, apiKey: e.target.value } })}
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
                disabled={!data.prowlarr.baseUrl || !data.prowlarr.apiKey || testingProwlarr}
                className="gap-1.5"
              >
                {testingProwlarr ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <CableIcon className="size-3.5" />
                )}
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
        </div>

        <div className="p-5 rounded-2xl border border-white/10 bg-white/[0.02]">
          <div className="flex items-center gap-3 mb-4">
            <DownloadIcon className="size-5 text-signal" />
            <div>
              <p className="text-sm font-semibold">Download Client</p>
              <p className="text-xs text-muted-foreground">
                Optional — start downloading right away
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">Type</p>
              <Select
                value={data.downloadClient.type}
                onValueChange={(v) => setData({ downloadClient: { type: v as any, config: {} } })}
              >
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (set up later)</SelectItem>
                  <SelectItem value="blackhole">Blackhole</SelectItem>
                  <SelectItem value="torbox">TorBox</SelectItem>
                  <SelectItem value="sabnzbd">SABnzbd</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {data.downloadClient.type === 'blackhole' && (
              <div>
                <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">Output Folder</p>
                <Input
                  value={data.downloadClient.config.outputFolder ?? ''}
                  onChange={e => setData({ downloadClient: { ...data.downloadClient, config: { ...data.downloadClient.config, outputFolder: e.target.value } } })}
                  placeholder="/path/to/nzb/folder"
                  className="font-mono"
                />
              </div>
            )}
            {data.downloadClient.type === 'torbox' && (
              <div>
                <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">API Key</p>
                <Input
                  value={data.downloadClient.config.apiKey ?? ''}
                  onChange={e => setData({ downloadClient: { ...data.downloadClient, config: { ...data.downloadClient.config, apiKey: e.target.value } } })}
                  type="password"
                  className="font-mono"
                />
              </div>
            )}
            {data.downloadClient.type === 'sabnzbd' && (
              <div className="space-y-3">
                <div>
                  <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">URL</p>
                  <Input
                    value={data.downloadClient.config.url ?? ''}
                    onChange={e => setData({ downloadClient: { ...data.downloadClient, config: { ...data.downloadClient.config, url: e.target.value } } })}
                    placeholder="http://localhost:8080"
                    className="font-mono"
                  />
                </div>
                <div>
                  <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-1.5">API Key</p>
                  <Input
                    value={data.downloadClient.config.apiKey ?? ''}
                    onChange={e => setData({ downloadClient: { ...data.downloadClient, config: { ...data.downloadClient.config, apiKey: e.target.value } } })}
                    type="password"
                    className="font-mono"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

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
