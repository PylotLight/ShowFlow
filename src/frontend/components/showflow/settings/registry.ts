/**
 * Settings search registry: one entry per searchable setting, across every
 * Settings tab. The UI (Settings search box, ⌘K palette) reads only this.
 *
 * Each entry's `id` is also the `data-setting` attribute on the row it points
 * at (FieldRow `settingId`, or a `data-setting` on a panel/heading). When the
 * row isn't on its own (or is only rendered conditionally, e.g. TorBox fields
 * when TorBox is the client), `anchor` names the element to scroll to instead
 * and `fallback` the one to use when the anchor isn't rendered right now.
 *
 * Adding a setting: add a row here + `settingId="<id>"` on its FieldRow.
 * registry.test.ts fails if an id/anchor isn't present in the components.
 */

import { SETTINGS_TABS } from "./tabs";

export interface SettingMeta {
  /** Stable id, `<tab>.<slug>`. Also the default scroll target. */
  id: string;
  label: string;
  description: string;
  /** Synonyms and related words people might type. */
  keywords?: string[];
  /** Settings tab id (settings/tabs.ts). */
  tab: string;
  /** Group heading inside the tab, shown as breadcrumb. */
  section?: string;
  /** `data-setting` to scroll to when it isn't `id` itself. */
  anchor?: string;
  /** `data-setting` to use when the anchor isn't rendered (conditional rows). */
  fallback?: string;
  /** Rendered from data with a generated attribute (e.g. one row per task). */
  dynamic?: boolean;
}

type Entry = Omit<SettingMeta, "tab" | "section">;
const S = (tab: string, section: string | undefined, entries: Entry[]): SettingMeta[] =>
  entries.map(e => ({ tab, ...(section ? { section } : {}), ...e }));

const COLOR_FIELDS = [
  ["background", "Background", "Base background color of the interface."],
  ["foreground", "Foreground", "Primary text color."],
  ["surface", "Surface", "Card and panel background."],
  ["card", "Card", "Elevated surface background."],
  ["card-foreground", "Card foreground", "Text on card surfaces."],
  ["popover", "Popover", "Dropdown and popover background."],
  ["muted-foreground", "Muted foreground", "Secondary / muted text color."],
  ["border", "Border", "Default border color."],
  ["input", "Input", "Form input border color."],
] as const;

// Mirrors backend/core/scheduler.ts task definitions (name, displayName).
const TASKS = [
  ["sync-shows", "Sync Shows", "Sync show metadata and episode information from providers.", ["refresh metadata", "episodes"]],
  ["scan-library", "Scan Library", "Scan media folders for new and updated files.", ["rescan", "disk"]],
  ["backup", "Database Backup", "Create a backup of the ShowFlow database on a schedule.", ["backup schedule"]],
  ["rss-sync", "RSS Sync", "Pull each indexer's latest-releases feed and grab new releases.", ["rss", "feed"]],
  ["auto-grab", "Auto-Grab Wanted Episodes", "Search indexers and grab missing aired episodes.", ["search", "wanted", "missing"]],
  ["housekeeping", "Housekeeping", "Clean up old logs, cache entries and temporary files.", ["cleanup", "logs"]],
  ["update-check", "Update Watcher", "Check GitHub for a newer build and auto-download it.", ["update check", "release"]],
  ["pipeline-cleanup", "Pipeline Event Cleanup", "Purge old pipeline event log entries.", ["cleanup", "events", "history"]],
  ["quarantine-cleanup", "Quarantine Cleanup", "Delete junk files quarantined more than a day ago.", ["quarantine", "junk"]],
  ["health-check", "System Health Check", "Poll indexers, download clients and import paths for status.", ["health", "status"]],
  ["watcher-monitor", "Watcher Monitor", "Monitor download watcher health and restart if needed.", ["watcher"]],
  ["jellyfin-sync", "Jellyfin Sync", "Sync watched state from Jellyfin.", ["jellyfin", "watched"]],
  ["episode-mapping-refresh", "Episode Mapping Refresh", "Refresh TheXem episode mappings for anime season splits.", ["xem", "thexem", "anime", "scene"]],
] as const;

