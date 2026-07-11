import {
  LayoutDashboard,
  Calendar,
  Download,
  Library,
  AlertCircle,
  HardDrive,
  Settings,
} from "lucide-react";
import * as React from "react";

import { cn } from "@frontend/lib/utils";

export type NavItem = "dashboard" | "agenda" | "queue" | "library" | "missing" | "sources" | "settings";

interface SidebarProps {
  activeItem: NavItem;
  onChange: (item: NavItem) => void;
  className?: string;
}

export function Sidebar({ activeItem, onChange, className }: SidebarProps) {
  const [missingCount, setMissingCount] = React.useState(0);
  const [queueCount, setQueueCount] = React.useState(0);
  const [isHealthy, setIsHealthy] = React.useState<boolean | null>(null);

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

    pollQueue();
    pollHealth();

    const id = setInterval(() => {
      pollQueue();
      pollHealth();
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
    { id: "sources" as NavItem, label: "Sources", icon: HardDrive },
    { id: "settings" as NavItem, label: "Settings", icon: Settings },
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
              </button>
            ))}
          </div>
        </div>

        {/* System Health (Bottom of Sidebar) */}
        <div className="mt-auto border-t border-white/5 pt-4">
          <div className="flex items-start gap-2.5 rounded-lg bg-white/[0.01] p-3 border border-white/5 lg:block">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
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
            <p className="font-mono text-[9px] text-muted-foreground mt-1.5 hidden lg:block">
              Watcher {isHealthy ? "active" : "stopped"}
            </p>
          </div>
        </div>
      </aside>

      {/* Mobile Bottom Navigation (visible on screens < 768px) */}
      <nav className="glass-plane fixed bottom-0 left-0 right-0 z-30 flex h-14 items-center justify-around border-x-0 border-b-0 px-2 py-1 md:hidden">
        {mainNavs.concat(collectionNavs.slice(0, 1)).map((nav) => (
          <button
            key={nav.id}
            onClick={() => onChange(nav.id)}
            className={cn(
              "relative flex flex-col items-center justify-center px-3 py-1 font-sans text-caption font-medium transition-colors",
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
