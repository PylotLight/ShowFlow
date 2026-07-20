# Architecture Overview

ShowFlow is an automated media library manager inspired by Sonarr/Radarr, distributed as a single Docker image with its own self-hosted over-the-air update mechanism. Regenerated 2026-07-16 against the current codebase (`src/backend`, `src/frontend`, `supervisor/`) — see `docs/codebase-mapping.md` for the file-level directory map and `docs/archive/sonarr-parity.md` for a feature-by-feature gap analysis against Sonarr (archived 2026-07-19 as a point-in-time snapshot; remaining open items were pulled forward into `docs/tasklist-remaining-items.md`).

## Core Architecture

### Quality & Profile Engine
ShowFlow uses a scoring system (`core/quality_engine.ts`) to determine the "best" version of a media file.
- **Quality Definitions**: Ranked tiers (e.g., 1080p > 720p), seeded by default on first boot (SDTV through Remux-2160p).
- **Custom Formats**: Regex-based patterns that add score as `bonus`, or gate a release as `required` / `forbidden`.
- **Profiles**: A named group of custom formats plus an optional quality allow-list. An empty allow-list means unrestricted; a non-empty one rejects any release outside it. A `cutoff_quality_id` column exists on profiles but is not currently read by the scoring or upgrade logic.

### Import Pipeline (reactive)
A `DownloadManager` (`core/download_manager.ts`) coordinates whichever download client(s) are configured:
- **Blackhole**: watches a folder for completed downloads dropped there by an external client.
- **TorBox**: a debrid-style client — releases are submitted directly via API rather than through a watch folder, with background completion tracked through db events.

Regardless of source, a completed file goes through:
1. **Resolution**: The `Oracle` (`parser/`) determines which show/episode the file belongs to — first against the local `show_titles` index, falling back to a live provider search.
2. **Upgrade Check**: `QualityEngine.shouldUpgrade` compares the new file's score against any existing file for that episode.
3. **Action**: If it's an upgrade, the existing file is replaced; if not, the file is left for manual review; otherwise it's skipped.

### Automated Grabber (proactive)
`GrabberService` (`core/grabber_service.ts`) automates search and acquisition:
1. **Search**: Queries every enabled indexer — Prowlarr and/or the native indexers (Nyaa, SubsPlease, TPB, Knaben, RARBG) — for the specific episode or season.
2. **Filtering & Scoring**: Filters obviously-irrelevant results, then ranks the rest using the `QualityEngine` against the show's assigned profile.
3. **Decision**: For a single-episode grab, checks the best result is an upgrade over what's already on disk (season-pack grabs skip this — a pack can span episodes at different existing qualities).
4. **Action**: Grabs via `release.indexer.grab(release)` — routed through TorBox first if configured, otherwise falling back to the indexer's own grab (Prowlarr writes a `.torrent`/`.magnet` to the blackhole folder for the reactive pipeline above to pick up).

This same `searchReleases` → score → grab path backs three surfaces: the fully-automatic per-episode/season grab, and interactive search (the person picks a specific result, which then hits `POST /api/search/grab`).

## High-Level Components

### 1. The Oracle (Parser) — `parser/`
Takes a raw filename and resolves it into a structured show/season/episode. Handles `SxxExx`, `1x01`, multi-episode ranges, and absolute anime numbering; disambiguates by checking the local `show_titles` alias index before falling back to fuzzy matching (`fuse.js`) and live provider lookups.

### 2. Quality Engine — `core/quality_engine.ts`
Calculates a `ReleaseScore`: quality rank × 1000, plus/minus custom format scores, with `rejected: true` short-circuiting anything that hits a forbidden format, a missing required format, or a disallowed quality.

### 3. Metadata Providers — `providers/`
`tmdb.ts`, `tvdb.ts`, `anilist.ts` behind a shared `IMetadataProvider` interface (`providers/base.ts`) and a factory (`providers/factory.ts`). Each show can have multiple linked providers with per-role assignment (which one supplies metadata vs. air-time data), plus a "primary" provider. Responses are cached in `metadata_cache` (6h TTL).

### 4. Indexers — `providers/indexers/`
Prowlarr (`prowlarr.ts`) as an aggregator, plus native indexers under `indexers/native/` that don't need Prowlarr at all. All implement the same `Indexer` interface (`search`, `grab`, `validate`, `listIndexers`), so `GrabberService` treats them interchangeably.

### 5. Download Clients — `core/download_clients/`
`BlackholeClient` (`blackhole.ts`) and `TorboxDownloadClient` (`torbox.ts`), both implementing a shared `DownloadClient` interface (`types.ts`), re-exported through `index.ts` and managed by `core/download_manager.ts`.

