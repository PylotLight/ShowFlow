# Unified Pipeline Rework — Status

Tracks implementation against `design-brief-unified-pipeline.md`'s four features and shared data model (§5). Update this alongside the code as pieces land — don't let it drift into aspirational-doc territory.

## Shared data model (§5) — foundation for all four features

| Primitive | Status | Where |
|---|---|---|
| Reason-code taxonomy | ✅ Done | `core/pipeline/reason_codes.ts` — `ReasonCode`, `ReasonCategory`, `PipelineStage` |
| Pipeline Event Log | ✅ Done, partially wired | `db/schema.ts` (`pipelineEvents`), `db/pipeline.ts`. Written from `grabber_service.ts` (search/filter/reject/grab). **Not yet written from**: the reactive import path (`download_manager.ts` — blackhole/torbox completion → parser → upgrade check → import), so IMPORTING/AVAILABLE stage transitions don't exist yet. Everything currently written stops at GRABBED. |
| System Health Snapshot | ✅ Done, poller wired | `db/schema.ts` (`systemHealth`), `db/health.ts`. `core/pipeline/health_poller.ts` now actually populates it: Prowlarr + native indexers via `Indexer.validate()`, Blackhole (watch-folder writability) + TorBox (`/v1/api/user/me` credential check), and every show profile's root folder (writability). Runs as the `health-check` scheduled task, every 5 minutes. Exposed read-only at `GET /api/system/health` (`{ overallStatus, byType }`) - no dashboard UI consumes it yet, that's still §4. |
| Retention | ✅ Done | `pipeline-cleanup` scheduled task (daily, 14-day retention) + `cleanupOldPipelineEvents`. `system_health` doesn't need retention (current-state table, not a log). |

## §3 Failure Diagnosis Assistant — not started (UI), data layer ready

The brief's recommendation was rules-based lookup first (no ML). The taxonomy in `reason_codes.ts` *is* that lookup table — each `ReasonCode` already carries `category`, `label`, and `confidence`. What's missing:
- A route (`GET /api/pipeline/diagnose?code=...` or similar) that returns the plain-English diagnosis + suggested action for a code. Right now `describeReasonCode()` only returns category/label/confidence — no "suggested action" field exists yet, that needs adding to `ReasonCodeDef`.
- Surfacing it in the three places the brief calls for: queue, history, and the trace panel (§2, not built) — plus the health dashboard (§4, data flowing, UI not built).
- Confidence display (certain/likely/guess) — the data exists, no UI reads it yet.

## §2 "Why isn't this downloading" trace — not started (UI), data layer ready

`listPipelineEvents(showId, season, episode)` already returns the full chronological trace, oldest→newest, exactly as the brief's example format wants. Remaining work is entirely UI + one route:
- `GET /api/shows/:id/seasons/:season/episodes/:episode/trace` (or similar) wrapping `db.listPipelineEvents`.
- Render as the brief's timeline, with the four distinct states it calls out (nothing tried / tried & rejected / grabbed & stuck downloading / grabbed & stuck importing) — note the "stuck downloading/importing" states need the import-path event logging mentioned above to exist.
- Expandable rejected-release detail — already there in `metadata_json` on `release_rejected`/`release_filtered` events (per-release breakdown, not just counts).
- Manual "Search now" action at the top — wire to the existing `POST .../grab` or search endpoint.
- "Copy trace as text" — cheap, do it early.

## §4 Unified Health Dashboard — data flowing, UI not started

The poller now writes real data every 5 minutes (`GET /api/system/health` to inspect). What's left is purely the dashboard UI itself: the three-section layout from the brief (indexers / download clients / import, one top-line status), each row expanding to the diagnosis from §3 (still needs the "suggested action" field added to `ReasonCodeDef`, see above), and linking a failed row out to its config page.

## §1 Pipeline Kanban view — not started

Per the brief's own build order this is deliberately last. Needs:
- A "current stage per item" bulk query — `getLatestPipelineEvent` exists for one item; the Kanban view needs the equivalent across every tracked show/episode at once (group by show_id+season+episode, take latest). Not built yet — will get slow with a naive per-item loop once libraries are large, worth a proper grouped query when this gets built.
- The IA decision from the brief (§1): recommendation was Option 2 (new additive "Pipeline" nav page), not replacing Queue/Wanted/History yet.

## Suggested next concrete step: §4 dashboard UI, or §2 trace UI

The backend plumbing (§5) is now fully built end-to-end - both primitives exist, are written to, and are exposed over HTTP. Nothing UI-facing has been built yet for any of the four features. Two reasonable next steps, roughly equal effort:
- **§4 Health Dashboard**: `GET /api/system/health` already returns everything it needs; this is close to pure aggregation/rendering work now.
- **§2 Trace panel**: `listPipelineEvents` already returns everything it needs too; needs one small route plus the timeline UI.

Either is now unblocked - pick whichever is more useful to see first.

## Open decisions still unresolved (from brief §7)

- [ ] IA approach for Pipeline view — brief recommends Option 2, not yet confirmed as final
- [x] Diagnosis engine rules-based only, no ML in v1 — taxonomy is rules-based by construction, nothing to reconsider
- [ ] Health Dashboard vs Pipeline view as default landing page, or neither — still open, moot until both exist
- [x] Build order — followed brief's §6 order for the backend piece (taxonomy+log before diagnosis/trace/dashboard/kanban); diagnosis/trace/dashboard/kanban themselves not yet built in that order since none are started
