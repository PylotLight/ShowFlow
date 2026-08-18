import { CalendarDaysIcon, CheckIcon, ChevronRightIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@frontend/components/ui/button";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { EpisodeChip } from "@frontend/components/showflow/EpisodeChip";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";
import type { EpisodeFileInfo } from "@frontend/components/showflow/EpisodeRow";
import { MediaBadges } from "@frontend/components/showflow/MediaBadges";
import { cn } from "@frontend/lib/utils";

export interface UpcomingEpisode {
  showTitle: string;
  episodeTitle?: string;
  season: number;
  episode: number;
  airDate: string;
  filePath: string | null;
  file?: EpisodeFileInfo | null;
}

function isPast(airDate: string): boolean {
  return new Date(airDate).getTime() <= Date.now();
}

function formatNowTime(): string {
  return new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
}

function AgendaList({
  upcoming,
  shows,
  onSelectShow,
  onExpand,
}: {
  upcoming: UpcomingEpisode[];
  shows: ShowSummary[];
  onSelectShow: (show: ShowSummary) => void;
  onExpand: () => void;
}) {
  // Helper to group episodes by day
  const grouped = React.useMemo(() => {
    const todayStr = new Date().toDateString();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toDateString();

    const sections: [{ title: string; items: UpcomingEpisode[] }, { title: string; items: UpcomingEpisode[] }, { title: string; items: UpcomingEpisode[] }] = [
      { title: "Today", items: [] },
      { title: "Tomorrow", items: [] },
      { title: "Later this week", items: [] },
    ];

    for (const ep of upcoming) {
      const epDate = new Date(ep.airDate);
      const epDateStr = epDate.toDateString();

      if (epDateStr === todayStr) {
        sections[0].items.push(ep);
      } else if (epDateStr === tomorrowStr) {
        sections[1].items.push(ep);
      } else {
        sections[2].items.push(ep);
      }
    }

    return sections
      .filter((s) => s.items.length > 0)
      .map((s) => ({ ...s, items: [...s.items].sort((a, b) => new Date(a.airDate).getTime() - new Date(b.airDate).getTime()) }));
  }, [upcoming]);

  const handleSelectEpisodeShow = (showTitle: string) => {
    const match = shows.find((s) => s.title.toLowerCase() === showTitle.toLowerCase());
    if (match) {
      onSelectShow(match);
    }
  };

  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (scrollRef.current) {
      const nowLine = scrollRef.current.querySelector('[data-now-line="true"]');
      if (nowLine) {
        nowLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [upcoming]);

  return (
    <GlassPanel className="flex flex-col overflow-hidden h-full">
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
        <div className="flex items-center gap-2">
          <CalendarDaysIcon className="size-4 text-signal" />
          <span className="font-display text-sm font-semibold tracking-wide">Airing Agenda / Forecast</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onExpand} className="text-muted-foreground h-7 px-2 text-xs">
          Calendar <ChevronRightIcon className="size-3.5" />
        </Button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {upcoming.length === 0 ? (
          <div className="text-muted-foreground py-12 text-center text-xs">Nothing airing in the next 7 days.</div>
        ) : (
          grouped.map((group) => {
            let groupBorderColor = "border-l-white/10";
            let groupTitleColor = "text-white/40";
            
            if (group.title === "Today") {
              groupBorderColor = "border-l-signal";
              groupTitleColor = "text-signal";
            } else if (group.title === "Tomorrow") {
              groupBorderColor = "border-l-accent-amber";
              groupTitleColor = "text-accent-amber";
            }

            const items = group.items;
            const isToday = group.title === "Today";
            const nowLineIdx = isToday ? items.findIndex((ep) => !isPast(ep.airDate)) : -1;
            const hasNowLine = nowLineIdx > 0;

            return (
              <div key={group.title} className="space-y-2">
                <h3 className={`font-mono text-[9px] font-bold uppercase tracking-widest ${groupTitleColor}`}>
                  // {group.title}
                </h3>
                <div className="grid grid-cols-1 gap-1.5">
                  {items.map((ep, i) => {
                    const hasShow = shows.some((s) => s.title.toLowerCase() === ep.showTitle.toLowerCase());
                    const available = !!ep.filePath;
                    const past = isPast(ep.airDate);

                    return (
                      <React.Fragment key={i}>
                        {hasNowLine && i === nowLineIdx && (
                          <div data-now-line="true" className="relative flex items-center py-1.5">
                            <div className="absolute inset-0 flex items-center">
                              <div className="w-full border-t border-signal/40" />
                            </div>
                            <div className="relative flex items-center gap-2">
                              <span className="inline-flex items-center gap-1.5 rounded-full bg-signal/10 px-2.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-signal border border-signal/20">
                                NOW — {formatNowTime()}
                              </span>
                            </div>
                          </div>
                        )}
                        <button
                          type="button"
                          disabled={!hasShow}
                          onClick={() => handleSelectEpisodeShow(ep.showTitle)}
                          className={cn(
                            "group flex items-center justify-between gap-3 rounded-lg border border-l-2 border-white/0 bg-white/[0.01] px-3 py-2.5 text-left transition-all",
                            past && isToday ? "border-l-white/5 opacity-60 hover:opacity-80" : groupBorderColor,
                            hasShow ? "hover:border-white/5 hover:bg-white/[0.03] cursor-pointer" : "cursor-default",
                          )}
                        >
                          <div className="flex min-w-0 flex-1 flex-col">
                            <span className={cn(
                              "truncate text-xs font-semibold",
                              hasShow ? "text-white group-hover:text-signal" : "text-white/80",
                              available && "text-signal/80",
                            )}>
                              {ep.showTitle}
                            </span>
                            {ep.episodeTitle && (
                              <span className="truncate font-mono text-[9px] text-white/40 mt-0.5">
                                {ep.episodeTitle}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {available && (
                              <MediaBadges media={ep.file?.media} max={3} />
                            )}
                            {available && (
                              <span className="flex items-center gap-1 rounded-full bg-signal/10 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider text-signal border border-signal/15">
                                <CheckIcon className="size-2.5" strokeWidth={3} />
                                Available
                              </span>
                            )}
                            <span className="font-mono text-[9px] text-white/30">
                              {new Date(ep.airDate).toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                            <EpisodeChip season={ep.season} episode={ep.episode} state={available ? "tracked" : past ? "none" : "airing"} className="shrink-0" />
                          </div>
                        </button>
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
    </GlassPanel>
  );
}

export { AgendaList };
