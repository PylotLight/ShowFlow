import { ChevronLeft, ChevronRight, Clock } from "lucide-react";
import * as React from "react";

import { PosterImage } from "@frontend/components/showflow/PosterImage";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";
import { formatDelayMinutes } from "@frontend/lib/airtime";
import { useCompact } from "@frontend/lib/useCompact";

import { focusRing } from "./format";
import type { SeasonStat } from "./types";

/** Alternate backdrops the provider knows about, persisted via PATCH config.backdropIndex. */
function useBackdrops(showId: string) {
  const [options, setOptions] = React.useState<{ index: number; url: string; thumb?: string }[]>([]);
  const [index, setIndex] = React.useState(0);
  // Blur-up: the full hero fades in over the tiny variant once decoded.
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    setOptions([]);
    setIndex(0);
    setLoaded(false);
    fetch(`/api/shows/${showId}/images/backdrops`).then(r => r.json()).then(data => {
      setOptions(Array.isArray(data.options) ? data.options : []);
      setIndex(typeof data.selected === "number" ? data.selected : 0);
    }).catch(() => {});
  }, [showId]);

  function cycle(dir: 1 | -1) {
    if (options.length < 2) return;
    const next = (index + dir + options.length) % options.length;
    setIndex(next);
    setLoaded(false);
    fetch(`/api/shows/${showId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { backdropIndex: next } }),
    }).catch(() => {});
  }

  return { options, index, loaded, setLoaded, cycle };
}

/**
 * Fixed page backdrop + hero banner. Sonarr-style melt: the art dissolves
 * into the page background instead of ending at a hard edge. Poster, title,
 * meta line and the action bar (children) sit on the crisp row below the fade.
 */
export function ShowHero({ show, modal, seasons, releaseDelayMinutes, children }: {
  show: ShowSummary;
  modal: boolean;
  seasons: SeasonStat[] | null;
  releaseDelayMinutes: number | null;
  children?: React.ReactNode;
}) {
  const bd = useBackdrops(show.id);
  const compact = useCompact();
  const hideOnError = (e: React.SyntheticEvent<HTMLImageElement>) => { e.currentTarget.style.display = "none"; };
  const navBtn = `absolute top-1/2 -translate-y-1/2 z-20 rounded-full bg-black/50 p-1.5 text-white/80 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 pointer-coarse:p-2.5 transition-opacity hover:bg-black/70 hover:text-white ${focusRing}`;

  return (
    <>
      {/* Backdrop background */}
      <div className={`pointer-events-none ${modal ? "absolute" : "fixed"} inset-0 z-0 overflow-hidden`}>
        <img
          src={`/api/shows/${show.id}/images/backdrop`}
          alt=""
          aria-hidden
          className="size-full object-cover opacity-[0.18] scale-110"
          onError={hideOnError}
        />
        <div className="absolute inset-0" style={{
          background: `
            radial-gradient(circle at 26% 3%, color-mix(in srgb, var(--signal) 20%, transparent), transparent 40%),
            radial-gradient(circle at 88% 83%, rgba(103,78,124,.14), transparent 35%),
            linear-gradient(to bottom, rgba(13,16,21,.3) 0%, rgba(13,16,21,.92) 60%, rgba(13,16,21,1) 100%)
          `,
        }} />
      </div>

      {compact ? (
        /* Phone / mini window: a short backdrop band with the poster
           overlapping its bottom edge, title + meta beside it, then the
           action row, so the episode list starts above the fold instead of
           under a 420px banner. */
        <section className="relative z-10 w-full shrink-0">
          <div
            className="relative h-28 w-full overflow-hidden"
            style={{
              maskImage: "linear-gradient(to bottom, black 0%, black 45%, transparent 100%)",
              WebkitMaskImage: "linear-gradient(to bottom, black 0%, black 45%, transparent 100%)",
            }}
          >
            <img
              src={`/api/shows/${show.id}/images/backdrop?index=${bd.index}`}
              alt=""
              aria-hidden
              fetchPriority="high"
              decoding="async"
              onLoad={() => bd.setLoaded(true)}
              onError={hideOnError}
              className={`absolute inset-0 size-full object-cover object-[center_30%] transition-opacity duration-500 ${bd.loaded ? "opacity-90" : "opacity-0"}`}
            />
          </div>
          <div className="-mt-16 flex items-end gap-3 px-3">
            <div className="w-[76px] shrink-0 overflow-hidden rounded-lg shadow-xl ring-1 ring-white/10">
              <PosterImage showId={show.id} alt={show.title} size="card" className="w-full aspect-[2/3]" />
            </div>
            <div className="min-w-0 flex-1 pb-0.5 [text-shadow:0_1px_8px_rgba(0,0,0,0.8)]">
              <h1 className="font-display text-xl font-semibold leading-tight tracking-wide text-white line-clamp-2" title={show.title}>
                {show.title}
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[11px] text-foreground/70">
                <span className="uppercase tracking-wider">{show.providerType}</span>
                {seasons && (
                  <>
                    <span className="text-white/30" aria-hidden>·</span>
                    <span>{seasons.length} season{seasons.length !== 1 ? "s" : ""}</span>
                    <span className="text-white/30" aria-hidden>·</span>
                    <span>{seasons.reduce((a, s) => a + s.episodeCount, 0)} eps</span>
                  </>
                )}
                {releaseDelayMinutes != null && (
                  <span className="inline-flex items-center gap-1 text-accent-amber" title="Learned release delay: expected minutes after air time that releases typically appear for this show">
                    <Clock className="size-3" />
                    ~{formatDelayMinutes(releaseDelayMinutes)} after air
                  </span>
                )}
              </div>
            </div>
          </div>
          {children && <div className="px-3 pt-3">{children}</div>}
        </section>
      ) : (
      <section className="show-hero-banner group relative z-10 w-full h-[420px] md:h-[540px] shrink-0">
        <div
          className="absolute inset-0"
          style={{
            maskImage: "linear-gradient(to bottom, black 0%, black 62%, transparent 98%)",
            WebkitMaskImage: "linear-gradient(to bottom, black 0%, black 62%, transparent 98%)",
          }}
        >
          <img
            src={`/api/shows/${show.id}/images/backdrop?index=${bd.index}&thumb=1`}
            alt=""
            aria-hidden
            decoding="async"
            className="absolute inset-0 size-full object-cover object-[center_35%] blur-md scale-105"
            onError={hideOnError}
          />
          <img
            src={`/api/shows/${show.id}/images/backdrop?index=${bd.index}`}
            alt=""
            aria-hidden
            fetchPriority="high"
            decoding="async"
            onLoad={() => bd.setLoaded(true)}
            onError={hideOnError}
            className={`absolute inset-0 size-full object-cover object-[center_35%] transition-opacity duration-500 ${bd.loaded ? "opacity-100" : "opacity-0"}`}
          />
          <div className="absolute inset-0" style={{
            background: `
              radial-gradient(circle at 26% 3%, color-mix(in srgb, var(--signal) 25%, transparent), transparent 40%),
              linear-gradient(to bottom, rgba(13,16,21,.15) 0%, rgba(13,16,21,.35) 55%, rgba(13,16,21,.85) 100%)
            `,
          }} />
        </div>
        {bd.options.length > 1 && (
          <>
            {/* Top-right so the action bar row never covers it. */}
            <span className="absolute top-3 right-3 z-20 rounded-full bg-black/50 px-2 py-0.5 font-mono text-[11px] text-white/80">
              {bd.index + 1}/{bd.options.length}
            </span>
            <button onClick={() => bd.cycle(-1)} className={`${navBtn} left-2`} aria-label="Previous backdrop">
              <ChevronLeft className="size-4" />
            </button>
            <button onClick={() => bd.cycle(1)} className={`${navBtn} right-2`} aria-label="Next backdrop">
              <ChevronRight className="size-4" />
            </button>
          </>
        )}
        <div className="absolute bottom-0 left-0 right-0 flex flex-col gap-3 px-4 md:px-8 pb-4 md:pb-6">
         <div className="flex items-end gap-4 md:gap-6">
          <div className="shrink-0 w-[96px] md:w-[140px] rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10">
            <PosterImage showId={show.id} alt={show.title} size="card" className="w-full aspect-[2/3]" />
          </div>
          <div className="min-w-0 flex-1 pb-1">
            <div className="[text-shadow:0_2px_12px_rgba(0,0,0,0.85)]">
              <h1 className="font-display text-2xl md:text-4xl font-semibold tracking-wide text-white leading-tight">
                {show.title}
              </h1>
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-2 text-xs font-mono text-foreground/75">
                <span className="uppercase tracking-wider">{show.providerType}</span>
                {seasons && (
                  <>
                    <span className="text-white/30" aria-hidden>·</span>
                    <span>{seasons.length} season{seasons.length !== 1 ? "s" : ""}</span>
                    <span className="text-white/30" aria-hidden>·</span>
                    <span>{seasons.reduce((a, s) => a + s.episodeCount, 0)} episodes</span>
                  </>
                )}
                {releaseDelayMinutes != null && (
                  <>
                    <span className="text-white/30" aria-hidden>·</span>
                    <span className="inline-flex items-center gap-1 text-accent-amber" title="Learned release delay: expected minutes after air time that releases typically appear for this show">
                      <Clock className="size-3" />
                      releases ~{formatDelayMinutes(releaseDelayMinutes)} after air
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
         </div>
          {children && <div className="md:pl-[164px]">{children}</div>}
        </div>
      </section>
      )}
    </>
  );
}
