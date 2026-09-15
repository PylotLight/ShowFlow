import {
  ArrowDownUp,
  CheckIcon,
  DownloadIcon,
  Loader2Icon,
  PackageIcon,
  SaveIcon,
  SearchIcon,
  SettingsIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import * as React from "react";

import { Badge } from "@frontend/components/ui/badge";
import { Button } from "@frontend/components/ui/button";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Input } from "@frontend/components/ui/input";
import { Panel } from "@frontend/components/ui/panel";
import { ScrollArea } from "@frontend/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { cn } from "@frontend/lib/utils";

interface AdhocRelease {
  guid: string;
  indexerId: number;
  indexerName: string;
  title: string;
  seeders: number;
  leechers: number;
  grabs: number;
  size: number;
  publishDate: string;
  ageHours: number;
  infoUrl: string;
  downloadUrl: string;
  magnetUrl: string;
  infoHash: string;
  protocol: "usenet" | "torrent" | "unknown";
  categories: { id: number; name: string }[];
  indexerFlags: string[];
  isPack: boolean;
  raw?: Record<string, unknown>;
}

interface IndexerStat {
  key: string;
  kind: string;
  name: string;
  ok: boolean;
  ms: number;
  count: number;
  error?: string;
}

type SearchType = "search" | "tvsearch" | "movie" | "music" | "book";
type SortKey = "age" | "seeders" | "size";
type ProtocolFilter = "all" | "torrent" | "usenet";

const CATEGORY_PRESETS = [
  { id: 5000, label: "TV" },
  { id: 5070, label: "Anime" },
  { id: 2000, label: "Movies" },
  { id: 3000, label: "Music" },
  { id: 8000, label: "Books" },
];

const PRESETS_KEY = "indexerSearch.presets";

