import {
  LayoutDashboard,
  Calendar,
  Download,
  Library,
  AlertCircle,
  HardDrive,
  Settings,
  CheckCircle2,
  ChevronDown,
  FolderOpen,
} from "lucide-react";
import * as React from "react";

import { cn } from "@frontend/lib/utils";

export type NavItem = "dashboard" | "agenda" | "queue" | "library" | "missing" | "sources" | "settings" | "manual-import";

interface SidebarProps {
  activeItem: NavItem;
  onChange: (item: NavItem) => void;
  onSettingsTab?: (tab: string) => void;
  className?: string;
}

export function Sidebar({ activeItem, onChange, onSettingsTab, className }: SidebarProps) {
  const [settingsHovered, setSettingsHovered] = React.useState(false);
  const [missingCount, setMissingCount] = React.useState(0);
  const [queueCount, setQueueCount] = React.useState(0);
  const [manualCount, setManualCount] = React.useState(0);
  const [isHealthy, setIsHealthy] = React.useState<boolean | null>(null);
  const [seriesCount, setSeriesCount] = React.useState(0);

  React.useEffect(() => {
    // Poll processing queue count
    const pollQueue = () =>
      fetch("/api/system/processing")
        .then((r) => r.json())
        .then((files: string[]) => setQueueCount(files.length))
        .catch(() => {});

    // Poll watcher status for health indicator
    const pollHealth = () =>
      fetch("/api/system/status")
        .then((r) => r.json())
        .then((d) => setIsHealthy(d.watching !== null))
        .catch(() => setIsHealthy(false));

    // Poll library series count
    const pollLibrary = () =>
      fetch("/api/shows")
        .then((r) => r.json())
        .then((shows: any[]) => setSeriesCount(shows.length))
        .catch(() => {});

    // Poll missing (aired, tracked, no file) episode count
    const pollMissing = () =>
      fetch("/api/missing")
        .then((r) => r.json())
        .then((episodes: any[]) => setMissingCount(episodes.length))
        .catch(() => {});

    // Poll manual import file count
    const pollManual = () =>
      fetch("/api/manual-import/count")
        .then((r) => r.json())
        .then((d: { count: number }) => setManualCount(d.count ?? 0))
        .catch(() => {});

    pollQueue();
    pollHealth();
    pollLibrary();
    pollMissing();
    pollManual();

    const id = setInterval(() => {
      pollQueue();
      pollHealth();
      pollLibrary();
      pollMissing();
      pollManual();
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  const mainNavs = [
    { id: "dashboard" as NavItem, label: "Dashboard", icon: LayoutDashboard },
    { id: "agenda" as NavItem, label: "Calendar", icon: Calendar },
    { id: "queue" as NavItem, label: "Queue", icon: Download, badge: queueCount },
  ];

  const collectionNavs = [
    { id: "library" as NavItem, label: "Library", icon: Library },
    { id: "missing" as NavItem, label: "Missing", icon: AlertCircle, badge: missingCount },
  ];

  const manageNavs = [
    { id: "manual-import" as NavItem, label: "Manual Import", icon: FolderOpen, badge: manualCount },
    { id: "sources" as NavItem, label: "Sources", icon: HardDrive },
    { id: "settings" as NavItem, label: "Settings", icon: Settings },
  ];

  const settingsTabs = [
    { id: "general", label: "General" },
    { id: "appearance", label: "Appearance" },
    { id: "providers", label: "Providers" },
    { id: "indexers", label: "Indexers" },
    { id: "quality", label: "Quality" },
    { id: "downloads", label: "Downloads" },
    { id: "tasks", label: "Tasks" },
    { id: "backup", label: "Backup" },
    { id: "debug", label: "Debug" },
  ];

  return (
    <>
      {/* Desktop Sidebar (visible on md screens and up) */}
      <aside
        className={cn(
          "glass-panel sticky top-0 z-30 hidden h-screen flex-col border-y-0 border-l-0 p-4 transition-all duration-300 md:flex",
          "md:w-16 lg:w-60 shrink-0",
          className
        )}
      >
        {/* Logo / Branding */}
        <div className="flex h-14 items-center gap-3 px-2 mb-6">
          <img src="/assets/logo.svg" alt="ShowFlow" className="h-25 w-25 drop-shadow-[0_0_12px_rgba(0,210,255,0.35)]" />
          <span className="font-display text-lg font-bold tracking-wider text-white uppercase hidden lg:inline">
            ShowFlow
          </span>
        </div>

        {/* Navigation Lists */}
        <div className="flex-1 space-y-6 overflow-y-auto pr-1">
          {/* Main Workspace */}
          <div className="space-y-1">
            {mainNavs.map((nav) => (
              <button
                key={nav.id}
                onClick={() => onChange(nav.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left font-sans text-sm font-medium transition-all duration-150",
                  activeItem === nav.id
                    ? "bg-signal/15 text-signal font-semibold border border-signal/10"
                    : "text-muted-foreground hover:bg-white/[0.03] hover:text-white"
                )}
              >
                <nav.icon className="size-4 shrink-0" />
                <span className="flex-1 truncate hidden lg:inline">{nav.label}</span>
                {nav.badge !== undefined && nav.badge > 0 && (
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-caption font-mono font-bold leading-none",
                      activeItem === nav.id ? "bg-signal text-signal-foreground" : "bg-white/10 text-white/60"
                    )}
                  >
                    {nav.badge}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Collection Group */}
          <div className="space-y-1">
            <span className="px-3 font-mono text-[9px] font-semibold uppercase tracking-wider text-white/30 hidden lg:inline-block">
              Collection
            </span>
            {collectionNavs.map((nav) => (
              <button
                key={nav.id}
                onClick={() => onChange(nav.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left font-sans text-sm font-medium transition-all duration-150",
                  activeItem === nav.id
                    ? "bg-signal/15 text-signal font-semibold border border-signal/10"
                    : "text-muted-foreground hover:bg-white/[0.03] hover:text-white"
                )}
              >
                <nav.icon className="size-4 shrink-0" />
                <span className="flex-1 truncate hidden lg:inline">{nav.label}</span>
                {nav.badge !== undefined && nav.badge > 0 && (
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-caption font-mono font-bold leading-none",
                      activeItem === nav.id ? "bg-signal text-signal-foreground" : "bg-accent-amber/20 text-accent-amber"
                    )}
                  >
                    {nav.badge}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Manage Group */}
          <div className="space-y-1">
            <span className="px-3 font-mono text-[9px] font-semibold uppercase tracking-wider text-white/30 hidden lg:inline-block">
              Manage
            </span>
            {manageNavs.map((nav) => (
              nav.id === "settings" ? (
                <div
                  key={nav.id}
                  className="relative"
                  onMouseEnter={() => setSettingsHovered(true)}
                  onMouseLeave={() => setSettingsHovered(false)}
                >
                  <button
                    onClick={() => onChange(nav.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left font-sans text-sm font-medium transition-all duration-150",
                      activeItem === nav.id
                        ? "bg-signal/15 text-signal font-semibold border border-signal/10"
                        : "text-muted-foreground hover:bg-white/[0.03] hover:text-white"
                    )}
                  >
                    <nav.icon className="size-4 shrink-0" />
                    <span className="flex-1 truncate hidden lg:inline">{nav.label}</span>
                    <ChevronDown className={cn("size-3 opacity-50 hidden lg:inline transition-transform duration-300", settingsHovered && "rotate-180")} />
                  </button>
                  
                  {/* Settings Tabs Dropdown */}
                  <div 
                    className={cn(
                      "ml-6 space-y-1 mt-1 hidden lg:block overflow-hidden transition-all duration-300 ease-out",
                      settingsHovered ? "max-h-96 opacity-100" : "max-h-0 opacity-0"
                    )}
                  >
                    {settingsTabs.map((tab, index) => (
                      <button
                        key={tab.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          onChange("settings");
                          onSettingsTab?.(tab.id);
                          setSettingsHovered(false);
                        }}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-white/[0.05] hover:text-white transition-all duration-200",
                          settingsHovered ? "translate-x-0 opacity-100 blur-0" : "-translate-x-2 opacity-0 blur-sm"
                        )}
                        style={{
                          transitionDelay: settingsHovered ? `${index * 30}ms` : '0ms'
                        }}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <button
                  key={nav.id}
                  onClick={() => onChange(nav.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left font-sans text-sm font-medium transition-all duration-150",
                    activeItem === nav.id
                      ? "bg-signal/15 text-signal font-semibold border border-signal/10"
                      : "text-muted-foreground hover:bg-white/[0.03] hover:text-white"
                  )}
                >
                  <nav.icon className="size-4 shrink-0" />
                  <span className="flex-1 truncate hidden lg:inline">{nav.label}</span>
                  {(nav as any).badge !== undefined && (nav as any).badge > 0 && (
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-caption font-mono font-bold leading-none shrink-0 hidden lg:inline-block",
                        activeItem === nav.id ? "bg-signal text-signal-foreground" : "bg-white/10 text-white/60"
                      )}
                    >
                      {(nav as any).badge}
                    </span>
                  )}
                </button>
              )
            ))}
          </div>
        </div>

        {/* Combined Health (Bottom of Sidebar) */}
        <div className="mt-auto border-t border-white/5 pt-4">
          <div className="space-y-1">
            <div className="flex items-start gap-2.5 rounded-lg bg-white/[0.01] p-2.5 border border-white/5">
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2 shrink-0">
                    {isHealthy === null ? (
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-white/30"></span>
                    ) : isHealthy ? (
                      <>
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-75"></span>
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-signal"></span>
                      </>
                    ) : (
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive"></span>
                    )}
                  </span>
                  <span className="font-sans text-xs font-semibold text-white/90 hidden lg:inline">
                    {isHealthy === null ? "Checking..." : isHealthy ? "System healthy" : "System offline"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="size-3 text-emerald-500 shrink-0" />
                  <span className="font-sans text-xs text-white/70 hidden lg:inline">{seriesCount} series</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile Bottom Navigation (visible on screens < 768px) */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 flex h-14 items-center gap-1 overflow-x-auto border-t border-white/10 px-2 py-1 md:hidden"
        style={{ backdropFilter: "blur(18px) saturate(115%)", WebkitBackdropFilter: "blur(18px) saturate(115%)", background: "rgb(28 32 40 / 62%)" }}>
        {mainNavs.concat(collectionNavs, manageNavs).map((nav) => (
          <button
            key={nav.id}
            onClick={() => onChange(nav.id)}
            className={cn(
              "relative flex shrink-0 flex-col items-center justify-center px-3 py-1 font-sans text-caption font-medium transition-colors",
              activeItem === nav.id ? "text-signal" : "text-muted-foreground"
            )}
          >
            <nav.icon className="size-4.5" />
            <span className="mt-0.5 scale-90">{nav.label}</span>
            {nav.badge !== undefined && nav.badge > 0 && (
              <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-signal px-1 text-[8px] font-mono font-bold text-signal-foreground">
                {nav.badge}
              </span>
            )}
          </button>
        ))}
      </nav>
    </>
  );
}
