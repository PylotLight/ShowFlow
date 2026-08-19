import path from "node:path";
import fs from "node:fs";
import { eq, and, sql } from "drizzle-orm";
import type { DatabaseManager } from "../db";
import * as schema from "../db/schema";
import { Oracle } from "../parser/oracle";
import type { NamingConfig } from "./episode_naming";

/**
 * Merge `sourceId` into `targetId`. The target show is kept; the source
 * show's episodes/files/providers/titles/artworks/mappings are folded into
 * it, files are physically moved under the target's root folder, and the
 * source show row (plus its leftover rows) is deleted.
 *
 * Conflicts: when both shows already track the same (season, episode), the
 * row that has a file wins; if both have files the target's file wins.
 */
export async function mergeShows(db: DatabaseManager, targetId: string, sourceId: string) {
  const target = db.getShow(targetId);
  const source = db.getShow(sourceId);
  if (!target || !source) throw new Error("Both shows must exist");

  const sourceEpisodes = db.listAllEpisodes(sourceId) as any[];
  const targetEpisodes = db.listAllEpisodes(targetId) as any[];
  const targetKeySet = new Set(targetEpisodes.map(e => `${e.season_number}:${e.episode_number}`));

  const sourceFiles = db.listEpisodeFilesByShow(sourceId) as any[];
  const targetFiles = db.listEpisodeFilesByShow(targetId) as any[];
  const targetFileKeySet = new Set(targetFiles.map(f => `${f.season_number}:${f.episode_number}`));

  const oracle = new Oracle();
  const seriesType = (target as any).series_type ?? "standard";
  const targetLike = { title: target.title, metadata: { seriesType } } as any;
  const config = await import("../routes/_shared").then(m => m.loadConfig());
  const namingConfig = {
    ...(config as Record<string, unknown> & Partial<NamingConfig>),
    seriesType,
  };
  const targetRoot = db.getShowRootFolder(targetId);

  const movedFiles: { from: string; to: string }[] = [];
  const adoptedEpisodes: { season: number; episode: number }[] = [];

  const targetFileMap = new Map(targetFiles.map(f => [`${f.season_number}:${f.episode_number}`, f]));

  // 1. Episodes: re-point source episodes whose (season, episode) is free.
  for (const ep of sourceEpisodes) {
    if (targetKeySet.has(`${ep.season_number}:${ep.episode_number}`)) continue;
    db.drizz.update(schema.episodes)
      .set({ show_id: targetId })
      .where(and(
        eq(schema.episodes.show_id, sourceId),
        eq(schema.episodes.season_number, ep.season_number),
        eq(schema.episodes.episode_number, ep.episode_number),
      )).run();
    targetKeySet.add(`${ep.season_number}:${ep.episode_number}`);
    adoptedEpisodes.push({ season: ep.season_number, episode: ep.episode_number });
  }

  // 2. Episode files: re-point source file rows; on collision keep the better
  //    quality as current.
  for (const file of sourceFiles) {
    const key = `${file.season_number}:${file.episode_number}`;
    const existingTarget = targetFileMap.get(key);
    if (existingTarget) {
      // Both have a file for this episode. Compare "quality" loosely:
      // prefer the row that has been probed with a higher resolution.
      const probe = (f: any) => f.video_height || 0;
      const sourceBetter = probe(file) > probe(existingTarget);
      if (sourceBetter && file.is_current === 1 && existingTarget.is_current === 1) {
        db.drizz.update(schema.episodeFiles)
          .set({ is_current: 0 })
          .where(eq(schema.episodeFiles.id, existingTarget.id)).run();
        db.drizz.update(schema.episodeFiles)
          .set({ show_id: targetId })
          .where(eq(schema.episodeFiles.id, file.id)).run();
        targetFileMap.set(key, file);
      } else {
        db.drizz.update(schema.episodeFiles)
          .set({ show_id: targetId, is_current: file.is_current === 1 ? 0 : file.is_current })
          .where(eq(schema.episodeFiles.id, file.id)).run();
      }
    } else {
      db.drizz.update(schema.episodeFiles)
        .set({ show_id: targetId })
        .where(eq(schema.episodeFiles.id, file.id)).run();
      targetFileMap.set(key, file);
      targetFileKeySet.add(key);
    }
  }

  // 3. Physically move files under the target's root folder.
  const allSourceFiles = db.listEpisodeFilesByShow(sourceId) as any[];
  for (const file of allSourceFiles) {
    if (!file.file_path) continue;
    if (!fs.existsSync(file.file_path)) continue;
    if (path.dirname(file.file_path) === path.dirname(targetRoot ?? "")) continue;
    const season = file.season_number;
    const episode = file.episode_number;
    const rel = oracle.buildProposedPath(
      targetLike,
      [{ season, episode, absoluteNumber: undefined, title: undefined, airDate: undefined }],
      file.original_name ?? file.file_path,
      namingConfig,
    );
    const targetPath = targetRoot ? path.join(targetRoot, rel) : path.join(path.dirname(file.file_path), path.basename(rel));
    if (path.resolve(targetPath) === path.resolve(file.file_path)) continue;
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await fs.promises.rename(file.file_path, targetPath);
    } catch (err: any) {
      if (err.code === "EXDEV") {
        await fs.promises.copyFile(file.file_path, targetPath);
        await fs.promises.unlink(file.file_path);
      } else {
        throw err;
      }
    }
    db.updateEpisodeFilePath(targetId, season, episode, targetPath);
    db.updateEpisodeFileRowPath(file.id, targetPath);
    movedFiles.push({ from: file.file_path, to: targetPath });
  }

  // 4. Re-point providers. Unique (provider_type, provider_id) means the two
  //    shows can't already share a provider - re-point directly. If the target
  //    already has the same provider_type with a *different* id (possible when
  //    the duplicate was added via another provider), merge instead.
  const targetProviders = db.drizz.select({ pt: schema.showProviders.provider_type }).from(schema.showProviders)
    .where(eq(schema.showProviders.show_id, targetId)).all() as { pt: string }[];
  const targetProviderTypes = new Set(targetProviders.map(p => p.pt));
  const sourceProviders = db.drizz.select().from(schema.showProviders)
    .where(eq(schema.showProviders.show_id, sourceId)).all() as any[];

  for (const p of sourceProviders) {
    if (targetProviderTypes.has(p.provider_type)) {
      // Keep the target's provider for this type; drop the source's.
      db.drizz.delete(schema.showProviders)
        .where(and(
          eq(schema.showProviders.show_id, sourceId),
          eq(schema.showProviders.provider_type, p.provider_type),
        )).run();
    } else {
      db.drizz.update(schema.showProviders)
        .set({ show_id: targetId, is_primary: 1 })
        .where(and(
          eq(schema.showProviders.show_id, sourceId),
          eq(schema.showProviders.provider_type, p.provider_type),
        )).run();
      targetProviderTypes.add(p.provider_type);
    }
  }

  // 5. Re-point titles, skipping combos the target already has.
  const targetTitles = db.drizz.select({
    norm: schema.showTitles.normalized_title,
    type: schema.showTitles.title_type,
    provider: schema.showTitles.provider_type,
  }).from(schema.showTitles)
    .where(eq(schema.showTitles.show_id, targetId)).all() as { norm: string; type: string; provider: string | null }[];
  const targetTitleKeySet = new Set(targetTitles.map(t => `${t.norm}|${t.type}|${t.provider ?? ""}`));
  const sourceTitles = db.drizz.select().from(schema.showTitles)
    .where(eq(schema.showTitles.show_id, sourceId)).all() as any[];

  for (const t of sourceTitles) {
    const key = `${t.normalized_title}|${t.title_type}|${t.provider_type ?? ""}`;
    if (targetTitleKeySet.has(key)) {
      db.drizz.delete(schema.showTitles).where(eq(schema.showTitles.id, t.id)).run();
    } else {
      db.drizz.update(schema.showTitles)
        .set({ show_id: targetId })
        .where(eq(schema.showTitles.id, t.id)).run();
      targetTitleKeySet.add(key);
    }
  }

  // 6. Re-point artworks, skipping (provider_type, artwork_type) the target has.
  const targetArtworkRows = db.drizz.select({
    pt: schema.showArtworks.provider_type,
    type: schema.showArtworks.artwork_type,
  }).from(schema.showArtworks)
    .where(eq(schema.showArtworks.show_id, targetId)).all() as { pt: string; type: string }[];
  const targetArtworkKeys = new Set(targetArtworkRows.map(a => `${a.pt}|${a.type}`));
  const sourceArtworks = db.drizz.select().from(schema.showArtworks)
    .where(eq(schema.showArtworks.show_id, sourceId)).all() as any[];

  for (const a of sourceArtworks) {
    const key = `${a.provider_type}|${a.artwork_type}`;
    if (targetArtworkKeys.has(key)) {
      db.drizz.delete(schema.showArtworks).where(eq(schema.showArtworks.id, a.id)).run();
    } else {
      db.drizz.update(schema.showArtworks)
        .set({ show_id: targetId })
        .where(eq(schema.showArtworks.id, a.id)).run();
      targetArtworkKeys.add(key);
    }
  }

  // 7. Re-point grabbed releases (no FK, no uniqueness to worry about).
  db.drizz.update(schema.grabbedReleases)
    .set({ show_id: targetId })
    .where(eq(schema.grabbedReleases.show_id, sourceId)).run();

  // 8. Re-point episode mappings.
  db.drizz.update(schema.episodeMappings)
    .set({ show_id: targetId })
    .where(eq(schema.episodeMappings.show_id, sourceId)).run();

  // 9. Episode-mapping config: keep the target's; drop the source's.
  db.drizz.delete(schema.episodeMappingConfig)
    .where(eq(schema.episodeMappingConfig.show_id, sourceId)).run();

  // 10. Seasons: re-point seasons the target lacks.
  const targetSeasonRows = db.drizz.select({ s: schema.seasons.season_number }).from(schema.seasons)
    .where(eq(schema.seasons.show_id, targetId)).all() as { s: number }[];
  const targetSeasons = new Set(targetSeasonRows.map(r => r.s));
  const sourceSeasons = db.drizz.select({ s: schema.seasons.season_number }).from(schema.seasons)
    .where(eq(schema.seasons.show_id, sourceId)).all() as { s: number }[];
  for (const s of sourceSeasons) {
    if (targetSeasons.has(s.s)) {
      db.drizz.delete(schema.seasons).where(and(
        eq(schema.seasons.show_id, sourceId),
        eq(schema.seasons.season_number, s.s),
      )).run();
    } else {
      db.drizz.update(schema.seasons)
        .set({ show_id: targetId })
        .where(and(
          eq(schema.seasons.show_id, sourceId),
          eq(schema.seasons.season_number, s.s),
        )).run();
      targetSeasons.add(s.s);
    }
  }

  // 11. Re-point pipeline events (history) to the target.
  db.drizz.update(schema.pipelineEvents)
    .set({ show_id: targetId })
    .where(eq(schema.pipelineEvents.show_id, sourceId)).run();

  // 12. Delete the source show (cascades any remaining child rows).
  db.removeShow(sourceId);

  db.logEvent({
    type: "merge",
    entityType: "show",
    entityId: targetId,
    message: `Merged "${source.title}" into "${target.title}" (${adoptedEpisodes.length} episodes adopted, ${movedFiles.length} files moved)`,
  });

  return {
    targetId,
    sourceId,
    adoptedEpisodes,
    movedFiles,
  };
}