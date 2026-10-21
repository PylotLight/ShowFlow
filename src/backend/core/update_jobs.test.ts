import { test, expect, describe } from "bun:test";
import { UpdateCoordinator, UpdateBusyError, sameRelease } from "./update_jobs";

type R = { ok: boolean; message: string; releaseId?: string };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("sameRelease", () => {
  test("sha wins when both sides know it", () => {
    expect(sameRelease({ tag: "v1", releaseId: "a" }, { tag: "v1", releaseId: "b" })).toBe(false);
    expect(sameRelease({ tag: "v1", releaseId: "a" }, { tag: "v2", releaseId: "a" })).toBe(true);
  });
  test("falls back to the tag, ignoring a leading v", () => {
    expect(sameRelease({ tag: "v0.1.90" }, { tag: "0.1.90", releaseId: "abc" })).toBe(true);
    expect(sameRelease({ tag: "v0.1.90" }, { tag: "v0.1.91" })).toBe(false);
    expect(sameRelease({}, {})).toBe(false);
  });
});

describe("UpdateCoordinator downloads", () => {
  test("a second download of the same release joins the running job (one fetch)", async () => {
    const c = new UpdateCoordinator<R>();
    const d = deferred<R>();
    let calls = 0;
    const fn = () => { calls++; return d.promise; };
    const auto = c.download({ tag: "v0.1.90" }, "auto", fn);
    await tick();
    expect(c.phase()).toBe("downloading");
    const manual = c.download({ tag: "v0.1.90", releaseId: "sha1" }, "manual", fn);
    await tick();
    expect(c.currentDownload()?.joiners).toBe(1);
    d.resolve({ ok: true, message: "staged", releaseId: "sha1" });
    const [a, m] = await Promise.all([auto, manual]);
    expect(calls).toBe(1);
    expect(a.joined).toBe(false);
    expect(m.joined).toBe(true);
    expect(m.result.releaseId).toBe("sha1");
    expect(c.phase()).toBe("idle");
  });

  test("a by-sha caller joins a by-tag job once its sha is resolved", async () => {
    const c = new UpdateCoordinator<R>();
    const d = deferred<R>();
    const first = c.download({ tag: "v0.1.90" }, "auto", async (h) => { h.setReleaseId("sha1"); return d.promise; });
    await tick();
    const second = c.download({ tag: "different-title", releaseId: "sha1" }, "manual", () => Promise.resolve({ ok: false, message: "should not run" }));
    await tick();
    d.resolve({ ok: true, message: "ok", releaseId: "sha1" });
    expect((await second).joined).toBe(true);
    expect((await first).result.ok).toBe(true);
  });

  test("a different release waits for the running one (one job at a time)", async () => {
    const c = new UpdateCoordinator<R>();
    const d1 = deferred<R>();
    const order: string[] = [];
    const one = c.download({ tag: "v1" }, "auto", async () => { order.push("start v1"); const r = await d1.promise; order.push("end v1"); return r; });
    const two = c.download({ tag: "v2" }, "manual", async () => { order.push("start v2"); return { ok: true, message: "v2" }; });
    await tick();
    expect(order).toEqual(["start v1"]);
    expect(c.currentDownload()?.tag).toBe("v1");
    d1.resolve({ ok: true, message: "v1" });
    await Promise.all([one, two]);
    expect(order).toEqual(["start v1", "end v1", "start v2"]);
  });

  test("joiners see a failed download too, and the slot frees", async () => {
    const c = new UpdateCoordinator<R>();
    const d = deferred<R>();
    const a = c.download({ tag: "v1" }, "auto", () => d.promise);
    const b = c.download({ tag: "v1" }, "manual", () => d.promise);
    d.promise.catch(() => {}); // the test's own handle, not the coordinator's
    d.reject(new Error("404"));
    await expect(a).rejects.toThrow("404");
    await expect(b).rejects.toThrow("404");
    expect(c.phase()).toBe("idle");
  });

  test("the slot is free by the time the downloader resumes (so it can activate right after)", async () => {
    const c = new UpdateCoordinator<R>();
    await c.download({ tag: "v1" }, "auto", async () => ({ ok: true, message: "ok" }));
    expect(c.currentDownload()).toBeNull();
    expect(c.beginActivation({ releaseId: "sha1", tag: "v1", source: "auto" })).toBe(true);
  });
});

