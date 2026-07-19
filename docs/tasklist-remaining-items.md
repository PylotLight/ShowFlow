# Tasklist: Post-Wizard Remaining Items

**Status:** Collected from original pitch + design briefs, validated against `main`
**Branch:** Items grouped by branch below — create branches per group as needed

## ✅ Validation summary (vs. original pitch)

| # | Pitch item | Status | Notes |
|---|---|---|---|
| 1 | Background-vs-wait fork + import progress view | ❌ NOT DONE | StepSonarrConnect just imports silently — no fork UI, no progress visualization |
| 2 | Fluid animations, premium UI | ✅ DONE | Step transitions, glass UI, step indicator |
| 3 | Folder picker upgrade | ⚠️ PARTIAL | Upgraded in wizard (StepRootFolders), NOT backported to `ShowProfileManager.tsx` |
| 4 | "Skip and set up manually" | ✅ DONE | Link on every non-gate step |
| 5 | Notifications inbox (priority + replaces "Saved" toast) | ⚠️ PARTIAL | Backend + popover built, but NOT wired into input save confirmations |
| 6 | Sonarr import UX polish | ❌ NOT DONE | Still janky — no fork, no progress visualization, IntegrationsTab not updated |
| 7 | Library Type model (associate indexers→root→profile, hide profile when 1 exists) | ✅ DONE | Schema + backend + AddShowDialog + IntegrationsTab |
| 8 | "Wanted in 13d" bug | ❌ NOT DONE | Needs source fix in Wanted status derivation |
| 9 | Global background activity popover | ✅ DONE | BackgroundActivityPopover + registry, but only Sonarr registers jobs |
| 10 | Post-import library scan | ✅ DONE | Backend scraps after importSeries() |
| 11 | Agenda scroll-to-now | ❌ NOT DONE | AgendaList.tsz computes nowLineIdx but never scrolls to it |
| 12 | Show page scan/organize visibility | ❌ NOT DONE | No pipeline event logging for scan/organize actions |
| 13 | Pipeline tab rename | ❌ NOT DONE | Product decision + code change |

---

## 📦 Suggested branch groupings

### Branch 1: `pl/import-fork-and-progress`
Dependencies: wizard shell exists, background job registry exists, Sonarr progress tracking exists.

- [ ] **Import fork UI** — Step 5 of wizard: after mapping series, show "Start import and keep configuring" vs "Wait here and watch it" instead of just importing silently
- [ ] **Import progress view** — Nice progress visualization (per-series list, current/total, completed/errored counts) consuming the jobId from POST /api/sonarr/import
- [ ] **Sidebar progress while continuing** — If user picks "keep configuring", show a compact progress indicator in the wizard chrome (or via BackgroundActivityPopover) as they move through Theme/Health steps
- [ ] **IntegrationsTab.tsz progress** — Wire the existing (non-wizard) import path to read jobId from response and show the same progress component

### Branch 2: `pl/wizard-polish-and-backports`
Dependencies: main.

- [ ] **Backport folder picker** — Replace the text-input-root-folder in `ShowProfileManager.tsz` (Settings) with the upgraded directory browser from StepRootFolders
- [ ] **Wire notifications as "Saved" replacement** — Add notification entries when settings are saved (POST /api/settings), replacing the ad-hoc `saveMsg`/`saving` inline state pattern in SettingsPage
- [ ] **Register more background tasks** — Wire library scan, health poll, backup to register against the Background Job registry so they show in the popover

### Branch 3: `pl/bug-ux-fixes`
Dependencies: none.

- [ ] **"Wanted in 13d" fix** — In the pipeline/calendar Wanted status derivation, check air_date before treating an episode as searchable. If air_date > now, it's "Upcoming" not "Wanted".
- [ ] **Agenda scroll-to-now** — In `AgendaList.tsz`, on mount + data change, scroll the `nowLineIdx` element into view (or top of list if no now line)
- [ ] **Show page scan/organize trace** — Log scan/organize actions as pipeline events with new event_types, then show trace in show detail page using the same pattern as the existing TraceDialog

### Branch 4: `pl/v2-pipeline-rename`
Dependencies: none (product decision first).

- [ ] **Decide on Pipeline nav label** — "Activity" / "Downloads" / "Progress" — decide which reads clearly
- [ ] **Decide Queue vs Pipeline merge** — Whether Queue should remain a separate nav item or be merged into Pipeline
- [ ] **Implement rename** — Sidebar label, route path, header title, page components

---

## 🔁 Overlap coordination

### Already claimed (on main):
- `src/frontend/components/showflow/onboarding/` — all 8 wizard steps, shell, types
- `src/frontend/components/showflow/NotificationsPopover.tsx` — notifications inbox UI
- `src/frontend/components/showflow/BackgroundActivityPopover.tsx` — background activity popover
- `src/frontend/styles/globals.css` — wizard animation utilities
- Various route/backend pieces from the earlier library-type + background-jobs work

### Files to watch for conflicts:
- `src/frontend/components/showflow/SettingsPage.tsx` — has `onReRunWizard` prop, would be touched by branch 2 (notifications wiring, folder picker backport)
- `src/frontend/components/showflow/IntegrationsTab.tsx` — touched by branch 1 (import progress)
- `src/frontend/components/showflow/SettingsShared.tsx` — touched by branch 2 if FieldRow gets notification wiring
- `src/frontend/components/showflow/AgendaList.tsx` — touched by branch 3 only
- `src/frontend/components/showflow/ShowDetail.tsx` — touched by branch 3 only
- `src/frontend/App.tsx` — nav items, wiring — touched by branch 4 only
- `src/backend/core/background_jobs.ts` — touched by branch 2 (register more tasks)
- `src/backend/db/schema.ts` — pipeline event taxonomy extension (branch 3)
