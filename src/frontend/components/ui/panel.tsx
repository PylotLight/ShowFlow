import { cn } from "@frontend/lib/utils";
import * as React from "react";

/**
 * A width-safe wrapper for dialog / panel content. Long titles, filenames and
 * other unconstrained text will truncate with an ellipsis instead of spilling
 * outside the panel.
 */
function Panel({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "max-w-[calc(100vw-2rem)] min-w-0 overflow-hidden rounded-xl",
        className,
      )}
      {...props}
    />
  );
}

export { Panel };
