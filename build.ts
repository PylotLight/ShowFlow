import tailwind from "bun-plugin-tailwind";
import { mkdir } from "node:fs/promises";

// Cross-compile target. Default: bun-linux-x64 (glibc/Debian).
// Set BUILD_TARGET=bun-linux-x64-musl for Alpine runtime.
const TARGET = (process.env.BUILD_TARGET ?? "bun-linux-x64") as "bun-linux-x64" | "bun-linux-x64-musl";
const OUTFILE = "showflow";
const ARTIFACT_PATH = OUTFILE;

const result = await Bun.build({
  entrypoints: ["src/backend/server.ts"],
  plugins: [tailwind],
  minify: true,
  sourcemap: "linked",
  compile: {
    target: TARGET,
    outfile: OUTFILE,
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "__BUILD_COMMIT__": JSON.stringify(process.env.GITHUB_SHA ?? "development"),
    "__BUILD_VERSION__": JSON.stringify(process.env.GITHUB_REF_NAME ?? "development"),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`✓ built ${OUTFILE} (${TARGET})`);

// Generate manifest.json alongside the binary so the Dockerfile can copy it
// as the bootstrap release for cold-start PVCs. Reads the same env vars
// build.ts's define block bakes into the binary, so the manifest and binary
// always describe the same build within a single CI job.
const artifactFile = Bun.file(ARTIFACT_PATH);
const hasher = new Bun.CryptoHasher("sha256");
hasher.update(await artifactFile.arrayBuffer());
const sha256 = hasher.digest("hex");

const manifest = {
  releaseId: process.env.GITHUB_SHA ?? "development",
  version: process.env.GITHUB_REF_NAME ?? "development",
  commit: process.env.GITHUB_SHA ?? "development",
  platform: "linux-x64",
  readyPath: "/internal/ready",
  artifact: {
    name: OUTFILE,
    sha256,
  },
  minimumSupervisorVersion: process.env.SUPERVISOR_VERSION ?? "0.0.0",
};

await Bun.write("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(`✓ wrote manifest.json`);
