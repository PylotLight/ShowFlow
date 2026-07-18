import * as React from "react";

import { Sidebar, type NavItem } from "@frontend/components/showflow/Sidebar";
import { Dashboard } from "@frontend/components/showflow/Dashboard";
import { CalendarView } from "@frontend/components/showflow/CalendarView";
import { Library } from "@frontend/components/Library";
import { ShowDetailDialog } from "@frontend/components/showflow/ShowDetailDialog";
import { AddShowDialog } from "@frontend/components/showflow/AddShowDialog";
import { SettingsPage } from "@frontend/components/showflow/SettingsPage";
import { DebugPage } from "@frontend/components/showflow/DebugPage";
import { QueuePage } from "@frontend/components/showflow/QueuePage";
import { PipelineKanban } from "@frontend/components/showflow/PipelineKanban";
import { SourcesPage } from "@frontend/components/showflow/SourcesPage";
import { ManualImport } from "@frontend/components/showflow/ManualImport";
import { HealthDashboard } from "@frontend/components/showflow/HealthDashboard";
import { Input } from "@frontend/components/ui/input";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";
import { SearchIcon } from "lucide-react";
import { FeedbackButton } from "@frontend/components/showflow/FeedbackButton";
import { loadTheme, applyTheme } from "@frontend/lib/theme";
import { HeaderActions, HeaderActionsProvider } from "@frontend/lib/header-actions";
import { OnboardingWizard } from "@frontend/components/showflow/onboarding/OnboardingWizard";
import "./styles/index.css";

export function App() {
  const [activeNav, setActiveNav] = React.useState<NavItem>("dashboard");
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<ShowSummary | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [settingsInitialTab, setSettingsInitialTab] = React.useState<string | undefined>(undefined);
  const [settingsScrollTo, setSettingsScrollTo] = React.useState<string | undefined>(undefined);
  const [wizardOpen, setWizardOpen] = React.useState<boolean>(() => {
    try {
      const raw = localStorage.getItem("showflow-onboarding");
      if (!raw) return true;
      const parsed = JSON.parse(raw);
      return !parsed.completed;
    } catch {
      return true;
    }
  });
  const [wizardKey, setWizardKey] = React.useState(0);
  const wizardManual = React.useRef(false);

  React.useEffect(() => {
    loadTheme().then((theme) => {
      applyTheme(theme);
    });
  }, []);

  React.useEffect(() => {
    if (wizardManual.current) {
      wizardManual.current = false;
      return;
    }
    if (!wizardOpen) return;
    (async () => {
      try {
        const res = await fetch("/api/shows?limit=1");
        if (res.ok) {
          const shows = await res.json();
          if (shows.length > 0) setWizardOpen(false);
        }
      } catch {}
    })();
  }, [wizardKey]);

  const [backdropUrl, setBackdropUrl] = React.useState("");
  const [headerActionsEl, setHeaderActionsEl] = React.useState<HTMLDivElement | null>(null);

  function selectShow(show: ShowSummary | null) {
    if (show) {
      setSelected(show);
    }
  }

  function reRunWizard() {
    localStorage.removeItem("showflow-onboarding");
    wizardManual.current = true;
    setWizardKey(k => k + 1);
    setWizardOpen(true);
  }

  if (wizardOpen) {
    return <OnboardingWizard onFinish={() => { setWizardOpen(false); window.location.reload(); }} />;
  }

  return (
    <HeaderActionsProvider container={headerActionsEl}>
    <div className="app-background flex h-screen text-foreground pb-14 md:pb-0">
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
      <Sidebar 
        activeItem={activeNav} 
        onChange={(item) => { setActiveNav(item); setSelected(null); }}
        onSettingsTab={(tab, scrollTo) => { setSettingsInitialTab(tab); setSettingsScrollTo(scrollTo); setActiveNav("settings"); setSelected(null); }}
      />

      {/* Main Viewport Workspace */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 relative z-10">
        {/* Main Content Header — hidden when view has its own header. Layout is
            identical on every page; only the actions slot content (portaled
            in by the active page via <HeaderActions>) changes. */}
        {activeNav !== "agenda" && (
          <header className="flex h-16 items-center gap-4 border-b border-white/5 px-6 py-4">
            <div className="flex items-center gap-4 shrink-0">
              <h1 className="font-display text-2xl font-bold tracking-tight text-white capitalize">
                {activeNav}
              </h1>
            </div>

            <div ref={setHeaderActionsEl} className="flex min-w-0 flex-1 items-center gap-4" />
          </header>
        )}

        {/* Dynamic Content Views */}
        <div key={activeNav} className="flex-1 min-h-0 overflow-y-auto p-6 animate-page-enter">
          {activeNav === "dashboard" ? (
            <div className="h-full flex flex-col overflow-hidden">
              <Dashboard
                key={refreshKey}
                onSelectShow={selectShow}
                onShowCalendar={() => setActiveNav("agenda")}
                onAddShow={() => setRefreshKey((k) => k + 1)}
              />
            </div>
          ) : activeNav === "agenda" ? (
            <CalendarView
              key={refreshKey}
              onSelectShow={selectShow}
            />
          ) : activeNav === "library" ? (
            <>
              <HeaderActions>
                <div className="ml-auto flex items-center gap-4">
                  <div className="relative w-48 sm:w-64">
                    <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
                    <Input
                      placeholder="Search library..."
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      className="pl-8 h-8 text-xs bg-white/5 border-white/5 focus:border-signal/50 focus:ring-1 focus:ring-signal/30"
                    />
                  </div>
                  <AddShowDialog onAdded={() => setRefreshKey((k) => k + 1)} />
                </div>
              </HeaderActions>
              <Library
                key={refreshKey}
                query={query}
                onSelectShow={selectShow}
                onBackdropChange={setBackdropUrl}
              />
            </>
          ) : activeNav === "settings" ? (
            <SettingsPage
              key={settingsInitialTab}
              onDone={() => { setActiveNav("dashboard"); setSettingsScrollTo(undefined); }}
              initialTab={settingsInitialTab}
              scrollToSection={settingsScrollTo}
              onReRunWizard={reRunWizard}
            />
          ) : activeNav === "queue" ? (
            <QueuePage key={refreshKey} />
          ) : activeNav === "pipeline" ? (
            <PipelineKanban key={refreshKey} onSelectShow={selectShow} />
          ) : activeNav === "health" ? (
            <HealthDashboard
              onOpenSettings={(tab) => {
                setSettingsInitialTab(tab);
                setActiveNav("settings");
              }}
            />
          ) : activeNav === "sources" ? (
            <SourcesPage
              onOpenSettings={() => {
                setSettingsInitialTab("indexers");
                setActiveNav("settings");
              }}
            />
          ) : activeNav === "manual-import" ? (
            <ManualImport />
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

      {/* Feedback button — floating bottom-right */}
      <FeedbackButton />
    </div>
    </HeaderActionsProvider>
  );
}

export default App;
