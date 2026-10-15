import type { SonarrQualityProfile } from './client';
import { parseResolution, parseSource } from '../../core/release_quality';
import { SOURCE_ORDER, type ReleaseSource } from '../../core/quality_terms';
import type { ProfileModelInput } from '../../db/quality_model';

/**
 * Map a Sonarr quality profile onto the streamlined model: allowed qualities
 * -> min/target resolution (+ skip sources Sonarr never allowed), cutoff ->
 * upgrade until, upgradeAllowed -> upgrades on/off. Sonarr's custom formats
 * aren't part of its quality profile payload, so terms start empty.
 *
 * Series import itself maps each Sonarr series onto a ShowFlow profile id
 * (providers/sonarr/import.ts); ids are unchanged by the model switch.
 */
export function sonarrProfileToModel(p: SonarrQualityProfile, id: string): ProfileModelInput {
  const allowed = p.items.filter(i => i.allowed).map(i => i.quality.name);
  const res = allowed.map(n => parseResolution(n) ?? (/(sdtv|dvd)/i.test(n) ? 480 : null)).filter((r): r is number => r != null);
  const sources = new Set(allowed.map(n => parseSource(n)).filter(Boolean) as ReleaseSource[]);
  const anyBare = allowed.some(n => parseSource(n) == null);
  const cutoffName = p.items.find(i => i.quality.id === p.cutoff)?.quality.name ?? null;
  const cutoffSource = cutoffName ? parseSource(cutoffName) : null;
  return {
    id,
    name: p.name,
    minResolution: res.length ? Math.min(...res) : null,
    targetResolution: res.length ? Math.max(...res) : null,
    allowUnknownResolution: false,
    skipSources: anyBare || sources.size === 0 ? [] : SOURCE_ORDER.filter(s => !sources.has(s)),
    upgradesEnabled: !!p.upgradeAllowed && !!cutoffName,
    upgradeUntilResolution: cutoffName ? parseResolution(cutoffName) ?? (cutoffSource ? 480 : null) : null,
    upgradeUntilSource: cutoffSource,
    terms: [],
  };
}
