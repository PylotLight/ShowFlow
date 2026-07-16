# ShowFlow Sonarr-Parity Gap Analysis

This document tracks how close ShowFlow is to Sonarr’s core **desired-state** loop (monitor → search → download → import → upgrade), plus quality management and day-to-day ops.

**Last reviewed:** 2026-07-16 against the current codebase. This pass re-verified the "Known bugs" section and the provider/download-client inventory in "What already works" — those two sections are current as of this date. The feature-gap tables further down were not re-audited line-by-line in this pass and may still lag the code.

---

## Status legend

| Status | Meaning |
| :--- | :--- |
| **Done** | Works end-to-end for the happy path |
| **Partial** | Schema, API, or UI exists, but logic is incomplete, buggy, or not wired into automation |
| **Missing** | Not started in a meaningful way |

---

## MVP goal: desired-state automation

Sonarr’s power is not only organizing files — it **monitors** for them. ShowFlow already does a strong **reactive** job (watch/blackhole → parse → score → import). MVP parity means completing the **proactive** loop:

```text
Tracked missing/upgradable episodes
  → indexer search (Prowlarr)
  → score & select
  → send to download client
  → detect completion
  → import / upgrade
  → update library state
```

---

## What already works (do not re-build)

These are solid foundations relative to early-phase docs (see `docs/archive/progress.md` and `docs/archive/roadmap.md` — archived 2026-07-16, phase checklists were partly stale).

