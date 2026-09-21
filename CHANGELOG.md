# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]
- **Mobile settings**: the section dropdown is gone. Phone layouts now open a tappable list, then either a bottom sheet (General, Providers, Indexers, Integrations, Quality) or a full-screen drill-down (Appearance, Naming, Downloads, Tasks, Backup, Analytics, Debug). Deep-links into a tab still land on that section.
- **Mobile chrome**: bottom nav is five items (Dashboard, Calendar, Library, Queue, More) with a slide-up More sheet for the rest; the shell uses `100dvh` + iOS safe-area padding so content clears the home indicator.

## [v0.1.72] - 2026-09-18
- **Fix**: the Search Releases dialog now shows the alt release numbering next to the provider episode (e.g. `S01E49 | S04E13`; pack searches list the alt seasons the same way), so it's visible which numbering was queried instead of guessing from the result titles.

## [v0.1.71] - 2026-09-18
- **Fix**: one-click flat rebuild for episode mappings when TheXem is unreachable. If the provider lists everything as one season (e.g. TVDB `S01E01–60`) but the sync is down and rows were corrupted by an identity Fix All, "Rebuild flat targets" in the Fix All panel re-derives each row's provider target from its intact scene absolute number (scene `S04E13` abs 49 → provider `S01E49`), so scene-direction searches work again without hand-fixing 60 rows.

## [v0.1.70] - 2026-09-18
- **Fix**: wrongly-locked episode mappings can now be reverted. A bulk Fix All with offset 0 on a season-split show stamps scene==provider identities (e.g. `S04E18 → S04E18`) that destroy the real TheXem rows — and locked rows survived every future sync with no way back. Per-row **Revert** buttons plus a bulk "revert all fixes" hand rows back to the sync job so the next refresh replaces them. The grabber also logs the fallback reason now (`No scene mapping for "Show S01E49" (N rows) — searching provider numbering`) instead of silently searching provider numbering.

## [v0.1.69] - 2026-09-18
- **Fix**: anime season-split shows (e.g. Ascendance of a Bookworm) searched the wrong numbering and found nothing. The grabber built queries from provider-native numbering (`S01E58`) but releases/indexers use scene numbering (`S04E22`); the episode mapping was only applied on import, never on search. Searches now translate provider → scene via the mapping table (querying both namings, accepting either, deduped), and season-pack searches fan out to every scene season mapped to the provider season. Note: rows bulk-locked with offset 0 on a split show (`S04E18 → S04E18`) are identity mappings that destroy the real TheXem rows — those need a re-sync or manual correction before the new search path can resolve.

## [v0.1.68] - 2026-09-18
- **Concurrent download limiter**: grabs used to start downloading all at once — every queued TorBox download ran its own poll + file-fetch loop, so a burst of grabs (overnight auto-grab cycles, season packs, rapid UI clicks) fanned out unbounded against TorBox and local bandwidth. The existing `downloadClient.torbox.concurrency` setting was loaded but never enforced; it now gates a fair FIFO semaphore (default 3, adjustable 1–20 in Settings → Downloads → TorBox). Extra grabs queue with a visible `queued (N/M downloads active)` state on the Queue page and start as slots free up, and cancelling a queued grab releases its waiter without consuming a slot. Invalid legacy values fall back to the default instead of breaking config load.

## [v0.1.67] - 2026-09-17
- **Fix**: episodes no longer silently go ungrabbed. The "fully-automatic grab" was never wired to anything: the only periodic hook was the `rss-scan` task, which shipped *disabled* and whose body was a stub (`// RSS scanning logic would go here`) — every grab required someone clicking Auto in the UI, so anything airing overnight aged past its release window unnoticed. New `auto-grab` scheduled task (every 15 min, on by default) drives the existing pipeline: tracked episodes in auto search mode, missing from disk, past their `expected_release_at` — the air-window forecast that had been computed on every sync but never used for grabbing — newest-due first, capped per cycle so one tick can't hammer indexers after a long outage.
- **Re-grab guard**: an episode with a successful grab in the last 12h is skipped, so in-flight TorBox downloads aren't re-submitted every cycle (a download that died gets retried once the cooldown lapses; failed *searches* always retry, catching releases published after the last look). This also surfaced `grabbed_at` rows written by the column's `datetime('now')` default — space-separated timestamps sort *below* ISO cutoffs on the same day, so cooldown math silently misses; new writes are explicit ISO and queries normalize legacy rows.
- Scheduled ticks now run `downloading` tasks ahead of sync/maintenance work (actions are awaited sequentially, so an auto-grab queued behind a multi-hour scan would otherwise wait on it); the stale `rss-scan` row is dropped from the task list on boot, and scheduled grabs route through the watcher's long-lived TorBox client so the Queue page sees them.

