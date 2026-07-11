import type { Indexer } from './types';
import { ProwlarrIndexer } from './prowlarr';

export class IndexerFactory {
  static create(type: string, config: any): Indexer {
    switch (type) {
      case 'prowlarr':
        return new ProwlarrIndexer(config.apiKey, config.baseUrl);
      default:
        throw new Error(`Unsupported indexer type: ${type}`);
    }
  }
}
