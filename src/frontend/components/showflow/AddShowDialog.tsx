import { CheckIcon, Loader2, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@frontend/components/ui/button";
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
import { PosterImage } from "@frontend/components/showflow/PosterImage";
import { cn } from "@frontend/lib/utils";

interface SearchResult {
  id: string;
  title: string;
  year?: number;
  providerType: string;
  existingShowId?: string | null;
}

function AddShowDialog({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [source, setSource] = React.useState<"tvdb" | "tmdb" | "anilist">("tvdb");
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [qualityProfiles, setQualityProfiles] = React.useState<{ id: string; name: string }[]>([]);
  const [selectedQualityProfile, setSelectedQualityProfile] = React.useState("");

  const [seriesType, setSeriesType] = React.useState<string>("standard");
  const [showProfiles, setShowProfiles] = React.useState<{ id: string; name: string; root_folder_path: string }[]>([]);
  const [selectedShowProfileId, setSelectedShowProfileId] = React.useState<string>("");
  const [selectedItems, setSelectedItems] = React.useState<Map<string, SearchResult>>(new Map());
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
    setSeriesType(source === "anilist" ? "anime" : "standard");
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
      } catch (err: any) {
        setError(err.message);
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(timeout);
  }, [query, source]);

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
            profile: selectedQualityProfile || undefined,
            seriesType,
            showProfileId: selectedShowProfileId || undefined,
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
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add shows</DialogTitle>
          <DialogDescription>Search a provider, select shows, then add them all at once.</DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Select value={source} onValueChange={(v) => { setSource(v as typeof source); setSeriesType(v === "anilist" ? "anime" : "standard"); }}>
            <SelectTrigger className="w-28 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tvdb">TVDB</SelectItem>
              <SelectItem value="tmdb">TMDB</SelectItem>
              <SelectItem value="anilist">AniList</SelectItem>
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
          {qualityProfiles.length > 0 && (
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
            <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Type</span>
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
          <div className="rounded-lg border border-white/10 overflow-hidden">
            <div className="h-1 bg-white/5">
              <div
                className="h-full bg-signal transition-all duration-300"
                style={{ width: `${(processing.results.length / Math.max(selectedItems.size, 1)) * 100}%` }}
              />
            </div>
            <div className="flex flex-col divide-y divide-white/5 max-h-80 overflow-y-auto">
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
          <>
            <ScrollArea className="h-80 w-full rounded-lg border border-white/10 overflow-hidden">
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
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => { if (!disabled) toggleSelect(r); }}
                      disabled={disabled}
                      className={cn(
                        "min-w-0 flex items-center gap-3 p-3 text-left transition-colors disabled:opacity-50",
                        isSelected ? "bg-signal/10" : "hover:bg-white/5",
                      )}
                    >
                      <div className={cn(
                        "size-5 shrink-0 rounded border-2 grid place-items-center transition-colors",
                        isSelected ? "border-signal bg-signal" : "border-white/20",
                      )}>
                        {isSelected && <CheckIcon className="size-3 text-white" />}
                      </div>
                      <PosterImage source={source} id={r.id} alt={r.title} className="h-16 w-11 shrink-0 rounded-sm" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{r.title}</p>
                        <p className="text-muted-foreground font-mono text-xs">
                          {r.year ?? "—"} · #{r.id}
                        </p>
                      </div>
                      {r.existingShowId && (
                        <span className="text-emerald-400 font-mono text-[10px] shrink-0">Already added</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </ScrollArea>

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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export { AddShowDialog };
