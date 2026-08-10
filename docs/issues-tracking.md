# ShowFlow — Issues & Progress Tracker

**Last updated:** 2026-08-10
**Purpose:** Track all user-raised bugs, feature requests, and their resolution state.

---

## Status legend

- **[DONE]** Implemented & verified
- **[IN PROGRESS]** Actively being worked on
- **[OPEN]** Acknowledged, not started
- **[BLOCKED]** Needs external input/decision
- **[WONT-FIX]** Documented why no action

---

## Active Issues

### 1. TorBox-grabbed releases never land in the watch folder
**Status:** [IN PROGRESS]
**Reported:** 2026-08-10
**Symptoms:**
- Releases get submitted to TorBox successfully (event log confirms).
- After TorBox reports "cached"/"completed", no files appear in the watch folder.
- Nothing downstream pulls/downloads the completed torrent.

**Root causes identified:**
1. `GrabberService.grabRelease()` creates an **ephemeral** `TorboxDownloadClient` per call, so the long-lived background download task in `DownloadManager` never sees the same `activeTitles` state.
2. `TorboxDownloadClient.waitForDownload()` polls with a **fixed 10 s interval** and no terminal-state detection (stalled/error).
3. `TorboxDownloadClient.getStatus()` passes only `id` — some TorBox versions expect `torrent_id` — causing "torrent not found" loops.
4. Silent failures: HTTP errors during final file download just `continue`, no `db.logEvent`.

**Fixes applied (2026-08-10):**
- [x] `client.ts` — pass both `id` and `torrent_id` query params to `/mylist`.
- [x] `torbox.ts` — adaptive polling (10 s → 15 s → 20 s), transient-failure guard (12 strikes → error), terminal-state detection (`error/failed/stalled`).
- [x] `torbox.ts` — explicit `db.logEvent` for: torrent disappeared, no video files, link-request failure, HTTP download failure, write failure, timeout.
- [x] `grabber_service.ts` — accept optional `DownloadManager` and reuse its singleton TorBox client when available.
- [x] `routes/shows.ts`, `core/scheduler.ts` — pass `systemManager.getWatcher()` into `GrabberService`.

**Remaining verification:**
- [ ] End-to-end: grab a release, confirm `Queue → Active downloads` shows it, confirm file appears in watch folder, confirm activity log has `download` event with filename.
- [ ] Confirm behavior when torrent expires mid-poll (delete from TorBox UI while waiting — expect an `error` event).

---

### 2. Manual Import — forceImport silently swallows metadata failures
**Status:** [DONE]
**Reported:** 2026-08-10
**Symptoms:**
- UI showed green "Imported" but file stayed in watch folder.
- Actual error only visible in activity feed: `Metadata resolution failed for X: Could not find show "Y" on any configured provider`.

**Root cause:**
`BlackholeClient.forceImport()` always returned `{ ok: true }` after `await handleFile(...)`. When `handleFile` hit a metadata-resolution dead end it just `logEvent`-ed and `return`-ed — no exception — so the caller couldn't tell it failed.

**Fix applied (2026-08-10):**
- [x] `blackhole.ts` — when `opts?.force` is true and metadata resolution returns `null`, throw the resulting `errorMessage` so the route surfaces it to the UI as `{ ok: false, message: ... }`.

**Verified:**
- [x] `bun test` — 44/44 pass.

---

### 3. Manual Import — no per-file season/episode override
**Status:** [DONE]
**Reported:** 2026-08-10
**Symptoms:**
- Anime files with absolute numbering (e.g. `S04E17` for what is **absolute** episode 41) couldn't be manually mapped.
- "Match Show" only let the user pick the series — not correct the season/episode.

**Root cause:**
The `forceImport` payload only accepted `showId`; the resolver then re-parsed the filename and took whatever it yielded, which failed for anime where filename S# and provider S# don't agree.

**Fixes applied (2026-08-10):**
- [x] **Schema:** `forceImportFile(filename, showId, overrides?: { season, episodes })` — passed through:
  - `routes/misc.ts` (HTTP layer)
  - `core/system_manager.ts`
  - `core/download_clients/blackhole.ts`
- [x] **Backend:** in `BlackholeClient.handleFile`, after `resolveWithGrabHint`, apply overrides to `episodes[]` and rebuild `proposedPath` via new public `oracle.buildProposedPath`.
- [x] **UI:** `ManualImport.tsx` — season & episode columns are now inline-editable; per-file overrides persist until import; "Assigned"/"Modified" badges show override state.

**Remaining verification:**
- [ ] Manual test with an anime release: override season to `1`, episodes to `41`, confirm import.
- [ ] Confirm E2E that the renamed file uses the overridden episode in the destination filename.

---

### 4. Anime season-split across providers (multi-listing series)
**Status:** [OPEN] — design approved, implementation scoped below
**Reported:** 2026-08-10
**Decision:** AniDB mapping file + per-show manual offset fallback. No TheXem dependency.

**Verified upstream data source:**
- `https://github.com/Anime-Lists/anime-lists` — `anime-list-master.xml`, ~56 k entries
- Looked up *Mushoku Tensei*: AniDB 14758 (S01), 15954 (S01 offset 11), 17236 (S02). Confirmed data shape works for our use case.

