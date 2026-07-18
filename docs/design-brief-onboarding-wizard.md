# Design Brief: Setup Onboarding Wizard

**Status:** ✅ BUILT — all 8 steps implemented and merged to `main`

> See `docs/tasklist-remaining-items.md` for remaining post-wizard polish items (import fork UI, progress visualization, folder picker backport). The wizard itself is complete — steps 1-8 live at `src/frontend/components/showflow/onboarding/` on `main`.
**Purpose:** Replace "open Settings, hope you find the right tab, hope you do it in the right order" first-run experience with a guided, linear wizard that gets a new install from empty to "actually watching something get grabbed" in one sitting.

**Depends on:** the Library Type / indexer-association rework and the platform-wide Notifications + Background Activity systems described in `design-brief-platform-ux-systems.md`. This wizard is designed *against* those systems rather than duplicating its own progress/toast pattern — see §3 and §4 below.

---

## 0. Key finding before scoping this: most of the hard parts already exist

This isn't a from-scratch build. Every step below has a real backend route and, in most cases, a real settings-page component already in the repo. The wizard's job is **orchestration and sequencing**, not reimplementing these:

| Wizard step | Already exists as | Notes |
|---|---|---|
| Root directories | `FolderPicker.tsx`, `/api/show-profiles` (POST) | `ShowProfileManager.tsx` is the existing settings-page version. **Needs a UI upgrade** — see §3, this is one of the few pieces we're not just reusing as-is. |
| Library Type (root dir + indexers + profile, replaces separate profile/type pickers) | Doesn't exist yet — new model, see `design-brief-platform-ux-systems.md` §1 | Wizard step 3 below assumes this lands first; if it doesn't, step 3 falls back to today's separate quality-profile + series-type pickers. |
| Provider key (indexer/download client) | `IndexersTab.tsx`, `/api/config`, `/api/settings` (POST, keyed by `prowlarr`/etc. with Zod validation) | Also covers Blackhole/TorBox per the health-poller work |
| Connect to Sonarr + import | `IntegrationsTab.tsx`, `/api/sonarr/settings`, `/api/sonarr/test`, `/api/sonarr/series`, `/api/sonarr/import` | Import currently branches to a fire-and-forget background promise for >5 series with no queryable progress — this is the one real backend gap, see §2. |
| Theme | `AppearanceTab.tsx`, `ColorDock.tsx` | Purely cosmetic, no backend dependency, easiest step to reuse as-is |
| System health check | `/api/system/health`, `HealthDashboard.tsx` | Natural "everything's actually working" confirmation step before finishing |

**Implication for scope:** the wizard is a new *shell component* that sequences existing (or newly-reworked) components with wizard chrome, plus new orchestration for: a first-run flag/route, the import progress view, and a genuinely nicer folder-picker.

---

## 1. Proposed flow

```
Welcome → Root Folders → Library Type & Quality → Indexer/Download Client
    → Sonarr Connect, Series Fetch & Import → Theme → Health Check → Done
```

### Step-by-step

**1. Welcome**
One screen, no config. Sets expectations ("this'll take about 5 minutes"). Every step from here on carries a plain **"Skip and set up manually"** text link — see §3.

**2. Root directories**
Upgraded folder picker (§3) + `/api/show-profiles`. At least one root folder required to proceed — the only genuinely hard gate in the wizard. Validate writability inline using the same check the health poller already runs, so "is this writable" is answered identically here and in ongoing health monitoring.

**3. Library Type & Quality**
If the Library Type rework has landed: a single selector — "TV" / "Anime" / custom — that bundles root folder default, associated indexers, and a quality profile, so this step (and Add Show, and Sonarr import mapping in step 5) only ever asks for *one* choice instead of profile + series-type separately. If only one quality profile exists system-wide, this step doesn't show a profile choice at all — just confirm the type/root mapping and move on.

If it hasn't landed yet, this step falls back to today's model: confirm default quality profile, confirm series-type/root mapping as two separate pickers. Either way, pre-select sane defaults so most users can hit Next immediately.

**4. Provider key(s)**
Reuse `IndexersTab.tsx`-style forms for Prowlarr/indexer and download client (Blackhole/TorBox). Inline "Test connection" per field, validation errors surfaced right in the step — don't let people advance on an untested key only to hit a wall two steps later.

**5. Connect to Sonarr, fetch series, define import mapping**
Real UX work happens here — see §2.

**6. Theme**
Reuse `AppearanceTab.tsx`/`ColorDock.tsx` as-is.

**7. Health check**
Call `/api/system/health`, same three-section summary as `HealthDashboard.tsx`, scoped to what was just configured. Advisory only — a degraded indexer shouldn't block completing the wizard.

