// Stop-start activation sequence. Exclusive DB ownership, not blue-green
// overlap: the old process fully exits (closing its own DB connection)
// before the candidate ever opens showflow.db.

import { readManifest, verifyArtifact, releasePath, writeStateAtomic, readState, SUPERVISOR_VERSION, compareVersions, type Phase } from "./state";

interface RunningChild {
  process: Bun.Subprocess;
  port: number;
  releaseId: string;
}

export class ReleaseManager {
  private current: RunningChild | null = null;
  phase: Phase = "starting";
  private activating = false;

  /** Port to proxy public traffic to, or null while nothing is stable. */
  get activePort(): number | null {
    return this.phase === "stable" && this.current ? this.current.port : null;
  }

  get activeReleaseId(): string | null {
    return this.current?.releaseId ?? null;
  }

  /** The currently active child process, if any. Used by the SIGTERM handler to forward the signal. */
  get activeProcess(): Bun.Subprocess | null {
    return this.current?.process ?? null;
  }

  /**
   * Activate `releaseId`. Serialized — a second call while one is already
   * in flight is rejected rather than silently interleaving two stop-start
   * sequences against the same child process.
   */
  async activate(releaseId: string, opts: { isRestore?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
    if (this.activating) {
      return { ok: false, message: "An activation is already in progress." };
    }
    this.activating = true;
    try {
      return await this.runActivation(releaseId, opts.isRestore ?? false);
    } finally {
      this.activating = false;
    }
  }

  private async runActivation(releaseId: string, isRestore: boolean): Promise<{ ok: boolean; message: string }> {
    const dir = releasePath(releaseId);
    const manifest = await readManifest(dir);
    if (!manifest) {
      return { ok: false, message: `No manifest.json found for release "${releaseId}".` };
    }
    if (!(await verifyArtifact(dir, manifest))) {
      return { ok: false, message: `Artifact checksum mismatch for release "${releaseId}" — refusing to activate.` };
    }
    if (manifest.minimumSupervisorVersion && compareVersions(SUPERVISOR_VERSION, manifest.minimumSupervisorVersion) < 0) {
      return {
        ok: false,
        message: `Supervisor version ${SUPERVISOR_VERSION} is too old for release "${releaseId}" (requires ${manifest.minimumSupervisorVersion}). ` +
          `The pod's image must be rebuilt with a newer supervisor.`,
      };
    }

    this.phase = "quiescing";
    await writeStateAtomic({ phase: "quiescing", candidate: releaseId });
    await this.quiesceAndStop(this.current);
    this.current = null;
    this.phase = "stopped";
    await writeStateAtomic({ phase: "stopped" });

    this.phase = "starting";
    await writeStateAtomic({ phase: "starting" });
    const port = 19000 + Math.floor(Math.random() * 1000);
    let candidateProc: Bun.Subprocess;
    try {
      candidateProc = Bun.spawn([`${dir}/${manifest.artifact.name}`], {
        // Identity comes from the binary's own compiled-in __BUILD_* consts,
        // not this env var — PORT is the only thing the child actually
        // needs from its environment to know where to listen.
        env: { ...Bun.env, PORT: String(port) },
        stdout: "inherit",
        stderr: "inherit",
      });
    } catch (err) {
      this.phase = "restoring";
      return this.handleFailedStart(releaseId, isRestore, `Failed to spawn release "${releaseId}": ${String(err)}`);
    }

    const ok = await this.waitReadyRepeated(port, manifest);
    if (!ok) {
      try { candidateProc.kill("SIGKILL"); } catch {}
      return this.handleFailedStart(releaseId, isRestore, `Release "${releaseId}" failed readiness checks.`);
    }

    this.current = { process: candidateProc, port, releaseId };
    this.phase = "stable";
    this.watchForCrash(candidateProc, releaseId);
    await writeStateAtomic({
      active: releaseId,
      lastKnownGood: releaseId,
      candidate: undefined,
      phase: "stable",
    });
    return { ok: true, message: `Release "${releaseId}" is active.` };
  }

  private async handleFailedStart(releaseId: string, isRestore: boolean, message: string): Promise<{ ok: boolean; message: string }> {
    if (isRestore) {
      // Already relaunching lastKnownGood and it still failed — don't loop
      // forever. Surface this loudly; there is nothing safe left to fall
      // back to automatically.
      this.phase = "restoring";
      await writeStateAtomic({ phase: "restoring" });
      return { ok: false, message: `${message} lastKnownGood also failed to start — manual intervention required.` };
    }
    this.phase = "restoring";
    await writeStateAtomic({ phase: "restoring" });
    const state = await readState();
    if (!state.lastKnownGood) {
      return { ok: false, message: `${message} No lastKnownGood release recorded to relaunch.` };
    }
    console.error(`[supervisor] ${message} Relaunching lastKnownGood "${state.lastKnownGood}".`);
    return this.runActivation(state.lastKnownGood, true);
  }

  private async quiesceAndStop(child: RunningChild | null, deadlineMs = 10_000): Promise<void> {
    if (!child) return;
    child.process.kill("SIGTERM"); // old process closes its own DB connection on receipt
    const exited = await Promise.race([
      child.process.exited.then(() => true),
      Bun.sleep(deadlineMs).then(() => false),
    ]);
    if (!exited) child.process.kill("SIGKILL");
  }

  private async waitReadyRepeated(port: number, manifest: { commit: string; readyPath: string }, passesNeeded = 3): Promise<boolean> {
    let passes = 0;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${manifest.readyPath}`);
        const body = await res.json();
        if (res.ok && body.ready && body.releaseId === manifest.commit) {
          passes++;
          if (passes >= passesNeeded) return true;
        } else {
          passes = 0;
        }
      } catch {
        passes = 0;
      }
      await Bun.sleep(300);
    }
    return false;
  }

  /**
   * Detects the child dying on its own while `stable` — distinct from the
   * supervisor-initiated SIGTERM in quiesceAndStop(), which must not
   * trigger this (that exit is expected, not a crash). Guards against a
   * stale listener firing after activate() has already superseded this
   * process by checking `this.current` still points at the same one.
   */
  private watchForCrash(proc: Bun.Subprocess, releaseId: string): void {
    proc.exited.then(async (code) => {
      if (this.current?.process !== proc) return; // expected exit, already superseded
      if (this.phase !== "stable") return; // exit happened as part of a normal activate()
      console.error(`[supervisor] release "${releaseId}" exited unexpectedly (code ${code}) while stable.`);
      this.current = null;
      this.phase = "restoring";
      await writeStateAtomic({ phase: "restoring" });
      const state = await readState();
      if (!state.lastKnownGood) {
        console.error("[supervisor] no lastKnownGood to relaunch — manual intervention required.");
        return;
      }
      await this.activate(state.lastKnownGood, { isRestore: true });
    });
  }
}


