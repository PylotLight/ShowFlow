import {
  ArrowDownUp,
  Ban,
  CheckIcon,
  DownloadIcon,
  FilterIcon,
  Loader2Icon,
  PackageIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";

import { Badge } from "@frontend/components/ui/badge";
import { Button } from "@frontend/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@frontend/components/ui/dialog";
import { Input } from "@frontend/components/ui/input";
import { ScrollArea } from "@frontend/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { cn } from "@frontend/lib/utils";

export interface ReleaseScore {
  rank: number;
  formatScore: number;
  totalScore: number;
  qualityId?: string;
  qualityName?: string;
  matchedTags?: string[];
}

export interface Release {
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
  raw: Record<string, unknown>;
  score: ReleaseScore;
}

type SortKey = "score" | "seeders" | "size" | "age";
type ProtocolFilter = "all" | "torrent" | "usenet";

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

function formatAge(hours: number): string {
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  const months = days / 30;
  if (months < 12) return `${Math.round(months)}mo`;
  return `${Math.round(months / 12)}y`;
}

function ScoreBadge({ score }: { score: ReleaseScore }) {
  if (score.totalScore === -1) {
    return (
      <Badge variant="outline" className="border-red-500/30 text-red-400">
        <Ban className="size-3" /> Blocked
      </Badge>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 font-mono text-xs tabular-nums">
      <span className="text-foreground/70">{score.rank}</span>
      {score.formatScore > 0 && (
        <span className="text-emerald-400">+{score.formatScore}</span>
      )}
    </span>
  );
}

interface ReleaseSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showId: string;
  showTitle: string;
  season: number;
  episode?: number;
  onGrabbed?: (message: string) => void;
}

function ReleaseSearchDialog({
  open,
  onOpenChange,
  showId,
  showTitle,
  season,
  episode,
  onGrabbed,
}: ReleaseSearchDialogProps) {
  const isSeasonScope = episode == null;

  const [releases, setReleases] = React.useState<Release[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [protocol, setProtocol] = React.useState<ProtocolFilter>("all");
  const [sortBy, setSortBy] = React.useState<SortKey>("score");
  const [minSeeders, setMinSeeders] = React.useState(0);
  const [indexerFilter, setIndexerFilter] = React.useState("all");
  const [packsOnly, setPacksOnly] = React.useState(false);
  const [qualityFilter, setQualityFilter] = React.useState("all");
  const [textFilter, setTextFilter] = React.useState("");

  const [grabbingGuid, setGrabbingGuid] = React.useState<string | null>(null);
  const [grabbedGuids, setGrabbedGuids] = React.useState<Set<string>>(new Set());

  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    setReleases(null);
    const path = isSeasonScope
      ? `/api/shows/${showId}/seasons/${season}/search`
      : `/api/shows/${showId}/seasons/${season}/episodes/${episode}/search`;
    fetch(path)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Search failed");
        setReleases(data.releases);
      })
      .catch((err: any) => setError(err.message ?? "Search failed"))
      .finally(() => setLoading(false));
  }, [showId, season, episode, isSeasonScope]);

  React.useEffect(() => {
    if (!open) return;
    setGrabbedGuids(new Set());
    load();
  }, [open, load]);

  const indexerNames = React.useMemo(() => {
    if (!releases) return [];
    return Array.from(new Set(releases.map((r) => r.indexerName))).sort();
  }, [releases]);

  const qualityNames = React.useMemo(() => {
    if (!releases) return [];
    return Array.from(new Set(releases.map((r) => r.score.qualityName).filter(Boolean))).sort() as string[];
  }, [releases]);

  const filtered = React.useMemo(() => {
    if (!releases) return [];
    let list = releases;
    if (protocol !== "all") list = list.filter((r) => r.protocol === protocol);
    if (indexerFilter !== "all") list = list.filter((r) => r.indexerName === indexerFilter);
    if (minSeeders > 0) list = list.filter((r) => r.protocol !== "torrent" || r.seeders >= minSeeders);
    if (isSeasonScope && packsOnly) list = list.filter((r) => r.isPack);
    if (qualityFilter !== "all") list = list.filter((r) => r.score.qualityName === qualityFilter);
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
      case "age":
        sorted.sort((a, b) => a.ageHours - b.ageHours);
        break;
      default:
        sorted.sort((a, b) => b.score.totalScore - a.score.totalScore);
    }
    return sorted;
  }, [releases, protocol, indexerFilter, minSeeders, packsOnly, isSeasonScope, sortBy, qualityFilter, textFilter]);

  async function handleGrab(release: Release) {
    setGrabbingGuid(release.guid);
    try {
      const res = await fetch("/api/search/grab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(release),
      });
      const data = await res.json();
      const message: string = data.message ?? (data.success ? `Grabbed ${release.title}` : "Grab failed");
      if (data.success) {
        setGrabbedGuids((prev) => new Set(prev).add(release.guid));
      }
      onGrabbed?.(message);
    } catch (err: any) {
      onGrabbed?.(err.message ?? "Grab failed");
    } finally {
      setGrabbingGuid(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] w-[95vw] max-h-[90vh] h-[90vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Search Releases</DialogTitle>
          <DialogDescription>
            {showTitle} ·{" "}
            {isSeasonScope
              ? `Season ${season} (packs & episodes)`
              : `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
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
              <SelectItem value="score">Best match</SelectItem>
              <SelectItem value="seeders">Seeders</SelectItem>
              <SelectItem value="size">Size</SelectItem>
              <SelectItem value="age">Newest</SelectItem>
            </SelectContent>
          </Select>

          {indexerNames.length > 1 && (
            <Select value={indexerFilter} onValueChange={setIndexerFilter}>
              <SelectTrigger size="sm" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All indexers</SelectItem>
                {indexerNames.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {qualityNames.length > 1 && (
            <Select value={qualityFilter} onValueChange={setQualityFilter}>
              <SelectTrigger size="sm" className="w-32">
                <FilterIcon className="size-3.5 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All qualities</SelectItem>
                {qualityNames.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
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

          {isSeasonScope && (
            <button
              type="button"
              onClick={() => setPacksOnly((v) => !v)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-mono text-xs transition-colors",
                packsOnly
                  ? "bg-signal/15 text-signal shadow-[inset_0_0_0_0.5px_var(--signal)]"
                  : "bg-white/[0.04] text-muted-foreground hover:bg-white/[0.07]",
              )}
            >
              <PackageIcon className="size-3.5" /> Packs only
            </button>
          )}

          <Button variant="outline" size="sm" className="ml-auto" onClick={load} disabled={loading}>
            {loading ? <Loader2Icon className="size-3.5 animate-spin" /> : <SearchIcon className="size-3.5" />}
            Refresh
          </Button>
        </div>

        <ScrollArea className="flex-1 min-h-0 mt-3 rounded-lg border border-white/10">
          <div className="flex flex-col divide-y divide-white/5">
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
            {!loading && !error && releases !== null && filtered.length === 0 && (
              <p className="text-muted-foreground p-6 text-sm">
                {releases.length === 0 ? "No releases found." : "No releases match the current filters."}
              </p>
            )}
            {!loading &&
              !error &&
              filtered.map((release) => {
                const isGrabbing = grabbingGuid === release.guid;
                const isGrabbed = grabbedGuids.has(release.guid);
                const blocked = release.score.totalScore === -1;
                return (
                  <div
                    key={`${release.indexerId}-${release.guid}`}
                    className={cn("flex items-start gap-3 p-3", blocked && "opacity-60")}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium leading-snug text-foreground/90" title={release.title}>
                        {release.title}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-caption text-muted-foreground">
                        <Badge variant="outline" className="uppercase">
                          {release.protocol}
                        </Badge>
                        {release.isPack && (
                          <Badge variant="amber">
                            <PackageIcon className="size-3" /> Pack
                          </Badge>
                        )}
                        {release.score.qualityName && (
                          <Badge variant="muted">{release.score.qualityName}</Badge>
                        )}
                        {release.score.matchedTags && release.score.matchedTags.length > 0 && (
                          <span className="text-muted-foreground/50 text-[10px] font-mono truncate max-w-[200px]">
                            {release.score.matchedTags.filter(t => t !== release.score.qualityName).join(" · ")}
                          </span>
                        )}
                        <ScoreBadge score={release.score} />
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
                        <span>{formatAge(release.ageHours)} ago</span>
                        <span className="truncate">{release.indexerName}</span>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={isGrabbed ? "outline" : "default"}
                      onClick={() => handleGrab(release)}
                      disabled={isGrabbing}
                      className="shrink-0"
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
      </DialogContent>
    </Dialog>
  );
}

export { ReleaseSearchDialog };