**8. Done**
Land on the daily-use landing page (Pipeline/Kanban or whatever the pipeline status doc's landing-page decision resolves to), not back on Settings.

---

## 2. Sonarr connect, fetch, and import — the step that needs real design

### Sequence

1. Connect + test (existing `/api/sonarr/test`).
2. **Fetch all series up front** via `/api/sonarr/series` — pull the full list and let the user define the type/root-folder mapping (per the Library Type model in step 3, or today's series-type mapping if that hasn't shipped) against the *complete* list, not a partial/paginated one. Mapping needs to happen before any import starts, since it's what `SonarrImporter.importSeries(seriesIds, typeMapping)` already takes as a parameter — nothing new needed on the fetch/mapping side, it's a UI screen over data the API already returns.
3. Once mapping is confirmed, **the user makes an explicit choice**, not a fixed default:
   - **"Start import now and keep setting up"** — import kicks off immediately, tracked via the global Background Activity system (see `design-brief-platform-ux-systems.md` §2), wizard moves on to Theme/Health while a persistent progress indicator rides along in the header.
   - **"Wait here and watch it import"** — wizard stays on this step, shows the full import progress view in place, and only advances to Theme once import completes.

   Present this as a real fork in the wizard UI ("this may take a while for large libraries — want to keep configuring while it runs, or wait here?"), not a silent default either direction — different libraries and different users have genuinely different preferences here (someone importing 400 series wants to keep moving; someone importing 12 might rather just watch it finish).

### What needs building (the actual gap)

`/api/sonarr/import` currently branches on size: ≤5 series resolves synchronously, >5 fires a background promise that only `console.log`s on completion — nothing queryable, nothing a UI can poll. This needs to become a real tracked background task:

- A **progress-tracking record** for the import job (in-memory is fine for a single-process app, doesn't need to survive a restart) exposing `{ total, imported, existing, errored, done }`, updated as `SonarrImporter.importSeries` processes each item rather than only at the end.
- `GET /api/sonarr/import/status` (or similar) for polling.
- This job should register itself with the platform Background Activity system (`design-brief-platform-ux-systems.md` §2) the moment it starts, so it's visible from the header regardless of which path (A or B above) the user picked — the wizard's own progress view and the global popover should read from the *same* underlying job, not maintain separate state.
- Per-item import errors render through the same reason-code/diagnosis language as the rest of the pipeline work, not a new ad-hoc error string format.
- **After import completes, trigger a library scan for existing files.** Newly imported shows should immediately reflect files already present in their root folders rather than showing everything as missing until the next scheduled scan — this is a real gap independent of the wizard (see `design-brief-platform-ux-systems.md` §5 for the non-onboarding version of this same fix).

---

## 3. Design notes

- **Fluid, premium feel.** This wizard is a first-impression surface — transitions between steps should be animated (slide/fade, not a hard cut), inputs should feel immediate and responsive, and it should read as considered rather than a bare form sequence. Treat this as seriously as the rest of the app's visual language, not a bolt-on install flow.
- **Folder picker needs a real upgrade.** The current text-input-based folder entry is the weakest input surface in the flow and it's the very first thing a new user touches. Needs an actual fast, browsable directory picker (tree or breadcrumb navigation, create-new-folder inline, recent/suggested paths) — not free-text with a "browse" afterthought. Worth fixing here and backporting to `ShowProfileManager.tsx` in Settings, since it's the same weak component in both places.
- **"Skip and set up manually" everywhere.** Literal text link, present on every step except the root-folder gate — don't trap anyone in the wizard who already knows what they're doing or is restoring from backup.
- **No separate "Saved" toast pattern.** Input confirmation in the wizard (and everywhere else) should route through the platform Notifications system rather than the wizard inventing its own transient "Saved" text — see `design-brief-platform-ux-systems.md` §3.
- **Resumable, not one-shot.** Closing/refreshing mid-flow should reopen where it left off (persist `onboarding.step` via `/api/settings`). Re-runnable from Settings ("Re-run setup wizard") at any time afterward, not a gate that's gone after first launch.
- **Validation quality is the actual product.** The wizard's value over raw Settings tabs isn't new functionality, it's catching mistakes — a bad key, an unwritable folder, an unreachable Sonarr instance — at the point of entry. Prioritize this over visual polish, though both matter here.

---

## 4. Open questions

- First-run detection: auto-detect off "zero show profiles exist" (recommended) vs. an explicit fresh-install flag.
- Mandatory-through-root-folder-only (recommended) vs. gating the whole wizard before the rest of the app is usable.
- Theme step ordering — low stakes.
- Default selection for the step-5 fork (background vs. wait) — recommend *asking* rather than defaulting, per §2, but worth confirming that's not overkill for the common case (small library, import finishes in seconds either way — maybe the fork only needs to appear when the fetched series count crosses some threshold, e.g. >15, and just runs synchronously-and-visibly below that without asking).

---

## 5. Suggested build order

1. Wizard shell (progress chrome, step navigation, skip/resume persistence)
2. Wire in existing/reworked steps: Root Folders (with upgraded picker) → Library Type & Quality → Provider Key → Theme
3. Sonarr fetch-all + mapping UI (pure UI over an existing endpoint, no backend gap)
4. Import progress tracking (backend) + the background-vs-wait fork (frontend) — depends on the platform Background Activity system existing first, or this ships a wizard-local version that gets folded in later
5. Post-import library scan trigger
6. Health-check step
7. First-run auto-detection + "re-run wizard" entry point in Settings

Steps 1–3 and 6–7 are independent of the platform-wide systems brief and can start immediately. Step 4 is the one piece worth sequencing *after* (or explicitly alongside) the Background Activity system so it isn't built twice.
