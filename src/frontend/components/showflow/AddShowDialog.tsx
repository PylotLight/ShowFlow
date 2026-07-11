import { Loader2, PlusIcon, SearchIcon } from "lucide-react";
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
  const [adding, setAdding] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

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
        setResults(await res.json());
      } catch (err: any) {
        setError(err.message);
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(timeout);
  }, [query, source]);

  async function handleAdd(result: SearchResult) {
    setAdding(result.id);
    setError(null);
    try {
      const res = await fetch("/api/shows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, providerId: result.id, name: result.title }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to add show");
      setOpen(false);
      setQuery("");
      setResults([]);
      onAdded();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAdding(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default" size="sm">
          <PlusIcon /> Add Show
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a show</DialogTitle>
          <DialogDescription>Search a provider and pick the right match.</DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Select value={source} onValueChange={(v) => setSource(v as typeof source)}>
            <SelectTrigger className="w-32 shrink-0">
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

        {error && <p className="text-destructive text-sm">{error}</p>}

        <ScrollArea className="h-80 rounded-lg border border-white/10">
          <div className="flex flex-col divide-y divide-white/5">
            {searching && (
              <div className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
                <Loader2 className="size-4 animate-spin" /> Searching {source}...
              </div>
            )}
            {!searching && query.trim() && results.length === 0 && (
              <p className="text-muted-foreground p-4 text-sm">No results for &ldquo;{query}&rdquo;.</p>
            )}
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => handleAdd(r)}
                disabled={adding !== null}
                className={cn(
                  "hover:bg-white/5 flex items-center gap-3 p-3 text-left transition-colors disabled:opacity-50",
                )}
              >
                <PosterImage source={source} id={r.id} alt={r.title} className="h-16 w-11 shrink-0 rounded-sm" />
                <div className="flex-1">
                  <p className="text-sm font-medium">{r.title}</p>
                  <p className="text-muted-foreground font-mono text-xs">
                    {r.year ?? "—"} · #{r.id}
                  </p>
                </div>
                {r.existingShowId && (
                  <span className="text-emerald-400 font-mono text-[10px]">Already added</span>
                )}
                {adding === r.id ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <PlusIcon className="text-muted-foreground size-4" />
                )}
              </button>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

export { AddShowDialog };
