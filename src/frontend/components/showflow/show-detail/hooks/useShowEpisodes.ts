import * as React from "react";

import type { EpisodeData } from "@frontend/components/showflow/EpisodeRow";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";

import { orderSeasons } from "../format";
import type { EpisodeFilter, FlashStatus, GrabTarget, SeasonSection, SeasonStat, SeasonWithEpisodes } from "../types";

function hasAired(ep: EpisodeData, now: number): boolean {
  if (!ep.airDate) return false;
  const t = Date.parse(ep.airDate);
  return !Number.isNaN(t) && t <= now;
}

/**
 * Seasons + episodes for one show, plus every episode/season mutation
 * (monitor toggles, search mode, auto-grabs). One unified list, latest season
 * first (specials last), episodes newest-first within a season.
 */
export function useShowEpisodes(show: ShowSummary, flashStatus: FlashStatus) {
  const [seasons, setSeasons] = React.useState<SeasonStat[] | null>(null);
  const [episodesBySeason, setEpisodesBySeason] = React.useState<Record<number, EpisodeData[]>>({});
  const [collapsed, setCollapsed] = React.useState<Record<number, boolean>>({});
  const [loadingEpisodes, setLoadingEpisodes] = React.useState(false);
  const [filter, setFilter] = React.useState<EpisodeFilter>("all");
  const [grabTarget, setGrabTarget] = React.useState<GrabTarget>(null);

  async function loadAllEpisodes() {
    setLoadingEpisodes(true);
    try {
      const r = await fetch(`/api/shows/${show.id}/episodes`);
      const data: { seasons: SeasonWithEpisodes[] } = await r.json();
      const list = Array.isArray(data.seasons) ? data.seasons : [];
      const ordered = orderSeasons(list);
      setSeasons(ordered.map(({ episodes: _e, ...stats }) => stats));
      setCollapsed((prev) => {
        // Preserve the user's collapse choices across refreshes; new
        // seasons default to collapsed unless they're the latest.
        const next: Record<number, boolean> = {};
        ordered.forEach((s, i) => { next[s.seasonNumber] = prev[s.seasonNumber] ?? i !== 0; });
        return next;
      });
      const buckets: Record<number, EpisodeData[]> = {};
      // Episodes within a season run newest-first (finale on top), matching
      // the seasons' latest-first order.
      for (const s of ordered) {
        buckets[s.seasonNumber] = [...(s.episodes ?? [])].sort((a, b) => b.episode - a.episode);
      }
      setEpisodesBySeason(buckets);
    } catch {
      // Keep previous state on failure; the list simply doesn't refresh.
    } finally {
      setLoadingEpisodes(false);
    }
  }

  React.useEffect(() => {
    setSeasons(null);
    setEpisodesBySeason({});
    setCollapsed({});
    // Films have no episode rows — the movie panel owns its own fetches.
    if ((show.seriesType ?? "standard") !== "movie") loadAllEpisodes();
  }, [show.id]);

  const orderedSeasons = React.useMemo(() => (seasons ? orderSeasons(seasons) : []), [seasons]);
  const episodesLoaded = Object.keys(episodesBySeason).length > 0;

  // Per-season filtered episodes for the unified list. While a file-state
  // filter is active every section is force-expanded so matches are never
  // hidden inside a collapsed season.
  const forceExpand = filter !== "all";
  const sections: SeasonSection[] = React.useMemo(() => {
    const hasFile = (ep: EpisodeData) => !!ep.filePath;
    return orderedSeasons.map((s) => {
      const all = episodesBySeason[s.seasonNumber] ?? [];
      const eps = filter === "all" ? all : all.filter((ep) => (filter === "available" ? hasFile(ep) : !hasFile(ep)));
      return { season: s, all, episodes: eps };
    });
  }, [orderedSeasons, episodesBySeason, filter]);

  const overallAvailable = sections.reduce((a, s) => a + s.all.filter((e) => !!e.filePath).length, 0);
  const overallTotal = sections.reduce((a, s) => a + s.all.length, 0);

  // Monitored, aired, not on disk, and not set to interactive-only search.
  const missingEpisodes = React.useMemo(() => {
    const now = Date.now();
    return sections.flatMap((s) => s.all.filter((e) => e.tracked && !e.filePath && hasAired(e, now) && e.searchMode !== "interactive"));
  }, [sections]);

  function toggleCollapsed(season: number) {
    setCollapsed((prev) => ({ ...prev, [season]: !prev[season] }));
  }

  function updateEpisodeBucket(season: number, fn: (eps: EpisodeData[]) => EpisodeData[]) {
    setEpisodesBySeason((prev) => {
      const cur = prev[season];
      if (!cur) return prev;
      return { ...prev, [season]: fn(cur) };
    });
  }

  async function toggleTracked(episode: EpisodeData, tracked: boolean) {
    updateEpisodeBucket(episode.season, (eps) => eps.map((e) => (e.episode === episode.episode ? { ...e, tracked } : e)));
    try {
      const res = await fetch(
        `/api/shows/${show.id}/seasons/${episode.season}/episodes/${episode.episode}/tracked`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tracked }) },
      );
      if (!res.ok) throw new Error("Failed to update");
    } catch {
      updateEpisodeBucket(episode.season, (eps) => eps.map((e) => (e.episode === episode.episode ? { ...e, tracked: !tracked } : e)));
    }
  }

  async function changeSearchMode(episode: EpisodeData, mode: "auto" | "interactive") {
    updateEpisodeBucket(episode.season, (eps) => eps.map((e) => (e.episode === episode.episode ? { ...e, searchMode: mode } : e)));
    try {
      const res = await fetch(
        `/api/shows/${show.id}/seasons/${episode.season}/episodes/${episode.episode}/search`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) },
      );
      if (!res.ok) throw new Error("Failed to update");
    } catch {
      updateEpisodeBucket(episode.season, (eps) => eps.map((e) => (e.episode === episode.episode ? { ...e, searchMode: episode.searchMode === "auto" ? "interactive" : "auto" } : e)));
    }
  }

  async function toggleSeasonTracked(season: number, tracked: boolean) {
    updateEpisodeBucket(season, (eps) => eps.map((e) => ({ ...e, tracked })));
    try {
      const res = await fetch(`/api/shows/${show.id}/seasons/${season}/tracked`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracked }),
      });
      if (!res.ok) throw new Error("Failed to update");
    } catch {
      loadAllEpisodes();
    }
  }

  async function autoGrabEpisode(episode: EpisodeData) {
    setGrabTarget(`ep:${episode.season}:${episode.episode}`);
    try {
      const res = await fetch(`/api/shows/${show.id}/seasons/${episode.season}/episodes/${episode.episode}/grab`, { method: "POST" });
      const data = await res.json();
      flashStatus(data.message ?? (data.success ? "Grabbed." : "Grab failed."), !!data.success);
      if (data.success) loadAllEpisodes();
    } catch (err: any) {
      flashStatus(err.message ?? "Grab failed.", false);
    } finally {
      setGrabTarget(null);
    }
  }

  async function autoGrabSeason(season: number) {
    setGrabTarget(`season:${season}`);
    try {
      const res = await fetch(`/api/shows/${show.id}/seasons/${season}/grab`, { method: "POST" });
      const data = await res.json();
      flashStatus(data.message ?? (data.success ? "Grabbed." : "Grab failed."), !!data.success);
      if (data.success) loadAllEpisodes();
    } catch (err: any) {
      flashStatus(err.message ?? "Grab failed.", false);
    } finally {
      setGrabTarget(null);
    }
  }

  /**
   * "Search missing": reuses the existing season + episode grab endpoints.
   * A season whose aired episodes are all missing gets one pack grab;
   * otherwise each missing episode is grabbed individually, in sequence.
   */
  async function searchMissing() {
    if (missingEpisodes.length === 0) {
      flashStatus("Nothing missing — every monitored, aired episode is on disk.");
      return;
    }
    setGrabTarget("missing");
    const now = Date.now();
    const jobs: { label: string; url: string }[] = [];
    for (const s of sections) {
      const n = s.season.seasonNumber;
      const missing = missingEpisodes.filter((e) => e.season === n);
      if (missing.length === 0) continue;
      const aired = s.all.filter((e) => hasAired(e, now));
      if (missing.length > 1 && missing.length === aired.length) {
        jobs.push({ label: `S${n} pack`, url: `/api/shows/${show.id}/seasons/${n}/grab` });
      } else {
        for (const e of missing) {
          jobs.push({ label: `S${e.season}E${e.episode}`, url: `/api/shows/${show.id}/seasons/${e.season}/episodes/${e.episode}/grab` });
        }
      }
    }
    let grabbed = 0;
    let failed = 0;
    try {
      for (const [i, job] of jobs.entries()) {
        flashStatus(`Searching ${job.label} (${i + 1}/${jobs.length})…`);
        try {
          const res = await fetch(job.url, { method: "POST" });
          const data = await res.json();
          if (data.success) grabbed++; else failed++;
        } catch {
          failed++;
        }
      }
      flashStatus(
        `Search missing: ${grabbed} grabbed${failed > 0 ? `, ${failed} with no match` : ""}.`,
        grabbed > 0 || failed === 0,
      );
      if (grabbed > 0) loadAllEpisodes();
    } finally {
      setGrabTarget(null);
    }
  }

  return {
    seasons,
    sections,
    collapsed,
    toggleCollapsed,
    forceExpand,
    loadingEpisodes,
    episodesLoaded,
    filter,
    setFilter,
    overallAvailable,
    overallTotal,
    missingEpisodes,
    grabTarget,
    setGrabTarget,
    loadAllEpisodes,
    toggleTracked,
    changeSearchMode,
    toggleSeasonTracked,
    autoGrabEpisode,
    autoGrabSeason,
    searchMissing,
  };
}

export type ShowEpisodes = ReturnType<typeof useShowEpisodes>;
