import { Loader2, PlusIcon, SearchIcon, Trash2, Star, RefreshCw, ChevronDown, ChevronUp, Info } from "lucide-react";
import * as React from "react";

import { Button } from "@frontend/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@frontend/components/ui/dialog";
import { Input } from "@frontend/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@frontend/components/ui/tooltip";
import { cn } from "@frontend/lib/utils";

interface ProviderRoles {
  metadata: boolean;
  airtime: boolean;
}

interface ProviderSource {
  type: string;
  id: string;
  title: string | null;
  isPrimary: boolean;
  lastSynced: string | null;
  roles: ProviderRoles;
}

interface SearchResult {
  id: string;
  title: string;
  originalTitle?: string | null;
  romanizedTitle?: string | null;
  year?: number;
  providerType: string;
  posterUrl?: string;
  existingShowId?: string | null;
  overview?: string | null;
  type?: string | null;
}

function SearchResultRow({ result, onAdd }: { result: SearchResult; onAdd: (r: SearchResult) => void }) {
  const [expanded, setExpanded] = React.useState(false);

  const altTitles = [result.originalTitle, result.romanizedTitle].filter(Boolean) as string[];
  const uniqueAltTitles = [...new Set(altTitles.filter(t => t !== result.title))];

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-start gap-3 p-2.5 text-left text-sm hover:bg-white/5 transition-colors"
      >
        {result.posterUrl && (
          <img
            src={result.posterUrl}
            alt={result.title}
            className="w-9 h-[13.5px] shrink-0 rounded bg-white/5 object-cover mt-0.5"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="rounded bg-white/10 px-1 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider shrink-0">
              {result.providerType}
            </span>
            {result.year && (
              <span className="font-mono text-[10px] text-muted-foreground shrink-0">({result.year})</span>
            )}
          </div>
          <p className="mt-0.5 text-sm font-medium leading-tight">{result.title}</p>
          {uniqueAltTitles.length > 0 && !expanded && (
            <p className="text-[11px] text-muted-foreground truncate">{uniqueAltTitles.join(" · ")}</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0 pt-1">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onAdd(result); }}
            className="rounded-lg p-1.5 text-muted-foreground hover:text-white hover:bg-white/10 transition-colors"
            title="Add this source"
          >
            <PlusIcon className="size-3.5" />
          </button>
          <span className="text-muted-foreground/40">
            {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </span>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-white/5 px-3 py-2.5 space-y-1.5 text-xs">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <div>
              <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Provider ID</span>
              <p className="font-mono text-xs text-white/80">#{result.id}</p>
            </div>
            {result.year && (
              <div>
                <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Year</span>
                <p className="font-mono text-xs text-white/80">{result.year}</p>
              </div>
            )}
            {result.type && (
              <div>
                <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Format</span>
                <p className="font-mono text-xs text-white/80">{result.type}</p>
              </div>
            )}
          </div>
          {uniqueAltTitles.length > 0 && (
            <div>
              <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Also known as</span>
              {uniqueAltTitles.map((t, i) => (
                <p key={i} className="text-xs text-white/70">{t}</p>
              ))}
            </div>
          )}
          {result.overview && (
            <div>
              <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Overview</span>
              <p className="text-xs text-white/60 leading-relaxed line-clamp-4">{result.overview.replace(/<[^>]*>/g, '')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RoleToggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn(
        "rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-all cursor-pointer",
        active
          ? "bg-signal/15 text-signal"
          : "bg-white/[0.04] text-muted-foreground/50 hover:text-muted-foreground hover:bg-white/[0.07]",
      )}
    >
      {label}
    </button>
  );
}

function ManageSourcesDialog({
  showId,
  showTitle,
  open,
  onOpenChange,
  onSourcesChanged,
}: {
  showId: string;
  showTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSourcesChanged: () => void;
}) {
  const [sources, setSources] = React.useState<ProviderSource[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [searching, setSearching] = React.useState(false);
  const [addPanel, setAddPanel] = React.useState(false);
  const [searchType, setSearchType] = React.useState<"tmdb" | "tvdb" | "anilist">("tmdb");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searchResults, setSearchResults] = React.useState<SearchResult[]>([]);
  const [syncing, setSyncing] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch(`/api/shows/${showId}/providers`)
      .then(r => r.json())
      .then(setSources)
      .catch(() => setSources([]))
      .finally(() => setLoading(false));
  }, [open, showId]);

  React.useEffect(() => {
    if (!searchQuery.trim() || !addPanel) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    const timeout = setTimeout(async () => {
      try {
        const res = await fetch(`/api/providers/${searchType}/search?q=${encodeURIComponent(searchQuery)}`);
        if (res.ok) {
          const data = await res.json();
          setSearchResults(data);
        }
      } catch {} finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(timeout);
  }, [searchQuery, searchType, addPanel]);

  const linkedProviderTypes = new Set(sources.map(s => s.type));

  function isLinked(providerType: string) {
    return sources.some(s => s.type === providerType);
  }

  async function handleAdd(result: SearchResult) {
    try {
      const res = await fetch(`/api/shows/${showId}/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerType: result.providerType, providerId: result.id }),
      });
      if (res.ok) {
        setAddPanel(false);
        setSearchQuery("");
        setSearchResults([]);
        const updated = await fetch(`/api/shows/${showId}/providers`).then(r => r.json());
        setSources(updated);
        onSourcesChanged();
      }
    } catch {}
  }

  async function handleRemove(type: string) {
    if (!confirm(`Remove ${type} from "${showTitle}"?`)) return;
    try {
      await fetch(`/api/shows/${showId}/providers/${type}`, { method: "DELETE" });
      const updated = await fetch(`/api/shows/${showId}/providers`).then(r => r.json());
      setSources(updated);
      onSourcesChanged();
    } catch {}
  }

  async function handleSetPrimary(type: string) {
    try {
      await fetch(`/api/shows/${showId}/providers/${type}/primary`, { method: "PUT" });
      const updated = await fetch(`/api/shows/${showId}/providers`).then(r => r.json());
      setSources(updated);
      onSourcesChanged();
    } catch {}
  }

  async function handleToggleRole(type: string, role: 'metadata' | 'airtime', active: boolean) {
    try {
      await fetch(`/api/shows/${showId}/providers/${type}/role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, active }),
      });
      const updated = await fetch(`/api/shows/${showId}/providers`).then(r => r.json());
      setSources(updated);
      onSourcesChanged();
    } catch {}
  }

  async function handleSync(type: string) {
    setSyncing(type);
    try {
      await fetch(`/api/shows/${showId}/sync`, { method: "POST" });
    } catch {} finally {
      setSyncing(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Metadata Sources</DialogTitle>
          <DialogDescription>
            Assign roles (Metadata, Airtime) to each linked source for &ldquo;{showTitle}&rdquo;
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3 overflow-y-auto flex-1 min-h-0 pr-1 -mr-1">
            {sources.map(source => (
              <div
                key={source.type}
                className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider">
                      {source.type}
                    </span>
                    <RoleToggle
                      label="Metadata"
                      active={source.roles.metadata}
                      onClick={() => handleToggleRole(source.type, 'metadata', !source.roles.metadata)}
                    />
                    <RoleToggle
                      label="Airtime"
                      active={source.roles.airtime}
                      onClick={() => handleToggleRole(source.type, 'airtime', !source.roles.airtime)}
                    />
                  </div>
                  <p className="mt-1 text-sm font-medium truncate">{source.title || showTitle}</p>
                  <p className="font-mono text-[10px] text-muted-foreground">#{source.id}</p>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleSetPrimary(source.type)}
                    disabled={source.isPrimary}
                    className="rounded-lg p-1.5 text-muted-foreground hover:text-amber-400 hover:bg-white/5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Set as primary (fallback for unassigned roles)"
                  >
                    <Star className="size-3.5" fill={source.isPrimary ? "currentColor" : "none"} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSync(source.type)}
                    disabled={syncing === source.type}
                    className="rounded-lg p-1.5 text-muted-foreground hover:text-white hover:bg-white/5 transition-colors disabled:opacity-30"
                    title="Sync now"
                  >
                    <RefreshCw className={`size-3.5 ${syncing === source.type ? "animate-spin" : ""}`} />
                  </button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => handleRemove(source.type)}
                        disabled={sources.length <= 1}
                        className="rounded-lg p-1.5 text-muted-foreground hover:text-red-400 hover:bg-white/5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    {sources.length <= 1 && (
                      <TooltipContent>Cannot remove the only source</TooltipContent>
                    )}
                  </Tooltip>
                </div>
              </div>
            ))}

            {addPanel ? (
              <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <div className="flex gap-2">
                  <Select value={searchType} onValueChange={(v) => setSearchType(v as typeof searchType)}>
                    <SelectTrigger className="w-28 shrink-0 h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tvdb">TVDB</SelectItem>
                      <SelectItem value="tmdb">TMDB</SelectItem>
                      <SelectItem value="anilist">AniList</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="relative flex-1">
                    <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                    <Input
                      autoFocus
                      placeholder="Search to add..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-8 h-8 text-xs"
                    />
                  </div>
                </div>

                <div className="max-h-[40vh] space-y-1 overflow-y-auto">
                  {searching && (
                    <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" /> Searching...
                    </div>
                  )}
                  {!searching && searchQuery.trim() && searchResults.length === 0 && (
                    <p className="py-2 text-xs text-muted-foreground">No results.</p>
                  )}
                  {searchResults
                    .filter(r => !isLinked(r.providerType))
                    .map(r => (
                      <SearchResultRow key={`${r.providerType}-${r.id}`} result={r} onAdd={handleAdd} />
                    ))}
                </div>

                <button
                  type="button"
                  onClick={() => { setAddPanel(false); setSearchQuery(""); setSearchResults([]); }}
                  className="w-full text-center text-xs text-muted-foreground hover:text-white py-1 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddPanel(true)}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-white/10 p-3 text-sm text-muted-foreground hover:text-white hover:border-white/20 transition-colors"
              >
                <PlusIcon className="size-4" />
                Add metadata source
              </button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export { ManageSourcesDialog };
