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
**Status:** [DONE — pending field-test]
**Reported:** 2026-08-10
**Symptoms:**
- Releases get submitted to TorBox successfully (event log confirms).
- After TorBox reports "cached"/"completed", no files appear in the watch folder.
- Nothing downstream pulls/downloads the completed torrent.

**Root causes identified:**
1. `GrabberService.grabRelease()` created an **ephemeral** `TorboxDownloadClient` per call, so the long-lived background download task in `DownloadManager` never saw the same `activeTitles` state.
2. `TorboxDownloadClient.waitForDownload()` polled with a **fixed 10 s interval** and no terminal-state detection (stalled/error).
3. `TorboxDownloadClient.getStatus()` passed only `id` query param — some TorBox versions expect `torrent_id`.
4. Silent failures: HTTP errors during final file download just `continue`, no `db.logEvent`.

**Fixes applied (2026-08-10):**
- [x] `client.ts` — `/mylist` now sends both `id` and `torrent_id`.
- [x] `torbox.ts` — adaptive polling (10 s → 15 s → 20 s), terminal-state detection, transient-failure guard, explicit `db.logEvent` for every failure path.
- [x] `grabber_service.ts` — constructor accepts optional `DownloadManager`; uses its singleton TorBox client when present.
- [x] `routes/shows.ts`, `core/scheduler.ts` — pass `systemManager.getWatcher()` into `GrabberService`.

**Remaining verification:**
- [ ] End-to-end: grab a release, confirm `Queue → Active downloads` shows it, confirm file appears in watch folder, confirm `download` event with filename.

---

### 2. Manual Import — forceImport silently swallowed metadata failures
**Status:** [DONE]
**Reported:** 2026-08-10

**Root cause:**
`BlackholeClient.forceImport()` returned `{ ok: true }` regardless of `handleFile`'s outcome. `handleFile` logged failures to the events DB then silently returned.

**Fix applied:**
- [x] `blackhole.ts` — when `force: true`, throw on metadata-resolution failure so the route surfaces a real error to the UI.

---

### 3. Manual Import — no per-file season/episode override
**Status:** [DONE]
**Reported:** 2026-08-10

**What shipped:**
- API schema: `forceImportFile(filename, showId, overrides?: { season, episodes })` threaded through `routes/misc.ts` → `SystemManager` → `BlackholeClient`.
- Backend applies overrides in `handleFile` after `resolveWithGrabHint` and rebuilds `proposedPath` via new public `oracle.buildProposedPath`.
- `ManualImport.tsx`: Season & Episode cells are click-to-edit inline; overrides persist per-file until import; status badges surface "Assigned"/"Modified".

**Remaining verification:**
- [ ] Manual test with absolute-numbered anime (e.g. `S04E17` → override to `S01E41`).

---

### 4. Anime season-split across providers (multi-listing series)
**Status:** [BLOCKED — pending design sign-off]
**Reported:** 2026-08-10

#### Real-world failure mode (verified against production APIs)

*Honzuki no Gekokujou (Ascendance of a Bookworm)* — **TVDB id 366263**:

- **TVDB**: single series with all 60 episodes listed under S01.
- **Anidb**: split across 4 listings (14 + 12 + 10 + 24 eps).
- **Scene releases**: tag episodes as S0XEYY (e.g. `S04E17`).
- **User's import error**: `Could not find show "Honzuki no Gekokujou" on any configured provider` even though the show exists — because the resolver looked for S04E17 and TVDB only knows S01E60.

#### The data sources we considered

**Option A — AniDB episode-mapping file only** *(the previous plan)*
- Source: `https://github.com/Anime-Lists/anime-lists` master XML (~56k entries, community-maintained).
- Maps AniDB → TVDB + TMDB with offsets.
- **Critical gap**: doesn't know about **scene numbering**. For Honzuki S04 we have:
  - AniDB S04E17 → TVDB "no such season"
  - Scene S04E17 → AniDB S04E17 (they agree)
  - But the **show exists on TVDB at all** is the failure — AniDB data can't tell us "this TVDB show is really 4 cours."
- **Verdict:** inadequate as the *only* source. Useful as fallback for shows where AniDB has the split but TVDB consolidated (e.g. Mushoku Tensei).

**Option B — TheXem (thexem.info) mapping API**
- Source: `https://thexem.info/doc` — REST API, community-maintained.
- Maps across **tvdb / anidb / scene / trakt / mal / imdb / tmdb** in one call.
- For tvdb 366263 returns 60 rows like:
  ```json
  {"scene":{"season":4,"episode":17,"absolute":53},
   "anidb":{"season":4,"episode":17,...},
   "tvdb":{"season":1,"episode":53,...}}
  ```
- Free, no auth. Caching headers permit week-long storage. Servarr wiki documents it as the backing service for Sonarr's anime handling.
- **Verdict:** the canonical source for this problem. **Recommended primary.**

