import Fuse from 'fuse.js';

import { FilenameParser, type ParsedFilename } from './index';
import { ProviderFactory, type ProviderType } from '../providers/factory';
import { db } from '../db';
import type {
  Episode,
  EpisodeQuery,
  IMetadataProvider,
  Show,
} from '../core/types';
import { debugLog } from '../core/debug';

type ShowTitleType =
  | 'canonical'
  | 'original'
  | 'romanized'
  | 'translation'
  | 'alias'
  | 'provider'
  | 'user';

interface LocalShowRow {
  showId: string;
  showTitle: string;
  showOriginalTitle: string | null;
  showYear: number | null;
  showSeriesType: string | null;

  providerType: string;
  providerId: string;
  providerTitle: string | null;
  providerOriginalTitle: string | null;
  providerMetadataJson: string | null;
  isPrimary: number | null;

  knownTitle?: string | null;
  knownTitleType?: string | null;
  knownTitleLanguage?: string | null;

  matchedTitle?: string | null;
  matchedTitleType?: string | null;
  matchedTitleLanguage?: string | null;
}

interface LocalShowCandidate {
  localShowId: string;
  show: Show;
  providerType: ProviderType;
  providerId: string;
  titles: string[];
  isPrimary: boolean;
  score?: number;
}

interface ProviderShow extends Show {
  aliases?: string[];
  alternateTitles?: string[];
  translations?: Record<string, string>;
  metadata?: Record<string, unknown>;
}


const PROVIDER_TYPES: ProviderType[] = ['tmdb', 'tvdb', 'anilist'];

function isProviderType(value: string): value is ProviderType {
  return PROVIDER_TYPES.includes(value as ProviderType);
}

function normalizeTitle(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[._]+/g, ' ')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function uniqueTitles(titles: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();

  return titles.filter((title): title is string => {
    if (!title?.trim()) return false;

    const normalized = normalizeTitle(title);

    if (!normalized || seen.has(normalized)) {
      return false;
    }

    seen.add(normalized);
    return true;
  });
}

export class Oracle {
  private readonly parser = new FilenameParser();

    private lastParsed: ParsedFilename | null = null;
  private lastSearchResults: Show[] = [];
  private lastProviderAttempts: Array<{
    provider: ProviderType;
    strategies: string[];
    candidateCount: number;
    candidates: { id: string; title: string }[];
    matchedTitle: string | null;
    episodeErrors: string[];
  }> = [];

