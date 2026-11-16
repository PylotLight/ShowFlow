import { test, expect, describe } from "bun:test";
import { instantStepView, type InstantJobView } from "./instantUpdate";

const job = (p: Partial<InstantJobView>): InstantJobView => ({ tag: "v0.1.90", releaseId: null, source: "manual", step: "download", message: null, ...p });

describe("instantStepView", () => {
  test("walks download → activate", () => {
    expect(instantStepView("v0.1.90", job({}), null).kind).toBe("download");
    expect(instantStepView("v0.1.90", job({ step: "activate", releaseId: "sha" }), null)).toEqual({ kind: "activate", releaseId: "sha" });
  });

  test("matches tags with or without the v", () => {
    expect(instantStepView("0.1.90", job({ step: "activate", releaseId: "sha" }), null).kind).toBe("activate");
  });

  test("reports failures with the server's reason", () => {
    expect(instantStepView("v0.1.90", job({ step: "failed", message: "sha256 mismatch" }), null)).toEqual({ kind: "failed", message: "sha256 mismatch" });
    expect(instantStepView("v0.1.90", null, { releaseId: "sha", tag: "v0.1.90", phase: "failed", detail: "backup failed" })).toEqual({ kind: "failed", message: "backup failed" });
  });

  test("falls back to the activation when the job record is gone", () => {
    expect(instantStepView("v0.1.90", null, { releaseId: "sha", tag: "v0.1.90", phase: "draining" })).toEqual({ kind: "activate", releaseId: "sha" });
  });

  test("ignores another release's job", () => {
    expect(instantStepView("v0.1.90", job({ tag: "v0.1.91" }), null).kind).toBe("waiting");
    expect(instantStepView("v0.1.90", null, { releaseId: "x", tag: "v0.1.91", phase: "draining" }).kind).toBe("waiting");
  });

  test("done when it's already the running release", () => {
    expect(instantStepView("v0.1.90", job({ step: "done", message: "Already running v0.1.90" }), null)).toEqual({ kind: "done", message: "Already running v0.1.90" });
  });

  test("applied when the restart landed between polls (only the activation record is left)", () => {
    const last = { releaseId: "sha", tag: "v0.1.93", outcome: "activated" as const };
    expect(instantStepView("v0.1.93", null, null, last)).toEqual({ kind: "applied" });
    expect(instantStepView("0.1.93", null, null, last).kind).toBe("applied");
  });

  test("a rolled-back record for this tag is a failure", () => {
    const last = { releaseId: "sha", tag: "v0.1.93", outcome: "rolled-back" as const, message: "health check failed" };
    expect(instantStepView("v0.1.93", null, null, last)).toEqual({ kind: "failed", message: "health check failed" });
  });

  test("a live job for the tag wins over an older activation record", () => {
    const last = { releaseId: "old", tag: "v0.1.93", outcome: "rolled-back" as const };
    expect(instantStepView("v0.1.93", job({ tag: "v0.1.93" }), null, last).kind).toBe("download");
  });

  test("another release's activation record doesn't count", () => {
    expect(instantStepView("v0.1.93", null, null, { releaseId: "x", tag: "v0.1.92", outcome: "activated" }).kind).toBe("waiting");
  });
});
