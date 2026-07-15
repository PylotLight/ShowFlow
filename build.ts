import tailwind from "bun-plugin-tailwind";

// Compiles the server directly into a single self-contained executable.
// server.ts imports src/frontend/index.html, so Bun's full-stack executable
// mode bundles the React app, CSS, and server into one binary — no separate
// dist/ output or copy step.
//
// `plugins: [tailwind]` is passed explicitly here (rather than relying on
// bunfig.toml's [serve.static] plugin list being picked up implicitly by a
// bare `bun build --compile` CLI invocation) because Bun's docs confirm
// plugins run through Bun.build({ compile, plugins }), but don't explicitly
// document bun-plugin-tailwind specifically working through the full-stack
// (target: bun) compile path — only through target: "browser" standalone
// HTML. Verify with `bun run build.ts` and check the smoke-test below.
const result = await Bun.build({
  entrypoints: ["src/backend/server.ts"],
  plugins: [tailwind],
  minify: true,
  sourcemap: "linked",
  compile: {
    target: "bun-linux-x64",
    outfile: "showflow",
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    // Build identity baked into the binary itself, not passed as a runtime
    // env var. An env var is the supervisor's *claim* about what it's
    // running; a compiled-in constant is evidence the supervisor can check
    // the readiness response against before ever trusting a release.
    "__BUILD_COMMIT__": JSON.stringify(process.env.GITHUB_SHA ?? "development"),
    "__BUILD_VERSION__": JSON.stringify(process.env.GITHUB_REF_NAME ?? "development"),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`✓ built ${result.outputs[0]?.path ?? "showflow"}`);