## [v0.1.66] - 2026-09-17
- **Fix**: movie artwork no longer stuck on "no signal". A film's metadata sync reported success but never wrote image bytes, so posters only warmed lazily when the grid's `<img>` 404'd — which right after a bulk add meant every card independently re-hit the rate-limited TMDB `/movie/` endpoint, tripping a 429 storm that poisoned each show's warm behind a 10-minute negative backoff, well after the UI had already given up. Sync now warms artwork for movies (immediately) and shows, and the warmer resolves the poster URL from metadata it already fetched — so warming is one image download with zero extra API calls. A failed warm now self-heals (success clears the stamp; retry cooldown 10m → 60s).
- **Fix**: stopped crediting the wrong release as a file's origin. Movie/episode import stamped whatever the *most recent grab for the show* was onto whatever file actually landed, with no check they were the same release — e.g. a FraMeSToR REMUX grab shown as the origin of a DirtyHippie RIFE re-encode (`from: …-FraMeSToR` over a `…-DirtyHippie.mkv`). Imports and scans now only attach a grab's provenance when the grabbed release name matches the landed file (trailing scene group, then token containment); on disagreement the honest filename is kept instead. A one-time startup pass corrects already-misattributed rows.
- **Movie page shows its real metadata**: `GET /api/shows/:id` had been dropping the probed media and the release fields it stores, so the film page rendered almost nothing beyond a path + size. It now returns the full media object (HDR format, audio languages/tracks, release tags) and the movie panel is redesigned into a Radarr-style two-column Media / File spec, with a header rating, a runtime · release-date · language · studio line, and TMDB/IMDb links.

## [v0.1.65] - 2026-09-17
- **Release updates go RSS-driven**: the Updates flow no longer polls the rate-limited GitHub Releases API (whose 60 req/hr unauthenticated budget a "Track Build" loop burned in minutes, 429-ing everything after). Discovery now subscribes to `https://github.com/<repo>/releases.atom` with `ETag`/`If-None-Match`, served from GitHub's web CDN and exempt from the REST rate limit — a no-change check is a ~200-byte `304`, so it can't 429. New `core/update_watcher.ts` runs a background pass that parses the feed, and when a strictly-newer tag appears it makes exactly one API call to resolve + download the `showflow-<sha>.tar.gz`, hands it to the supervisor to verify and stage, then records it as a pending update. Net: quota is spent per *actual release*, never per poll.
- **Auto-download + one-click activate**: a newly published release is downloaded and verified automatically (toggleable, default on); the notification area then shows *"Update v0.1.65 is ready to activate"* linking to the panel, whose banner Activate button runs the existing supervisor handoff. Activation stays strictly manual. `reconcilePendingOnBoot()` clears the marker once the running build matches, so the notification disappears after a successful apply.
- **Adaptive polling for the dev loop**: while the Updates panel is open and the tab visible it checks the feed every ~20s (pausing when hidden) so a freshly-pushed release stages in seconds; the scheduler's `update-check` task dropped from weekly to 15 min for the closed-tab floor. New `POST /api/admin/updates/check` (with a force flag for a "Check now" button), `GET/POST /api/admin/updates/settings` (auto-download toggle), and `GET /api/admin/updates/pending`.

