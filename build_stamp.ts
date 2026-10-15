// Version + commit baked into the binary and manifest.json by build.ts.
//
// Release builds pass SHOWFLOW_VERSION / SHOWFLOW_COMMIT explicitly. Don't
// rely on GITHUB_REF_NAME / GITHUB_SHA: the runner owns every GITHUB_* var and
// silently ignores a step-level `env:` override, so under workflow_call from a
// workflow_dispatch on main they're "main" and the caller's pre-bump sha —
// that's how v0.1.81 shipped stamped "main" (and the wrong commit).

export interface BuildStamp {
  version: string;
  commit: string;
}

const SEMVER_TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

export function resolveBuildStamp(env: Record<string, string | undefined>): BuildStamp {
  const version = env.SHOWFLOW_VERSION || env.GITHUB_REF_NAME || "development";
  const commit = env.SHOWFLOW_COMMIT || env.GITHUB_SHA || "development";
  // Release builds must carry a real tag + full sha, or the in-app updater
  // can't tell what it's running (and re-installs itself → ETXTBSY).
  if (env.SHOWFLOW_RELEASE_BUILD === "1") {
    if (!SEMVER_TAG.test(version)) {
      throw new Error(`release build: version "${version}" isn't a semver tag (set SHOWFLOW_VERSION=vX.Y.Z)`);
    }
    if (!FULL_SHA.test(commit)) {
      throw new Error(`release build: commit "${commit}" isn't a full git sha (set SHOWFLOW_COMMIT)`);
    }
  }
  return { version, commit };
}
