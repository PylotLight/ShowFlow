# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
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
- **Show detail rework**: season tabs replaced with a single unified episode list (latest season first, Specials last, collapsible per season with per-season availability + progress). Latest season opens by default; the all/available/missing filter applies globally and force-expands matching sections. Per-season Monitor / Browse / Auto actions live in each section header; per-episode interactive search and auto-grab stay on the row hover actions. Top bar condensed to Back/title, Scan, one **Options** menu (shared desktop + mobile, with per-item descriptions across Configure / Organize / Remove sections), expand and close. Hero banner grew into the freed space (21/7, max 360px).
- **Library Show Resolution Prioritization**: `Oracle` matching logic now prioritizes existing library shows and their aliases in candidate scoring before resolving to unfamiliar non-library titles, preventing false positives when downloading episodes.

### Fixed
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
