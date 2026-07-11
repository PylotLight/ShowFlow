import * as React from "react";

import { cn } from "@frontend/lib/utils";
import { Skeleton } from "@frontend/components/ui/skeleton";

function PosterImage({
  source,
  id,
  showId,
  alt,
  className,
}: {
  source?: string;
  id?: string;
  showId?: string;
  alt: string;
  className?: string;
}) {
  const [loaded, setLoaded] = React.useState(false);

  let src: string;
  if (showId) {
    src = `/api/shows/${showId}/images/poster`;
  } else if (source && id) {
    src = `/api/images/poster/${source}/${id}`;
  } else {
    src = '';
  }

  return (
    <div className={cn("relative overflow-hidden bg-muted", className)}>
      {!loaded && <Skeleton className="absolute inset-0" />}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        className={cn(
          "size-full object-cover transition-opacity duration-300",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

export { PosterImage };
