import { createLogger } from '@soukconnect/service-kit';
import { Meilisearch } from 'meilisearch';
import { MongoClient } from 'mongodb';
import { loadCatalogConfig } from '../config.js';
import { MongoCatalogStore } from '../mongo/catalog-store.js';
import { toSearchDocument } from '../search/documents.js';
import { MeiliSearchIndex } from '../search/meili-index.js';

/** Rebuilds the search index from MongoDB: after a settings change, or to restore the index. */
const config = loadCatalogConfig();
const logger = createLogger('catalog-reindex', config.LOG_LEVEL);
const mongo = await MongoClient.connect(config.CATALOG_MONGODB_URL);
try {
  const store = new MongoCatalogStore(mongo, mongo.db());
  const index = new MeiliSearchIndex(
    new Meilisearch({ host: config.MEILISEARCH_URL, apiKey: config.MEILI_MASTER_KEY }),
  );
  async function* documents() {
    for await (const batch of store.listedInBatches()) {
      yield batch.map(({ product, shop }) => toSearchDocument(product, shop));
    }
  }
  const count = await index.rebuild(documents());
  logger.info({ count }, 'search index rebuilt');
} finally {
  await mongo.close();
}
