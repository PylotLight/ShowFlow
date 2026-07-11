import * as React from "react";

import { cn } from "@frontend/lib/utils";

/**
 * The one wrapper every "monitor" surface in the app goes through, so the
 * blur/border/background treatment stays consistent instead of being
 * re-typed on every card, banner, and rail.
 */
function GlassPanel({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="glass-panel" className={cn("glass-panel rounded-xl", className)} {...props} />;
}

export { GlassPanel };
