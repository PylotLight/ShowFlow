import { Input, ALL_FORMATS, FilePathSource, LogLevel, Logging } from 'mediabunny';
import type { EpisodeFileRow, FileMediaColumns } from '../db/episode_files';
import { extractReleaseMeta } from './release_meta';

/**
 * Mediabunny defaults to Info-level console output, printing per-track
 * warnings (e.g. "Track #3 has an unsupported content encoding; dropping.")
 * on every probe of an odd file and spamming pod logs. Errors-only: real
 * failures still surface, demuxer chatter doesn't.
 */
Logging.level = LogLevel.Errors;

/**
 * Full-file duration scans above this size are skipped: computeDuration()
 * reads the whole file on the single Bun thread, stalling the server for
 * minutes on multi-GB oddities (readiness probe trips, UI hangs). Such
 * files get a null duration instead of a hang; healthy files expose
 * duration in metadata and never reach the fallback.
 */
const COMPUTE_DURATION_SIZE_CAP = 8 * 1024 * 1024 * 1024;

/** The subset of MediaProbeInfo the upgrade/duplicate comparisons use. */
export type ProbeMediaForComparison = Pick<MediaProbeInfo, 'video' | 'audio' | 'overallBitrate' | 'fileSize'>;

/**
 * Fold a probe result + the release filename into the flat episode_files media
 * columns (see db/episode_files.ts FileMediaColumns). This is the single place
 * that merges what the file *is* (probe) with what the release name *claims*
 * (HDR format, Atmos, bit depth, source grade …) so the scanner, the blackhole
 * importer and the manual-import path all persist identical media detail.
 */
export function foldProbeToColumns(
  probe: MediaProbeInfo | null,
  releaseName: string | null | undefined,
): FileMediaColumns | null {
  if (!probe) return null;
  const meta = extractReleaseMeta(releaseName);
  // A probe-detected transfer function is the file's truth; the name can only
  // add the finer HDR format. When the name claims none but the file is HDR,
  // fall back to a plain 'HDR10' label so the badge still reads "HDR".
  const hdrFormat = probe.video?.hdr
    ? meta.hdrFormat ?? 'HDR10'
    : meta.hdrFormat;
  return {
    container: probe.container,
    video_width: probe.video?.width ?? null,
    video_height: probe.video?.height ?? null,
    video_codec: probe.video?.codec?.toLowerCase() ?? null,
    video_fps: probe.video?.fps ? Math.round(probe.video.fps) : null,
    hdr: probe.video?.hdr ? 1 : null,
    hdr_format: hdrFormat,
    audio_codec: probe.audio?.[0]?.codec?.toLowerCase() ?? null,
    audio_channels: probe.audio?.[0]?.channels ?? null,
    audio_tracks: probe.audio?.length
      ? JSON.stringify(probe.audio.map(a => ({
        codec: a.codec ?? null,
        channels: a.channels ?? null,
        language: a.language ?? null,
        name: a.name ?? null,
      })))
      : null,
    audio_languages: probe.audioLanguages?.length
      ? JSON.stringify(probe.audioLanguages)
      : null,
    duration_seconds: probe.durationSeconds ? Math.round(probe.durationSeconds) : null,
    bitrate_kbps: probe.overallBitrate ? Math.round(probe.overallBitrate / 1000) : null,
    // Always emit a (possibly empty) tag array: a null release_tags column then
    // unambiguously means "never extracted", so the metadata backfill query
    // doesn't loop over every plain-titled file forever.
    release_tags: JSON.stringify(meta.tags),
  };
}

/**
 * Rebuild a probe-comparable shape from an episode_files row's stored media
 * columns (no disk access). Lets callers score a previously-probed file for
 * upgrade/duplicate decisions without re-reading the file.
 */
export function mediaFromStoredRow(row: EpisodeFileRow): ProbeMediaForComparison | null {
  if (!row.container && row.video_width == null && row.video_height == null) return null;
  return {
    video: {
      codec: row.video_codec,
      width: row.video_width,
      height: row.video_height,
      fps: row.video_fps ?? null,
      codedWidth: row.video_width,
      codedHeight: row.video_height,
      bitrate: null,
      averageBitrate: null,
      hdr: !!row.hdr,
    },
    audio: row.audio_codec
      ? [{ codec: row.audio_codec, channels: row.audio_channels, sampleRate: null, bitrate: null, averageBitrate: null, language: null, name: null }]
      : [],
    overallBitrate: row.bitrate_kbps ? row.bitrate_kbps * 1000 : null,
    fileSize: row.file_size,
  };
}

/**
 * Structured media info for a stored video file, extracted with mediabunny
 * (a pure-TS demuxer - no ffprobe/ffmpeg binary needed, which matters since
 * the production image is distroless). This is what powers the resolution /
 * bitrate / codec badges on stored episodes and the media-aware upgrade
 * decisions.
 */
