import { Check, DownloadIcon, Loader2Icon, RefreshCw, MousePointerClick, SearchIcon } from "lucide-react";
import * as React from "react";

import { EpisodeChip } from "@frontend/components/showflow/EpisodeChip";

export interface EpisodeData {
  season: number;
  episode: number;
  title?: string;
  filePath?: string;
  tracked: boolean;
  airDate?: string | null;
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
                const time = formatAirTime(episode.airDate);
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
        <span className={`font-mono text-caption uppercase tracking-wider whitespace-nowrap ${
          available ? "text-signal/70" : "text-muted-foreground/50"
        }`}>
          {available ? "Available" : "Missing"}
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
