import * as React from "react";
import { ErrorNotice } from "./settings/errors";
import { Loader2Icon, RefreshCwIcon, DownloadIcon, CheckCircle2Icon, PlayIcon, AlertCircleIcon, ShieldCheckIcon, HammerIcon, ArrowRightIcon, ChevronDownIcon, RadioIcon } from "lucide-react";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Button } from "@frontend/components/ui/button";
import { Switch } from "@frontend/components/ui/switch";
import { usePolling } from "@frontend/lib/usePolling";
import { reconnectDelayMs, pendingPollMs, applyEstimateLabel } from "@frontend/lib/updateTiming";
import { updateFetch, resolveRecovery, type RecoveryTarget } from "@frontend/lib/updateFetch";

interface PendingUpdate {
  tag: string;
  releaseId: string;
  title: string | null;
  notes: string | null;
  publishedAt: string | null;
  stagedAt: string;
}

interface UpdateInfo {
  autoActivate?: { mode: "off" | "idle" | "window"; hour: number };
  serverTime?: string;
  download?: {
    tag: string | null;
    phase: "resolving" | "downloading" | "verifying" | "staged" | "error";
    receivedBytes: number;
    totalBytes: number | null;
    attempt: number;
    message: string | null;
    timings?: { downloadMs?: number; extractedInline?: boolean; supervisorMs?: number; supervisorPath?: "install" | "install-archive" };
  } | null;
  downloadFailure?: { tag: string; count: number; nextRetryAt: string; message: string } | null;
  activation?: { releaseId: string; tag: string | null; phase: "draining" | "backing-up" | "handing-off" | "failed"; detail: string; busy: string[]; auto: boolean } | null;
  lastActivation?: { releaseId: string; tag: string | null; outcome?: "activated" | "rolled-back" | "failed"; message?: string; backupFile: string | null; startedAt?: string; finishedAt?: string } | null;
  pendingMigrations?: string[] | null;
  busy?: string[];
}

const ACTIVATION_PHASE_LABEL: Record<string, string> = {
  draining: "Waiting for jobs",
  "backing-up": "Backing up DB",
  "handing-off": "Handing off",
  failed: "Failed",
};

function formatMb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

interface ReleaseItem {
  githubReleaseId: number;
  tagName: string;
  name: string | null;
  body: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  isLikelyCurrent: boolean;
  /** vs the running release (sha match or semver); only newer/unknown get "Update to". */
  relation?: "current" | "newer" | "older" | "unknown";
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
  const [showOlder, setShowOlder] = React.useState(false);
  const [notesOpen, setNotesOpen] = React.useState<Record<number, boolean>>({});
  const [installedReleaseId, setInstalledReleaseId] = React.useState<string | null>(null);
  const [installedTag, setInstalledTag] = React.useState<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = React.useState(0);
  const pageRef = React.useRef(1);
  const pollTimerRef = React.useRef<any>(null);
  const pollDelayRef = React.useRef(3000);
  const reconnectTimerRef = React.useRef<any>(null);

  // ---- Background watcher state ----
  const [pending, setPending] = React.useState<PendingUpdate | null>(null);
  const [autoDownload, setAutoDownload] = React.useState(true);
  const [checking, setChecking] = React.useState(false);
  const [checkNote, setCheckNote] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<UpdateInfo>({});
  /** releaseId we asked the backend to activate and are waiting to hand off. */
  const [awaitingHandoff, setAwaitingHandoffState] = React.useState<string | null>(null);
  const awaitingRef = React.useRef<string | null>(null);
  function setAwaitingHandoff(id: string | null) {
    awaitingRef.current = id;
    setAwaitingHandoffState(id);
  }
  const watchTimerRef = React.useRef<any>(null);
  /** Latest /pending payload, readable from fetch callbacks without stale closures. */
  const infoRef = React.useRef<UpdateInfo>({});
  infoRef.current = info;
  const activeTagRef = React.useRef<string | null>(null);
  activeTagRef.current = activeUpdateTag;
  const currentStepRef = React.useRef(1);
  currentStepRef.current = currentStep;
  /** Set while a manual "Update to" install request is in flight. */
  const installingTagRef = React.useRef<string | null>(null);
  /** Target of the running reconnect poll, so a second trigger doesn't start a parallel one. */
  const reconnectTargetRef = React.useRef<RecoveryTarget | null>(null);
  /** Quiet retries of fetchAll() while ShowFlow restarts, before we show an error. */
  const fetchAllRetryRef = React.useRef<{ timer: any; n: number }>({ timer: null, n: 0 });

