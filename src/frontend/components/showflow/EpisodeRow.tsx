import { Check, DownloadIcon, Loader2Icon, RefreshCw, MousePointerClick, SearchIcon, Info, Clock } from "lucide-react";
import * as React from "react";

import { EpisodeChip } from "@frontend/components/showflow/EpisodeChip";
import { MediaBadges } from "@frontend/components/showflow/MediaBadges";
import {
  expectedReleaseTime,
  formatFileSize,
  formatImportDate,
  formatResolution,
  formatBitrate,
  formatDuration,
} from "@frontend/lib/airtime";

export interface FileMedia {
  container?: string | null;
  videoWidth?: number | null;
  videoHeight?: number | null;
  videoCodec?: string | null;
  videoFps?: number | null;
  hdr?: boolean;
  audioCodec?: string | null;
  audioChannels?: number | null;
  durationSeconds?: number | null;
  bitrateKbps?: number | null;
  probedAt?: string | null;
}

export interface EpisodeFileInfo {
  path?: string | null;
  name?: string | null;
  size?: number | null;
  sourceKind?: string | null;
  releaseTitle?: string | null;
  indexerName?: string | null;
  publishDate?: string | null;
  importedAt?: string | null;
  media?: FileMedia | null;
}

export interface EpisodeData {
  season: number;
  episode: number;
  title?: string;
  filePath?: string;
  tracked: boolean;
  airDate?: string | null;
  airTime?: string | null;
  expectedReleaseAt?: string | null;
  file?: EpisodeFileInfo | null;
  searchMode?: 'auto' | 'interactive';
}

export interface ColumnDef {
  id: string;
  label: string;
  visible: boolean;
}

function formatAirTime(airDate: string) {
  if (!airDate.includes("T")) return null;
  const d = new Date(airDate);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
}

/** Entry-row detail popover: granular "what file + which release" for an
 *  episode. Hover/click the info glyph in the row. */
