import { ExternalLinkIcon, HardDriveIcon, Loader2Icon, SettingsIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@frontend/components/ui/button";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { cn } from "@frontend/lib/utils";

interface NativeMeta {
  id: string;
  name: string;
  protocol: string;
  privacy: string;
  description: string;
  defaultUrl: string;
}

interface NativeStatus {
  id: string;
  name: string;
  ok: boolean;
  message?: string;
}

function StatusDot({ state }: { state: "ok" | "fail" | "off" | "loading" }) {
  if (state === "loading") return <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />;
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        state === "ok" && "bg-emerald-400 shadow-[0_0_6px_theme(colors.emerald.400)]",
        state === "fail" && "bg-red-400",
        state === "off" && "bg-white/20",
      )}
    />
  );
}

function SourcesPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [prowlarrEnabled, setProwlarrEnabled] = React.useState<boolean | null>(null);
  const [prowlarrStatus, setProwlarrStatus] = React.useState<{ ok: boolean; message?: string } | null>(null);
  const [prowlarrIndexers, setProwlarrIndexers] = React.useState<any[] | null>(null);
  const [nativeMeta, setNativeMeta] = React.useState<NativeMeta[]>([]);
  const [nativeConfigs, setNativeConfigs] = React.useState<any[]>([]);
  const [nativeStatuses, setNativeStatuses] = React.useState<Record<string, NativeStatus>>({});
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    Promise.all([
      fetch("/api/settings").then((r) => r.json()).catch(() => []),
      fetch("/api/indexers/native/meta").then((r) => r.json()).catch(() => []),
    ]).then(([settings, meta]) => {
      const prowlarrRaw = settings.find((s: any) => s.key === "prowlarr");
      let enabled = false;
      if (prowlarrRaw) {
        try {
          const p = JSON.parse(prowlarrRaw.value);
          enabled = p.enabled !== false && !!p.baseUrl;
        } catch {}
      }
      setProwlarrEnabled(enabled);

      const nativeRaw = settings.find((s: any) => s.key === "nativeIndexers");
      if (nativeRaw) {
        try { setNativeConfigs(JSON.parse(nativeRaw.value)); } catch {}
      }
      setNativeMeta(Array.isArray(meta) ? meta : []);
      setLoading(false);

      if (enabled) {
        fetch("/api/indexers/prowlarr/status").then((r) => r.json()).then(setProwlarrStatus).catch(() => setProwlarrStatus({ ok: false, message: "Connection failed" }));
        fetch("/api/indexers/prowlarr/indexers").then((r) => r.json()).then((res) => setProwlarrIndexers(Array.isArray(res) ? res : [])).catch(() => setProwlarrIndexers([]));
      }
    });

    fetch("/api/indexers/native/status")
      .then((r) => r.json())
      .then((results: NativeStatus[]) => {
        const map: Record<string, NativeStatus> = {};
        for (const r of results) map[r.id] = r;
        setNativeStatuses(map);
      })
      .catch(() => {});
  }, []);

  const enabledNative = nativeMeta.filter((m) => nativeConfigs.find((c) => c.id === m.id)?.enabled);
  const activeSourceCount = (prowlarrEnabled ? 1 : 0) + enabledNative.length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <GlassPanel className="flex items-center justify-between p-5">
        <div className="flex items-center gap-3">
          <HardDriveIcon className="size-5 text-signal" />
          <div>
            <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-signal">// Sources</span>
            <h2 className="font-display text-2xl font-bold text-white">
              {activeSourceCount} indexer{activeSourceCount !== 1 ? "s" : ""} active
            </h2>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={onOpenSettings}>
          <SettingsIcon className="size-3.5" />
          Configure
        </Button>
      </GlassPanel>

      {activeSourceCount === 0 && (
        <GlassPanel className="p-8 text-center">
          <HardDriveIcon className="size-8 text-muted-foreground mx-auto mb-3" />
          <h3 className="font-display text-lg font-bold text-white mb-1">No sources configured</h3>
          <p className="text-muted-foreground text-sm mb-4">
            Connect Prowlarr or enable a native indexer to start finding releases.
          </p>
          <Button size="sm" onClick={onOpenSettings}>
            <SettingsIcon className="size-3.5" />
            Configure Sources
          </Button>
        </GlassPanel>
      )}

      {/* Prowlarr */}
      {prowlarrEnabled && (
        <GlassPanel className="overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/5">
            <div className="flex items-center gap-2.5">
              <StatusDot state={prowlarrStatus === null ? "loading" : prowlarrStatus.ok ? "ok" : "fail"} />
              <div>
                <h3 className="font-display text-base font-semibold text-white">Prowlarr</h3>
                <p className="text-muted-foreground text-xs">{prowlarrStatus?.message ?? (prowlarrStatus === null ? "Checking connection…" : "")}</p>
              </div>
            </div>
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {prowlarrIndexers === null ? "" : `${prowlarrIndexers.length} indexer${prowlarrIndexers.length !== 1 ? "s" : ""}`}
            </span>
          </div>
          {prowlarrIndexers === null ? (
            <div className="flex items-center justify-center py-8">
              <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : prowlarrIndexers.length === 0 ? (
            <p className="text-muted-foreground text-sm px-5 py-6 text-center">No indexers found via Prowlarr.</p>
          ) : (
            <div className="divide-y divide-white/5">
              {prowlarrIndexers.map((ix) => (
                <div key={ix.id} className="flex items-center gap-3 px-5 py-2.5">
                  <span className={cn("size-1.5 shrink-0 rounded-full", ix.enabled ? "bg-emerald-400" : "bg-muted-foreground/40")} />
                  <span className="font-mono flex-1 text-sm text-white/85 truncate">{ix.name}</span>
                  <span className="text-muted-foreground text-caption font-mono uppercase tracking-wider">{ix.protocol}</span>
                  <span className="text-muted-foreground text-caption font-mono uppercase tracking-wider">{ix.privacy}</span>
                </div>
              ))}
            </div>
          )}
        </GlassPanel>
      )}

      {/* Native indexers */}
      {enabledNative.length > 0 && (
        <GlassPanel className="overflow-hidden">
          <div className="px-5 py-3.5 border-b border-white/5">
            <h3 className="font-display text-base font-semibold text-white">Native Indexers</h3>
            <p className="text-muted-foreground text-xs mt-0.5">Built-in trackers — no Prowlarr required</p>
          </div>
          <div className="divide-y divide-white/5">
            {enabledNative.map((meta) => {
              const status = nativeStatuses[meta.id];
              return (
                <div key={meta.id} className="flex items-center gap-3 px-5 py-3">
                  <StatusDot state={!status ? "loading" : status.ok ? "ok" : "fail"} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-medium text-white/90">{meta.name}</span>
                      <span className="text-muted-foreground text-caption font-mono uppercase tracking-wider">{meta.protocol}</span>
                    </div>
                    {status?.message && (
                      <p className={cn("text-xs mt-0.5", status.ok ? "text-muted-foreground" : "text-red-400")}>{status.message}</p>
                    )}
                  </div>
                  <a
                    href={meta.defaultUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted-foreground hover:text-foreground transition-colors p-1.5"
                    title={`Open ${meta.name}`}
                  >
                    <ExternalLinkIcon className="size-3.5" />
                  </a>
                </div>
              );
            })}
          </div>
        </GlassPanel>
      )}
    </div>
  );
}

export { SourcesPage };
