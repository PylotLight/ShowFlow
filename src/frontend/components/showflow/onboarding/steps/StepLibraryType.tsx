import * as React from "react";
import { Button } from "@frontend/components/ui/button";
import { cn } from "@frontend/lib/utils";
import { ArrowRightIcon, BookIcon, SparklesIcon, StarIcon, FolderIcon } from "lucide-react";
import type { StepProps } from "../types";

const TYPE_OPTIONS = [
  { id: 'Standard', label: 'Standard', icon: BookIcon },
  { id: 'Anime', label: 'Anime', icon: SparklesIcon },
  { id: 'Movies', label: 'Movies', icon: StarIcon },
] as const;

export function StepLibraryType({ data, setData, onNext, onSkip }: StepProps) {
  const [mappings, setMappings] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!data.rootFolders.length) return;
    setMappings(prev => {
      const next = { ...prev };
      for (const folder of data.rootFolders) {
        if (!next[folder]) next[folder] = 'Standard';
      }
      return next;
    });
  }, [data.rootFolders]);

  const handleContinue = async () => {
    setSaving(true);
    try {
      for (const [folder, typeName] of Object.entries(mappings)) {
        const preset = TYPE_OPTIONS.find(o => o.id === typeName)!;
        const id = `lt_${typeName.toLowerCase()}`;
        await fetch("/api/library-types", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: `${id}_${folder.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`,
            name: typeName,
            rootFolderPath: folder,
            qualityProfileId: preset.id === 'Anime' ? 'anime' : 'standard',
            isDefault: false,
          }),
        });
      }
      onNext();
    } catch {} finally {
      setSaving(false);
    }
  };

  return (
    <div className="py-4">
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight mb-2">Library Type</h2>
        <p className="text-muted-foreground">
          Map each root folder to a library type. This sets quality profiles and
          how each folder is organized.
        </p>
      </div>

      <div className="space-y-3">
        {data.rootFolders.map(folder => {
          const currentType = mappings[folder] || 'Standard';
          return (
            <div
              key={folder}
              className="p-4 rounded-xl border bg-white/[0.02] border-white/10 space-y-3"
            >
              <div className="flex items-center gap-3">
                <FolderIcon className="size-4 shrink-0 text-signal" />
                <span className="font-mono text-sm break-all text-foreground/80">{folder}</span>
              </div>
              <div className="flex gap-1.5 pl-7">
                {TYPE_OPTIONS.map(opt => {
                  const isActive = currentType === opt.id;
                  const OptIcon = opt.icon;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => setMappings(prev => ({ ...prev, [folder]: opt.id }))}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200",
                        isActive
                          ? "bg-signal/10 text-signal ring-1 ring-signal/30"
                          : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-white/[0.03]"
                      )}
                    >
                      <OptIcon className="size-3" />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-8 flex items-center justify-between">
        <button onClick={onSkip} className="text-xs text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors italic">
          Skip and set up manually
        </button>
        <Button variant="glass" onClick={handleContinue} disabled={saving} className="gap-2 h-11 px-6 rounded-xl">
          {saving ? "Saving..." : "Continue"}
          <ArrowRightIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
