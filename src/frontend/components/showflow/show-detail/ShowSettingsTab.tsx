import { GitCompareArrows, Link2, Trash2 } from "lucide-react";
import * as React from "react";

import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";

import { pillButton } from "./format";
import type { ShowConfig } from "./hooks/useShowConfig";

function Row({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div className="text-sm text-foreground/90">{label}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>
      </div>
      <div className="shrink-0 sm:w-64">{children}</div>
    </div>
  );
}

/** Per-show configuration that used to live in the Options dropdown. */
export function ShowSettingsTab({ config, onFixMatch, onMapping, onRemove }: {
  config: ShowConfig;
  onFixMatch: () => void;
  onMapping: () => void;
  onRemove: () => void;
}) {
  const healthColor = config.mappingHealth === "ok" ? "bg-emerald-400" : config.mappingHealth === "conflicts" ? "bg-amber-400" : config.mappingHealth === "error" ? "bg-red-400" : "bg-slate-500";
  return (
    <div className="flex flex-col gap-4">
      <GlassPanel className="px-5 py-2 divide-y divide-white/[0.05]">
        {config.profiles.length > 0 && (
          <Row label="Quality profile" hint="Which quality formats to accept for this show">
            <Select value={config.profile} onValueChange={config.changeProfile}>
              <SelectTrigger size="sm" className="w-full" aria-label="Quality profile"><SelectValue /></SelectTrigger>
              <SelectContent>
                {config.profiles.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Row>
        )}
        <Row label="Series type" hint="Standard or anime routing, plus the matching root folder">
          <Select value={config.seriesType} onValueChange={config.changeSeriesType}>
            <SelectTrigger size="sm" className="w-full" aria-label="Series type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="standard">Standard</SelectItem>
              <SelectItem value="anime">Anime</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        {config.folderProfiles.length > 0 && (
          <Row label="Root folder" hint={config.rootFolderPath ? `Currently ${config.rootFolderPath}` : "Library root this show's folder lives under"}>
            <Select value={config.matchedFolderProfileId} onValueChange={config.changeRootFolder} disabled={config.rootFolderSaving}>
              <SelectTrigger size="sm" className="w-full" aria-label="Root folder"><SelectValue placeholder="Pick a root folder" /></SelectTrigger>
              <SelectContent>
                {config.folderProfiles.map(fp => <SelectItem key={fp.id} value={fp.id}>{fp.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Row>
        )}
        <Row label="Metadata match" hint="Which TMDB / TVDB / AniList entry this show is matched to">
          <button type="button" onClick={onFixMatch} className={pillButton}><Link2 className="size-3.5" /> Fix match</button>
        </Row>
        <Row label="Episode mapping" hint="Scene ↔ provider numbering overrides for anime and specials">
          <button type="button" onClick={onMapping} className={pillButton}>
            <GitCompareArrows className="size-3.5" /> Edit mapping
            <span className={`size-1.5 rounded-full ${healthColor}`} aria-label={`Mapping health: ${config.mappingHealth}`} />
          </button>
        </Row>
      </GlassPanel>

      <GlassPanel className="px-5 py-2 border-red-500/20">
        <Row label="Remove show" hint="Remove this show from your library. Files on disk are left alone.">
          <button type="button" onClick={onRemove} className={`${pillButton} text-red-400 hover:text-red-300 hover:bg-red-400/10`}>
            <Trash2 className="size-3.5" /> Remove
          </button>
        </Row>
      </GlassPanel>
    </div>
  );
}