  async resolve(
    filename: string,
    preferredProvider: ProviderType = 'tmdb',
    config: Record<string, unknown> = {},
  ): Promise<{
    show: Show;
    episodes: Episode[];
    proposedPath: string;
    parsed?: unknown;
  } | null> {
    const parsed = this.parser.parse(filename);

    this.lastParsed = parsed;
    this.lastSearchResults = [];

    if (!parsed?.show) {
      debugLog('Filename parsing failed or did not include a show title', {
        filename,
        parsed,
      });
      return null;
    }

    parsed.show = this.cleanParsedTitle(parsed.show);

    debugLog('Filename parsed', {
      filename,
      parsed,
    });

    const localCandidate = this.findLocalShow(parsed.show);

    if (localCandidate) {
      debugLog('Resolved show from local database before provider lookup', {
        parsedTitle: parsed.show,
        localShowId: localCandidate.localShowId,
        title: localCandidate.show.title,
        providerType: localCandidate.providerType,
        providerId: localCandidate.providerId,
        score: localCandidate.score,
      });

      const provider = ProviderFactory.getProvider(
        localCandidate.providerType,
        config,
      );

      const { episodes, errors: episodeErrors } = await this.resolveEpisodes(
        provider,
        localCandidate.providerId,
        parsed,
        localCandidate.show,
      );

      if (episodes.length === 0) {
        debugLog('Local show matched, but no episode could be resolved', {
          parsedTitle: parsed.show,
          show: localCandidate.show.title,
          episodeErrors,
          providerType: localCandidate.providerType,
          providerId: localCandidate.providerId,
          parsed,
        });
        return null;
      }

      const proposedPath = this.buildPath(
        localCandidate.show,
        episodes,
        filename,
        config as Record<string, unknown>,
      );

      return {
        show: localCandidate.show,
        episodes,
        proposedPath,
        parsed,
      };
    }

    const provider = ProviderFactory.getProvider(preferredProvider, config);
    const strategies = this.buildSearchStrategies(parsed.show);

    let searchResults: Show[] = [];
    let resolvedProvider = provider;
    let resolvedProviderType = preferredProvider;

    if (!provider.isConfigured()) {
      debugLog('Skipping provider search: provider is not configured (missing API key)', {
        provider: preferredProvider,
      });
    } else {
      searchResults = await this.searchProvider(provider, strategies);
    }

    this.lastSearchResults = searchResults;
    this.lastProviderAttempts = [];

    let matchedShow = this.matchProviderShow(parsed.show, searchResults);

    this.lastProviderAttempts.push({
      provider: preferredProvider,
      strategies,
      candidateCount: searchResults.length,
      candidates: searchResults.slice(0, 5).map(s => ({
        id: s.id,
        title: s.title,
      })),
      matchedTitle: matchedShow?.title ?? null,
      episodeErrors: [],
    });


    // The preferred provider (usually TVDB/TMDB) frequently has poor or no
    // coverage for anime, non-English, or niche titles. Rather than giving
    // up immediately, fall back through the remaining provider types before
    // reporting failure - this is what actually fixes most "could not
    // resolve metadata" cases for fansub-style releases.
    if (!matchedShow) {
      const remainingProviders = PROVIDER_TYPES.filter(p => p !== preferredProvider);

      for (const fallbackType of remainingProviders) {
        const fallbackProvider = ProviderFactory.getProvider(fallbackType, config);
        if (!fallbackProvider.isConfigured()) {
          debugLog('Skipping fallback provider: not configured (missing API key)', {
            provider: fallbackType,
          });
          continue;
        }
        const fallbackResults = await this.searchProvider(fallbackProvider, strategies);

        this.lastProviderAttempts.push({
          provider: fallbackType,
          strategies,
          candidateCount: fallbackResults.length,
          candidates: fallbackResults.slice(0, 5).map(s => ({
            id: s.id,
            title: s.title,
          })),
          matchedTitle: null,
          episodeErrors: [],
        });


        const fallbackMatch = this.matchProviderShow(parsed.show, fallbackResults);
        this.lastProviderAttempts[
          this.lastProviderAttempts.length - 1
        ]!.matchedTitle = fallbackMatch?.title ?? null;

        if (fallbackMatch) {
          matchedShow = fallbackMatch;
          resolvedProvider = fallbackProvider;
          resolvedProviderType = fallbackType;
          this.lastSearchResults = fallbackResults;

          debugLog('Resolved show via fallback provider after preferred provider found no match', {
            parsedTitle: parsed.show,
            preferredProvider,
            fallbackProvider: fallbackType,
            title: fallbackMatch.title,
          });
          break;
        }
      }
    }

    if (!matchedShow) {
      debugLog('No confident provider show match across any provider', {
        parsedTitle: parsed.show,
        attempts: this.lastProviderAttempts,
      });
      return null;
    }

    // Persist all resolved aliases/alt-titles back into the local DB so that
    // future files for the same series hit the fast exact lookup instead of
    // re-querying providers. No extra API calls; only re-uses what we already fetched.
    try {
      const existingLocal = db.getShowByProvider(resolvedProviderType, matchedShow.id);
      if (existingLocal?.id) {
        db.syncAllShowTitles(existingLocal.id, existingLocal.provider_type, {
          title: matchedShow.title,
          originalTitle: matchedShow.originalTitle,
          romanizedTitle: (matchedShow as { romanizedTitle?: string }).romanizedTitle,
          aliases: matchedShow.aliases,
          alternateTitles: matchedShow.alternateTitles,
          translations: matchedShow.translations,
          metadata: (matchedShow.metadata as Record<string, unknown>) ?? {},
        });
      }
    } catch (err) {
      debugLog('Failed to persist resolved show titles (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    debugLog('Resolved show from external provider', {
      parsedTitle: parsed.show,
      providerType: resolvedProviderType,
      providerId: matchedShow.id,
      title: matchedShow.title,
      titles: this.getProviderTitles(matchedShow),
    });

    const { episodes, errors: episodeErrors } = await this.resolveEpisodes(
      resolvedProvider,
      matchedShow.id,
      parsed,
      matchedShow,
    );

    const resolvedAttempt = this.lastProviderAttempts.find(
      attempt => attempt.provider === resolvedProviderType,
    );

    if (resolvedAttempt) {
      resolvedAttempt.episodeErrors = episodeErrors;
    }

    if (episodes.length === 0) {
      debugLog('Provider show matched, but no episode could be resolved', {
        parsedTitle: parsed.show,
        show: matchedShow.title,
        providerType: resolvedProviderType,
        providerId: matchedShow.id,
        parsed,
        episodeErrors,
      });
      return null;
    }

    const proposedPath = this.buildPath(
      matchedShow,
      episodes,
      filename,
      config as Record<string, unknown>,
    );

    return {
      show: matchedShow,
      episodes,
      proposedPath,
      parsed,
    };
  }

