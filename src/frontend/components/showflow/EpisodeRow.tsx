import { Check, DownloadIcon, Loader2Icon, RefreshCw, MousePointerClick, SearchIcon, Info, Clock } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";

import { EpisodeChip } from "@frontend/components/showflow/EpisodeChip";
import { MediaBadges } from "@frontend/components/showflow/MediaBadges";
import {
  STATE_CHIP,
  STATE_LABEL,
  episodeExplainId,
  type ExplainedEpisode,
} from "@frontend/lib/pipelineStatus";
import {
  expectedReleaseTime,
  formatFileSize,
  formatImportDate,
} from "@frontend/lib/airtime";

export interface AudioTrackInfo {
  codec?: string | null;
  channels?: number | null;
  language?: string | null;
  name?: string | null;
}

export interface FileMedia {
  container?: string | null;
  videoWidth?: number | null;
  videoHeight?: number | null;
  videoCodec?: string | null;
  videoFps?: number | null;
  hdr?: boolean;
  hdrFormat?: string | null;
  audioCodec?: string | null;
  audioChannels?: number | null;
  audioTracks?: AudioTrackInfo[] | null;
  audioLanguages?: string[] | null;
  releaseTags?: string[] | null;
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

/** Show id for the episode rows below (ShowDetail provides it); enables the "why not pulled" badge. */
export const EpisodeShowContext = React.createContext<string | null>(null);

/**
 * "Why hasn't this been pulled?" for a missing tracked episode: fetches
 * /api/episodes/:id/explain on open (no extra load on the list itself) and
 * shows the same reason line as the Pipeline's Needs attention list.
 */
function WhyPopover({ showId, episode }: { showId: string; episode: EpisodeData }) {
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<ExplainedEpisode | null>(null);
  const [failed, setFailed] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const popRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ top?: number; bottom?: number; right: number } | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Portal + fixed position: the season card clips overflow, so an
    // absolutely positioned popover on the last rows would be cut off.
    const r = ref.current?.getBoundingClientRect();
    if (r) {
      const below = window.innerHeight - r.bottom > 140;
      const right = Math.max(8, window.innerWidth - r.right);
      setPos(below ? { top: r.bottom + 6, right } : { bottom: window.innerHeight - r.top + 6, right });
    }
    setFailed(false);
    fetch(`/api/episodes/${episodeExplainId(showId, episode.season, episode.episode)}/explain`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setFailed(true); });
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => { cancelled = true; document.removeEventListener("mousedown", handler); };
  }, [open, showId, episode.season, episode.episode, episode.tracked, episode.searchMode]);

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label="Why hasn't this been downloaded?"
        aria-expanded={open}
        title="Why not downloaded yet?"
        className="rounded px-1 font-mono text-[11px] text-muted-foreground hover:text-white/90 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal transition-colors"
      >
        why?
      </button>
      {open && pos && createPortal(
        <div ref={popRef} role="dialog" aria-label="Pipeline status" style={{ position: "fixed", top: pos.top, bottom: pos.bottom, right: pos.right }} className="z-[100] w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-white/10 bg-[#15181f] shadow-2xl shadow-black/50 p-3 text-left animate-fade-in">
          <div className="font-mono text-[11px] font-bold uppercase tracking-widest text-signal mb-2">// Pipeline status</div>
          {data ? (
            <div className="space-y-1.5">
              <span className={`inline-block rounded border px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide ${STATE_CHIP[data.state]}`}>
                {STATE_LABEL[data.state]}
              </span>
              <p className="text-xs leading-snug text-white/85">{data.detail}</p>
            </div>
          ) : failed ? (
            <p className="text-xs text-red-300">Couldn't load the status.</p>
          ) : (
            <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />
          )}
        </div>,
        document.body,
      )}
    </div>
  );
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

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label="File and release details"
        title="File & release details"
        className="text-muted-foreground hover:text-white/80 transition-colors p-0.5"
      >
        <Info className="size-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-40 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-white/10 bg-[#15181f] shadow-2xl shadow-black/50 p-3 text-left animate-fade-in">
          <div className="font-mono text-[11px] font-bold uppercase tracking-widest text-signal mb-2">
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
              {media && <MediaBadges media={media} className="pt-0.5" />}
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
      {/* min-w-0 lets the value shrink inside the flex row — without it long
          release titles/paths overflow the card instead of wrapping. */}
      <span className={`text-white/85 text-right break-all min-w-0 flex-1 ${mono ? "font-mono text-[11px]" : "font-medium"}`} title={value}>
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
  const showId = React.useContext(EpisodeShowContext);
  const showAirDate = columns.find(c => c.id === 'airDate')?.visible;
  const showStatus = columns.find(c => c.id === 'status')?.visible;
  const showSearch = columns.find(c => c.id === 'search')?.visible;
  const showActions = columns.find(c => c.id === 'actions')?.visible ?? true;

  // Two templates: the full column set from sm up, and a phone layout
  // (<640px) where the air date folds under the title, status shrinks to a
  // dot + info glyph and the search-mode toggle hides, so the title column
  // keeps most of a 390px row instead of being squeezed to a few letters.
  // CSS vars (not an inline gridTemplateColumns) so the breakpoint can switch.
  const desktopCols = [
    '24px',
    '60px',
    showAirDate ? 'auto' : '',
    'minmax(0, 1fr)',
    showStatus ? 'auto' : '',
    showActions ? '76px' : '',
    showSearch ? '48px' : '',
  ].filter(Boolean).join(' ');
  const mobileCols = [
    '24px',
    'auto',
    'minmax(0, 1fr)',
    showStatus ? 'auto' : '',
    showActions ? 'auto' : '',
  ].filter(Boolean).join(' ');

  const airDateLabel = episode.airDate
    ? (() => {
        const d = new Date(episode.airDate);
        const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        const time = expectedReleaseTime(episode.expectedReleaseAt, episode.airDate) ?? formatAirTime(episode.airDate);
        return time ? `${date} ${time}` : date;
      })()
    : null;

  return (
    <div
      className="group grid gap-2 items-center px-3 sm:px-4 py-2 transition-colors hover:bg-white/[0.02] grid-cols-[var(--ep-cols-sm)] sm:grid-cols-[var(--ep-cols)]"
      style={{ '--ep-cols': desktopCols, '--ep-cols-sm': mobileCols } as React.CSSProperties}
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
              ? "border-signal/60 bg-signal/20 text-signal"
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

      {/* Air Date (own column from sm up; folded under the title on phones) */}
      {showAirDate && (
        <span className="hidden sm:block font-mono text-sub text-muted-foreground truncate whitespace-nowrap">
          {airDateLabel ?? '—'}
        </span>
      )}

      {/* Title */}
      <span className="min-w-0 flex flex-col">
        <span className="truncate text-sm leading-snug text-foreground/85 group-hover:text-foreground transition-colors">
          {episode.title || "TBA"}
        </span>
        {showAirDate && airDateLabel && (
          <span className="sm:hidden truncate font-mono text-[11px] leading-snug text-muted-foreground">
            {airDateLabel}
          </span>
        )}
      </span>

      {/* Status */}
      {showStatus && (
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <span className={`hidden sm:inline font-mono text-caption uppercase tracking-wider ${
            available ? "text-signal/70" : "text-muted-foreground"
          }`}>
            {available ? "Available" : "Missing"}
          </span>
          {!available && showId && <WhyPopover showId={showId} episode={episode} />}
          {/* Phones: the filled check toggle already shows availability, so
              no extra dot; missing rows keep "why?" and drop the info glyph
              to leave the title its width. */}
          <span className={available ? "inline-flex" : "hidden sm:inline-flex"}>
            <InfoPopover episode={episode} />
          </span>
        </span>
      )}

      {/* Search / grab actions - always visible (dimmed at rest, full on hover/focus) so touch users can reach them */}
      {showActions && (
        <div className="flex items-center justify-end gap-1 opacity-75 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
          className="hidden sm:flex items-center justify-center transition-colors"
          aria-label={`Search mode: ${episode.searchMode || 'auto'}`}
          title={`Search mode: ${episode.searchMode || 'auto'} (click to toggle)`}
        >
          {episode.searchMode === 'interactive' ? (
            <span className="text-accent-amber/80 hover:text-accent-amber flex items-center gap-1">
              <MousePointerClick className="size-3.5" />
            </span>
          ) : (
            <span className="text-muted-foreground hover:text-signal/70 flex items-center gap-1">
              <RefreshCw className="size-3.5" />
            </span>
          )}
        </button>
      )}
    </div>
  );
}

export { EpisodeRow };
