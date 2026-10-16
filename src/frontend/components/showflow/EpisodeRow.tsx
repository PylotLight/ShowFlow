import { Check, CircleAlert, DownloadIcon, Loader2Icon, RefreshCw, MousePointerClick, SearchIcon, Info, Clock } from "lucide-react";
import { touchHit, touchHitRound } from "@frontend/components/ui/pill";
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
import { cn } from "@frontend/lib/utils";
import { useCompact } from "@frontend/lib/useCompact";
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

function formatAirTime(airDate: string) {
  if (!airDate.includes("T")) return null;
  const d = new Date(airDate);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
}

function episodeCode(season: number, episode: number) {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

/** Not on disk yet and its air date is still ahead (or unknown). */
function isUpcoming(episode: EpisodeData) {
  if (episode.filePath) return false;
  if (!episode.airDate) return true;
  const t = new Date(episode.airDate).getTime();
  return isNaN(t) || t > Date.now();
}

/**
 * One details trigger per row (replaces the old "why?" text link + separate
 * info glyph). The glyph hints the state: info = on disk, clock = not aired
 * yet, alert = aired but missing. Opens the release provenance for files on
 * disk, and the pipeline's "why hasn't this been pulled" answer (fetched from
 * /api/episodes/:id/explain on open, no extra load on the list) for missing
 * ones. Popover on desktop, bottom sheet in the compact layout.
 */
function EpisodeDetails({ showId, episode, compact }: { showId: string | null; episode: EpisodeData; compact: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<ExplainedEpisode | null>(null);
  const [failed, setFailed] = React.useState(false);
  const ref = React.useRef<HTMLButtonElement>(null);
  const popRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ top?: number; bottom?: number; right: number } | null>(null);

  const available = !!episode.filePath;
  const upcoming = isUpcoming(episode);
  const explain = !available && !!showId;

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Portal + fixed position: the season card clips overflow, so an
    // absolutely positioned popover on the last rows would be cut off.
    const r = ref.current?.getBoundingClientRect();
    if (r && !compact) {
      const below = window.innerHeight - r.bottom > 220;
      const right = Math.max(8, window.innerWidth - r.right);
      setPos(below ? { top: r.bottom + 6, right } : { bottom: window.innerHeight - r.top + 6, right });
    }
    if (explain) {
      setFailed(false);
      fetch(`/api/episodes/${episodeExplainId(showId!, episode.season, episode.episode)}/explain`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => { if (!cancelled) setData(d); })
        .catch(() => { if (!cancelled) setFailed(true); });
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, compact, explain, showId, episode.season, episode.episode, episode.tracked, episode.searchMode]);

  const Icon = available ? Info : upcoming ? Clock : CircleAlert;
  const label = available ? "File and release details" : upcoming ? "Upcoming: release details" : "Why hasn't this been downloaded?";

  const body = <EpisodeDetailsBody episode={episode} explain={explain} data={data} failed={failed} />;

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={label}
        className={cn(
          touchHit, "rounded-md p-1 max-md:p-1.5 transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal",
          open ? "text-white/90 bg-white/[0.06]" : !available && !upcoming ? "text-accent-amber/70 hover:text-accent-amber" : "text-muted-foreground hover:text-white/85",
        )}
      >
        <Icon className="size-3.5" />
      </button>
      {open && compact && createPortal(
        <div className="fixed inset-0 z-[100] flex flex-col justify-end" role="presentation">
          <div className="absolute inset-0 bg-black/55 animate-fade-in" onClick={() => setOpen(false)} aria-hidden />
          <div
            ref={popRef}
            role="dialog"
            aria-label={`${episodeCode(episode.season, episode.episode)} details`}
            className="relative mx-auto w-full max-w-lg rounded-t-2xl border-t border-white/10 bg-[#15181f] px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl shadow-black/60 animate-page-enter"
          >
            <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-white/15" aria-hidden />
            <div className="mb-3 flex items-baseline gap-2 min-w-0">
              <span className="font-mono text-xs tabular-nums text-muted-foreground shrink-0">{episodeCode(episode.season, episode.episode)}</span>
              <span className={cn("truncate text-sm", episode.title ? "text-white/90" : "text-muted-foreground")}>{episode.title || "TBA"}</span>
            </div>
            {body}
          </div>
        </div>,
        document.body,
      )}
      {open && !compact && pos && createPortal(
        <div
          ref={popRef}
          role="dialog"
          aria-label={`${episodeCode(episode.season, episode.episode)} details`}
          style={{ position: "fixed", top: pos.top, bottom: pos.bottom, right: pos.right }}
          className="z-[100] w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-white/10 bg-[#15181f] shadow-2xl shadow-black/50 p-3 text-left animate-fade-in"
        >
          {body}
        </div>,
        document.body,
      )}
    </>
  );
}

