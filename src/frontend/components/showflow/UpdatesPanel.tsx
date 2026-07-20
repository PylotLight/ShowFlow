import * as React from "react";
import { Loader2Icon, RefreshCwIcon, DownloadIcon } from "lucide-react";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Button } from "@frontend/components/ui/button";

export function UpdatesPanel() {
  const [token, setToken] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<any>(null);
  const [releases, setReleases] = React.useState<any[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [actionLoading, setActionLoading] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [installedReleaseId, setInstalledReleaseId] = React.useState<string | null>(null);
  const pageRef = React.useRef(1);

  function headers(): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  function fetchAll() {
    setLoading(true);
    setErr(null);
    pageRef.current = 1;
    Promise.all([
      fetch("/api/admin/updates/status", { headers: headers() }).then(r => r.ok ? r.json() : Promise.reject(r.status)),
      fetch("/api/admin/updates/available?page=1", { headers: headers() }).then(r => r.ok ? r.json() : { releases: [], hasMore: false }),
    ])
      .then(([s, a]) => { setStatus(s); setReleases(a.releases ?? []); setHasMore(a.hasMore ?? false); })
      .catch(e => setErr(String(e)))
      .finally(() => setLoading(false));
  }

  async function loadMore() {
    setLoadingMore(true);
    setErr(null);
    const next = pageRef.current + 1;
    try {
      const res = await fetch(`/api/admin/updates/available?page=${next}`, { headers: headers() });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const a = await res.json();
      setReleases(prev => [...prev, ...(a.releases ?? [])]);
      setHasMore(a.hasMore ?? false);
      pageRef.current = next;
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  React.useEffect(() => {
    fetch("/api/admin/token")
      .then(r => r.json())
      .then(d => { setToken(d.token); fetchAll(); })
      .catch(e => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function doInstall(githubReleaseId: number) {
    setActionLoading(`install-${githubReleaseId}`);
    setErr(null);
    setInstalledReleaseId(null);
    try {
      const res = await fetch("/api/admin/updates/install", {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify({ githubReleaseId }),
      });
      const data = await res.json();
      if (!data.ok) { setErr(data.message || "Install failed"); return; }
      if (data.releaseId) setInstalledReleaseId(data.releaseId);
      fetchAll();
    } catch (e) { setErr(String(e)); }
    finally { setActionLoading(null); }
  }

  async function doActivate(releaseId: string) {
    setActionLoading(`activate-${releaseId}`);
    setErr(null);
    try {
      const { markPendingRelease, clearPendingRelease } = await import("@frontend/register-sw");
      markPendingRelease(releaseId);
      const res = await fetch("/api/admin/updates/activate", {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify({ releaseId }),
      });
      const data = await res.json();
      if (data.timedOut) return;
      if (!data.ok) { setErr(data.message || "Activation failed"); clearPendingRelease(); }
    } catch {
      // Connection dropped = supervisor is quiescing (killing this process).
      // Activation is proceeding normally — the SW offline page handles reconnection.
    }
    finally { setActionLoading(null); }
  }

  return (
    <div className="space-y-6">
      <GlassPanel className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Update Status</h3>
            <p className="text-muted-foreground text-xs mt-0.5">Current state from the supervisor</p>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={fetchAll} disabled={loading}>
              <RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
        {status && (
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-white/[0.03] p-3 border border-white/5">
              <span className="font-mono text-[10px] text-white/60">Active</span>
              <p className="font-mono text-xs text-white/90 mt-0.5">{status.activeReleaseId ? status.activeReleaseId.slice(0, 12) : "—"}</p>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-3 border border-white/5">
              <span className="font-mono text-[10px] text-white/60">Phase</span>
              <p className="font-mono text-xs text-signal mt-0.5 capitalize">{status.phase || "—"}</p>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-3 border border-white/5">
              <span className="font-mono text-[10px] text-white/60">App Version</span>
              <p className="font-mono text-xs text-white/90 mt-0.5">{status.appVersion || "—"}</p>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-3 border border-white/5">
              <span className="font-mono text-[10px] text-white/60">lastKnownGood</span>
              <p className="font-mono text-xs text-white/90 mt-0.5">{status.lastKnownGood ? status.lastKnownGood.slice(0, 12) : "—"}</p>
            </div>
          </div>
        )}
        {!status && !loading && (
          <div className="rounded-lg bg-white/[0.03] p-4 border border-dashed border-white/10 text-center">
            <p className="font-mono text-xs text-muted-foreground">Could not reach supervisor status</p>
          </div>
        )}
        {installedReleaseId && (
          <div className="rounded-lg bg-signal/10 border border-signal/30 p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-signal font-medium">Release installed</p>
              <p className="font-mono text-[10px] text-white/60 mt-0.5">{installedReleaseId}</p>
            </div>
            <Button
              variant="default"
              size="sm"
              disabled={actionLoading !== null}
              onClick={() => doActivate(installedReleaseId)}
            >
              {actionLoading === `activate-${installedReleaseId}` ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                "Activate"
              )}
            </Button>
          </div>
        )}
      </GlassPanel>

      {err && (
        <div className="rounded-lg bg-red-900/20 border border-red-500/30 p-3">
          <p className="font-mono text-xs text-red-400">{err}</p>
        </div>
      )}

      <GlassPanel className="p-6 space-y-4">
        <div>
          <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Available Releases</h3>
          <p className="text-muted-foreground text-xs mt-0.5">Published GitHub releases with showflow + manifest.json assets</p>
        </div>
        {loading && (
          <div className="flex items-center justify-center py-6">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {!loading && releases.length === 0 && (
          <div className="rounded-lg bg-white/[0.03] p-4 border border-dashed border-white/10 text-center">
            <p className="font-mono text-xs text-muted-foreground">
              No releases found. Set the GITHUB_REPO environment variable for update discovery.
            </p>
          </div>
        )}
        {!loading && releases.length > 0 && (
          <div className="space-y-2">
            {releases.map((r: any) => {
              const isCurrent = r.isLikelyCurrent;
              return (
                <div key={r.githubReleaseId} className="flex items-start justify-between rounded-lg bg-white/[0.03] p-3 border border-white/5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-white/90 truncate">{r.tagName}</span>
                      {isCurrent && <span className="text-[10px] text-signal bg-signal/10 px-1.5 py-0.5 rounded">current</span>}
                      {r.prerelease && <span className="text-[10px] text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded">pre</span>}
                      {!r.hasRequiredAssets && <span className="text-[10px] text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded">missing assets</span>}
                    </div>
                    {r.name && <p className="text-xs text-muted-foreground mt-0.5 truncate">{r.name}</p>}
                    <p className="text-[10px] text-muted-foreground mt-0.5">{r.publishedAt ? new Date(r.publishedAt).toLocaleDateString() : "—"}</p>
                  </div>
                  <div className="flex items-center gap-2 ml-3 shrink-0">
                    {r.hasRequiredAssets && !isCurrent && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={actionLoading !== null}
                        onClick={() => doInstall(r.githubReleaseId)}
                      >
                        {actionLoading === `install-${r.githubReleaseId}` ? (
                          <Loader2Icon className="size-3 animate-spin" />
                        ) : (
                          <DownloadIcon className="size-3" />
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
            {hasMore && (
              <div className="pt-2 text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={loadingMore}
                  onClick={loadMore}
                >
                  {loadingMore ? <Loader2Icon className="size-3.5 animate-spin mr-1.5" /> : null}
                  Load older releases
                </Button>
              </div>
            )}
          </div>
        )}
      </GlassPanel>
    </div>
  );
}