## [v0.1.64] - 2026-09-17
- **Full media detail on films and episodes**: the movie page showed only a bare file path and `AVAILABLE · 35.7 GiB`, throwing away the resolution/codec/HDR/audio/bitrate the pipeline had already probed and stored. `GET /api/shows/:id` now returns the probed media (via the same `serializeFileMedia` the episode list uses) plus the original release name, and the movie panel renders the shared `<MediaBadges>` — `2160p · HEVC · Dolby Vision · 60fps · TRUEHD · 7.1 · Atmos · EN/JA · Matroska · … · imported as: Thor.2011.2160p.DV…`.
- **Filename-derived quality metadata**: a demuxer can't tell Dolby Vision from HDR10+ from plain HDR10, can't see Atmos (it's an object-audio layer on a TrueHD track), nor bit depth, source grade (REMUX/WEB-DL), the language set, or AI/RIFE passes — but the release name carries all of it. New `core/release_meta.ts` extracts those into `hdr_format` + `release_tags` columns alongside the existing probe. The file's own truth still wins on resolution/codec/fps/bitrate; the name only fills what the file can't.
- **Deeper probe + confirmed languages**: media_probe now reads every audio track's language and title, so multi-language is established from the file (`audio_tracks`/`audio_languages`) rather than trusted from a `MULTI` tag. All three write paths (watch-folder import, library scan, startup backfill) fold probe + name through one shared `foldProbeToColumns` instead of each repeating the column mapping.
- **Backfill**: on startup a cheap, disk-free pass tags every stored file from its kept original release name (no re-read needed) so existing library rows light up badges immediately, before the slower re-probe of never-probed files. `migration 0005` adds the columns.

## [v0.1.63] - 2026-09-17
- **Cancel active downloads**: every in-flight item on the Queue page gains a cancel button. TorBox grabs are aborted mid-flight — the poll loop, retry backoffs, and any streaming file fetch all interrupt immediately, the torrent is deleted from the TorBox account so it stops caching/seeding, and the staged `.part` file is cleaned up. Watch-folder imports can likewise be stopped and deleted from the drop folder. Each cancel surfaces a "Cancelled by user" job failure and a log event, so nothing vanishes silently. New `POST /api/system/processing/cancel`; queue item ids are now stable (`torbox:<torrentId>` / `blackhole:<file>`).

## [v0.1.62] - 2026-09-17
- **Fix**: movie posters no longer 404. A bare numeric TMDB id (legacy rows, hand-added provider ids) is ambiguous — films and series are numbered in separate sequences — so the series lookup retried as a film on 404 instead of giving up. Covers the `/api/images/poster/:source/:id` route, the background artwork warmer, and the backdrop list, so film artwork self-heals with no migration.
- **Fix**: dropping a film into the watch folder now imports it. The filename parser read the release year (`Thor.2011.…`) as an absolute episode number, which disqualified the file from the movie matcher and sent it to the episode-only resolver: "Could not find show Thor on any configured provider." A lone year-shaped number that equals the film's own year no longer counts as an episode marker, and movie title parsing now cuts at the year, so quality/audio/group tags (`2160p.DV.Ai-Enhanced.RIFE…`) can't leak into the title and miss the library match.
- **Manual import is movie-aware**: watch-folder listings label film rows `movie` and resolve them against the library without a provider round-trip; the Season/Episodes columns collapse to a Movie badge; assigning a library film routes to the film importer and drops any stale season/episode override; the show picker shows each entry's type + year so a film is distinguishable from a same-titled series. Movie import failures (missing root folder, existing destination) now report instead of answering "Imported" with the file untouched.
- **Faster, safer big-file imports**: files over 512MB hash a size + head/middle/tail sample instead of streaming all 50GB through the hasher (the slowest, most memory-hungry step a film drop took); small files keep the exact historical digest so existing dedupe is untouched. Cross-device moves now use a kernel-side copy, with the chunked userspace stream kept only as a fallback.

## [v0.1.61] - 2026-09-17
- **Fix**: in-place updates no longer reject with "Supervisor version … is too old." Each release's manifest had been stamping `minimumSupervisorVersion` with its *own* tag (the workflow started feeding the git tag into `SUPERVISOR_VERSION`, which `build.ts` reused for the floor). Since the update tarball swaps only the app binary — the supervisor persists from the pod's image — every pod older than the target release was locked out and told to "rebuild the image." The manifest floor is now a separate, stable activation-protocol version (`0.1.0`), so existing pods can apply new releases directly.
- **Fix**: release asset upload no longer fails with `not a git repository` — the v0.1.59 "faster releases" change dropped the `publish-release-assets` job's checkout, but `gh release upload` still resolved the repo from a git remote, so every release since built the image yet uploaded nothing. `gh` now gets `--repo` explicitly. (The first v0.1.61 publish hit this and shipped no tarball; re-cut.)
- **Fix**: release asset publishing no longer dies on `invalid reference format` — the image-extract step pulled the digest under the repo's raw mixed-case name (`PylotLight/ShowFlow`), which Docker rejects; the ref is now lowercased like the tag side already was.
- **Fix**: show/movie folder names no longer split into duplicates. Five separate title→path sanitizers (blackhole client, library scanner, Oracle, shows route, episode-naming engine) each handled illegal characters — especially colons — slightly differently, so a grab could land in a folder that didn't match where the scanner looked. They now share one `sanitizeTitle` (colon → space, matching the naming engine's smart default), which also stops Samba exposing colon-named folders as 8.3 mangled names (e.g. `REJ1JG~5`) to Finder.
- **Bulk folder repair**: the Overlaps dialog gains a "Consolidate all" action that merges every detected overlapping-folder group in one pass (previously one group per click). New `POST /api/shows/duplicates/consolidate-all`; per-group review still available.

