# Unified Pipeline Rework — Status

Tracks implementation against `design-brief-unified-pipeline.md`'s four features and shared data model (§5). Update this alongside the code as pieces land — don't let it drift into aspirational-doc territory.

**Last verified against actual code:** all four features have shipped UI wired into `App.tsx` nav (`pipeline`, `health` routes, plus trace/diagnose dialogs opened from Kanban cards). The section below was previously out of date — it described a UI-not-started state that no longer matched the repo.

## Shared data model (§5) — foundation for all four features

| Primitive | Status | Where |
|---|---|---|
| Reason-code taxonomy | ✅ Done | `core/pipeline/reason_codes.ts` — `ReasonCode`, `ReasonCategory`, `PipelineStage`, plus `suggestedAction` per code (already present, not a TODO). |
| Pipeline Event Log | ✅ Done, fully wired | `db/schema.ts` (`pipelineEvents`), `db/pipeline.ts`. Written from `grabber_service.ts` (search/filter/reject/grab) AND from `BlackholeClient.handleFile()` (watch-folder detection → oracle resolve → upgrade check → import), so IMPORTING/AVAILABLE stage transitions exist end-to-end. TorBox-downloaded files go through the blackhole watch folder and are covered by the same path. |
| System Health Snapshot | ✅ Done, poller wired | `db/schema.ts` (`systemHealth`), `db/health.ts`. `core/pipeline/health_poller.ts` populates it: Prowlarr + native indexers via `Indexer.validate()`, Blackhole (watch-folder writability) + TorBox (credential check), and every show profile's root folder (writability). Runs as the `health-check` scheduled task, every 5 minutes, registered in `scheduler.ts`. Exposed read-only at `GET /api/system/health` (`db/routes/analytics.ts`) → `{ overallStatus, byType }`, consumed by `HealthDashboard.tsx`. |
| Retention | ✅ Done | `pipeline-cleanup` scheduled task (daily, 14-day retention) + `cleanupOldPipelineEvents`. `system_health` doesn't need retention (current-state table, not a log). |

## §3 Failure Diagnosis Assistant — ✅ shipped

- `GET /api/shows/:id/seasons/:season/episodes/:episode/diagnose` (`routes/shows.ts`) returns `{ hasIssue, event, diagnosis, suggestedAction }` off the latest pipeline event + `describeReasonCode()`.
- `DiagnoseDialog.tsx` renders it: issue summary, category, confidence badge, suggested action callout. Opened from Kanban cards (`PipelineKanban.tsx`).
- Rules-based only, per the brief's recommendation — nothing ML-assisted, consistent with the confidence field always reading `certain`/`likely` today.
- **Not yet done:** surfacing diagnosis inline in Queue/History (brief asked for it in "the three places" — queue, history, and the trace panel; only the trace/diagnose dialogs exist today, not an inline queue/history badge).

## §2 "Why isn't this downloading" trace — ✅ shipped, missing 3 small brief asks

- `GET /api/shows/:id/seasons/:season/episodes/:episode/trace` (`routes/shows.ts`) wraps `db.listPipelineEvents`, oldest→newest.
- `TraceDialog.tsx` renders it grouped by stage with per-event detail (reason label, release title, indexer), opened from Kanban cards.
- **Gaps vs. the brief, still open:**
  - No "Copy trace as text" button — brief flags this explicitly as cheap/high-value for community troubleshooting.
  - No expandable per-release rejection detail — `metadata_json` on `release_rejected`/`release_filtered` events already carries the per-release breakdown (per the comment in `db/pipeline.ts`), but `TraceDialog.tsx` only renders the summary `message` line, not a drill-down list.
  - No manual "Search now" action at the top of the panel — brief calls this "often the very next thing" someone wants after opening the trace.

## §4 Unified Health Dashboard — ✅ shipped

- `HealthDashboard.tsx` consumes `GET /api/system/health`, mounted at the `health` nav item in `App.tsx`, with an "open settings" link-out for failed components.
- **Needs verifying, not confirmed either way:** the brief's explicit ask that each row expand into the §3 diagnosis layer rather than a separate explanation — worth a quick check that `HealthDashboard.tsx` calls the same diagnosis path as `DiagnoseDialog.tsx` rather than re-deriving its own text from `reason_code`.

## §1 Pipeline Kanban view — ✅ shipped

