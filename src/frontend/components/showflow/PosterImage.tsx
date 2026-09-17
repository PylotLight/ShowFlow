import * as React from "react";

import { cn } from "@frontend/lib/utils";
import { Skeleton } from "@frontend/components/ui/skeleton";

/** Poster URLs that have fully loaded at least once this session. */
const seenSrcs = new Set<string>();

function PosterImage({
  source,
  id,
  showId,
  alt,
  className,
  size,
}: {
  source?: string;
  id?: string;
  showId?: string;
  alt: string;
  className?: string;
  /** "card" serves the lightweight variant (TMDB w342 / AniList medium) —
   *  plenty for grid cells and agenda thumbs at a fraction of the bytes. */
  size?: "card" | "full";
}) {
  let src: string;
  if (showId) {
    src = `/api/shows/${showId}/images/poster${size === "card" ? "?size=card" : ""}`;
  } else if (source && id) {
    src = `/api/images/poster/${source}/${id}`;
  } else {
    src = '';
  }

  // Session-level seen cache: a remount (filter change, tab switch, search
  // keystroke re-render) must not flash the skeleton for an image the
  // browser already has — start revealed and let the cached bytes show
  // through instantly.
  const [currentSrc, setCurrentSrc] = React.useState(src);
  const [loaded, setLoaded] = React.useState(() => seenSrcs.has(src));
  // `faded` lags `loaded` by the fade duration so the skeleton stays
  // mounted *under* the fading-in image — the cut happens only once the
  // image is fully opaque, so there's no flash of bare background.
  const [faded, setFaded] = React.useState(() => seenSrcs.has(src));
  if (currentSrc !== src) {
    setCurrentSrc(src);
    setLoaded(seenSrcs.has(src));
    setFaded(seenSrcs.has(src));
  }
  React.useEffect(() => {
    if (!loaded || faded) return;
    const t = setTimeout(() => setFaded(true), 500);
    return () => clearTimeout(t);
  }, [loaded, faded]);
  // Posters serve DB-only now; a 404 means the background warmer hasn't
  // finished yet (issues #31). Retry the same URL a few times — no cache
  // buster needed since error responses aren't cached — then give up and
  // render the bare container (cards already show the title text).
  const [attempt, setAttempt] = React.useState(0);
  const [failed, setFailed] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const trySrc = attempt > 0 ? `${src}${src.includes("?") ? "&" : "?"}warm=${attempt}` : src;

  if (failed || !src) {
    return <div className={cn("relative overflow-hidden bg-muted", className)} />;
  }

  return (
    <div className={cn("relative overflow-hidden bg-muted", className)}>
      {!faded && <Skeleton className="absolute inset-0" />}
      <img
        src={trySrc}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => { seenSrcs.add(src); setLoaded(true); }}
        onError={() => {
          if (attempt < 4) {
            timerRef.current = setTimeout(() => setAttempt(a => a + 1), 4000);
          } else {
            setFailed(true);
          }
        }}
        className={cn(
          "size-full object-cover transition-all duration-500 ease-out",
          loaded ? "opacity-100 scale-100" : "opacity-0 motion-safe:scale-[1.04]",
        )}
      />
    </div>
  );
}

export { PosterImage };