interface SearchPreset {
  id: string;
  name: string;
  query: string;
  type: SearchType;
  categories: number[];
  limit: string;
  indexerIds: number[];
  nativeIds: string[];
  updatedAt: string;
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

// Effective age in hours for "newest first": reported ageHours wins when
// sane, otherwise fall back to publishDate, otherwise sink to the bottom.
// (Native indexers often omit ageHours, which used to leave new releases
// scattered through the list.)
function effectiveAgeHours(r: { ageHours: number; publishDate: string }): number {
  if (Number.isFinite(r.ageHours) && r.ageHours >= 0) return r.ageHours;
  if (r.publishDate) {
    const t = new Date(r.publishDate).getTime();
    if (!Number.isNaN(t)) return Math.max(0, (Date.now() - t) / 3_600_000);
  }
  return Number.POSITIVE_INFINITY;
}

function formatAge(hours: number): string {
  const h = Number.isFinite(hours) && hours > 0 ? hours : 0;
  const totalMinutes = Math.round(h * 60);
  if (totalMinutes < 1) return "just now";
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const wholeHours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (wholeHours < 24) {
    return mins > 0 ? `${wholeHours}h ${mins}m` : `${wholeHours}h`;
  }
  const days = Math.floor(wholeHours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.round(months / 12)}y`;
}

function IndexerSearch({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [query, setQuery] = React.useState("");
  const [searchType, setSearchType] = React.useState<SearchType>("search");
  const [categories, setCategories] = React.useState<number[]>([]);
  const [limit, setLimit] = React.useState("50");

  const [prowlarrIndexers, setProwlarrIndexers] = React.useState<{ id: number; name: string; enabled: boolean }[] | null>(null);
  const [nativeIndexers, setNativeIndexers] = React.useState<{ id: string; name: string }[]>([]);
  const [pickedProwlarr, setPickedProwlarr] = React.useState<number[]>([]);
  const [pickedNative, setPickedNative] = React.useState<string[]>([]);
  const [pickersReady, setPickersReady] = React.useState(false);

  const [releases, setReleases] = React.useState<AdhocRelease[] | null>(null);
  const [stats, setStats] = React.useState<IndexerStat[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [protocol, setProtocol] = React.useState<ProtocolFilter>("all");
  const [sortBy, setSortBy] = React.useState<SortKey>("age");
  const [minSeeders, setMinSeeders] = React.useState(0);
  const [indexerFilter, setIndexerFilter] = React.useState("all");
  const [textFilter, setTextFilter] = React.useState("");

  const [grabbingGuid, setGrabbingGuid] = React.useState<string | null>(null);
  const [grabbedGuids, setGrabbedGuids] = React.useState<Set<string>>(new Set());
  const [notice, setNotice] = React.useState<{ message: string; ok: boolean } | null>(null);

  const [presets, setPresets] = React.useState<SearchPreset[]>([]);
  const [activePresetId, setActivePresetId] = React.useState<string | null>(null);
  const [presetName, setPresetName] = React.useState("");
  const [savingPreset, setSavingPreset] = React.useState(false);

  // Load the indexer pickers once: Prowlarr sub-indexers + enabled natives.
  // Presets load alongside so applying one can intersect with what's available.
  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((settings: any[]) => {
        if (cancelled || !Array.isArray(settings)) return;
        const raw = settings.find((s) => s.key === PRESETS_KEY);
        if (raw) {
          try {
            const parsed = JSON.parse(raw.value);
            if (Array.isArray(parsed)) setPresets(parsed);
          } catch {}
        }
      })
      .catch(() => {});
    (async () => {
      try {
        const res = await fetch("/api/indexers/prowlarr/indexers");
        const data = await res.json();
        if (!cancelled && Array.isArray(data)) {
          setProwlarrIndexers(data);
          setPickedProwlarr(data.filter((i: any) => i.enabled !== false).map((i: any) => i.id));
        } else if (!cancelled) {
          setProwlarrIndexers([]);
        }
      } catch {
        if (!cancelled) setProwlarrIndexers([]);
      }
    })();
    fetch("/api/indexers/native/status")
      .then((r) => r.json())
      .then((results: { id: string; name: string }[]) => {
        if (cancelled || !Array.isArray(results)) return;
        setNativeIndexers(results);
        setPickedNative(results.map((r) => r.id));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setPickersReady(true); });
    return () => { cancelled = true; };
  }, []);

  function toggleCategory(id: number) {
    setCategories((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  function toggleProwlarr(id: number) {
    setPickedProwlarr((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  }

  function toggleNative(id: string) {
    setPickedNative((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  }

  function applyPreset(p: SearchPreset) {
    setQuery(p.query ?? "");
    setSearchType(p.type ?? "search");
    setCategories(Array.isArray(p.categories) ? p.categories : []);
    setLimit(p.limit ?? "50");
    // Intersect with currently available indexers so stale ids are dropped.
    const prowlarrIds = new Set((prowlarrIndexers ?? []).map((i) => i.id));
    const nativeIds = new Set(nativeIndexers.map((n) => n.id));
    setPickedProwlarr((p.indexerIds ?? []).filter((id) => prowlarrIds.has(id)));
    setPickedNative((p.nativeIds ?? []).filter((id) => nativeIds.has(id)));
    setActivePresetId(p.id);
    setPresetName(p.name);
    setNotice(null);
  }

  async function persistPresets(next: SearchPreset[]) {
    setPresets(next);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: PRESETS_KEY, value: JSON.stringify(next) }),
      });
    } catch {
      setNotice({ message: "Preset saved locally but failed to persist to server.", ok: false });
    }
  }

  async function savePreset() {
    const name = presetName.trim();
    if (!name || savingPreset) return;
    setSavingPreset(true);
    try {
      const preset: SearchPreset = {
        id: activePresetId ?? (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `preset-${Date.now()}`),
        name,
        query: query.trim(),
        type: searchType,
        categories: [...categories],
        limit,
        indexerIds: [...pickedProwlarr],
        nativeIds: [...pickedNative],
        updatedAt: new Date().toISOString(),
      };
      const idx = presets.findIndex((p) => p.id === preset.id || p.name === name);
      const next = idx >= 0
        ? presets.map((p, i) => (i === idx ? { ...preset, id: p.id } : p))
        : [...presets, preset];
      await persistPresets(next);
      setActivePresetId(next[idx >= 0 ? idx : next.length - 1]!.id);
      setNotice({ message: `Preset "${name}" saved.`, ok: true });
    } finally {
      setSavingPreset(false);
    }
  }

  async function deletePreset() {
    if (!activePresetId) return;
    const target = presets.find((p) => p.id === activePresetId);
    await persistPresets(presets.filter((p) => p.id !== activePresetId));
    setActivePresetId(null);
    setPresetName("");
    setNotice({ message: target ? `Preset "${target.name}" deleted.` : "Preset deleted.", ok: true });
  }

  async function runSearch() {
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    setReleases(null);
    setStats([]);
    try {
      const params = new URLSearchParams({ q, type: searchType, limit });
      for (const c of categories) params.append("category", String(c));
      // Only send picker params when the selection is a strict subset —
      // absent means "all" server-side.
      if (prowlarrIndexers && pickedProwlarr.length > 0 && pickedProwlarr.length < prowlarrIndexers.length) {
        for (const id of pickedProwlarr) params.append("indexer", String(id));
      }
      if (pickedNative.length > 0 && pickedNative.length < nativeIndexers.length) {
        for (const id of pickedNative) params.append("native", id);
      }
      const res = await fetch(`/api/search/adhoc?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Search failed");
      setReleases(Array.isArray(data.results) ? data.results : []);
      setStats(Array.isArray(data.indexers) ? data.indexers : []);
      setTotal(typeof data.total === "number" ? data.total : 0);
      setGrabbedGuids(new Set());
    } catch (err: any) {
      setError(err.message ?? "Search failed");
    } finally {
      setLoading(false);
    }
  }

  const indexerNames = React.useMemo(() => {
    if (!releases) return [];
    return Array.from(new Set(releases.map((r) => r.indexerName))).sort();
  }, [releases]);

  const filtered = React.useMemo(() => {
    if (!releases) return [];
    let list = releases;
    if (protocol !== "all") list = list.filter((r) => r.protocol === protocol);
    if (indexerFilter !== "all") list = list.filter((r) => r.indexerName === indexerFilter);
    if (minSeeders > 0) list = list.filter((r) => r.protocol !== "torrent" || r.seeders >= minSeeders);
    if (textFilter) {
      const q = textFilter.toLowerCase();
      list = list.filter((r) => r.title.toLowerCase().includes(q));
    }
    const sorted = [...list];
    switch (sortBy) {
      case "seeders":
        sorted.sort((a, b) => b.seeders - a.seeders);
        break;
      case "size":
        sorted.sort((a, b) => b.size - a.size);
        break;
      default:
        sorted.sort((a, b) => effectiveAgeHours(a) - effectiveAgeHours(b));
    }
    return sorted;
  }, [releases, protocol, indexerFilter, minSeeders, sortBy, textFilter]);

  async function handleGrab(release: AdhocRelease) {
    setGrabbingGuid(release.guid);
    try {
      const res = await fetch("/api/search/grab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(release),
      });
      const data = await res.json();
      const ok = !!data.success;
      const message: string = data.message ?? (ok ? `Grabbed ${release.title}` : "Grab failed");
      if (ok) setGrabbedGuids((prev) => new Set(prev).add(release.guid));
      setNotice({ message, ok });
    } catch (err: any) {
      setNotice({ message: err.message ?? "Grab failed", ok: false });
    } finally {
      setGrabbingGuid(null);
    }
  }

  const noSources = pickersReady && (prowlarrIndexers?.length ?? 0) === 0 && nativeIndexers.length === 0;

  return (
    <div className="space-y-4">
      <GlassPanel className="p-5">
        <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-signal">// Indexer Search</span>
        <h2 className="font-display text-2xl font-bold text-white mb-1">Ad hoc search</h2>
        <p className="text-muted-foreground text-sm mb-4">
          Query any configured indexer directly — no show or release attached. Grab sends the release to your download client.
        </p>

        {/* Presets */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Select
            value={activePresetId ?? ""}
            onValueChange={(v) => {
              const p = presets.find((p) => p.id === v);
              if (p) applyPreset(p);
            }}
          >
            <SelectTrigger size="sm" className="w-48">
              <SelectValue placeholder={presets.length === 0 ? "No presets yet" : "Apply preset…"} />
            </SelectTrigger>
            <SelectContent>
              {presets.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Preset name…"
            value={presetName}
            onChange={(e) => { setPresetName(e.target.value); }}
            className="h-8 w-40 text-xs"
          />
          <Button variant="outline" size="sm" onClick={savePreset} disabled={!presetName.trim() || savingPreset} title="Save current query + config as a preset (same name overwrites)">
            {savingPreset ? <Loader2Icon className="size-3.5 animate-spin" /> : <SaveIcon className="size-3.5" />}
            Save preset
          </Button>
          {activePresetId && (
            <Button variant="outline" size="sm" onClick={deletePreset} title="Delete the active preset">
              <Trash2Icon className="size-3.5" />
            </Button>
          )}
        </div>

        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); runSearch(); }}
        >
          <Input
            placeholder="Search indexers… (e.g. Dandadan S01 1080p)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 text-sm"
          />
          <Button type="submit" size="sm" className="h-9 shrink-0" disabled={loading || !query.trim()}>
            {loading ? <Loader2Icon className="size-3.5 animate-spin" /> : <SearchIcon className="size-3.5" />}
            Search
          </Button>
        </form>

        {/* Query config */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Select value={searchType} onValueChange={(v) => setSearchType(v as SearchType)}>
            <SelectTrigger size="sm" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="search">Generic</SelectItem>
              <SelectItem value="tvsearch">TV</SelectItem>
              <SelectItem value="movie">Movie</SelectItem>
              <SelectItem value="music">Music</SelectItem>
              <SelectItem value="book">Book</SelectItem>
            </SelectContent>
          </Select>

          <Select value={limit} onValueChange={setLimit}>
            <SelectTrigger size="sm" className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="25">25 max</SelectItem>
              <SelectItem value="50">50 max</SelectItem>
              <SelectItem value="100">100 max</SelectItem>
              <SelectItem value="200">200 max</SelectItem>
            </SelectContent>
          </Select>

          <span className="font-mono text-caption uppercase tracking-wider text-muted-foreground ml-1">Categories</span>
          {CATEGORY_PRESETS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => toggleCategory(c.id)}
              className={cn(
                "rounded-md px-2.5 py-1.5 font-mono text-xs transition-colors",
                categories.includes(c.id)
                  ? "bg-signal/15 text-signal shadow-[inset_0_0_0_0.5px_var(--signal)]"
                  : "bg-white/[0.04] text-muted-foreground hover:bg-white/[0.07]",
              )}
              title={`Newznab category ${c.id}`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* Indexer picker */}
        <div className="mt-3 space-y-2">
          {prowlarrIndexers === null || !pickersReady ? (
            <p className="text-muted-foreground flex items-center gap-2 text-xs">
              <Loader2Icon className="size-3.5 animate-spin" /> Loading indexers…
            </p>
          ) : noSources ? (
            <div className="flex items-center gap-3 rounded-lg border border-white/10 p-3">
              <p className="text-muted-foreground flex-1 text-sm">No indexers configured — connect Prowlarr or enable a native indexer first.</p>
              <Button variant="outline" size="sm" onClick={onOpenSettings}>
                <SettingsIcon className="size-3.5" /> Configure
              </Button>
            </div>
          ) : (
            <>
              {(prowlarrIndexers?.length ?? 0) > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-caption uppercase tracking-wider text-muted-foreground mr-1">Prowlarr</span>
                  {prowlarrIndexers!.map((ix) => (
                    <button
                      key={ix.id}
                      type="button"
                      onClick={() => toggleProwlarr(ix.id)}
                      className={cn(
                        "rounded-md px-2.5 py-1.5 font-mono text-xs transition-colors",
                        pickedProwlarr.includes(ix.id)
                          ? "bg-signal/15 text-signal shadow-[inset_0_0_0_0.5px_var(--signal)]"
                          : "bg-white/[0.04] text-muted-foreground hover:bg-white/[0.07]",
                      )}
                      title={ix.enabled ? ix.name : `${ix.name} (disabled in Prowlarr)`}
                    >
                      {ix.name}
                    </button>
                  ))}
                </div>
              )}
              {nativeIndexers.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-caption uppercase tracking-wider text-muted-foreground mr-1">Native</span>
                  {nativeIndexers.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => toggleNative(n.id)}
                      className={cn(
                        "rounded-md px-2.5 py-1.5 font-mono text-xs transition-colors",
                        pickedNative.includes(n.id)
                          ? "bg-signal/15 text-signal shadow-[inset_0_0_0_0.5px_var(--signal)]"
                          : "bg-white/[0.04] text-muted-foreground hover:bg-white/[0.07]",
                      )}
                    >
                      {n.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </GlassPanel>

      {/* Per-indexer stats */}
      {stats.length > 0 && (
        <Panel className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5">
          {stats.map((s) => (
            <span
              key={s.key}
              className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground"
              title={s.error ?? `${s.count} result(s) in ${s.ms}ms`}
            >
              <span className={cn("size-1.5 rounded-full", s.ok ? "bg-emerald-400" : "bg-red-400")} />
              <span className="text-foreground/80">{s.name}</span>
              <span className="tabular-nums">{s.count} · {s.ms}ms</span>
              {!s.ok && <span className="text-red-400 max-w-[240px] truncate">{s.error}</span>}
            </span>
          ))}
          <span className="ml-auto font-mono text-caption uppercase tracking-wider text-muted-foreground">
            {total} total
          </span>
        </Panel>
      )}

      {notice && (
        <div className={cn("flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm", notice.ok ? "border-emerald-500/20 text-emerald-300" : "border-red-500/20 text-red-300")}>
          {notice.ok ? <CheckIcon className="size-4 shrink-0" /> : <XIcon className="size-4 shrink-0" />}
          <span className="truncate" title={notice.message}>{notice.message}</span>
        </div>
      )}

      {/* Results */}
      <Panel className="rounded-lg border border-white/10">
        <div className="flex items-center gap-2 flex-wrap border-b border-white/5 px-3 py-2">
          <Input
            placeholder="Filter titles..."
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
            className="h-8 w-48 text-xs"
          />
          <Select value={protocol} onValueChange={(v) => setProtocol(v as ProtocolFilter)}>
            <SelectTrigger size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All protocols</SelectItem>
              <SelectItem value="torrent">Torrent</SelectItem>
              <SelectItem value="usenet">Usenet</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortKey)}>
            <SelectTrigger size="sm" className="w-32">
              <ArrowDownUp className="size-3.5 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="age">Newest</SelectItem>
              <SelectItem value="seeders">Seeders</SelectItem>
              <SelectItem value="size">Size</SelectItem>
            </SelectContent>
          </Select>
          {indexerNames.length > 1 && (
            <Select value={indexerFilter} onValueChange={setIndexerFilter}>
              <SelectTrigger size="sm" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All indexers</SelectItem>
                {indexerNames.map((name) => (
                  <SelectItem key={name} value={name}>{name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-caption uppercase tracking-wider text-muted-foreground">Seeds</span>
            <Input
              type="number"
              min={0}
              value={minSeeders}
              onChange={(e) => setMinSeeders(Math.max(0, parseInt(e.target.value, 10) || 0))}
              className="h-8 w-14 px-2 text-xs"
            />
          </div>
          {releases !== null && !loading && (
            <span className="ml-auto font-mono text-caption uppercase tracking-wider text-muted-foreground">
              {filtered.length} shown
            </span>
          )}
        </div>
        <ScrollArea className="h-[52vh] w-full">
          <div className="flex flex-col divide-y divide-white/5 w-full min-w-0">
            {loading && (
              <div className="text-muted-foreground flex items-center gap-2 p-6 text-sm">
                <Loader2Icon className="size-4 animate-spin" /> Searching indexers...
              </div>
            )}
            {!loading && error && (
              <div className="flex items-center gap-2 p-6 text-sm text-red-400">
                <XIcon className="size-4 shrink-0" /> {error}
              </div>
            )}
            {!loading && !error && releases === null && (
              <p className="text-muted-foreground p-6 text-sm">Run a search above — results land here with a Grab button each.</p>
            )}
            {!loading && !error && releases !== null && filtered.length === 0 && (
              <p className="text-muted-foreground p-6 text-sm">
                {releases.length === 0 ? "No releases found." : "No releases match the current filters."}
              </p>
            )}
            {!loading && !error && filtered.map((release) => {
              const isGrabbing = grabbingGuid === release.guid;
              const isGrabbed = grabbedGuids.has(release.guid);
              return (
                <div
                  key={`${release.indexerId}-${release.guid}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 p-3 min-w-0"
                >
                  <div className="min-w-0 overflow-hidden">
                    <p className="truncate max-w-full overflow-hidden text-sm font-medium leading-snug text-foreground/90" title={release.title}>
                      {release.title}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-caption text-muted-foreground min-w-0 max-w-full overflow-hidden">
                      <Badge variant="outline" className="uppercase">{release.protocol}</Badge>
                      {release.isPack && (
                        <Badge variant="amber"><PackageIcon className="size-3" /> Pack</Badge>
                      )}
                      <span>{formatBytes(release.size)}</span>
                      {release.protocol === "torrent" ? (
                        <span>
                          <span className="text-emerald-400">{release.seeders}</span>
                          {" / "}
                          <span className="text-red-400/80">{release.leechers}</span>
                        </span>
                      ) : (
                        <span>{release.grabs} grabs</span>
                      )}
                      <span>{formatAge(effectiveAgeHours(release))} ago</span>
                      <span className="truncate min-w-0 max-w-[160px]" title={release.indexerName}>{release.indexerName}</span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={isGrabbed ? "outline" : "default"}
                    onClick={() => handleGrab(release)}
                    disabled={isGrabbing}
                    className="shrink-0 whitespace-nowrap"
                  >
                    {isGrabbing ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : isGrabbed ? (
                      <CheckIcon className="size-3.5" />
                    ) : (
                      <DownloadIcon className="size-3.5" />
                    )}
                    {isGrabbed ? "Grabbed" : "Grab"}
                  </Button>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </Panel>
    </div>
  );
}

export { IndexerSearch };
