import { Input, ALL_FORMATS, FilePathSource } from 'mediabunny';
import type { EpisodeFileRow } from '../db/episode_files';

/** The subset of MediaProbeInfo the upgrade/duplicate comparisons use. */
export type ProbeMediaForComparison = Pick<MediaProbeInfo, 'video' | 'audio' | 'overallBitrate' | 'fileSize'>;

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
      ? [{ codec: row.audio_codec, channels: row.audio_channels, sampleRate: null, bitrate: null, averageBitrate: null }]
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
  }[];
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
    if (durationSeconds == null) {
      durationSeconds = await input.computeDuration();
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
      const [codec, channels, sampleRate, peakB, avgB] = await Promise.all([
        track.getCodec(),
        track.getNumberOfChannels().catch(() => undefined),
        track.getSampleRate().catch(() => undefined),
        track.getBitrate().catch(() => undefined),
        track.getAverageBitrate().catch(() => undefined),
      ]);
      audio.push({
        codec,
        channels: channels ?? null,
        sampleRate: sampleRate ?? null,
        bitrate: peakB ?? null,
        averageBitrate: avgB ?? null,
      });
    }

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