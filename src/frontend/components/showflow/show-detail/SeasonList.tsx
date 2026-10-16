import { Check, ChevronDown, DownloadIcon, Loader2Icon, SearchIcon } from "lucide-react";
import * as React from "react";

import { EpisodeRow, type ColumnDef, type EpisodeData } from "@frontend/components/showflow/EpisodeRow";

import { focusRing, seasonLabel } from "./format";
import type { EpisodeFilter, GrabTarget, SearchTarget, SeasonSection } from "./types";

const seasonBtn =
  "flex items-center gap-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.08] text-muted-foreground hover:text-foreground px-2.5 py-1 font-mono text-caption uppercase tracking-wider transition-colors disabled:opacity-60 max-sm:size-8 max-sm:justify-center max-sm:px-0 " +
  focusRing;

/** One collapsible season: header with Monitor / Browse / Auto, then its episode rows. */
function SeasonBlock({ section, expanded, filter, columns, grabTarget, onToggleCollapsed, onToggleSeasonTracked, onOpenSearch, onAutoGrabSeason, episodeHandlers }: {
  section: SeasonSection;
  expanded: boolean;
  filter: EpisodeFilter;
  columns: ColumnDef[];
  grabTarget: GrabTarget;
  onToggleCollapsed: () => void;
  onToggleSeasonTracked: (tracked: boolean) => void;
  onOpenSearch: (t: SearchTarget) => void;
  onAutoGrabSeason: () => void;
  episodeHandlers: {
    toggleTracked: (ep: EpisodeData, tracked: boolean) => void;
    changeSearchMode: (ep: EpisodeData, mode: "auto" | "interactive") => void;
    autoGrabEpisode: (ep: EpisodeData) => void;
  };
}) {
  const { season, all, episodes: eps } = section;
  const n = season.seasonNumber;
  const label = seasonLabel(n);
  const avail = all.filter((e) => !!e.filePath).length;
  const seasonTracked = all.length > 0 && all.every((e) => e.tracked);
  const grabbingSeason = grabTarget === `season:${n}`;

  return (
    <div className="border-b border-white/[0.04] last:border-0">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className={`flex min-w-0 flex-1 items-center gap-2.5 text-left rounded-md ${focusRing}`}
          aria-expanded={expanded}
        >
          <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "" : "-rotate-90"}`} />
          <span className="font-display text-sm font-semibold tracking-wide text-white/90 shrink-0">{label}</span>
          <span className="font-mono text-xs shrink-0">
            <span className="text-signal">{avail}</span>
            <span className="text-muted-foreground">/{all.length}</span>
          </span>
          <span className="hidden sm:block w-24 h-1 rounded-full bg-white/5 overflow-hidden shrink-0" aria-hidden>
            <span className="block h-full rounded-full bg-signal/70" style={{ width: all.length ? `${(avail / all.length) * 100}%` : "0%" }} />
          </span>
        </button>
        <div className="flex items-center gap-1.5 flex-wrap">
          {all.length > 0 && (
            <button
              type="button"
              onClick={() => onToggleSeasonTracked(!seasonTracked)}
              title={seasonTracked ? `Stop monitoring all ${label.toLowerCase()} episodes` : `Monitor all ${label.toLowerCase()} episodes for new releases`}
              className={seasonBtn}
            >
              <Check className="size-3" /> <span className="max-sm:sr-only">{seasonTracked ? "Unmonitor" : "Monitor"}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onOpenSearch({ season: n })}
            title={`Browse and manually pick a ${label.toLowerCase()} release`}
            className={seasonBtn}
          >
            <SearchIcon className="size-3" /> <span className="max-sm:sr-only">Browse</span>
          </button>
          <button
            type="button"
            onClick={onAutoGrabSeason}
            disabled={grabbingSeason}
            title={`Automatically search and download the best matching ${label.toLowerCase()} release`}
            className={seasonBtn}
          >
            {grabbingSeason ? <Loader2Icon className="size-3 animate-spin" /> : <DownloadIcon className="size-3" />}
            <span className="max-sm:sr-only">Auto</span>
          </button>
        </div>
      </div>
      {expanded && (
        eps.length === 0 ? (
          <p className="px-4 pb-3 pl-11 text-xs text-muted-foreground">
            {filter === "available" ? "No available episodes in this season." : "No missing episodes in this season."}
          </p>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {eps.map((ep) => (
              <EpisodeRow
                key={`${ep.season}-${ep.episode}`}
                episode={ep}
                columns={columns}
                grabbing={grabTarget === `ep:${ep.season}:${ep.episode}`}
                onToggleTracked={(tracked) => episodeHandlers.toggleTracked(ep, tracked)}
                onChangeSearchMode={(mode) => episodeHandlers.changeSearchMode(ep, mode)}
                onAutoGrab={() => episodeHandlers.autoGrabEpisode(ep)}
                onOpenSearch={() => onOpenSearch({ season: ep.season, episode: ep.episode })}
              />
            ))}
          </div>
        )
      )}
    </div>
  );
}

/** Unified episode list: all seasons, latest first, collapsible. */
export function SeasonList(props: {
  sections: SeasonSection[];
  collapsed: Record<number, boolean>;
  forceExpand: boolean;
  filter: EpisodeFilter;
  columns: ColumnDef[];
  grabTarget: GrabTarget;
  onToggleCollapsed: (season: number) => void;
  onToggleSeasonTracked: (season: number, tracked: boolean) => void;
  onAutoGrabSeason: (season: number) => void;
  onOpenSearch: (t: SearchTarget) => void;
  toggleTracked: (ep: EpisodeData, tracked: boolean) => void;
  changeSearchMode: (ep: EpisodeData, mode: "auto" | "interactive") => void;
  autoGrabEpisode: (ep: EpisodeData) => void;
}) {
  const episodeHandlers = { toggleTracked: props.toggleTracked, changeSearchMode: props.changeSearchMode, autoGrabEpisode: props.autoGrabEpisode };
  return (
    <div className="md:overflow-y-auto">
      {props.sections.map((section) => {
        const n = section.season.seasonNumber;
        return (
          <SeasonBlock
            key={n}
            section={section}
            expanded={props.forceExpand || !props.collapsed[n]}
            filter={props.filter}
            columns={props.columns}
            grabTarget={props.grabTarget}
            onToggleCollapsed={() => props.onToggleCollapsed(n)}
            onToggleSeasonTracked={(tracked) => props.onToggleSeasonTracked(n, tracked)}
            onOpenSearch={props.onOpenSearch}
            onAutoGrabSeason={() => props.onAutoGrabSeason(n)}
            episodeHandlers={episodeHandlers}
          />
        );
      })}
    </div>
  );
}
