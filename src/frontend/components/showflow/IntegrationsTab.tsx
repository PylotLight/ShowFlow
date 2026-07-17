import * as React from "react";
import { CheckIcon, XIcon, Loader2Icon, EyeIcon, EyeOffIcon } from "lucide-react";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Input } from "@frontend/components/ui/input";
import { Button } from "@frontend/components/ui/button";
import { Switch } from "@frontend/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { FieldRow } from "./SettingsShared";

export function IntegrationsTab({ sonarr, setSonarr, showSonarrKey, setShowSonarrKey, sonarrTesting, sonarrStatus, sonarrTestingFn, sonarrSeries, sonarrSeriesLoading, sonarrFetchSeries, sonarrImporting, sonarrImportResults, sonarrImportTotal, selectedSonarrSeries, setSelectedSonarrSeries, showProfilesList, qualityProfilesList, sonarrTypeConfig, setSonarrTypeConfig, sonarrTypesPresent, visibleSonarrSeries, sonarrImportFn, jellyfin, setJellyfin, showJellyfinKey, setShowJellyfinKey, jellyfinTesting, jellyfinStatus, jellyfinTestingFn, jellyfinSyncing, jellyfinSyncResult, jellyfinSyncFn, saveSonarr, }: {
  sonarr: any; setSonarr: any;
  showSonarrKey: boolean; setShowSonarrKey: (v: boolean) => void;
  sonarrTesting: boolean; sonarrStatus: any;
  sonarrTestingFn: () => void;
  sonarrSeries: any[] | null; sonarrSeriesLoading: boolean; sonarrFetchSeries: () => void;
  sonarrImporting: boolean; sonarrImportResults: any[]; sonarrImportTotal: number;
  selectedSonarrSeries: Set<number>; setSelectedSonarrSeries: (v: Set<number>) => void;
  showProfilesList: any[]; qualityProfilesList: any[];
  sonarrTypeConfig: Record<string, { included: boolean; showProfileId: string; qualityProfileId: string }>;
  setSonarrTypeConfig: (v: any) => void;
  sonarrTypesPresent: any[]; visibleSonarrSeries: any[];
  sonarrImportFn: () => void;
  jellyfin: any; setJellyfin: any;
  showJellyfinKey: boolean; setShowJellyfinKey: (v: boolean) => void;
  jellyfinTesting: boolean; jellyfinStatus: any; jellyfinTestingFn: () => void;
  jellyfinSyncing: boolean; jellyfinSyncResult: any; jellyfinSyncFn: () => void;
  saveSonarr: () => void;
}) {
  return (
    <>
      <GlassPanel className="p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Sonarr</h3>
            <p className="text-muted-foreground text-xs mt-0.5">Connect to Sonarr for series management and importing</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {sonarr.enabled ? 'Enabled' : 'Disabled'}
            </span>
            <Switch
              checked={sonarr.enabled}
              onCheckedChange={v => setSonarr((prev: any) => ({ ...prev, enabled: v }))}
            />
          </div>
        </div>
        {sonarr.enabled && (
        <>
          <FieldRow label="Sonarr URL" description="e.g. http://localhost:8989">
            <Input
              value={sonarr.baseUrl}
              onChange={e => setSonarr((prev: any) => ({ ...prev, baseUrl: e.target.value }))}
              placeholder="http://localhost:8989"
            />
          </FieldRow>
          <FieldRow label="API Key" description="Found in Sonarr Settings > General">
            <div className="relative">
              <Input
                type={showSonarrKey ? "text" : "password"}
                value={sonarr.apiKey}
                onChange={e => setSonarr((prev: any) => ({ ...prev, apiKey: e.target.value }))}
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
          <FieldRow label="API Version" description="Sonarr API version">
            <Select
              value={sonarr.apiVersion}
              onValueChange={v => setSonarr((prev: any) => ({ ...prev, apiVersion: v }))}
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
            <Button size="sm" onClick={saveSonarr}>
              Save Settings
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={sonarrTestingFn}
              disabled={sonarrTesting || !sonarr.baseUrl}
            >
              {sonarrTesting ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : null}
              Test Connection
            </Button>
          </div>
          {sonarrStatus && (
            <div className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs ${
              sonarrStatus.ok ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
            }`}>
              {sonarrStatus.ok ? <CheckIcon className="size-3.5 shrink-0" /> : <XIcon className="size-3.5 shrink-0" />}
              {sonarrStatus.message || (sonarrStatus.ok ? "Connected" : "Failed")}
            </div>
          )}

          {/* Import Series section - merged into the same panel */}
          <div className="pt-5 border-t border-white/5 space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-mono text-sm font-semibold text-white/90">Import Series from Sonarr</h4>
                <p className="text-muted-foreground text-xs mt-0.5">Select series to import into ShowFlow</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={sonarrFetchSeries}
                disabled={sonarrSeriesLoading}
              >
                {sonarrSeriesLoading ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : null}
                Fetch Series
              </Button>
            </div>

            {sonarrTypesPresent.length > 0 && (
              <div className="space-y-3 border border-white/5 rounded-lg p-4 bg-white/[0.02]">
                <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Series Type Mapping
                </p>
                {sonarrTypesPresent.map(([type, count]: [string, number]) => {
                  const tc = sonarrTypeConfig[type] || { included: true, showProfileId: "", qualityProfileId: "" };
                  return (
                    <div key={type} className="flex items-center gap-3">
                      <Switch
                        checked={tc.included}
                        onCheckedChange={v => setSonarrTypeConfig((prev: any) => ({ ...prev, [type]: { ...tc, included: v } }))}
                      />
                      <span className="font-mono text-sm min-w-[100px]">{type} ({count})</span>
                      <Select
                        value={tc.showProfileId}
                        onValueChange={v => setSonarrTypeConfig((prev: any) => ({ ...prev, [type]: { ...tc, showProfileId: v } }))}
                      >
                        <SelectTrigger className="w-36">
                          <SelectValue placeholder="Root folder" />
                        </SelectTrigger>
                        <SelectContent>
                          {showProfilesList.map((p: any) => (
                            <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={tc.qualityProfileId}
                        onValueChange={v => setSonarrTypeConfig((prev: any) => ({ ...prev, [type]: { ...tc, qualityProfileId: v } }))}
                      >
                        <SelectTrigger className="w-36">
                          <SelectValue placeholder="Quality profile" />
                        </SelectTrigger>
                        <SelectContent>
                          {qualityProfilesList.map((p: any) => (
                            <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  );
                })}
              </div>
            )}

            {sonarrSeries !== null && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    {visibleSonarrSeries.length} series
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        if (selectedSonarrSeries.size === visibleSonarrSeries.length) {
                          setSelectedSonarrSeries(new Set());
                        } else {
                          setSelectedSonarrSeries(new Set(visibleSonarrSeries.map((s: any) => s.id)));
                        }
                      }}
                    >
                      {selectedSonarrSeries.size === visibleSonarrSeries.length ? "Deselect All" : "Select All"}
                    </Button>
                    <Button
                      size="sm"
                      onClick={sonarrImportFn}
                      disabled={selectedSonarrSeries.size === 0 || sonarrImporting}
                    >
                      {sonarrImporting ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : null}
                      Import ({selectedSonarrSeries.size})
                    </Button>
                  </div>
                </div>

                {sonarrSeriesLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : !sonarrSeries || sonarrSeries.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Click "Fetch Series" to load available series.</p>
                ) : (
                  <div className="max-h-80 overflow-y-auto space-y-1">
                    {sonarrSeries.filter((s: any) => sonarrTypeConfig[s.seriesType || 'standard']?.included !== false).map((s: any) => (
                      <label key={s.id} className="flex items-center gap-3 rounded-lg px-4 py-2.5 bg-white/[0.03] cursor-pointer hover:bg-white/[0.05] transition-colors">
                        <input
                          type="checkbox"
                          checked={selectedSonarrSeries.has(s.id)}
                          onChange={e => {
                            const next = new Set(selectedSonarrSeries);
                            e.target.checked ? next.add(s.id) : next.delete(s.id);
                            setSelectedSonarrSeries(next);
                          }}
                          className="rounded border-white/20"
                        />
                        <span className="font-mono text-sm flex-1">{s.title}</span>
                        <span className="text-muted-foreground font-mono text-caption">{s.year}</span>
                        <span className="text-muted-foreground font-mono text-caption uppercase">{s.seriesType || 'standard'}</span>
                      </label>
                    ))}
                  </div>
                )}

                {sonarrImportResults.length > 0 && (
                  <div className="rounded-lg bg-white/[0.03] p-3 space-y-1.5 max-h-40 overflow-y-auto">
                    <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      Import Results ({sonarrImportResults.length})
                    </p>
                    {sonarrImportResults.map((r, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        {r.status === 'imported' && <CheckIcon className="size-3 text-emerald-400 shrink-0" />}
                        {r.status === 'existing' && <span className="size-3 shrink-0 text-muted-foreground">•</span>}
                        {r.status === 'error' && <XIcon className="size-3 text-red-400 shrink-0" />}
                        <span className="font-mono truncate">{r.title || r.sonarrTitle}</span>
                        <span className="text-muted-foreground shrink-0">{r.status}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
        )}
      </GlassPanel>

      <GlassPanel className="p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Jellyfin</h3>
            <p className="text-muted-foreground text-xs mt-0.5">Sync watched state from Jellyfin to ShowFlow</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {jellyfin.enabled ? 'Enabled' : 'Disabled'}
            </span>
            <Switch
              checked={jellyfin.enabled}
              onCheckedChange={v => setJellyfin((prev: any) => ({ ...prev, enabled: v }))}
            />
          </div>
        </div>
        {jellyfin.enabled && (
        <>
          <FieldRow label="Jellyfin URL" description="e.g. http://localhost:8096">
            <Input
              value={jellyfin.baseUrl}
              onChange={e => setJellyfin((prev: any) => ({ ...prev, baseUrl: e.target.value }))}
              placeholder="http://localhost:8096"
            />
          </FieldRow>
          <FieldRow label="API Key" description="Found in Jellyfin Dashboard > API Keys">
            <div className="relative">
              <Input
                type={showJellyfinKey ? "text" : "password"}
                value={jellyfin.apiKey}
                onChange={e => setJellyfin((prev: any) => ({ ...prev, apiKey: e.target.value }))}
                placeholder="Jellyfin API key"
              />
              <button
                type="button"
                onClick={() => setShowJellyfinKey(!showJellyfinKey)}
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
              >
                {showJellyfinKey ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
              </button>
            </div>
          </FieldRow>
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" onClick={() => {
              fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ key: "jellyfin", value: jellyfin }),
              }).then(() => {});
            }}>
              Save Settings
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={jellyfinTestingFn}
              disabled={jellyfinTesting || !jellyfin.baseUrl}
            >
              {jellyfinTesting ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : null}
              Test Connection
            </Button>
          </div>
          {jellyfinStatus && (
            <div className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs ${
              jellyfinStatus.ok ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
            }`}>
              {jellyfinStatus.ok ? <CheckIcon className="size-3.5 shrink-0" /> : <XIcon className="size-3.5 shrink-0" />}
              {jellyfinStatus.message || (jellyfinStatus.ok ? "Connected" : "Failed")}
            </div>
          )}
          <div className="pt-3 border-t border-white/5">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-mono text-sm font-semibold text-white/90">Sync Watched State</h4>
                <p className="text-muted-foreground text-xs mt-0.5">Pull episode play states from Jellyfin</p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="default"
                  size="sm"
                  onClick={jellyfinSyncFn}
                  disabled={jellyfinSyncing}
                >
                  {jellyfinSyncing ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : null}
                  Run Sync
                </Button>
              </div>
            </div>
            {jellyfinSyncResult && (
              <p className="text-xs text-muted-foreground mt-2">
                Matched {jellyfinSyncResult.matchedEpisodes || 0} / {jellyfinSyncResult.totalEpisodes || 0} episodes
                {jellyfinSyncResult.errors?.length ? ` (${jellyfinSyncResult.errors.length} errors)` : ""}
              </p>
            )}
          </div>
        </>
        )}
      </GlassPanel>
    </>
  );
}
