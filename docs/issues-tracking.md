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
**Status:** [OPEN] — design signed off 2026-08-10; implementation scoped
**Reported:** 2026-08-10

#### Real-world failure mode (verified against production APIs)

*Honzuki no Gekokujou (Ascendance of a Bookworm)* — **TVDB id 366263**:

- **TVDB**: single series with all 60 episodes listed under S01.
- **Anidb**: split across 4 listings (14 + 12 + 10 + 24 eps).
- **Scene releases**: tag episodes as S0XEYY (e.g. `S04E17`).
- **User's import error**: `Could not find show "Honzuki no Gekokujou" on any configured provider` even though the show exists — because the resolver looked for S04E17 and TVDB only knows S01E60.

#### Decision — two-tier mapping (signed off 2026-08-10)

| # | Question | Decision |
|---|---|---|
| Q1 | TheXem query cadence | **Per-request with 7-day TTL cache** (TheXem `Cache-Control` allows it; bulk sync wastes bandwidth). |
| Q2 | Show not present in TheXem | **Fall back to the shared tvdb/anidb/anilist custom mapping** (auto-seeded; we maintain it ourselves). Surfaced via a badge + fix control + mismatch drill-down so the user always sees *what* mapping occurred, *from which source*, and *where sources disagree*. **Never require hand-mapping when an automated source exists** — manual work only for what genuinely can't be derived. |
| Q3 | Scope of the mapping | Both **episode resolution AND folder naming**: folder uses the provider's view (e.g. TVDB `Season 01`), filename may keep the scene suffix (e.g. `S04E17`) — user preference, configurable. |
| Q4 | Opt-in scope | Per-show toggle, **default ON when `series_type === 'anime'`**, OFF otherwise; user can override per show. |
| Q5 | Partials (1:1 until S3, then split) | Iterate mapping **per episode** — a single show can use different tiers across different episodes. |
| Q6 | Aliases | Capture **all unique confirmed aliases** per series, deduped (normalized equality — lowercase, strip punctuation, drop leading articles); feed into `show_titles` for fast local lookup. |

Follow-up clarifications (2026-08-10):

| # | Question | Decision |
|---|---|---|
| F1 | Who builds the mapping? | **Auto-seed + manual fix.** Sync the community sources into our own table; manual fixes/confirmations layer on top (confirmed rows are locked from refresh). Manual mapping is a last resort only. |
| F2 | Source precedence on conflict | **Provider-native for the resolved target** (usually TVDB) is authoritative for the final S/E; AniDB informs the scene-season structure; **disagreements are flagged as a badge, never a silent guess**. |
| F3 | Where does the UI live? | **Per-show panel only** — no global mappings page. Badge + fix control + mismatch drill-down in show detail settings. |
| F4 | What triggers the warning badge? | **ANY disagreement across sources** — season-structure split, episode counts, or alias conflicts. |

#### Why TheXem stays primary (Tier 1)

- TheXem is the only source here that actually knows **scene numbering** (verified: `map/all?id=366263` → `scene S04E17 abs 53` ↔ `tvdb S01E53` ↔ `anidb S04E17`). The AniDB offset model cannot express "this TVDB show is really 4 cours" on its own.
- It is the source Sonarr's anime mode has run on for years — stable, well-understood semantics.

#### Fallback tier (Q2) — shared custom mapping for anything not in TheXem

Self-managed table, auto-seeded from:

1. **AniDB** (`anime-list-master.xml`, ~56k entries) — tvdb↔anidb offsets (`episodeoffset`, `defaulttvdbseason`), cross-refs, structure for partitioned cours.
2. **AniList** (existing `providers/anilist.ts`) — AniList IDs + title aliases.

The per-show badge exists precisely so that while this tier is doing work, the user can see what resolved where and fix the genuinely-broken cases — without being forced to hand-map anything the sources already tell us.

#### Backend implementation plan (phases)

**Phase A — Schema + migration (≈ 300 LOC)**
- New table `episode_mappings` (holds both tiers):

