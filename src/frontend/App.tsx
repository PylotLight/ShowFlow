import * as React from "react";

import { Sidebar, type NavItem } from "@frontend/components/showflow/Sidebar";
import { NotificationsPopover } from "@frontend/components/showflow/NotificationsPopover";
import { DebugBadge } from "@frontend/components/showflow/DebugBadge";
import { Dashboard } from "@frontend/components/showflow/Dashboard";
import { CalendarView } from "@frontend/components/showflow/CalendarView";
import { Library } from "@frontend/components/Library";
import { ShowDetailDialog } from "@frontend/components/showflow/ShowDetailDialog";
import { AddShowDialog } from "@frontend/components/showflow/AddShowDialog";
import { SettingsPage } from "@frontend/components/showflow/SettingsPage";
import { DebugPage } from "@frontend/components/showflow/DebugPage";
import { PipelinePage } from "@frontend/components/showflow/PipelinePage";
import { ActivityPage } from "@frontend/components/showflow/ActivityPage";
import { CommandPalette } from "@frontend/components/showflow/CommandPalette";
import { IndexerSearch } from "@frontend/components/showflow/IndexerSearch";
import { Toaster } from "@frontend/components/ui/sonner";
import { ConfirmHost } from "@frontend/components/ui/confirm";
import { Input } from "@frontend/components/ui/input";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";
import { MenuIcon, SearchIcon } from "lucide-react";
import { FeedbackButton } from "@frontend/components/showflow/FeedbackButton";
import { loadTheme, applyTheme } from "@frontend/lib/theme";
import { HeaderActions, HeaderActionsProvider } from "@frontend/lib/header-actions";
import { OnboardingWizard } from "@frontend/components/showflow/onboarding/OnboardingWizard";
import {
  DEFAULT_ACTIVITY_TAB,
  PAGE_LABELS,
  cameFromApp,
  navigate,
  pageHash,
  routeToHash,
  useHashRoute,
  type PageRoute,
} from "@frontend/lib/router";
import "./styles/index.css";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function App() {
  // Navigation lives in the URL hash (see lib/router.ts) so refresh, back /
  // forward and deep links all work.
  const route = useHashRoute();
  // The show detail renders over whichever page you opened it from; on a
  // pasted #/show/:id link that falls back to the dashboard.
  const lastPageRoute = React.useRef<PageRoute>({ kind: "page", page: "dashboard" });
  if (route.kind === "page") lastPageRoute.current = route;
  const pageRoute = lastPageRoute.current;
  const activeNav: NavItem = pageRoute.page;
  const settingsTab = pageRoute.settingsTab;
  const settingsScrollTo = pageRoute.section;

  const [query, setQuery] = React.useState("");
  const [showSummary, setShowSummary] = React.useState<ShowSummary | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [addShowOpen, setAddShowOpen] = React.useState(false);
  const selectedShowId = route.kind === "show" ? route.showId : null;
  const selected = selectedShowId && showSummary?.id === selectedShowId ? showSummary : null;
  // Three-state gate so the wizard never flashes on reload: while "checking"
  // we render nothing, then open only if the server is genuinely unconfigured.
  const [wizardState, setWizardState] = React.useState<'checking' | 'open' | 'closed'>(() => {
    try {
      const raw = localStorage.getItem("showflow-onboarding");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.completed) return 'closed';
      }
    } catch {}
    return 'checking';
  });
  const wizardOpen = wizardState === 'open';
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
    if (wizardState !== 'checking') return;
    (async () => {
      try {
        const statusRes = await fetch("/api/system/status");
        if (statusRes.ok) {
          const status = await statusRes.json();
          if (status.testMode) {
            setWizardState('closed');
            return;
          }
        }
        const res = await fetch("/api/library-types");
        if (res.ok) {
          const types = await res.json();
          if (types.length > 0) {
            // Server is configured: remember locally so the next load
            // resolves to closed without waiting on the network.
            try {
              const raw = localStorage.getItem("showflow-onboarding");
              const parsed = raw ? JSON.parse(raw) : {};
              localStorage.setItem("showflow-onboarding", JSON.stringify({ ...parsed, completed: true }));
            } catch {}
            setWizardState('closed');
          } else {
            setWizardState('open');
          }
        } else {
          setWizardState('open');
        }
      } catch {
        setWizardState('open');
      }
    })();
  }, [wizardKey]);

  const [backdropUrl, setBackdropUrl] = React.useState("");
  const [headerActionsEl, setHeaderActionsEl] = React.useState<HTMLDivElement | null>(null);

  // Canonicalise the hash (empty / unknown -> #/dashboard, legacy
  // ?tab= -> /tab) without adding a history entry.
  React.useEffect(() => {
    const canonical = routeToHash(route);
    if (window.location.hash !== canonical) navigate(canonical, { replace: true });
  }, [route]);

  // Deep link to a show we don't have a summary for yet: load it.
  React.useEffect(() => {
    if (!selectedShowId || showSummary?.id === selectedShowId) return;
    let cancelled = false;
    fetch(`/api/shows/${encodeURIComponent(selectedShowId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        if (cancelled) return;
        setShowSummary({
          id: d.id,
          providerType: d.providerType,
          title: d.title,
          profile: d.profile ?? undefined,
          seriesType: d.seriesType ?? undefined,
          lastUpdated: d.lastUpdated ?? undefined,
        });
      })
      .catch(() => {
        if (!cancelled) navigate(pageHash(lastPageRoute.current.page), { replace: true });
      });
    return () => { cancelled = true; };
  }, [selectedShowId, showSummary?.id]);

  // Tab title per page / show.
  React.useEffect(() => {
    const label = route.kind === "show" ? selected?.title : PAGE_LABELS[route.page];
    document.title = label ? `${label} · ShowFlow` : "ShowFlow";
  }, [route, selected?.title]);

  function goTo(page: NavItem) {
    navigate(pageHash(page));
  }

  function openSettings(tab?: string, section?: string) {
    navigate(pageHash("settings", tab, section));
  }

  function selectShow(show: ShowSummary | null) {
    if (!show) return;
    setShowSummary(show);
    navigate(`#/show/${encodeURIComponent(show.id)}`, { state: { sfFromApp: true } });
  }

  function closeShow() {
    // Opened from inside the app: pop back to exactly where we were.
    // Pasted link: replace with the underlying page so back doesn't reopen it.
    if (cameFromApp()) window.history.back();
    else navigate(pageHash(lastPageRoute.current.page), { replace: true });
  }

  // Refresh the library grid + show detail after data-changing actions
  // (e.g. renaming a series from the detail modal) fire this event.
  React.useEffect(() => {
    const onRefresh = (e: Event) => {
      const detail = (e as CustomEvent).detail as { showId?: string; title?: string } | undefined;
      if (detail?.showId && detail?.title) {
        setShowSummary(prev => prev && prev.id === detail.showId ? { ...prev, title: detail.title! } : prev);
      }
      setRefreshKey(k => k + 1);
    };
    window.addEventListener("showflow-refresh-shows", onRefresh);
    return () => window.removeEventListener("showflow-refresh-shows", onRefresh);
  }, []);

  function reRunWizard() {
    localStorage.removeItem("showflow-onboarding");
    wizardManual.current = true;
    setWizardKey(k => k + 1);
    setWizardState('open');
  }

  return (
    <HeaderActionsProvider container={headerActionsEl}>
    <div className={`app-background app-shell-height flex h-screen text-foreground pb-mobile-nav md:pb-0 ${wizardOpen ? 'pointer-events-none' : ''}`}>
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
        onChange={goTo}
        onSettingsTab={openSettings}
        mobileMenuOpen={mobileMenuOpen}
        onMobileMenuOpenChange={setMobileMenuOpen}
      />

      {/* Main Viewport Workspace */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 relative z-10">
        {/* Main Content Header — single persistent row for every page: title,
            page-specific actions (portaled in via <HeaderActions>), and the
            global notification / background-activity controls. */}
        <header className="flex min-h-14 flex-wrap items-center gap-x-2 gap-y-2 border-b border-white/5 px-3 py-2 sm:px-6 md:h-16 md:flex-nowrap md:gap-4 md:py-4">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Open menu"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-white/[0.05] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/70 md:hidden"
          >
            <MenuIcon className="size-5" />
          </button>
          <h1 className="min-w-0 flex-1 truncate font-display text-lg font-bold tracking-tight text-white sm:text-2xl md:flex-none md:shrink-0">
            {PAGE_LABELS[activeNav]}
          </h1>

          {/* Page actions slot. On mobile it drops to its own full-width row
              under the title bar so it never collides with the bell. */}
          <div
            ref={setHeaderActionsEl}
            className="order-last flex w-full min-w-0 items-center gap-2 empty:hidden md:order-none md:w-auto md:flex-1 md:gap-4"
          />

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Search and commands (Ctrl+K)"
              title="Search and commands (⌘K / Ctrl+K)"
              className="flex size-9 items-center justify-center gap-2 rounded-lg text-muted-foreground hover:bg-white/[0.05] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/70 lg:w-auto lg:border lg:border-white/10 lg:bg-white/[0.03] lg:px-2.5"
            >
              <SearchIcon className="size-4" />
              <span className="hidden text-xs lg:inline">Search</span>
              <kbd className="hidden rounded border border-white/10 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground lg:inline">{isMac ? "⌘K" : "Ctrl K"}</kbd>
            </button>
            <DebugBadge className="mr-1 hidden md:inline-flex" onOpenDebug={() => openSettings("debug")} />
            {/* Single mount for every breakpoint — it polls, so never render two. */}
            <NotificationsPopover />
            <div className="hidden md:block">
              <FeedbackButton />
            </div>
          </div>
        </header>

        {/* Dynamic Content Views */}
        <div key={activeNav} className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-6 animate-page-enter">
          {activeNav === "dashboard" ? (
            <div className="h-full flex flex-col overflow-hidden">
              <Dashboard
                key={refreshKey}
                onSelectShow={selectShow}
                onShowCalendar={() => goTo("agenda")}
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
                <div className="flex w-full items-center gap-2 sm:gap-4 md:ml-auto md:w-auto">
                  <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
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
              // Tab lives in the URL (#/settings/:tab), so switching tabs
              // re-renders instead of remounting (no config reload); only a
              // new ?section= deep link remounts to re-run the scroll.
              key={`settings:${settingsScrollTo ?? ""}`}
              onDone={() => goTo("dashboard")}
              initialTab={settingsTab}
              tab={settingsTab ?? "general"}
              onTabChange={(t) => { if (t !== (settingsTab ?? "general")) navigate(pageHash("settings", t)); }}
              scrollToSection={settingsScrollTo}
              onReRunWizard={reRunWizard}
            />
          ) : activeNav === "activity" ? (
            <ActivityPage
              key={refreshKey}
              tab={pageRoute.activityTab ?? DEFAULT_ACTIVITY_TAB}
              onOpenSettings={(tab) => openSettings(tab)}
            />
          ) : activeNav === "pipeline" ? (
            <PipelinePage key={refreshKey} onSelectShow={selectShow} />
          ) : activeNav === "search" ? (
            <IndexerSearch
              onOpenSettings={() => openSettings("indexers")}
            />
          ) : (
            <div className="glass-plane rounded-xl p-8 text-center text-muted-foreground">
              <h3 className="font-display text-lg font-bold text-white mb-2 uppercase">
                {PAGE_LABELS[activeNav]} Section
              </h3>
              <p className="font-mono text-caption">
                Work-in-progress operational workspace for {PAGE_LABELS[activeNav]}.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Show Detail Modal — renders on top of any page */}
      {selected && (
        <ShowDetailDialog
          key={selected.id}
          show={selected}
          onClose={closeShow}
        />
      )}
    </div>
    <CommandPalette
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      onSelectShow={selectShow}
      onAddShow={() => setAddShowOpen(true)}
    />
    <AddShowDialog
      hideTrigger
      open={addShowOpen}
      onOpenChange={setAddShowOpen}
      onAdded={() => setRefreshKey((k) => k + 1)}
    />
    {/* Single toast + confirm hosts for the whole app. */}
    <Toaster />
    <ConfirmHost />
    {wizardOpen && (
      <OnboardingWizard onFinish={() => { setWizardState('closed'); window.location.reload(); }} />
    )}
    </HeaderActionsProvider>
  );
}

export default App;
