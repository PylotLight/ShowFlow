import * as React from "react";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { Switch } from "@frontend/components/ui/switch";
import { LibraryTypeManager } from "./LibraryTypeManager";
import { UpdatesPanel } from "./UpdatesPanel";
import { FieldRow } from "./SettingsShared";
import { TIMEZONE_PRESETS } from "@frontend/lib/timezones";

export function GeneralTab({ config, saveConfig, scrollToSection }: {
  config: any;
  saveConfig: (updates: Record<string, any>) => void;
  scrollToSection?: string;
}) {
  const updatesRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (scrollToSection === "updates" && updatesRef.current) {
      updatesRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [scrollToSection]);

  return (
    <>
      <GlassPanel className="p-6 space-y-5">
        <div>
          <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Libraries</h3>
          <p className="text-muted-foreground text-xs mt-0.5">Each library bundles a root folder, quality profile, and indexer set. Shows assigned to a library are organized under its root folder. This is what onboarding's Library step creates.</p>
        </div>
        <LibraryTypeManager />
      </GlassPanel>

      <GlassPanel className="p-6 space-y-5">
        <div>
          <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Defaults</h3>
          <p className="text-muted-foreground text-xs mt-0.5">Default behavior for new shows and file handling</p>
        </div>
        <FieldRow label="Default Provider" description="Metadata provider used when adding shows">
          <Select
            value={config.defaultProvider || "tmdb"}
            onValueChange={v => saveConfig({ defaultProvider: v })}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tmdb">TMDB</SelectItem>
              <SelectItem value="tvdb">TVDB</SelectItem>
              <SelectItem value="anilist">AniList</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <FieldRow label="On Collision" description="What to do when a file already exists at the destination">
          <Select
            value={config.onCollision || "skip"}
            onValueChange={v => saveConfig({ onCollision: v })}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="skip">Skip</SelectItem>
              <SelectItem value="overwrite">Overwrite</SelectItem>
              <SelectItem value="version">Version</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <FieldRow label="Dry Run" description="Log actions without actually moving files">
          <Switch
            checked={!!config.dryRun}
            onCheckedChange={v => saveConfig({ dryRun: v })}
          />
        </FieldRow>
        <FieldRow
          label="Fallback Timezone"
          description="Used when a show's origin country doesn't pin airtimes down — defaults to America/New_York (Sonarr-compatible)"
        >
          <Select
            value={config.fallbackTimeZone || "America/New_York"}
            onValueChange={v => saveConfig({ fallbackTimeZone: v })}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIMEZONE_PRESETS.map((tz) => (
                <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>
      </GlassPanel>

      <div ref={updatesRef} id="updates">
        <UpdatesPanel />
      </div>
    </>
  );
}