```sql
id            INTEGER PRIMARY KEY AUTOINCREMENT,
show_id       TEXT NOT NULL REFERENCES shows(id),
tvdb_id       TEXT NOT NULL,
scene_season  INTEGER, scene_episode INTEGER, scene_absolute INTEGER,   -- thexem tier (nullable)
anidb_season  INTEGER, anidb_episode INTEGER, anidb_absolute INTEGER,   -- tier-2 structure (nullable)
target_season INTEGER, target_episode INTEGER, target_absolute INTEGER, -- provider-native target
source        TEXT NOT NULL DEFAULT 'thexem',  -- 'thexem' | 'anidb' | 'anilist' | 'manual'
locked        INTEGER DEFAULT 0,               -- user-confirmed; excluded from refresh overwrite
conflict_json TEXT,                            -- structured disagreement notes across sources
scraped_at    TEXT DEFAULT (datetime('now')),
UNIQUE(show_id, scene_season, scene_episode)
```

- Per-show derived health (`mapping_health` in `shows.config` or computed cache): `ok` / `conflicts` / `missing` — the source of the frontend badge.

**Phase B — Sync / ingestion (≈ 200 LOC)**
- `providers/thexem/client.ts` — `getMappingAll(tvdbId)`, `getMappingSingle(...)`; honors `Cache-Control`, mirrors rows into `episode_mappings` (`source='thexem'`).
- AniDB master-XML scraper — same table, `source='anidb'`, nullable `scene_*` triplet.
- AniList alias pass — normalize + dedupe aliases into `show_titles`.
- Scheduled task `episode-mapping-refresh` — weekly; refreshes only `locked = 0` rows; on any cross-source disagreement writes `conflict_json` (F2/F4).

**Phase C — Resolver integration (≈ 120 LOC)**
- In `Oracle.resolveWithGrabHint()`, after a successful parse, when mapping is enabled:
  1. Match `scene_season`/`scene_episode` → read `target_*` → resolve provider episode → build `proposedPath` from target S/E.
  2. No TheXem row but an AniDB row exists → anidb→target offset (provider-native authoritative, F2).
  3. If agreement checks fail, still resolve but attach `conflict_json` so the badge surfaces (F4).
- If mapping disabled or no row, existing resolution path is unchanged.

**Phase D — Conflict / mismatch detection (≈ 100 LOC)**
- Compare tvdb / anidb / anilist per show on each refresh: season structure, episode counts, alias sets. Any disagreement → `mapping_health = 'conflicts'` with details in `conflict_json`. No mapping at all → `'missing'`.

#### Frontend implementation plan (per-show panel only, ≈ 300 LOC)

**ShowDetail → settings "Provider Mapping" card**

```
[x] Use anime episode mapping                 (default ON when series_type = anime)
    Tier 1: thexem · last fetched 2 days ago · 60 episodes mapped
    Tier 2: anidb/anilist fallback · 3 cours offset-mapped
    ! 2 conflicts with AniDB — view           (amber/red badge = F4)

    [?] Which sources disagree, on which seasons, and what resolved
    [Refresh mapping]  [View mapping table]
```

- Toggle: default ON for `series_type === 'anime'`, OFF otherwise; per-show override (Q4).
- **Badge** on the show: green `ok` / amber–red `conflicts` / gray `missing`. Any cross-source disagreement → red state (F4).
- **Fix control**: edit individual rows or season offsets; mark a row "confirmed" to lock it (`locked = 1`), excluding it from refresh — the auto-seed + manual-fix model (F1).
- Mapping table modal: scene / anidb / provider-target side-by-side; offset view for tier-2 shows.
- `ManualImport.tsx` — when a mapped row applies, log `[Mapping] scene S04E17 → tvdb S01E53` to the activity event so the user sees exactly what was applied.

#### Migration plan

- Existing shows: mapping `enabled = true` where `series_type = 'anime'`, `false` otherwise — mirrors Q4's default. Standard/daily libraries are untouched; anime libraries benefit immediately. Per-show override available.

#### Dependencies
- No new npm packages. TheXem = plain JSON over HTTPS; AniDB = the already-scoped XML scraper; AniList = existing `providers/anilist.ts`.

#### Non-goals
- Pushing corrections to TheXem from inside ShowFlow (submit fixes upstream, on thexem.info). Local overrides/locks only.
- Trakt/MAL/IMDb mappings.
- Movies/OVAs — separate table later; `season`/`episode` fields stay nullable so that migration is trivial.

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

**Amendment (2026-08-19):** Colons are now stripped too. macOS/APFS cannot represent `:` and Samba exposes such folders to Finder as 8.3 mangled names (e.g. `REJ1JG~5`), so keeping colons verbatim broke SMB shares. Existing colon-named folders/files were renamed and DB paths rewritten in-place.

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
