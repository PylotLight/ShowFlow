import type { FileMedia } from "@frontend/components/showflow/EpisodeRow";
import {
  formatResolution,
  formatBitrate,
  formatDuration,
} from "@frontend/lib/airtime";

/** ISO 639-2/T → short display code. Keeps the common ones readable; unknown
 *  3-letter codes pass through upper-cased so nothing is silently dropped. */
function langLabel(code: string): string {
  const map: Record<string, string> = {
    eng: "EN", jpn: "JA", zho: "ZH", chi: "ZH", fra: "FR", fre: "FR",
    spa: "ES", ger: "DE", deu: "DE", ita: "IT", rus: "RU", por: "PT",
    kor: "KO", hin: "HI", ara: "AR", dut: "NL", nld: "NL", pol: "PL",
    swe: "SV", dan: "DA", nor: "NO", nob: "NO", fin: "FI", tur: "TR",
    ces: "CS", cze: "CS", hun: "HU", ell: "EL", gre: "EL", heb: "HE",
    tha: "TH", vie: "VI", ind: "ID", ukr: "UK", rum: "RO", ron: "RO",
  };
  return map[code.toLowerCase()] ?? code.toUpperCase();
}

/** Compact media badges (resolution, codec, HDR format, audio, bitrate…)
 *  rendered from a file's probed media + filename-derived release tags. Shared
 *  across the episode rows (show detail) and the agenda/dashboard/calendar
 *  surfaces so "what quality do I actually have" is visible without opening the
 *  release popover. */
export function MediaBadges({ media, className, max }: { media?: FileMedia | null; className?: string; max?: number }) {
  const badges: { label: string; key: string; tone?: 'accent' }[] = [];

  const res = media?.videoWidth != null || media?.videoHeight != null
    ? formatResolution(media.videoHeight, media.videoWidth)
    : "";
  if (res) badges.push({ label: res, key: 'res' });
  if (media?.videoCodec) badges.push({ label: media.videoCodec.toUpperCase(), key: 'codec' });

  // HDR: the release name's specific format when known (Dolby Vision, HDR10+…),
  // else a plain HDR flag from the probe. HLG rides along as a tag below.
  const tags = media?.releaseTags ?? [];
  const hdrTone: 'accent' | undefined = media?.hdrFormat === "Dolby Vision" || media?.hdrFormat === "HDR10+" ? 'accent' : undefined;
  if (media?.hdrFormat) badges.push({ label: media.hdrFormat, key: 'hdr', tone: hdrTone });
  else if (media?.hdr) badges.push({ label: "HDR", key: 'hdr' });

  if (media?.videoFps && Math.round(media.videoFps) > 24) badges.push({ label: `${Math.round(media.videoFps)}fps`, key: 'fps' });

  if (media?.audioCodec) badges.push({ label: media.audioCodec.toUpperCase(), key: 'audio' });
  if (media?.audioChannels) badges.push({ label: channelsLabel(media.audioChannels), key: 'ch' });
  // Atmos is object-audio metadata the probe can't read — surface it from the
  // release tags when present.
  if (tags.includes('Atmos') && !badges.some(b => b.key === 'atmos')) badges.push({ label: "Atmos", key: 'atmos', tone: 'accent' });

  // Real multi-language, confirmed by the file itself (not just the name).
  const langs = media?.audioLanguages ?? [];
  if (langs.length > 1) badges.push({ label: langs.map(langLabel).join('/'), key: 'lang' });

  if (media?.container) badges.push({ label: media.container, key: 'container' });
  if (media?.bitrateKbps) badges.push({ label: formatBitrate(media.bitrateKbps), key: 'br' });
  if (media?.durationSeconds) badges.push({ label: formatDuration(media.durationSeconds), key: 'dur' });

  // Remaining filename-derived tags the badges don't already cover.
  const seen = new Set(badges.map(b => b.label));
  for (const tag of tags) {
    if (tag === 'Atmos' || seen.has(tag)) continue;
    badges.push({ label: tag, key: `tag:${tag}`, tone: tag === 'HLG' ? 'accent' : undefined });
    seen.add(tag);
  }

  if (badges.length === 0) return null;

  const shown = max != null ? badges.slice(0, max) : badges;

  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${className ?? ""}`} aria-label="Media info">
      {shown.map((b) => (
        <span
          key={b.key}
          className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
            b.tone === 'accent'
              ? "bg-accent-amber/15 text-accent-amber border border-accent-amber/20"
              : "bg-white/[0.06] text-white/70"
          }`}
        >
          {b.label}
        </span>
      ))}
    </span>
  );
}

/** 8 channels → "7.1"; 6 → "5.1"; a bare count otherwise. */
function channelsLabel(ch: number): string {
  const map: Record<number, string> = { 2: "2.0", 6: "5.1", 8: "7.1", 4: "4.0", 5: "5.0", 3: "3.0" };
  return map[ch] ?? `${ch}ch`;
}