**Option C — Composite (thexem primary + AniDB fallback)**
- Use TheXem when it has the show (covers scene↔tvdb↔anidb in one shot).
- Fall back to AniDB master XML when TheXem is missing or rate-limited.
- Most robust, but adds operational complexity: two ingestion paths, two schemas to maintain.

**Option D — Manual offsets only (current as of #3)**
- Per-file override already shipped. Works but requires manual work per show/cour.

#### Recommendation

**Option B (TheXem API) as primary, with option to layer in Option A (AniDB XML) later if TheXem coverage proves thin.**

Reasons:
1. TheXem covers **scene numbering**, which is what anime release groups actually use. AniDB-only data can't tell us S04E17 exists on a TVDB show; TheXem already knows.
2. Sonarr's anime mode has been battle-tested against TheXem for years — its semantics are stable.
3. Single ingestion path, single schema. If a show isn't on TheXem yet, the user can submit it (community-driven) instead of us maintaining a private mapping.
4. The AniDB XML file is still useful as a fallback for *very new* shows not yet on TheXem, but we shouldn't add it until we see if TheXem alone leaves gaps.

#### Open questions to resolve before implementing

| # | Question | Recommendation |
|---|---|---|
| Q1 | Should TheXem be queried **per-request** (fresh, ~50 ms, rate-limited) or **bulk-cached** (~56 KB/show, weekly sync)? | **Per-request with 7-day TTL cache.** TheXem's caching headers explicitly allow this; bulk sync wastes bandwidth for shows we'll never touch. |
| Q2 | When TheXem is missing a show, how do we surface that to the user? | Show a "Not on TheXem" badge on the show detail page with a "Request mapping" link to thexem.info (community submission flow is documented at `/xem/add`). |
| Q3 | Should the mapping apply to **only** episode resolution, or also **season folder naming**? | Both. If we map scene S04E17 → tvdb S01E53, then folder should be `Season 01/` (TVDB's view) but the *filename* could keep the scene S04E17 suffix for clarity — user preference. |
| Q4 | Per-show opt-in, or library-wide toggle? | Per-show toggle (on show edit page). Anime-only by default. Standard shows are unaffected. |
| Q5 | How do we handle **partials** — e.g. a show that starts 1:1 with TVDB but splits at season 3? | TheXem mappings are already per-episode. Our resolver should iterate the mapping for the requested filename and use whichever row matches the scene numbering. |
| Q6 | Should we also index the **aliases** TheXem returns? (Honzuki has EN, JP, and per-season JP titles.) | Yes — feed these into `show_titles` so the Oracle can find them on a future import without re-querying TheXem. |

#### Backend implementation plan (phases)

**Phase A — Schema + ingestion (≈ 300 LOC + migration)**
- New table `thexem_mappings`:
  ```sql
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id TEXT NOT NULL REFERENCES shows(id),
  tvdb_id TEXT NOT NULL,
  scene_season INTEGER, scene_episode INTEGER, scene_absolute INTEGER,
  anidb_season INTEGER, anidb_episode INTEGER, anidb_absolute INTEGER,
  tvdb_season INTEGER,  tvdb_episode INTEGER,  tvdb_absolute INTEGER,
  source TEXT DEFAULT 'thexem',   -- 'thexem' | 'anidb' | 'manual'
  fetched_at TEXT DEFAULT (datetime('now')),
  UNIQUE(show_id, scene_season, scene_episode)
  ```
- New module `src/backend/providers/thexem/client.ts` (~80 LOC):
  - `getMappingAll(tvdbId)`, `getMappingSingle(...)` — wraps `/map/all`, `/map/single`
  - Honors their `Cache-Control` headers, mirrors to SQLite for offline reuse
- Extend the show edit/sync flow to accept `enableThexemMapping: true` in `shows.config`.

**Phase B — Resolver integration (≈ 120 LOC)**
- In `Oracle.resolveWithGrabHint()`, after parsing succeeds but before provider episode lookup:
  1. If show has TheXem enabled and `parsed.season` + `parsed.episodes` exist:
     - Look up the candidate mapped rows in `thexem_mappings` where `(scene_season = parsed.season AND scene_episode IN parsed.episodes)`.
     - For each matched row, fetch the **TVDB** episode via the primary provider.
     - Cache those episodes, build `proposedPath` from the TVDB S/E values.
  2. If no match (or mapping disabled), fall through to existing resolution.

**Phase C — Background jobs**
- New TaskName `thexem-refresh` (weekly, opt-in during onboarding) that walks shows with `enableThexemMapping = true` and re-fetches their mapping rows.
- Refresh rate: align with TheXem's own cache TTL (7 days).

**Phase D — UI (≈ 250 LOC)**
- ShowDetail settings panel: "Provider Mapping" section with:
  - Toggle: "Use TheXem community anime mapping"
  - When enabled: read-only table of `scene S/E ↔ anidb S/E ↔ tvdb S/E` derived from the local cache
  - "Refresh mapping" button to force re-fetch
  - "Source: thexem (fetched 3 days ago)" attribution
- On `release-search`/`grab` flows, log a `pipeline_event` noting which mapping row was applied — helps debug "wrong episode imported" reports later.

**Phase E — Optional fallback**
- Only if TheXem coverage gaps emerge after deployment: layer in the AniDB master-XML scraper (Option A) behind the same `source` column. Will reuse the `thexem_mappings` table — AniDB rows just have `source = 'anidb'` and a null `scene_*` triplet.

#### Frontend implementation plan (≈ 350 LOC)

**Settings → new "Anime Mapping" card** (under show detail's existing settings tab):

```
[ ] Use TheXem community anime episode mapping
    When enabled, releases tagged with the scene season (e.g. S04E17)
    are resolved against TVDB's actual numbering (e.g. S01E53) using
    thexem.info's community anime list.
    Source: thexem.info · last fetched 2 days ago · 60 episodes mapped
    [Refresh mapping]  [View mapping table]  [Report missing season]
```

- Toggle is stored per-show in `shows.config` (`thexem: { enabled: true, lastSyncedAt }`).
- "View mapping table" opens a read-only modal showing scene/anidb/tvdb S/E side-by-side.
- "Report missing season" opens a link to `https://thexem.info/xem/add?origin=tvdb&id=<tvdbId>`.

**ManualImport.tsx changes:**
- When a force-import triggers the TheXem path, log `[Mapping] scene S04E17 → tvdb S01E53` to the activity event so the user sees what was applied.
- The "Assigned"/"Modified" badges already stretch to cover this — no UI changes needed for the inline editing work in #3.

**ShowDetail.tsx changes:**
- New **Mapping** column tag on episode row when the displayed S/E came from a TheXem mapping (vs the provider's native S/E).

#### Migration plan

- Existing shows default to `thexem.enabled = false`. No surprises for current libraries.
- A Settings → System toggle ("Enable TheXem auto-suggest for new anime shows") flips the default for new library additions only.

#### Dependencies
- No new npm packages — TheXem is plain JSON over HTTPS.
- Existing `db.getCache`/`setCache` handles the HTTP cache; we add a per-show fetch for live view.

#### Non-goals
- Editing TheXem mappings from inside ShowFlow (community edits belong upstream).
- Trakt/MAL/IMDb mappings TheXem also exposes — we don't need them today.
- Movies (Honzuki movies, OVAs). TheXem has them, but the schema above intentionally keeps `season`/`episode` fields nullable so movies live in a separate table later without a data migration.

---

### 5. Series folder naming doesn't match Sonarr's preferred format
**Status:** [DONE]
**Reported:** 2026-08-10

**Fix applied (2026-08-10):**
- [x] `Oracle.sanitize()` now strips only `< > " / \ | ? *`. Colons and dashes are preserved verbatim.
- [x] New endpoints `GET /api/shows/:id/rename-preview` and `POST /api/shows/:id/rename-apply`.
- [x] `ShowDetail` "Rename Folder" button: preview dialog shows current/proposed name, episode-impact count, and a Plex/Jellyfin refresh warning.

**Remaining verification:**
- [ ] Manual rename on a show with existing episodes.
- [ ] Decide whether `Organize` should respect any future per-`library_type` `series_folder_format` template (currently hardcoded `show - S01E01.ext`).

---

## Backlog / Unprioritised

| # | Issue | Notes |
|---|---|---|
| B1 | Manual Import list view OOMs when watch folder is large + heavy shows | Mitigated by cache (30 s TTL), see `docs/manual-import-oom.md` — long-term fix is to batch-resolve |
| B2 | SonarrImportDialog UX for multi-root-folder setups | Improvement, not bug |
| B3 | EpisodeChip color-coding for upgrade states | Cosmetic |
| B4 | Release notes/CHANGELOG automation on `bun run release` | Process gap |
| B5 | Retry queue for failed TorBox downloads (vs one-shot) | Currently just logs and gives up; consider persistent "retry at next RSS" |
| B6 | `Organize` should respect a `series_folder_format` template | Currently hardcoded `show - S01E01.ext`; decouple from #5 once templates land |

---

## Recently Completed

| # | Issue | Completed |
|---|---|---|
| 2 | forceImport silent-failure | 2026-08-10 |
| 3 | Manual season/episode override | 2026-08-10 |
| 1 | TorBox pipeline (polling, error logging, ephemeral client, status query compat) | 2026-08-10 (pending field-test) |
| 5 | Folder naming colon-preservation + rename preview/apply | 2026-08-10 |

---

## How to use this doc

1. **Add new issues** under *Active Issues*, assigned a number. Don't remove completed ones immediately — move them to *Recently Completed* once verified in production.
2. **When starting work**, flip status to `[IN PROGRESS]` and add yourself to an "owner" line.
3. **Cross-reference** item numbers from commit messages (`fix(#4): …`) to make future archaeology easier.
4. **Archive** quarterly: move resolved items older than ~3 months to `docs/archive/issues-YYYY-QN.md`.
