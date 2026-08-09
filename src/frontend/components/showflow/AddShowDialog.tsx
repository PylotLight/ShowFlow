import {
  CheckIcon,
  ClapperboardIcon,
  ExternalLinkIcon,
  FilmIcon,
  Loader2,
  PlusIcon,
  SearchIcon,
  StarIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";

import { Button } from "@frontend/components/ui/button";
import { Badge } from "@frontend/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@frontend/components/ui/dialog";
import { Input } from "@frontend/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { ScrollArea } from "@frontend/components/ui/scroll-area";
import { Separator } from "@frontend/components/ui/separator";
import { PosterImage } from "@frontend/components/showflow/PosterImage";
import { cn } from "@frontend/lib/utils";

interface SearchResult {
  id: string;
  title: string;
  originalTitle?: string | null;
  romanizedTitle?: string | null;
  year?: number;
  providerType: string;
  posterUrl?: string;
  backdropUrl?: string;
  existingShowId?: string | null;
  overview?: string | null;
  type?: string | null;
  rating?: number | null;
  status?: string | null;
}

interface ShowDetail {
  id: string;
  title: string;
  originalTitle?: string | null;
  romanizedTitle?: string | null;
  year?: number;
  providerType: string;
  posterUrl?: string;
  backdropUrl?: string;
  overview?: string | null;
  genres?: string[] | null;
  rating?: number | null;
  status?: string | null;
  type?: string | null;
  episodeCount?: number | null;
  seasonCount?: number | null;
  creators?: string[] | null;
  networks?: string[] | null;
  firstAirDate?: string | null;
  seasons?: { id: string; number: number; name?: string }[];
  links?: { label: string; url: string }[];
}

function stripHtml(input?: string | null): string {
  if (!input) return "";
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatRating(rating?: number | null): string | null {
  if (typeof rating !== "number") return null;
  return rating.toFixed(1);
}

type ProviderId = "tvdb" | "tmdb" | "anilist";

const SOURCE_OPTIONS: { id: ProviderId; label: string }[] = [
  { id: "tvdb", label: "TVDB" },
  { id: "tmdb", label: "TMDB" },
  { id: "anilist", label: "AniList" },
];

function AddShowDialog({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [source, setSource] = React.useState<ProviderId>("tvdb");
  const [availableSources, setAvailableSources] = React.useState<ProviderId[]>([]);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [libraryTypes, setLibraryTypes] = React.useState<{ id: string; name: string }[]>([]);
  const [selectedLibraryTypeId, setSelectedLibraryTypeId] = React.useState("");

  const [qualityProfiles, setQualityProfiles] = React.useState<{ id: string; name: string }[]>([]);
  const [selectedQualityProfile, setSelectedQualityProfile] = React.useState("");

  const [seriesType, setSeriesType] = React.useState<string>("standard");
  const [showProfiles, setShowProfiles] = React.useState<{ id: string; name: string; root_folder_path: string }[]>([]);
  const [selectedShowProfileId, setSelectedShowProfileId] = React.useState<string>("");
  const [selectedItems, setSelectedItems] = React.useState<Map<string, SearchResult>>(new Map());

  const [activeItem, setActiveItem] = React.useState<SearchResult | null>(null);
  const [detail, setDetail] = React.useState<ShowDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState<string | null>(null);

  const [processing, setProcessing] = React.useState<{
    status: "idle" | "processing" | "done";
    results: { id: string; title: string; ok: boolean; error?: string }[];
  }>({ status: "idle", results: [] });

  function findProfileForType(type: string): string {
    if (!showProfiles.length) return "";
    const matched = showProfiles.find(p => p.name.toLowerCase() === type.toLowerCase());
    return matched?.id ?? showProfiles[0]?.id ?? "";
  }

  React.useEffect(() => {
    if (!open) return;
    setSelectedItems(new Map());
    setQuery("");
    setResults([]);
    setError(null);
    setActiveItem(null);
    setDetail(null);
    fetch("/api/providers").then(r => r.json()).then(data => {
      const configured = Array.isArray(data)
        ? data.filter((p: any) => p?.configured).map((p: any) => p.id as ProviderId)
        : [];
      setAvailableSources(configured);
      if (configured.length > 0) {
        const first = configured[0]!;
        const next: ProviderId = configured.includes(source) ? source! : first;
        setSource(next);
        setSeriesType(next === "anilist" ? "anime" : "standard");
      }
    }).catch(() => setAvailableSources([]));
    fetch("/api/library-types").then(r => r.json()).then(data => {
      const list = Array.isArray(data) ? data : [];
      setLibraryTypes(list);
      if (list.length > 0) {
        const defaultType = list.find((t: any) => t.is_default === 1) || list[0];
        setSelectedLibraryTypeId(defaultType.id);
        setSelectedQualityProfile("");
      }
    }).catch(() => {});
    fetch("/api/profiles").then(r => r.json()).then(data => {
      const list = Array.isArray(data) ? data : [];
      setQualityProfiles(list);
      if (list.length > 0 && !list.some(p => p.id === selectedQualityProfile)) {
        setSelectedQualityProfile(list[0].id);
      }
    }).catch(() => {});
    fetch("/api/show-profiles").then(r => r.json()).then(data => {
      const list = Array.isArray(data) ? data : [];
      setShowProfiles(list);
    }).catch(() => {});
  }, [open, source]);

  React.useEffect(() => {
    setSelectedShowProfileId(findProfileForType(seriesType));
  }, [seriesType, showProfiles]);

  React.useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    setError(null);
    const timeout = setTimeout(async () => {
      try {
        const res = await fetch(`/api/providers/${source}/search?q=${encodeURIComponent(query)}`);
        if (!res.ok) throw new Error((await res.json()).error ?? "Search failed");
        const data = await res.json();
        setResults(data);
        setActiveItem(data[0] ?? null);
      } catch (err: any) {
        setError(err.message);
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(timeout);
  }, [query, source]);

  React.useEffect(() => {
    if (!activeItem || activeItem.existingShowId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    fetch(`/api/providers/${source}/show/${activeItem.id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load details");
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setDetail(data as ShowDetail);
      })
      .catch((err: any) => {
        if (!cancelled) setDetailError(err.message ?? "Failed to load details");
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeItem, source]);

  function toggleSelect(item: SearchResult) {
    setSelectedItems(prev => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });
  }

  async function handleBulkAdd() {
    const items = [...selectedItems.values()];
    if (items.length === 0) return;

    setProcessing({ status: "processing", results: [] });

    const results: { id: string; title: string; ok: boolean; error?: string }[] = [];

    for (const item of items) {
      let ok = false;
      let error: string | undefined;
      try {
        const res = await fetch("/api/shows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source,
            providerId: item.id,
            name: item.title,
            profile: selectedLibraryTypeId ? undefined : (selectedQualityProfile || undefined),
            seriesType,
            showProfileId: selectedShowProfileId || undefined,
            libraryTypeId: selectedLibraryTypeId || undefined,
          }),
        });
        if (res.ok) {
          ok = true;
        } else {
          const body = await res.json().catch(() => ({}));
          error = body.error || res.statusText;
        }
      } catch (err: any) {
        error = err.message ?? "Unknown error";
      }
      results.push({ id: item.id, title: item.title, ok, error });
      setProcessing({ status: "processing", results: [...results] });
      await new Promise(r => setTimeout(r, 300));
    }

    setProcessing({ status: "done", results });
    setSelectedItems(new Map());
    onAdded();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setSelectedItems(new Map()); setProcessing({ status: "idle", results: [] }); }}}>
      <DialogTrigger asChild>
        <Button variant="default" size="sm">
          <PlusIcon /> Add Show
        </Button>
      </DialogTrigger>
      <DialogContent className="flex h-[90vh] max-w-6xl flex-col gap-4 p-6">
        <DialogHeader>
          <DialogTitle>Add shows</DialogTitle>
          <DialogDescription>Search a provider, preview shows, select the ones you want, then add them all at once.</DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Select value={source} onValueChange={(v) => { setSource(v as ProviderId); setSeriesType(v === "anilist" ? "anime" : "standard"); }}>
            <SelectTrigger className="w-28 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCE_OPTIONS.filter(o => availableSources.includes(o.id)).map(o => (
                <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative flex-1">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
              autoFocus
              placeholder="Search by title..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {libraryTypes.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Type</span>
              <Select value={selectedLibraryTypeId} onValueChange={setSelectedLibraryTypeId}>
                <SelectTrigger className="w-28 h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {libraryTypes.map(t => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {libraryTypes.length <= 1 && qualityProfiles.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Quality</span>
              <Select value={selectedQualityProfile} onValueChange={setSelectedQualityProfile}>
                <SelectTrigger className="w-32 h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {qualityProfiles.map(p => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Series</span>
            <Select value={seriesType} onValueChange={setSeriesType}>
              <SelectTrigger className="w-28 h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="standard">Standard</SelectItem>
                <SelectItem value="anime">Anime</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {error && <p className="text-destructive text-sm">{error}</p>}

        {processing.status !== "idle" ? (
          <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-white/10 overflow-hidden">
            <div className="h-1 bg-white/5">
              <div
                className="h-full bg-signal transition-all duration-300"
                style={{ width: `${(processing.results.length / Math.max(selectedItems.size, 1)) * 100}%` }}
              />
            </div>
            <div className="flex flex-col divide-y divide-white/5 min-h-0 flex-1 overflow-y-auto">
              {processing.results.map((r) => (
                <div key={r.id} className="flex items-center gap-3 p-3">
                  {r.ok ? (
                    <CheckIcon className="size-4 text-emerald-500 shrink-0" />
                  ) : processing.status === "processing" ? (
                    <Loader2 className="size-4 text-muted-foreground animate-spin shrink-0" />
                  ) : (
                    <XIcon className="size-4 text-red-400 shrink-0" />
                  )}
                  <span className="text-sm truncate flex-1">{r.title}</span>
                  {!r.ok && r.error && (
                    <span className="text-[10px] text-red-400 font-mono truncate max-w-[160px] shrink-0">{r.error}</span>
                  )}
                </div>
              ))}
            </div>
            {processing.status === "done" && (
              <div className="border-t border-white/5 px-3 py-2 text-xs font-mono text-muted-foreground">
                {processing.results.filter(r => r.ok).length} of {processing.results.length} added
              </div>
            )}
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden md:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
            {/* Results pane */}
            <ScrollArea className="h-full w-full rounded-lg border border-white/10 overflow-hidden">
              <div className="flex flex-col divide-y divide-white/5 overflow-hidden">
                {searching && (
                  <div className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
                    <Loader2 className="size-4 animate-spin" /> Searching {source}...
                  </div>
                )}
                {!searching && query.trim() && results.length === 0 && (
                  <p className="text-muted-foreground p-4 text-sm">No results for &ldquo;{query}&rdquo;.</p>
                )}
                {results.map((r) => {
                  const isSelected = selectedItems.has(r.id);
                  const disabled = !!r.existingShowId;
                  const isActive = activeItem?.id === r.id;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => {
                        if (disabled) { setActiveItem(r); return; }
                        setActiveItem(r);
                        toggleSelect(r);
                      }}
                      disabled={disabled}
                      className={cn(
                        "min-w-0 flex items-center gap-3 p-3 text-left transition-colors disabled:opacity-50",
                        isActive ? "bg-signal/10" : "hover:bg-white/5",
                      )}
                    >
                      <div
                        role="checkbox"
                        aria-checked={isSelected}
                        onClick={(e) => { if (!disabled) { e.stopPropagation(); toggleSelect(r); } }}
                        className={cn(
                          "size-5 shrink-0 rounded border-2 grid place-items-center transition-colors cursor-pointer",
                          isSelected ? "border-signal bg-signal" : "border-white/20",
                        )}
                      >
                        {isSelected && <CheckIcon className="size-3 text-white" />}
                      </div>
                      <PosterImage source={source} id={r.id} alt={r.title} className="h-20 w-14 shrink-0 rounded-sm" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{r.title}</p>
                        <p className="text-muted-foreground font-mono text-xs truncate">
                          {r.year ?? "—"} · #{r.id}
                          {r.type ? ` · ${r.type}` : ""}
                        </p>
                        {(r.rating != null || r.status) && (
                          <p className="mt-0.5 flex items-center gap-2 text-xs">
                            {r.rating != null && (
                              <span className="inline-flex items-center gap-1 text-amber-400">
                                <StarIcon className="size-3 fill-amber-400" /> {formatRating(r.rating)}
                              </span>
                            )}
                            {r.status && <span className="text-muted-foreground truncate">{r.status}</span>}
                          </p>
                        )}
                        {r.overview && (
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{stripHtml(r.overview)}</p>
                        )}
                      </div>
                      {r.existingShowId && (
                        <span className="text-emerald-400 font-mono text-[10px] shrink-0">Already added</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </ScrollArea>

            {/* Detail pane */}
            <div className="hidden min-h-0 flex-col rounded-lg border border-white/10 overflow-hidden md:flex">
              {!activeItem ? (
                <div className="text-muted-foreground flex flex-1 items-center justify-center p-6 text-center text-sm">
                  Select a show to preview its details.
                </div>
              ) : activeItem.existingShowId ? (
                <div className="flex flex-1 items-center justify-center p-6 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <CheckIcon className="size-8 text-emerald-500" />
                    <p className="text-sm font-medium">{activeItem.title}</p>
                    <p className="text-muted-foreground text-xs">This show is already in your library.</p>
                  </div>
                </div>
              ) : detailLoading ? (
                <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin" /> Loading details...
                </div>
              ) : detailError ? (
                <div className="text-destructive flex flex-1 items-center justify-center p-6 text-center text-sm">
                  {detailError}
                </div>
              ) : detail ? (
                <DetailPane detail={detail} source={source} />
              ) : null}
            </div>
          </div>
        )}

        {processing.status === "idle" && (
          <div className="flex items-center justify-between pt-1">
            <span className="text-muted-foreground text-xs font-mono">
              {selectedItems.size > 0 ? <>{selectedItems.size} selected</> : null}
            </span>
            <Button
              size="sm"
              onClick={handleBulkAdd}
              disabled={selectedItems.size === 0}
              className="relative"
            >
              <PlusIcon className="size-3.5 mr-1.5" />
              Add Selected{selectedItems.size > 0 ? ` (${selectedItems.size})` : ''}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailPane({ detail, source }: { detail: ShowDetail; source: string }) {
  const overview = stripHtml(detail.overview);
  const rating = formatRating(detail.rating);
  const genres = detail.genres ?? [];
  const links = detail.links ?? [];
  const seasons = detail.seasons ?? [];

  return (
    <ScrollArea className="h-full w-full">
      <div className="flex flex-col">
        <div className="relative h-36 w-full shrink-0 overflow-hidden bg-muted">
          <img
            src={detail.backdropUrl}
            alt=""
            loading="lazy"
            className="size-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
        </div>

        <div className="-mt-12 flex items-end gap-4 px-4">
          <PosterImage source={source} id={detail.id} alt={detail.title} className="h-32 w-22 shrink-0 rounded-md border border-white/10 shadow-xl" />
          <div className="min-w-0 flex-1 pb-1">
            <h3 className="text-lg leading-tight font-semibold truncate">{detail.title}</h3>
            <p className="text-muted-foreground font-mono text-xs truncate">
              {detail.year ?? "—"}
              {detail.originalTitle && detail.originalTitle !== detail.title ? ` · ${detail.originalTitle}` : ""}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
          {rating != null && (
            <Badge variant="amber" className="gap-1">
              <StarIcon className="size-3 fill-amber-400" /> {rating}
            </Badge>
          )}
          {detail.status && <Badge variant="signal">{detail.status}</Badge>}
          {detail.type && <Badge variant="muted">{detail.type}</Badge>}
          {detail.seasonCount != null && (
            <Badge variant="muted" className="gap-1">
              <ClapperboardIcon /> {detail.seasonCount} season{detail.seasonCount === 1 ? "" : "s"}
            </Badge>
          )}
          {detail.episodeCount != null && (
            <Badge variant="muted" className="gap-1">
              <FilmIcon /> {detail.episodeCount} episode{detail.episodeCount === 1 ? "" : "s"}
            </Badge>
          )}
        </div>

        {genres.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pt-2">
            {genres.map(g => (
              <span key={g} className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-muted-foreground">
                {g}
              </span>
            ))}
          </div>
        )}

        {overview && (
          <div className="px-4 pt-3">
            <p className="text-sm leading-relaxed text-muted-foreground">{overview}</p>
          </div>
        )}

        <Separator className="my-3" />

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 pb-2 text-xs">
          {(detail.creators?.length ?? 0) > 0 && (
            <div className="min-w-0">
              <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {source === "anilist" ? "Studios" : "Created by"}
              </p>
              <p className="mt-0.5 truncate">{detail.creators!.join(", ")}</p>
            </div>
          )}
          {(detail.networks?.length ?? 0) > 0 && source !== "anilist" && (
            <div className="min-w-0">
              <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Network</p>
              <p className="mt-0.5 truncate">{detail.networks!.join(", ")}</p>
            </div>
          )}
          {detail.firstAirDate && (
            <div className="min-w-0">
              <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">First aired</p>
              <p className="mt-0.5 truncate">{detail.firstAirDate}</p>
            </div>
          )}
        </div>

        {seasons.length > 0 && (
          <>
            <Separator className="my-3" />
            <div className="px-4 pb-2">
              <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Seasons</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {seasons.map(s => (
                  <span
                    key={s.id}
                    className="rounded border border-white/10 px-2 py-1 text-xs"
                    title={s.name && s.name !== `Season ${s.number}` ? s.name : undefined}
                  >
                    {s.name && s.name !== `Season ${s.number}` ? s.name : `Season ${s.number}`}
                  </span>
                ))}
              </div>
            </div>
          </>
        )}

        {links.length > 0 && (
          <>
            <Separator className="my-3" />
            <div className="px-4 pb-4">
              <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Links</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {links.map(link => (
                  <a
                    key={link.url}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs transition-colors hover:bg-white/10 hover:text-white"
                  >
                    <ExternalLinkIcon className="size-3" />
                    {link.label}
                  </a>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </ScrollArea>
  );
}

export { AddShowDialog };
