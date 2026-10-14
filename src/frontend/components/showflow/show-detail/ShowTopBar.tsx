import { ChevronLeft, Maximize2, Minimize2, XIcon } from "lucide-react";
import * as React from "react";

import { focusRing } from "./format";

/** Sticky slim bar: back, breadcrumb title, transient status, expand/close. */
export function ShowTopBar({ title, status, onBack, modal, onToggleExpand, expanded }: {
  title: string;
  status: { ok: boolean; text: string } | null;
  onBack: () => void;
  modal: boolean;
  onToggleExpand?: () => void;
  expanded?: boolean;
}) {
  const iconBtn = `text-muted-foreground hover:text-foreground transition-colors rounded-md p-1 ${focusRing}`;
  return (
    <header
      className="sticky top-0 z-20 flex items-center gap-x-3 px-3 md:px-6 py-2 border-b border-white/5 shrink-0"
      style={{ backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", background: "rgba(13,16,21,.75)" }}
    >
      <button onClick={onBack} className={`text-muted-foreground hover:text-foreground text-sm flex items-center gap-1.5 transition-colors rounded-md ${focusRing}`}>
        <ChevronLeft className="size-4" />
        Back
      </button>
      <span className="text-white/20 text-xs" aria-hidden>/</span>
      <span className="text-foreground text-sm font-medium truncate">{title}</span>

      <span role="status" aria-live="polite" className="min-w-0 flex-1 truncate">
        {status && (
          <span className={`ml-1 text-xs ${status.ok ? "text-emerald-400" : "text-red-400"}`}>{status.text}</span>
        )}
      </span>

      <div className="ml-auto flex items-center gap-1.5 shrink-0">
        {onToggleExpand && (
          <button onClick={onToggleExpand} className={iconBtn} title={expanded ? "Minimize" : "Expand"} aria-label={expanded ? "Minimize" : "Expand"}>
            {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
        )}
        {modal && (
          <button onClick={onBack} className={iconBtn} aria-label="Close">
            <XIcon className="size-4" />
          </button>
        )}
      </div>
    </header>
  );
}