## [v0.1.60] - 2026-09-17
- **Full movie support**: add films from TMDB (TV/Movies toggle in Add Show, m- prefixed ids so films never collide with series), library entries with posters/backdrops, per-movie Browse + Auto-grab (title+year index search, remake-safe matching, upgrade-aware), automatic import matching (`Title (Year)/Title (Year).ext`), library scan mapping, and a dedicated detail panel with file status. No migration — films reuse episode_files on a (0,0) sentinel plus nullable grab rows.

## [v0.1.59] - 2026-09-17
- **TMDB auth fixed**: v4 read-access tokens (JWTs starting `eyJ…`) now ride the `Authorization: Bearer` header per TMDB's app auth docs instead of `?api_key=` (which always 401s); v3 keys keep using `api_key`. Either paste works — settings labels say so.
- **Browse missed releases**: Recently Released rows for aired-but-missing episodes now show a Browse pill that opens the per-episode release browser scoped to that exact episode.
- **Softer images**: posters fade + settle in over 500ms (opacity/scale, reduced-motion safe) with the skeleton held underneath until the fade completes — no more pop-in.
- **Faster releases**: app + supervisor compile in one Docker layer (supervisor minified); the release tarball is extracted from the just-built image instead of a second bun install + compile — cuts ~1-2min per release and guarantees tarball == image bytes.

## [v0.1.58] - 2026-09-17
- **Images serve DB-only**: poster routes never touch the network — a miss enqueues a bounded background warm (4 concurrent, 10min failure backoff) and returns 404 immediately; PosterImage retries while warming, then falls back cleanly. No more grid stalls behind live TVDB/TMDB fetches.
- **Movie-aware scanner**: files under *Movies* library roots that don't look like episodes are skipped silently with a summary count — no more per-file "Show not found / Could not parse" spam every scan.
- **Smoother library**: memoized poster cards (search keystrokes and backdrop rotation no longer re-render 300 cards) + deferred search query; skip log fires once per stuck task instead of every minute.

## [v0.1.57] - 2026-09-17
- **Fix**: vacuum result units (MiB, was mislabeled GiB).
- **Faster posters**: grid/list thumbs use a `?size=card` lightweight variant (TMDB w342, AniList medium) cached alongside the full poster; detail hero keeps full size.
- **No more image flash on search/filter**: PosterImage remembers already-loaded URLs for the session, so remounts render instantly instead of flashing skeletons; images also decode off the main thread.

## [v0.1.56] - 2026-09-17
- **Database Cleanup panel (Analytics)**: manual sweeps that run as background jobs — prune episode-file history (keeps live + latest per episode), purge scan-log spam (you pick keep-days 1–30, errors/grabs untouched), and vacuum to reclaim space. Reports rows removed and size before/after.
- **Automatic**: daily pipeline cleanup now also purges scan-type audit rows older than 7 days, so a future write storm self-drains.
- **Health clarity**: the scheduler log names failing components (`overall down — failing: indexer:nyaa(down), metadata_provider:thexem(degraded)`) instead of a bare "down".
- **Fix**: TheXem requests now send the same browser-like User-Agent as every other outbound client — Cloudflare was 403ing Bun's default UA, which read as permanently "degraded".