export interface MediaProbeInfo {
  /** Container format, e.g. 'Matroska' (MKV/WebM) or ISOBMFF-style (mp4/mov). */
  container: string | null;
  /** File size in bytes on disk. */
  fileSize: number | null;
  /** Duration in seconds ('duration' is reserved-ish for method names). */
  durationSeconds: number | null;
  /**
   * Overall average bitrate in bits/sec, computed as fileSize*8/duration
   * when the container doesn't carry its own bitrate (MKV usually doesn't).
   * This is the best single proxy for "how big/heavy is this encode".
   */
  overallBitrate: number | null;
  /** Primary (first) video track info, if any. */
  video: {
    codec: string | null;
    /** Display width in px after aspect-ratio/rotation adjustment. */
    width: number | null;
    /** Display height in px after aspect-ratio/rotation adjustment. */
    height: number | null;
    /** Coded (storage) width - pre-rotation. */
    codedWidth: number | null;
    /** Coded (storage) height - pre-rotation. */
    codedHeight: number | null;
    /** Best-guess frames per second. */
    fps: number | null;
    /** HDR / high dynamic range flag from color metadata. */
    hdr: boolean;
    /** Peak bitrate in bits/sec from container metadata, if present. */
    bitrate: number | null;
    /** Average bitrate in bits/sec from container metadata, if present. */
    averageBitrate: number | null;
  } | null;
  /** Audio tracks (usually 1). */
  audio: {
    codec: string | null;
    channels: number | null;
    sampleRate: number | null;
    bitrate: number | null;
    averageBitrate: number | null;
    /** ISO 639-2/T language code, e.g. 'eng' / 'jpn'; 'und' when unknown. */
    language?: string | null;
    /** Human-readable track name/title from the container, if any. */
    name?: string | null;
  }[];
  /**
   * Distinct real languages across all audio tracks (excludes 'und'). When >1
   * the file is multi-language — the container's own ground truth for a
   * filename's MULTI/DUAL tag.
   */
  audioLanguages: string[];
}

/**
 * Probe a media file on disk. Returns null when the file isn't a readable
 * media file or the probe fails - never throws. Optionally caps how far off
 * the metadata-sized window mediabunny is allowed to stray, keeping memory
 * bounded for multi-GB files (defaults are fine for video files).
 */
export async function probeMediaFile(filePath: string): Promise<MediaProbeInfo | null> {
  let input: Input | null = null;
  try {
    let fileSize: number | null = null;
    try {
      const f = Bun.file(filePath);
      fileSize = f.size;
    } catch {}
    input = new Input({
      source: new FilePathSource(filePath),
      formats: ALL_FORMATS,
    });
    const format = await input.getFormat();
    let durationSeconds: number | null = null;
    durationSeconds = await input.getDurationFromMetadata();
    if (durationSeconds == null && (fileSize == null || fileSize <= COMPUTE_DURATION_SIZE_CAP)) {
      try {
        durationSeconds = await input.computeDuration();
      } catch {
        durationSeconds = null;
      }
    }

    const tracks = await input.getTracks();
    const videoTracks: any[] = [];
    const audioTracks: any[] = [];
    for (const track of tracks) {
      if (track.isVideoTrack()) videoTracks.push(track);
      else if (track.isAudioTrack()) audioTracks.push(track);
    }

    const videoTrack = videoTracks[0];
    let video: MediaProbeInfo['video'] = null;
    if (videoTrack) {
      let width: number | null = null;
      let height: number | null = null;
      let codedWidth: number | null = null;
      let codedHeight: number | null = null;
      let fps: number | null = null;
      let hdr = false;
      let bitrate: number | null = null;
      let averageBitrate: number | null = null;
      const codec = await videoTrack.getCodec();

      const [dWidth, dHeight, codeWidth, codeHeight, rot, hdrResult, peakB, avgB] = await Promise.all([
        videoTrack.getDisplayWidth().catch(() => undefined),
        videoTrack.getDisplayHeight().catch(() => undefined),
        videoTrack.getCodedWidth().catch(() => undefined),
        videoTrack.getCodedHeight().catch(() => undefined),
        videoTrack.getRotation().catch(() => undefined),
        videoTrack.hasHighDynamicRange().catch(() => undefined),
        videoTrack.getBitrate().catch(() => undefined),
        videoTrack.getAverageBitrate().catch(() => undefined),
      ]);
      width = dWidth ?? null;
      height = dHeight ?? null;
      codedWidth = codeWidth ?? null;
      codedHeight = codeHeight ?? null;
      hdr = hdrResult ?? false;
      bitrate = peakB ?? null;
      averageBitrate = avgB ?? null;
      try {
        const metrics = await videoTrack.computeFrameRateMetrics();
        fps = metrics.bestGuessFrameRate ? parseFloat(metrics.bestGuessFrameRate) : null;
      } catch {
        fps = null;
      }
      void rot;
      video = { codec, width, height, codedWidth, codedHeight, fps, hdr, bitrate, averageBitrate };
    }

    const audio: MediaProbeInfo['audio'] = [];
    for (const track of audioTracks) {
      const [codec, channels, sampleRate, peakB, avgB, language, name] = await Promise.all([
        track.getCodec(),
        track.getNumberOfChannels().catch(() => undefined),
        track.getSampleRate().catch(() => undefined),
        track.getBitrate().catch(() => undefined),
        track.getAverageBitrate().catch(() => undefined),
        track.getLanguageCode().catch(() => undefined),
        track.getName().catch(() => undefined),
      ]);
      audio.push({
        codec,
        channels: channels ?? null,
        sampleRate: sampleRate ?? null,
        bitrate: peakB ?? null,
        averageBitrate: avgB ?? null,
        language: language && language !== 'und' ? language : null,
        name: name ?? null,
      });
    }

    const audioLanguages = [...new Set(
      audio.map(a => a.language).filter((l): l is string => !!l),
    )];

    const overallBitrate =
      fileSize != null && durationSeconds != null && durationSeconds > 0
        ? (fileSize * 8) / durationSeconds
        : null;

    return {
      container: format?.name ?? null,
      fileSize,
      durationSeconds,
      overallBitrate,
      video,
      audio,
      audioLanguages,
    };
  } catch (err) {
    return null;
  } finally {
    try {
      await input?.dispose();
    } catch {
      // ignore
    }
  }
}