import { test, expect } from "bun:test";
import { foldProbeToColumns, type MediaProbeInfo } from "./media_probe";

function probe(over: Partial<MediaProbeInfo> = {}): MediaProbeInfo {
  return {
    container: "Matroska",
    fileSize: 1000,
    durationSeconds: 100,
    overallBitrate: 80,
    video: {
      codec: "hevc", width: 3840, height: 2160, codedWidth: 3840, codedHeight: 2160,
      fps: 59.94, hdr: false, bitrate: null, averageBitrate: null,
    },
    audio: [{ codec: "truehd", channels: 8, sampleRate: 48000, bitrate: null, averageBitrate: null, language: "eng", name: null }],
    audioLanguages: ["eng"],
    ...over,
  };
}

test("file wins on resolution/codec; name supplies the HDR format the probe can't", () => {
  const cols = foldProbeToColumns(
    probe({ video: { ...probe().video!, hdr: true } }),
    "Thor.2011.2160p.DV.HDR10Plus.TrueHD.7.1.Atmos.mkv",
  )!;
  expect(cols.video_width).toBe(3840);
  expect(cols.video_codec).toBe("hevc");
  expect(cols.video_fps).toBe(60);
  expect(cols.hdr_format).toBe("Dolby Vision");
  expect(JSON.parse(cols.audio_tracks!)[0].language).toBe("eng");
  expect(JSON.parse(cols.release_tags!)).toContain("Atmos");
});

test("HDR file with no format in the name is labelled plain HDR10", () => {
  const cols = foldProbeToColumns(
    probe({ video: { ...probe().video!, hdr: true } }),
    "Movie.2020.1080p.x265.mkv",
  )!;
  expect(cols.hdr_format).toBe("HDR10");
});

test("SDR file keeps any HDR format the name advertises", () => {
  const cols = foldProbeToColumns(probe(), "Movie.2020.2160p.Dolby.Vision.x265.mkv")!;
  expect(cols.hdr).toBeNull();
  expect(cols.hdr_format).toBe("Dolby Vision");
});

test("empty tags serialise to [] so 'never extracted' stays distinguishable", () => {
  const cols = foldProbeToColumns(probe(), "Movie.2020.1080p.x265.mkv")!;
  expect(cols.release_tags).toBe("[]");
});

test("null probe yields null columns", () => {
  expect(foldProbeToColumns(null, "anything.mkv")).toBeNull();
});