### 6. Import Pipeline — `core/download_manager.ts` + `parser/` + `quality_engine.ts`
The reactive system described above.

### 7. External library integrations — `providers/jellyfin/`, `providers/sonarr/`
- **Jellyfin**: one-way library sync from an existing Jellyfin server, to seed ShowFlow's library from what's already organized on disk.
- **Sonarr**: one-time series import from an existing Sonarr instance, for migrating off Sonarr onto ShowFlow.

### 8. Scheduler — `core/scheduler.ts`
Background task registry (metadata sync, library scan) with configurable intervals, intelligent sync frequency (airing shows sync more often than completed ones), and a `/api/tasks` surface for the UI to inspect/trigger/reconfigure tasks.

## Release & Update Pipeline (Supervisor)

This is a **separate concern from the app above** — its own compiled binary (`supervisor/`), not part of `src/backend`, and the container's actual entrypoint (`CMD ["/supervisor"]` in the Dockerfile). The app binary (`showflow`, built from `src/backend/server.ts`) runs as a child process the supervisor starts, monitors, and swaps out.

### Why: zero-downtime-ish self-updates on a single-replica deployment
ShowFlow ships as one Docker image per release, but the deployment model (a single Kubernetes pod, `k8s/deployment.yaml`) needs a way to install and activate a *new* release without the operator rebuilding/redeploying the image every time — hence a supervisor that owns downloading, verifying, and swapping app binaries on the PVC at `/data`, independent of the container image lifecycle.

### How it works
1. **Manifest-driven releases**: every build produces a `manifest.json` (`build.ts`) with a `releaseId`, `version`, a sha256 of the compiled `showflow` binary, and a `minimumSupervisorVersion`. The supervisor refuses to activate a release whose `minimumSupervisorVersion` is newer than its own compiled-in version (`compareVersions` in `supervisor/state.ts`).
2. **Install**: `POST /admin/install` (loopback-only, `127.0.0.1:9090`) copies a release's binary + manifest into `/data/releases/<id>` and verifies its sha256 before it's ever trusted.
3. **Activate — stop-start, not blue-green**: `ReleaseManager.activate()` (`supervisor/activate.ts`) fully stops the currently-running release (SIGTERM, up to a 10s grace period, then SIGKILL), waits for its own DB connection to close, *then* starts the candidate. This is deliberate — SQLite needs exclusive single-writer ownership of `showflow.db`, so there's no overlap window where both processes could hold it open.
4. **Readiness gating**: the candidate must pass `/internal/ready` (which checks live DB connectivity, not just process-up) three consecutive times within a 15s window before the supervisor calls it `stable` and starts proxying public traffic to it.
5. **Automatic rollback**: if the candidate fails to start or fails readiness, the supervisor automatically relaunches `lastKnownGood`. If that *also* fails, it stops and surfaces "manual intervention required" rather than looping.
6. **Crash detection while stable**: a release that dies unexpectedly after reaching `stable` (not as part of a normal activate() stop) also triggers the same `lastKnownGood` relaunch path.
7. **Cold start / disaster recovery**: on a fresh PVC (new pod, lost volume), `bootstrap.ts` installs the release baked into the image itself (`/bootstrap/showflow` + `/bootstrap/manifest.json`) as `lastKnownGood` before anything else runs.
8. **Public traffic during cutover**: while a release is `quiescing`/`stopped`/`starting` (not `stable`), the supervisor's public proxy answers every request with an explicit 503 rather than hanging — a real, short outage window is the documented tradeoff over pretending there's zero downtime with only one running instance.

### App ↔ supervisor bridge
The app process itself has no way to reach the supervisor's admin API from outside the pod (it's loopback-only, unauthenticated by design, relying entirely on network-namespace isolation). `server.ts` bridges a public, **token-authenticated** surface for the frontend:

- `GET /api/admin/updates/available` — lists installable releases from GitHub (via `core/updates_manager.ts`).
- `POST /api/admin/updates/install` — downloads and installs a specific GitHub release.
- `POST /api/admin/updates/activate` — triggers activation. Fire-and-forget from the app's own point of view: activating necessarily kills *this* process, so it structurally cannot await the supervisor's full response on the success path. The frontend's contract is to poll `/internal/ready` afterward, not trust this response as final.
- `GET /api/admin/updates/status` — supervisor phase + active release, merged with the app's own build info.