  /**
   * Exact local-title match is indexed and always attempted first.
   * Fuzzy local matching is a fallback only; it refuses close alternatives.
   */
  private findLocalShow(parsedTitle: string): LocalShowCandidate | null {
    const normalized = normalizeTitle(parsedTitle);

    const exactRows = db.findShowsByNormalizedTitle(
      normalized,
    ) as LocalShowRow[];

    const exactCandidates = this.groupLocalRows(exactRows);

    const exact = this.selectPreferredLocalCandidate(
      exactCandidates,
      normalized,
      true,
    );

    if (exact) {
      return exact;
    }

    const fuzzyRows = db.getLocalShowCandidates() as LocalShowRow[];
    const fuzzyCandidates = this.groupLocalRows(fuzzyRows);

    if (fuzzyCandidates.length === 0) {
      return null;
    }

    const fuse = new Fuse(fuzzyCandidates, {
      keys: ['titles'],
      includeScore: true,
      threshold: 0.32,
      ignoreLocation: true,
      minMatchCharLength: 3,
    });

    const matches = fuse.search(normalized);
    const best = matches[0];
    const second = matches[1];

    if (!best || best.score == null || best.score > 0.32) {
      return null;
    }

    if (
      second?.score != null &&
      Math.abs(second.score - best.score) < 0.04
    ) {
      debugLog('Ambiguous local fuzzy match; provider search will be used', {
        parsedTitle,
        first: {
          title: best.item.show.title,
          score: best.score,
        },
        second: {
          title: second.item.show.title,
          score: second.score,
        },
      });
      return null;
    }

    return {
      ...best.item,
      score: best.score,
    };
  }

  private groupLocalRows(rows: LocalShowRow[]): LocalShowCandidate[] {
    const candidates = new Map<string, LocalShowCandidate>();

    for (const row of rows) {
      if (!isProviderType(row.providerType)) {
        debugLog('Skipping local show with unsupported provider type', {
          showId: row.showId,
          providerType: row.providerType,
        });
        continue;
      }

      const key = `${row.showId}:${row.providerType}`;

      const candidate = candidates.get(key) ?? {
        localShowId: row.showId,
        providerType: row.providerType,
        providerId: row.providerId,
        show: {
          id: row.providerId,
          title: row.showTitle,
          originalTitle: row.showOriginalTitle ?? undefined,
          year: row.showYear ?? undefined,
          provider: row.providerType,
          metadata: this.safeJsonObject(row.providerMetadataJson),
        },
        isPrimary: row.isPrimary === 1,
        titles: [],
      };

      candidate.titles.push(
        ...uniqueTitles([
          row.showTitle,
          row.showOriginalTitle,
          row.providerTitle,
          row.providerOriginalTitle,
          row.knownTitle,
          row.matchedTitle,
          ...this.extractTitlesFromMetadata(row.providerMetadataJson),
        ]),
      );


      candidate.titles = uniqueTitles(candidate.titles);

      candidates.set(key, candidate);
    }

    return [...candidates.values()];
  }

