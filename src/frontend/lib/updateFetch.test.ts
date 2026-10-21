import { test, expect, describe } from "bun:test";
import { classifyResponse, updateFetch, isRestartStatus, sameVersion, normalizeVersion, resolveRecovery } from "./updateFetch";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("classifyResponse", () => {
  test("old supervisor's plain-text 503 is a restart, not a JSON SyntaxError", async () => {
    const r = await classifyResponse(new Response("Service Unavailable", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } }));
    expect(r).toEqual({ kind: "restarting", status: 503, reason: "Service Unavailable" });
  });

  test("new supervisor's JSON 503 { restarting: true } is a restart", async () => {
    const r = await classifyResponse(json({ error: "Service Unavailable", message: "ShowFlow is restarting, retry shortly.", restarting: true }, 503));
    expect(r.kind).toBe("restarting");
  });

  test("ingress 502/504 HTML pages and empty bodies are restarts", async () => {
    expect((await classifyResponse(new Response("<html>Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }))).kind).toBe("restarting");
    expect((await classifyResponse(new Response("", { status: 504 }))).kind).toBe("restarting");
  });

  test("the app's own JSON 502 (e.g. GitHub failed during install) is a real error", async () => {
    const r = await classifyResponse(json({ error: "GitHub release 1 not found (404)." }, 502));
    expect(r).toMatchObject({ kind: "error", status: 502, message: "GitHub release 1 not found (404)." });
  });

  test("JSON 4xx carries its message and data", async () => {
    const r = await classifyResponse(json({ ok: false, message: "An activation is already in progress." }, 409));
    expect(r).toMatchObject({ kind: "error", status: 409, message: "An activation is already in progress.", data: { ok: false } });
  });

  test("non-JSON on a non-gateway status is an error with a readable message", async () => {
    const r = await classifyResponse(new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(r).toMatchObject({ kind: "error", status: 200 });
    if (r.kind === "error") expect(r.message).toContain("HTML page");
  });

  test("2xx JSON is ok", async () => {
    const r = await classifyResponse(json({ ok: true, releaseId: "abc" }));
    expect(r).toEqual({ kind: "ok", status: 200, data: { ok: true, releaseId: "abc" } });
  });

  test("JSON body without a JSON content-type still parses", async () => {
    const r = await classifyResponse(new Response('{"a":1}', { status: 200, headers: { "content-type": "text/plain" } }));
    expect(r).toEqual({ kind: "ok", status: 200, data: { a: 1 } });
  });
});

describe("updateFetch", () => {
  test("network failure (connection refused mid-swap) is a restart", async () => {
    const r = await updateFetch("/x", undefined, async () => { throw new TypeError("Failed to fetch"); });
    expect(r).toEqual({ kind: "restarting", status: null, reason: "Failed to fetch" });
  });

  test("aborts are rethrown", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(updateFetch("/x", undefined, async () => { throw abort; })).rejects.toBe(abort);
  });

  test("passes the response through classification", async () => {
    const r = await updateFetch("/x", undefined, async () => new Response("Service Unavailable", { status: 503 }));
    expect(r.kind).toBe("restarting");
  });
});

test("isRestartStatus", () => {
  expect([502, 503, 504].every(isRestartStatus)).toBe(true);
  expect([200, 400, 404, 409, 500].some(isRestartStatus)).toBe(false);
});

test("version comparison ignores the v prefix", () => {
  expect(normalizeVersion(" v0.1.89 ")).toBe("0.1.89");
  expect(sameVersion("v0.1.89", "0.1.89")).toBe(true);
  expect(sameVersion("v0.1.88", "v0.1.89")).toBe(false);
  expect(sameVersion(null, null)).toBe(false);
});

describe("resolveRecovery", () => {
  const byTag = { releaseId: null, tag: "v0.1.89" };

  test("running version == target tag is applied (the v0.1.88 -> v0.1.89 case)", () => {
    expect(resolveRecovery(byTag, { ready: { releaseId: "deadbeef", version: "v0.1.89" } })).toEqual({ kind: "applied" });
  });

  test("releaseId match from /internal/ready is applied", () => {
    expect(resolveRecovery({ releaseId: "abc", tag: null }, { ready: { releaseId: "abc" } })).toEqual({ kind: "applied" });
  });

  test("supervisor stable on the target is applied even if the binary stamp is off", () => {
    expect(resolveRecovery({ releaseId: "abc", tag: "v0.1.89" }, { ready: { releaseId: "main", version: "main" }, status: { activeReleaseId: "abc", phase: "stable" } })).toEqual({ kind: "applied" });
    expect(resolveRecovery(byTag, { status: { phase: "stable", appVersion: "v0.1.89" } })).toEqual({ kind: "applied" });
  });

  test("applied beats a stale failure record", () => {
    expect(resolveRecovery(byTag, {
      ready: { version: "v0.1.89" },
      pending: { lastActivation: { releaseId: "x", tag: "v0.1.89", outcome: "failed", message: "nope" } },
    })).toEqual({ kind: "applied" });
  });

  test("rollback of the target is a failure", () => {
    expect(resolveRecovery(byTag, {
      ready: { version: "v0.1.88" },
      pending: { lastActivation: { releaseId: "x", tag: "v0.1.89", outcome: "rolled-back", message: "readiness failed" } },
    })).toEqual({ kind: "failed", message: "readiness failed" });
  });

  test("activation / download / staged states are followed, not failed", () => {
    expect(resolveRecovery(byTag, { pending: { activation: { releaseId: "x", tag: "v0.1.89", phase: "draining", detail: "waiting" } } }))
      .toEqual({ kind: "activating", releaseId: "x", phase: "draining", detail: "waiting" });
    expect(resolveRecovery(byTag, { pending: { download: { tag: "v0.1.89", phase: "downloading" } } })).toEqual({ kind: "downloading", phase: "downloading" });
    expect(resolveRecovery(byTag, { pending: { pending: { releaseId: "x", tag: "v0.1.89" } } })).toEqual({ kind: "staged", releaseId: "x" });
  });

  test("other releases' state is ignored", () => {
    expect(resolveRecovery(byTag, {
      ready: { version: "v0.1.88" },
      pending: { lastActivation: { releaseId: "y", tag: "v0.1.88", outcome: "failed" }, download: { tag: "v0.1.90", phase: "downloading" } },
    })).toEqual({ kind: "waiting" });
  });
});
