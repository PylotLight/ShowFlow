# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Created a structural left `Sidebar.tsx` navigation panel featuring collapsed icons for tablet viewports, mobile bottom navigation bar, live counts badges, and a bottom system health indicator.
- Created `LibraryHealth.tsx` full-width health strip, which consolidates system exceptions and displays a clean status confirmation line when healthy.
- Implemented `comfortable` vs `dense` display density toggle controls.
- Added dynamic item selection mode to the Context Rail: selecting an agenda timeline row details the file paths, quality configurations, and search grab triggers.

### Fixed
- **Settings page restored**: `SettingsPage` was not imported or routed in `App.tsx`, causing a `ReferenceError: Can't find variable: Settings` crash when navigating to the Settings nav item. Now wired correctly — clicking Settings in the sidebar renders the full `SettingsPage` component.
- **Dashboard calendar timezone**: Date-only `air_date` values (midnight UTC) from metadata providers were being formatted with `toLocaleTimeString`, showing a misleading local-time conversion instead of no time. Dates are now grouped by the calendar date verbatim (avoiding UTC-to-local day-shift for users east of UTC), and the time column shows `TBA` for date-only records.

### Changed
- Shifted dashboard pattern from flat widgets to a continuous operational workspace layout: 70% width schedule timeline workspace, 30% width activity/details rail, and bottom library health strip.
- Updated `App.tsx` shell to wire in the new Sidebar router and workspace layout.
- Styled global theme elements in `globals.css` with a custom dark background gradients recipe (`app-background`), a custom low-opacity satin glass recipe (`glass-panel`), and backdrop filter support.
- Refactored `WatcherPanel.tsx` and agenda lists to use clean transparent row borders rather than competing glass card backgrounds.