  private selectPreferredLocalCandidate(
    candidates: LocalShowCandidate[],
    normalizedQuery: string,
    requireExact: boolean,
  ): LocalShowCandidate | null {
    const matching = candidates.filter(candidate => {
      return candidate.titles.some(title => {
        const isExact = normalizeTitle(title) === normalizedQuery;
        return requireExact ? isExact : true;
      });
    });

    if (matching.length === 0) {
      return null;
    }

    const sorted = [...matching].sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) {
        return a.isPrimary ? -1 : 1;
      }

      return a.show.title.localeCompare(b.show.title);
    });

    if (sorted.length > 1) {
      debugLog('Multiple exact local title matches found', {
        normalizedQuery,
        matches: sorted.map(candidate => ({
          localShowId: candidate.localShowId,
          title: candidate.show.title,
          providerType: candidate.providerType,
          providerId: candidate.providerId,
        })),
      });
    }

    return sorted[0] ?? null;
  }

  private async searchProvider(
    provider: IMetadataProvider,
    strategies: string[],
  ): Promise<Show[]> {
    const resultsById = new Map<string, Show>();

    for (const strategy of strategies) {
      try {
        const results = await provider.searchShow(strategy);

        debugLog('Provider search completed', {
          strategy,
          resultCount: results.length,
        });

        for (const show of results) {
          resultsById.set(show.id, show);
        }
      } catch (error) {
        debugLog('Provider search failed', {
          strategy,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return [...resultsById.values()];
  }

  private matchProviderShow(
    parsedTitle: string,
    results: Show[],
  ): Show | null {
    const normalizedQuery = normalizeTitle(parsedTitle);

    // Get list of all local/library show provider keys (e.g., tvdb:1234, tmdb:5678)
    const localShows = db.listShows() as Array<{ id: string; provider_type: string }>;
    const localProviderKeys = new Set(
      localShows.flatMap(s => {
        const providers = db.listShowProviders(s.id);
        return providers.map((p: any) => `${p.provider_type}:${p.provider_id}`);
      })
    );

    const exact = results.find(show =>
      this.getProviderTitles(show).some(
        title => normalizeTitle(title) === normalizedQuery,
      ),
    );

    if (exact) {
      return exact;
    }

    const candidates = results.map(show => ({
      show,
      titles: this.getProviderTitles(show).map(normalizeTitle),
      isLibrary: localProviderKeys.has(`${show.provider}:${show.id}`),
    }));

    const fuse = new Fuse(candidates, {
      keys: ['titles'],
      includeScore: true,
      threshold: 0.35,
      ignoreLocation: true,
      minMatchCharLength: 3,
    });

    const matches = fuse.search(normalizedQuery);
    if (matches.length === 0) return null;

    // Apply a score boost (bonus) for library shows (lower score is better in Fuse)
    const scoredMatches = matches.map(m => {
      const isLib = m.item.isLibrary;
      const rawScore = m.score ?? 1.0;
      // Boost library shows by subtracting 0.15 from their Fuse score
      const adjustedScore = isLib ? Math.max(0, rawScore - 0.15) : rawScore;
      return {
        ...m,
        adjustedScore,
      };
    });

    scoredMatches.sort((a, b) => a.adjustedScore - b.adjustedScore);

    const best = scoredMatches[0];
    const second = scoredMatches[1];

    if (!best || best.adjustedScore > 0.28) {
      return null;
    }

    if (
      second != null &&
      Math.abs(second.adjustedScore - best.adjustedScore) < 0.04
    ) {
      debugLog('Ambiguous provider result; refusing automatic selection', {
        parsedTitle,
        first: {
          title: best.item.show.title,
          score: best.adjustedScore,
          isLibrary: best.item.isLibrary,
        },
        second: {
          title: second.item.show.title,
          score: second.adjustedScore,
          isLibrary: second.item.isLibrary,
        },
      });

      return null;
    }

    return best.item.show;
  }

  private getProviderTitles(show: Show): string[] {
    const providerShow = show as ProviderShow;
    const translations = Object.values(providerShow.translations ?? {});

    return uniqueTitles([
      show.title,
      show.originalTitle,
      show.romanizedTitle,
      ...(providerShow.aliases ?? []),
      ...(providerShow.alternateTitles ?? []),
      ...translations,
      ...this.extractTitlesFromObject(show.metadata),
    ]);
  }

  /**
   * Metadata varies by provider. This reads likely title arrays/fields without
   * making Oracle depend on TVDB-specific response types.
   */
  private extractTitlesFromMetadata(metadataJson: string | null): string[] {
    return this.extractTitlesFromObject(this.safeJsonObject(metadataJson));
  }

  private extractTitlesFromObject(
    metadata: Record<string, unknown> | undefined,
  ): string[] {
    if (!metadata) {
      return [];
    }

    const values: string[] = [];

    const collect = (value: unknown): void => {
      if (typeof value === 'string' && value.trim()) {
        values.push(value);
        return;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') {
            collect(item);
          } else if (item && typeof item === 'object') {
            const record = item as Record<string, unknown>;
            collect(record.name);
            collect(record.title);
            collect(record.value);
          }
        }
      }

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const nestedValue of Object.values(value)) {
          if (typeof nestedValue === 'string') {
            collect(nestedValue);
          }
        }
      }
    };

    collect(metadata.aliases);
    collect(metadata.alias);
    collect(metadata.alternateTitles);
    collect(metadata.alternate_titles);
    collect(metadata.translations);
    collect(metadata.titles);
    collect(metadata.nameTranslations);
    collect(metadata.name_translations);

    return uniqueTitles(values);
  }

  private safeJsonObject(
    rawJson: string | null,
  ): Record<string, unknown> | undefined {
    if (!rawJson) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(rawJson);

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (error) {
      debugLog('Unable to parse provider metadata JSON', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return undefined;
  }

  private buildSearchStrategies(parsedTitle: string): string[] {
    const cleaned = this.cleanParsedTitle(parsedTitle);

    return uniqueTitles([
      cleaned,
      cleaned
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    ]);
  }

  private cleanParsedTitle(value: string): string {
    return value
      .normalize('NFKC')
      .replace(/[._]+/g, ' ')
      .replace(/[‐‑‒–—]/g, '-')
      .replace(/\s+-\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async resolveEpisodes(
    provider: IMetadataProvider,
    showId: string,
    parsed: {
      season?: number;
      episodes?: number[];
      absoluteNumbers?: number[];
    },
    show: Show,
  ): Promise<{ episodes: Episode[]; errors: string[] }> {
    const episodes: Episode[] = [];
    const errors: string[] = [];

    if (parsed.episodes?.length) {
      for (const episodeNumber of parsed.episodes) {
        const query: EpisodeQuery = {
          season: parsed.season,
          episode: episodeNumber,
        };

        try {
          const episode = await provider.getEpisode(showId, query);
          episodes.push(episode);

          debugLog('Episode resolved', {
            show: show.title,
            showId,
            season: parsed.season,
            episodeNumber,
            title: episode.title,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`S${parsed.season}E${episodeNumber}: ${message}`);
          debugLog('Failed to resolve episode', {
            show: show.title,
            showId,
            season: parsed.season,
            episodeNumber,
            error: message,
          });
        }
      }

      return { episodes, errors };
    }

    if (parsed.absoluteNumbers?.length) {
      for (const absoluteNumber of parsed.absoluteNumbers) {
        try {
          const episode = await provider.getEpisode(showId, {
            absoluteNumber,
          });

          episodes.push(episode);

          debugLog('Absolute episode resolved', {
            show: show.title,
            showId,
            absoluteNumber,
            title: episode.title,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`Absolute #${absoluteNumber}: ${message}`);
          debugLog('Failed to resolve absolute episode', {
            show: show.title,
            showId,
            absoluteNumber,
            error: message,
          });
        }
      }
    }

    return { episodes, errors };
  }

  private buildPath(
    show: Show,
    episodes: Episode[],
    originalFilename: string,
    config?: Record<string, unknown>,
  ): string {
    const extension = originalFilename.match(/\.[^.]+$/)?.[0] ?? '.mkv';
    const firstEpisode = episodes[0];

    if (!firstEpisode) {
      return `Unknown/${originalFilename}`;
    }

    const seasonPadded = String(firstEpisode.season).padStart(2, '0');

    const episodeCode = episodes.length === 1
      ? `S${seasonPadded}E${String(firstEpisode.episode).padStart(2, '0')}`
      : `S${seasonPadded}E${String(firstEpisode.episode).padStart(2, '0')}-${String(
          episodes.at(-1)?.episode ?? firstEpisode.episode,
        ).padStart(2, '0')}`;

    const seasonFolderFormat =
      (config?.seasonFolderFormat as string) || 'Season {season}';
    const seasonFolder = seasonFolderFormat
      .replace('{season:02}', seasonPadded)
      .replace('{season}', String(firstEpisode.season));

    const safeShowTitle = this.sanitize(show.title);
    const safeEpisodeTitle = firstEpisode.title
      ? ` - ${this.sanitize(firstEpisode.title)}`
      : '';

    return [
      safeShowTitle,
      seasonFolder,
      `${safeShowTitle} - ${episodeCode}${safeEpisodeTitle}${extension}`,
    ].join('/');
  }

  private sanitize(value: string): string {
    return value.replace(/[<>:"/\\|?*]/g, '').trim();
  }

  /**
   * Resolve a file, falling back to the series->release->episode grab
   * tracking when the normal parse+search path fails. When we know exactly
   * which show/season/episode a release was grabbed for, skip the show-name
   * search entirely and resolve the episode(s) straight from that show's
   * provider.
   */
  async resolveWithGrabHint(
    filename: string,
    preferredProvider: ProviderType = 'tmdb',
    config: Record<string, unknown> = {},
    overrideShowId?: string,
  ): Promise<{
    show: Show;
    episodes: Episode[];
    proposedPath: string;
    parsed?: unknown;
    usedHint: boolean;
  } | null> {
    if (overrideShowId) {
      const parsed = this.parser.parse(filename);
      const seasonNum = parsed?.season ?? 1;
      const singleEpisode = parsed?.episodes?.length === 1 ? parsed.episodes[0] : (parsed?.episodes?.[0] ?? 1);

      const hinted = await this.resolveGrabbed(filename, {
        showId: overrideShowId,
        season: seasonNum,
        episode: singleEpisode,
      }, preferredProvider, config);

      if (hinted) return { ...hinted, usedHint: true };
    }

    const normal = await this.resolve(filename, preferredProvider, config);
    if (normal) return { ...normal, usedHint: false };

    const parsed = this.parser.parse(filename);
    const seasonNum = parsed?.season;
    const singleEpisode = parsed?.episodes?.length === 1 ? parsed.episodes[0] : undefined;
    if (seasonNum == null || singleEpisode == null) return null;

    const grab = db.findGrabbedReleaseForEpisode(seasonNum, singleEpisode);
    if (!grab) return null;

    const hinted = await this.resolveGrabbed(filename, {
      showId: grab.show_id,
      season: grab.season_number ?? seasonNum,
      episode: grab.episode_number ?? singleEpisode,
    }, preferredProvider, config);

    if (!hinted) return null;
    return { ...hinted, usedHint: true };
  }

  /**
   * Resolve a file whose name is too generic for the normal parse+search
   * path, using an explicit hint of which show/season/episode it was
   * grabbed for. Skips the show-name search entirely and resolves the
   * episode(s) straight from that show's provider.
   */
  async resolveGrabbed(
    filename: string,
    hint: { showId: string; season?: number; episode?: number },
    preferredProvider: ProviderType = 'tmdb',
    config: Record<string, unknown> = {},
  ): Promise<{
    show: Show;
    episodes: Episode[];
    proposedPath: string;
    parsed?: unknown;
  } | null> {
    const parsed = this.parser.parse(filename);
    this.lastParsed = parsed;
    this.lastSearchResults = [];

    const showRow = db.getShow(hint.showId) as any;
    if (!showRow) return null;

    const providers = db.listShowProviders(hint.showId) as any[];
    const primary = providers.find((p: any) => p.is_primary) ?? providers[0];
    if (!primary) return null;

    const providerType = isProviderType(primary.provider_type) ? primary.provider_type : preferredProvider;
    const provider = ProviderFactory.getProvider(providerType, config);

    const show: Show = {
      id: primary.provider_id,
      title: showRow.title,
      originalTitle: showRow.original_title ?? undefined,
      year: showRow.year ?? undefined,
      provider: providerType,
      metadata: this.safeJsonObject(primary.metadata_json),
    };

    const season = parsed?.season ?? hint.season;
    const episodeNumbers = parsed?.episodes?.length
      ? parsed.episodes
      : hint.episode != null
        ? [hint.episode]
        : [];

    if (season == null || episodeNumbers.length === 0) {
      debugLog('Grab hint missing season/episode numbers; falling back to normal resolution', {
        filename,
        showId: hint.showId,
        parsed,
      });
      return null;
    }

    debugLog('Resolving via grab hint (skipping show-name search)', {
      filename,
      showId: hint.showId,
      show: show.title,
      season,
      episodes: episodeNumbers,
    });

    const { episodes, errors } = await this.resolveEpisodes(
      provider,
      primary.provider_id,
      { season, episodes: episodeNumbers },
      show,
    );

    if (episodes.length === 0) {
      debugLog('Grab-hint episode resolution failed', {
        show: show.title,
        season,
        episodes: episodeNumbers,
        errors,
      });
      return null;
    }

    const proposedPath = this.buildPath(show, episodes, filename, config as Record<string, unknown>);

    return { show, episodes, proposedPath, parsed };
  }

  /**
   * Lightweight resolver used by the manual-import list view. It deliberately
   * avoids ANY provider flow so the list page cannot OOM the pod:
   *   • never calls provider.searchShow() — its per-result hydration pulls
   *     ~120MB of extended-series JSON per candidate
   *   • never calls provider.getEpisode()/getEpisodes()/fetchExtendedSeries()
   *     — its paginated TVDB episode listing pulled ~1GB per file
   *   • never calls provider.getShow()
   *
   * It only consults the local DB (show_titles alias index + fuzzy fallback).
   * If a file matches a previously-imported show, the row is returned so the
   * UI can display the title/season/episode and show whether the file is a
   * duplicate of an existing import. Files with no local match are returned
   * as resolved:false — the user can still import them, and the full
   * (expensive) resolveWithGrabHint() runs then inside handleFile().
   *
   * This matters because /api/manual-import/list enumerates every file in
   * the watch folder; running the heavy path per file accumulated GBs of
   * episode payloads on the JS heap before the kernel OOM-killed the pod.
   */
  async resolveForList(
    filename: string,
    preferredProvider: ProviderType = 'tmdb',
    config: Record<string, unknown> = {},
  ): Promise<{
    show: Show;
    season?: number;
    episodes: number[];
    parsed?: unknown;
  } | null> {
    const parsed = this.parser.parse(filename);
    this.lastParsed = parsed;
    this.lastSearchResults = [];
    this.lastProviderAttempts = [];

    if (!parsed?.show) {
      return null;
    }

    parsed.show = this.cleanParsedTitle(parsed.show);
    debugLog('List-resolve: parsed filename', { filename, parsed });

    const localCandidate = this.findLocalShow(parsed.show);
    if (!localCandidate) {
      debugLog('List-resolve: no local match; returning unresolved', {
        parsedTitle: parsed.show,
      });
      return null;
    }

    debugLog('List-resolve: local match', {
      parsedTitle: parsed.show,
      title: localCandidate.show.title,
      providerType: localCandidate.providerType,
      providerId: localCandidate.providerId,
      score: localCandidate.score,
    });

    return {
      show: localCandidate.show,
      season: parsed.season,
      episodes: parsed.episodes ?? [],
      parsed,
    };
  }

  getDiagnostics(): {
    parsed: ParsedFilename | null;
    searchResults: Show[];
    searchResultCount: number;
    providerAttempts: Array<{
      provider: ProviderType;
      strategies: string[];
      candidateCount: number;
      candidates: { id: string; title: string }[];
      matchedTitle: string | null;
      episodeErrors: string[];
    }>;
  } {
    return {
      parsed: this.lastParsed as ParsedFilename | null,
      searchResults: this.lastSearchResults,
      searchResultCount: this.lastSearchResults.length,
      providerAttempts: this.lastProviderAttempts,
    };
  }

}
