import {
  ActivityIcon,
  CalendarIcon,
  ClockIcon,
  DownloadCloudIcon,
  FolderSearchIcon,
  FilmIcon,
  HistoryIcon,
  LayersIcon,
  LayoutDashboardIcon,
  LibraryIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  TvIcon,
} from "lucide-react";
import * as React from "react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@frontend/components/ui/command";
import { SETTINGS_TABS } from "@frontend/components/showflow/settings/tabs";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";
import { ACTIVITY_TABS, activityHash, navigate, pageHash } from "@frontend/lib/router";
import { toast } from "@frontend/lib/toast";

type PaletteShow = ShowSummary & { year?: number | null };
type Task = { name: string; displayName: string; description?: string };

// /api/shows cached across palette opens; refreshed in the background
// after a minute so new shows turn up without a reload.
let showsCache: { at: number; shows: PaletteShow[] } | null = null;
const SHOWS_TTL_MS = 60_000;

async function loadShows(): Promise<PaletteShow[]> {
  const r = await fetch("/api/shows");
  if (!r.ok) throw new Error(String(r.status));
  const data = await r.json();
  const shows = Array.isArray(data) ? (data as PaletteShow[]) : [];
  showsCache = { at: Date.now(), shows };
  return shows;
}

/** Fire a scheduler task now via the existing POST /api/tasks/:name. */
export function runTask(name: string, label: string) {
  const p = fetch(`/api/tasks/${encodeURIComponent(name)}`, { method: "POST" })
    .then(async (r) => {
      const res = await r.json().catch(() => ({}));
      if (!r.ok || res.success === false) throw new Error(res.message || res.error || `HTTP ${r.status}`);
      return res as { message?: string };
    });
  toast.promise(p, {
    loading: `${label}…`,
    success: (res) => res.message || `${label} finished`,
    error: (e) => `${label} failed: ${e instanceof Error ? e.message : String(e)}`,
  });
}

const PAGES = [
  { label: "Dashboard", hash: () => pageHash("dashboard"), icon: LayoutDashboardIcon },
  { label: "Calendar", hash: () => pageHash("agenda"), icon: CalendarIcon },
  { label: "Library", hash: () => pageHash("library"), icon: LibraryIcon },
  { label: "Pipeline", hash: () => pageHash("pipeline"), icon: LayersIcon },
  { label: "Indexer Search", hash: () => pageHash("search"), icon: SearchIcon },
];

const ACTIVITY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  now: DownloadCloudIcon,
  history: HistoryIcon,
  "manual-import": FolderSearchIcon,
  health: ActivityIcon,
};

/**
 * ⌘K / Ctrl+K palette: jump to a show by title, any page / Activity tab /
 * Settings tab, or run an action. Mounted once in App; `open` is lifted so
 * the header search button can open it too.
 */
export function CommandPalette({ open, onOpenChange, onSelectShow, onAddShow }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectShow: (show: ShowSummary) => void;
  onAddShow: () => void;
}) {
  const [search, setSearch] = React.useState("");
  const [shows, setShows] = React.useState<PaletteShow[]>(() => showsCache?.shows ?? []);
  const [tasks, setTasks] = React.useState<Task[]>([]);

  // Global shortcut.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  React.useEffect(() => {
    if (!open) return;
    setSearch("");
    if (!showsCache || Date.now() - showsCache.at > SHOWS_TTL_MS) {
      loadShows().then(setShows).catch(() => {});
    } else {
      setShows(showsCache.shows);
    }
    fetch("/api/tasks")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setTasks(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [open]);

  const run = (fn: () => void) => {
    onOpenChange(false);
    // Let the dialog close (and return focus) before navigating / opening another dialog.
    requestAnimationFrame(fn);
  };

  const q = search.trim().toLowerCase();
  // Only list shows once the user types; ~300 rows of noise otherwise.
  const matchedShows = React.useMemo(() => {
    if (!q) return [];
    return shows
      .filter((s) => s.title.toLowerCase().includes(q))
      .sort((a, b) => {
        const as = a.title.toLowerCase().startsWith(q) ? 0 : 1;
        const bs = b.title.toLowerCase().startsWith(q) ? 0 : 1;
        return as - bs || a.title.localeCompare(b.title);
      })
      .slice(0, 12);
  }, [shows, q]);

  const otherTasks = tasks.filter((t) => t.name !== "auto-grab" && t.name !== "scan-library");

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      commandProps={{ loop: true }}
    >
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder="Search shows, pages, settings, actions…"
        aria-label="Search shows, pages, settings and actions"
      />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>

        {matchedShows.length > 0 && (
          <CommandGroup heading="Shows">
            {matchedShows.map((s) => (
              <CommandItem
                key={s.id}
                // Title first so cmdk's fuzzy filter keeps what we matched.
                value={`show ${s.title} ${s.id}`}
                onSelect={() => run(() => onSelectShow(s))}
              >
                {s.seriesType === "movie" ? <FilmIcon /> : <TvIcon />}
                <span className="truncate">{s.title}</span>
                {s.year ? <span className="font-mono text-[11px] text-muted-foreground">{s.year}</span> : null}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading="Actions">
          <CommandItem value="action add show new series" onSelect={() => run(onAddShow)}>
            <PlusIcon /> Add show…
          </CommandItem>
          <CommandItem value="action run auto-grab now search wanted" onSelect={() => run(() => runTask("auto-grab", "Auto-grab"))}>
            <PlayIcon /> Run auto-grab now
          </CommandItem>
          <CommandItem value="action scan library rescan files" onSelect={() => run(() => runTask("scan-library", "Library scan"))}>
            <FolderSearchIcon /> Scan library
          </CommandItem>
          <CommandItem value="action open activity queue downloads" onSelect={() => run(() => navigate(activityHash("now")))}>
            <DownloadCloudIcon /> Open Activity
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Pages">
          {PAGES.map((p) => (
            <CommandItem key={p.label} value={`page ${p.label}`} onSelect={() => run(() => navigate(p.hash()))}>
              <p.icon /> {p.label}
            </CommandItem>
          ))}
          {ACTIVITY_TABS.map((t) => {
            const Icon = ACTIVITY_ICONS[t.id] ?? ActivityIcon;
            return (
              <CommandItem key={t.id} value={`page activity ${t.label} ${t.id === "now" ? "queue downloads" : ""}`} onSelect={() => run(() => navigate(activityHash(t.id)))}>
                <Icon /> Activity <span className="text-muted-foreground">›</span> {t.label}
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandGroup heading="Settings">
          {SETTINGS_TABS.map((t) => (
            <CommandItem key={t.id} value={`settings ${t.label} ${t.id}`} onSelect={() => run(() => navigate(pageHash("settings", t.id)))}>
              <t.icon /> Settings <span className="text-muted-foreground">›</span> {t.label}
            </CommandItem>
          ))}
        </CommandGroup>

        {otherTasks.length > 0 && (
          <CommandGroup heading="Run task">
            {otherTasks.map((t) => (
              <CommandItem key={t.name} value={`task run ${t.displayName} ${t.name}`} onSelect={() => run(() => runTask(t.name, t.displayName))}>
                <ClockIcon /> <span className="truncate">Run {t.displayName}</span>
                <CommandShortcut>{t.name}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
