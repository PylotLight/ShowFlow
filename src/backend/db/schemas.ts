import { z } from 'zod';

export const ConfigSchema = z.object({
  apiKeys: z.record(z.string(), z.string()).optional(),
  imdb: z.object({
    enabled: z.boolean().default(false),
    apiKey: z.string().default(''),
    awsAccessKeyId: z.string().default(''),
    awsSecretAccessKey: z.string().default(''),
    region: z.string().default('us-east-1'),
    endpoint: z.string().default('https://api-fulfill.dataexchange.us-east-1.amazonaws.com/v1'),
    dataSetId: z.string().default(''),
    revisionId: z.string().default(''),
    assetId: z.string().default(''),
  }).default({
    enabled: false,
    apiKey: '',
    awsAccessKeyId: '',
    awsSecretAccessKey: '',
    region: 'us-east-1',
    endpoint: 'https://api-fulfill.dataexchange.us-east-1.amazonaws.com/v1',
    dataSetId: '',
    revisionId: '',
    assetId: '',
  }),
  defaultProvider: z.enum(['tmdb', 'tvdb', 'anilist']).default('tvdb'),
  onCollision: z.enum(['overwrite', 'skip', 'version']).default('skip'),
  dryRun: z.boolean().default(false),
  seasonFolderFormat: z.string().default('Season {season}'),
  importFolder: z.string().optional(),
  /**
   * IANA timezone used when a series has no recognisable originCountry
   * (matches Sonarr/Skyhook's default of assuming US network times; see
   * TVDBProvider.COUNTRY_TIMEZONE).
   */
  fallbackTimeZone: z.string().default('America/New_York'),
  downloadClient: z.object({
    type: z.enum(['blackhole', 'torbox', 'sabnzbd', 'none']).optional(),
    blackhole: z.object({
      outputFolder: z.string().optional(),
      watchFolder: z.string().optional(),
    }).optional(),
    torbox: z.object({
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
      inputFolder: z.string().optional(),
      outputFolder: z.string().optional(),
      concurrency: z.number().optional(),
    }).optional(),
    sabnzbd: z.object({
      url: z.string().optional(),
      apiKey: z.string().optional(),
    }).optional(),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export const ProwlarrConfigSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string().default('').refine(
    v => v === '' || /^https?:\/\/.+/.test(v),
    { message: "Prowlarr URL must be a valid URL (e.g. http://localhost:9696)" },
  ),
  apiKey: z.string().default(''),
  syncLevel: z.enum(['full', 'addRemoveOnly', 'disabled']).default('full'),
  tags: z.array(z.number()).default([]),
});

export type ProwlarrConfig = z.infer<typeof ProwlarrConfigSchema>;

export const SonarrConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().default('').refine(
    v => v === '' || /^https?:\/\/.+/.test(v),
    { message: "Sonarr URL must be a valid URL (e.g. http://localhost:8989)" },
  ),
  apiKey: z.string().default(''),
  apiVersion: z.enum(['v3', 'v5']).default('v3'),
});

export type SonarrConfig = z.infer<typeof SonarrConfigSchema>;

export const JellyfinConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().default('').refine(
    v => v === '' || /^https?:\/\/.+/.test(v),
    { message: "Jellyfin URL must be a valid URL (e.g. http://localhost:8096)" },
  ),
  apiKey: z.string().default(''),
});

export type JellyfinConfig = z.infer<typeof JellyfinConfigSchema>;

const NativeIndexerIdSchema = z.enum(['nyaa', 'subsplease', 'tpb', 'knaben', 'rarbg']);

export const NativeIndexerConfigSchema = z.object({
  id: NativeIndexerIdSchema,
  enabled: z.boolean().default(true),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
});

export const NativeIndexersConfigSchema = z.array(NativeIndexerConfigSchema).default([]);

export type NativeIndexerConfig = z.infer<typeof NativeIndexerConfigSchema>;

export const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