function InfoPopover({ episode }: { episode: EpisodeData }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const rel = episode.file?.releaseTitle ?? episode.file?.name;
  const release = episode.file;
  const media = release?.media;
  const expected = expectedReleaseTime(episode.expectedReleaseAt, episode.airDate);

  const mediaBadges: { label: string; key: string }[] = [];
  if (media?.container) mediaBadges.push({ label: media.container, key: 'container' });
  const res = media?.videoWidth != null || media?.videoHeight != null
    ? formatResolution(media.videoHeight, media.videoWidth)
    : "";
  if (res) mediaBadges.push({ label: res, key: 'res' });
  if (media?.videoCodec) mediaBadges.push({ label: media.videoCodec.toUpperCase(), key: 'codec' });
  if (media?.hdr) mediaBadges.push({ label: "HDR", key: 'hdr' });
  if (media?.audioCodec) mediaBadges.push({ label: media.audioCodec.toUpperCase(), key: 'audio' });
  if (media?.audioChannels) mediaBadges.push({ label: `${media.audioChannels}ch`, key: 'ch' });
  if (media?.bitrateKbps) mediaBadges.push({ label: formatBitrate(media.bitrateKbps), key: 'br' });
  if (media?.durationSeconds) mediaBadges.push({ label: formatDuration(media.durationSeconds), key: 'dur' });

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label="File and release details"
        title="File & release details"
        className="text-muted-foreground/40 hover:text-white/80 transition-colors p-0.5"
      >
        <Info className="size-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-40 w-72 rounded-lg border border-white/10 bg-[#15181f] shadow-2xl shadow-black/50 p-3 text-left animate-fade-in">
          <div className="font-mono text-[9px] font-bold uppercase tracking-widest text-signal mb-2">
            // Release provenance
          </div>
          {rel ? (
            <div className="space-y-1.5">
              <Detail label="Release" value={rel} />
              {release?.sourceKind && <Detail label="Source" value={release.sourceKind} />}
              {release?.indexerName && <Detail label="Indexer" value={release.indexerName} />}
              {release?.publishDate && <Detail label="Published" value={formatImportDate(release.publishDate)} />}
              {release?.importedAt && <Detail label="Imported" value={formatImportDate(release.importedAt)} />}
              {release?.size != null && <Detail label="Size" value={formatFileSize(release.size)} />}
              {release?.path && <Detail label="Path" value={release.path} mono />}
              {mediaBadges.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-0.5" aria-label="Media info">
                  {mediaBadges.map((b) => (
                    <span
                      key={b.key}
                      className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-white/70"
                    >
                      {b.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              {episode.filePath ? episode.filePath : "No file stored for this episode yet."}
            </div>
          )}
          {expected && !rel && (
            <div className="mt-2 flex items-center gap-1.5 border-t border-white/5 pt-2 text-[11px] text-signal/80">
              <Clock className="size-3" /> Expected release {expected}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`text-white/85 text-right break-all ${mono ? "font-mono text-[10px]" : "font-medium"}`} title={value}>
        {value}
      </span>
    </div>
  );
}

function EpisodeRow({
  episode,
  columns,
  grabbing,
  onToggleTracked,
  onChangeSearchMode,
  onAutoGrab,
  onOpenSearch,
}: {
  episode: EpisodeData;
  columns: ColumnDef[];
  grabbing?: boolean;
  onToggleTracked: (tracked: boolean) => void;
  onChangeSearchMode?: (mode: 'auto' | 'interactive') => void;
  onAutoGrab?: () => void;
  onOpenSearch?: () => void;
}) {
  const available = !!episode.filePath;
  const showAirDate = columns.find(c => c.id === 'airDate')?.visible;
  const showStatus = columns.find(c => c.id === 'status')?.visible;
  const showSearch = columns.find(c => c.id === 'search')?.visible;
  const showActions = columns.find(c => c.id === 'actions')?.visible ?? true;

  return (
    <div
      className="group grid gap-2 items-center px-4 py-2 transition-colors hover:bg-white/[0.02]"
      style={{
        gridTemplateColumns: [
          '24px',
          '60px',
          showAirDate ? 'auto' : '',
          'minmax(0, 1fr)',
          showStatus ? 'auto' : '',
          showActions ? '76px' : '',
          showSearch ? '48px' : '',
        ].filter(Boolean).join(' '),
      }}
    >
      {/* Track toggle */}
      <button
        type="button"
        onClick={() => onToggleTracked(!episode.tracked)}
        aria-label={episode.tracked ? "Mark untracked" : "Mark tracked"}
        className={`size-5 rounded-full border-2 transition-all grid place-items-center ${
          available
            ? "border-signal bg-signal text-[#051208]"
            : episode.tracked
              ? "border-signal/60 bg-signal/20 text-signal/60"
              : "border-white/20 group-hover:border-white/40 text-transparent"
        }`}
      >
        <Check className="size-3.5" strokeWidth={3} />
      </button>

      {/* Episode code */}
      <div className="flex items-center gap-1.5">
        <EpisodeChip
          season={episode.season}
          episode={episode.episode}
          state={episode.tracked ? "tracked" : "none"}
          className="font-mono text-xs"
        />
      </div>

      {/* Air Date */}
      {showAirDate && (
        <span className="font-mono text-sub text-muted-foreground/70 truncate whitespace-nowrap">
          {episode.airDate
            ? (() => {
                const d = new Date(episode.airDate);
                const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
                const time = expectedReleaseTime(episode.expectedReleaseAt, episode.airDate) ?? formatAirTime(episode.airDate);
                return time ? `${date} ${time}` : date;
              })()
            : '—'}
        </span>
      )}

      {/* Title */}
      <span className="truncate text-sm leading-snug text-foreground/85 group-hover:text-foreground transition-colors">
        {episode.title || "TBA"}
      </span>

      {/* Status */}
      {showStatus && (
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <span className={`font-mono text-caption uppercase tracking-wider ${
            available ? "text-signal/70" : "text-muted-foreground/50"
          }`}>
            {available ? "Available" : "Missing"}
          </span>
          {available && <MediaBadges media={episode.file?.media} max={4} className="hidden md:inline-flex" />}
          <InfoPopover episode={episode} />
        </span>
      )}

      {/* Search / grab actions - revealed on row hover so the list stays quiet at rest */}
      {showActions && (
        <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={onOpenSearch}
            aria-label="Search releases"
            title="Interactive search"
            className="text-muted-foreground hover:text-signal transition-colors p-1"
          >
            <SearchIcon className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onAutoGrab}
            disabled={grabbing}
            aria-label="Auto search and grab"
            title="Auto search & grab best match"
            className="text-muted-foreground hover:text-signal transition-colors p-1 disabled:opacity-50"
          >
            {grabbing ? <Loader2Icon className="size-3.5 animate-spin" /> : <DownloadIcon className="size-3.5" />}
          </button>
        </div>
      )}

      {/* Search mode */}
      {showSearch && (
        <button
          type="button"
          onClick={() => onChangeSearchMode?.(episode.searchMode === 'auto' ? 'interactive' : 'auto')}
          className="flex items-center justify-center transition-colors"
          aria-label={`Search mode: ${episode.searchMode || 'auto'}`}
          title={`Search mode: ${episode.searchMode || 'auto'} (click to toggle)`}
        >
          {episode.searchMode === 'interactive' ? (
            <span className="text-accent-amber/80 hover:text-accent-amber flex items-center gap-1">
              <MousePointerClick className="size-3.5" />
            </span>
          ) : (
            <span className="text-muted-foreground/50 hover:text-signal/70 flex items-center gap-1">
              <RefreshCw className="size-3.5" />
            </span>
          )}
        </button>
      )}
    </div>
  );
}

export { EpisodeRow };
