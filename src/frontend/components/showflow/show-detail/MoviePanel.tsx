import { Check, DownloadIcon, ExternalLink, Loader2Icon, SearchIcon, Star } from "lucide-react";
import * as React from "react";

import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { MediaBadges } from "@frontend/components/showflow/MediaBadges";
import { formatBitrate, formatDuration, formatImportDate, formatResolution } from "@frontend/lib/airtime";

import { channelsLabel, focusRing, formatMovieBytes, langLabel, pillButton, pillButtonPrimary } from "./format";
import type { MovieFileInfo } from "./types";

/** One label/value line inside a media/release spec list. Renders nothing when
 *  the value is empty so missing data collapses cleanly. */
export function SpecRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 font-mono text-[11px] uppercase tracking-wider text-white/65">{label}</dt>
      <dd className="text-right font-mono text-[12px] text-white/80">{value}</dd>
    </div>
  );
}

/** A small section heading with an optional trailing accent icon. */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-white/65">
      {children}
    </div>
  );
}

/**
 * Detail body for films: no seasons/episodes exist, so this shows the
 * metadata + file status with Browse/Auto-grab actions instead of the
 * episode list.
 */
export function MoviePanel({ showId, showTitle, onBrowse, onAutoGrab, grabbing }: {
  showId: string;
  showTitle: string;
  onBrowse: () => void;
  onAutoGrab: () => void;
  grabbing: boolean;
}) {
  const [year, setYear] = React.useState<number | null>(null);
  const [movieFile, setMovieFile] = React.useState<MovieFileInfo | null>(null);
  const [meta, setMeta] = React.useState<{
    overview?: string | null; genres?: string[] | null; rating?: number | null; ratingSource?: string | null; ratingVotes?: number | null;
    firstAirDate?: string | null; status?: string | null; runtime?: number | null; studios?: string[] | null;
    languages?: string[] | null; links?: { label: string; url: string }[] | null;
  } | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/shows/${showId}`)
      .then(r => r.json())
      .then(async (data) => {
        if (cancelled) return;
        setYear(typeof data.year === "number" ? data.year : null);
        setMovieFile(data.movieFile ?? null);
        if (data.providerType === "tmdb" && data.providerId) {
          try {
            const m = await fetch(`/api/providers/tmdb/show/${data.providerId}?kind=movie`).then(r => r.json());
            if (!cancelled) setMeta(m);
          } catch {}
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [showId]);

  const media = movieFile?.media ?? null;
  const releaseTags = media?.releaseTags ?? [];
  const resolution = (media?.videoHeight || media?.videoWidth)
    ? formatResolution(media?.videoHeight, media?.videoWidth) : "";
  const videoLabel = [media?.videoCodec?.toUpperCase(), media?.videoFps && Math.round(media.videoFps) > 24 ? `${Math.round(media.videoFps)}fps` : ""]
    .filter(Boolean).join(" · ");
  const audioLabel = media?.audioCodec
    ? [media.audioCodec.toUpperCase(), channelsLabel(media.audioChannels), releaseTags.includes("Atmos") ? "Atmos" : ""].filter(Boolean).join(" ")
    : "";
  const audioLangs = (media?.audioLanguages ?? []).map(langLabel).join(" · ");
  const hdrLabel = media?.hdrFormat ?? (media?.hdr ? "HDR" : "");

  return (
    <GlassPanel className="p-5 flex flex-col gap-4">
      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <div className="size-4 rounded-full border border-muted-foreground/40 border-t-transparent animate-spin" />
          Loading movie...
        </div>
      ) : (
        <>
          {/* Header: kind / status / rating on the left, availability on the right */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-white/60 bg-white/[0.06] border border-white/10 rounded-full px-2 py-0.5">
                Movie{year ? ` · ${year}` : ""}
              </span>
              {meta?.status && (
                <span className="font-mono text-[11px] uppercase tracking-wider text-white/65">{meta.status}</span>
              )}
              {meta?.rating != null && (
                <span className="flex items-center gap-1 font-mono text-[11px] text-white/70" title={meta.ratingVotes != null ? `${meta.ratingVotes.toLocaleString()} ratings` : undefined}>
                  <Star className="size-3 text-accent-amber" fill="currentColor" strokeWidth={0} />
                  {meta.rating.toFixed(1)}
                  {meta.ratingSource && <span className="text-white/65">{meta.ratingSource}</span>}
                </span>
              )}
            </div>
            {movieFile ? (
              <span className="flex items-center gap-1 rounded-full bg-signal/10 px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-wider text-signal border border-signal/20">
                <Check className="size-3" strokeWidth={3} />
                Available{movieFile.size != null ? ` · ${formatMovieBytes(movieFile.size)}` : ""}
              </span>
            ) : (
              <span className="rounded-full bg-accent-amber/10 px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-wider text-accent-amber border border-accent-amber/20">
                Missing — not downloaded
              </span>
            )}
          </div>

          {/* Quick facts line */}
          {meta && (meta.runtime || meta.firstAirDate || (meta.languages?.length ?? 0) > 0) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 -mt-1 font-mono text-[11px] text-white/65">
              {meta.runtime != null && <span>{formatDuration(meta.runtime * 60)}</span>}
              {meta.firstAirDate && <span>{meta.firstAirDate}</span>}
              {(meta.languages?.length ?? 0) > 0 && <span>{meta.languages!.join(" / ")}</span>}
              {(meta.studios?.length ?? 0) > 0 && <span className="truncate max-w-[24rem]">{meta.studios!.slice(0, 2).join(", ")}</span>}
            </div>
          )}

          {meta?.overview && (
            <p className="text-sm text-white/70 leading-relaxed max-w-3xl line-clamp-4">{meta.overview}</p>
          )}

          {(meta?.genres?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {meta!.genres!.map(g => (
                <span key={g} className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-muted-foreground">{g}</span>
              ))}
            </div>
          )}

          {/* Divider + two-column spec area */}
          {movieFile && (
            <>
              <div className="h-px bg-white/[0.06]" />
              <div className="grid gap-x-10 gap-y-5 sm:grid-cols-2">
                {/* Media: what the file actually contains */}
                <div className="flex flex-col gap-2">
                  <SectionLabel>Media</SectionLabel>
                  <MediaBadges media={media} />
                  <dl className="mt-0.5 flex flex-col gap-1.5 border-t border-white/5 pt-3">
                    <SpecRow label="Resolution" value={resolution} />
                    <SpecRow label="Video" value={videoLabel} />
                    <SpecRow label="HDR" value={hdrLabel} />
                    <SpecRow label="Audio" value={audioLabel} />
                    <SpecRow label="Audio languages" value={audioLangs} />
                    <SpecRow label="Container" value={media?.container?.toUpperCase() ?? ""} />
                    <SpecRow label="Bitrate" value={media?.bitrateKbps ? formatBitrate(media.bitrateKbps) : ""} />
                    <SpecRow label="Runtime" value={media?.durationSeconds ? formatDuration(media.durationSeconds) : ""} />
                    {releaseTags.length > 0 && (
                      <SpecRow label="Flags" value={releaseTags.join(" · ")} />
                    )}
                  </dl>
                </div>

                {/* File: where it lives and how it got here */}
                <div className="flex flex-col gap-2">
                  <SectionLabel>File</SectionLabel>
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[12px] text-white/80" title={movieFile.originalName ?? movieFile.name ?? undefined}>
                      {movieFile.name ?? movieFile.originalName ?? movieFile.path.split(/[\\/]/).pop()}
                    </div>
                    <div className="mt-0.5 break-all font-mono text-[11px] leading-relaxed text-white/65">{movieFile.path}</div>
                  </div>
                  <dl className="mt-0.5 flex flex-col gap-1.5 border-t border-white/5 pt-3">
                    <SpecRow label="Size" value={movieFile.size != null ? formatMovieBytes(movieFile.size) : ""} />
                    <SpecRow label="Source" value={movieFile.sourceKind === "release" ? "Grabbed" : "Imported"} />
                    {movieFile.releaseTitle && <SpecRow label="Release" value={movieFile.releaseTitle} />}
                    <SpecRow label="Indexer" value={movieFile.indexerName ?? ""} />
                    <SpecRow label="Imported" value={formatImportDate(movieFile.importedAt)} />
                  </dl>
                </div>
              </div>
            </>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={onBrowse}
              className={pillButton}
            >
              <SearchIcon className="size-3.5" /> Browse releases
            </button>
            <button
              type="button"
              onClick={onAutoGrab}
              disabled={grabbing}
              className={pillButtonPrimary}
            >
              {grabbing ? <Loader2Icon className="size-3.5 animate-spin" /> : <DownloadIcon className="size-3.5" />}
              {movieFile ? "Upgrade" : "Auto-grab"}
            </button>
            {(meta?.links?.length ?? 0) > 0 && (
              <div className="ml-auto flex items-center gap-1">
                {meta!.links!.map(l => (
                  <a
                    key={l.url}
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className={`flex items-center gap-1 rounded-full px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-white/65 hover:text-white/90 hover:bg-white/[0.06] transition-colors ${focusRing}`}
                  >
                    <ExternalLink className="size-3" /> {l.label}
                  </a>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </GlassPanel>
  );
}
