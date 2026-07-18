import * as React from "react";
import { Button } from "@frontend/components/ui/button";
import { cn } from "@frontend/lib/utils";
import { ArrowRightIcon, BookIcon, SparklesIcon, StarIcon } from "lucide-react";
import type { StepProps } from "../types";

interface LibraryType {
  id: string;
  name: string;
  rootFolderPath: string | null;
  qualityProfileId: string | null;
  isDefault: boolean;
}

export function StepLibraryType({ data, setData, onNext, onSkip }: StepProps) {
  const [types, setTypes] = React.useState<LibraryType[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/library-types");
        if (res.ok) setTypes(await res.json());
      } catch {} finally {
        setLoading(false);
      }
    })();
  }, []);

  const selected = data.libraryTypeId;

  const presets = [
    { id: null as any, name: 'Standard', qualityProfileId: 'standard', isDefault: true },
    { id: null as any, name: 'Anime', qualityProfileId: 'anime', isDefault: false },
    { id: null as any, name: 'Movies', qualityProfileId: 'standard', isDefault: false },
  ];

  const displayTypes = types.length > 0 ? types : presets;

  const handleContinue = async () => {
    if (types.length > 0) { onNext(); return; }
    const preset = presets.find(p => p.name === (displayTypes.find((t: any) => (t.id ?? t.name) === (selected || 'Standard')) as any)?.name) ?? presets[0];
    setSaving(true);
    try {
      const id = `lt_${preset.name.toLowerCase()}`;
      const res = await fetch("/api/library-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: preset.name, qualityProfileId: preset.qualityProfileId, isDefault: preset.isDefault }),
      });
      if (res.ok) {
        setData({ libraryTypeId: id });
        onNext();
      }
    } catch {} finally {
      setSaving(false);
    }
  };

  return (
    <div className="py-4">
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight mb-2">Library Type</h2>
        <p className="text-muted-foreground">
          Choose how your library is organized. This sets default quality profiles,
          root folder mappings, and indexer associations.
        </p>
      </div>

      {loading ? (
        <div className="text-center py-12 text-sm text-muted-foreground">Loading...</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {displayTypes.map((t: any) => {
            const isSelected = selected === t.id || (!selected && t.name === 'Standard');
            return (
              <button
                key={t.id ?? t.name}
                onClick={() => setData({ libraryTypeId: t.id ?? null })}
                className={cn(
                  "relative flex flex-col items-center gap-3 p-6 rounded-2xl border text-left transition-all duration-200",
                  isSelected
                    ? "border-signal/50 bg-signal/[0.04] ring-1 ring-signal/30"
                    : "border-white/10 hover:border-white/20 bg-white/[0.02]"
                )}
              >
                {t.name === 'Standard' && <BookIcon className={cn("size-8", isSelected ? "text-signal" : "text-muted-foreground/40")} />}
                {t.name === 'Anime' && <SparklesIcon className={cn("size-8", isSelected ? "text-signal" : "text-muted-foreground/40")} />}
                {t.name === 'Movies' && <StarIcon className={cn("size-8", isSelected ? "text-signal" : "text-muted-foreground/40")} />}
                {(t.name !== 'Standard' && t.name !== 'Anime' && t.name !== 'Movies') && (
                  <div className={cn("size-8 rounded-lg flex items-center justify-center font-bold text-lg", isSelected ? "text-signal bg-signal/10" : "text-muted-foreground/40 bg-white/[0.03]")}>
                    {t.name.charAt(0)}
                  </div>
                )}
                <div className="text-center">
                  <p className={cn("text-sm font-semibold", isSelected && "text-signal")}>{t.name}</p>
                  {t.rootFolderPath && (
                    <p className="text-[10px] font-mono text-muted-foreground/60 mt-1 truncate max-w-full">{t.rootFolderPath}</p>
                  )}
                </div>
                {isSelected && (
                  <div className="absolute top-3 right-3 size-3 rounded-full bg-signal" />
                )}
              </button>
            );
          })}
        </div>
      )}

      {data.rootFolders.length > 0 && (
        <div className="mt-6 p-4 rounded-xl bg-white/[0.02] border border-white/5">
          <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground/60 mb-2">
            Using root folder
          </p>
          <p className="text-sm font-mono truncate">{data.rootFolders[0]}</p>
        </div>
      )}

      <div className="mt-8 flex items-center justify-between">
        <button onClick={onSkip} className="text-sm text-muted-foreground/60 hover:text-muted-foreground transition-colors">
          Skip and set up manually
        </button>
        <Button onClick={handleContinue} disabled={saving} className="gap-2 h-11 px-6 rounded-xl">
          {saving ? "Saving..." : types.length === 0 ? "Use default" : "Continue"}
          <ArrowRightIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