## [v0.1.55] - 2026-09-17
- **Fix**: scheduler no longer stacks overlapping runs — a due task already in flight is skipped, so one slow library scan can't snowball into 92 concurrent scans that wedge the event loop (the 502s).
- **Fix**: library scan is idempotent — unchanged files skip all writes and audit events (was ~2k new rows in `episode_files` + `audit_logs` per scan, 3.2M rows each).
- **Fix**: TorBox download timeout is first-byte only — slow multi-GB bodies stream under the stall watchdog instead of dying at 3min on every attempt.
- **Maintenance**: daily pipeline cleanup now prunes superseded episode-file rows, keeping the latest per episode.

## [v0.1.54] - 2026-09-16
- **Fix**: backdrop counter (`1/7`) lifted clear of the content overlap the taller banner introduced.

## [v0.1.53] - 2026-09-16
- **Layout polish**: Recent Activity badges fixed-width so messages align; calendar days roomier with Sonarr-style two-line entries and bigger text; hero banner taller with upward-biased art and a longer melt below the episode panel.

## [v0.1.52] - 2026-09-16
- **Agenda fixes**: import/publish times parse naive SQLite stamps as UTC (no more wrong-zone times); provenance card wraps long titles/paths; Recently Released back above the agenda; selecting a past day shows its episodes in full (was "No episodes" despite the count); per-episode release-search button on agenda rows.

## [v0.1.51] - 2026-09-16
- **Downloads ride out sick edges**: TorBox API calls fail fast (60s) instead of hanging forever; first-byte budget 90s→3min for cold CDN edges on multi-GB files.
- **Jobs View navigates in-app**: notification View buttons switch views without a full page reload.

## [v0.1.50] - 2026-09-16
- **Watch folder ignores in-progress downloads**: `.part/.tmp/.aria2` etc. are never imported (a stalled download looks "size-stable", so the mover was stealing partials mid-download and dropping truncated files in the library). TorBox stages partials in a hidden `.downloading/` dir and adopts v0.1.49 orphans, so already-fetched bytes resume.

## [v0.1.49] - 2026-09-16
- **TorBox downloads survive CDN hiccups**: per-file retry (5 attempts, fresh link each time, 10s→2min backoff) on transient 5xx/524s, resume via Range, 90s header timeout + 2min stall watchdog, `.part` files renamed only on success (truncated videos never reach the watch folder). Wait-phase progress no longer fakes 100% — real % only once bytes move.

## [v0.1.48] - 2026-09-16
- **Activate in place**: once a release is downloaded + verified, its row swaps Update for Activate Now — no more scrolling to the status card.

## [v0.1.47] - 2026-09-16
- **Year-suffixed shows actually match**: a TVDB-style `Show (2024)` suffix no longer poisons indexer queries (Knaben exact-match needs every token) or the title filter (the parenthesized token never appears in release names). Queries use the bare title; matches still reject on a conflicting release year (remake protection). Fixes per-episode Search Releases returning nothing while Indexer Search finds releases.
- **Softer dashboard titles + taller hero**: agenda titles drop to 75% white (hover to full); the show hero grows to 340/440px so title treatments survive the crop more often.

## [v0.1.46] - 2026-09-16
### Added
- **Show hero melt (replaces focal presets)**: the backdrop now dissolves into the page background Sonarr-style — fixed center anchor, taller hero, no crop line, no Top/Ctr/Bot buttons to fiddle with. Backdrop ‹ › cycler stays.
- **Faster show open**: the backdrop endpoint serves cached bytes without waiting on provider round-trips (option list now persisted); hovering a poster preloads its hero, which also gets download priority on the detail page.
- **Blur-up hero + DB-first lists**: the detail backdrop renders an instant blurred thumbnail over the melt and sharpens when the full image decodes; tiny thumb bytes are cached locally (no schema change) and the backdrop list serves stored options instantly with a weekly background refresh.
- **Settings General tab reorder**: Available Releases sits directly under Libraries, followed by Update Status, with Defaults last.
- **Dashboard agenda polish (Batch A)**: near-white episode titles with proximity shown on dot + timestamp only; explicit Scheduled / Awaiting release / Available pills; Today + prev/next strip controls with labeled day counts; header total scoped to its date window; Recently Released moved below the agenda; Pipeline/Queue/Manual Import badges carry scope tooltips.

