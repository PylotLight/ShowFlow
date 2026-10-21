import { ChevronRightIcon, Loader2Icon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Button } from "@frontend/components/ui/button";
import { confirmDialog } from "@frontend/components/ui/confirm";
import { Input } from "@frontend/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { Switch } from "@frontend/components/ui/switch";
import { navigate, pageHash } from "@frontend/lib/router";
import { cn } from "@frontend/lib/utils";
import { FieldRow, SETTINGS_TEXT } from "./SettingsShared";
import { CutoffUnmetList } from "./CutoffUnmetList";
import { useSettings } from "./settings/SettingsContext";

/**
 * One profile-centric Quality screen (replaces the old qualities list, global
 * custom formats and per-profile formats). A profile = resolution target/min,
 * fixed source order with skips, term chips, upgrade-until, and a test box.
 * Model + scoring live in src/backend/core/quality_terms.ts.
 */

type Mode = "prefer" | "strong_prefer" | "avoid" | "strong_avoid" | "must" | "never";
type Source = "remux" | "bluray" | "webdl" | "webrip" | "hdtv" | "dvd" | "sdtv";

interface ProfileTerm { termId: string; mode: Mode; weight: number | null }

interface Profile {
  id: string;
  name: string;
  minResolution: number | null;
  targetResolution: number | null;
  allowUnknownResolution: boolean;
  skipSources: Source[];
  upgradesEnabled: boolean;
  upgradeUntilResolution: number | null;
  upgradeUntilSource: Source | null;
  upgradeUntilScore: number | null;
  terms: ProfileTerm[];
  migrationNote: string | null;
  usedBy: { libraryTypeId: string; name: string; shows: number }[];
  /** Read-only extras the API sends back; never saved. */
  modelVersion?: number;
  resolvedTerms?: unknown;
}

interface TermLib {
  groups: { id: string; label: string }[];
  builtins: { id: string; group: string; label: string }[];
  custom: { id: string; name: string; regex: string }[];
  modeWeights: Record<Mode, number>;
  sources: { id: Source; label: string }[];
  resolutions: number[];
  presets: (Omit<Profile, "id" | "usedBy" | "migrationNote" | "upgradeUntilResolution" | "upgradeUntilSource" | "upgradeUntilScore"> & {
    id: string;
    description: string;
    upgradeUntil: { resolution: number | null; source: Source | null } | null;
    terms: { termId: string; mode: Mode }[];
  })[];
}

const MODES: { id: Mode; label: string; short: string }[] = [
  { id: "prefer", label: "Prefer", short: "+" },
  { id: "strong_prefer", label: "Strong prefer", short: "++" },
  { id: "avoid", label: "Avoid", short: "−" },
  { id: "strong_avoid", label: "Strong avoid", short: "−−" },
  { id: "must", label: "Must have", short: "must" },
  { id: "never", label: "Never", short: "never" },
];
const MODE_LABEL = Object.fromEntries(MODES.map(m => [m.id, m.label])) as Record<Mode, string>;

/** Chip colours. Every state also carries a text suffix, so colour is never the only signal. */
const MODE_CHIP: Record<Mode, string> = {
  prefer: "border-emerald-400/60 bg-emerald-400/10 text-emerald-200",
  strong_prefer: "border-emerald-300 bg-emerald-400/20 text-emerald-100 font-semibold",
  avoid: "border-amber-400/60 bg-amber-400/10 text-amber-200",
  strong_avoid: "border-orange-400 bg-orange-500/20 text-orange-100 font-semibold",
  must: "border-sky-400/70 bg-sky-400/10 text-sky-200",
  never: "border-red-400/70 bg-red-500/15 text-red-200",
};

const CUSTOM = "custom:";
const GROUP = "group:";
const resLabel = (r: number | null) => (r == null ? "Any" : r === 4320 ? "8K" : `${r}p`);

function signed(n: number) {
  return n > 0 ? `+${n}` : String(n);
}

function slugify(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || crypto.randomUUID().slice(0, 8);
}

async function api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
  return data as T;
}

function toSave(p: Profile) {
  const { usedBy: _u, migrationNote: _m, modelVersion: _v, resolvedTerms: _r, ...rest } = p;
  return rest;
}

// ---- small building blocks ------------------------------------------------

function Section({ title, description, children, className, settingId }: { title: string; description?: string; children: React.ReactNode; className?: string; settingId?: string }) {
  return (
    <section data-setting={settingId} className={cn("space-y-3 border-t border-white/[0.06] pt-4 first:border-t-0 first:pt-0", className)}>
      <div>
        <h4 className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-signal">{title}</h4>
        {description && <p className={cn("mt-0.5", SETTINGS_TEXT.desc)}>{description}</p>}
      </div>
      {children}
    </section>
  );
}

const chipBase = "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-caption leading-none transition-colors outline-none focus-visible:ring-2 focus-visible:ring-signal/70";
const chipOff = "border-white/15 bg-white/[0.03] text-foreground/85 hover:border-white/30 hover:bg-white/[0.06]";

/** Mirrors core/cutoff.ts defaultUpgradeUntilResolution: with no explicit
 *  "until", upgrades stop at the target capped at 1080p. The target is the
 *  ceiling of what may be grabbed, not where upgrades stop. */
