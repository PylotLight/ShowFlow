import * as React from "react";
import { Loader2Icon, RefreshCwIcon, DownloadIcon, CheckCircle2Icon, PlayIcon, AlertCircleIcon, ShieldCheckIcon, HammerIcon, ArrowRightIcon } from "lucide-react";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Button } from "@frontend/components/ui/button";

interface ReleaseItem {
  githubReleaseId: number;
  tagName: string;
  name: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  isLikelyCurrent: boolean;
  hasRequiredAssets: boolean;
  buildInProgress: boolean;
  buildDetails?: {
    status: string;
    conclusion: string | null;
    htmlUrl: string | null;
    name: string | null;
    updatedAt: string | null;
    createdAt: string | null;
    durationSeconds?: number;
  } | null;
  assets: { id: number; name: string; sizeBytes: number }[];
}

export function UpdatesPanel() {
  const [token, setToken] = React.useState<string | null>(null);
  const tokenRef = React.useRef<string | null>(null);
  const [status, setStatus] = React.useState<any>(null);
  const [releases, setReleases] = React.useState<ReleaseItem[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  
  // Update Flow Active Tracker State
  const [activeUpdateTag, setActiveUpdateTag] = React.useState<string | null>(null);
  const [currentStep, setCurrentStep] = React.useState<number>(1); // 1: Build, 2: Download, 3: Activate, 4: Applied
  const [stepStatus, setStepStatus] = React.useState<"idle" | "running" | "success" | "error">("idle");
  const [stepMessage, setStepMessage] = React.useState<string>("");
  const [downloadProgress, setDownloadProgress] = React.useState<number>(0);
  
  const [actionLoading, setActionLoading] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [installedReleaseId, setInstalledReleaseId] = React.useState<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = React.useState(0);
  const pageRef = React.useRef(1);
  const pollTimerRef = React.useRef<any>(null);
  const pollDelayRef = React.useRef(3000);
  const reconnectTimerRef = React.useRef<any>(null);

  function headers(): Record<string, string> {
    return { Authorization: `Bearer ${token ?? tokenRef.current}` };
  }

  // Adaptive live-poll for the "Track Build" loop. The backend caches GitHub
  // responses, so polling our own /api is cheap — but we still stretch the
  // interval (3s -> 5.4s -> 9.7s ... capped at 30s) via a self-rescheduling
  // timer, keeping total request volume low.
  function startBuildPoll() {
    stopBuildPoll();
    const tick = () => {
      fetchAll(true);
      pollDelayRef.current = Math.min(pollDelayRef.current * 1.8, 30_000);
      pollTimerRef.current = setTimeout(tick, pollDelayRef.current);
    };
    pollTimerRef.current = setTimeout(tick, pollDelayRef.current);
  }

  function stopBuildPoll() {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollDelayRef.current = 3000;
  }

  function fetchAll(quiet = false) {
    if (!quiet) setLoading(true);
    setErr(null);
    pageRef.current = 1;
    Promise.all([
      fetch("/api/admin/updates/status", { headers: headers() }).then(r => r.ok ? r.json() : Promise.reject(r.status)),
      fetch("/api/admin/updates/available?page=1", { headers: headers() }).then(r => r.ok ? r.json() : { releases: [], hasMore: false }),
    ])
      .then(([s, a]) => { 
        setStatus(s); 
        const rels: ReleaseItem[] = a.releases ?? [];
        setReleases(rels); 
        setHasMore(a.hasMore ?? false); 

        // Auto-select any release that is currently building if nothing is manually selected
        const buildingRelease = rels.find(r => r.buildInProgress);
        if (buildingRelease && !activeUpdateTag) {
          setActiveUpdateTag(buildingRelease.tagName);
          setCurrentStep(1);
          setStepStatus("running");
          setStepMessage(`CI build in progress for ${buildingRelease.tagName}. Tracking GitHub Actions workflow...`);
          startBuildPoll();
        }

        // If watching a release build in progress, update step state
        if (activeUpdateTag && currentStep === 1) {
          const target = rels.find((r: ReleaseItem) => r.tagName === activeUpdateTag);
          if (target) {
            if (target.hasRequiredAssets) {
              setStepStatus("success");
              setStepMessage(`Release ${target.tagName} assets ready! Click "Update to ${target.tagName}" below.`);
              stopBuildPoll();
            } else if (!target.buildInProgress) {
              setStepStatus("error");
              setStepMessage("CI build completed but missing required showflow tarball asset.");
              stopBuildPoll();
            } else {
              const runName = target.buildDetails?.name ?? "Build";
              const dur = target.buildDetails?.durationSeconds ? `${target.buildDetails.durationSeconds}s` : "running";
              setStepMessage(`CI Build (${runName}): ${target.buildDetails?.status || "in_progress"} — ${dur} elapsed.`);
            }
          }
        }
      })
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
      .then(d => { tokenRef.current = d.token; setToken(d.token); fetchAll(); })
      .catch(e => setErr(String(e)))
      .finally(() => setLoading(false));

    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, []);

  // ---- Reconnect poller: polls /internal/ready from the SPA itself ----
  // The SW offline.html only intercepts *navigation* requests (manual refreshes).
  // After activation the SPA is still loaded in memory, so we must poll here
  // and trigger window.location.reload() ourselves once the new release is live.
  function startReconnectPoll(pendingReleaseId: string) {
    setCurrentStep(4);
    setStepStatus("running");
    setReconnectAttempt(0);

    let attempt = 0;

    function backoffDelay(n: number): number {
      const base = Math.min(800 * Math.pow(1.4, n), 4000);
      return Math.round(base + base * 0.2 * Math.random());
    }

    function poll() {
      attempt++;
      setReconnectAttempt(attempt);
      setStepMessage(`Waiting for new app process… (attempt ${attempt})`);

      fetch("/internal/ready", { cache: "no-store" })
        .then(res => {
          if (!res.ok) throw new Error(`not ready: ${res.status}`);
          return res.json();
        })
        .then(body => {
          const releaseId = body?.releaseId;
          if (!pendingReleaseId || releaseId === pendingReleaseId) {
            // New release is live!
            setStepStatus("success");
            setStepMessage("Update applied! Reloading page…");
            try { localStorage.removeItem("showflow:pendingReleaseId"); } catch {}
            setTimeout(() => window.location.reload(), 400);
            return;
          }
          // Server responded but it's still the old (or rolled-back) release
          setStepMessage(`Server is up but still switching release… (attempt ${attempt})`);
          reconnectTimerRef.current = setTimeout(poll, backoffDelay(attempt));
        })
        .catch(() => {
          // Server not ready yet
          setStepMessage(`Waiting for server startup… (attempt ${attempt})`);
          reconnectTimerRef.current = setTimeout(poll, backoffDelay(attempt));
        });
    }

    // First poll after a short delay to give the supervisor time to SIGTERM
    reconnectTimerRef.current = setTimeout(poll, backoffDelay(0));
  }

  function startWatchBuild(tagName: string) {
    setActiveUpdateTag(tagName);
    setCurrentStep(1);
    setStepStatus("running");
    setStepMessage("Watching CI build & asset generation on GitHub Actions...");
    startBuildPoll();
  }

  async function doInstall(githubReleaseId: number, tagName: string) {
    setActiveUpdateTag(tagName);
    setCurrentStep(2);
    setStepStatus("running");
    setStepMessage("Downloading release asset & handing off to supervisor verification...");
    setDownloadProgress(25);

    setActionLoading(`install-${githubReleaseId}`);
    setErr(null);
    setInstalledReleaseId(null);
    
    const interval = setInterval(() => {
      setDownloadProgress((prev) => (prev < 85 ? prev + 15 : prev));
    }, 400);

    try {
      const res = await fetch("/api/admin/updates/install", {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify({ githubReleaseId }),
      });
      clearInterval(interval);
      setDownloadProgress(100);

      const data = await res.json();
      if (!data.ok) { 
        setStepStatus("error");
        setStepMessage(data.message || "Install failed");
        setErr(data.message || "Install failed"); 
        return; 
      }
      
      setStepStatus("success");
      setStepMessage(`Release downloaded and verified by supervisor! Ready for activation.`);
      if (data.releaseId) setInstalledReleaseId(data.releaseId);
      fetchAll(true);
    } catch (e) { 
      clearInterval(interval);
      setStepStatus("error");
      setStepMessage(String(e));
      setErr(String(e)); 
    }
    finally { setActionLoading(null); }
  }

  async function doActivate(releaseId: string, tagName?: string) {
    if (tagName) setActiveUpdateTag(tagName);
    setCurrentStep(3);
    setStepStatus("running");
    setStepMessage("Activating new app build… Handoff to supervisor in progress.");

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
      if (data.timedOut) {
        // Activation passed pre-flight — supervisor is now restarting the app.
        // Start polling /internal/ready from the SPA so we auto-reload.
        startReconnectPoll(releaseId);
        return;
      }
      if (!data.ok) { 
        setStepStatus("error");
        setStepMessage(data.message || "Activation failed");
        setErr(data.message || "Activation failed"); 
        clearPendingRelease(); 
      }
    } catch {
      // Connection dropped = supervisor is quiescing (killing this process).
      // Activation is proceeding — poll from the SPA to detect the new release.
      startReconnectPoll(releaseId);
    }
    finally { setActionLoading(null); }
  }

  return (
    <div className="space-y-6">
      {/* UPDATE PIPELINE PROGRESS CARD */}
      {activeUpdateTag && (
        <GlassPanel className="p-6 space-y-5 border-signal/30 bg-signal/[0.02]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-signal opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-signal"></span>
              </span>
              <h3 className="font-display text-sm font-semibold tracking-wide text-white">
                Update Pipeline: <span className="font-mono text-signal">{activeUpdateTag}</span>
              </h3>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setActiveUpdateTag(null)} className="text-white/40 hover:text-white text-xs">
              Dismiss
            </Button>
          </div>

          {/* Stepper Bar */}
          <div className="grid grid-cols-4 gap-2 pt-1">
            {/* Step 1: CI Build */}
            <div className={`p-3 rounded-lg border text-xs space-y-1.5 transition-all ${
              currentStep === 1 
                ? "bg-white/[0.08] border-signal/50 text-white" 
                : currentStep > 1 
                  ? "bg-white/[0.02] border-emerald-500/30 text-emerald-400" 
                  : "bg-white/[0.01] border-white/5 text-white/40"
            }`}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase font-semibold">1. CI Build</span>
                {currentStep === 1 && stepStatus === "running" && <Loader2Icon className="size-3 animate-spin text-signal" />}
                {currentStep > 1 && <CheckCircle2Icon className="size-3 text-emerald-400" />}
              </div>
              <p className="font-medium truncate text-[11px]">Assets</p>
            </div>

            {/* Step 2: Download */}
            <div className={`p-3 rounded-lg border text-xs space-y-1.5 transition-all ${
              currentStep === 2 
                ? "bg-white/[0.08] border-signal/50 text-white" 
                : currentStep > 2 
                  ? "bg-white/[0.02] border-emerald-500/30 text-emerald-400" 
                  : "bg-white/[0.01] border-white/5 text-white/40"
            }`}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase font-semibold">2. Download</span>
                {currentStep === 2 && stepStatus === "running" && <Loader2Icon className="size-3 animate-spin text-signal" />}
                {currentStep > 2 && <CheckCircle2Icon className="size-3 text-emerald-400" />}
              </div>
              <p className="font-medium truncate text-[11px]">Tarball & Verify</p>
            </div>

            {/* Step 3: Activate */}
            <div className={`p-3 rounded-lg border text-xs space-y-1.5 transition-all ${
              currentStep === 3 
                ? "bg-white/[0.08] border-signal/50 text-white" 
                : currentStep > 3 
                  ? "bg-white/[0.02] border-emerald-500/30 text-emerald-400" 
                  : "bg-white/[0.01] border-white/5 text-white/40"
            }`}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase font-semibold">3. Activate</span>
                {currentStep === 3 && stepStatus === "running" && <Loader2Icon className="size-3 animate-spin text-signal" />}
                {currentStep > 3 && <CheckCircle2Icon className="size-3 text-emerald-400" />}
              </div>
              <p className="font-medium truncate text-[11px]">Supervisor Handoff</p>
            </div>

            {/* Step 4: Refresh */}
            <div className={`p-3 rounded-lg border text-xs space-y-1.5 transition-all ${
              currentStep === 4 && stepStatus === "success"
                ? "bg-white/[0.02] border-emerald-500/30 text-emerald-400"
                : currentStep === 4 
                  ? "bg-white/[0.08] border-signal/50 text-white" 
                  : "bg-white/[0.01] border-white/5 text-white/40"
            }`}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase font-semibold">4. Refresh</span>
                {currentStep === 4 && stepStatus === "running" && <Loader2Icon className="size-3 animate-spin text-signal" />}
                {currentStep === 4 && stepStatus === "success" && <CheckCircle2Icon className="size-3 text-emerald-400" />}
              </div>
              <p className="font-medium truncate text-[11px]">
                {currentStep === 4 && stepStatus === "success" 
                  ? "Reloading…" 
                  : currentStep === 4 && reconnectAttempt > 0
                    ? `Polling… #${reconnectAttempt}`
                    : "Auto Reconnect"}
              </p>
            </div>
          </div>

          {/* Status info & Download bar */}
          <div className="bg-white/[0.03] border border-white/5 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-white/80 font-mono text-[11px]">{stepMessage || "Processing update phase..."}</span>
              {stepStatus === "error" && <span className="text-red-400 font-semibold text-[10px]">Failed</span>}
            </div>

            {currentStep === 2 && stepStatus === "running" && (
              <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                <div 
                  className="bg-signal h-full transition-all duration-300 rounded-full" 
                  style={{ width: `${downloadProgress}%` }}
                />
              </div>
            )}
          </div>
        </GlassPanel>
      )}

      {/* SUPERVISOR STATUS CARD */}
      <GlassPanel className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Update Status</h3>
            <p className="text-muted-foreground text-xs mt-0.5">Current state from the supervisor</p>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => fetchAll()} disabled={loading}>
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
              <p className="text-xs text-signal font-medium">Release downloaded & verified</p>
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
                "Activate Now"
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

      {/* AVAILABLE RELEASES LIST */}
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
            {releases.map((r: ReleaseItem) => {
              const isCurrent = r.isLikelyCurrent;
              const isWatchTarget = activeUpdateTag === r.tagName;
              const build = r.buildDetails;

              return (
                <div key={r.githubReleaseId} className="space-y-2 rounded-lg bg-white/[0.03] p-3 border border-white/5 hover:border-white/10 transition-colors">
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs text-white/90 truncate font-semibold">{r.tagName}</span>
                        {isCurrent && <span className="text-[10px] text-signal bg-signal/10 px-1.5 py-0.5 rounded border border-signal/20 font-mono">current</span>}
                        {r.prerelease && <span className="text-[10px] text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded border border-amber-400/20 font-mono">pre</span>}
                        {r.buildInProgress && (
                          <span className="text-[10px] text-sky-400 bg-sky-400/10 px-1.5 py-0.5 rounded border border-sky-400/20 font-mono flex items-center gap-1">
                            <Loader2Icon className="size-2.5 animate-spin" /> CI Building ({build?.durationSeconds ? `${build.durationSeconds}s` : "in progress"})
                          </span>
                        )}
                        {!r.hasRequiredAssets && !r.buildInProgress && <span className="text-[10px] text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded border border-red-400/20 font-mono">missing assets</span>}
                      </div>
                      {r.name && <p className="text-xs text-muted-foreground mt-0.5 truncate">{r.name}</p>}
                      <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground font-mono">
                        <span>{r.publishedAt ? new Date(r.publishedAt).toLocaleString() : "—"}</span>
                        {r.assets.length > 0 && <span>Asset: {(r.assets[0]!.sizeBytes / (1024 * 1024)).toFixed(1)} MB</span>}
                        {build?.htmlUrl && (
                          <a href={build.htmlUrl} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline flex items-center gap-0.5">
                            GitHub Workflow <ArrowRightIcon className="size-2.5" />
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-3 shrink-0">
                      {/* Action: Watch Build */}
                      {r.buildInProgress && (
                        <Button
                          variant={isWatchTarget ? "default" : "ghost"}
                          size="sm"
                          className="text-xs text-sky-400 hover:text-sky-300 border border-sky-500/20"
                          onClick={() => startWatchBuild(r.tagName)}
                        >
                          <HammerIcon className="size-3 mr-1" />
                          {isWatchTarget ? "Watching..." : "Track Build"}
                        </Button>
                      )}

                      {/* Action: Download & Install */}
                      {r.hasRequiredAssets && !isCurrent && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={actionLoading !== null}
                          onClick={() => doInstall(r.githubReleaseId, r.tagName)}
                        >
                          {actionLoading === `install-${r.githubReleaseId}` ? (
                            <Loader2Icon className="size-3 animate-spin mr-1.5" />
                          ) : (
                            <DownloadIcon className="size-3 mr-1.5" />
                          )}
                          Update to {r.tagName}
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Inline Live Build Tracker Bar if this tag is actively selected */}
                  {isWatchTarget && currentStep === 1 && (
                    <div className="mt-2 p-2.5 rounded bg-sky-950/30 border border-sky-500/30 text-xs flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Loader2Icon className="size-3.5 animate-spin text-sky-400" />
                        <span className="font-mono text-[11px] text-sky-200">
                          {build ? `Actions Run "${build.name}": status is ${build.status} (${build.durationSeconds ?? 0}s elapsed)` : "Monitoring GitHub Actions release workflow..."}
                        </span>
                      </div>
                      <span className="text-[10px] font-mono text-sky-400/80">Polling live · {Math.round(pollDelayRef.current / 1000)}s</span>
                    </div>
                  )}
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

