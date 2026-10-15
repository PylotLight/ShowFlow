import { test, expect, describe } from 'bun:test';
import { parseResolution, parseSource, matchTier, topTierAtResolution, type TierDef } from './release_quality';
import manifest from '../db/seed/manifest.json';

const TIERS: TierDef[] = manifest.qualities;

function tierOf(name: string): string | null {
  return matchTier(name, TIERS).tier?.name ?? null;
}

describe('parseResolution', () => {
  test('p/i tags, WxH, 4K/UHD/8K', () => {
    expect(parseResolution('Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-NTb')).toBe(1080);
    expect(parseResolution('[SubsPlease] Frieren - 01 (1080p) [ABCD1234].mkv')).toBe(1080);
    expect(parseResolution('Show.S01E01.720p.HDTV.x264')).toBe(720);
    expect(parseResolution('Show.S01E01.576p.WEB')).toBe(576);
    expect(parseResolution('Show 1080i HDTV')).toBe(1080);
    expect(parseResolution('Show.S01E01.1920x1080.x264')).toBe(1080);
    expect(parseResolution('Show S01E01 4K HDR')).toBe(2160);
    expect(parseResolution('Show.S01E01.UHD.BluRay.x265')).toBe(2160);
    expect(parseResolution('Show.S01E01.8K.WEB')).toBe(4320);
  });
  test('no false hits on codecs, hashes or years', () => {
    expect(parseResolution('Show.S01E01.x265-GRP')).toBe(null);
    expect(parseResolution('[Group] Show - 01 [AB1080CD].mkv')).toBe(null);
    expect(parseResolution('Show.2016.S01E01')).toBe(null);
    expect(parseResolution(null)).toBe(null);
  });
});

describe('parseSource', () => {
  test('real release spellings', () => {
    expect(parseSource('Show.S01E01.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-FraMeSToR')).toBe('remux');
    expect(parseSource('Show.S01E01.2160p.BDRemux.HEVC')).toBe('remux');
    expect(parseSource('Show.S01E01.1080p.BluRay.x264-GRP')).toBe('bluray');
    expect(parseSource('Show.S01E01.1080p.Blu-ray.x264')).toBe('bluray');
    expect(parseSource('[Group] Show - 01 [BD 1080p HEVC FLAC]')).toBe('bluray');
    expect(parseSource('Show.S01E01.1080p.BDRip.x265')).toBe('bluray');
    expect(parseSource('Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-NTb')).toBe('webdl');
    expect(parseSource('Show.S01E01.1080p.WEBDL.H.264')).toBe('webdl');
    expect(parseSource('Show.S01E01.1080p.WEB.h264-GRP')).toBe('webdl');
    expect(parseSource('Show.S01E01.1080p.WEBRip.x264-GRP')).toBe('webrip');
    expect(parseSource('Show.S01E01.1080p.WEB-Rip.x264')).toBe('webrip');
    expect(parseSource('Show.S01E01.720p.HDTV.x264-KILLERS')).toBe('hdtv');
    expect(parseSource('Show.S01E01.DVDRip.XviD')).toBe('dvd');
    expect(parseSource('Show.S01E01.PDTV.XviD')).toBe('sdtv');
  });
  test('a title word "web" does not beat an explicit source', () => {
    expect(parseSource('Charlottes.Web.S01E01.720p.HDTV.x264')).toBe('hdtv');
  });
  test('anime with no source tag', () => {
    expect(parseSource('[SubsPlease] Frieren - 01 (1080p) [ABCD1234].mkv')).toBe(null);
    expect(parseSource('Show.S01E01.DTS-HD.MA')).toBe(null);
  });
});

describe('matchTier against the seeded tiers', () => {
  test('resolution + source combine into the real tier', () => {
    expect(tierOf('Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-NTb')).toBe('WEBDL-1080p');
    expect(tierOf('Show.S01E01.1080p.WEBRip.x264-GRP')).toBe('WEBRip-1080p');
    expect(tierOf('Show.S01E01.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-FraMeSToR')).toBe('Remux-1080p');
    expect(tierOf('Show.S01E01.1080p.BluRay.x264-GRP')).toBe('Bluray-1080p');
    expect(tierOf('Show.S01E01.720p.HDTV.x264-KILLERS')).toBe('HDTV-720p');
    expect(tierOf('Show.S01E01.2160p.WEB-DL.DV.HDR.H.265-FLUX')).toBe('WEBDL-2160p');
    expect(tierOf('Show.S01E01.2160p.UHD.BluRay.REMUX.HDR.HEVC.TrueHD.Atmos')).toBe('Remux-2160p');
  });
  test('4K/UHD names land on 2160p tiers', () => {
    expect(tierOf('Show S01E01 4K HDR')).toBe('2160p');
    expect(tierOf('Show S01E01 4K WEB-DL HDR')).toBe('WEBDL-2160p');
  });
  test('fallbacks: no source -> bare resolution, missing tier -> next source, no res -> source-only', () => {
    expect(tierOf('[SubsPlease] Frieren - 01 (1080p) [ABCD1234].mkv')).toBe('1080p');
    expect(tierOf('Show.S01E01.720p.BluRay.REMUX')).toBe('Bluray-720p');
    expect(tierOf('Show.S01E01.480p.HDTV')).toBe('480p');
    expect(tierOf('Show.S01E01.576p.WEB-DL')).toBe('WEBDL-480p');
    expect(tierOf('Show.S01E01.DVDRip.XviD')).toBe('DVD');
    expect(tierOf('Show.S01E01.HDTV.XviD')).toBe('SDTV');
    expect(tierOf('Show.S01E01.x264')).toBe(null);
  });
  test('ranking now follows the tier order: Remux > BluRay > WEB-DL > WEBRip > HDTV', () => {
    const rank = (n: string) => matchTier(n, TIERS).tier?.rank ?? 0;
    const remux = rank('Show.S01E01.1080p.BluRay.REMUX.AVC');
    const bluray = rank('Show.S01E01.1080p.BluRay.x264');
    const webdl = rank('Show.S01E01.1080p.WEB-DL.H.264');
    const webrip = rank('Show.S01E01.1080p.WEBRip.x264');
    const hdtv = rank('Show.S01E01.1080p.HDTV.x264');
    expect(remux).toBeGreaterThan(bluray);
    expect(bluray).toBeGreaterThan(webdl);
    expect(webdl).toBeGreaterThan(webrip);
    expect(webrip).toBeGreaterThan(hdtv);
    expect(rank('Show.S01E01.720p.BluRay.REMUX')).toBeLessThan(rank('Show.S01E01.1080p.HDTV'));
  });
  test('user-added tier names still match literally', () => {
    const tiers = [...TIERS, { id: 'q_custom', name: 'Raw-HD', rank: 25 }];
    expect(matchTier('Show.S01E01.Raw-HD.ts', tiers).tier?.name).toBe('Raw-HD');
  });
  test('topTierAtResolution', () => {
    expect(topTierAtResolution(1080, TIERS)?.name).toBe('Remux-1080p');
    expect(topTierAtResolution(null, TIERS)).toBe(null);
  });
});
