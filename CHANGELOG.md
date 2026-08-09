# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Created a structural left `Sidebar.tsx` navigation panel featuring collapsed icons for tablet viewports, mobile bottom navigation bar, live counts badges, and a bottom system health indicator.
- Created `LibraryHealth.tsx` full-width health strip, which consolidates system exceptions and displays a clean status confirmation line when healthy.
- Implemented `comfortable` vs `dense` display density toggle controls.
- Added dynamic item selection mode to the Context Rail: selecting an agenda timeline row details the file paths, quality configurations, and search grab triggers.
- Added a 4-step update progress visualizer in `UpdatesPanel.tsx` and enhanced service-worker `offline.html` handoff screen to track CI builds, downloads, activation, and auto-refresh.
- **Update auto-reconnect**: After activation, the SPA now polls `/internal/ready` itself (instead of relying solely on the SW offline page which only intercepts navigation requests) and automatically reloads the page once the new release is live.
- Added **Manual Import Show Selection Modal**: interactive show picker panel allowing manual association of unresolved/errored watch-folder files to existing library shows.

### Improved
- **Library Show Resolution Prioritization**: `Oracle` matching logic now prioritizes existing library shows and their aliases in candidate scoring before resolving to unfamiliar non-library titles, preventing false positives when downloading episodes.

### Fixed
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
