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
  const [loaded, setLoaded] = React.useState(() => seenSrcs.has(src));

  return (
    <div className={cn("relative overflow-hidden bg-muted", className)}>
      {!loaded && <Skeleton className="absolute inset-0" />}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => { seenSrcs.add(src); setLoaded(true); }}
        className={cn(
          "size-full object-cover transition-opacity duration-300",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

export { PosterImage };