export const SETTINGS_REGISTRY: SettingMeta[] = [
  // ── General ────────────────────────────────────────────────────────────
  ...S("general", "Updates", [
    { id: "general.updates", label: "Updates", description: "ShowFlow releases published on GitHub and what the supervisor is running.", keywords: ["update", "upgrade", "version", "release", "github", "supervisor", "new version"] },
    { id: "general.auto-download", anchor: "general.updates", label: "Auto-download releases", description: "Download and verify new releases in the background, then wait for you to activate.", keywords: ["update", "automatic", "download", "release", "staged"] },
    { id: "general.auto-activate", anchor: "general.updates", label: "Auto-activate staged releases", description: "Activate a staged release by itself when idle or in a nightly window.", keywords: ["update", "automatic", "install", "restart", "nightly", "idle", "apply"] },
    { id: "general.update-status", anchor: "general.updates", label: "Update status", description: "Current state from the supervisor.", keywords: ["supervisor", "running version", "restart", "rollback"] },
  ]),
  ...S("general", "Grabbing", [
    { id: "general.upgrade-until-cutoff", label: "Upgrade until cutoff", description: "Keep looking for a better release while a file is below its quality profile's cutoff.", keywords: ["upgrade", "cutoff", "better quality", "replace", "auto-grab"] },
    { id: "general.prefer-season-packs", label: "Prefer season packs", description: "For a finished season, try one season pack before searching episode by episode.", keywords: ["season pack", "full season", "batch", "complete"] },
    { id: "general.pack-threshold", fallback: "general.prefer-season-packs", label: "Pack threshold", description: "Missing episodes a finished season needs before a pack is tried.", keywords: ["season pack", "minimum missing", "episodes"] },
  ]),
  ...S("general", "Libraries", [
    { id: "general.libraries", label: "Libraries", description: "Root folder, quality profile and indexer set per library.", keywords: ["library type", "root folder", "media folder", "path", "anime", "movies", "tv"] },
  ]),
  ...S("general", "Defaults", [
    { id: "general.default-provider", label: "Default provider", description: "Metadata provider used when adding shows.", keywords: ["tmdb", "tvdb", "anilist", "metadata", "add show"] },
    { id: "general.on-collision", label: "On collision", description: "What to do when a file already exists at the destination.", keywords: ["overwrite", "skip", "duplicate", "conflict", "exists", "version"] },
    { id: "general.dry-run", label: "Dry run", description: "Log actions without actually moving files.", keywords: ["test mode", "simulate", "no changes", "safe"] },
    { id: "general.fallback-timezone", label: "Fallback timezone", description: "Used when a show's origin country doesn't pin airtimes down.", keywords: ["time zone", "airtime", "tz", "america/new_york", "schedule"] },
    { id: "general.setup", fallback: "general.defaults", label: "Re-run setup wizard", description: "Re-run onboarding to reconfigure from scratch.", keywords: ["onboarding", "wizard", "setup", "reset", "first run"] },
  ]),

  // ── Quality ────────────────────────────────────────────────────────────
  ...S("quality", "Quality profiles", [
    { id: "quality.profiles", label: "Quality profiles", description: "What to grab and when to stop upgrading; create from a preset.", keywords: ["profile", "preset", "quality", "new profile", "sonarr"] },
    { id: "quality.profile-name", label: "Profile name", description: "Shown wherever you pick a profile.", keywords: ["rename profile"] },
    { id: "quality.resolution-target", label: "Target resolution", description: "Best resolution to grab.", keywords: ["1080p", "2160p", "4k", "720p", "uhd", "resolution", "max"] },
    { id: "quality.resolution-minimum", label: "Minimum resolution", description: "Lowest resolution you'll accept.", keywords: ["480p", "720p", "sd", "resolution", "min"] },
    { id: "quality.unknown-resolution", label: "Unknown resolution", description: "Accept names with no resolution tag (common on anime).", keywords: ["no resolution", "anime", "untagged"] },
    { id: "quality.sources", label: "Sources", description: "Release sources in order, best first; turn off any you never want.", keywords: ["bluray", "web-dl", "webrip", "hdtv", "remux", "dvd", "source"] },
    { id: "quality.terms", label: "Terms", description: "Prefer, avoid, must-have or never terms in release names.", keywords: ["custom format", "preferred words", "codec", "hevc", "x265", "release group", "keywords", "score", "must have", "never"] },
    { id: "quality.keep-upgrading", label: "Keep upgrading", description: "Look for better releases after the first grab.", keywords: ["upgrade", "cutoff", "replace"] },
    { id: "quality.upgrade-until", fallback: "quality.keep-upgrading", label: "Upgrade until", description: "Stop upgrading once the file reaches this quality.", keywords: ["cutoff", "upgrade target", "stop"] },
    { id: "quality.test-release", label: "Test a release", description: "Paste a title to see how a profile parses and scores it.", keywords: ["parse", "score", "release name", "debug", "try"] },
  ]),

  // ── Naming ─────────────────────────────────────────────────────────────
  ...S("naming", "Episode naming", [
    { id: "naming.rename-episodes", label: "Rename episodes", description: "Rename stored files to the format; off keeps original filenames.", keywords: ["rename", "file name", "filename", "organize"] },
    { id: "naming.replace-illegal-characters", label: "Replace illegal characters", description: "Replace characters illegal on NTFS/POSIX filesystems.", keywords: ["invalid characters", "ntfs", "windows", "sanitize"] },
    { id: "naming.colon-replacement", label: "Colon replacement", description: "How colons in titles are handled.", keywords: ["colon", "dash", "smart"] },
    { id: "naming.multi-episode-style", label: "Multi-episode style", description: "How multiple episodes in one file are numbered.", keywords: ["double episode", "multi ep", "extend", "range"] },
    { id: "naming.season-folder-format", label: "Season folder format", description: "Template for season subdirectories.", keywords: ["season folder", "directory", "folder name", "specials"] },
  ]),
  ...S("naming", "Formats", [
    { id: "naming.standard-episode-format", label: "Standard episode format", description: "File name template for standard series.", keywords: ["template", "tokens", "file name", "pattern"] },
    { id: "naming.daily-episode-format", label: "Daily episode format", description: "File name template for daily series (uses {Air Date}).", keywords: ["template", "air date", "talk show", "news"] },
    { id: "naming.anime-episode-format", label: "Anime episode format", description: "File name template for anime (supports absolute numbers).", keywords: ["template", "absolute", "anime"] },
  ]),

  // ── Downloads ──────────────────────────────────────────────────────────
  ...S("downloads", "Downloads", [
    { id: "downloads.download-client", label: "Download client", description: "How releases are submitted for downloading.", keywords: ["torbox", "sabnzbd", "usenet", "torrent", "blackhole", "client", "debrid"] },
    { id: "downloads.torbox-api-key", fallback: "downloads.download-client", label: "TorBox API key", description: "Your TorBox API key for direct downloads.", keywords: ["torbox", "debrid", "token", "key"] },
    { id: "downloads.download-directory", fallback: "downloads.download-client", label: "Download directory", description: "Where TorBox saves files locally.", keywords: ["torbox", "path", "folder", "download location"] },
    { id: "downloads.concurrent-downloads", fallback: "downloads.download-client", label: "Concurrent downloads", description: "Max grabs downloading at once; extra downloads queue.", keywords: ["parallel", "simultaneous", "slots", "queue", "limit"] },
    { id: "downloads.sabnzbd-url", fallback: "downloads.download-client", label: "SABnzbd URL", description: "Address of your SABnzbd server.", keywords: ["sabnzbd", "usenet", "nzb", "host"] },
    { id: "downloads.sabnzbd-api-key", fallback: "downloads.download-client", label: "SABnzbd API key", description: "Found in SABnzbd Config > General.", keywords: ["sabnzbd", "usenet", "nzb", "key"] },
    { id: "downloads.watch-folder", label: "Watch folder", description: "Directory where download clients place completed files.", keywords: ["blackhole", "completed", "import folder", "path", "watcher"] },
  ]),

  // ── Providers ──────────────────────────────────────────────────────────
  ...S("providers", "API keys", [
    { id: "providers.tmdb-api-key", label: "TMDB API key", description: "themoviedb.org v3 API key or v4 read access token.", keywords: ["tmdb", "themoviedb", "metadata", "token"] },
    { id: "providers.tvdb-api-key", label: "TVDB API key", description: "thetvdb.com API key for show metadata.", keywords: ["tvdb", "thetvdb", "metadata"] },
    { id: "providers.tvdb-pin", label: "TVDB PIN", description: "PIN for TVDB v4 API authentication (optional).", keywords: ["tvdb", "subscriber pin"] },
  ]),
  ...S("providers", "IMDb API", [
    { id: "providers.imdb", label: "IMDb ratings lookup", description: "Optional IMDb ratings via AWS Data Exchange.", keywords: ["imdb", "ratings", "aws", "data exchange", "enable"] },
    { id: "providers.imdb-api-key", label: "IMDb API key", description: "API key from your IMDb API subscription email.", keywords: ["imdb", "ratings"] },
    { id: "providers.aws-access-key-id", label: "AWS access key ID", description: "Long-term AWS credential for Data Exchange access.", keywords: ["aws", "imdb", "credentials", "iam"] },
    { id: "providers.aws-secret-access-key", label: "AWS secret access key", description: "Long-term AWS secret for Data Exchange access.", keywords: ["aws", "imdb", "secret", "credentials"] },
    { id: "providers.aws-region", label: "AWS region", description: "Region of the Data Exchange asset (usually us-east-1).", keywords: ["aws", "imdb", "us-east-1"] },
    { id: "providers.imdb-dataset", label: "Dataset / revision / asset IDs", description: "From your Data Exchange subscription.", keywords: ["aws", "imdb", "data set", "revision", "asset"] },
  ]),

  // ── Indexers ───────────────────────────────────────────────────────────
  ...S("indexers", "Prowlarr", [
    { id: "indexers.prowlarr", label: "Prowlarr connection", description: "Connect to Prowlarr to search torrent/usenet indexers.", keywords: ["prowlarr", "jackett", "indexer manager", "enable"] },
    { id: "indexers.prowlarr-url", fallback: "indexers.prowlarr", label: "Prowlarr URL", description: "Address of your Prowlarr server.", keywords: ["prowlarr", "host", "server"] },
    { id: "indexers.prowlarr-api-key", fallback: "indexers.prowlarr", label: "Prowlarr API key", description: "Found in Prowlarr Settings > General.", keywords: ["prowlarr", "key"] },
    { id: "indexers.sync-level", fallback: "indexers.prowlarr", label: "Sync level", description: "How indexers are synced from Prowlarr.", keywords: ["prowlarr", "sync", "full sync", "add and remove"] },
  ]),
  ...S("indexers", "Native indexers", [
    { id: "indexers.native", label: "Native indexers", description: "Built-in trackers, no Prowlarr required.", keywords: ["tracker", "torrent", "nyaa", "eztv", "built-in", "base url", "mirror"] },
  ]),

  // ── Integrations ───────────────────────────────────────────────────────
  ...S("integrations", "Metadata providers", [
    { id: "integrations.metadata", label: "Metadata providers (Sonarr import)", description: "TMDB and TVDB keys the Sonarr import needs.", keywords: ["tmdb", "tvdb", "api key", "metadata"] },
  ]),
  ...S("integrations", "Sonarr", [
    { id: "integrations.sonarr", label: "Sonarr", description: "Connect to Sonarr for series management and importing.", keywords: ["sonarr", "arr", "enable", "migrate"] },
    { id: "integrations.sonarr-url", fallback: "integrations.sonarr", label: "Sonarr URL", description: "Address of your Sonarr server.", keywords: ["sonarr", "host"] },
    { id: "integrations.sonarr-api-key", fallback: "integrations.sonarr", label: "Sonarr API key", description: "Found in Sonarr Settings > General.", keywords: ["sonarr", "key"] },
    { id: "integrations.sonarr-api-version", fallback: "integrations.sonarr", label: "Sonarr API version", description: "Sonarr API version (v3 / v5).", keywords: ["sonarr", "v3", "v5"] },
    { id: "integrations.sonarr-import", fallback: "integrations.sonarr", label: "Import series from Sonarr", description: "Select series to import, with series type mapping.", keywords: ["sonarr", "import", "migrate", "series type", "mapping", "fetch series"] },
  ]),
  ...S("integrations", "Jellyfin", [
    { id: "integrations.jellyfin", label: "Jellyfin", description: "Sync watched state from Jellyfin to ShowFlow.", keywords: ["jellyfin", "emby", "watched", "played", "sync"] },
    { id: "integrations.jellyfin-url", fallback: "integrations.jellyfin", label: "Jellyfin URL", description: "Address of your Jellyfin server.", keywords: ["jellyfin", "host"] },
    { id: "integrations.jellyfin-api-key", fallback: "integrations.jellyfin", label: "Jellyfin API key", description: "Found in Jellyfin Dashboard > API Keys.", keywords: ["jellyfin", "key"] },
  ]),

  // ── Connect ────────────────────────────────────────────────────────────
  ...S("connect", "Notifications", [
    { id: "connect.notifications", label: "Notification targets", description: "Send events to ntfy, Discord, Apprise or a webhook.", keywords: ["notify", "alerts", "push", "ntfy", "discord", "apprise", "webhook", "events", "add target"] },
  ]),
  ...S("connect", "Media server refresh", [
    { id: "connect.media-refresh", label: "Media server refresh", description: "After an import, ask Jellyfin and Plex to rescan that folder.", keywords: ["plex", "jellyfin", "rescan", "library refresh", "scan"] },
    { id: "connect.jellyfin-refresh", label: "Refresh Jellyfin after import", description: "Uses the URL and API key from Integrations > Jellyfin.", keywords: ["jellyfin", "rescan"] },
    { id: "connect.plex-refresh", label: "Refresh Plex after import", description: "Ask Plex to rescan the imported folder.", keywords: ["plex", "rescan"] },
    { id: "connect.plex-url", fallback: "connect.plex-refresh", label: "Plex URL", description: "Address of your Plex server.", keywords: ["plex", "host", "32400"] },
    { id: "connect.plex-token", fallback: "connect.plex-refresh", label: "Plex token", description: "Your X-Plex-Token.", keywords: ["plex", "x-plex-token", "key"] },
    { id: "connect.batch-window", label: "Batch window", description: "Seconds to wait for more imports before refreshing.", keywords: ["debounce", "delay", "seconds"] },
  ]),

  // ── Source Status ──────────────────────────────────────────────────────
  ...S("sources", undefined, [
    { id: "sources.overview", label: "Source status", description: "Health of Prowlarr and native indexers.", keywords: ["indexer status", "health", "errors", "sources", "down"] },
  ]),

  // ── Appearance ─────────────────────────────────────────────────────────
  ...S("appearance", "Accent", [
    { id: "appearance.accent", label: "Accent theme", description: "Accent color used throughout the interface.", keywords: ["color", "colour", "theme", "highlight", "brand"] },
  ]),
  ...S("appearance", "Colors", [
    { id: "appearance.colors", label: "Colors", description: "Adjust the base color scheme.", keywords: ["colour", "theme", "palette", "dark mode"] },
    ...COLOR_FIELDS.map(([slug, label, description]) => ({
      id: `appearance.color-${slug}`, fallback: "appearance.colors", label: `${label} color`, description, keywords: ["colour", "theme"],
    })),
  ]),
  ...S("appearance", "Typography", [
    { id: "appearance.typography", label: "Typography", description: "Fonts and text sizing.", keywords: ["font", "text size", "type"] },
    { id: "appearance.display-font", fallback: "appearance.typography", label: "Display font", description: "Font family for headings and titles.", keywords: ["font", "heading", "typeface"] },
    { id: "appearance.sans-font", fallback: "appearance.typography", label: "Sans font", description: "Font family for body text.", keywords: ["font", "body", "typeface"] },
    { id: "appearance.mono-font", fallback: "appearance.typography", label: "Mono font", description: "Font family for monospace / code text.", keywords: ["font", "monospace", "code"] },
    { id: "appearance.text-sizes", fallback: "appearance.typography", label: "Text sizes", description: "Caption, sub, small and base text sizes.", keywords: ["font size", "scale", "bigger", "smaller", "caption"] },
  ]),
  ...S("appearance", "Sizes & spacing", [
    { id: "appearance.sizes", label: "Sizes & spacing", description: "Density and sizing of UI elements.", keywords: ["density", "compact", "spacing"] },
    { id: "appearance.card-radius", fallback: "appearance.sizes", label: "Card radius", description: "Border radius on panels and cards.", keywords: ["rounded", "corners", "radius"] },
    { id: "appearance.element-radius", fallback: "appearance.sizes", label: "Element radius", description: "Border radius on buttons and inputs.", keywords: ["rounded", "corners", "radius", "buttons"] },
  ]),

  // ── Tasks ──────────────────────────────────────────────────────────────
  ...S("tasks", "File watcher", [
    { id: "tasks.file-watcher", label: "File watcher", description: "Watches the download folder and imports completed files.", keywords: ["watcher", "blackhole", "import", "restart"] },
  ]),
  ...S("tasks", "Scheduled tasks", TASKS.map(([name, label, description, kw]) => ({
    id: `tasks.${name}`, dynamic: true, fallback: "tasks.file-watcher", label, description, keywords: ["task", "schedule", "interval", "run now", ...kw],
  }))),

  // ── Backup ─────────────────────────────────────────────────────────────
  ...S("backup", "Database backups", [
    { id: "backup.backups", label: "Database backups", description: "Create, upload, download or restore database snapshots.", keywords: ["backup", "restore", "snapshot", "export", "import", "download db", "seed"] },
    { id: "backup.retention", label: "Backup retention", description: "How many recent, daily and weekly backups to keep.", keywords: ["keep", "retention", "prune", "old backups", "daily", "weekly"] },
  ]),

  // ── Analytics ──────────────────────────────────────────────────────────
  ...S("analytics", "Database usage", [
    { id: "analytics.database-usage", label: "Database usage", description: "Table sizes, activity and metadata cache.", keywords: ["database", "size", "disk", "tables", "stats", "storage"] },
    { id: "analytics.database-cleanup", fallback: "analytics.database-usage", label: "Database cleanup", description: "Trim old event history to shrink the database.", keywords: ["vacuum", "cleanup", "purge", "shrink"] },
  ]),

  // ── Debug ──────────────────────────────────────────────────────────────
  ...S("debug", "Debug mode", [
    { id: "debug.debug-enabled", label: "Debug mode", description: "Log all API calls and system events to a live console.", keywords: ["debug", "logging", "logs", "verbose", "console", "trace"] },
  ]),
];

