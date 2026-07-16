# 🗺️ Codebase Mapping

This guide maps the logical architecture to the physical directory structure. Regenerated 2026-07-16 against the actual tree — the previous version described a pre-`src/backend`/`src/frontend` split and no longer matched the code.

## 📂 Directory Structure

```text
src/
├── backend/
│   ├── server.ts          # Bun.serve entry point — route table wiring, embedded assets, SIGTERM/readiness
│   ├── proxy-patch.ts      # Patches globalThis.fetch at module load (must import first — see server.ts)
│   ├── routes/              # Route handlers extracted from server.ts (13 modules)
│   ├── core/                # Business logic & orchestration
│   │   ├── download_manager.ts   # Coordinates configured download clients (blackhole, TorBox)
│   │   ├── download_clients/     # BlackholeClient (blackhole.ts) + TorboxDownloadClient (torbox.ts),
│   │   │                       # plus DownloadClient interface (types.ts), exported via index.ts
│   │   ├── grabber_service.ts    # Search → score → grab pipeline (episode, season, interactive)
│   │   ├── quality_engine.ts     # Quality/custom-format scoring, allow-list, upgrade comparison
│   │   ├── sync_manager.ts       # Metadata + episode sync orchestration per show
│   │   ├── scheduler.ts          # Background task registry & execution intervals
│   │   ├── system_manager.ts     # Watcher lifecycle, manual scan/import, processing state
│   │   ├── library_scanner.ts    # Scans root folders, maps files to episodes
│   │   ├── calendar_manager.ts   # Air-date / upcoming-episode queries
│   │   ├── limiter.ts            # Global rate limiting & concurrency control
│   │   ├── backup.ts             # DB backup/restore, upload
│   │   ├── updates_manager.ts    # Bridges to the supervisor's admin API for release install/activate
│   │   ├── show_titles.ts        # Title/alias normalization & candidate extraction
│   │   ├── debug.ts              # In-memory debug log ring buffer + WS streaming
│   │   └── *.test.ts             # bun test suites (proxy, quality_engine)
│   ├── db/
│   │   ├── index.ts        # DatabaseManager class — thin delegator (113 lines)
│   │   ├── schemas.ts      # Zod config schemas
│   │   ├── init.ts          # DB initialization & migration
│   │   ├── shows.ts         # Show/episode/season queries
│   │   ├── config.ts        # Config & settings queries
│   │   ├── system.ts        # System-level queries (tasks, events, backups)
│   │   ├── schema.ts       # Drizzle table definitions
│   │   ├── migrate.ts      # Standalone migration runner
│   │   └── migrations/     # SQL migration files
│   ├── parser/
│   │   ├── oracle.ts       # Resolution pipeline: parsed filename → provider-confirmed show/season/episode
│   │   ├── index.ts        # Filename regex parser (SxxExx, 1x01, absolute numbering)
│   │   └── __tests__/
│   └── providers/
│       ├── base.ts          # IMetadataProvider interface & shared fetch/cache logic
│       ├── factory.ts       # Instantiates tmdb/tvdb/anilist providers at runtime
│       ├── tmdb.ts, tvdb.ts, anilist.ts
│       ├── indexers/
│       │   ├── factory.ts, prowlarr.ts, types.ts
│       │   └── native/      # Built-in indexers not requiring Prowlarr: nyaa, subsplease, tpb, knaben, rarbg
│       ├── jellyfin/         # client.ts (API client), sync.ts (library sync)
│       ├── sonarr/           # client.ts (API client), import.ts (one-time series import from an existing Sonarr instance)
│       └── torbox/           # client.ts, services.ts — TorBox debrid download client
│
├── frontend/
│   ├── main.tsx, App.tsx, index.html
│   ├── register-sw.ts, sw.js, offline.html   # PWA service worker + offline fallback
│   ├── APITester.tsx        # Manual API-exploration page
│   ├── lib/                 # theme.ts, utils.ts
│   ├── styles/
│   ├── assets/
│   └── components/
│       ├── Library.tsx
│       ├── ui/               # shadcn/ui primitives (button, dialog, tabs, select, etc.)
│       └── showflow/         # App-specific components: Sidebar, Dashboard, CalendarView,
│                              # QueuePage, MissingPage, SourcesPage, QualityProfiles,
│                              # SettingsPage, ShowDetail(Dialog), AddShowDialog, WatcherPanel,
│                              # ManualImport, ReleaseSearchDialog, DebugPage, EventTicker, etc.
│
supervisor/                  # Separate compiled binary — NOT part of src/. Container entrypoint.
├── index.ts    # Daemon + CLI dual-mode entry (install/activate/status)
├── activate.ts # ReleaseManager — stop-start activation state machine
├── bootstrap.ts# Cold-start install of the image-bundled release onto a fresh PVC
└── state.ts    # Shared types, paths, atomic state-file writes, version comparison
```

There is no `src/cli` directory. ShowFlow no longer ships a CLI — `package.json`'s `cli` script and the `commander` dependency were removed 2026-07-16. All functionality is exposed through the REST API and React dashboard.

## ⚙️ Core Logic Flow (The "Pipe")

**Reactive import (Blackhole):**
1. `download_manager.ts` starts `BlackholeClient` (and/or `TorboxDownloadClient`), watching a folder / polling for completed downloads.
2. `parser/index.ts` extracts season/episode/absolute numbers from the filename.
3. `parser/oracle.ts` resolves the parsed candidate against the local `show_titles` index first, falling back to a live provider search via `providers/factory.ts`.
4. `core/quality_engine.ts` scores the file and compares it against any existing file for that episode (`shouldUpgrade`).
5. The file is moved into the library, or diverted for manual review, depending on the upgrade result.

**Proactive grab (search → download):**
1. `core/grabber_service.ts` queries all enabled indexers (Prowlarr and/or native) for a show/season/episode.
2. Results are filtered for relevance and scored with `quality_engine.ts` against the show's assigned profile.
3. The best (or a manually chosen) release is grabbed via `indexer.grab(release)` — routed through TorBox if configured, otherwise written to the blackhole folder for the reactive pipeline above to pick up.

**Release/update flow (supervisor, separate from the app above):**
See `docs/arch.md` for the stop-start activation sequence, readiness gating, and rollback behavior — that logic lives entirely in `supervisor/`, compiled as its own binary, and is independent of `src/backend`.

## 🛠️ Key Libraries & Their Roles

- **Bun.serve** (native) — HTTP server + static asset embedding, no separate framework.
- **`drizzle-orm`** (`bun-sqlite` driver) — typed schema/queries in `db/schema.ts` and the domain modules under `db/`; some legacy tables are still raw SQL via `bun:sqlite` directly.
- **`zod`** — validates `Config` and per-integration settings (Prowlarr, Sonarr, Jellyfin, native indexers).
- **`fuse.js`** — fuzzy show-title matching in the Oracle when exact/alias lookups miss.
- **`radix-ui` / shadcn-style components** — `components/ui/*`.
- **`lucide-react`** — icon set across the dashboard.