describe("UpdateCoordinator activation", () => {
  test("only one activation can hold the slot", () => {
    const c = new UpdateCoordinator<R>();
    expect(c.beginActivation({ releaseId: "a", tag: "v1", source: "auto" })).toBe(true);
    expect(c.beginActivation({ releaseId: "a", tag: "v1", source: "manual" })).toBe(false);
    c.endActivation("other");
    expect(c.phase()).toBe("activating");
    c.endActivation("a");
    expect(c.phase()).toBe("idle");
  });

  test("new downloads are refused while activating", async () => {
    const c = new UpdateCoordinator<R>();
    c.beginActivation({ releaseId: "a", tag: "v1", source: "auto" });
    await expect(c.download({ tag: "v2" }, "manual", async () => ({ ok: true, message: "" }))).rejects.toBeInstanceOf(UpdateBusyError);
  });

  test("activation waits for an in-flight download, which still completes for the joined caller", async () => {
    // The v0.1.89 race: watcher staged, auto-activate fired, manual request still open.
    const c = new UpdateCoordinator<R>();
    const d = deferred<R>();
    const manual = c.download({ tag: "v0.1.90", releaseId: "sha1" }, "manual", () => d.promise);
    await tick();
    expect(c.beginActivation({ releaseId: "sha1", tag: "v0.1.90", source: "auto" })).toBe(true);
    // A same-release download during the wait still joins (no busy error).
    const joiner = c.download({ tag: "v0.1.90" }, "auto", () => Promise.resolve({ ok: false, message: "no" }));
    let handedOff = false;
    const activation = c.waitForDownloads().then(() => { handedOff = true; });
    await tick();
    expect(handedOff).toBe(false);
    d.resolve({ ok: true, message: "staged", releaseId: "sha1" });
    const m = await manual;
    expect(m.result.ok).toBe(true);
    expect((await joiner).joined).toBe(true);
    await activation;
    expect(handedOff).toBe(true);
  });

  test("waitForDownloads also waits for a download queued behind the first", async () => {
    const c = new UpdateCoordinator<R>();
    const d1 = deferred<R>();
    const d2 = deferred<R>();
    c.download({ tag: "v1" }, "auto", () => d1.promise);
    c.download({ tag: "v2" }, "manual", () => d2.promise);
    await tick();
    let done = false;
    const w = c.waitForDownloads().then(() => { done = true; });
    d1.resolve({ ok: true, message: "" });
    await tick(); await tick();
    expect(done).toBe(false);
    expect(c.currentDownload()?.tag).toBe("v2");
    d2.resolve({ ok: true, message: "" });
    await w;
    expect(done).toBe(true);
  });
});

describe("UpdateCoordinator instant overlay", () => {
  test("same release joins, a different one is refused, and it holds downloadBusy until activation", () => {
    const c = new UpdateCoordinator<R>();
    const a = c.beginInstant({ tag: "v1" }, "manual");
    expect(a?.joined).toBe(false);
    expect(c.beginInstant({ tag: "v1" }, "manual")?.joined).toBe(true);
    expect(c.beginInstant({ tag: "v2" }, "manual")).toBeNull();
    expect(c.downloadBusy()).toBe(true);
    c.updateInstant({ step: "activate", releaseId: "sha1" });
    c.beginActivation({ releaseId: "sha1", tag: "v1", source: "manual" });
    expect(c.downloadBusy()).toBe(false);
    expect(c.phase()).toBe("activating");
  });

  test("a finished instant job lingers for the panel, then clears", async () => {
    const c = new UpdateCoordinator<R>(() => new Date(), 5);
    c.beginInstant({ tag: "v1" }, "manual");
    c.updateInstant({ step: "failed", message: "boom" });
    expect(c.snapshot().instant?.step).toBe("failed");
    expect(c.downloadBusy()).toBe(false);
    // A new instant update can start right away.
    expect(c.beginInstant({ tag: "v2" }, "manual")?.joined).toBe(false);
    c.updateInstant({ step: "done" });
    await new Promise((r) => setTimeout(r, 15));
    expect(c.snapshot().instant).toBeNull();
  });

  test("refused while another release is activating", () => {
    const c = new UpdateCoordinator<R>();
    c.beginActivation({ releaseId: "sha0", tag: "v0", source: "auto" });
    expect(c.beginInstant({ tag: "v1" }, "manual")).toBeNull();
    expect(c.beginInstant({ tag: "v0" }, "manual")?.joined).toBe(false);
  });
});