// ── Matching ───────────────────────────────────────────────────────────────

export interface SettingResult {
  entry: SettingMeta;
  score: number;
  /** "Tab › Section" breadcrumb. */
  path: string;
}

export function tabLabel(tab: string): string {
  return SETTINGS_TABS.find(t => t.id === tab)?.label ?? tab;
}

/** Lowercase, strip accents and punctuation (keeps letters/digits). */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function words(s: string): string[] {
  const n = normalize(s);
  return n ? n.split(" ") : [];
}

/** Tab entries, so "backup" or "naming" also land on the tab itself. */
export const TAB_ENTRIES: SettingMeta[] = SETTINGS_TABS.map(t => ({
  id: `tab:${t.id}`,
  label: t.label,
  description: `${t.label} settings`,
  tab: t.id,
}));

/**
 * Score one entry against the query tokens. Every token must match somewhere
 * (AND); where it matches sets the weight: label beats keyword beats
 * section/tab beats description. 0 = no match.
 */
function scoreEntry(entry: SettingMeta, tokens: string[], phrase: string): number {
  const label = normalize(entry.label);
  const labelWords = words(entry.label);
  const kw = (entry.keywords ?? []).map(normalize);
  const kwWords = kw.flatMap(k => k.split(" "));
  const ctxWords = [...words(entry.section ?? ""), ...words(tabLabel(entry.tab))];
  const descWords = words(entry.description);

  let score = 0;
  for (const t of tokens) {
    let best = 0;
    if (labelWords.includes(t)) best = 30;
    else if (labelWords.some(w => w.startsWith(t))) best = 22;
    else if (kwWords.includes(t)) best = 18;
    else if (kwWords.some(w => w.startsWith(t))) best = 14;
    else if (ctxWords.some(w => w.startsWith(t))) best = 8;
    else if (descWords.some(w => w.startsWith(t))) best = 5;
    // Mid-word fallback ("box" -> TorBox), only for 3+ chars to avoid noise.
    else if (t.length >= 3 && (label.replace(/ /g, "").includes(t) || kw.some(k => k.replace(/ /g, "").includes(t)))) best = 4;
    if (!best) return 0;
    score += best;
  }
  // Whole-phrase bonuses: exact label, label prefix, exact keyword phrase.
  if (label === phrase) score += 40;
  else if (label.startsWith(phrase)) score += 20;
  if (kw.includes(phrase)) score += 12;
  // Prefer specific rows over whole tabs when scores tie.
  if (entry.id.startsWith("tab:")) score -= 1;
  return score;
}

