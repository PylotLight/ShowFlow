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
  ghcr.io/PylotLight/showflow:latest
```

Open `http://localhost:3000` — the wizard walks through basic setup (media paths, indexer, API keys).

## Configuration

Configured via environment variables or the settings UI:

| Variable | Purpose |
|---|---|
| `SHOWFLOW_DATA_DIR` | Database & state storage (default: `/data`) |
| `SHOWFLOW_DEBUG` | Enable debug logging (`true` / unset) |
| `TMDB_API_KEY` | Metadata & poster images |
| `TVDB_API_KEY` | TV metadata (TheTVDB) |
| `TVDB_PIN` | TVDB API PIN (if required) |
| `http_proxy` / `https_proxy` / `all_proxy` / `no_proxy` | HTTP proxy configuration |

## Architecture

- **Backend**: Bun + SQLite — quality engine, show resolution, indexer integration
- **Frontend**: React (single HTML import) — show management, calendar, settings
- **Supervisor**: Standalone binary — port proxy, graceful handoff, over-the-air updates

See [docs/arch.md](docs/arch.md) for the full architecture and API reference.

## Caveats

- **TV shows only** — movie support is planned for a future release.
- **Single-user** — no multi-user or permission system.
- **Beta quality** — the release/update pipeline is still hardening; manual image pulls are the stable path.
