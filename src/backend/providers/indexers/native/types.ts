export type NativeIndexerId =
  | 'nyaa'
  | 'subsplease'
  | 'tpb'
  | 'knaben'
  | 'rarbg';

export interface NativeIndexerConfig {
  id: NativeIndexerId;
  enabled: boolean;
  /** Override the default base URL for this tracker. */
  baseUrl?: string;
  /** Some trackers may need an API key or cookie. */
  apiKey?: string;
}

export const NATIVE_INDEXER_META: Record<NativeIndexerId, {
  name: string;
  description: string;
  defaultUrl: string;
  protocol: 'torrent' | 'usenet';
  privacy: 'public' | 'private' | 'semi-public';
}> = {
  nyaa: {
    name: 'Nyaa.si',
    description: 'BitTorrent community focused on East Asian media (anime)',
    defaultUrl: 'https://nyaa.si',
    protocol: 'torrent',
    privacy: 'public',
  },
  subsplease: {
    name: 'SubsPlease',
    description: 'Anime releases with consistent quality and English subtitles',
    defaultUrl: 'https://subsplease.org',
    protocol: 'torrent',
    privacy: 'public',
  },
  tpb: {
    name: 'The Pirate Bay',
    description: 'Large public torrent indexer covering all categories',
    defaultUrl: 'https://thepiratebay.org',
    protocol: 'torrent',
    privacy: 'public',
  },
  knaben: {
    name: 'Knaben',
    description: 'General-purpose public torrent indexer (API v1)',
    defaultUrl: 'https://api.knaben.org/v1',
    protocol: 'torrent',
    privacy: 'public',
  },
  rarbg: {
    name: 'TheRARBG',
    description: 'Public torrent indexer (RARBG clone/mirror)',
    defaultUrl: 'https://therarbg.to',
    protocol: 'torrent',
    privacy: 'public',
  },
};