All four require a bearer token (`checkAdminAuth()`), generated once on first boot and persisted to the DB — the only authenticated routes in the API today (see `docs/archive/sonarr-parity.md` → "Known bugs" #7 for the rest of the API's auth posture and why it's currently open by design).

### Current gaps in this pipeline (as of 2026-07-16)
- **CI/manifest inconsistency**: the standalone release tarball built by `.github/workflows/docker-image.yml`'s `publish-release-assets` job does not set `SUPERVISOR_VERSION` when generating `manifest.json`, so `minimumSupervisorVersion` always falls back to `build.ts`'s hardcoded default (`"0.1.0"`) rather than reflecting the actual release tag the way the Docker image build does.
- **`imagePullPolicy: IfNotPresent` + `image: showflow:latest`** in `k8s/deployment.yaml` means a rescheduled pod on a node with any cached `showflow:latest` image won't pull a newer one — silently stale, with no error surfaced.
- **No automatic release discovery/install loop yet** — today it's `GET /api/admin/updates/available` → `install` → `activate`, driven from the UI or a manual `kubectl exec`. Phase 2 (scheduled auto-discovery + auto-install) is not implemented.

## Data Model

### Database (SQLite, via Drizzle for the newer tables)

The database layer is organised as a `DatabaseManager` class in `db/index.ts` (113 lines) that delegates to domain-focused modules under `db/` (`db/shows.ts`, `db/config.ts`, `db/system.ts`, `db/init.ts`, `db/schemas.ts`). The core tables are:
- **`shows`**: One row per tracked series — title, year, `profile`, `series_type`, `root_folder_path`.
- **`show_providers`**: A show can be linked to multiple metadata providers (tmdb/tvdb/anilist), each with its own `provider_id`, cached `metadata_json`, and `is_primary`/`is_metadata`/`is_airtime` role flags.
- **`show_titles`**: Indexed canonical/original/romanized/alias/provider/user titles per show, normalized for fast exact-match lookups by the Oracle before it falls back to fuzzy matching.
- **`seasons`** & **`episodes`**: Hierarchy of episodes, including `file_path`, `is_tracked`, `air_date`, and per-episode `search_mode` (auto/interactive).
- **`show_artworks`**: Cached poster/backdrop/banner image bytes + metadata per show/provider/artwork-type.
- **`quality_definitions`**, **`custom_formats`**, **`quality_profiles`**, **`profile_formats`**, **`profile_qualities`**: The Quality Engine's building blocks — ranked quality tiers, regex-based custom formats, and per-profile format/quality associations.
- **`show_profiles`**: Named root-folder presets offered when adding a show.
- **`settings`**: Key-value store for system-wide configuration (API keys, integration configs, admin token).
- **`scheduled_tasks`**: Scheduler bookkeeping (interval, last/next execution).
- **`audit_logs`**: General event log backing the dashboard activity ticker (`/api/events`).
- **`metadata_cache`**: TTL'd raw provider API response cache.
- **`processed_files`**: SHA-256 hash log to prevent duplicate imports.

## API Design
The system exposes a REST API (Bun's native route table in `src/backend/server.ts`, with individual handlers extracted into `src/backend/routes/`) that the React frontend consumes directly. ShowFlow does not ship a CLI — all functionality is exposed through the API and dashboard.

## API Reference

This list reflects the actual route table as of 2026-07-16; it's organized by area rather than in file order.

### Configuration & Settings
- `GET /api/config` / `PATCH /api/config` — validated system configuration.
- `GET /api/settings`, `POST /api/settings`, `DELETE /api/settings` — raw key/value settings (also handles Prowlarr/Sonarr/Jellyfin config merge-and-validate on `POST` when `key` matches one of those integrations).
- `GET /api/show-profiles`, `POST /api/show-profiles`, `DELETE /api/show-profiles/:id` — named root-folder presets.
- `GET /api/files/browse?path=` — server-side directory browser for path pickers in Settings.

### System Management
- `POST /api/system/scan`, `POST /api/system/watch/start`, `POST /api/system/watch/stop`, `POST /api/system/watch/rescan`
- `GET /api/system/status` — watcher state + running build's release/version.
- `GET /api/system/processing` — files/releases currently in flight.

### Task Scheduling
- `GET /api/tasks`, `GET /api/tasks/definitions`, `PATCH /api/tasks/:name`, `POST /api/tasks/:name` (run now).

### Activity Feed
- `GET /api/events?limit=` — recent audit log entries for the dashboard ticker.

### Quality Management
- `GET /api/qualities`, `POST /api/qualities`, `DELETE /api/qualities/:id`
- `GET /api/profiles`, `POST /api/profiles`, `DELETE /api/profiles/:id`
- `GET /api/profiles/:id/formats`, `POST /api/profiles/:id/formats`, `DELETE /api/profiles/:id/formats`
- `GET /api/profiles/:id/qualities`, `POST /api/profiles/:id/qualities`, `DELETE /api/profiles/:id/qualities`
- `PUT /api/profiles/:id/indexers` — restrict a profile to specific indexers.
- `GET /api/custom-formats`, `POST /api/custom-formats`, `DELETE /api/custom-formats/:id`

### Library & Shows
- `GET /api/shows`, `POST /api/shows`, `POST /api/shows/bulk-delete`
- `GET /api/shows/:id`, `PATCH /api/shows/:id`, `DELETE /api/shows/:id`
- `POST /api/shows/:id/relocate` — move all of a show's files to a new root folder.
- `POST /api/shows/:id/organize` — rename files in place to the standard naming pattern.
- `POST /api/shows/:id/sync`, `POST /api/shows/sync-all`, `POST /api/shows/:id/scan`

### Provider management (per-show)
- `GET /api/shows/:id/providers`, `POST /api/shows/:id/providers`, `DELETE /api/shows/:id/providers/:type`
- `PUT /api/shows/:id/providers/:type/primary`
- `PUT /api/shows/:id/providers/:type/role` — assign metadata/airtime role.

### Seasons / Episodes & Automation
- `GET /api/shows/:id/seasons`, `GET /api/shows/:id/seasons/:season/episodes`
- `PATCH /api/shows/:id/seasons/:season/tracked`, `PATCH /api/shows/:id/seasons/:season/episodes/:episode/tracked`
- `GET /api/shows/:id/seasons/:season/episodes/:episode/search` (interactive search), `PATCH .../search` (set auto/interactive mode)
- `POST /api/shows/:id/seasons/:season/episodes/:episode/grab` — automatic best-release grab for one episode.
- `GET /api/shows/:id/seasons/:season/search`, `POST /api/shows/:id/seasons/:season/grab` — season-pack equivalents.

### Indexers & Search
- `GET /api/indexers/prowlarr/status`, `GET /api/indexers/prowlarr/indexers`
- `GET /api/indexers/native/meta`, `GET /api/indexers/native/status`, `GET /api/indexers/native/test/:id`
- `GET /api/search?q=` — ad-hoc search across all enabled indexers.
- `POST /api/search/grab` — grab a specific interactive-search result (routes through TorBox if configured, else the originating indexer).

### External Integrations
- `GET/POST /api/sonarr/settings`, `GET /api/sonarr/test`, `GET /api/sonarr/series`, `POST /api/sonarr/import`
- `GET/POST /api/jellyfin/settings`, `GET /api/jellyfin/test`, `GET /api/jellyfin/users`, `POST /api/jellyfin/sync`

### Images
- `GET /api/shows/:id/images/poster`, `GET /api/shows/:id/images/backdrop` — by internal show ID, DB-blob-cached.
- `GET /api/images/poster/:source/:id`, `GET /api/images/backdrop/:source/:id`, `GET /api/images/artwork/:source/:id/:type` — by provider + provider ID (used pre-add, in the Add Show search flow).

### Calendar & Missing
- `GET /api/calendar?days=&past=` — upcoming episodes.
- `GET /api/missing` — tracked, aired, fileless episodes.

### Backup
- `GET /api/backup`, `POST /api/backup`, `POST /api/backups/upload`, `POST /api/backups/:file/restore`, `GET /api/backups/:file`

### Manual Import
- `GET /api/manual-import/list`, `POST /api/manual-import/import`, `POST /api/manual-import/delete`, `GET /api/manual-import/count`

### Debug & Feedback
- `GET /api/debug/logs`, `POST /api/debug/clear`, `GET /api/debug/ws` (WebSocket log stream)
- `POST /api/feedback` — files a GitHub issue (requires `GITHUB_TOKEN`/`GITHUB_REPO` env vars; otherwise returns 501).

### Release / Update Pipeline (token-authenticated — see "Release & Update Pipeline" above)
- `GET /api/admin/updates/available`, `POST /api/admin/updates/install`, `POST /api/admin/updates/activate`, `GET /api/admin/updates/status`
- `GET /api/admin/token` — hands the persisted admin token to the frontend (intentionally unauthenticated itself, so the UI never needs manual token entry).

### Health
- `GET /internal/ready` — DB-backed readiness check consumed by the supervisor and k8s readiness probe.
