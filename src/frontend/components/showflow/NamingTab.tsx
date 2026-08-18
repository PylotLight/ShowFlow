import * as React from "react";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Input } from "@frontend/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { Switch } from "@frontend/components/ui/switch";
import { FieldRow } from "./SettingsShared";

const TOKENS: { token: string; hint: string }[] = [
  { token: "{Series Title}", hint: "Series name" },
  { token: "{Series Clean Title}", hint: "Series name with illegal characters replaced" },
  { token: "{Series TitleThe}", hint: "Series name with The moved to the end" },
  { token: "{Episode Title}", hint: "Episode name" },
  { token: "{Episode Clean Title}", hint: "Episode name with illegal characters replaced" },
  { token: "{season:00}", hint: "Two-digit season number (01, 12)" },
  { token: "{episode:00}", hint: "Two-digit episode number (01, 12)" },
  { token: "{Absolute Episode Number}", hint: "Absolute episode number" },
  { token: "{Air Date}", hint: "Air date in YYYY-MM-DD form (daily series)" },
  { token: "{Quality Title}", hint: "Source + resolution, e.g. WEBDL-1080p" },
  { token: "{Quality Full}", hint: "Quality title + version, e.g. WEBDL-1080p Proper" },
  { token: "{Quality Proper}", hint: "Proper/Repack/v2 marker, if any" },
  { token: "{MediaInfo Video}", hint: "Video codec, e.g. x265" },
  { token: "{MediaInfo Simple}", hint: "Video codec, e.g. x265" },
  { token: "{MediaInfo Full}", hint: "Codec + resolution, e.g. x265 1080p" },
  { token: "{MediaInfo AudioCodec}", hint: "Audio codec, e.g. EAC3" },
  { token: "{MediaInfo AudioChannels}", hint: "Audio channels, e.g. 5.1" },
  { token: "{Release Group}", hint: "Release group from the release name" },
  { token: "{Original Filename}", hint: "Original release filename" },
];

