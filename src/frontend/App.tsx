import * as React from "react";

import { Sidebar, type NavItem } from "@frontend/components/showflow/Sidebar";
import { Dashboard } from "@frontend/components/showflow/Dashboard";
import { CalendarView } from "@frontend/components/showflow/CalendarView";
import { Library } from "@frontend/components/Library";
import { ShowDetailDialog } from "@frontend/components/showflow/ShowDetailDialog";
import { AddShowDialog } from "@frontend/components/showflow/AddShowDialog";
import { SettingsPage } from "@frontend/components/showflow/SettingsPage";
import { DebugPage } from "@frontend/components/showflow/DebugPage";
import { Input } from "@frontend/components/ui/input";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";
import { SearchIcon } from "lucide-react";
import { loadTheme, applyTheme } from "@frontend/lib/theme";
import "./styles/index.css";

export function App() {
  const [activeNav, setActiveNav] = React.useState<NavItem>("dashboard");
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<ShowSummary | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  React.useEffect(() => {
    loadTheme().then((theme) => {
      applyTheme(theme);
    });
  }, []);

  const [backdropUrl, setBackdropUrl] = React.useState("");

  function selectShow(show: ShowSummary | null) {
    if (show) {
      setSelected(show);
    }
  }

  return (
    <div className="app-background flex min-h-screen text-foreground pb-14 md:pb-0">
      {/* Global backdrop for library view */}
      {activeNav === "library" && backdropUrl && (
        <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none">
          <img
            key={backdropUrl}
            src={backdropUrl}
            alt=""
            className="absolute inset-0 size-full object-cover animate-[fadeIn_1.5s_ease-in-out]"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
          <div className="absolute inset-0 bg-gradient-to-b from-background/90 via-background/60 to-background" />
        </div>
      )}

      {/* Navigation Sidebar */}
      <Sidebar activeItem={activeNav} onChange={(item) => { setActiveNav(item); setSelected(null); }} />

      {/* Main Viewport Workspace */}
      <div className="flex-1 flex flex-col min-w-0 relative z-10">
        {/* Main Content Header — hidden when view has its own header */}
        {activeNav !== "settings" && activeNav !== "agenda" && (
          <header className="flex h-16 items-center justify-between border-b border-white/5 px-6 py-4">
            <div className="flex items-center gap-4">
              <h1 className="font-display text-2xl font-bold tracking-tight text-white capitalize">
                {activeNav}
              </h1>
            </div>

            <div className="flex items-center gap-4">
              {/* Search Input */}
              {activeNav === "library" && (
                <div className="relative w-48 sm:w-64">
                  <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
                  <Input
                    placeholder="Search library..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="pl-8 h-8 text-xs bg-white/5 border-white/5 focus:border-signal/50 focus:ring-1 focus:ring-signal/30"
                  />
                </div>
              )}

              {/* Add Series Button */}
              <AddShowDialog onAdded={() => setRefreshKey((k) => k + 1)} />
            </div>
          </header>
        )}

        {/* Dynamic Content Views */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeNav === "dashboard" ? (
            <div className="h-full flex flex-col">
              <Dashboard
                key={refreshKey}
                onSelectShow={selectShow}
                onShowCalendar={() => setActiveNav("agenda")}
              />
            </div>
          ) : activeNav === "agenda" ? (
            <CalendarView
              key={refreshKey}
              onSelectShow={selectShow}
            />
          ) : activeNav === "library" ? (
            <Library
              key={refreshKey}
              query={query}
              onSelectShow={selectShow}
              onBackdropChange={setBackdropUrl}
            />
          ) : activeNav === "settings" ? (
            <SettingsPage onDone={() => setActiveNav("dashboard")} />
          ) : (
            <div className="glass-plane rounded-xl p-8 text-center text-muted-foreground">
              <h3 className="font-display text-lg font-bold text-white mb-2 uppercase">
                {activeNav} Section
              </h3>
              <p className="font-mono text-caption">
                Work-in-progress operational workspace for {activeNav}.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Show Detail Modal — renders on top of any page */}
      {selected && (
        <ShowDetailDialog
          show={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

export default App;
