import type { Indexer } from './types';
import type { NativeIndexerConfig, NativeIndexerId } from './native/types';
import { ProwlarrIndexer } from './prowlarr';
import { NyaaSiIndexer } from './native/nyaa';
import { SubsPleaseIndexer } from './native/subsplease';
import { TPBIndexer } from './native/tpb';
import { KnabenIndexer } from './native/knaben';
import { RarbgIndexer } from './native/rarbg';

export class IndexerFactory {
  static create(type: string, config: any): Indexer {
    switch (type) {
      case 'prowlarr':
        return new ProwlarrIndexer(config.apiKey, config.baseUrl);
      case 'native':
        return IndexerFactory.createNative(config);
      default:
        throw new Error(`Unsupported indexer type: ${type}`);
    }
  }

  static createNative(config: NativeIndexerConfig): Indexer {
    const { id, baseUrl } = config;
    switch (id) {
      case 'nyaa':
        return new NyaaSiIndexer(baseUrl);
      case 'subsplease':
        return new SubsPleaseIndexer(baseUrl);
      case 'tpb':
        return new TPBIndexer(baseUrl);
      case 'knaben':
        return new KnabenIndexer(baseUrl);
      case 'rarbg':
        return new RarbgIndexer(baseUrl);
      default:
        throw new Error(`Unknown native indexer id: ${id}`);
    }
  }
}
