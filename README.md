# ShowFlow Documentation

ShowFlow is an automated media library manager inspired by Sonarr/Radarr.

## Core Architecture

### Quality & Profile Engine
ShowFlow uses a scoring system to determine the "best" version of a media file.
- **Quality Definitions**: Defined ranks (e.g., 1080p > 720p).
- **Custom Formats**: Regex-based patterns that add/subtract scores (e.g., "Dual Audio" +100).
- **Profiles**: Groups of Custom Formats and a quality cutoff.

### Import Pipeline (Blackhole)
The `BlackholeClient` watches a folder for new files:
1. **Resolution**: Uses the `Oracle` to determine which show/episode the file belongs to.
2. **Upgrade Check**: Compares the new file's score against the existing file in the library.
3. **Action**:
   - If it's an **upgrade**: Existing file is removed, new file is moved to library.
   - If it's **not an upgrade**: File is moved to `manualReviewPath` (if configured) for manual intervention.
   - Otherwise: File is skipped.

### Automated Grabber
The `GrabberService` automates the search and acquisition of missing or upgradable episodes:
1. **Search**: Queries indexers (e.g., Prowlarr) for the specific episode.
2. **Scoring**: Ranks all results using the `QualityEngine`.
3. **Decision**: Checks if the best result is better than what we already have.
4. **Action**: Triggers the indexer's `grab` command to start the download.

---

## API Reference

### Configuration & Settings
- `GET /api/config`: Get current validated system configuration.
- `PATCH /api/config`: Update specific configuration fields.
- `GET /api/settings`: List all raw database settings.
- `POST /api/settings`: Set a raw configuration key/value pair.
- `DELETE /api/settings`: Remove a configuration key.

### System Management
- `POST /api/system/scan`: Trigger a manual library scan.
- `POST /api/system/watch/start`: Start the Blackhole import watcher.
- `POST /api/system/watch/stop`: Stop the Blackhole import watcher.

### Quality Management
- `GET /api/qualities`: List all quality definitions.
- `POST /api/qualities`: Create/Update a quality definition.
- `GET /api/profiles`: List all quality profiles.
- `POST /api/profiles`: Create/Update a quality profile.
- `GET /api/profiles/:id/formats`: List custom formats for a profile.
- `POST /api/profiles/:id/formats`: Add a custom format to a profile.
- `DELETE /api/profiles/:id/formats`: Remove a custom format from a profile.
- `GET /api/custom-formats`: List all custom format definitions.
- `POST /api/custom-formats`: Create/Update a custom format definition.

### Library & Shows
- `GET /api/shows`: List all tracked shows.
- `POST /api/shows`: Add a show to the library.
- `GET /api/shows/:id`: Get details for a specific show.
- `PATCH /api/shows/:id`: Update show profile or title.
- `DELETE /api/shows/:id`: Remove a show.
- `POST /api/shows/:id/sync`: Force a metadata sync for a show.

### Episodes & Automation
- `GET /api/shows/:id/seasons`: List seasons for a show.
- `GET /api/shows/:id/seasons/:season/episodes`: List episodes in a season.
- `PATCH /api/shows/:id/seasons/:season/episodes/:episode/tracked`: Toggle tracking status.
- `POST /api/shows/:id/seasons/:season/episodes/:episode/grab`: Search for and grab the best available release for an episode.

### Utility
- `GET /api/calendar`: Get upcoming episodes for the next X days.
- `GET /api/images/poster/:source/:id`: Proxy for show posters.
