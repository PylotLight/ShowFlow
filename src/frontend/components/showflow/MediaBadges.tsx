import type { FileMedia } from "@frontend/components/showflow/EpisodeRow";
import {
  formatResolution,
  formatBitrate,
  formatDuration,
} from "@frontend/lib/airtime";

/** Compact media badges (resolution, codec, HDR, audio...) rendered from a
 *  file's probed media info. Shared across the episode rows (show detail) and
 *  the agenda/dashboard/calendar surfaces so "what quality do I actually have"
 *  is visible without opening the release popover. */
export function MediaBadges({ media, className, max }: { media?: FileMedia | null; className?: string; max?: number }) {
  const badges: { label: string; key: string }[] = [];

  const res = media?.videoWidth != null || media?.videoHeight != null
    ? formatResolution(media.videoHeight, media.videoWidth)
    : "";
  if (res) badges.push({ label: res, key: 'res' });
  if (media?.videoCodec) badges.push({ label: media.videoCodec.toUpperCase(), key: 'codec' });
  if (media?.hdr) badges.push({ label: "HDR", key: 'hdr' });
  if (media?.audioCodec) badges.push({ label: media.audioCodec.toUpperCase(), key: 'audio' });
  if (media?.audioChannels) badges.push({ label: `${media.audioChannels}ch`, key: 'ch' });
  if (media?.container) badges.push({ label: media.container, key: 'container' });
  if (media?.bitrateKbps) badges.push({ label: formatBitrate(media.bitrateKbps), key: 'br' });
  if (media?.durationSeconds) badges.push({ label: formatDuration(media.durationSeconds), key: 'dur' });

  if (badges.length === 0) return null;

  const shown = max != null ? badges.slice(0, max) : badges;

  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${className ?? ""}`} aria-label="Media info">
      {shown.map((b) => (
        <span
          key={b.key}
          className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-white/70"
        >
          {b.label}
        </span>
      ))}
    </span>
  );
}