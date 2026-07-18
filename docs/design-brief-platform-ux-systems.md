# Design Brief: Platform-Wide UX Systems & Backlog

**Status:** Draft for scoping — not yet in development

> 🔶 **§1 (Library Type model) and §2 (Background Activity registry) are claimed and in progress** on branch `feature/library-type-and-background-jobs` — backend/schema foundation has landed there (not yet merged). See `docs/tasklist-library-type-and-background-jobs.md` for exactly what's done vs. outstanding before picking up either section below. §3–§9 are still fully open.
**Purpose:** Capture the cross-cutting systems (they affect onboarding, settings, library, and pipeline surfaces alike) plus a batch of smaller fixes raised in review. These aren't scoped to one feature — building them once, centrally, is the whole point, same philosophy as the shared pipeline data model.

---

## 1. Library Type model (replaces separate quality-profile + series-type pickers)

### The problem as raised
Today, adding a show or mapping a Sonarr import requires picking **two** things independently: a quality profile and a series type (e.g. "anime" vs "standard"). But "anime" isn't a quality — it's really a different indexer set, often a different root folder, and sometimes a different naming/organization convention. The current model conflates "which quality rules apply" with "which indexers to search," because `quality_profiles.indexers` stores indexer association *inside* the quality profile row itself. That's the actual tangle: quality rules and indexer routing are two different concerns wearing one selector.

### Current schema (for reference)
- `shows.profile` and `shows.series_type` are separate columns — two independent choices per show today.
- `quality_profiles.indexers` (JSON) already loosely associates indexers with a profile, which is *part* of why type and quality feel tangled together instead of cleanly separated.
- `show_profiles` (root-folder presets) is a third, separate concept with no link to either of the above.

### Proposed model
Introduce a **Library Type** as the thing a user actually picks once, bundling:
- Default root folder (from `show_profiles`)
- Associated indexer set (moved out of `quality_profiles.indexers`)
- A referenced quality profile (now purely about quality/format rules, nothing else)

Add/import screens then show **one selector** ("TV", "Anime", or custom-named types), not two. Quality profile becomes an implementation detail of the Library Type rather than something surfaced separately — with one exception:

**If more than one quality profile exists**, allow a Library Type to reference any of them (this is the "optionally split later" ask — global-by-default, splittable when needed). **If only one quality profile exists system-wide, don't show a profile picker anywhere in Add Show / Import flows at all** — there's nothing to choose, so don't ask.

### Migration notes
- `quality_profiles.indexers` needs to move to the new Library Type entity; existing profiles' indexer associations become the seed data for auto-generated Library Types during migration (e.g. a profile with anime-flagged indexers becomes an "Anime" type).
- `shows.series_type` and `shows.root_folder_path` likely collapse into a single `shows.library_type_id` FK, with quality profile resolved via the type rather than stored directly on the show — worth deciding whether per-show quality overrides are still needed, or whether that's a "split later" case handled by giving a show its own Library Type.
- This is a real data-model change, not a UI-only fix — scope it as its own migration + backend pass before touching Add Show / Import UI, since both of those screens are the actual payoff of getting the model right.

### Open questions
- Naming: "Library Type," "Content Type," "Category" — whatever avoids colliding with "quality profile" in the UI so users don't think they're the same setting.
- Does a show's Library Type ever need to change after creation (e.g. reclassify a show from "TV" to "Anime")? Probably yes, eventually — worth at least not architecting against it.

---

## 2. Global background activity indicator

### The problem as raised
Long-running operations (Sonarr import, library scans, health polling, anything future) currently run silently. There's no persistent way to see "something is happening in the background" from wherever you are in the app — a scan could be running and you'd have no idea unless you happen to be looking at the specific page that shows it.

### Proposed solution
A persistent icon in the app header/chrome (visible regardless of active nav — needs to live outside the per-page `HeaderActions` portal in `App.tsx`, which currently swaps per view, and outside the `activeNav !== "agenda"` conditional that hides the whole header on the agenda page) that:
- Shows a live count/spinner when anything is running
- Opens a popover listing every active background task with real progress (not just "running"): Sonarr import, library scan, health poll, backup, etc.
- Each entry links to more detail where relevant (e.g. an in-progress Sonarr import links to the same progress view the onboarding wizard uses — same underlying job, not a duplicate)

### Design notes
- This is a **registry**, not a feature built once per task type — define a small "background job" interface (id, label, progress, status, optional link) that any long-running operation registers itself against, so future long-running features get this for free instead of each one reinventing its own progress UI.
- Distinct from Notifications (§3) — this is *live, in-progress* work; notifications are discrete, already-happened (or needs-attention) items. A completed background job can *file* a notification when it finishes, but the two lists shouldn't be merged into one UI.

---

## 3. Notifications / inbox system

### The problem as raised
Two things currently have no home:
1. Priority items that need attention — indexer not configured, no quality profile set, a download failed, disk almost full — currently either don't surface at all outside their own page, or only show up if you happen to visit Settings/Health.
2. Passive input confirmation ("Saved") is currently a transient toast with no persistence — if you miss it, it's just gone, and it's disconnected from anything else in the app.

