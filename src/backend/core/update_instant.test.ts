import { test, expect, describe } from "bun:test";
import { UpdateCoordinator, UpdateBusyError } from "./update_jobs";
import { startInstantUpdate, type InstantDeps } from "./update_instant";
import type { StageResult } from "./updates_manager";
import type { ActivationOutcome } from "./update_activation";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(over: Partial<InstantDeps> = {}) {
  const jobs = new UpdateCoordinator<StageResult>();
  const calls: string[] = [];
  const staged: Array<[string, string]> = [];
  const deps: InstantDeps = {
    jobs,
    download: async (id) => {
      calls.push(`download ${id}`);
      const { result } = await jobs.download({ tag: "v0.1.90" }, "manual", async () => ({ ok: true, message: "staged", releaseId: "sha90" }));
      return { ...result, tag: "v0.1.90" };
    },
    recordStaged: async (tag, rid) => { staged.push([tag, rid]); },
    activate: (rid, tag) => {
      calls.push(`activate ${rid} ${tag}`);
      if (!jobs.beginActivation({ releaseId: rid, tag, source: "manual" })) return { ok: false, message: "already activating" };
      return { ok: true, message: "started", done: Promise.resolve<ActivationOutcome>("handed-off") };
    },
    ...over,
  };
  return { jobs, calls, staged, deps };
}

describe("instant update", () => {
  test("download → verify → record staged → activate, in one go", async () => {
    const h = harness();
    const r = startInstantUpdate({ githubReleaseId: 90, tag: "v0.1.90" }, "manual", h.deps);
    expect(r.ok).toBe(true);
    const end = await r.done;
    expect(h.calls).toEqual(["download 90", "activate sha90 v0.1.90"]);
    expect(h.staged).toEqual([["v0.1.90", "sha90"]]);
    expect(end?.step).toBe("activate");
    expect(end?.releaseId).toBe("sha90");
    expect(h.jobs.phase()).toBe("activating"); // slot kept until the restart
  });

  test("a second click on the same release joins; another release is refused", async () => {
    const h = harness();
    const gate = deferred<void>();
    h.deps.download = async () => { await gate.promise; return { ok: true, message: "", releaseId: "sha90", tag: "v0.1.90" }; };
    const first = startInstantUpdate({ githubReleaseId: 90, tag: "v0.1.90" }, "manual", h.deps);
    const again = startInstantUpdate({ githubReleaseId: 90, tag: "v0.1.90" }, "manual", h.deps);
    const other = startInstantUpdate({ githubReleaseId: 91, tag: "v0.1.91" }, "manual", h.deps);
    expect(again).toMatchObject({ ok: true, joined: true });
    expect(other.ok).toBe(false);
    gate.resolve();
    await first.done;
  });

  test("download failure stops before activation and reports the reason", async () => {
    const h = harness();
    h.deps.download = async () => ({ ok: false, message: "sha256 mismatch", tag: "v0.1.90" });
    const r = startInstantUpdate({ githubReleaseId: 90, tag: "v0.1.90" }, "manual", h.deps);
    const end = await r.done;
    expect(end?.step).toBe("failed");
    expect(end?.message).toBe("sha256 mismatch");
    expect(h.calls).toEqual([]);
    expect(h.jobs.phase()).toBe("idle");
    expect(h.jobs.downloadBusy()).toBe(false);
  });

  test("a failed activation (backup / supervisor pre-flight) is reported and frees the slot", async () => {
    const h = harness();
    h.deps.activate = (rid, tag) => {
      h.jobs.beginActivation({ releaseId: rid, tag, source: "manual" });
      const done = Promise.resolve().then(() => { h.jobs.endActivation(rid); return "failed" as ActivationOutcome; });
      return { ok: true, message: "", done };
    };
    h.deps.activationError = () => "Pre-update backup failed (disk full)";
    const end = await startInstantUpdate({ githubReleaseId: 90, tag: "v0.1.90" }, "manual", h.deps).done;
    expect(end?.step).toBe("failed");
    expect(end?.message).toContain("disk full");
    expect(h.jobs.phase()).toBe("idle");
  });

  test("already running that release: done, no activation", async () => {
    const h = harness();
    h.deps.download = async () => ({ ok: false, alreadyActive: true, message: "Already running v0.1.90", releaseId: "sha90", tag: "v0.1.90" });
    const end = await startInstantUpdate({ githubReleaseId: 90, tag: "v0.1.90" }, "manual", h.deps).done;
    expect(end?.step).toBe("done");
    expect(h.calls).toEqual([]);
  });

  test("joins the watcher's in-flight download instead of fetching twice, and auto-activate can't cut in", async () => {
    const h = harness();
    const gate = deferred<StageResult>();
    let fetches = 0;
    // Background watcher starts first.
    const watcher = h.jobs.download({ tag: "v0.1.90" }, "auto", () => { fetches++; return gate.promise; });
    await tick();
    h.deps.download = async () => {
      const { result, joined } = await h.jobs.download({ tag: "v0.1.90", releaseId: "sha90" }, "manual", async () => { fetches++; return { ok: true, message: "", releaseId: "sha90" }; });
      return { ...result, joined, tag: "v0.1.90" };
    };
    const r = startInstantUpdate({ githubReleaseId: 90, tag: "v0.1.90" }, "manual", h.deps);
    await tick();
    // What maybeAutoActivate checks: a download / instant update holds the slot.
    expect(h.jobs.downloadBusy()).toBe(true);
    gate.resolve({ ok: true, message: "", releaseId: "sha90" });
    await watcher;
    // Between the shared download finishing and the instant activation,
    // the instant job still holds the slot.
    expect(h.jobs.downloadBusy() || h.jobs.phase() === "activating").toBe(true);
    const end = await r.done;
    expect(fetches).toBe(1);
    expect(end?.step).toBe("activate");
  });

  test("follows an activation of the same release that's already running", () => {
    const h = harness();
    h.jobs.beginActivation({ releaseId: "sha90", tag: "v0.1.90", source: "auto" });
    const r = startInstantUpdate({ githubReleaseId: 90, tag: "v0.1.90" }, "manual", h.deps);
    expect(r).toMatchObject({ ok: true, joined: true });
    expect(h.jobs.snapshot().instant).toMatchObject({ step: "activate", releaseId: "sha90" });
    expect(startInstantUpdate({ githubReleaseId: 91, tag: "v0.1.91" }, "manual", h.deps).ok).toBe(false);
  });

  test("an activation that claims the slot mid-download: follow it when it's this release", async () => {
    const h = harness();
    h.deps.download = async () => { throw new UpdateBusyError({ releaseId: "sha90", tag: "v0.1.90", source: "auto", startedAt: "" }); };
    const end = await startInstantUpdate({ githubReleaseId: 90, tag: "v0.1.90" }, "manual", h.deps).done;
    expect(end?.step).toBe("activate");
    const h2 = harness();
    h2.deps.download = async () => { throw new UpdateBusyError({ releaseId: "sha89", tag: "v0.1.89", source: "auto", startedAt: "" }); };
    const end2 = await startInstantUpdate({ githubReleaseId: 90, tag: "v0.1.90" }, "manual", h2.deps).done;
    expect(end2?.step).toBe("failed");
  });
});
