import { z } from 'zod';

export const ShowSchema = z.object({
  id: z.string(),
  title: z.string(),
  originalTitle: z.string().optional(),
  romanizedTitle: z.string().optional(),
  year: z.number().optional(),
  provider: z.string(), // e.g., 'tmdb', 'tvdb', 'anilist'
  normalizedId: z.string().optional(), // Unified ID across providers if applicable
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
  airDate: z.string().optional(), // ISO format
  metadata: z.record(z.string(), z.any()).optional(),
});

export type Episode = z.infer<typeof EpisodeSchema>;

// Season/episode are optional because a filename may only yield an absolute
// number (common in anime releases). Providers are responsible for resolving
// whichever combination they're given into a fully-qualified Episode.
// At least one of (season & episode) or absoluteNumber must be present.
export interface EpisodeQuery {
  season?: number;
  episode?: number;
  absoluteNumber?: number;
}

export interface IMetadataProvider {
  name: string;
  searchShow(query: string): Promise<Show[]>;
  getShow(id: string): Promise<Show>;
  getEpisode(showId: string, episodeInfo: EpisodeQuery): Promise<Episode>;
  getSeasons(showId: string): Promise<Season[]>;
  getEpisodes(showId: string, seasonNumber?: number): Promise<Episode[]>;
}
