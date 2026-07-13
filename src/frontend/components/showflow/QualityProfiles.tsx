import { CheckIcon, ChevronDownIcon, ChevronUpIcon, Loader2Icon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import * as React from "react";

import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Badge } from "@frontend/components/ui/badge";
import { Button } from "@frontend/components/ui/button";
import { Input } from "@frontend/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { cn } from "@frontend/lib/utils";

interface Quality {
  id: string;
  name: string;
  rank: number;
}

interface CustomFormat {
  id: string;
  name: string;
  regex: string;
  score: number;
}

interface Profile {
  id: string;
  name: string;
  cutoff_quality_id: string | null;
  indexers?: string[];
}

interface ProfileFormat extends CustomFormat {
  profile_format_type: "bonus" | "required" | "forbidden";
}

function slugify(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || crypto.randomUUID().slice(0, 8);
}

function post(path: string, body: unknown) {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---- Catalogs ---------------------------------------------------------
// Guided defaults so setup is pick-a-button rather than type-it-yourself.
// Free text is reserved for naming things Claude/ShowFlow can't predict
// (a custom profile name, a genuinely one-off quality or format) - the
// common 90% case should never require typing.

const QUALITY_CATALOG = [
  "SDTV", "DVD",
  "480p", "WEBRip-480p", "WEBDL-480p",
  "720p", "HDTV-720p", "WEBRip-720p", "WEBDL-720p", "Bluray-720p",
  "1080p", "HDTV-1080p", "WEBRip-1080p", "WEBDL-1080p", "Bluray-1080p", "Remux-1080p",
  "2160p", "HDTV-2160p", "WEBRip-2160p", "WEBDL-2160p", "Bluray-2160p", "Remux-2160p",
];

const CUSTOM_FORMAT_CATALOG: { name: string; regex: string; score: number }[] = [
  { name: "Dual Audio", regex: "dual.?audio", score: 50 },
  { name: "Dolby Vision", regex: "dolby.?vision|\\bdv\\b", score: 60 },
  { name: "HDR10+", regex: "hdr10\\+", score: 40 },
  { name: "HDR10", regex: "hdr10(?!\\+)", score: 30 },
  { name: "Atmos", regex: "atmos", score: 30 },
  { name: "TrueHD", regex: "true.?hd", score: 20 },
  { name: "DTS-HD MA", regex: "dts.?hd.?ma", score: 20 },
  { name: "x265 / HEVC", regex: "x265|hevc", score: 20 },
  { name: "10-bit", regex: "10.?bit|hi10p", score: 10 },
  { name: "Remux", regex: "remux", score: 50 },
  { name: "Repack / Proper", regex: "repack|proper", score: 5 },
  { name: "Freeleech", regex: "freeleech", score: 5 },
];

const SCORE_PRESETS = [
  { label: "Required", value: 1000 },
  { label: "Strongly preferred", value: 100 },
  { label: "Preferred", value: 50 },
  { label: "Slightly preferred", value: 10 },
  { label: "Neutral", value: 0 },
  { label: "Slightly avoid", value: -10 },
  { label: "Avoid", value: -50 },
  { label: "Strongly avoid", value: -100 },
];

const ALL_INDEXERS: { id: string; name: string }[] = [
  { id: 'prowlarr', name: 'Prowlarr' },
  { id: 'nyaa', name: 'Nyaa.si' },
  { id: 'subsplease', name: 'SubsPlease' },
  { id: 'tpb', name: 'The Pirate Bay' },
  { id: 'knaben', name: 'Knaben' },
  { id: 'rarbg', name: 'TheRARBG' },
];

const PROFILE_NAME_PRESETS = ["Any", "SD", "HD - 720p", "HD - 1080p", "Ultra HD - 2160p", "Anime"];

function scoreLabel(score: number) {
  const preset = SCORE_PRESETS.find(p => p.value === score);
  if (preset) return preset.label;
  return score > 0 ? `+${score}` : String(score);
}

function ScoreSelect({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const preset = SCORE_PRESETS.find(p => p.value === value);
  const [customOpen, setCustomOpen] = React.useState(!preset);

  return (
    <div className="flex items-center gap-1.5">
      <Select
        value={preset ? String(preset.value) : "custom"}
        onValueChange={(v) => {
          if (v === "custom") { setCustomOpen(true); return; }
          setCustomOpen(false);
          onChange(Number(v));
        }}
        disabled={disabled}
      >
        <SelectTrigger size="sm" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SCORE_PRESETS.map(p => (
            <SelectItem key={p.value} value={String(p.value)}>{p.label} ({p.value >= 0 ? `+${p.value}` : p.value})</SelectItem>
          ))}
          <SelectItem value="custom">Custom value...</SelectItem>
        </SelectContent>
      </Select>
      {customOpen && (
        <Input
          type="number"
          value={value}
          onChange={e => onChange(parseInt(e.target.value, 10) || 0)}
          className="w-20 font-mono"
          disabled={disabled}
        />
      )}
    </div>
  );
}

// ---- Custom Formats -------------------------------------------------------

function CustomFormatsPanel({ formats, onChange }: { formats: CustomFormat[]; onChange: () => void }) {
  const [addingCustom, setAddingCustom] = React.useState(false);
  const [name, setName] = React.useState("");
  const [regex, setRegex] = React.useState("");
  const [score, setScore] = React.useState(0);
  const [saving, setSaving] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<string | null>(null);

  const existingNames = new Set(formats.map(f => f.name.toLowerCase()));
  const catalogRemaining = CUSTOM_FORMAT_CATALOG.filter(c => !existingNames.has(c.name.toLowerCase()));

  function reset() {
    setName("");
    setRegex("");
    setScore(0);
    setAddingCustom(false);
  }

  function addFromCatalog(entry: typeof CUSTOM_FORMAT_CATALOG[number]) {
    setSaving(entry.name);
    post("/api/custom-formats", { id: slugify(entry.name), name: entry.name, regex: entry.regex, score: entry.score })
      .then(r => { if (r.ok) onChange(); })
      .finally(() => setSaving(null));
  }

  function saveCustom() {
    if (!name.trim() || !regex.trim()) return;
    setSaving("__custom__");
    post("/api/custom-formats", { id: slugify(name), name: name.trim(), regex: regex.trim(), score })
      .then(r => { if (r.ok) { reset(); onChange(); } })
      .finally(() => setSaving(null));
  }

  function updateScore(f: CustomFormat, next: number) {
    post("/api/custom-formats", { id: f.id, name: f.name, regex: f.regex, score: next }).then(r => { if (r.ok) onChange(); });
  }

  function remove(id: string) {
    setRemoving(id);
    fetch(`/api/custom-formats/${id}`, { method: "DELETE" })
      .then(r => { if (r.ok) onChange(); })
      .finally(() => setRemoving(null));
  }

  return (
    <GlassPanel className="p-6 space-y-5">
      <div>
        <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Custom Formats</h3>
        <p className="text-muted-foreground text-xs mt-0.5">
          Patterns that score a release up or down (e.g. Dual Audio, HDR) or that a profile can require/forbid outright.
        </p>
      </div>

      {formats.length > 0 && (
        <div className="space-y-1.5">
          {formats.map(f => (
            <div key={f.id} className="flex items-center gap-3 rounded-lg px-4 py-3 bg-white/[0.03]">
              <span className="font-mono flex-1 text-sm tracking-wide">{f.name}</span>
              <code className="text-muted-foreground font-mono text-xs bg-white/[0.04] rounded px-2 py-1 max-w-56 truncate">{f.regex}</code>
              <ScoreSelect value={f.score} onChange={(v) => updateScore(f, v)} />
              <button
                type="button"
                onClick={() => remove(f.id)}
                disabled={removing === f.id}
                className="text-muted-foreground hover:text-red-400 shrink-0 transition-colors"
              >
                {removing === f.id ? <Loader2Icon className="size-4 animate-spin" /> : <Trash2Icon className="size-4" />}
              </button>
            </div>
          ))}
        </div>
      )}

      {catalogRemaining.length > 0 && (
        <div className="space-y-2">
          <span className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">Add common format</span>
          <div className="flex flex-wrap gap-1.5">
            {catalogRemaining.map(entry => (
              <button
                key={entry.name}
                type="button"
                onClick={() => addFromCatalog(entry)}
                disabled={saving === entry.name}
                className="flex items-center gap-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.08] border border-white/5 px-3 py-1.5 font-mono text-xs text-foreground/80 transition-colors disabled:opacity-50"
              >
                {saving === entry.name ? <Loader2Icon className="size-3 animate-spin" /> : <PlusIcon className="size-3" />}
                {entry.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {!addingCustom ? (
        <button
          type="button"
          onClick={() => setAddingCustom(true)}
          className="text-muted-foreground hover:text-foreground font-mono text-xs underline decoration-dotted underline-offset-4 transition-colors"
        >
          + Define a custom format (not in the list above)
        </button>
      ) : (
        <div className="space-y-2 rounded-lg px-4 py-3 bg-white/[0.04]">
          <div className="flex items-center gap-2">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Name (e.g. Group XYZ)" className="w-48" />
            <Input value={regex} onChange={e => setRegex(e.target.value)} placeholder="Regex to match in release titles" className="flex-1 font-mono" />
          </div>
          <div className="flex items-center gap-2">
            <ScoreSelect value={score} onChange={setScore} />
            <Button size="sm" onClick={saveCustom} disabled={saving === "__custom__" || !name.trim() || !regex.trim()}>
              {saving === "__custom__" ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
            </Button>
            <button type="button" onClick={reset} className="text-muted-foreground hover:text-foreground p-1.5 transition-colors">
              <XIcon className="size-4" />
            </button>
          </div>
        </div>
      )}

      {formats.length === 0 && catalogRemaining.length === 0 && (
        <p className="text-muted-foreground text-sm py-2">No custom formats yet.</p>
      )}
    </GlassPanel>
  );
}

// ---- Quality Definitions ---------------------------------------------------

function QualitiesPanel({ qualities, onChange, onQualitiesChange }: { qualities: Quality[]; onChange: () => void; onQualitiesChange: React.Dispatch<React.SetStateAction<Quality[]>> }) {
  const [addingCustom, setAddingCustom] = React.useState(false);
  const [name, setName] = React.useState("");
  const [saving, setSaving] = React.useState<string | null>(null);
  const [moving, setMoving] = React.useState<string | null>(null);

  const sorted = [...qualities].sort((a, b) => b.rank - a.rank);
  const nextRank = sorted.length > 0 ? sorted[0]!.rank + 10 : 100;
  const existingNames = new Set(qualities.map(q => q.name.toLowerCase()));
  const catalogRemaining = QUALITY_CATALOG.filter(q => !existingNames.has(q.toLowerCase()));

  function addFromCatalog(qualityName: string) {
    // Optimistic — update local state instantly, save in background
    const q: Quality = { id: slugify(qualityName), name: qualityName, rank: nextRank };
    onQualitiesChange(prev => [...prev, q]);
    post("/api/qualities", { id: q.id, name: q.name, rank: q.rank })
      .then(r => { if (!r.ok) onChange(); })
      .catch(onChange);
  }

  function saveCustom() {
    if (!name.trim()) return;
    setSaving("__custom__");
    post("/api/qualities", { id: slugify(name), name: name.trim(), rank: nextRank })
      .then(r => { if (r.ok) { setName(""); setAddingCustom(false); onChange(); } })
      .finally(() => setSaving(null));
  }

  function remove(id: string) {
    // Optimistic — remove locally instantly, save in background
    onQualitiesChange(prev => prev.filter(q => q.id !== id));
    fetch(`/api/qualities/${id}`, { method: "DELETE" })
      .then(r => { if (!r.ok) onChange(); })
      .catch(onChange);
  }

  async function move(index: number, direction: -1 | 1) {
    const self = sorted[index];
    const other = sorted[index + direction];
    if (!self || !other) return;
    setMoving(self.id);
    try {
      await Promise.all([
        post("/api/qualities", { id: self.id, name: self.name, rank: other.rank }),
        post("/api/qualities", { id: other.id, name: other.name, rank: self.rank }),
      ]);
      onChange();
    } finally {
      setMoving(null);
    }
  }

  return (
    <GlassPanel className="p-6 space-y-5">
      <div>
        <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Qualities</h3>
        <p className="text-muted-foreground text-xs mt-0.5">
          Resolution/source tiers, ordered by preference. Use the arrows to reorder — higher in the list wins when comparing releases.
        </p>
      </div>

      {sorted.length > 0 && (
        <div className="space-y-1.5">
          {sorted.map((q, i) => (
            <div key={q.id} className="flex items-center gap-3 rounded-lg px-4 py-3 bg-white/[0.03]">
              <div className="flex flex-col shrink-0">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0 || moving === q.id}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors"
                >
                  <ChevronUpIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === sorted.length - 1 || moving === q.id}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors"
                >
                  <ChevronDownIcon className="size-3.5" />
                </button>
              </div>
              <span className="font-mono flex-1 text-sm tracking-wide">{q.name}</span>
              <button
                type="button"
                onClick={() => remove(q.id)}
                className="text-muted-foreground hover:text-red-400 shrink-0 transition-colors"
              >
                <Trash2Icon className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {catalogRemaining.length > 0 && (
        <div className="space-y-2">
          <span className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">Add common quality</span>
          <div className="flex flex-wrap gap-1.5">
            {catalogRemaining.map(qualityName => (
              <button
                key={qualityName}
                type="button"
                onClick={() => addFromCatalog(qualityName)}
                className="flex items-center gap-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.08] border border-white/5 px-3 py-1.5 font-mono text-xs text-foreground/80 transition-colors"
              >
                <PlusIcon className="size-3" />
                {qualityName}
              </button>
            ))}
          </div>
        </div>
      )}

      {!addingCustom ? (
        <button
          type="button"
          onClick={() => setAddingCustom(true)}
          className="text-muted-foreground hover:text-foreground font-mono text-xs underline decoration-dotted underline-offset-4 transition-colors"
        >
          + Define a custom quality (not in the list above)
        </button>
      ) : (
        <div className="flex items-center gap-2 rounded-lg px-4 py-3 bg-white/[0.04]">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Name (e.g. WEBDL-4320p)" className="flex-1" />
          <Button size="sm" onClick={saveCustom} disabled={saving === "__custom__" || !name.trim()}>
            {saving === "__custom__" ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
          </Button>
          <button type="button" onClick={() => { setAddingCustom(false); setName(""); }} className="text-muted-foreground hover:text-foreground p-1.5 transition-colors">
            <XIcon className="size-4" />
          </button>
        </div>
      )}

      {sorted.length === 0 && catalogRemaining.length === 0 && (
        <p className="text-muted-foreground text-sm py-2">No qualities defined — the grabber can't rank releases without at least one.</p>
      )}
    </GlassPanel>
  );
}

// ---- Quality Profiles -------------------------------------------------------

function ProfileFormatsEditor({ profileId, allFormats }: { profileId: string; allFormats: CustomFormat[] }) {
  const [assigned, setAssigned] = React.useState<ProfileFormat[] | null>(null);
  const [addingFormatId, setAddingFormatId] = React.useState("");
  const [addingType, setAddingType] = React.useState<"bonus" | "required" | "forbidden">("bonus");
  const [saving, setSaving] = React.useState(false);

  function load() {
    fetch(`/api/profiles/${profileId}/formats`).then(r => r.json()).then(data => setAssigned(Array.isArray(data) ? data : []));
  }

  React.useEffect(load, [profileId]);

  const assignedIds = new Set((assigned ?? []).map(f => f.id));
  const available = allFormats.filter(f => !assignedIds.has(f.id));

  function addFormat() {
    if (!addingFormatId) return;
    setSaving(true);
    post(`/api/profiles/${profileId}/formats`, { formatId: addingFormatId, type: addingType })
      .then(r => { if (r.ok) { setAddingFormatId(""); load(); } })
      .finally(() => setSaving(false));
  }

  function removeFormat(formatId: string) {
    setSaving(true);
    fetch(`/api/profiles/${profileId}/formats`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ formatId }),
    }).then(r => { if (r.ok) load(); })
      .finally(() => setSaving(false));
  }

  const typeColors: Record<string, "signal" | "amber" | "muted"> = {
    bonus: "signal",
    required: "amber",
    forbidden: "muted",
  };

  if (assigned === null) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" /> Loading formats...
      </div>
    );
  }

  return (
    <div className="space-y-3 pt-3 border-t border-white/5">
      {assigned.length === 0 ? (
        <p className="text-muted-foreground text-xs">No custom formats attached — this profile scores purely on quality rank.</p>
      ) : (
        <div className="space-y-1.5">
          {assigned.map(f => (
            <div key={f.id} className="flex items-center gap-2 rounded-lg px-3 py-2 bg-white/[0.03]">
              <Badge variant={typeColors[f.profile_format_type]}>{f.profile_format_type}</Badge>
              <span className="font-mono text-xs flex-1">{f.name}</span>
              {f.profile_format_type === "bonus" && (
                <span className="text-muted-foreground font-mono text-xs">{scoreLabel(f.score)}</span>
              )}
              <button
                type="button"
                onClick={() => removeFormat(f.id)}
                disabled={saving}
                className="text-muted-foreground hover:text-red-400 transition-colors"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {available.length > 0 && (
        <div className="flex items-center gap-2">
          <Select value={addingFormatId} onValueChange={setAddingFormatId}>
            <SelectTrigger size="sm" className="flex-1">
              <SelectValue placeholder="Attach a custom format..." />
            </SelectTrigger>
            <SelectContent>
              {available.map(f => (
                <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={addingType} onValueChange={(v) => setAddingType(v as typeof addingType)}>
            <SelectTrigger size="sm" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bonus">Bonus</SelectItem>
              <SelectItem value="required">Required</SelectItem>
              <SelectItem value="forbidden">Forbidden</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" onClick={addFormat} disabled={!addingFormatId || saving}>
            {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />}
          </Button>
        </div>
      )}
    </div>
  );
}

function ProfileQualitiesEditor({ profileId, qualities }: { profileId: string; qualities: Quality[] }) {
  const [allowed, setAllowed] = React.useState<Quality[] | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  function load() {
    fetch(`/api/profiles/${profileId}/qualities`).then(r => r.json()).then(data => setAllowed(Array.isArray(data) ? data : []));
  }

  React.useEffect(load, [profileId]);

  if (allowed === null) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" /> Loading qualities...
      </div>
    );
  }

  const allowedIds = new Set(allowed.map(q => q.id));
  const sorted = [...qualities].sort((a, b) => b.rank - a.rank);

  async function toggle(qualityId: string) {
    setBusyId(qualityId);
    try {
      if (allowedIds.has(qualityId)) {
        await fetch(`/api/profiles/${profileId}/qualities`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ qualityId }),
        });
      } else {
        await post(`/api/profiles/${profileId}/qualities`, { qualityId });
      }
      load();
    } finally {
      setBusyId(null);
    }
  }

  async function allowEverything() {
    setBusyId("__all__");
    try {
      await Promise.all(allowed!.map(q => fetch(`/api/profiles/${profileId}/qualities`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qualityId: q.id }),
      })));
      load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-2 pb-3 border-b border-white/5">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">Allowed qualities</span>
        {allowedIds.size > 0 && (
          <button
            type="button"
            onClick={allowEverything}
            disabled={busyId === "__all__"}
            className="text-muted-foreground hover:text-foreground font-mono text-[10px] underline decoration-dotted underline-offset-2 transition-colors"
          >
            Allow everything
          </button>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {allowedIds.size === 0
          ? "Unrestricted — every known quality is currently acceptable. Tick any below to limit this profile to specific tiers."
          : "Only the ticked qualities below will ever be grabbed under this profile."}
      </p>
      {sorted.length === 0 ? (
        <p className="text-muted-foreground text-xs">Define at least one quality above before restricting this profile.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {sorted.map(q => {
            const checked = allowedIds.has(q.id);
            return (
              <button
                key={q.id}
                type="button"
                onClick={() => toggle(q.id)}
                disabled={busyId === q.id}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-xs transition-colors disabled:opacity-50",
                  checked
                    ? "bg-signal/15 border-signal/30 text-signal"
                    : "bg-white/[0.04] hover:bg-white/[0.08] border-white/5 text-foreground/70",
                )}
              >
                {busyId === q.id ? <Loader2Icon className="size-3 animate-spin" /> : (checked ? <CheckIcon className="size-3" /> : null)}
                {q.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProfileIndexersEditor({ profileId, indexers }: { profileId: string; indexers?: string[] }) {
  const [current, setCurrent] = React.useState<string[]>(indexers ?? []);
  const [saving, setSaving] = React.useState(false);

  function toggle(id: string) {
    const next = current.includes(id) ? current.filter(i => i !== id) : [...current, id];
    setCurrent(next);
    setSaving(true);
    fetch(`/api/profiles/${profileId}/indexers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    }).finally(() => setSaving(false));
  }

  return (
    <div className="space-y-3">
      <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
        Indexers
        {current.length === 0 && (
          <span className="text-muted-foreground/60 font-normal">(all enabled indexers will be used)</span>
        )}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {ALL_INDEXERS.map(ix => {
          const checked = current.includes(ix.id);
          return (
            <button
              key={ix.id}
              type="button"
              onClick={() => toggle(ix.id)}
              disabled={saving}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-xs transition-colors disabled:opacity-50",
                checked
                  ? "bg-signal/15 border-signal/30 text-signal"
                  : "bg-white/[0.04] hover:bg-white/[0.08] border-white/5 text-foreground/70",
              )}
            >
              {ix.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ProfileRow({ profile, qualities, allFormats, onChange }: {
  profile: Profile;
  qualities: Quality[];
  allFormats: CustomFormat[];
  onChange: () => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);

  function setCutoff(cutoffId: string) {
    post("/api/profiles", { id: profile.id, name: profile.name, cutoffId }).then(() => onChange());
  }

  function remove() {
    setRemoving(true);
    fetch(`/api/profiles/${profile.id}`, { method: "DELETE" })
      .then(r => { if (r.ok) onChange(); })
      .finally(() => setRemoving(false));
  }

  return (
    <div className="rounded-lg bg-white/[0.03] overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronDownIcon className={cn("size-4 transition-transform", expanded && "rotate-180")} />
        </button>
        <span className="font-mono flex-1 text-sm font-medium tracking-wide">{profile.name}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground font-mono text-caption uppercase tracking-wider">Cutoff</span>
          <Select value={profile.cutoff_quality_id ?? ""} onValueChange={setCutoff}>
            <SelectTrigger size="sm" className="w-40">
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              {qualities.map(q => (
                <SelectItem key={q.id} value={q.id}>{q.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <button
          type="button"
          onClick={remove}
          disabled={removing}
          className="text-muted-foreground hover:text-red-400 shrink-0 transition-colors"
        >
          {removing ? <Loader2Icon className="size-4 animate-spin" /> : <Trash2Icon className="size-4" />}
        </button>
      </div>
      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          <ProfileQualitiesEditor profileId={profile.id} qualities={qualities} />
          <ProfileFormatsEditor profileId={profile.id} allFormats={allFormats} />
          <ProfileIndexersEditor profileId={profile.id} indexers={profile.indexers} />
        </div>
      )}
    </div>
  );
}

function ProfilesPanel({ profiles, qualities, formats, onChange }: {
  profiles: Profile[];
  qualities: Quality[];
  formats: CustomFormat[];
  onChange: () => void;
}) {
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const existingNames = new Set(profiles.map(p => p.name.toLowerCase()));
  const presetsRemaining = PROFILE_NAME_PRESETS.filter(p => !existingNames.has(p.toLowerCase()));

  function create(profileName: string) {
    if (!profileName.trim()) return;
    setSaving(true);
    post("/api/profiles", { id: slugify(profileName), name: profileName.trim() })
      .then(r => { if (r.ok) { setName(""); setAdding(false); onChange(); } })
      .finally(() => setSaving(false));
  }

  return (
    <GlassPanel className="p-6 space-y-5">
      <div>
        <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Quality Profiles</h3>
        <p className="text-muted-foreground text-xs mt-0.5">
          A cutoff, an optional allow-list of acceptable qualities, and a set of custom formats. Assign one to each show from its detail page.
        </p>
      </div>

      {profiles.length > 0 && (
        <div className="space-y-1.5">
          {profiles.map(p => (
            <ProfileRow key={p.id} profile={p} qualities={qualities} allFormats={formats} onChange={onChange} />
          ))}
        </div>
      )}

      {presetsRemaining.length > 0 && (
        <div className="space-y-2">
          <span className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">Add common profile</span>
          <div className="flex flex-wrap gap-1.5">
            {presetsRemaining.map(preset => (
              <button
                key={preset}
                type="button"
                onClick={() => create(preset)}
                disabled={saving}
                className="flex items-center gap-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.08] border border-white/5 px-3 py-1.5 font-mono text-xs text-foreground/80 transition-colors disabled:opacity-50"
              >
                <PlusIcon className="size-3" />
                {preset}
              </button>
            ))}
          </div>
        </div>
      )}

      {!adding ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="text-muted-foreground hover:text-foreground font-mono text-xs underline decoration-dotted underline-offset-4 transition-colors"
        >
          + Name a custom profile (not in the list above)
        </button>
      ) : (
        <div className="flex items-center gap-2 rounded-lg px-4 py-3 bg-white/[0.04]">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Profile name" className="flex-1" />
          <Button size="sm" onClick={() => create(name)} disabled={saving || !name.trim()}>
            {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
          </Button>
          <button type="button" onClick={() => { setAdding(false); setName(""); }} className="text-muted-foreground hover:text-foreground p-1.5 transition-colors">
            <XIcon className="size-4" />
          </button>
        </div>
      )}

      {profiles.length === 0 && presetsRemaining.length === 0 && (
        <p className="text-muted-foreground text-sm py-2">No quality profiles yet — shows fall back to a "standard" profile with no custom formats.</p>
      )}
    </GlassPanel>
  );
}

// ---- Root -------------------------------------------------------------------

function QualityProfilesTab() {
  const [qualities, setQualities] = React.useState<Quality[]>([]);
  const [formats, setFormats] = React.useState<CustomFormat[]>([]);
  const [profiles, setProfiles] = React.useState<Profile[]>([]);
  const [loading, setLoading] = React.useState(true);

  function load() {
    Promise.all([
      fetch("/api/qualities").then(r => r.json()),
      fetch("/api/custom-formats").then(r => r.json()),
      fetch("/api/profiles").then(r => r.json()),
    ]).then(([q, f, p]) => {
      setQualities(Array.isArray(q) ? q : []);
      setFormats(Array.isArray(f) ? f : []);
      setProfiles(Array.isArray(p) ? p : []);
      setLoading(false);
    });
  }

  React.useEffect(load, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <ProfilesPanel profiles={profiles} qualities={qualities} formats={formats} onChange={load} />
      <QualitiesPanel qualities={qualities} onChange={load} onQualitiesChange={setQualities} />
      <CustomFormatsPanel formats={formats} onChange={load} />
    </>
  );
}

export { QualityProfilesTab };