export function NamingTab({ config, saveConfig }: {
  config: any;
  saveConfig: (updates: Record<string, any>) => void;
}) {
  const [preview, setPreview] = React.useState<Record<string, string> | null>(null);

  const naming = {
    renameEpisodes: config.renameEpisodes !== false,
    replaceIllegalCharacters: config.replaceIllegalCharacters !== false,
    colonReplacement: config.colonReplacement || "smart",
    multiEpisodeStyle: config.multiEpisodeStyle || "extend",
    standardEpisodeFormat: config.standardEpisodeFormat || "{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}",
    dailyEpisodeFormat: config.dailyEpisodeFormat || "{Series Title} - {Air Date} - {Episode Title} {Quality Full}",
    animeEpisodeFormat: config.animeEpisodeFormat || "{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}",
    seasonFolderFormat: config.seasonFolderFormat || "Season {season}",
  };

  const loadPreview = React.useCallback((overrides?: Record<string, any>) => {
    fetch("/api/naming/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...naming, ...overrides }),
    }).then(r => r.json()).then(data => setPreview(data)).catch(() => setPreview(null));
  }, []);

  React.useEffect(() => {
    loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-6">
      <GlassPanel className="p-6 space-y-5">
        <div>
          <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Episode Naming</h3>
          <p className="text-muted-foreground text-xs mt-0.5">How stored episode files are renamed, matching Sonarr's Episode Naming settings. Quality tokens like {`{Quality Full}`} are expected in the filename.</p>
        </div>

        <FieldRow label="Rename Episodes" description="Rename stored files to the format below. Off keeps original filenames.">
          <Switch
            checked={naming.renameEpisodes}
            onCheckedChange={v => { saveConfig({ renameEpisodes: v }); loadPreview({ renameEpisodes: v }); }}
          />
        </FieldRow>
        <FieldRow label="Replace Illegal Characters" description="Replace characters illegal on NTFS/POSIX filesystems with spaces">
          <Switch
            checked={naming.replaceIllegalCharacters}
            onCheckedChange={v => { saveConfig({ replaceIllegalCharacters: v }); loadPreview({ replaceIllegalCharacters: v }); }}
          />
        </FieldRow>
        <FieldRow label="Colon Replacement" description="How colons in titles are handled (Smart removes a colon before a digit, replaces with a space otherwise)">
          <Select
            value={naming.colonReplacement}
            onValueChange={v => { saveConfig({ colonReplacement: v }); loadPreview({ colonReplacement: v }); }}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="smart">Smart Replace</SelectItem>
              <SelectItem value="space">Replace with Space</SelectItem>
              <SelectItem value="dash">Replace with Dash</SelectItem>
              <SelectItem value="delete">Delete</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <FieldRow label="Multi Episode Style" description="How multiple episodes in one file are numbered">
          <Select
            value={naming.multiEpisodeStyle}
            onValueChange={v => { saveConfig({ multiEpisodeStyle: v }); loadPreview({ multiEpisodeStyle: v }); }}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="extend">Extend</SelectItem>
              <SelectItem value="scene">Scene</SelectItem>
              <SelectItem value="office">Office</SelectItem>
              <SelectItem value="repeat">Repeat</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <FieldRow label="Season Folder Format" description="Template for season subdirectories">
          <Input
            value={naming.seasonFolderFormat}
            onChange={e => saveConfig({ seasonFolderFormat: e.target.value })}
            placeholder="Season {season}"
            className="font-mono"
          />
        </FieldRow>
      </GlassPanel>

      <GlassPanel className="p-6 space-y-5">
        <div>
          <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Formats</h3>
          <p className="text-muted-foreground text-xs mt-0.5">Format templates per series type. Click a token to insert it, or type it manually.</p>
        </div>

        <FormatField
          label="Standard Episode Format"
          description="Used for standard series"
          value={naming.standardEpisodeFormat}
          onChange={v => { saveConfig({ standardEpisodeFormat: v }); loadPreview({ standardEpisodeFormat: v }); }}
        />
        <FormatField
          label="Daily Episode Format"
          description="Used for daily series (uses {Air Date})"
          value={naming.dailyEpisodeFormat}
          onChange={v => { saveConfig({ dailyEpisodeFormat: v }); loadPreview({ dailyEpisodeFormat: v }); }}
        />
        <FormatField
          label="Anime Episode Format"
          description="Used for anime series (supports absolute numbers)"
          value={naming.animeEpisodeFormat}
          onChange={v => { saveConfig({ animeEpisodeFormat: v }); loadPreview({ animeEpisodeFormat: v }); }}
        />

        <div>
          <p className="text-sub font-mono font-bold uppercase tracking-widest text-foreground/80 mb-2">Tokens</p>
          <div className="flex flex-wrap gap-1.5">
            {TOKENS.map(t => (
              <button
                key={t.token}
                title={t.hint}
                onClick={() => {
                  const active = (document.activeElement as HTMLInputElement | null);
                  if (active && active.dataset.format) {
                    const key = active.dataset.format;
                    const current = (naming as any)[key];
                    saveConfig({ [key]: current + t.token });
                    loadPreview({ [key]: current + t.token });
                  }
                }}
                className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 font-mono text-[11px] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
              >
                {t.token}
              </button>
            ))}
          </div>
          <p className="text-muted-foreground text-xs mt-2">Focus a format field above, then click a token to append it at the caret.</p>
        </div>

        {preview && (
          <div className="rounded-xl border border-white/10 bg-black/20 p-4 space-y-2">
            <p className="text-sub font-mono font-bold uppercase tracking-widest text-foreground/80">Preview</p>
            {Object.entries(preview).map(([key, value]) => (
              <div key={key} className="flex items-center gap-3">
                <span className="w-28 shrink-0 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{key}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-white/90">{value}</code>
              </div>
            ))}
          </div>
        )}
      </GlassPanel>
    </div>
  );
}

function FormatField({ label, description, value, onChange }: {
  label: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const key = label === "Standard Episode Format" ? "standardEpisodeFormat"
    : label === "Daily Episode Format" ? "dailyEpisodeFormat" : "animeEpisodeFormat";
  return (
    <FieldRow label={label} description={description}>
      <Input
        data-format={key}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="font-mono"
        placeholder="{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}"
      />
    </FieldRow>
  );
}