/**
 * Resolution bucket (2160 / 1080 / ...) from a probed frame size.
 *
 * Width matters as much as height: scope/cinemascope releases are
 * letterboxed, so a real 4K episode is 3840x1600 (or 3840x1608) and a
 * 1080p one 1920x800. Bucketing by height (or by pixel count) alone called
 * those 1080p and 720p, which then disagreed with the release name's
 * 2160p/1080p and fell back to a probe-only "Remux-1080p" score.
 * Thresholds follow Sonarr's: width >= 3200 is 2160p, >= 1800 is 1080p,
 * >= 1200 is 720p; height keeps covering 4:3 and anamorphic encodes.
 */
export function resolutionFromDimensions(height: number | null | undefined, width?: number | null): number | null {
  const h = height ?? 0;
  const w = width ?? 0;
  if (!h && !w) return null;
  const px = w && h ? w * h : 0;
  if (px >= 7680 * 4320 * 0.9 || w >= 7000 || h >= 4000) return 4320;
  if (px >= 3840 * 2160 * 0.8 || w >= 3200 || h >= 2000) return 2160;
  if (px >= 1920 * 1080 * 0.8 || w >= 1800 || h >= 1000) return 1080;
  if (w >= 1200 || h >= 700) return 720;
  if (h >= 540) return 576;
  return 480;
}