/**
 * Search settings by label, keywords, section/tab and description.
 * Results are sorted best first; ties keep registry order (= page order).
 */
export function searchSettings(
  query: string,
  { limit = 20, entries = SETTINGS_REGISTRY, includeTabs = true }: { limit?: number; entries?: SettingMeta[]; includeTabs?: boolean } = {},
): SettingResult[] {
  const phrase = normalize(query);
  if (!phrase) return [];
  const tokens = phrase.split(" ");
  const pool = includeTabs ? [...TAB_ENTRIES, ...entries] : entries;
  const scored: { r: SettingResult; i: number }[] = [];
  pool.forEach((entry, i) => {
    const score = scoreEntry(entry, tokens, phrase);
    if (score > 0) scored.push({ r: { entry, score, path: settingPath(entry) }, i });
  });
  return scored
    .sort((a, b) => b.r.score - a.r.score || a.i - b.i)
    .slice(0, limit)
    .map(x => x.r);
}

export function settingPath(entry: SettingMeta): string {
  if (entry.id.startsWith("tab:")) return "Settings";
  const tab = tabLabel(entry.tab);
  return entry.section && normalize(entry.section) !== normalize(tab) ? `${tab} › ${entry.section}` : tab;
}

export function findSetting(id: string): SettingMeta | undefined {
  return SETTINGS_REGISTRY.find(e => e.id === id) ?? TAB_ENTRIES.find(e => e.id === id);
}
