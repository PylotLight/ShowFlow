import { ArrowDownIcon, ArrowUpIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@frontend/lib/utils";

/**
 * Manual Import conflict explanation: the reason badge and the expandable
 * incoming-vs-existing panel. Shapes mirror the backend's
 * core/manual_import_explain.ts (returned per file by /api/manual-import/list).
 */

export type ReasonTone = "ok" | "info" | "warn" | "error";

export interface ImportReason {
  code: string;
  label: string;
  tone: ReasonTone;
  detail: string;
  source: "recorded" | "derived";
  at?: string;
  note?: string;
}

export interface FileSide {
  filename: string;
  releaseName?: string | null;
  container: string | null;
  sizeBytes: number | null;
  resolution: number | null;
  source: string | null;
  videoCodec: string | null;
  hdr: string | null;
  audio: string | null;
  releaseGroup: string | null;
  qualityName: string | null;
  rank: number;
  score: number;
  termScore: number;
  rejected: boolean;
  rejectReason?: string;
  detailsFrom: "probe" | "filename";
}

export type Verdict = "better" | "worse" | "same" | "different" | "larger" | "smaller" | "unknown";

export interface FieldDiff {
  field: string;
  label: string;
  incoming: string | null;
  existing: string | null;
  verdict: Verdict;
  note?: string;
}

export interface ImportComparison {
  profileId: string;
  profileName: string | null;
  upgradesAllowed: boolean;
  incoming: FileSide;
  existing: FileSide | null;
  otherExisting: string[];
  diffs: FieldDiff[];
  scoreDelta: number | null;
  sizeDelta: number | null;
  cutoff: { name: string; met: boolean } | null;
  verdict: string;
}

export interface ForceImportEffect {
  action: "add" | "replace";
  replaces: string[];
  keeps: string[];
  summary: string;
}

const TONE_CLASS: Record<ReasonTone, string> = {
  ok: "bg-green-500/10 text-green-400 border-green-500/20",
  info: "bg-sky-500/10 text-sky-300 border-sky-500/20",
  warn: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  error: "bg-destructive/10 text-destructive border-destructive/20",
};

export function ReasonBadge({ reason, className }: { reason: ImportReason; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded border px-1.5 py-px font-mono text-[11px]",
        TONE_CLASS[reason.tone] ?? TONE_CLASS.info,
        className,
      )}
      title={reason.detail}
    >
      {reason.label}
    </span>
  );
}

export function formatBytes(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (abs >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

/** "2160p · WEB-DL · Dolby Vision · 4.10 GB" one-liner for a side. */
export function sideSummary(s: FileSide | null | undefined): string | null {
  if (!s) return null;
  const parts = [
    s.resolution ? `${s.resolution}p` : null,
    s.source,
    s.hdr,
    formatBytes(s.sizeBytes),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** Signed score delta chip ("-10,000") coloured by direction. */
export function ScoreDelta({ delta }: { delta: number | null | undefined }) {
  if (delta == null) return null;
  const up = delta > 0;
  const same = delta === 0;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px]",
        same ? "text-muted-foreground" : up ? "text-green-400" : "text-red-400",
      )}
      title="Incoming score minus existing score"
    >
      {same ? "=" : up ? <ArrowUpIcon className="size-2.5" /> : <ArrowDownIcon className="size-2.5" />}
      {same ? "same score" : `${up ? "+" : ""}${delta.toLocaleString("en-US")}`}
    </span>
  );
}

function verdictClass(v: Verdict): string {
  switch (v) {
    case "better": return "text-green-400";
    case "worse": return "text-red-400";
    case "different": return "text-amber-300";
    case "larger":
    case "smaller": return "text-sky-300";
    default: return "text-foreground/60";
  }
}

function VerdictMark({ v }: { v: Verdict }) {
  if (v === "better") return <ArrowUpIcon className="mt-px size-3 shrink-0" aria-hidden />;
  if (v === "worse") return <ArrowDownIcon className="mt-px size-3 shrink-0" aria-hidden />;
  if (v === "larger") return <span aria-hidden className="shrink-0">↑</span>;
  if (v === "smaller") return <span aria-hidden className="shrink-0">↓</span>;
  if (v === "different") return <span aria-hidden className="shrink-0">≠</span>;
  return null;
}

const VERDICT_WORD: Partial<Record<Verdict, string>> = {
  better: "better",
  worse: "worse",
  larger: "larger",
  smaller: "smaller",
  different: "differs",
};

function formatWhen(at: string | undefined): string {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : ` ${d.toLocaleString()}`;
}

const GRID = "grid grid-cols-[minmax(56px,auto)_1fr_1fr] gap-x-2 md:gap-x-3";