### Proposed solution
A notification bell/inbox, same header-level placement philosophy as §2, with two kinds of entries:
- **Priority/action items** — surfaced from real signals the app already has: `system_health` rows in `degraded`/`down` state, an unconfigured/missing quality profile, a failed pipeline event, disk-space warnings. This is mostly a *consumption* layer on data that already exists (health snapshot, pipeline events) rather than a new detection system — reuse the same reason-code taxonomy from the pipeline work so a notification and a health-dashboard row describe a problem identically.
- **Passive confirmations** — replaces the ad-hoc "Saved" toast pattern app-wide. A save still gets an ephemeral inline acknowledgment (that part's fine to keep lightweight), but the notification inbox becomes the durable record of "here's what changed and when" if someone wants to check later, rather than the confirmation being genuinely disposable.

### Design notes
- Needs a way to distinguish severity (a failed download vs. "your profile was saved") — both visually and in whether it's dismissible-by-default or needs explicit acknowledgment.
- Read/unread state, most likely — a badge count on the bell for unaddressed priority items specifically, not for passive confirmations (those shouldn't inflate an "attention needed" counter).
- Given the reason-code taxonomy already exists and already has a confidence/category model, this system is largely "build the inbox UI + a feed endpoint that queries pipeline_events/system_health for anything above a severity threshold" rather than a new backend concept.

---

## 4. Sonarr import UX polish (outside the wizard)

The onboarding wizard brief (`design-brief-onboarding-wizard.md` §2) covers the wizard-specific version of this. The same import flow is reachable outside onboarding (re-import, adding more series later) via `IntegrationsTab.tsx` and should get the same treatment rather than staying janky there while the wizard gets the nice version — same progress-tracking backend, same "watch here or run in background" fork, same post-import scan trigger. Worth building the backend piece (progress tracking, background-job registration) as shared infrastructure from the start rather than wizard-only, so this doesn't need a second pass later.

---

## 5. Post-import / post-add library scan

Raised specifically in the Sonarr import context, but the same gap likely applies whenever a root folder or show is newly added: newly known items should get an immediate scan for already-existing files rather than waiting for the next scheduled scan and showing everything as missing in the meantime. Small, mostly a matter of calling the existing scan path (`library_scanner.ts`) at the right trigger points rather than new scanning logic.

---

## 6. Series/organize/scan visibility on the show detail page

Raised as: current organize/scan actions on a show's detail page are weaker than the equivalent Sonarr surfaces — less visibility into what was actually scanned, matched, or skipped, and why. Given the pipeline work already solved exactly this problem for downloads (the §2 trace panel, reason codes, diagnosis layer), the natural move is **reuse that pattern here rather than inventing a new one**: log scan/organize actions as pipeline events (new `event_type`s under a `scan`/`organize` stage, or a parallel log using the same shape) so the show detail page can show a proper trace — files found, matched, renamed, skipped and why — instead of a bare "scan" button with no feedback. Worth scoping as its own small brief once the pipeline event log's stage taxonomy is confirmed to extend cleanly to non-download operations.

---

## 7. Agenda: scroll-to-now behavior

`AgendaList.tsx` groups episodes into Today/Tomorrow/Later, and already computes a "now" divider line within Today's section (`nowLineIdx`) — but the list container (`overflow-y-auto`) never actually scrolls to it or to the top on mount/data change. Fix: on mount (and when the underlying `upcoming` data changes), scroll the "Now" line into view if present, or the top of the list if not — small, self-contained, no backend involvement.

---

## 8. "Pipeline" nav item naming

Raised as: "Pipeline" isn't descriptive as a nav label, and it currently sits alongside a separate "Queue" nav item (`QueuePage.tsx`), which risks the exact "which page do I check" confusion the pipeline design brief was meant to solve. Two related decisions, not just a rename:
- What to call the Kanban view — candidates: "Activity," "Downloads," "Progress" — whatever reads clearly as "state of everything I'm tracking" without requiring the word "pipeline" as domain jargon.
- Whether "Queue" (the older page) should still exist as a separate nav item at all, now that the Kanban view exists — this is the exact IA question the original pipeline brief flagged in §1 (Option 2 as a stepping stone toward eventually replacing/merging the old pages) and hadn't been revisited since. Worth deciding now rather than accumulating both indefinitely.

---

## 9. Known bug: incorrect "Wanted" state on far-future episodes

Raised as: a newly added show showed "Wanted... 13d" — an episode that hasn't aired yet is being labeled as *wanted* (implying the app has searched and failed) rather than *upcoming/not yet aired*, which are different states with different implications (per the same "distinct states need distinct treatment" principle already applied to the pipeline trace work). Needs a source-level fix (not just relabeling) — likely wherever "Wanted" status is derived, it should check air date before treating an episode as searchable/wanted at all. Flagging here for the bug pass rather than scoping further, since it's a fix, not a design decision.

---

## Suggested sequencing relative to the onboarding wizard

The onboarding wizard brief explicitly depends on two of these:
1. **Library Type model (§1)** — wizard step 3 is meaningfully better with this in place, but can ship with today's two-picker fallback if sequencing doesn't allow it first.
2. **Background Activity system (§2)** — the wizard's import-progress fork wants to register against this rather than build a wizard-local version that has to get folded in later.

Everything else here (§3 Notifications, §4–8) is independent and can proceed in whatever order is most useful — §7 (agenda scroll) and §9 (wanted-state bug) are both small enough to knock out between other work, consistent with how the pipeline brief's small trace-panel gaps were framed.
