import type { IMetadataProvider } from '../core/types';
import { AniListProvider } from './anilist';
import { TMDBProvider } from './tmdb';
import { TVDBProvider } from './tvdb';

export type ProviderType = 'tmdb' | 'tvdb' | 'anilist';

export class ProviderFactory {
  static getProvider(
    type: ProviderType,
    config: Record<string, unknown> = {}
  ): IMetadataProvider {
    switch (type) {
      case 'tmdb':
        return new TMDBProvider(config);
      case 'tvdb':
        return new TVDBProvider(config);
      case 'anilist':
        return new AniListProvider(config);
      default: {
        const unsupportedType: never = type;
        throw new Error(`Unsupported provider type: ${unsupportedType}`);
      }
    }
  }
}