- `db.listKanbanEpisodes()` (`db/pipeline.ts`) does the bulk "latest stage per item" query as a single window-function scan (not a per-item loop) — resolves the brief's stated perf concern up front.
- `GET /api/pipeline/kanban` (`routes/pipeline.ts`) groups into lanes by `STAGE_ORDER`, with an `attentionCount` across WANTED/SEARCHING/FAILED.
- `PipelineKanban.tsx` renders it, mounted at the `pipeline` nav item, cards opening `TraceDialog`/`DiagnoseDialog`.
- IA decision followed the brief's recommendation: Option 2, additive new nav page, old Queue page (`QueuePage.tsx`) still present alongside it.
- **Unconfirmed — check `PipelineKanban.tsx` directly if these matter to you:** bulk actions from cards (force search / skip / delete) and a rolling 48h window for the AVAILABLE lane were both open questions in the brief (§1) and I didn't verify either is implemented.

## Open decisions from brief §7 — current status

- [x] IA approach for Pipeline view — Option 2 (additive nav page) shipped, matches recommendation
- [x] Diagnosis engine rules-based only, no ML in v1 — shipped as rules-based, no change needed
- [ ] Health Dashboard vs Pipeline view as default landing page, or neither — still genuinely open; both exist now so this is decidable
- [x] Build order — backend (§5) and all four UI surfaces are built; original §6 order (taxonomy/log → diagnosis → trace → dashboard → kanban) was followed loosely, dashboard/kanban UI landed alongside rather than strictly after

---

## Where to go from here

The four features from the original brief are all live end-to-end. That closes out the brief as scoped — everything below is new work building on top of it, not finishing what's here. Roughly in order of how directly it builds on what already exists:

### 1. Close the three §2 trace gaps (small, self-contained)
These were explicit asks in the original brief that didn't make it into `TraceDialog.tsx`:
- **Copy trace as text** — serialize the already-fetched `TraceEvent[]` into the brief's plain-text format, clipboard button in the dialog header. No new backend work.
- **Expandable rejected-release detail** — the per-release breakdown is already sitting in `metadata_json`; this is a frontend-only accordion/drill-down on `release_rejected`/`release_filtered` rows.
- **"Search now" action** — wire a button in `TraceDialog.tsx` to the existing grab/search endpoint for that episode.

Cheap wins because the data layer for all three already exists — this is UI-only work.

### 2. Surface diagnosis inline where the brief originally asked for it
Right now diagnosis only shows up in the dedicated `DiagnoseDialog`. The brief's §3 scope was queue, history, *and* the trace panel — worth deciding whether that's still the right scope or whether the dialog covers the need well enough on its own. If you do want it inline, it's a small reusable `<DiagnosisBadge reasonCode=... />` component rather than new backend work, since `reason_codes.ts` already has everything a badge needs.

### 3. Decide the landing-page question (§7, still open)
Now that Pipeline and Health both exist as real pages, worth actually deciding: Pipeline as home (probably right, per the brief's own reasoning — people check "what's downloading" more than "is the system healthy") with Health reachable via a persistent status dot in the sidebar, rather than a full nav item. This is a product decision more than a build task, but it's cheap to implement once decided.

### 4. Kanban's two open questions from §1
Worth resolving now that the Kanban view is real and presumably getting used:
- Bulk actions from cards (force search / skip / delete) for parity with the old Queue page.
- A rolling window (brief suggested 48h) for the AVAILABLE lane so it doesn't accumulate forever.

### 5. Extend the shared data model instead of the four original surfaces
This is genuinely new scope, not brief cleanup — flagging as ideas rather than commitments:
- **Historical health trends** — the brief explicitly deferred this ("current-state-only in v1... trends are a natural v2"). The polling data is already being collected every 5 minutes; a lightweight trend view becomes mostly a query + chart now that the raw data exists.
- **Notification hook** — also explicitly deferred in the brief as "a separate ticket." Push/email/Discord when `overallStatus` flips to degraded is a small addition on top of the existing health-check task.
- **Community-maintained reason-code list** — the brief raised this as an open question for §3. If failure patterns come up that the taxonomy doesn't cover, this is the point where it's worth deciding whether new codes ship via normal releases (fine at current scale) or need a faster-moving mechanism.
- **Heuristic/ML-assisted diagnoses** — brief's explicit v2, never same confidence tier as rules-based. Only worth it once real gaps show up in what the rules-based table catches.

### Suggested order given you're mid bug-fixing
Since you're heads-down on bugs right now: (1) and (4) are the cheapest, most self-contained, and least likely to interact with whatever you're currently debugging — good "between bugs" work. (2) and (3) are product decisions worth making deliberately rather than squeezing in. (5) is genuinely next-phase work, worth revisiting once the current bug list is down to a manageable size.
