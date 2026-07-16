import { EyeIcon, EyeOffIcon, CheckIcon, XIcon, Loader2Icon, ExternalLinkIcon } from "lucide-react";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Input } from "@frontend/components/ui/input";
import { Button } from "@frontend/components/ui/button";
import { Switch } from "@frontend/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { FieldRow, cn } from "./SettingsShared";

export function IndexersTab({ prowlarr, setProwlarr, saveProwlarr, saveProwlarrWithDefaults, testProwlarr, prowlarrTesting, prowlarrStatus, loadIndexers, indexers, indexersLoading, showProwlarrKey, setShowProwlarrKey, nativeIndexers, nativeMeta, nativeSaving, nativeTesting, nativeStatuses, toggleNativeIndexer, updateNativeBaseUrl, testNativeIndexer, saving }: {
  prowlarr: any;
  setProwlarr: any;
  saveProwlarr: () => void;
  saveProwlarrWithDefaults: (overrides: any) => void;
  testProwlarr: () => void;
  prowlarrTesting: boolean;
  prowlarrStatus: any;
  loadIndexers: () => void;
  indexers: any[] | null;
  indexersLoading: boolean;
  showProwlarrKey: boolean;
  setShowProwlarrKey: (v: boolean) => void;
  nativeIndexers: any[];
  nativeMeta: any[];
  nativeSaving: boolean;
  nativeTesting: Record<string, boolean>;
  nativeStatuses: Record<string, { ok: boolean; message?: string }>;
  toggleNativeIndexer: (id: string, enabled: boolean) => void;
  updateNativeBaseUrl: (id: string, baseUrl: string) => void;
  testNativeIndexer: (id: string) => void;
  saving: string | null;
}) {
  return (
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
                setProwlarr((prev: any) => {
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
            onChange={e => setProwlarr((prev: any) => ({ ...prev, baseUrl: e.target.value }))}
            placeholder="http://localhost:9696"
          />
        </FieldRow>
        <FieldRow label="API Key" description="Found in Prowlarr Settings > General">
          <div className="relative">
            <Input
              type={showProwlarrKey ? "text" : "password"}
              value={prowlarr.apiKey}
              onChange={e => setProwlarr((prev: any) => ({ ...prev, apiKey: e.target.value }))}
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
            onValueChange={v => setProwlarr((prev: any) => ({ ...prev, syncLevel: v }))}
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
              {indexers.map((ix: any) => (
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
          {nativeMeta.map((meta: any) => {
            const cfg = nativeIndexers.find((n: any) => n.id === meta.id);
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
  );
}