## [v0.1.45] - 2026-09-16
### Added
- **Updates panel: collapsed history + release notes**: the Available Releases list now keeps only the current release and anything newer expanded; older releases collapse into a "Show previous releases (N)" toggle. Each row with notes gets an expandable "Release notes" view (backend passes GitHub `body` through). Release script now publishes the CHANGELOG `[Unreleased]` section as the GitHub release notes (rotating it into a versioned heading afterwards) instead of an auto compare-link.
- **Banner backdrop cycler**: hover the show banner to flip through every backdrop the provider knows about (TVDB fanart types, TMDB voted backdrops) with a position counter; the pick persists per show. Falls back to the single metadata backdrop when no list is exposed.
- **Adhoc Indexer Search page**: new top-level sidebar entry for release-disconnected searching across Prowlarr sub-indexers and enabled natives (Prowlarr fully optional). Query controls for search type, Newznab categories, result limit, and per-indexer picker; per-indexer stats strip (result count, latency, errors); per-result Grab via the existing download-client path; client-side filter/sort ("Newest" falls back to publish date when indexers omit age). Named **search presets** (query + full config) persist server-side under the `indexerSearch.presets` setting with apply / save-overwrite / delete.
- **Whole-show episodes endpoint** `GET /api/shows/:id/episodes`: per-season stats plus every episode with file/provenance detail in one round trip (one episode query + one file-map query), replacing N+1 per-season fetches for large shows. Serialization shared with the per-season route, which is unchanged for other callers.
- Created a structural left `Sidebar.tsx` navigation panel featuring collapsed icons for tablet viewports, mobile bottom navigation bar, live counts badges, and a bottom system health indicator.
- Created `LibraryHealth.tsx` full-width health strip, which consolidates system exceptions and displays a clean status confirmation line when healthy.
- Implemented `comfortable` vs `dense` display density toggle controls.
- Added dynamic item selection mode to the Context Rail: selecting an agenda timeline row details the file paths, quality configurations, and search grab triggers.
- Added a 4-step update progress visualizer in `UpdatesPanel.tsx` and enhanced service-worker `offline.html` handoff screen to track CI builds, downloads, activation, and auto-refresh.
- **Update auto-reconnect**: After activation, the SPA now polls `/internal/ready` itself (instead of relying solely on the SW offline page which only intercepts navigation requests) and automatically reloads the page once the new release is live.
- Added **Manual Import Show Selection Modal**: interactive show picker panel allowing manual association of unresolved/errored watch-folder files to existing library shows.
- Added **Library Bulk Update**: after selecting shows in the library (via filters + select-all/individual select), a "Configure" action in the floating bar mass-applies library type, quality profile, series type, or tracking across the selected shows.
- Added **stored-episode media metadata**: on-disk episode files are probed with mediabunny (a pure-TS demuxer - no ffprobe binary, works in the distroless image) and their real resolution / video & audio codec / HDR / bitrate / duration are stored in `episode_files` and surfaced as badges in the episode info popover and the `/files`, `/episodes`, and `/calendar` APIs. Upgrade decisions now compare the stored file's *probed* media (not its cleaned filename), so a stored 2160p is never "upgraded" by an arriving 1080p, and scans reconcile duplicate on-disk copies per episode (library-wide and per-show), keeping only the best-scoring file.

### Improved
- **TorBox download visibility**: the file-fetch phase now streams to disk with live progress (`Fetching file 1/2 — 35% (2.1 GiB of 6.2 GiB, 8.5 MiB/s)`) published to the background job, Queue page, and notifications popover — previously the job sat at "cached 100%" in silence for multi-GB downloads. Finished background jobs are retained 24h (capped at 200) instead of 5 minutes, and in-flight TorBox downloads persist across restarts: boot re-attaches the waiter so rollout restarts no longer silently drop grabs. Queue progress bars no longer render full when progress is unknown, and the "Processing Now" subtitle covers TorBox downloads as well as watch-folder imports.
- **Show scans scoped to the show folder** (derived from episode paths, sanitized-title fallback) instead of walking the whole library root; full library scans unchanged.
- **Show detail toolbar consolidated into the top bar**: episode availability count, progress bar, and ALL/AVAILABLE/MISSING pills moved to the header (compact), column-settings button docked in the header cluster, whole toolbar row removed so the list gets the full height (slim fallback row on small screens).
- Search page header renamed to **Indexer Search**, matching the sidebar.
- Restored breathing room between the banner and the episode list (top padding) after the toolbar-row removal left them flush.
- **Show detail rework**: season tabs replaced with a single unified episode list (latest season first, Specials last, collapsible per season with per-season availability + progress). Latest season opens by default; the all/available/missing filter applies globally and force-expands matching sections. Per-season Monitor / Browse / Auto actions live in each section header; per-episode interactive search and auto-grab stay on the row hover actions. Top bar condensed to Back/title, Scan, one **Options** menu (shared desktop + mobile, with per-item descriptions across Configure / Organize / Remove sections), expand and close. Hero banner grew into the freed space (21/7, max 360px).
- **Library Show Resolution Prioritization**: `Oracle` matching logic now prioritizes existing library shows and their aliases in candidate scoring before resolving to unfamiliar non-library titles, preventing false positives when downloading episodes.