  /**
   * The update in flight right now (if any), for deciding whether a dropped
   * connection / 503 means "ShowFlow is restarting to apply it".
   */
  function inFlightTarget(): RecoveryTarget | null {
    const a = infoRef.current.activation;
    if (awaitingRef.current) return { releaseId: awaitingRef.current, tag: activeTagRef.current };
    if (installingTagRef.current) return { releaseId: null, tag: installingTagRef.current };
    if (a && a.phase !== "failed") return { releaseId: a.releaseId, tag: a.tag };
    if (activeTagRef.current && currentStepRef.current >= 2) return { releaseId: null, tag: activeTagRef.current };
    return null;
  }

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
    if (fetchAllRetryRef.current.timer) { clearTimeout(fetchAllRetryRef.current.timer); fetchAllRetryRef.current.timer = null; }
    Promise.all([
      updateFetch<any>("/api/admin/updates/status", { headers: headers() }),
      updateFetch<any>("/api/admin/updates/available?page=1", { headers: headers() }),
    ])
      .then(([sr, ar]) => {
        if (sr.kind === "restarting" || ar.kind === "restarting") {
          // ShowFlow is mid-restart (an update handing off, or a pod restart).
          // Not an error: follow the update if one is in flight, otherwise
          // retry quietly and only complain if it never comes back.
          const target = inFlightTarget();
          if (target) { startReconnectPoll(target); return; }
          const n = ++fetchAllRetryRef.current.n;
          if (n <= 10) {
            fetchAllRetryRef.current.timer = setTimeout(() => fetchAll(true), Math.min(1_000 * n, 5_000));
          } else {
            fetchAllRetryRef.current.n = 0;
            setErr("HTTP 503: ShowFlow didn't come back after restarting");
          }
          return;
        }
        fetchAllRetryRef.current.n = 0;
        if (sr.kind === "error") { setErr(`HTTP ${sr.status}: ${sr.message}`); return; }
        const s = sr.data;
        const a = ar.kind === "ok" ? ar.data : { releases: [], hasMore: false };
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
      const r = await updateFetch<any>(`/api/admin/updates/available?page=${next}`, { headers: headers() });
      if (r.kind === "restarting") return; // ShowFlow is restarting; "Load more" again once it's back
      if (r.kind === "error") throw new Error(`Server returned ${r.status}: ${r.message}`);
      const a = r.data;
      setReleases(prev => [...prev, ...(a.releases ?? [])]);
      setHasMore(a.hasMore ?? false);
      pageRef.current = next;
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  // ---- Background watcher: fetch staged state, force a check, toggle mode ----
  function fetchPending() {
    return updateFetch<any>("/api/admin/updates/pending", { headers: headers() })
      .then(r => {
        if (r.kind === "ok") {
          const d = r.data;
          if (!d) return;
          setPending(d.pending ?? null);
          if (typeof d.autoDownload === "boolean") setAutoDownload(d.autoDownload);
          setInfo(d as UpdateInfo);
          return;
        }
        // A 503 / dropped connection while an update is in flight (our own
        // activation, an auto-activate, or an install racing one) means the
        // supervisor is restarting ShowFlow: follow it with the reconnect poll.
        if (r.kind === "restarting") {
          const target = inFlightTarget();
          if (target) startReconnectPoll(target);
        }
      })
      .catch(() => {});
  }

  // Live progress: poll /pending every 1.5s while something is moving
  // (download, verify, drain, backup, handoff). Idle otherwise.
  const busyDownload = !!info.download && ["resolving", "downloading", "verifying"].includes(info.download.phase);
  const busyActivation = !!info.activation && info.activation.phase !== "failed";
  usePolling(() => { fetchPending(); }, pendingPollMs(!!awaitingHandoff || (!!info.activation && info.activation.phase === "handing-off")), !!token && (busyDownload || busyActivation || !!awaitingHandoff || (actionLoading?.startsWith("install-") ?? false)));

  // Drive the stepper from the backend's activation progress.
  React.useEffect(() => {
    if (!awaitingHandoff) return;
    const a = info.activation;
    if (a && a.releaseId === awaitingHandoff) {
      if (a.phase === "failed") {
        setStepStatus("error");
        setStepMessage(a.detail);
        setErr(a.detail);
        setAwaitingHandoff(null);
        import("@frontend/register-sw").then(m => m.clearPendingRelease()).catch(() => {});
        return;
      }
      setStepMessage(`${ACTIVATION_PHASE_LABEL[a.phase] ?? a.phase}: ${a.detail}`);
      if (a.phase === "handing-off") {
        setAwaitingHandoff(null);
        startReconnectPoll({ releaseId: awaitingHandoff, tag: a.tag ?? activeTagRef.current });
      }
    }
  }, [info, awaitingHandoff]);

  // Real download progress for the stepper (replaces the old fake ticker).
  React.useEffect(() => {
    const d = info.download;
    if (!d || currentStep !== 2) return;
    if (d.phase === "downloading" && d.totalBytes) {
      setDownloadProgress(Math.min(99, Math.round((d.receivedBytes / d.totalBytes) * 100)));
      setStepMessage(`Downloading ${formatMb(d.receivedBytes)} / ${formatMb(d.totalBytes)}${d.attempt > 1 ? ` (attempt ${d.attempt})` : ""}…`);
    } else if (d.phase === "verifying") {
      setDownloadProgress(100);
      setStepMessage(d.timings?.extractedInline ? "Unpacked while downloading — supervisor is verifying the checksum…" : "Supervisor is extracting and verifying the checksum…");
    }
  }, [info.download, currentStep]);

  function saveAutoActivate(next: { mode: "off" | "idle" | "window"; hour: number }) {
    const prev = info.autoActivate;
    setInfo(i => ({ ...i, autoActivate: next }));
    fetch("/api/admin/updates/settings", {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ autoActivate: next }),
    })
      .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(d => { if (d?.autoActivate) setInfo(i => ({ ...i, autoActivate: d.autoActivate })); })
      .catch(() => setInfo(i => ({ ...i, autoActivate: prev })));
  }