/**
 * Expanded detail: the one-line reason, incoming vs existing with the
 * differences highlighted, profile/cutoff status, and what Force Import does.
 */
export function ConflictDetail({
  reason,
  comparison,
  forceImport,
}: {
  reason?: ImportReason;
  comparison?: ImportComparison;
  forceImport?: ForceImportEffect;
}) {
  const existing = comparison?.existing ?? null;
  return (
    <div className="space-y-3 text-xs">
      {reason && (
        <div className="flex items-start gap-2">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-1">
            <p className="text-foreground/85 break-words">{reason.detail}</p>
            {reason.note && <p className="text-amber-300 break-words">{reason.note}</p>}
            <p className="text-[10px] text-muted-foreground">
              {reason.source === "recorded"
                ? `Recorded by the importer when it skipped the file${formatWhen(reason.at)}`
                : "Worked out now with the importer's rules (no decision was recorded for this file)"}
            </p>
          </div>
        </div>
      )}

      {comparison && existing && comparison.diffs.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-white/5">
          <div className={cn(GRID, "bg-white/[0.03] px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground")}>
            <span />
            <span>Incoming</span>
            <span>Existing</span>
          </div>
          {comparison.diffs.map((d) => (
            <div
              key={d.field}
              className={cn(
                GRID,
                "items-start border-t border-white/5 px-3 py-1.5",
                d.verdict !== "same" && d.verdict !== "unknown" && "bg-white/[0.015]",
              )}
            >
              <span className="pt-px font-mono text-[9px] uppercase tracking-wider text-muted-foreground md:text-[10px]">{d.label}</span>
              <span className={cn("flex min-w-0 items-start gap-1 break-words font-mono text-[11px]", verdictClass(d.verdict))}>
                <VerdictMark v={d.verdict} />
                <span className="min-w-0">
                  {d.incoming ?? "—"}
                  {d.note && <span className="block text-[10px] opacity-80 md:ml-1 md:inline">({d.note})</span>}
                  {VERDICT_WORD[d.verdict] && <span className="sr-only"> ({VERDICT_WORD[d.verdict]})</span>}
                </span>
              </span>
              <span className="min-w-0 break-words font-mono text-[11px] text-foreground/70">{d.existing ?? "—"}</span>
            </div>
          ))}
          <div className={cn(GRID, "items-start border-t border-white/5 px-3 py-1.5")}>
            <span className="pt-px font-mono text-[10px] uppercase tracking-wider text-muted-foreground">File</span>
            <span className="min-w-0 break-all font-mono text-[10px] text-foreground/60">{comparison.incoming.filename}</span>
            <span className="min-w-0 break-all font-mono text-[10px] text-foreground/60">
              {existing.filename}
              {existing.releaseName && (
                <span className="block text-muted-foreground">from {existing.releaseName}</span>
              )}
            </span>
          </div>
        </div>
      )}

      {comparison && !existing && (
        <p className="text-muted-foreground">
          Nothing in the library for this yet
          {sideSummary(comparison.incoming) ? ` — incoming is ${sideSummary(comparison.incoming)}` : ""}.
        </p>
      )}

      {comparison && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span>
            Profile: <span className="text-foreground/80">{comparison.profileName ?? comparison.profileId}</span>
            {!comparison.upgradesAllowed && <span className="text-amber-400"> (upgrades off)</span>}
          </span>
          {comparison.cutoff && existing && (
            <span>
              Cutoff {comparison.cutoff.name}:{" "}
              <span className={comparison.cutoff.met ? "text-green-400" : "text-foreground/80"}>
                {comparison.cutoff.met ? "existing meets it" : "not met yet"}
              </span>
            </span>
          )}
          {comparison.otherExisting.length > 0 && (
            <span>Also covers: <span className="break-all font-mono text-foreground/70">{comparison.otherExisting.join(", ")}</span></span>
          )}
          {existing && comparison.incoming.detailsFrom === "filename" && (
            <span title="The importer scores the incoming file from its release name; codec/HDR/audio come from the file itself when it can be probed.">
              Incoming details read from its filename
            </span>
          )}
        </div>
      )}

      {forceImport && (
        <div
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2",
            forceImport.action === "replace"
              ? "border-amber-500/20 bg-amber-500/5 text-amber-200"
              : "border-white/5 bg-white/[0.02] text-foreground/75",
          )}
        >
          {forceImport.action === "replace" && <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />}
          <p className="min-w-0 break-words">
            <span className="font-medium">Force Import: </span>
            {forceImport.summary}
          </p>
        </div>
      )}
    </div>
  );
}
