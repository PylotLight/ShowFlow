/** Air time / expected-release helpers shared across showflow surfaces. */

export function formatAirtime(airDate: string | null | undefined): string {
  if (!airDate || !airDate.includes("T")) return "";
  const d = new Date(airDate);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Compact local time, e.g. "9:45 PM" - used for the dashboard clock chip. */
export function formatTime12(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
}

/**
 * Resolve the "expected release" timestamp for an episode. The air window
 * forecast lives in expectedReleaseAt; when absent but a time is derivable
 * from a plain air_date, we still format what we can. Returns null when
 * there is genuinely no date at all.
 */
export function expectedReleaseTime(
  expectedReleaseAt: string | null | undefined,
  airDate: string | null | undefined,
): string | null {
  const best = expectedReleaseAt || airDate;
  return formatTime12(best);
}

/** Signed shorthand like "+45m" / "~1h" for a delay in minutes. */
export function formatDelayMinutes(minutes: number | null | undefined): string | null {
  if (minutes == null) return null;
  if (minutes < 60) return `+${Math.round(minutes)}m`;
  const h = Math.round(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `~${h}h` : `~${h}h ${m}m`;
}

/** Human-friendly file size, e.g. "2.1 GB". */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const fixed = n >= 10 || i === 0 ? Math.round(n) : Number(n.toFixed(2));
  const str = Number.isInteger(fixed) ? String(fixed) : fixed.toFixed(1);
  return `${str} ${units[i]}`;
}

/** Short relative date label for import/publish timestamps. */
export function formatImportDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Human resolution label from a probed display height (e.g. 2160 -> "2160p",
 *  1080 -> "1080p", 960 -> "1080p" for the cropped variant). */
export function formatResolution(height: number | null | undefined, width?: number | null): string {
  if (!height) return "";
  const px = width != null ? width * height : null;
  if (px != null && px >= 7680 * 4320 * 0.9) return "8K";
  if ((px != null && px >= 3840 * 2160 * 0.8) || height >= 2000) return "2160p";
  if ((px != null && px >= 1920 * 1080 * 0.8) || height >= 1000) return "1080p";
  if (height >= 700) return "720p";
  if (height >= 400) return "480p";
  return `${height}p`;
}

/** Bitrate formatting for the media badges: "18.7 Mbps", "1.8 Mbps". */
export function formatBitrate(kbps: number | null | undefined): string {
  if (kbps == null || kbps <= 0) return "";
  const mbps = kbps / 1000;
  return `${Number.isInteger(mbps) ? mbps : mbps.toFixed(1)} Mbps`;
}

/** Duration formatting: "46m" / "1h 10m". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return "";
  const mins = Math.round(seconds / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}