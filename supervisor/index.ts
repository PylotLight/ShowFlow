// ShowFlow release supervisor. Compiled as its own standalone executable
// (see the Dockerfile) — the distroless runtime image has no shell and no
// Bun runtime outside what's embedded in this binary, so it can't be a
// bare .ts file run by `bun`.
//
// Dual-mode: run with no arguments, it's the long-running daemon (this is
// the container's CMD). Run with arguments, it's a thin CLI client that
// talks to the daemon's loopback-only admin API and exits — this is what
// `kubectl exec` invokes for manual install/activate in Phase 1, before
// Phase 2 adds automatic GitHub release discovery.
//
//   kubectl exec deploy/showflow -- /supervisor install v0.2.0
//   kubectl exec deploy/showflow -- /supervisor activate v0.2.0
//   kubectl exec deploy/showflow -- /supervisor status

import { mkdir, chmod } from "node:fs/promises";
import {
  ADMIN_PORT,
  PUBLIC_PORT,
  DOWNLOADS_DIR,
  readManifest,
  verifyArtifact,
  releasePath,
  readState,
  writeStateAtomic,
} from "./state";
import { ensureDataDirs, ensureBootstrapInstalled } from "./bootstrap";
import { ReleaseManager } from "./activate";
import { proxy, unavailableResponse } from "./proxy";

const args = process.argv.slice(2);

if (args.length > 0) {
  await runCli(args);
} else {
  await runDaemon();
}

// ---- CLI mode ------------------------------------------------------------

async function runCli(argv: string[]): Promise<void> {
  const [command, arg] = argv;
  try {
    switch (command) {
      case "status": {
        const res = await fetch(`http://127.0.0.1:${ADMIN_PORT}/admin/status`);
        console.log(JSON.stringify(await res.json(), null, 2));
        process.exit(res.ok ? 0 : 1);
      }
      case "install": {
        if (!arg) return fail("Usage: supervisor install <releaseId>");
        const res = await fetch(`http://127.0.0.1:${ADMIN_PORT}/admin/install`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ releaseId: arg }),
        });
        const body = await res.json();
        console.log(body.message);
        process.exit(res.ok && body.ok ? 0 : 1);
      }
      case "activate": {
        if (!arg) return fail("Usage: supervisor activate <releaseId>");
        const res = await fetch(`http://127.0.0.1:${ADMIN_PORT}/admin/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ releaseId: arg }),
        });
        const body = await res.json();
        console.log(body.message);
        process.exit(res.ok && body.ok ? 0 : 1);
      }
      default:
        return fail(`Unknown command "${command}". Expected: status | install <releaseId> | activate <releaseId>`);
    }
  } catch (err) {
    console.error(`[supervisor] could not reach the running daemon on 127.0.0.1:${ADMIN_PORT}: ${String(err)}`);
    process.exit(1);
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// ---- Daemon mode -----------------------------------------------------------

async function runDaemon(): Promise<void> {
  await ensureDataDirs();

  const manager = new ReleaseManager();

  const bootId = await ensureBootstrapInstalled();
  if (!bootId) {
    console.error("[supervisor] fatal: nothing to activate on startup. Exiting.");
    process.exit(1);
  }

  // Public proxy — every request while not `stable` gets an explicit 503
  // rather than hanging or erroring, per the design decision to prefer a
  // real (short) outage window over a design that pretends there's zero
  // downtime during cutover.
  const publicServer = Bun.serve({
    port: PUBLIC_PORT,
    async fetch(req) {
      const port = manager.activePort;
      if (port === null) return unavailableResponse();
      try {
        return await proxy(req, port);
      } catch {
        return unavailableResponse();
      }
    },
  });

  // Admin surface, loopback-only. Never bind this to 0.0.0.0 — it has no
  // auth of its own, and relies entirely on being unreachable from outside
  // the pod's network namespace.
  const adminServer = Bun.serve({
    hostname: "127.0.0.1",
    port: ADMIN_PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/admin/status" && req.method === "GET") {
        const state = await readState();
        return Response.json({ ...state, phase: manager.phase, activeReleaseId: manager.activeReleaseId });
      }

      if (url.pathname === "/admin/install" && req.method === "POST") {
        try {
          const { releaseId } = await req.json();
          const result = await installRelease(releaseId);
          return Response.json(result, { status: result.ok ? 200 : 400 });
        } catch (err) {
          return Response.json({ ok: false, message: String(err) }, { status: 500 });
        }
      }

      if (url.pathname === "/admin/activate" && req.method === "POST") {
        try {
          const { releaseId } = await req.json();
          const result = await manager.activate(releaseId);
          return Response.json(result, { status: result.ok ? 200 : 400 });
        } catch (err) {
          return Response.json({ ok: false, message: String(err) }, { status: 500 });
        }
      }

      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`[supervisor] public proxy on :${PUBLIC_PORT}, admin on 127.0.0.1:${ADMIN_PORT}`);

  const result = await manager.activate(bootId);
  console.log(`[supervisor] initial activation: ${result.message}`);

  // The supervisor itself also needs a clean-exit path for pod termination
  // (SIGTERM from kubelet during a rolling restart of the *pod*, distinct
  // from the stop-start handoff between releases). Forward it to whatever
  // child is currently running, then exit.
  process.on("SIGTERM", async () => {
    console.log("[supervisor] received SIGTERM, shutting down.");
    await writeStateAtomic({ phase: manager.phase });
    publicServer.stop(true);
    adminServer.stop(true);
    process.exit(0);
  });
}

async function installRelease(releaseId: string): Promise<{ ok: boolean; message: string }> {
  if (!releaseId) return { ok: false, message: "releaseId is required." };

  const src = `${DOWNLOADS_DIR}/${releaseId}`;
  const manifest = await readManifest(src);
  if (!manifest) {
    return { ok: false, message: `No manifest.json found under ${src}. Place the extracted release there first (e.g. via kubectl cp), then retry install.` };
  }
  if (!(await verifyArtifact(src, manifest))) {
    return { ok: false, message: `Artifact checksum mismatch for release "${releaseId}" in ${src} — refusing to install.` };
  }

  const dest = releasePath(releaseId);
  await mkdir(dest, { recursive: true });

  // Copy content rather than rename(). `docker cp` / `kubectl cp` typically
  // land files owned by root inside the container, and rename() needs
  // write+execute on the *source* directory (to unlink the entry) as well
  // as the destination — which the nonroot supervisor process doesn't have
  // for a root-owned /data/downloads/<id>. Copying only needs read access
  // to the source file and write access to the destination, both of which
  // the supervisor already has.
  await Bun.write(`${dest}/${manifest.artifact.name}`, Bun.file(`${src}/${manifest.artifact.name}`));
  await Bun.write(`${dest}/manifest.json`, Bun.file(`${src}/manifest.json`));
  await chmod(`${dest}/${manifest.artifact.name}`, 0o755);

  return { ok: true, message: `Installed release "${releaseId}". Run "activate ${releaseId}" to switch to it.` };
}
