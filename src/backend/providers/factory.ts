import type { IMetadataProvider } from '../core/types';
import { TMDBProvider } from './tmdb';
import { TVDBProvider } from './tvdb';
import { AniListProvider } from './anilist';

export type ProviderType = 'tmdb' | 'tvdb' | 'anilist';

export class ProviderFactory {
  static getProvider(type: ProviderType, config: any = {}): IMetadataProvider {
    switch (type) {
      case 'tmdb':
        return new TMDBProvider(config);
      case 'tvdb':
        return new TVDBProvider(config);
      case 'anilist':
        return new AniListProvider(config);
      default:
        throw new Error(`Unsupported provider type: ${type}`);
    }
  }
}
