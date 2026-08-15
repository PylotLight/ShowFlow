import { z } from 'zod';

export const ShowSchema = z.object({
  id: z.string(),
  title: z.string(),

  /**
   * Source/native title returned by the metadata provider.
   * For example, an English provider title may be "Full-Time Magister" while
   * the original title is "全职法师".
   */
  originalTitle: z.string().optional(),

  /**
   * Romanized form of the original title, when supplied by the provider.
   * For example: "Quanzhi Fashi".
   */
  romanizedTitle: z.string().optional(),

  /**
   * Alternate, translated, localized, or provider-recognized show names.
   * These are used for matching filenames, not for choosing the final folder
   * name; `title` remains the canonical display/path title.
   */
  aliases: z.array(z.string()).optional(),

  /**
   * Kept separately for providers that distinguish an explicit alternate
   * title collection from aliases. The resolver searches both fields.
   */
  alternateTitles: z.array(z.string()).optional(),

  /**
   * Provider translation map keyed by provider language code, such as:
   *
   * {
   *   eng: 'Full-Time Magister',
   *   jpn: '全职法师',
   *   zho: '全职法师',
   * }
   */
  translations: z.record(z.string(), z.string()).optional(),

  year: z.number().optional(),

  /**
   * Metadata provider identifier: tmdb, tvdb, anilist, etc.
   */
  provider: z.string(),

  /**
   * Unified provider identifier where one exists. For TVDB this is generally
   * the TVDB series ID represented as a string.
   */
  normalizedId: z.string().optional(),

  /**
   * Raw provider-specific data retained for debugging, synchronization, and
   * extraction of future title variants that are not yet explicitly modeled.
   */
  metadata: z.record(z.string(), z.any()).optional(),
});

export type Show = z.infer<typeof ShowSchema>;

export const SeasonSchema = z.object({
  id: z.string(),
  number: z.number(),
  name: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export type Season = z.infer<typeof SeasonSchema>;

export const EpisodeSchema = z.object({
  season: z.number(),
  episode: z.number(),
  absoluteNumber: z.number().optional(),
  title: z.string().optional(),
  airDate: z.string().optional(),
  /** Scheduled time-of-day the episode airs ("HH:MM") when the provider
   *  supplies it distinctly (TVDB series airsTime, AniList airingAt).
   *  Kept separate from airDate so a date-only airDate (TMDB) can still
   *  produce a full air-window datetime. */
  airTime: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export type Episode = z.infer<typeof EpisodeSchema>;

/**
 * A filename can identify an episode in either seasonal or absolute numbering.
 * Providers must resolve one valid form into a complete Episode result.
 */
export interface EpisodeQuery {
  season?: number;
  episode?: number;
  absoluteNumber?: number;
}

export interface IMetadataProvider {
  name: string;

  /** Whether this provider has the credentials it needs to make API calls. */
  isConfigured(): boolean;

  searchShow(query: string): Promise<Show[]>;

  getShow(id: string): Promise<Show>;

  getEpisode(
    showId: string,
    episodeInfo: EpisodeQuery,
  ): Promise<Episode>;

  getSeasons(showId: string): Promise<Season[]>;

  getEpisodes(
    showId: string,
    seasonNumber?: number,
  ): Promise<Episode[]>;
}
