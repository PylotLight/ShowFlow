import { Maximize2, Minimize2, XIcon } from "lucide-react";
import * as React from "react";

import { ShowDetail } from "@frontend/components/showflow/ShowDetail";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";
import { cn } from "@frontend/lib/utils";

function ShowDetailDialog({
  show,
  onClose,
}: {
  show: ShowSummary;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (expanded) {
          setExpanded(false);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener("keydown", handleEscape);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "";
    };
  }, [onClose, expanded]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      <div
        className={cn(
          "relative z-10 flex flex-col overflow-hidden glass-panel shadow-2xl transition-all duration-300 ease-out",
          expanded
            ? "fixed inset-3 md:inset-6 rounded-2xl"
            : "w-[92vw] max-w-6xl h-[80vh] max-h-[85vh] rounded-2xl"
        )}
      >
        <div className="flex-1 flex flex-col min-h-0">
          <ShowDetail show={show} onBack={onClose} modal onToggleExpand={() => setExpanded(v => !v)} expanded={expanded} />
        </div>
      </div>
    </div>
  );
}

export { ShowDetailDialog };
