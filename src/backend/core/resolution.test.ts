import { test, expect } from 'bun:test';
import { resolutionFromDimensions } from './resolution';
import { syntheticNameFromProbe, mergeProbeWithRelease, qualityEngine } from './quality_engine';

test('letterboxed scope encodes keep their real resolution', () => {
  expect(resolutionFromDimensions(1600, 3840)).toBe(2160);
  expect(resolutionFromDimensions(1608, 3840)).toBe(2160);
  expect(resolutionFromDimensions(2160, 3840)).toBe(2160);
  expect(resolutionFromDimensions(800, 1920)).toBe(1080);
  expect(resolutionFromDimensions(1080, 1920)).toBe(1080);
  expect(resolutionFromDimensions(1080, 1440)).toBe(1080);
  expect(resolutionFromDimensions(534, 1280)).toBe(720);
  expect(resolutionFromDimensions(720, 1280)).toBe(720);
  expect(resolutionFromDimensions(576, 720)).toBe(576);
  expect(resolutionFromDimensions(480, 640)).toBe(480);
  expect(resolutionFromDimensions(4320, 7680)).toBe(4320);
  expect(resolutionFromDimensions(null, null)).toBe(null);
});

const scope4k = {
  video: { codec: 'hevc', width: 3840, height: 1600, fps: 24, codedWidth: 3840, codedHeight: 1600, bitrate: null, averageBitrate: null, hdr: true },
  audio: [{ codec: 'eac3', channels: 6, sampleRate: null, bitrate: null, averageBitrate: null, language: null, name: null }],
  overallBitrate: 26_000_000,
  fileSize: 9.2 * 1024 ** 3,
} as any;

test('a 3840x1600 4K WEB-DL probes as 2160p, not Remux-1080p', () => {
  const name = syntheticNameFromProbe(scope4k);
  expect(name).toContain('2160p');
  expect(name).not.toContain('1080p');
  // ~26 Mbps is normal for a 4K WEB-DL, not a remux.
  expect(name).not.toContain('Remux');
});

test('probe + release title agree on 2160p, so the title supplies the source', () => {
  const profileId = 'standard';
  const probed = qualityEngine.getReleaseScoreFromMedia(scope4k, profileId);
  const release = qualityEngine.getReleaseScore('Dexter.Resurrection.S02E01.2160p.ATVP.WEB-DL.DV.HDR10+.DDP5.1.Atmos.H265.MP4-BTM', profileId);
  expect(probed.resolution).toBe(2160);
  const merged = mergeProbeWithRelease(probed, release);
  expect(merged.source).toBe(release.source);
});
