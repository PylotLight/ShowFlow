# ShowFlow

**Automated media library manager.** Track shows, define quality preferences, and let ShowFlow find, download, and upgrade episodes — similar to Sonarr/Radarr but self-contained in a single Docker image.

## Status

Automatic episode grabbing and blackhole importing are functional. Quality engine with custom formats, upgrade logic, and profile management is in place. The release/supervisor pipeline (Docker deployment with over-the-air updates) is pending refinement and testing.

## Quick Start

```sh
docker run -d \
  --name showflow \
  -p 3000:3000 \
  -v /path/to/data:/data \
  -v /path/to/media:/media \
  -e SHOWFLOW_ADMIN_TOKEN=<your-token> \
  ghcr.io/lwragg002/showflow:latest
```

Open `http://localhost:3000` — the wizard walks through basic setup (media paths, indexer, API keys).

## Configuration

Configured via environment variables or the settings UI:

| Variable | Purpose |
|---|---|
| `SHOWFLOW_ADMIN_TOKEN` | API & web UI auth |
| `PROWLARR_API_KEY` | Indexer integration |
| `TMDB_API_KEY` | Metadata & poster images |
| `DATA_DIR` | Database & state storage |
| `LIBRARY_PATH` | Root media folder |

## Architecture

- **Backend**: Bun + SQLite — quality engine, show resolution, indexer integration
- **Frontend**: React (single HTML import) — show management, calendar, settings
- **Supervisor**: Standalone binary — port proxy, graceful handoff, over-the-air updates

See [docs/arch.md](docs/arch.md) for the full architecture and API reference.

## Caveats

- **TV shows only** — movie support is not planned.
- **Single-user** — no multi-user or permission system.
- **Beta quality** — the release/update pipeline is still hardening; manual image pulls are the stable path.
