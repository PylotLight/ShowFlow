# Showfish

A small read-only desktop viewer for a ShowFlow database backup (macOS arm64,
Electron). It runs the normal ShowFlow server locally with
`SHOWFLOW_LOCAL_VIEW=1` against a copy of your backup and shows the usual UI in
a window. Nothing downloads, grabs, imports, scans, backs up or self-updates,
and it never talks to the NAS's indexers or download clients.

- Data lives in `~/Library/Application Support/Showfish/data/` (`showflow.db`,
  `images/`, `server.log`). The server's cwd and `SHOWFLOW_DATA_DIR` point there.
- First launch asks for a `.db` backup. **File › Open Backup… (⌘O)** swaps in
  another one (the server restarts). If the `.db` sits in a ShowFlow `backups/`
  folder, the `backups/images` store next to it is copied too; otherwise
  artwork re-warms from the metadata providers as you browse.
- Migrations run on startup, so older backups open fine.
- The UI shows a "Local view · read-only" badge, mutating API calls answer 403.

## Run in dev (fish)

Needs bun on your PATH (or `~/.bun/bin/bun`, or set `BUN_PATH`). Dev mode runs
`bun src/backend/server.ts` from this repo.

```fish
cd ShowFlow
bun install
cd desktop
bun install
bun run dev
```

## Build

```fish
cd ShowFlow/desktop
bun run dist:dir   # release/mac-arm64/Showfish.app
bun run dist       # .app + release/Showfish-0.1.0-mac-arm64.dmg
```

`build:server` compiles the server with `bun build --compile
--target=bun-darwin-arm64` into `resources/server/showflow-server` (frontend
embedded) with the Drizzle `migrations/` beside it, and electron-builder ships
that folder as `Contents/Resources/server`. No signing identity is set, so the
app is ad-hoc signed: a locally built copy opens normally; a copied/downloaded
one may need `xattr -dr com.apple.quarantine Showfish.app`.

## Server only (no Electron)

```fish
mkdir -p /tmp/sf; cp ~/Downloads/showflow-backup.db /tmp/sf/showflow.db; cd /tmp/sf
env SHOWFLOW_LOCAL_VIEW=1 SHOWFLOW_DATA_DIR=/tmp/sf PORT=47820 bun ~/code/ShowFlow/src/backend/server.ts
open http://127.0.0.1:47820
```

## What local view turns off

See `src/backend/core/local_view.ts`. With `SHOWFLOW_LOCAL_VIEW=1` the server:

- skips the scheduler (sync, library scan, backups, RSS sync, auto-grab,
  health polls, update checks…), Connect notifications, the download watcher
  (blackhole/TorBox), the release watcher / update activation and the artwork
  blob migration
- binds to 127.0.0.1 only
- answers 403 to every non-GET `/api` route (except naming/quality previews and
  dismissing notifications) and to GET routes that reach out: indexer search,
  per-show/season/episode searches and grabs, Prowlarr/native indexer status,
  Sonarr, Jellyfin, manual import, watch folder, update checks, backup files

Reset everything: quit, then `rm -rf ~/Library/Application\ Support/Showfish`.
