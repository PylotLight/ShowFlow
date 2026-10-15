import { LayersIcon } from "lucide-react";
import * as React from "react";

import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { PipelineAttention } from "@frontend/components/showflow/PipelineAttention";
import { PipelineKanban } from "@frontend/components/showflow/PipelineKanban";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";
import { cn } from "@frontend/lib/utils";

const TABS = [
  { id: "attention", label: "Needs attention" },
  { id: "lanes", label: "Lanes" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/**
 * Pipeline page: "Needs attention" (why each unfinished episode hasn't been
 * pulled, with a one-click fix) by default; the old lanes as a secondary tab.
 */
function PipelinePage({ onSelectShow }: { onSelectShow?: (show: ShowSummary | null) => void }) {
  const [tab, setTab] = React.useState<TabId>("attention");
  const [total, setTotal] = React.useState<number | null>(null);

  return (
    <div className="flex flex-col h-full gap-4">
      <GlassPanel className="flex flex-wrap items-center justify-between gap-3 p-4 shrink-0">
        <div className="flex items-center gap-3">
          <LayersIcon className="size-5 text-signal" aria-hidden />
          <div>
            <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-signal">// Pipeline</span>
            <h2 className="font-display text-2xl font-bold text-white mt-0.5">
              {tab === "attention"
                ? `${total ?? "—"} episode${total === 1 ? "" : "s"} not pulled yet`
                : "In-flight lanes"}
            </h2>
          </div>
        </div>
        <div role="tablist" aria-label="Pipeline view" className="flex items-center gap-1">
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "rounded-full px-3 py-1 font-mono text-[11px] uppercase tracking-wide transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal",
                tab === t.id
                  ? "bg-signal/15 text-signal font-semibold"
                  : "text-muted-foreground hover:text-foreground bg-white/[0.03] hover:bg-white/[0.06]",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </GlassPanel>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === "attention"
          ? <PipelineAttention onTotal={setTotal} />
          : <PipelineKanban embedded onSelectShow={onSelectShow} />}
      </div>
    </div>
  );
}

export { PipelinePage };
