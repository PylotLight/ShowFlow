import { SearchIcon, SettingsIcon } from "lucide-react";
import * as React from "react";

import { Input } from "@frontend/components/ui/input";
import { Button } from "@frontend/components/ui/button";
import { AddShowDialog } from "@frontend/components/showflow/AddShowDialog";
import { cn } from "@frontend/lib/utils";

export type ViewName = "home" | "library" | "settings";

const VIEWS: { id: ViewName; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "library", label: "Library" },
];

function AppHeader({
  view,
  onViewChange,
  query,
  onQueryChange,
  onShowAdded,
}: {
  view: ViewName;
  onViewChange: (v: ViewName) => void;
  query: string;
  onQueryChange: (q: string) => void;
  onShowAdded: () => void;
}) {
  return (
    <header className="glass-panel sticky top-0 z-20 flex items-center gap-2 rounded-none border-x-0 border-t-0 px-4 py-3 sm:gap-4 sm:px-6 sm:py-4">
      <h1 className="font-display shrink-0 text-xl font-semibold tracking-wide sm:text-2xl">ShowFlow</h1>

      <nav className="flex shrink-0 items-center gap-1 rounded-full bg-white/5 p-1">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => onViewChange(v.id)}
            className={cn(
              "rounded-full px-3 py-1 font-mono text-xs tracking-wider uppercase transition-colors",
              view === v.id ? "bg-signal text-signal-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v.label}
          </button>
        ))}
      </nav>

      {view === "library" && (
        <div className="relative min-w-0 max-w-sm flex-1">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            placeholder="Search your library..."
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            className="pl-9"
          />
        </div>
      )}

      <div className="flex-1" />
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => onViewChange("settings")}
        className={view === "settings" ? "text-signal" : "text-muted-foreground"}
        title="Settings"
      >
        <SettingsIcon className="size-4" />
      </Button>
      <AddShowDialog onAdded={onShowAdded} />
    </header>
  );
}

export { AppHeader };
