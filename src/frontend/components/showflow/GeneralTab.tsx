import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { Switch } from "@frontend/components/ui/switch";
import { ColorDock } from "./ColorDock";
import { ShowProfileManager } from "./ShowProfileManager";
import { FieldRow } from "./SettingsShared";

export function GeneralTab({ config, saveConfig, accent, setAccent }: {
  config: any;
  saveConfig: (updates: Record<string, any>) => void;
  accent: string;
  setAccent: (c: string) => void;
}) {
  return (
    <>
      <GlassPanel className="p-6 space-y-5">
        <div>
          <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Accent Theme</h3>
          <p className="text-muted-foreground text-xs mt-0.5">Choose the accent color used throughout the interface</p>
        </div>
        <ColorDock current={accent} onChange={(color) => { setAccent(color); }} />
      </GlassPanel>

      <GlassPanel className="p-6 space-y-5">
        <div>
          <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Profiles &amp; Root Folders</h3>
          <p className="text-muted-foreground text-xs mt-0.5">Each profile maps to a root folder. Shows assigned to a profile are organized under its root folder.</p>
        </div>
        <ShowProfileManager />
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
      </GlassPanel>
    </>
  );
}