function EpisodeDetailsBody({ episode, explain, data, failed }: {
  episode: EpisodeData;
  explain: boolean;
  data: ExplainedEpisode | null;
  failed: boolean;
}) {
  const rel = episode.file?.releaseTitle ?? episode.file?.name;
  const release = episode.file;
  const media = release?.media;
  const expected = expectedReleaseTime(episode.expectedReleaseAt, episode.airDate);
  const heading = "font-mono text-[11px] font-bold uppercase tracking-widest text-signal mb-2";

  return (
    <div className="space-y-3 text-left">
      {explain && (
        <section>
          <div className={heading}>// Pipeline status</div>
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
        </section>
      )}
      {rel ? (
        <section>
          <div className={heading}>// Release provenance</div>
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
        </section>
      ) : episode.filePath ? (
        <section>
          <div className={heading}>// File</div>
          <div className="font-mono text-[11px] text-white/80 break-all">{episode.filePath}</div>
        </section>
      ) : !explain ? (
        <div className="text-xs text-muted-foreground">No file stored for this episode yet.</div>
      ) : null}
      {expected && !rel && (
        <div className="flex items-center gap-1.5 border-t border-white/5 pt-2 text-[11px] text-signal/80">
          <Clock className="size-3" /> Expected release {expected}
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
  const compact = useCompact();
  const showAirDate = columns.find(c => c.id === 'airDate')?.visible;
  const showStatus = columns.find(c => c.id === 'status')?.visible;
  const showSearch = columns.find(c => c.id === 'search')?.visible;
  const showActions = columns.find(c => c.id === 'actions')?.visible ?? true;

  // Two templates: the full column set from md up, and the compact layout
  // (<768px, same switch as the rest of the app) where the air date folds
  // under the title, status shrinks to the details glyph and the search-mode
  // toggle hides, so the title column keeps most of a 390px row and the
  // trailing icons always fit. CSS vars (not an inline gridTemplateColumns)
  // so the breakpoint can switch.
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
    // details glyph + search + grab share one trailing cluster
    showStatus || showActions ? 'auto' : '',
  ].filter(Boolean).join(' ');

  const airDateLabel = episode.airDate
    ? (() => {
        const d = new Date(episode.airDate);
        const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        const time = expectedReleaseTime(episode.expectedReleaseAt, episode.airDate) ?? formatAirTime(episode.airDate);
        return time ? `${date} ${time}` : date;
      })()
    : null;

  const actionBtn = touchHit + " rounded-md p-1 max-md:p-1.5 text-muted-foreground hover:text-signal hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal";
  const actions = showActions && (
    <>
      <button
        type="button"
        onClick={onOpenSearch}
        aria-label="Search releases"
        title="Interactive search"
        className={actionBtn}
      >
        <SearchIcon className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onAutoGrab}
        disabled={grabbing}
        aria-label="Auto search and grab"
        title="Auto search & grab best match"
        className={cn(actionBtn, "disabled:opacity-50")}
      >
        {grabbing ? <Loader2Icon className="size-3.5 animate-spin" /> : <DownloadIcon className="size-3.5" />}
      </button>
    </>
  );

  return (
    <div
      className="group grid min-w-0 gap-2 items-center px-3 md:px-4 py-2 transition-colors hover:bg-white/[0.02] grid-cols-[var(--ep-cols-sm)] md:grid-cols-[var(--ep-cols)]"
      style={{ '--ep-cols': desktopCols, '--ep-cols-sm': mobileCols } as React.CSSProperties}
    >
      {/* Track toggle */}
      <button
        type="button"
        onClick={() => onToggleTracked(!episode.tracked)}
        aria-label={episode.tracked ? "Mark untracked" : "Mark tracked"}
        className={`${touchHitRound} size-5 rounded-full border-2 transition-all grid place-items-center ${
          available
            ? "border-signal bg-signal text-[#051208]"
            : episode.tracked
              ? "border-signal/60 bg-signal/20 text-signal"
              : "border-white/20 group-hover:border-white/40 text-transparent"
        }`}
      >
        <Check className="size-3.5" strokeWidth={3} />
      </button>

      {/* Episode code. Compact drops the tally dot: the check toggle beside
          it already shows tracked / available. */}
      <div className="flex items-center gap-1.5">
        <EpisodeChip
          season={episode.season}
          episode={episode.episode}
          state={episode.tracked ? "tracked" : "none"}
          className="font-mono text-xs"
          dotClassName="max-md:hidden"
        />
      </div>

      {/* Air Date (own column from md up; folded under the title on compact) */}
      {showAirDate && (
        <span className="hidden md:block font-mono text-sub text-muted-foreground truncate whitespace-nowrap">
          {airDateLabel ?? '—'}
        </span>
      )}

      {/* Title. Unnamed episodes ("TBA") render muted at the same size so
          a run of upcoming rows doesn't read louder than the named ones. */}
      <span className="min-w-0 flex flex-col">
        <span className={cn(
          "truncate text-sm max-md:text-[13px] leading-snug transition-colors",
          episode.title ? "text-foreground/85 group-hover:text-foreground" : "text-muted-foreground",
        )}>
          {episode.title || "TBA"}
        </span>
        {showAirDate && airDateLabel && (
          <span className="md:hidden truncate font-mono text-[11px] leading-snug text-muted-foreground">
            {airDateLabel}
          </span>
        )}
      </span>

      {compact ? (
        /* Compact: details glyph + search + grab in one tight cluster that
           always fits inside the row (no clipped icons at 390 / 440). */
        (showStatus || showActions) && (
          <div className="flex items-center justify-end gap-0.5 -mr-1.5">
            {showStatus && <EpisodeDetails showId={showId} episode={episode} compact />}
            {actions}
          </div>
        )
      ) : (
        <>
          {/* Status */}
          {showStatus && (
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span className={`font-mono text-caption uppercase tracking-wider ${
                available ? "text-signal/70" : "text-muted-foreground"
              }`}>
                {available ? "Available" : isUpcoming(episode) ? "Upcoming" : "Missing"}
              </span>
              <EpisodeDetails showId={showId} episode={episode} compact={false} />
            </span>
          )}

          {/* Search / grab actions - always visible (dimmed at rest, full on hover/focus) so touch users can reach them */}
          {showActions && (
            <div className="flex items-center justify-end gap-1 opacity-75 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              {actions}
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
                <span className="text-muted-foreground hover:text-signal/70 flex items-center gap-1">
                  <RefreshCw className="size-3.5" />
                </span>
              )}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export { EpisodeRow };