| Area | Reality today |
| :--- | :--- |
| **Metadata providers** | TMDB, TVDB, AniList with shared rate limit + metadata cache |
| **Oracle / parser** | SxxExx, `1x01`, multi-ep ranges, absolute anime numbers; fuzzy title match via Fuse |
| **Persistence** | SQLite (`shows`, `seasons`, `episodes`, quality tables, root folders, audit logs, artworks, tasks) |
| **Blackhole import** | Watch folder, stable-size wait, SHA-256 dedup, cross-device move, collision policy, quality upgrade check |
| **Library scan** | Walks root folders / `libraryPath`, maps files onto known shows |
| **Scheduler** | Background `sync-shows` + `scan-library` with intelligent sync intervals (airing vs completed) |
| **Quality primitives** | DB + API for definitions, profiles, custom formats; `QualityEngine` scoring + upgrade compare |
| **Prowlarr client** | Validate, list indexers, search, grab HTTP client; Settings UI + manual `/api/search` |
| **Manual grab API** | `POST .../episodes/:episode/grab` via `GrabberService` (grab call fixed — see "Known bugs" #1) |
| **Root folders** | Multi-root storage + free-space reporting |
| **Tracking** | Per-episode and per-season `is_tracked`; `search_mode` auto/interactive |
| **Calendar data** | DB-backed upcoming episodes; dashboard agenda strip |
| **React dashboard** | Library grid, show detail, add show, settings (providers/indexers/downloads/roots), glass UI |
| **CLI** | **Removed, confirmed 2026-07-16.** ShowFlow no longer ships a CLI — `package.json`'s `cli` script and the `commander` dependency have been removed. All functionality is exposed through the REST API and React dashboard. |
| **TorBox download client** | Debrid-style client (`providers/torbox/`) as an alternative to blackhole — releases submitted directly, background-tracked via db events. Not in earlier revisions of this doc. |
| **Native indexers** | Built-in indexers not requiring Prowlarr: Nyaa, SubsPlease, TPB, Knaben, RARBG (`providers/indexers/native/`). |
| **Jellyfin sync** | One-way library sync from an existing Jellyfin instance (`providers/jellyfin/`). |
| **Sonarr import** | One-time series import from an existing Sonarr instance (`providers/sonarr/import.ts`). |
| **Admin-token auth** | `/api/admin/updates/*` routes require a bearer token (generated on first boot, persisted to the DB) — see updated auth note under "Known bugs" below. |

---

## Feature gap analysis

### Critical path (blocks “Sonarr-like” autopilot)

| Feature | Status | Notes |
| :--- | :--- | :--- |
| **Automated search loop** | **Missing** | Scheduler only runs metadata sync + library scan. No task iterates `is_tracked` + missing/`search_mode=auto` and calls the grabber. |
| **Prowlarr search → grab** | **Done** | **Corrected 2026-07-16** — previously flagged as broken; `grabRelease()` correctly calls `release.indexer.grab(release)` with the full release object each indexer's `grab()` needs (see "Known bugs" #1, now fixed). Release→indexer binding exists via `ScoredRelease.indexer`. Grab events are logged (`db.logEvent({ type: 'grab', ... })`) but there's still no dedicated grab-history/queue table beyond the generic audit log. |
| **Download client lifecycle** | **Partial** | **Corrected 2026-07-16** — blackhole plus a TorBox debrid client (`Config.downloadClient.type`: `blackhole` \| `torbox` \| `none`), not blackhole-only as previously stated. Still no qBittorrent / Transmission / SABnzbd / NZBGet. No generic “downloading → completed → import” state machine — TorBox tracks its own background state and reports completion via db events rather than a shared state machine. |
| **Import on completion** | **Partial** | Blackhole import path exists. No client-driven “completed download” hook; non-upgrade files stay in the watch folder (no dedicated `manualReviewPath` / failed-import queue). |
| **Proactive upgrades** | **Partial** | Reactive upgrade on blackhole import via `QualityEngine.shouldUpgrade`. No scheduled “search for better than current” pass. Profile **cutoff** column is unused by the engine. |
| **Quality profiles (full Sonarr model)** | **Partial** | Rank + custom-format scores work. **Allowed-quality checklist is implemented** (`QualityEngine.isQualityAllowed`, verified 2026-07-16 — an empty allow-list means unrestricted, a non-empty one is enforced and rejects releases outside it). Still missing: cutoff enforcement (the `cutoff_quality_id` column exists but nothing reads it to stop upgrading past a target quality), min/max size filters, language, delay profiles, proper/repack handling. Quality detection is `filename.includes(name)` (no aliases / regex per quality). |
| **Custom formats** | **Partial** | Regex + bonus/required/forbidden types on profiles. No UI in Settings yet; engine spam-logs; no group/except/include-advanced CF model. |

### Medium complexity / product surface

| Feature | Status | Notes |
| :--- | :--- | :--- |
| **Granular monitoring** | **Partial** | Episode + season track toggles exist. No series-level default (monitor future/all/missing-only), no “ignored”, no “pilot only / first season”. |
| **Calendar-based automation** | **Partial** | Calendar read API + UI. No auto-mark tracked on air, no RSS/calendar-driven search after air date + delay. |
| **TMDB episode groups** | **Missing** | CLI accepts `--episode-group` and stores in show config; `TMDBProvider` does not remap Production/DVD/Streaming order. |
| **API auth** | **Missing** | Open REST API; fine for localhost, unsafe on a LAN/VPN without reverse-proxy auth. |
| **Connect (notifications)** | **Missing** | No Discord / Telegram / Pushover / webhook on grab/import/fail. |
| **History / activity** | **Partial** | `audit_logs` + `/api/events` feed dashboard ticker. No Sonarr-style History page, no failed-download retry UI. |
| **Queue UI** | **Missing** | Sidebar has Queue/Missing/Agenda/Sources nav stubs; only dashboard + library + settings are real. Processing list is blackhole-in-flight filenames only. |
| **Missing episodes view** | **Missing** | Badge count never populated; no `/api/missing` aggregating tracked + no `file_path`. |
| **Tags** | **Missing** | No series tags for bulk edit / delayed profiles / indexer restrictions. |
| **Naming / path templates** | **Partial** | Hardcoded Sonarr-like path in `Oracle.buildPath`. No user-editable naming tokens. |
| **Multi-episode / specials** | **Partial** | Parser supports multi-ep ranges; specials (`S00`) and packs not first-class. |
| **Failed import recovery** | **Missing** | No `failures` table / manual mapper UI (Phase 8 DoD still open). |
| **Daemonization** | **Partial** | `bun src/backend/server.ts` runs API + scheduler. Watcher is manual (`/api/system/watch/start` or CLI `watch`). No packaged systemd/Docker compose docs. |

### Low complexity / polish

| Feature | Status | Notes |
| :--- | :--- | :--- |
| **Root folder management** | **Done** | Multi-root + UI |
| **Bulk library scan** | **Done** | **Corrected 2026-07-16** — API + scheduled task; the CLI is intentionally gone (confirmed with the maintainer), not a gap. |
| **Expanded parser tests** | **Partial** | ~6 cases; target 50+ real-world names still open |
| **Structured logging** | **Missing** | `console.log` / `debugLog`; QualityEngine is especially noisy |
| **WebSocket live monitor** | **Missing** | Polling only (`/api/system/processing`, events) |
| **Quality / profile UI** | **Done** | **Corrected 2026-07-16** — Settings has a "Quality" tab backed by `QualityProfilesTab`; not missing. |
| **Default quality seed data** | **Done** | **Corrected 2026-07-16** — `DatabaseManager.seedDefaults()` runs on every DB init and seeds quality definitions (SDTV through Remux-2160p), a handful of custom formats (HDR/x265/HEVC/H265), and two starter profiles (Standard, Anime). A fresh DB is not empty. |
| **Docs accuracy** | **Done** | **Corrected 2026-07-16** — `codebase-mapping.md` regenerated against the real `src/backend`/`src/frontend` tree; `progress.md`, `roadmap.md`, `implementation_plan.md`, `translations_needed.md`, and `screenshots-plan.md` archived to `docs/archive/` (stale/superseded, no longer describe the live layout). This file (`sonarr-parity.md`) and `arch.md` are now the two maintained sources of truth. |

---

## Quality & profile management system

Target model (still the right design):

### 1. Quality definitions (the “what”)
Global tiers (`Bluray-1080p`, `Web-DL-1080p`, `HDTV-720p`, …).

- **Priority ranking** — implemented (`rank`)
- **Size constraints** — columns exist; **not enforced**
- **Aliases / detection** — **weak** (substring match on quality name only)

### 2. Quality profiles (the “goal”)
Per-show profile of acceptable qualities + cutoff.

- **Allowed qualities** — **corrected 2026-07-16: implemented.** `profile_qualities` allow-list is enforced by `QualityEngine.isQualityAllowed` (empty = unrestricted, non-empty = enforced).
- **Cutoff** — stored; still **not used** by `shouldUpgrade` / grab selection (not re-verified this pass beyond confirming no read of `cutoff_quality_id` in `quality_engine.ts`)
- **Language / delay** — **missing**

### 3. Custom formats (the “preference”)
Regex (or future conditions) with scores; highest total wins among allowed qualities.

- **Bonus / required / forbidden** — implemented in engine
- **Scoring in grab + import** — wired for both paths when profiles exist
- **UI + seed library of common CFs** — **missing**

**Selection logic (target):**

1. Filter forbidden CF / disallowed quality / size / language
2. Prefer higher quality rank until cutoff satisfied
3. Among equals, max custom-format score
4. Prefer seeders / age as tie-breakers (not implemented)

---

## Known bugs / sharp edges (review findings)

These are concrete code issues that block parity more than “missing features”:

1. ~~**`GrabberService` grab path is broken**~~ — **FIXED, verified 2026-07-16.** `grabRelease()` in `core/grabber_service.ts` correctly calls `release.indexer.grab(release)`, passing the full `IndexerResult` object as the `Indexer` interface requires (Prowlarr needs the raw ReleaseResource JSON, not just a guid/downloadUrl — see the comment on `IndexerResult.raw` in `providers/indexers/types.ts`). Manual and automatic grab both go through this path.
2. ~~**`DatabaseManager.updateShow` column mapping**~~ — **FIXED, verified 2026-07-16.** `updateShow()` in `db/index.ts` builds its Drizzle `set()` object explicitly (`root_folder_path: updates.rootFolderPath`, etc.) rather than passing camelCase keys through to raw SQL. PATCH `/api/shows/:id` writes the correct columns.
3. **Blackhole non-upgrade behavior** — not re-verified this pass. README/docs mention `manualReviewPath`; worth re-checking whether skipped files still land there or stay in the watch folder before release.
4. **Full-file SHA-256** — not re-verified this pass.
5. **Oracle always re-searches providers** — not re-verified this pass.
6. **Quality tests mutate the live `showflow.db`** — not re-verified this pass.
7. **API auth — partially addressed, verified 2026-07-16.** The `/api/admin/updates/*` routes (install/activate/status for the release pipeline) now require a bearer token, generated once on first boot and persisted to the DB (`checkAdminAuth()` in `server.ts`) — these are explicitly called out in code comments as "uniquely dangerous" since they download and execute a binary. Every other route, including `/api/settings` (which holds provider API keys), remains intentionally unauthenticated — a documented design decision for a self-hosted, single-user deployment expected to sit behind the operator's own network boundary, not an oversight. Worth confirming this tradeoff is acceptable for the target release audience before shipping.
8. **`saveShow` on import uses `INSERT OR REPLACE`** — not re-verified this pass.

---

## UI vs API matrix (dashboard)

| Surface | Status |
| :--- | :--- |
| Dashboard (calendar strip, health, activity) | Working (polling) |
| Library + poster grid + detail + track toggles | Working |
| Add show (provider search) | Working |
| Settings: general, roots, providers, Prowlarr, blackhole path | Working |
| Settings: qualities / profiles / custom formats | **Corrected 2026-07-16** — `QualityProfilesTab` (`QualityProfiles.tsx`) is a real, substantive component wired into a "Quality" tab in `SettingsPage.tsx`, not missing. |
| Agenda / Queue / Missing / Sources nav | **Corrected 2026-07-16** — `QueuePage.tsx`, `MissingPage.tsx`, and `SourcesPage.tsx` are real, non-trivial components (verified `QueuePage.tsx` renders the live activity/processing feed with typed event badges), not stub placeholders. Not fully re-audited for functional completeness in this pass. |
| Manual grab / interactive search from episode row | **Corrected 2026-07-16** — API exists and the grab bug is fixed (see "Known bugs" #1). |
| Live WebSocket activity | Missing |

---

## Priority roadmap to MVP (revised)

Order optimized for **one working autopilot loop** before polish.

1. ~~**Fix grab + release binding**~~ — **Done, verified 2026-07-16.** See "Known bugs" #1.

2. **Automated search task**  
   Scheduler task: for each tracked episode with no file (or below cutoff), search → score → grab. Rate-limit hard; respect `search_mode`.

3. **Download client v1**  
   Prefer one real client (qBittorrent *or* keep blackhole as default) with status polling and “completed → import” handoff. Blackhole remains valid for simple setups.

4. **Quality engine hardening**  
   Seed default qualities; enforce allowed + cutoff + min/max size; quieter logs; quality aliases; profile UI in Settings.

5. **Import failure queue**  
   `manualReviewPath` or DB `failed_imports` + UI mapper (unblocks trust).

6. **Proactive upgrades**  
   Scheduled upgrade searches once cutoff/score logic is trustworthy.

7. **Ops polish**  
   Missing page, history page, auth (API key), notifications, Docker/systemd docs, parser test expansion.

8. **Differentiators**  
   TMDB episode groups, absolute-number anime excellence, dual-provider remaps.

---

## Out of scope for MVP (track later)

- Full Sonarr Custom Format condition tree (except/include release group sets, media info probes)
- MediaInfo / ffprobe quality detection (not filename-only)
- Radarr-style movies
- Multi-user accounts / OAuth
- Indexer-direct (non-Prowlarr) integrations
- Full i18n (see `docs/archive/translations_needed.md`)

---

## Suggested doc hygiene

Keep this file as the **single source of truth** for Sonarr parity. When a row moves to Done:

- Tick it here  
- Note the PR/commit in `CHANGELOG.md`  
- `docs/progress.md` was archived to `docs/archive/progress.md` on 2026-07-16 and is no longer the live changelog — use `CHANGELOG.md` at the repo root instead  

Related but secondary: `docs/arch.md`, `docs/codebase-mapping.md` — both regenerated 2026-07-16 and now accurate against `src/backend`/`src/frontend`.