  // Runs one watcher cycle. `force` bypasses the 15s feed-TTL on the server
  // (real conditional GET → 304 when nothing changed). Cheap + rate-limit-free
  // either way, so we call it on mount, on "Check now", and on the visible poll.
  function runCheck(opts: { force?: boolean; note?: boolean } = {}) {
    setChecking(true);
    return updateFetch<any>("/api/admin/updates/check", {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ force: opts.force !== false }),
    })
      .then(r => {
        if (r.kind === "restarting") {
          if (opts.note) setCheckNote("ShowFlow is restarting, check again in a moment.");
          return null;
        }
        if (r.kind === "error") throw new Error(`${r.status}: ${r.message}`);
        return r.data;
      })
      .then((res: any) => {
        if (!res) return;
        setPending(res.pending ?? null);
        if (opts.note) {
          if (res.status === "staged") setCheckNote(`Checked — ${res.latestTag} is staged and ready to activate.`);
          else if (res.status === "up-to-date") setCheckNote(`Checked — you're on the latest release (${res.currentVersion}).`);
          else if (res.status === "downloaded-not-verified") setCheckNote(`Checked — ${res.latestTag} downloaded but failed verification: ${res.error ?? "unknown"}`);
          else if (res.status === "skipped") setCheckNote(`Checked — ${res.latestTag} is newer, but auto-download is off.`);
          else if (res.status === "retry-scheduled") setCheckNote(`Checked — ${res.latestTag} isn't downloadable yet (${res.error ?? "unknown"}); retrying automatically at ${res.nextRetryAt ? new Date(res.nextRetryAt).toLocaleTimeString() : "soon"}.`);
          else setCheckNote(null);
        }
        if (res.status === "staged") fetchAll(true);
        fetchPending();
      })
      .catch(e => { if (opts.note) setCheckNote(`Check failed: ${e instanceof Error ? e.message : String(e)}`); })
      .finally(() => setChecking(false));
  }

  function toggleAutoDownload(next: boolean) {
    setAutoDownload(next);
    setCheckNote(null);
    fetch("/api/admin/updates/settings", {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ autoDownload: next }),
    })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => setAutoDownload(!!d.autoDownload))
      // Revert the optimistic flip if the save failed.
      .catch(() => setAutoDownload(!next));
  }

  React.useEffect(() => {
    let tokenTimer: any = null;
    let cancelled = false;
    // The panel can mount while ShowFlow is restarting (e.g. a reload right
    // after an update): retry the token quietly instead of a JSON SyntaxError.
    const loadToken = (n: number) => {
      updateFetch<{ token: string }>("/api/admin/token")
        .then(r => {
          if (cancelled) return;
          if (r.kind === "ok") {
            tokenRef.current = r.data.token; setToken(r.data.token); fetchAll(); fetchPending();
            return;
          }
          if (r.kind === "restarting" && n < 15) { tokenTimer = setTimeout(() => loadToken(n + 1), Math.min(500 * (n + 1), 3_000)); return; }
          setErr(r.kind === "error" ? `HTTP ${r.status}: ${r.message}` : `HTTP ${r.status ?? 503}: ShowFlow isn't responding`);
          setLoading(false);
        })
        .catch(e => { if (!cancelled) { setErr(String(e)); setLoading(false); } });
    };
    loadToken(0);

    return () => {
      cancelled = true;
      if (tokenTimer) clearTimeout(tokenTimer);
      if (fetchAllRetryRef.current.timer) clearTimeout(fetchAllRetryRef.current.timer);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (watchTimerRef.current) clearInterval(watchTimerRef.current);
    };
  }, []);

  // ---- Adaptive watcher poll ----
  // While this panel is mounted AND the tab is actually visible, run a cheap
  // watcher check every 20s so a freshly-pushed release auto-downloads in front
  // of you. Pause entirely when the tab is hidden (no pointless background
  // traffic) — the 15-min scheduler task covers the closed-tab case. Checks
  // never touch the rate-limited API unless a genuinely newer tag exists.
  React.useEffect(() => {
    if (!token) return;
    const start = () => {
      if (watchTimerRef.current) return;
      watchTimerRef.current = setInterval(() => runCheck({ force: false }), 20_000);
    };
    const stop = () => {
      if (watchTimerRef.current) { clearInterval(watchTimerRef.current); watchTimerRef.current = null; }
    };
    const onVisible = () => (document.visibilityState === "visible" ? start() : stop());
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisible);
    return () => { document.removeEventListener("visibilitychange", onVisible); stop(); };
  }, [token]);

  // ---- Reconnect poller: polls /internal/ready from the SPA itself ----
  // The SW offline.html only intercepts *navigation* requests (manual refreshes).
  // After activation the SPA is still loaded in memory, so we must poll here
  // and trigger window.location.reload() ourselves once the new release is live.
  //
  // Also the landing spot for any 503 / dropped connection while an update is
  // in flight: it waits ShowFlow out, then asks the server what actually
  // happened (resolveRecovery) instead of assuming the step that was showing
  // failed. Running version == target -> step 4 success + reload.
  function startReconnectPoll(target: RecoveryTarget) {
    // Already following this restart: just fill in what we know about the target.
    if (reconnectTargetRef.current) {
      const cur = reconnectTargetRef.current;
      reconnectTargetRef.current = { releaseId: cur.releaseId ?? target.releaseId, tag: cur.tag ?? target.tag };
      return;
    }
    reconnectTargetRef.current = target;
    if (target.tag && !activeTagRef.current) setActiveUpdateTag(target.tag);
    setAwaitingHandoff(null);
    setErr(null);
    setCurrentStep(4);
    setStepStatus("running");
    setReconnectAttempt(0);
    const label = target.tag ?? target.releaseId?.slice(0, 12) ?? "the update";
    setStepMessage(`ShowFlow is restarting to apply ${label}, reconnecting…`);

    let attempt = 0;
    const MAX_ATTEMPTS = 60;

    function stop() {
      reconnectTargetRef.current = null;
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    }

    function giveUp(message: string) {
      stop();
      setStepStatus("error");
      setStepMessage(message);
      setErr(message);
      try { localStorage.removeItem("showflow:pendingReleaseId"); } catch {}
    }

    function done() {
      stop();
      setErr(null);
      setCurrentStep(4);
      setStepStatus("success");
      setStepMessage("Update applied! Reloading page…");
      try { localStorage.removeItem("showflow:pendingReleaseId"); } catch {}
      setTimeout(() => window.location.reload(), 400);
    }

    const again = (delay = reconnectDelayMs(attempt)) => { reconnectTimerRef.current = setTimeout(poll, delay); };

    async function poll() {
      const t = reconnectTargetRef.current;
      if (!t) return;
      attempt++;
      if (attempt > MAX_ATTEMPTS) {
        giveUp(`Gave up waiting for ${label} after ${MAX_ATTEMPTS} checks, check the supervisor status below.`);
        return;
      }
      setReconnectAttempt(attempt);

      const ready = await updateFetch<{ ready?: boolean; releaseId?: string; version?: string }>("/internal/ready", { cache: "no-store" }).catch(() => null);
      if (!ready || ready.kind !== "ok" || !ready.data?.ready) {
        setStepMessage(`ShowFlow is restarting to apply ${label}, waiting for it to come back… (attempt ${attempt})`);
        again();
        return;
      }

      const [st, pd] = await Promise.all([
        updateFetch<any>("/api/admin/updates/status", { headers: headers() }).catch(() => null),
        updateFetch<any>("/api/admin/updates/pending", { headers: headers() }).catch(() => null),
      ]);
      const pendingBody = pd?.kind === "ok" ? pd.data : null;
      if (pendingBody) {
        setInfo(pendingBody as UpdateInfo);
        setPending(pendingBody.pending ?? null);
      }
      const state = resolveRecovery(t, {
        ready: ready.data,
        status: st?.kind === "ok" ? st.data : null,
        pending: pendingBody,
      });

      switch (state.kind) {
        case "applied":
          done();
          return;
        case "failed":
          stop();
          setStepStatus("error");
          setStepMessage(state.message);
          setErr(state.message);
          try { localStorage.removeItem("showflow:pendingReleaseId"); } catch {}
          return;
        case "activating":
          // Old process is still draining / backing up before the handoff.
          attempt = Math.max(0, attempt - 1); // progress, not a miss
          setCurrentStep(3);
          setStepStatus("running");
          setStepMessage(`${ACTIVATION_PHASE_LABEL[state.phase] ?? state.phase}: ${state.detail}`);
          again(1_000);
          return;
        case "downloading":
          attempt = Math.max(0, attempt - 1);
          setCurrentStep(2);
          setStepStatus("running");
          setStepMessage(state.phase === "verifying" ? "Supervisor is verifying the download…" : "Downloading the release…");
          again(1_500);
          return;
        case "staged":
          // Downloaded + verified but not activated (auto-activate off, or
          // waiting for idle). Same end state as a finished "Update to".
          stop();
          setCurrentStep(2);
          setStepStatus("success");
          setStepMessage("Release downloaded and verified by supervisor! Ready for activation.");
          setInstalledReleaseId(state.releaseId);
          if (t.tag) setInstalledTag(t.tag);
          fetchAll(true);
          return;
        case "waiting":
          setStepMessage(`Server is up but still switching release… (attempt ${attempt}/${MAX_ATTEMPTS})`);
          again();
          return;
      }
    }

    // First poll after a short delay to give the supervisor time to SIGTERM
    reconnectTimerRef.current = setTimeout(poll, reconnectDelayMs(0));
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
    setDownloadProgress(0);

    setActionLoading(`install-${githubReleaseId}`);
    setErr(null);
    setInstalledReleaseId(null);
    setInstalledTag(null);
    
    // Real progress comes from the /pending poll (info.download) while this
    // request is in flight.

    installingTagRef.current = tagName;
    try {
      const r = await updateFetch<{ ok?: boolean; message?: string; releaseId?: string }>("/api/admin/updates/install", {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify({ githubReleaseId }),
      });
      if (r.kind === "restarting") {
        // The connection dropped / the supervisor 503'd mid-install. That's
        // ShowFlow restarting (typically auto-activate applying the release
        // the background watcher just staged), not a failed download: wait it
        // out and ask the server what happened.
        startReconnectPoll({ releaseId: null, tag: tagName });
        return;
      }
      setDownloadProgress(100);
      const data = r.data;
      if (r.kind === "error" || !data?.ok) {
        const message = data?.message || (r.kind === "error" ? r.message : "") || "Install failed";
        setStepStatus("error");
        setStepMessage(message);
        setErr(message);
        return;
      }
      
      setStepStatus("success");
      setStepMessage(`Release downloaded and verified by supervisor! Ready for activation.`);
      if (data.releaseId) {
        setInstalledReleaseId(data.releaseId);
        setInstalledTag(tagName);
      }
      fetchAll(true);
    } catch (e) { 
      setStepStatus("error");
      setStepMessage(String(e));
      setErr(String(e)); 
    }
    finally { installingTagRef.current = null; setActionLoading(null); }
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
      const r = await updateFetch<{ ok?: boolean; accepted?: boolean; timedOut?: boolean; message?: string }>("/api/admin/updates/activate", {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify({ releaseId, tag: tagName }),
      });
      if (r.kind === "restarting") {
        // Connection dropped = supervisor is quiescing (killing this process).
        startReconnectPoll({ releaseId, tag: tagName ?? null });
        return;
      }
      const data = r.data ?? { ok: false, message: r.kind === "error" ? r.message : undefined };
      if (data.accepted) {
        // Backend now drains running jobs, backs up if the release migrates
        // the DB, then hands off. Follow it via the /pending poll; the
        // reconnect poll starts once the handoff begins.
        setStepMessage("Preparing activation…");
        setAwaitingHandoff(releaseId);
        fetchPending();
        return;
      }
      if (data.timedOut) {
        // Older backend contract: activation already in progress.
        startReconnectPoll({ releaseId, tag: tagName ?? null });
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
      startReconnectPoll({ releaseId, tag: tagName ?? null });
    }
    finally { setActionLoading(null); }
  }

  // Newest-first from GitHub: the current release and anything newer
  // (plus in-flight builds) stay expanded; older releases collapse into a
  // single toggle so the list doesn't grow a row per shipped version.
  const currentIdx = releases.findIndex(r => r.isLikelyCurrent);
  const visibleReleases = currentIdx === -1
    ? releases
    : releases.filter((r, i) => i <= currentIdx || r.buildInProgress);
  const olderReleases = currentIdx === -1
    ? []
    : releases.filter((r, i) => i > currentIdx && !r.buildInProgress);

  function renderReleaseRow(r: ReleaseItem) {
    const isCurrent = r.isLikelyCurrent;
    const isWatchTarget = activeUpdateTag === r.tagName;
    const build = r.buildDetails;
    const notesExpanded = !!notesOpen[r.githubReleaseId];
    // Downloaded + verified, awaiting activation — either from a manual
    // "Update to" click this session (installedReleaseId) or from the
    // background watcher's auto-download (pending). The row's Update button
    // becomes Activate so there's no scroll to the status card.
    const stagedReleaseId = (installedReleaseId && installedTag === r.tagName)
      ? installedReleaseId
      : (pending && pending.tag === r.tagName ? pending.releaseId : null);
    const isStaged = stagedReleaseId !== null;

    return (
      <div key={r.githubReleaseId} className="space-y-2 rounded-lg bg-white/[0.03] p-3 border border-white/5 hover:border-white/10 transition-colors">
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-xs text-white/90 truncate font-semibold">{r.tagName}</span>
              {isCurrent && <span className="text-[11px] text-signal bg-signal/10 px-1.5 py-px rounded border border-signal/20 font-mono">current</span>}
              {r.prerelease && <span className="text-[11px] text-amber-400 bg-amber-400/10 px-1.5 py-px rounded border border-amber-400/20 font-mono">pre</span>}
              {r.buildInProgress && (
                <span className="text-[11px] text-sky-400 bg-sky-400/10 px-1.5 py-px rounded border border-sky-400/20 font-mono flex items-center gap-1">
                  <Loader2Icon className="size-2.5 animate-spin" /> CI Building ({build?.durationSeconds ? `${build.durationSeconds}s` : "in progress"})
                </span>
              )}
              {!r.hasRequiredAssets && !r.buildInProgress && <span className="text-[11px] text-red-400 bg-red-400/10 px-1.5 py-px rounded border border-red-400/20 font-mono">missing assets</span>}
            </div>
            {r.name && <p className="text-xs text-muted-foreground mt-0.5 truncate">{r.name}</p>}
            <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground font-mono flex-wrap">
              <span>{r.publishedAt ? new Date(r.publishedAt).toLocaleString() : "—"}</span>
              {r.assets.length > 0 && <span>Asset: {(r.assets[0]!.sizeBytes / (1024 * 1024)).toFixed(1)} MB</span>}
              {build?.htmlUrl && (
                <a href={build.htmlUrl} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline flex items-center gap-0.5">
                  GitHub Workflow <ArrowRightIcon className="size-2.5" />
                </a>
              )}
              {r.body && (
                <button
                  onClick={() => setNotesOpen(prev => ({ ...prev, [r.githubReleaseId]: !prev[r.githubReleaseId] }))}
                  className="text-muted-foreground hover:text-foreground flex items-center gap-0.5 transition-colors"
                >
                  Release notes
                  <ChevronDownIcon className={`size-2.5 transition-transform ${notesExpanded ? "" : "-rotate-90"}`} />
                </button>
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

            {/* Action: Download & Install, then Activate in place once staged */}
            {isStaged ? (
              <Button
                variant="default"
                size="sm"
                disabled={actionLoading !== null}
                onClick={() => doActivate(stagedReleaseId!, r.tagName)}
              >
                {actionLoading === `activate-${stagedReleaseId}` ? (
                  <Loader2Icon className="size-3 animate-spin mr-1.5" />
                ) : (
                  <PlayIcon className="size-3 mr-1.5" />
                )}
                Activate Now
              </Button>
            ) : (
              r.hasRequiredAssets && !isCurrent && r.relation === "older" ? (
                <span className="text-[11px] text-muted-foreground font-mono">previous</span>
              ) : r.hasRequiredAssets && !isCurrent && (
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
              )
            )}
          </div>
        </div>

        {r.body && notesExpanded && (
          <div className="rounded bg-black/30 border border-white/5 p-2.5 max-h-64 overflow-y-auto">
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-white/75">{r.body}</pre>
          </div>
        )}

        {/* Inline Live Build Tracker Bar if this tag is actively selected */}
        {isWatchTarget && currentStep === 1 && (
          <div className="mt-2 p-2.5 rounded bg-sky-950/30 border border-sky-500/30 text-xs flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2Icon className="size-3.5 animate-spin text-sky-400" />
              <span className="font-mono text-[11px] text-sky-200">
                {build ? `Actions Run "${build.name}": status is ${build.status} (${build.durationSeconds ?? 0}s elapsed)` : "Monitoring GitHub Actions release workflow..."}
              </span>
            </div>
            <span className="text-[11px] font-mono text-sky-400/80">Polling live · {Math.round(pollDelayRef.current / 1000)}s</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* STAGED-AND-READY BANNER — set by the background watcher's auto-download
          (or a manual "Update to"). One click here runs the same supervisor
          handoff the per-row Activate uses. Hidden while an activation is in
          flight (the pipeline card below owns the screen then). */}
      {pending && !activeUpdateTag && (
        <GlassPanel className="p-6 space-y-4 border-emerald-500/30 bg-emerald-500/[0.03]">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0">
              <ShieldCheckIcon className="size-5 shrink-0 text-emerald-400 mt-0.5" />
              <div className="min-w-0">
                <h3 className="font-display text-sm font-semibold tracking-wide text-white">
                  Update <span className="font-mono text-emerald-400">{pending.tag}</span> is downloaded &amp; verified
                </h3>
                <p className="text-muted-foreground text-xs mt-0.5">
                  Ready — the new build is staged on disk. {applyEstimateLabel(info.lastActivation, !!info.pendingMigrations?.length)}; ShowFlow restarts briefly. Do it now or later.
                </p>
                <p className="text-[11px] text-muted-foreground/70 mt-1 font-mono">
                  releaseId {pending.releaseId.slice(0, 12)} · staged {new Date(pending.stagedAt).toLocaleString()}
                </p>
              </div>
            </div>
            <Button
              variant="default"
              size="sm"
              className="shrink-0"
              disabled={actionLoading !== null}
              onClick={() => doActivate(pending.releaseId, pending.tag)}
            >
              {actionLoading === `activate-${pending.releaseId}` ? (
                <Loader2Icon className="size-3.5 animate-spin mr-1.5" />
              ) : (
                <PlayIcon className="size-3.5 mr-1.5" />
              )}
              Activate
            </Button>
          </div>
          {info.lastActivation && info.lastActivation.releaseId === pending.releaseId && (info.lastActivation.outcome === "rolled-back" || info.lastActivation.outcome === "failed") && (
            <div role="alert" className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-xs text-red-300">
              <AlertCircleIcon className="size-3.5 shrink-0 mt-0.5" />
              <span>{info.lastActivation.message ?? "The last activation of this release failed."} Auto-activate skips this build; you can retry manually.</span>
            </div>
          )}
          {info.activation && info.activation.releaseId === pending.releaseId && info.activation.phase !== "failed" && (
            <div className="flex items-center gap-2 rounded border border-signal/30 bg-signal/[0.05] px-3 py-2 text-xs text-white/85">
              <Loader2Icon className="size-3.5 shrink-0 animate-spin text-signal" />
              <span>
                {info.activation.auto ? "Auto-activating · " : ""}
                {ACTIVATION_PHASE_LABEL[info.activation.phase] ?? info.activation.phase}: {info.activation.detail}
              </span>
            </div>
          )}
          <ul className="space-y-1 text-[11px] text-muted-foreground">
            {info.pendingMigrations && info.pendingMigrations.length > 0 && (
              <li>
                Includes {info.pendingMigrations.length} database migration{info.pendingMigrations.length === 1 ? "" : "s"} — a backup is taken automatically before activating.
              </li>
            )}
            {info.pendingMigrations === null && <li>Couldn't read this build's migration list — a backup will be taken before activating, to be safe.</li>}
            {info.busy && info.busy.length > 0 && (
              <li>Activating waits (up to 2 min) for: {info.busy.join(", ")}.</li>
            )}
            <li>Nothing is downloaded when you click Activate — it's just the restart. TorBox downloads resume afterwards, and a failed health check rolls back automatically.</li>
          </ul>
          {pending.notes && (
            <details open className="rounded bg-black/30 border border-white/5">
              <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground font-mono select-none">Release notes</summary>
              <pre className="whitespace-pre-wrap px-3 pb-3 font-mono text-[11px] leading-relaxed text-white/75 max-h-64 overflow-y-auto">{pending.notes}</pre>
            </details>
          )}
        </GlassPanel>
      )}

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
            <Button variant="ghost" size="sm" onClick={() => setActiveUpdateTag(null)} className="text-white/60 hover:text-white text-xs">
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
                  : "bg-white/[0.01] border-white/5 text-white/60"
            }`}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] uppercase font-semibold">1. CI Build</span>
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
                  : "bg-white/[0.01] border-white/5 text-white/60"
            }`}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] uppercase font-semibold">2. Download</span>
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
                  : "bg-white/[0.01] border-white/5 text-white/60"
            }`}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] uppercase font-semibold">3. Activate</span>
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
                  : "bg-white/[0.01] border-white/5 text-white/60"
            }`}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] uppercase font-semibold">4. Refresh</span>
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
              {stepStatus === "error" && <span className="text-red-400 font-semibold text-[11px]">Failed</span>}
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

      {err && <ErrorNotice error={err} what="update status" onRetry={() => fetchAll()} />}

      {/* AVAILABLE RELEASES LIST */}
      <GlassPanel className="p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1 basis-56">
            <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Available Releases</h3>
            <p className="text-muted-foreground text-xs mt-0.5">Published GitHub releases with showflow + manifest.json assets</p>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <label className="flex items-center gap-2 cursor-pointer select-none" title="When on, a newly published release is auto-downloaded and verified in the background, then waits for you to Activate.">
              <span className="text-[11px] text-muted-foreground font-mono">Auto-download</span>
              <Switch checked={autoDownload} onCheckedChange={toggleAutoDownload} />
            </label>
            <label className="flex items-center gap-2 select-none" title="Activate a staged release by itself — only when nothing is importing or scanning. Off by default.">
              <span className="text-[11px] text-muted-foreground font-mono">Auto-activate</span>
              <select
                aria-label="Auto-activate staged releases"
                className="h-7 rounded-md border border-white/10 bg-black/40 px-2 text-[11px] font-mono text-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
                value={info.autoActivate?.mode === "window" ? `window:${info.autoActivate.hour}` : (info.autoActivate?.mode ?? "off")}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v.startsWith("window:")) saveAutoActivate({ mode: "window", hour: Number(v.slice(7)) });
                  else saveAutoActivate({ mode: v as "off" | "idle", hour: info.autoActivate?.hour ?? 4 });
                }}
              >
                <option value="off">Off</option>
                <option value="idle">When idle</option>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={`window:${h}`}>Nightly {String(h).padStart(2, "0")}:00 (idle)</option>
                ))}
              </select>
            </label>
            <Button variant="ghost" size="sm" onClick={() => runCheck({ force: true, note: true })} disabled={checking} title="Check GitHub for a new release now">
              {checking ? <Loader2Icon className="size-3.5 animate-spin mr-1.5" /> : <RadioIcon className="size-3.5 mr-1.5" />}
              Check now
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground/70">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
          </span>
          Watching the Releases feed automatically (this panel checks every ~20s while open; every 15 min in the background).
          {checkNote && <span className="text-signal"> {checkNote}</span>}
        </div>
        {info.autoActivate?.mode === "window" && info.serverTime && (
          <p className="text-[11px] font-mono text-muted-foreground">
            Nightly window uses the server's clock (now {info.serverTime.slice(16, 21)}); it's skipped if ShowFlow is busy for the whole hour.
          </p>
        )}
        {busyDownload && info.download && !activeUpdateTag && (
          <div className="rounded-lg border border-signal/30 bg-signal/[0.04] p-3 space-y-2">
            <div className="flex items-center justify-between text-[11px] font-mono text-white/85">
              <span>
                {info.download.phase === "verifying" ? "Verifying" : info.download.phase === "resolving" ? "Resolving" : "Downloading"} {info.download.tag ?? "release"}
                {info.download.attempt > 1 ? ` (attempt ${info.download.attempt})` : ""}
              </span>
              {info.download.totalBytes ? <span>{formatMb(info.download.receivedBytes)} / {formatMb(info.download.totalBytes)}</span> : null}
            </div>
            <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden" role="progressbar" aria-label="Release download progress"
              aria-valuenow={info.download.totalBytes ? Math.round((info.download.receivedBytes / info.download.totalBytes) * 100) : undefined}>
              <div className="bg-signal h-full transition-all duration-300 rounded-full"
                style={{ width: `${info.download.phase === "verifying" ? 100 : info.download.totalBytes ? Math.round((info.download.receivedBytes / info.download.totalBytes) * 100) : 5}%` }} />
            </div>
          </div>
        )}
        {info.downloadFailure && !pending && (
          <p className="text-[11px] font-mono text-amber-300">
            {info.downloadFailure.tag}: {info.downloadFailure.message} — retrying automatically at {new Date(info.downloadFailure.nextRetryAt).toLocaleTimeString()}.
          </p>
        )}
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
            {visibleReleases.map(renderReleaseRow)}
            {olderReleases.length > 0 && (
              <div className="rounded-lg border border-white/5 overflow-hidden">
                <button
                  onClick={() => setShowOlder(v => !v)}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-white/[0.02] transition-colors"
                >
                  <span className="font-mono">
                    {showOlder ? "Hide" : "Show"} previous releases ({olderReleases.length})
                  </span>
                  <ChevronDownIcon className={`size-3.5 transition-transform ${showOlder ? "" : "-rotate-90"}`} />
                </button>
                {showOlder && (
                  <div className="space-y-2 p-2 pt-0">
                    {olderReleases.map(renderReleaseRow)}
                  </div>
                )}
              </div>
            )}
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

      {/* SUPERVISOR STATUS CARD */}
      <GlassPanel className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Update Status</h3>
            <p className="text-muted-foreground text-xs mt-0.5">Current state from the supervisor</p>
          </div>
          <div className="flex items-center gap-1">
            <Button aria-label="Refresh" variant="ghost" size="sm" onClick={() => fetchAll()} disabled={loading}>
              <RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
        {status && (
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-white/[0.03] p-3 border border-white/5">
              <span className="font-mono text-[11px] text-white/60">Active</span>
              <p className="font-mono text-xs text-white/90 mt-0.5">{status.activeReleaseId ? status.activeReleaseId.slice(0, 12) : "—"}</p>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-3 border border-white/5">
              <span className="font-mono text-[11px] text-white/60">Phase</span>
              <p className="font-mono text-xs text-signal mt-0.5 capitalize">{status.phase || "—"}</p>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-3 border border-white/5">
              <span className="font-mono text-[11px] text-white/60">App Version</span>
              <p className="font-mono text-xs text-white/90 mt-0.5">{status.appVersion || "—"}</p>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-3 border border-white/5">
              <span className="font-mono text-[11px] text-white/60">lastKnownGood</span>
              <p className="font-mono text-xs text-white/90 mt-0.5">{status.lastKnownGood ? status.lastKnownGood.slice(0, 12) : "—"}</p>
            </div>
          </div>
        )}
        {!status && !loading && (
          <div className="rounded-lg bg-white/[0.03] p-4 border border-dashed border-white/10 text-center">
            <p className="font-mono text-xs text-muted-foreground">Could not reach supervisor status</p>
          </div>
        )}
      </GlassPanel>
    </div>
  );
}

