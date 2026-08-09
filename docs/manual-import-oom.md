# Manual Import OOM — Investigation Log & Current State

**Status: FIXED (candidate in code) — v0.1.16 deployed was crashing; fix not yet released.**

The Manual Import page (`GET /api/manual-import/list`) OOM-killed the showflow
pod (SIGKILL / exit 137 at the 4Gi cgroup limit). Every load of the page
triggered a monotonic memory climb to ~4Gi within a few seconds.

## Root cause (CONFIRMED 2026-08-09)

`db.getLocalShowCandidates()` (in `src/backend/db/shows.ts`) was a single
3-table query:

```sql
shows INNER JOIN show_providers LEFT JOIN show_titles
```

Because it selects `show_providers.metadata_json` while joining
`show_titles`, **every title row for a show re-materializes the full
`provider_metadata_json` blob**. With ~239 shows / ~8k titles / ~240 providers:

- Result: **8091 rows**, carrying `metadata_json` **37.6×** its real size
  (517MB of identical strings materialized from only 13.1MB stored).
- `oracle.findLocalShow()` runs this on every fuzzy-miss, `groupLocalRows()`
  then `JSON.parse`s each duplicated blob and builds a Fuse index.
- Locally reproduced: a single `resolveForList()` call climbed to
  `rss=2152MB heap=1004MB ext=993MB`, accumulating to `cgroup=4073/4096MB`
  and OOM-killing the pod. **GC could not reclaim it** across calls.

The earlier hypothesis ("multi-MB metadata blobs per show") was wrong — the
blame was the title-join duplication, not the blob size.

## Fix

Split `getLocalShowCandidates()` into two cheap queries:

1. `shows × show_providers` → 240 rows, `metadata_json` loaded **once** per show.
2. `show_titles` → 8065 rows (title + type + language only).

Merge in JS, attaching the `metadata_json` to only the **first** row of each
`show+provider` pair (the only row `groupLocalRows` parses).

Verify locally against the prod DB: 30-file list loop stays at
`rss=487MB heap=144MB ext=2MB` after GC, vs previous single-call 2.15GB and
monotonic climb to OOM. Titles still resolve correctly ("From Old Country
Bumpkin to Master Swordsman", "Daemons of the Shadow Realm", etc).

## Next steps

1. Deploy the fix as v0.1.18 (commit → `bun run release` → CI → rollout).
2. Keep `maybeForcedGc()` + mem probes; the surfaces stay.
3. Consider later dropping `provider_metadata_json` out of the list-path query
   entirely (the list page only needs title/series metadata).

## Cluster notes

- Deployment: `ghcr.io/pylotlight/showflow:latest`, `imagePullPolicy: Always`,
  limit 4Gi. Rollout = `kubectl --context pylot rollout restart -n showflow deployment/showflow`.
- The running image only updates when a `main`-branch push/release build tags
  `latest`; `bun run release` bumps + tags + releases, which triggers CI.
- `SHOWFLOW_DEBUG=true` is set on the deployment (enables `mem()` probes).
- Debug pod `showflow-debug` (python:3-alpine) mounts the PVC at `/data`.
  Note the real watch folder `/Data` is a **hôstPath on the node**, mounted
  only into the app pod — the debug pod cannot see it.