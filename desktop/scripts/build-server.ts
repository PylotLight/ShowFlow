// Compile the ShowFlow server into a standalone darwin-arm64 binary for the
// packaged app, with the Drizzle migrations beside it (db/index.ts looks for
// a `migrations` folder next to the executable).
//
//   bun run build:server   ->  desktop/resources/server/{showflow-server,migrations/}
//
// SHOWFISH_SERVER_TARGET=bun-linux-arm64 etc. builds for another platform
// (handy for smoke-testing the binary off a Mac).

import tailwind from "bun-plugin-tailwind";
import { cpSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..", "..");
const outDir = resolve(import.meta.dir, "..", "resources", "server");
const outfile = join(outDir, "showflow-server");
const target = (process.env.SHOWFISH_SERVER_TARGET || "bun-darwin-arm64") as "bun-darwin-arm64";

const pkg = await Bun.file(join(repo, "package.json")).json();
const commit = (await Bun.$`git -C ${repo} rev-parse --short HEAD`.quiet().nothrow().text()).trim() || "local";

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(repo, "src/backend/server.ts")],
  plugins: [tailwind],
  minify: true,
  compile: { target, outfile },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "__BUILD_COMMIT__": JSON.stringify(commit),
    "__BUILD_VERSION__": JSON.stringify(`${pkg.version}-local`),
  },
});

if (!result.success) {
  for (const l of result.logs) console.error(l);
  process.exit(1);
}

cpSync(join(repo, "src/backend/db/migrations"), join(outDir, "migrations"), { recursive: true });
console.log(`✓ built ${outfile} (${target}) + migrations`);
