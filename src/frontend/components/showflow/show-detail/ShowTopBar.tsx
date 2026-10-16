import { ChevronLeft, Maximize2, Minimize2, XIcon } from "lucide-react";
import * as React from "react";

import { focusRing } from "./format";

/** Sticky slim bar: back, breadcrumb title, expand/close. Action results are toasts. */
export function ShowTopBar({ title, onBack, modal, onToggleExpand, expanded }: {
  title: string;
  onBack: () => void;
  modal: boolean;
  onToggleExpand?: () => void;
  expanded?: boolean;
}) {
  const iconBtn = `text-muted-foreground hover:text-foreground transition-colors rounded-md p-1 ${focusRing}`;
  return (
    <header
      className="sticky top-0 z-20 flex h-11 items-center gap-x-2 px-1.5 md:h-auto md:gap-x-3 md:px-6 py-2 border-b border-white/5 shrink-0"
      style={{ backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", background: "rgba(13,16,21,.75)" }}
    >
      <button onClick={onBack} aria-label="Back" className={`text-muted-foreground hover:text-foreground text-sm flex items-center gap-1.5 transition-colors rounded-md max-md:size-8 max-md:justify-center ${focusRing}`}>
        <ChevronLeft className="size-5 md:size-4" />
        <span className="max-md:hidden">Back</span>
      </button>
      <span className="text-white/20 text-xs max-md:hidden" aria-hidden>/</span>
      <span className="text-foreground text-sm font-medium truncate">{title}</span>

      <span className="min-w-0 flex-1" />

      <div className="ml-auto flex items-center gap-1.5 shrink-0">
        {onToggleExpand && (
          <button onClick={onToggleExpand} className={`${iconBtn} max-md:hidden`} title={expanded ? "Minimize" : "Expand"} aria-label={expanded ? "Minimize" : "Expand"}>
            {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
        )}
        {modal && (
          <button onClick={onBack} className={`${iconBtn} max-md:p-1.5`} aria-label="Close">
            <XIcon className="size-4 max-md:size-5" />
          </button>
        )}
      </div>
    </header>
  );
}