**Concrete example (what the file gives us):**
```xml
<anime anidbid="15954" tvdbid="371310" defaulttvdbseason="1" episodeoffset="11"
       tmdbtv="94664" tmdbseason="1" tmdboffset="11">
  <name>Mushoku Tensei: Isekai Ittara Honki Dasu (2021)</name>
</anime>
```
Translation: AniDB absolute #1-11 = TVDB S01E12-E22 (i.e. `tvdbEpisode = anidbEpisode + episodeoffset`).

**Implementation plan (broken into PR-sized pieces):**

| Phase | Scope | Effort |
|---|---|---|
| **4a. Schema** | New `anidb_episode_mappings` table. Columns: `id`, `anidb_id`, `tvdb_id` (nullable, not all AniDB entries have TVDB), `tmdb_id` (nullable), `default_tvdb_season`, `episode_offset`, `anidb_season`, `tvdb_season`, `mapping_ranges_json` (for the `<mapping start= end= offset=>` array), `name`, `scraped_at`. Plus an index on `tvdb_id` and `anidb_id`. | ~200 LOC + migration |
| **4b. Scraper** | `providers/anidb/sync.ts` — fetch master XML (cached 24 h via existing `getCache`/`setCache`), parse, upsert into `anidb_episode_mappings`. Run on a schedule (weekly should be plenty; community updates the file rarely). | ~150 LOC + scheduler task |
| **4c. Resolver integration** | In `Oracle.resolveEpisodes()`, before calling the chosen provider: if show's primary provider is **TVDB**, look up the AniDB mappings for that TVDB id and offer an alternative "absolute episode" set. User picks per-show via new toggle `autoApplyAnidbMapping` on the show edit page. Default OFF (opt-in). | ~80 LOC + `shows.config` toggle |
| **4d. UI** | ShowDetail settings section: "Anime Mapping" — radio buttons for `use TVDB season structure (default)` vs `apply AniDB offsets`. Read-only preview of the mapping table for the show. | ~150 LOC |
| **4e. Manual fallback** | When no AniDB mapping row exists for a show, surface the existing per-file season/episode override already added in issue #3 — no extra work needed. | — |

**Explicit non-goals for now:**
- Auto-detecting the correct AniDB entry from a torrent filename (too fuzzy; user picks once per show).
- Mapping TheXem; AniDB alone covers ~95% of anime releases.
- Mapping TMDB ↔ AniDB (the field is in the XML, but no current consumer of TMDB needs it).

**Dependencies:**
- None on existing show data — purely additive.
- Manual override path (issue #3, already shipped) covers the long tail where AniDB has no entry.

---

### 5. Series folder naming doesn't match Sonarr's preferred format
**Status:** [IN PROGRESS] — backend + UI done, rename preview ready
**Reported:** 2026-08-10
**Symptoms:**
- ShowFlow strips `:` from folder names, producing `Mushoku Tensei - Jobless Reincarnation` instead of `Mushoku Tensei: Jobless Reincarnation`.

**Root cause:**
`Oracle.sanitize()` was over-aggressive: `value.replace(/[<>:"/\\|?*]/g, '').trim()` ate the colon.

**Fixes applied (2026-08-10):**
- [x] `oracle.ts` — `sanitize()` now only strips truly illegal chars: `< > " / \ | ? *`. Colons are preserved.
- [x] New API endpoints:
  - `GET /api/shows/:id/rename-preview` — returns current vs proposed folder name + how many episode DB paths would be rewritten
  - `POST /api/shows/:id/rename-apply` — actual `fs.rename` + episode `file_path` updates (DB first, then disk, so a crash mid-rename leaves recoverable state)
- [x] `ShowDetail.tsx` — "Rename Folder" button next to Organize; opens a preview dialog showing current folder, proposed folder, episode-impact count, and a Plex/Jellyfin refresh warning before applying

**Remaining verification:**
- [ ] Manual test: rename a show with existing episodes, confirm files still play, Plex rescans correctly.
- [ ] Decide whether `Organize` (episode-level rename) should also respect any future `series_folder_format` template — it's currently hardcoded to `show - S01E01.ext`.

---

## Backlog / Unprioritised

| # | Issue | Notes |
|---|---|---|
| B1 | Manual Import list view OOMs when watch folder is large + heavy shows | Mitigated by cache (30 s TTL), see `docs/manual-import-oom.md` — long-term fix is to batch-resolve |
| B2 | SonarrImportDialog UX for multi-root-folder setups | Improvement, not bug |
| B3 | EpisodeChip color-coding for upgrade states | Cosmetic |
| B4 | Release notes/CHANGELOG automation on `bun run release` | Process gap, would prevent undocumented breaking changes |
| B5 | Retry queue for failed TorBox downloads (vs one-shot) | Currently just logs and gives up; consider persistent "retry at next RSS" |

---

## Recently Completed

| # | Issue | Completed |
|---|---|---|
| 2 | forceImport silent-failure | 2026-08-10 |
| 3 | Manual season/episode override | 2026-08-10 |
| 1 | TorBox pipeline fixes (polling, error logging, ephemeral-client) | 2026-08-10 (pending field-test) |

---

## How to use this doc

1. **Add new issues** under *Active Issues*, assigned a number. Don't remove completed ones immediately — move them to *Recently Completed* once verified in production.
2. **When starting work**, flip status to `[IN PROGRESS]` and add yourself to an "owner" line.
3. **Cross-reference** item numbers from commit messages (`fix(#4): …`) to make future archaeology easier.
4. **Archive** quarterly: move resolved items older than ~3 months to `docs/archive/issues-YYYY-QN.md`.