const DEFAULT_UNTIL = 1080;
const defaultUntil = (target: number | null) => (target != null && target > 0 ? Math.min(target, DEFAULT_UNTIL) : DEFAULT_UNTIL);

function cutoffLabel(p: Pick<Profile, "upgradeUntilResolution" | "upgradeUntilSource" | "targetResolution">, sources: { id: Source; label: string }[]): string {
  const res = p.upgradeUntilResolution ?? defaultUntil(p.targetResolution);
  const src = p.upgradeUntilSource ? sources.find(s => s.id === p.upgradeUntilSource)?.label ?? p.upgradeUntilSource : null;
  return src ? `${resLabel(res)} ${src}` : `${resLabel(res)} (any source)`;
}

function ResSelect({ value, onChange, label, allowAny, options }: { value: number | null; onChange: (v: number | null) => void; label: string; allowAny: boolean; options: number[] }) {
  return (
    <Select value={value == null ? (allowAny ? "any" : "") : String(value)} onValueChange={v => onChange(v === "any" ? null : Number(v))}>
      <SelectTrigger size="sm" className="w-32 text-sub" aria-label={label}>
        <SelectValue placeholder="Pick" />
      </SelectTrigger>
      <SelectContent>
        {allowAny && <SelectItem value="any">Any</SelectItem>}
        {options.map(r => <SelectItem key={r} value={String(r)}>{resLabel(r)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

// ---- terms -------------------------------------------------------------

function TermChips({ draft, lib, paint, onChange }: { draft: Profile; lib: TermLib; paint: Mode; onChange: (terms: ProfileTerm[]) => void }) {
  const byId = new Map(draft.terms.map(t => [t.termId, t]));
  function toggle(termId: string) {
    const cur = byId.get(termId);
    if (cur && cur.mode === paint) onChange(draft.terms.filter(t => t.termId !== termId));
    else if (cur) onChange(draft.terms.map(t => (t.termId === termId ? { ...t, mode: paint, weight: null } : t)));
    else onChange([...draft.terms, { termId, mode: paint, weight: null }]);
  }
  const groups = [
    ...lib.groups.map(g => ({ ...g, terms: lib.builtins.filter(t => t.group === g.id).map(t => ({ id: t.id, label: t.label })) })),
    { id: "custom", label: "Custom", terms: lib.custom.map(c => ({ id: CUSTOM + c.id, label: c.name })) },
  ];
  return (
    <div className="space-y-2.5">
      {groups.map(({ terms, ...g }) => {
        if (!terms.length) return null;
        return (
          <div key={g.id} className="grid gap-1.5 sm:grid-cols-[8.5rem_1fr] sm:items-baseline">
            <span className="text-caption text-muted-foreground">{g.label}</span>
            <div className="flex flex-wrap gap-1.5">
              {terms.map(t => {
                const on = byId.get(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggle(t.id)}
                    aria-pressed={!!on}
                    aria-label={on ? `${t.label}: ${MODE_LABEL[on.mode]}. Click to ${on.mode === paint ? "clear" : `set ${MODE_LABEL[paint]}`}` : `${t.label}: off. Click to set ${MODE_LABEL[paint]}`}
                    className={cn(chipBase, on ? MODE_CHIP[on.mode] : chipOff)}
                  >
                    <span className={cn(on?.mode === "never" && "line-through decoration-1")}>{t.label}</span>
                    {on && <span className="font-mono text-[11px]">{MODES.find(m => m.id === on.mode)!.short}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Per-profile release groups: type a group (or pick one seen in your own
 * grabs/files) and it's added in the current click mode. Matches the parsed
 * group exactly, case-insensitive: leading `[Group]` or trailing `-GROUP`.
 */
function ReleaseGroupsRow({ draft, paint, onChange }: { draft: Profile; paint: Mode; onChange: (terms: ProfileTerm[]) => void }) {
  const [text, setText] = React.useState("");
  const [seen, setSeen] = React.useState<{ name: string; count: number }[]>([]);
  React.useEffect(() => {
    api<{ name: string; count: number }[]>("/api/quality/release-groups?limit=60").then(r => setSeen(Array.isArray(r) ? r : [])).catch(() => {});
  }, []);
  const groups = draft.terms.filter(t => t.termId.startsWith(GROUP));
  const have = new Set(groups.map(t => t.termId.slice(GROUP.length).toLowerCase()));

  function add(raw: string) {
    const name = raw.trim().replace(/^\[|\]$/g, "").replace(/^-/, "").trim();
    if (!name || name.length > 40) return;
    if (have.has(name.toLowerCase())) {
      toast.message(`${name} is already on this profile`);
      return;
    }
    onChange([...draft.terms, { termId: GROUP + name, mode: paint, weight: null }]);
    setText("");
  }
  function repaint(termId: string) {
    const cur = draft.terms.find(t => t.termId === termId);
    if (!cur) return;
    if (cur.mode === paint) onChange(draft.terms.filter(t => t.termId !== termId));
    else onChange(draft.terms.map(t => (t.termId === termId ? { ...t, mode: paint, weight: null } : t)));
  }
  const q = text.trim().toLowerCase();
  const suggestions = seen.filter(s => !have.has(s.name.toLowerCase()) && (!q || s.name.toLowerCase().includes(q))).slice(0, 8);

  return (
    <div className="grid gap-1.5 sm:grid-cols-[8.5rem_1fr] sm:items-baseline">
      <span className="text-caption text-muted-foreground">Release groups</span>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {groups.map(t => {
            const name = t.termId.slice(GROUP.length);
            return (
              <span key={t.termId} className={cn("inline-flex items-center rounded-full border text-caption leading-none", MODE_CHIP[t.mode])}>
                <button
                  type="button"
                  onClick={() => repaint(t.termId)}
                  aria-label={`${name}: ${MODE_LABEL[t.mode]}. Click to ${t.mode === paint ? "remove" : `set ${MODE_LABEL[paint]}`}`}
                  className="inline-flex items-center gap-1 rounded-full py-1 pl-2.5 pr-1 outline-none focus-visible:ring-2 focus-visible:ring-signal/70"
                >
                  <span className={cn(t.mode === "never" && "line-through decoration-1")}>{name}</span>
                  <span className="font-mono text-[11px]">{MODES.find(m => m.id === t.mode)!.short}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onChange(draft.terms.filter(x => x.termId !== t.termId))}
                  aria-label={`Remove release group ${name}`}
                  className="mr-1 rounded-full p-0.5 opacity-80 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-signal/70"
                >
                  <XIcon className="size-3" aria-hidden />
                </button>
              </span>
            );
          })}
          <form onSubmit={e => { e.preventDefault(); add(text); }} className="flex items-center gap-1.5">
            <Input
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder={groups.length ? "add another" : "type a group, e.g. SubsPlease"}
              aria-label="Add a release group"
              className="h-7 w-44 text-caption"
            />
            <Button type="submit" size="sm" variant="secondary" className="h-7" disabled={!text.trim()}>
              <PlusIcon className="size-3.5" /> {MODE_LABEL[paint]}
            </Button>
          </form>
        </div>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">Seen in your library</span>
            {suggestions.map(s => (
              <button
                key={s.name}
                type="button"
                onClick={() => add(s.name)}
                aria-label={`Add ${s.name} (${s.count} releases) as ${MODE_LABEL[paint]}`}
                className={cn(chipBase, chipOff, "px-2 py-0.5")}
              >
                {s.name}
                <span className="font-mono text-[11px] text-muted-foreground">{s.count}</span>
              </button>
            ))}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">Exact name, any case. Matches a leading [Group] or a trailing -GROUP.</p>
      </div>
    </div>
  );
}

function PaintBar({ paint, setPaint, weights }: { paint: Mode; setPaint: (m: Mode) => void; weights: Record<Mode, number> }) {
  return (
    <div role="radiogroup" aria-label="What a click on a term sets" className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-caption text-muted-foreground">Click a term to</span>
      {MODES.map(m => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={paint === m.id}
          onClick={() => setPaint(m.id)}
          className={cn(chipBase, paint === m.id ? MODE_CHIP[m.id] : chipOff)}
        >
          {m.label}
          {weights[m.id] !== 0 && <span className="font-mono text-[11px]">{signed(weights[m.id])}</span>}
        </button>
      ))}
    </div>
  );
}

function AdvancedSection({ draft, lib, onChange, onLibChange }: {
  draft: Profile;
  lib: TermLib;
  onChange: (terms: ProfileTerm[]) => void;
  onLibChange: () => void;
}) {
  const [name, setName] = React.useState("");
  const [regex, setRegex] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const byId = new Map(draft.terms.map(t => [t.termId, t]));
  const builtinLabel = new Map(lib.builtins.map(b => [b.id, b.label]));
  const active = draft.terms.filter(t => !t.termId.startsWith(CUSTOM) && t.mode !== "must" && t.mode !== "never");

  function setCustomMode(id: string, mode: Mode | "off") {
    const termId = CUSTOM + id;
    if (mode === "off") return onChange(draft.terms.filter(t => t.termId !== termId));
    const cur = byId.get(termId);
    if (cur) onChange(draft.terms.map(t => (t.termId === termId ? { ...t, mode } : t)));
    else onChange([...draft.terms, { termId, mode, weight: null }]);
  }
  function setWeight(termId: string, raw: string) {
    const weight = raw.trim() === "" ? null : Number(raw);
    if (weight != null && !Number.isFinite(weight)) return;
    onChange(draft.terms.map(t => (t.termId === termId ? { ...t, weight } : t)));
  }
  async function addCustom(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !regex.trim()) return;
    setBusy(true);
    try {
      const created = await api<{ id: string }>("/api/quality/custom-terms", "POST", { name: name.trim(), regex: regex.trim() });
      onChange([...draft.terms, { termId: CUSTOM + created.id, mode: "prefer", weight: null }]);
      setName("");
      setRegex("");
      onLibChange();
    } catch (err) {
      toast.error("Couldn't add term", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }
  async function removeCustom(id: string, label: string) {
    if (!(await confirmDialog({ title: `Delete custom term "${label}"?`, description: "It's removed from every profile that uses it.", destructive: true, confirmLabel: "Delete" }))) return;
    try {
      await api(`/api/quality/custom-terms/${encodeURIComponent(id)}`, "DELETE");
      onChange(draft.terms.filter(t => t.termId !== CUSTOM + id));
      onLibChange();
    } catch (err) {
      toast.error("Couldn't delete term", { description: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <details className="group rounded-lg border border-white/[0.08] bg-white/[0.02]">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2.5 text-sub font-medium outline-none focus-visible:ring-2 focus-visible:ring-signal/70">
        <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
        Advanced
        <span className="text-caption font-normal text-muted-foreground">custom regex terms, numeric weights (incl. groups)</span>
      </summary>
      <div className="space-y-4 px-3 pb-3">
        <div className="space-y-2">
          <p className={SETTINGS_TEXT.label}>Custom terms</p>
          {lib.custom.length === 0 && <p className={SETTINGS_TEXT.desc}>None yet. Add one for anything the library doesn't cover.</p>}
          <ul className="space-y-1.5">
            {lib.custom.map(c => {
              const t = byId.get(CUSTOM + c.id);
              return (
                <li key={c.id} className="grid grid-cols-[minmax(0,1fr)_5.5rem_auto] items-center gap-2 rounded-md bg-white/[0.03] px-2.5 py-1.5 sm:grid-cols-[minmax(0,1fr)_9rem_6rem_auto]">
                  <div className="col-span-3 min-w-0 sm:col-span-1">
                    <span className="text-sub">{c.name}</span>
                    <code className="ml-2 break-all font-mono text-[11px] text-muted-foreground">/{c.regex}/i</code>
                  </div>
                  <Select value={t?.mode ?? "off"} onValueChange={v => setCustomMode(c.id, v as Mode | "off")}>
                    <SelectTrigger size="sm" className="w-full text-caption" aria-label={`${c.name} on this profile`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">Off</SelectItem>
                      {MODES.map(m => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    inputMode="numeric"
                    disabled={!t || t.mode === "must" || t.mode === "never"}
                    value={t?.weight ?? ""}
                    placeholder={t ? String(lib.modeWeights[t.mode]) : "—"}
                    onChange={e => t && setWeight(t.termId, e.target.value)}
                    aria-label={`${c.name} weight`}
                    className="h-8 font-mono text-caption"
                  />
                  <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={`Delete custom term ${c.name}`} onClick={() => removeCustom(c.id, c.name)}>
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </li>
              );
            })}
          </ul>
          <form onSubmit={addCustom} className="flex flex-wrap items-center gap-2">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Name, e.g. Team" aria-label="Custom term name" className="h-8 w-full text-sub sm:w-40" />
            <Input value={regex} onChange={e => setRegex(e.target.value)} placeholder="Regex, e.g. \[Team\]" aria-label="Custom term regex" className="h-8 min-w-48 flex-1 font-mono text-caption" />
            <Button type="submit" size="sm" variant="secondary" disabled={busy || !name.trim() || !regex.trim()}>
              <PlusIcon className="size-3.5" /> Add
            </Button>
          </form>
        </div>

        {active.length > 0 && (
          <div className="space-y-2">
            <p className={SETTINGS_TEXT.label}>Weight overrides</p>
            <p className={SETTINGS_TEXT.desc}>Leave empty to use the fixed step. Only for when the steps really don't fit.</p>
            <div className="flex flex-wrap gap-2">
              {active.map(t => (
                <label key={t.termId} className="flex items-center gap-1.5 rounded-md bg-white/[0.03] px-2 py-1">
                  <span className="text-caption">{t.termId.startsWith(GROUP) ? `${t.termId.slice(GROUP.length)} (group)` : builtinLabel.get(t.termId) ?? t.termId}</span>
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={t.weight ?? ""}
                    placeholder={String(lib.modeWeights[t.mode])}
                    onChange={e => setWeight(t.termId, e.target.value)}
                    className="h-7 w-20 font-mono text-caption"
                  />
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

// ---- test box --------------------------------------------------------------

interface TermHit { termId: string; label: string; mode: Mode; weight: number; matched: boolean; invalid?: boolean }
interface ReleaseTestResult {
  resolution: number | null;
  source: string | null;
  releaseGroup?: string | null;
  quality: { name: string; rank: number } | null;
  terms: TermHit[];
  termScore: number;
  totalScore: number;
  allowed: boolean;
  rejectReason: string | null;
  cutoff: { name: string; rank: number; met: boolean; minTermScore: number | null } | null;
  upgradesEnabled: boolean;
}

function TestBox({ profileId, dirty }: { profileId: string; dirty: boolean }) {
  const [name, setName] = React.useState("");
  const [result, setResult] = React.useState<ReleaseTestResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => { setResult(null); }, [profileId]);

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api<ReleaseTestResult>("/api/quality/test", "POST", { name: name.trim(), profileId }));
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const matched = result?.terms.filter(t => t.matched) ?? [];
  return (
    <div className="space-y-2.5">
      <form onSubmit={run} className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-NTb"
          aria-label="Release name to test"
          className="h-8 min-w-56 flex-1 font-mono text-caption"
        />
        <Button type="submit" size="sm" disabled={busy || !name.trim()}>
          {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : "Test"}
        </Button>
      </form>
      {dirty && <p className="text-caption text-amber-200">Tests the saved profile. Save to test your changes.</p>}
      {error && <p role="alert" className="text-caption text-red-300">{error}</p>}
      {result && (
        <div className="space-y-2 rounded-lg bg-white/[0.03] px-3 py-2.5" aria-live="polite">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sub">
            <span className={cn("font-mono font-semibold", result.allowed ? "text-emerald-300" : "text-red-300")}>
              {result.allowed ? "Accepted" : "Rejected"}
            </span>
            <span className="font-mono">score {result.totalScore}</span>
            <span className="text-muted-foreground">
              {result.quality?.name ?? "unknown quality"}
              {result.quality && <span className="font-mono"> · rank {result.quality.rank}</span>}
            </span>
            {result.cutoff ? (
              <span className={cn("font-mono text-caption", result.cutoff.met ? "text-emerald-300" : "text-amber-200")}>
                upgrade until {result.cutoff.name}: {result.cutoff.met ? "reached" : "not yet"}
              </span>
            ) : (
              <span className="font-mono text-caption text-muted-foreground">upgrades off</span>
            )}
          </div>
          {!result.allowed && result.rejectReason && <p className="text-caption text-red-300">{result.rejectReason}</p>}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted-foreground">
            <span>resolution <span className="font-mono text-foreground">{result.resolution ? `${result.resolution}p` : "?"}</span></span>
            <span>source <span className="font-mono text-foreground">{result.source ?? "?"}</span></span>
            <span>group <span className="font-mono text-foreground">{result.releaseGroup ?? "none"}</span></span>
            <span>terms <span className="font-mono text-foreground">{signed(result.termScore)}</span></span>
          </div>
          {matched.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {matched.map(t => (
                <span key={t.termId} className={cn(chipBase, MODE_CHIP[t.mode], "cursor-default")}>
                  {t.label}
                  <span className="font-mono text-[11px]">{t.mode === "must" || t.mode === "never" ? MODE_LABEL[t.mode].toLowerCase() : signed(t.weight)}</span>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-caption text-muted-foreground">No terms on this profile matched.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ---- profile editor -----------------------------------------------------------

function ProfileEditor({ profile, lib, profiles, onSaved, onDeleted, onLibChange }: {
  profile: Profile;
  lib: TermLib;
  profiles: Profile[];
  onSaved: (p: Profile) => void;
  onDeleted: (id: string) => void;
  onLibChange: () => void;
}) {
  const [draft, setDraft] = React.useState<Profile>(profile);
  const giveUp = useGiveUpPolicy();
  const [paint, setPaint] = React.useState<Mode>("prefer");
  const [saving, setSaving] = React.useState(false);
  // Reset the draft only when the saved profile itself changes (save, reload),
  // not when e.g. the migration note is dismissed, so unsaved edits survive.
  const savedKey = JSON.stringify(toSave(profile));
  React.useEffect(() => { setDraft(profile); }, [savedKey]);

  const dirty = JSON.stringify(toSave(draft)) !== JSON.stringify(toSave(profile));
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setDraft(d => ({ ...d, [k]: v }));
  const minBad = draft.minResolution != null && draft.targetResolution != null && draft.minResolution > draft.targetResolution;

  async function save() {
    setSaving(true);
    try {
      const saved = await api<Profile>("/api/profiles", "POST", toSave(draft));
      onSaved(saved);
      toast.success(`Saved "${saved.name}"`);
    } catch (err) {
      toast.error("Couldn't save profile", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (profiles.length <= 1) return;
    if (!(await confirmDialog({ title: `Delete "${profile.name}"?`, destructive: true, confirmLabel: "Delete" }))) return;
    try {
      await api(`/api/profiles/${encodeURIComponent(profile.id)}`, "DELETE");
      onDeleted(profile.id);
    } catch (err) {
      toast.error("Couldn't delete profile", { description: err instanceof Error ? err.message : String(err) });
    }
  }
  async function dismissNote() {
    try {
      await api(`/api/profiles/${encodeURIComponent(profile.id)}/migration-note`, "DELETE");
      onSaved({ ...profile, migrationNote: null });
    } catch { /* non-critical */ }
  }

  const skip = new Set(draft.skipSources);
  const toggleSource = (s: Source) => set("skipSources", skip.has(s) ? draft.skipSources.filter(x => x !== s) : [...draft.skipSources, s]);
  const usedBy = profile.usedBy;

  return (
    <GlassPanel className="space-y-5 p-5 sm:p-6">
      {profile.migrationNote && (
        <div role="status" className="flex gap-3 rounded-lg border border-sky-400/40 bg-sky-400/[0.07] px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-sub font-medium text-sky-100">Converted from your old quality setup</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-caption text-sky-100/90">
              {profile.migrationNote.split("\n").map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          </div>
          <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label="Dismiss conversion notice" onClick={dismissNote}>
            <XIcon className="size-3.5" />
          </Button>
        </div>
      )}

      <Section title="Profile">
        <FieldRow settingId="quality.profile-name" label="Name" description="Shown wherever you pick a profile.">
          <Input value={draft.name} onChange={e => set("name", e.target.value)} aria-label="Profile name" className="h-8 text-sub" />
        </FieldRow>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={SETTINGS_TEXT.desc}>
            {usedBy.length
              ? <>Used by {usedBy.map((u, i) => <React.Fragment key={u.libraryTypeId}>{i > 0 && ", "}<span className="text-foreground">{u.name}</span> ({u.shows} {u.shows === 1 ? "show" : "shows"})</React.Fragment>)}. </>
              : "Not used by any library type yet. "}
            <button type="button" className="text-signal underline-offset-2 hover:underline outline-none focus-visible:ring-2 focus-visible:ring-signal/70 rounded" onClick={() => navigate(pageHash("settings", "general", "libraries"))}>
              Library types
            </button>
          </p>
          <Button type="button" variant="ghost" size="sm" className="text-red-300 hover:text-red-200" disabled={profiles.length <= 1 || usedBy.length > 0} onClick={remove}
            title={usedBy.length ? "Pick another profile on those library types first" : undefined}>
            <Trash2Icon className="size-3.5" /> Delete
          </Button>
        </div>
      </Section>

      <Section title="Resolution" description="Aim for the target; anything above it is skipped, anything below the minimum too.">
        <FieldRow settingId="quality.resolution-target" label="Target" description="Highest resolution to grab; anything above is skipped. Not the upgrade cutoff, that's under Upgrades.">
          <ResSelect label="Target resolution" value={draft.targetResolution} onChange={v => set("targetResolution", v)} allowAny options={lib.resolutions} />
        </FieldRow>
        <FieldRow settingId="quality.resolution-minimum" label="Minimum" description="Lowest resolution you'll accept.">
          <ResSelect label="Minimum resolution" value={draft.minResolution} onChange={v => set("minResolution", v)} allowAny options={lib.resolutions} />
        </FieldRow>
        {minBad && <p role="alert" className="text-caption text-red-300">Minimum is above the target.</p>}
        <FieldRow settingId="quality.unknown-resolution" label="Unknown resolution" description="Accept names with no resolution tag (common on anime). They rank below any known resolution.">
          <Switch checked={draft.allowUnknownResolution} onCheckedChange={v => set("allowUnknownResolution", v)} aria-label="Accept unknown resolution" />
        </FieldRow>
      </Section>

      <Section settingId="quality.sources" title="Sources" description="Fixed order, best first. Turn off any you never want.">
        <div className="flex flex-wrap items-center gap-1.5">
          {lib.sources.map((s, i) => {
            const off = skip.has(s.id);
            return (
              <React.Fragment key={s.id}>
                {i > 0 && <span aria-hidden className="text-caption text-muted-foreground">›</span>}
                <button
                  type="button"
                  aria-pressed={!off}
                  aria-label={`${s.label}: ${off ? "skipped" : "allowed"}`}
                  onClick={() => toggleSource(s.id)}
                  className={cn(chipBase, off ? "border-white/15 bg-transparent text-muted-foreground line-through" : "border-white/25 bg-white/[0.06] text-foreground")}
                >
                  {s.label}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </Section>

      <Section settingId="quality.terms" title="Terms" description="Each term counts once. Strong avoid beats a codec bonus, Never rejects outright.">
        <PaintBar paint={paint} setPaint={setPaint} weights={lib.modeWeights} />
        <TermChips draft={draft} lib={lib} paint={paint} onChange={t => set("terms", t)} />
        <ReleaseGroupsRow draft={draft} paint={paint} onChange={t => set("terms", t)} />
        <AdvancedSection draft={draft} lib={lib} onChange={t => set("terms", t)} onLibChange={onLibChange} />
      </Section>

      <Section title="Upgrades" description="Off means off: no upgrade searches, and imports never replace a file you already have.">
        <FieldRow settingId="quality.keep-upgrading" label="Keep upgrading" description="Look for better releases after the first grab.">
          <Switch
            checked={draft.upgradesEnabled}
            onCheckedChange={v => setDraft(d => ({
              ...d,
              upgradesEnabled: v,
              // Start from the default cutoff (target capped at 1080p), never
              // silently from a 2160p/"any" target.
              upgradeUntilResolution: v && d.upgradeUntilResolution == null ? defaultUntil(d.targetResolution) : d.upgradeUntilResolution,
            }))}
            aria-label="Keep upgrading"
          />
        </FieldRow>
        {draft.upgradesEnabled && (
          <FieldRow settingId="quality.upgrade-until" label="Until (cutoff)" description="Stop once the file reaches this. Optional term score keeps going until terms catch up too.">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <ResSelect label="Upgrade until resolution" value={draft.upgradeUntilResolution ?? defaultUntil(draft.targetResolution)} onChange={v => set("upgradeUntilResolution", v)} allowAny={false} options={lib.resolutions} />
              <Select value={draft.upgradeUntilSource ?? "any"} onValueChange={v => set("upgradeUntilSource", v === "any" ? null : (v as Source))}>
                <SelectTrigger size="sm" className="w-28 text-sub" aria-label="Upgrade until source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any source</SelectItem>
                  {lib.sources.filter(s => s.id !== "sdtv" && s.id !== "dvd").map(s => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input
                type="number"
                inputMode="numeric"
                value={draft.upgradeUntilScore ?? ""}
                placeholder="score ≥"
                onChange={e => set("upgradeUntilScore", e.target.value.trim() === "" ? null : Number(e.target.value))}
                aria-label="Upgrade until term score"
                className="h-8 w-24 font-mono text-caption"
              />
            </div>
          </FieldRow>
        )}
        {draft.upgradesEnabled && (
          <div className="space-y-2">
            <p data-testid="cutoff-summary" className={SETTINGS_TEXT.desc}>
              Cutoff: files below <span className="text-foreground">{cutoffLabel(draft, lib.sources)}</span>
              {draft.upgradeUntilScore != null && <> or a term score under <span className="text-foreground">{draft.upgradeUntilScore}</span></>}
              {" "}get upgrade searches; at or above it they're left alone.
              {draft.upgradeUntilResolution == null && " (Default: the target, capped at 1080p.)"}
            </p>
            {(draft.upgradeUntilResolution ?? 0) > DEFAULT_UNTIL && (
              <p data-testid="cutoff-give-up-info" className={SETTINGS_TEXT.desc}>
                Upgrades keep searching until {resLabel(draft.upgradeUntilResolution!)}
                {giveUp.misses > 0 ? `; searches give up after ${giveUp.misses} ${giveUp.misses === 1 ? "miss" : "misses"} in a row` : "; searches never give up"}
                {giveUp.days > 0 ? ` and skip episodes aired more than ${giveUp.days} days ago.` : " (no age limit)."}
              </p>
            )}
            <CutoffUnmetList profileId={profile.id} dirty={dirty} />
          </div>
        )}
      </Section>

      <Section settingId="quality.test-release" title="Test a release" description="Paste a title to see how this profile parses and scores it. Nothing is grabbed.">
        <TestBox profileId={profile.id} dirty={dirty} />
      </Section>

      <div className="sticky bottom-0 -mx-5 -mb-5 flex items-center justify-end gap-2 rounded-b-xl border-t border-white/[0.08] bg-background/95 px-5 py-3 backdrop-blur-md sm:-mx-6 sm:-mb-6 sm:px-6">
        {dirty && <span className="mr-auto text-caption text-amber-200">Unsaved changes</span>}
        <Button type="button" variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => setDraft(profile)}>Reset</Button>
        <Button type="button" size="sm" disabled={!dirty || saving || minBad || !draft.name.trim()} onClick={save}>
          {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : "Save profile"}
        </Button>
      </div>
    </GlassPanel>
  );
}

// ---- root ----------------------------------------------------------------------

function QualityProfilesTab() {
  const [profiles, setProfiles] = React.useState<Profile[]>([]);
  const [lib, setLib] = React.useState<TermLib | null>(null);
  const [selected, setSelected] = React.useState<string>("");
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);

  const loadLib = React.useCallback(() => api<TermLib>("/api/quality/terms").then(setLib).catch(() => {}), []);
  React.useEffect(() => {
    Promise.all([api<Profile[]>("/api/profiles"), api<TermLib>("/api/quality/terms")])
      .then(([p, l]) => {
        setProfiles(Array.isArray(p) ? p : []);
        setLib(l);
        setSelected(s => s || p[0]?.id || "");
      })
      .catch(err => toast.error("Couldn't load quality profiles", { description: String(err) }))
      .finally(() => setLoading(false));
  }, []);

  async function createFrom(presetId: string | null) {
    if (!lib) return;
    setCreating(true);
    try {
      const preset = presetId ? lib.presets.find(p => p.id === presetId) : null;
      const baseName = preset?.name ?? "New profile";
      let name = baseName;
      for (let n = 2; profiles.some(p => p.name.toLowerCase() === name.toLowerCase()); n++) name = `${baseName} ${n}`;
      let id = slugify(name);
      while (profiles.some(p => p.id === id)) id = `${id}-${crypto.randomUUID().slice(0, 4)}`;
      const body = preset
        ? {
            id, name,
            minResolution: preset.minResolution, targetResolution: preset.targetResolution,
            allowUnknownResolution: preset.allowUnknownResolution, skipSources: preset.skipSources,
            upgradesEnabled: preset.upgradesEnabled,
            upgradeUntilResolution: preset.upgradeUntil?.resolution ?? null, upgradeUntilSource: preset.upgradeUntil?.source ?? null,
            terms: preset.terms,
          }
        : { id, name, minResolution: 720, targetResolution: 1080, allowUnknownResolution: true, skipSources: [], upgradesEnabled: false, terms: [] };
      const saved = await api<Profile>("/api/profiles", "POST", body);
      setProfiles(ps => [...ps, saved]);
      setSelected(saved.id);
    } catch (err) {
      toast.error("Couldn't create profile", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setCreating(false);
    }
  }

  if (loading || !lib) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    );
  }

  const current = profiles.find(p => p.id === selected) ?? profiles[0];
  return (
    <div className="space-y-4">
      <GlassPanel data-setting="quality.profiles" className="space-y-3 p-5 sm:p-6">
        <div>
          <h3 className="font-display text-base font-semibold tracking-wide text-foreground">Quality profiles</h3>
          <p className={cn("mt-0.5", SETTINGS_TEXT.desc)}>
            What to grab and when to stop upgrading. Library types pick which profile their shows use.{" "}
            Coming from Sonarr?{" "}
            <button type="button" className="rounded text-signal underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-signal/70" onClick={() => navigate(pageHash("settings", "integrations"))}>
              Sonarr import
            </button>{" "}
            picks one of these per series type.
          </p>
        </div>
        <div role="tablist" aria-label="Profiles" className="flex flex-wrap gap-1.5">
          {profiles.map(p => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={p.id === current?.id}
              onClick={() => setSelected(p.id)}
              className={cn(
                "rounded-lg border px-3 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-signal/70",
                p.id === current?.id ? "border-signal/60 bg-signal/10" : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]",
              )}
            >
              <span className="block text-sub font-medium">{p.name}</span>
              <span className="block text-[11px] text-muted-foreground">
                {(() => { const n = p.usedBy.reduce((a, u) => a + u.shows, 0); return p.usedBy.length ? `${n} ${n === 1 ? "show" : "shows"}` : "unused"; })()}
                {p.migrationNote ? " · converted" : ""}
              </span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-caption text-muted-foreground">New from preset</span>
          {lib.presets.map(p => (
            <Button key={p.id} type="button" variant="secondary" size="sm" disabled={creating} title={p.description} onClick={() => createFrom(p.id)}>
              <PlusIcon className="size-3.5" /> {p.name}
            </Button>
          ))}
          <Button type="button" variant="ghost" size="sm" disabled={creating} onClick={() => createFrom(null)}>
            <PlusIcon className="size-3.5" /> Blank
          </Button>
        </div>
      </GlassPanel>

      {current && (
        <ProfileEditor
          key={current.id}
          profile={current}
          lib={lib}
          profiles={profiles}
          onSaved={p => setProfiles(ps => ps.map(x => (x.id === p.id ? p : x)))}
          onDeleted={id => { setProfiles(ps => ps.filter(x => x.id !== id)); setSelected(""); }}
          onLibChange={loadLib}
        />
      )}

      <UpgradeGiveUpPanel />
    </div>
  );
}

const GIVE_UP_MISSES = [0, 3, 4, 5, 6, 8, 12];
const GIVE_UP_DAYS = [0, 30, 60, 90, 180, 365];

/**
 * When scheduled upgrade searches stop (all profiles; config
 * upgradeGiveUpMisses / upgradeGiveUpAfterDays, see core/cutoff.ts). Given-up
 * episodes aren't searched or counted as below cutoff any more, but RSS
 * still grabs a better release if one shows up, and a new file, a
 * profile/cutoff change or a manual search starts them over.
 */
/** Current give-up rules (defaults mirror core/cutoff.ts). */
function useGiveUpPolicy(): { misses: number; days: number } {
  const { config } = useSettings();
  return {
    misses: typeof config?.upgradeGiveUpMisses === "number" ? config.upgradeGiveUpMisses : 5,
    days: typeof config?.upgradeGiveUpAfterDays === "number" ? config.upgradeGiveUpAfterDays : 90,
  };
}

function UpgradeGiveUpPanel() {
  const { saveConfig } = useSettings();
  const { misses, days } = useGiveUpPolicy();
  const opts = (list: number[], cur: number) => (list.includes(cur) ? list : [...list, cur].sort((a, b) => a - b));
  return (
    <GlassPanel className="space-y-4 p-5 sm:p-6" data-setting="quality.give-up">
      <Section title="Upgrade searches · all profiles" description="Stop chasing a cutoff that never gets met. Given-up episodes aren't searched or listed as below cutoff; RSS still takes a better release if one turns up, and a new file, a cutoff change or a manual search starts them over.">
        <FieldRow settingId="quality.give-up-misses" label="Give up after" description="Searches in a row that found nothing better (backoff 6h, 1d, 3d, then weekly; the default 5 is about 11 days).">
          <Select value={String(misses)} onValueChange={v => saveConfig({ upgradeGiveUpMisses: Number(v) })}>
            <SelectTrigger size="sm" className="w-32 text-sub" aria-label="Give up after misses"><SelectValue /></SelectTrigger>
            <SelectContent>
              {opts(GIVE_UP_MISSES, misses).map(n => <SelectItem key={n} value={String(n)}>{n === 0 ? "Never" : `${n} misses`}</SelectItem>)}
            </SelectContent>
          </Select>
        </FieldRow>
        <FieldRow settingId="quality.give-up-days" label="Only recent episodes" description="No upgrade searches for episodes that aired longer ago than this.">
          <Select value={String(days)} onValueChange={v => saveConfig({ upgradeGiveUpAfterDays: Number(v) })}>
            <SelectTrigger size="sm" className="w-32 text-sub" aria-label="Upgrade search age limit"><SelectValue /></SelectTrigger>
            <SelectContent>
              {opts(GIVE_UP_DAYS, days).map(n => <SelectItem key={n} value={String(n)}>{n === 0 ? "No limit" : `${n} days`}</SelectItem>)}
            </SelectContent>
          </Select>
        </FieldRow>
      </Section>
    </GlassPanel>
  );
}

export { QualityProfilesTab };
