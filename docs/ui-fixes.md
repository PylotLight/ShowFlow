# UI Fixes — Task List

**Source:** Design review of dashboard (dark theme / teal accent / agenda layout), 2026-09-10
**Goal:** Make the app feel like an automation control center — what's coming, what's downloading, what needs attention — not just a release calendar.

---

## Priority fixes (if only three ship)

- [ ] Improve contrast (secondary text → 4.5:1 minimum)
- [ ] Add explicit per-episode acquisition statuses
- [ ] Surface actionable failures alongside active downloads on the dashboard

---

## 1. Make the dashboard operational

- [ ] Add compact summary strip above the agenda:
  - [ ] **Downloading** — active count, total speed, next completion
  - [ ] **Needs attention** — failed imports, stalled downloads, missing episodes
  - [ ] **Indexers** — healthy count, failures, rate limits
  - [ ] **Storage** — remaining capacity + warnings
- [ ] Make each summary card clickable → detail view
- [ ] Add secondary column on wide screens (needs attention / active downloads with progress bars / recently imported)
- [ ] Avoid decorative statistics — only show data that drives action

## 2. Fix contrast & color hierarchy

- [x] Increase secondary-text contrast → **4.5:1 for normal text** (currently looks disabled): "Recently released", episode metadata, date headings, timestamps
- [x] Use near-white for show titles
- [x] Reserve teal for primary actions, selection, small accents only
- [x] Replace whole-title coloring with labeled status badges
- [x] Stop fading entire rows just because an episode aired previously
- [ ] Resolve semantic collision: teal currently means both "interactive" and an episode state; amber/gray are unexplained

## 3. Separate release timing from acquisition status

- [ ] Give every episode an explicit acquisition state:
  - `Scheduled`
  - `Awaiting release`
  - `Downloading · 62%`
  - `Imported · 1080p`
  - `Import blocked`
  - `Unmonitored`
- [ ] Keep air time in a separate field/column
- [ ] Released-but-not-downloaded episodes remain readable (and rank above upcoming in attention)
- [ ] Show exception reason + next action inline, e.g. **Import blocked** · Destination permission denied · **Review**

## 4. Restructure episode rows

- [ ] Two-line identity block: series name on line 1, `S02E03 · episode title` beneath
- [ ] Consistent poster size (slightly larger/more useful)
- [ ] Dedicated columns for status and time (currently title ↔ timestamp too far apart)
- [ ] Graceful truncation of long titles; full text on hover/focus or in details
- [ ] Contextual row menu: Search, Monitor, View details
- [ ] Density modes: compact + comfortable

## 5. Clarify navigation

- [ ] Rename/clarify nav items ("Queue", "Pipeline", "Sources" require interpretation):
  - **Activity** — downloads, imports, history
  - **Library**
  - **Calendar**
  - **Wanted** — if Pipeline = missing episodes/upgrades
  - **Indexers** — if Sources = indexer config
  - **System** — health, tasks, logs
  - **Settings**
- [x] Fix amber `254` beside Pipeline — reads as 254 problems; label the number's scope
- [ ] If Pipeline is a real processing workflow, keep it but make Queue vs Pipeline distinction explicit
- [ ] Reduce logo/header footprint; tighten sidebar spacing
- [ ] Make Manual Import contextual unless it's a frequent primary workflow

## 6. Simplify agenda controls

- [x] Show month + date range context on the date strip
- [x] Add controls: **Today**, prev/next~~, **7 days / 14 days** range toggle~~
- [ ] Distinguish "today" vs "selected day" with more than color
- [x] Label small day-strip counts as episode counts
- [x] Scope the header total: **"73 episodes across 42 series · next 30 days"**
- [x] Move **Today** first; relocate "Recently released" below upcoming or into its own panel
- [x] Remove nested borders and the decorative `// SYSTEM AGENDA` label
