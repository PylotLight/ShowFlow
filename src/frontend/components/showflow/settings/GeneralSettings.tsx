import * as React from "react";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { Switch } from "@frontend/components/ui/switch";
import { LibraryTypeManager } from "../LibraryTypeManager";
import { UpdatesPanel } from "../UpdatesPanel";
import { FieldRow } from "../SettingsShared";
import { useSettings } from "./SettingsContext";
import { TIMEZONE_PRESETS } from "@frontend/lib/timezones";

/** Group heading so General reads as distinct sections, not one long stack. */
function SectionHeading({ id, title, description }: { id: string; title: string; description: string }) {
  return (
    <div id={id} className="scroll-mt-4 pt-2 first:pt-0">
      <h2 className="font-mono text-xs font-bold uppercase tracking-[0.16em] text-signal">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

const SECTIONS = [
  { id: "defaults", label: "Defaults" },
  { id: "grabbing", label: "Grabbing" },
  { id: "libraries", label: "Libraries" },
  { id: "updates", label: "Updates" },
];

export function GeneralSettings({ scrollToSection, onReRunWizard }: {
  scrollToSection?: string;
  onReRunWizard?: () => void;
}) {
  const { config, saveConfig } = useSettings();
  const updatesRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (scrollToSection === "updates" && updatesRef.current) {
      updatesRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [scrollToSection]);

  return (
    <div className="space-y-6">
      <nav aria-label="General sections" className="flex flex-wrap gap-1.5">
        {SECTIONS.map(sec => (
          <a
            key={sec.id}
            href={`#${sec.id}`}
            onClick={(e) => { e.preventDefault(); document.getElementById(sec.id)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
            className="rounded-full bg-white/[0.04] px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-signal/70"
          >
            {sec.label}
          </a>
        ))}
      </nav>

      <SectionHeading id="defaults" title="Defaults" description="How new shows are added and how file collisions are handled." />
      <GlassPanel className="p-6 space-y-5">
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

      <SectionHeading id="grabbing" title="Grabbing" description="How the auto-grabber and RSS sync pick what to download." />
      <GlassPanel className="p-6 space-y-5">
        <FieldRow
          label="Upgrade until cutoff"
          description="Keep looking for a better release while an episode's file is below its quality profile's cutoff. Profiles with no cutoff are never upgraded."
        >
          <Switch
            aria-label="Upgrade until cutoff"
            checked={config.upgradeUntilCutoff !== false}
            onCheckedChange={v => saveConfig({ upgradeUntilCutoff: v })}
          />
        </FieldRow>
        <FieldRow
          label="Prefer season packs"
          description="For a season that has finished airing, try one season pack before searching episode by episode."
        >
          <Switch
            aria-label="Prefer season packs"
            checked={config.preferSeasonPacks !== false}
            onCheckedChange={v => saveConfig({ preferSeasonPacks: v })}
          />
        </FieldRow>
        {config.preferSeasonPacks !== false && (
          <FieldRow
            label="Pack threshold"
            description="Missing episodes a finished season needs before a pack is tried."
          >
            <Select
              value={String(config.seasonPackMinMissing ?? 2)}
              onValueChange={v => saveConfig({ seasonPackMinMissing: Number(v) })}
            >
              <SelectTrigger className="w-24" aria-label="Pack threshold">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[2, 3, 4, 6, 8].map(n => (
                  <SelectItem key={n} value={String(n)}>{n}+</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
        )}
      </GlassPanel>

      <SectionHeading id="libraries" title="Libraries" description="Each library bundles a root folder, quality profile, and indexer set. Shows assigned to a library are organized under its root folder. This is what onboarding's Library step creates." />
      <GlassPanel className="p-6 space-y-5">
        <LibraryTypeManager />
      </GlassPanel>

      <div ref={updatesRef}>
        <SectionHeading id="updates" title="Updates" description="ShowFlow releases published on GitHub, and the supervisor's view of what's running." />
      </div>
      <UpdatesPanel />

      {onReRunWizard && (
        <>
          <SectionHeading id="setup" title="Setup" description="Re-run the onboarding wizard to reconfigure from scratch." />
          <GlassPanel className="p-6">
            <button onClick={onReRunWizard} className="rounded-md text-sm text-signal hover:underline outline-none focus-visible:ring-2 focus-visible:ring-signal/70">Re-run setup wizard</button>
          </GlassPanel>
        </>
      )}
    </div>
  );
}