### Fixed
- **Probe log spam + readiness stalls**: mediabunny's per-track warnings are silenced during probes, and the full-file duration fallback is skipped for files over 8 GiB (it ran on the single Bun thread for minutes, tripping the 1s readiness probe and looking like a crash). No pod crash ever occurred (0 restarts, no crash log) — the "crash" was release-handoff restarts plus this stall.
- **Episode airtimes no longer wiped on import**: `saveEpisode` now preserves previously-known air date/time/title when the caller passes nothing (the import path only has file info), instead of NULLing them on every (re)import. Run a metadata refresh once to repopulate dates already lost. Covered by `save_episode.test.ts`.
- Episodes within a season now sort newest-first (finale on top), matching the seasons' latest-first order.
- **Onboarding flash on reload**: the wizard defaulted to visible before the server check finished, painting for a frame on every reload for configured instances. Now gated behind a checking/open/closed state that renders nothing until the server confirms the instance is genuinely unconfigured, and stamps completion locally so later loads resolve without a network wait.
- **Season Browse/Auto leaked across seasons**: season-scoped matching only checked show-title words, so a Season 3 Browse showed every other season's episodes (and Auto could grab the wrong season). Season scope now requires a season identifier in the title (S03/S3 incl. S03E04, "Season 3", 3x04; S00/Season 0/special for Specials). Absolute-numbered anime keeps title-only matching. Covered by `grabber_match.test.ts`.
- **Settings page restored**: `SettingsPage` was not imported or routed in `App.tsx`, causing a `ReferenceError: Can't find variable: Settings` crash when navigating to the Settings nav item. Now wired correctly — clicking Settings in the sidebar renders the full `SettingsPage` component.
- **Dashboard calendar timezone**: Date-only `air_date` values (midnight UTC) from metadata providers were being formatted with `toLocaleTimeString`, showing a misleading local-time conversion instead of no time. Dates are now grouped by the calendar date verbatim (avoiding UTC-to-local day-shift for users east of UTC), and the time column shows `TBA` for date-only records.

### Changed
- Shifted dashboard pattern from flat widgets to a continuous operational workspace layout: 70% width schedule timeline workspace, 30% width activity/details rail, and bottom library health strip.
- Updated `App.tsx` shell to wire in the new Sidebar router and workspace layout.
- Styled global theme elements in `globals.css` with a custom dark background gradients recipe (`app-background`), a custom low-opacity satin glass recipe (`glass-panel`), and backdrop filter support.
- Refactored `WatcherPanel.tsx` and agenda lists to use clean transparent row borders rather than competing glass card backgrounds.
- **Refactored `src/backend/server.ts`**: 2,611 → 242 lines. Extracted 13 route handler modules into `src/backend/routes/`. Import path and call sites unchanged — `server.ts` wires routes without change.
- **Refactored `src/frontend/components/showflow/SettingsPage.tsx`**: 2,531 → 192 lines. Extracted 15 tab components, tests, and Selenium scripts into dedicated modules. No change to App.tsx import.
- **Refactored `src/backend/db/index.ts`**: 1,656 → 113 lines. Split into 6 domain modules (`schemas.ts`, `init.ts`, `shows.ts`, `config.ts`, `system.ts`, `index.ts`). All `db.methodName()` call sites work without change.
- **Refactored `src/backend/core/download_clients.ts`**: 1,095 lines → `download_clients/` directory with `blackhole.ts`, `torbox.ts`, `types.ts`, `index.ts`. Import path `./download_clients` resolves transparently. No call site changes needed.
