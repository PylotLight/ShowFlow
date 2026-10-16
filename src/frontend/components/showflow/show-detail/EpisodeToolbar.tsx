import { DropdownMenu } from "radix-ui";
import { Check, Columns2 } from "lucide-react";
import * as React from "react";

import type { ColumnDef } from "@frontend/components/showflow/EpisodeRow";

import { focusRing } from "./format";
import type { EpisodeFilter } from "./types";

/** Availability summary, all/available/missing filter and column picker. */
export function EpisodeToolbar({ available, total, filter, onFilter, columns, onToggleColumn }: {
  available: number;
  total: number;
  filter: EpisodeFilter;
  onFilter: (f: EpisodeFilter) => void;
  columns: ColumnDef[];
  onToggleColumn: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 shrink-0">
      {total > 0 && (
        <>
          <span className="font-mono text-xs whitespace-nowrap" title={`${available} of ${total} episodes available`}>
            <span className="text-signal">{available}</span>
            <span className="text-muted-foreground">/{total} available</span>
          </span>
          <div className="hidden sm:block w-20 h-1.5 rounded-full bg-white/5 overflow-hidden" aria-hidden>
            <div className="h-full rounded-full bg-signal transition-all duration-300" style={{ width: `${(available / total) * 100}%` }} />
          </div>
        </>
      )}
      <div className="ml-auto flex items-center gap-2">
        <div role="radiogroup" aria-label="Filter episodes" className="flex items-center gap-0.5 bg-white/[0.04] rounded-full p-0.5 border border-white/5">
          {(["all", "available", "missing"] as const).map((f) => (
            <button
              key={f}
              role="radio"
              aria-checked={filter === f}
              onClick={() => onFilter(f)}
              className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider transition-all pointer-coarse:px-3 pointer-coarse:py-2 ${focusRing} ${
                filter === f ? "bg-signal/15 text-signal font-semibold" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" aria-label="Column settings" className={`rounded-md p-1.5 text-muted-foreground hover:text-foreground transition-colors pointer-coarse:p-2.5 ${focusRing}`}>
              <Columns2 className="size-4" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={6} className="z-50 w-44 rounded-lg border border-white/10 bg-[#15181f] p-1.5 shadow-xl">
              <DropdownMenu.Label className="px-2 py-1 text-caption font-mono uppercase tracking-wider text-muted-foreground">Columns</DropdownMenu.Label>
              {columns.map((col) => (
                <DropdownMenu.CheckboxItem
                  key={col.id}
                  checked={col.visible}
                  onCheckedChange={() => onToggleColumn(col.id)}
                  onSelect={(e) => e.preventDefault()}
                  className="flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground/85 outline-none data-[highlighted]:bg-white/[0.06]"
                >
                  <span className="flex size-3.5 items-center justify-center rounded border border-white/20 bg-white/5">
                    <DropdownMenu.ItemIndicator><Check className="size-3 text-signal" /></DropdownMenu.ItemIndicator>
                  </span>
                  {col.label}
                </DropdownMenu.CheckboxItem>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>
  );
}
