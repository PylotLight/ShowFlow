import * as React from "react";
import { Loader2, Settings2, XIcon } from "lucide-react";

import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@frontend/components/ui/dialog";
import { Button } from "@frontend/components/ui/button";
import { Label } from "@frontend/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";

interface LibraryType {
  id: string;
  name: string;
  root_folder_path: string | null;
  quality_profile_id: string | null;
  is_default: number;
}

interface QualityProfile {
  id: string;
  name: string;
}

const UNCHANGED = "__unchanged__";

export function BulkUpdateDialog({
  ids,
  open,
  onOpenChange,
  onDone,
}: {
  ids: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [libraryTypes, setLibraryTypes] = React.useState<LibraryType[]>([]);
  const [qualityProfiles, setQualityProfiles] = React.useState<QualityProfile[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [libraryType, setLibraryType] = React.useState<string>(UNCHANGED);
  const [quality, setQuality] = React.useState<string>(UNCHANGED);
  const [series, setSeries] = React.useState<string>(UNCHANGED);
  const [tracked, setTracked] = React.useState<string>(UNCHANGED);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    setLoading(true);
    Promise.all([
      fetch("/api/library-types").then(r => r.json()).catch(() => []),
      fetch("/api/profiles").then(r => r.json()).catch(() => []),
    ])
      .then(([types, profiles]) => {
        setLibraryTypes(Array.isArray(types) ? types : []);
        setQualityProfiles(Array.isArray(profiles) ? profiles : []);
      })
      .finally(() => setLoading(false));
  }, [open]);

  function reset() {
    setLibraryType(UNCHANGED);
    setQuality(UNCHANGED);
    setSeries(UNCHANGED);
    setTracked(UNCHANGED);
    setError(null);
  }

  const hasChanges =
    libraryType !== UNCHANGED ||
    quality !== UNCHANGED ||
    series !== UNCHANGED ||
    tracked !== UNCHANGED;

  async function handleSave() {
    if (!hasChanges) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, any> = { ids };
      if (libraryType !== UNCHANGED) body.libraryTypeId = libraryType;
      if (quality !== UNCHANGED) body.profile = quality;
      if (series !== UNCHANGED) body.seriesType = series;
      if (tracked !== UNCHANGED) body.tracked = tracked === "tracked";
      const res = await fetch("/api/shows/bulk-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to update shows");
      reset();
      onOpenChange(false);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update shows");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Settings2 className="size-4 text-signal" />
            <h2 className="font-display text-xl font-bold uppercase tracking-wider">Bulk Update</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            {ids.length} show{ids.length !== 1 ? "s" : ""} selected — set the fields to change, leave the rest as-is.
          </p>
        </DialogHeader>

        <div className="space-y-4">
          {loading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {libraryTypes.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    Library type
                  </Label>
                  <Select value={libraryType} onValueChange={setLibraryType}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="No change" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNCHANGED}>No change</SelectItem>
                      {libraryTypes.map(t => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}{t.is_default === 1 ? " (default)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground/70">
                    Bundles root folder, quality profile, and indexer routing.
                  </p>
                </div>
              )}

              {qualityProfiles.length > 0 && (
                <div className="space-y-1.5">
                  <Label htmlFor="bulk-quality" className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    Quality profile
                  </Label>
                  <Select value={quality} onValueChange={setQuality}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="No change" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNCHANGED}>No change</SelectItem>
                      {qualityProfiles.map(p => (
                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-1.5">
                <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Series type</Label>
                <Select value={series} onValueChange={setSeries}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="No change" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNCHANGED}>No change</SelectItem>
                    <SelectItem value="standard">Standard</SelectItem>
                    <SelectItem value="anime">Anime</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Tracking</Label>
                <Select value={tracked} onValueChange={setTracked}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="No change" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNCHANGED}>No change</SelectItem>
                    <SelectItem value="tracked">Track episodes</SelectItem>
                    <SelectItem value="untracked">Untrack episodes</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground/70">
                  Tracks or untracks all episodes across the selected shows.
                </p>
              </div>
            </>
          )}
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <XIcon className="size-3.5 shrink-0" />
            {error}
          </div>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={saving}>Cancel</Button>
          </DialogClose>
          <Button onClick={handleSave} disabled={!hasChanges || saving || loading}>
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            {saving ? "Applying..." : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}