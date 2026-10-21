import type { Handlers, QueueSpec } from '@soukconnect/messaging';
import { isListed } from '../domain/rules.js';
import type { CatalogStore, StockLedger } from '../ports.js';
import { type SearchDocument, toSearchDocument } from '../search/documents.js';

/** Commands of the saga, sent by orders: one queue, one consumer service. */
export const COMMANDS: QueueSpec = {
  queue: 'catalog.commands',
  bindings: ['catalog.reserve-stock', 'catalog.release-stock', 'catalog.commit-stock'],
};

/** The catalog keeps its own search index up to date from its own events. */
export const INDEXER: QueueSpec = {
  queue: 'catalog.indexer',
  bindings: ['catalog.product-changed'],
};

export function commandHandlers(stock: StockLedger): Handlers {
  return {
    'catalog.reserve-stock': (envelope) => stock.reserve(envelope),
    'catalog.release-stock': (envelope) => stock.release(envelope),
    'catalog.commit-stock': (envelope) => stock.commit(envelope),
  };
}

export interface IndexWriter {
  upsert(documents: SearchDocument[]): Promise<void>;
  remove(id: string): Promise<void>;
}

/**
 * Reads the product again rather than trusting the event: events may arrive out of order, the
 * database holds the latest state. Upserts and deletions are idempotent, so no inbox is needed.
 */
export function indexerHandlers(
  store: Pick<CatalogStore, 'getForIndex'>,
  index: IndexWriter,
): Handlers {
  return {
    'catalog.product-changed': async (envelope) => {
      const found = await store.getForIndex(envelope.payload.productId);
      if (found && isListed(found.product, found.shop)) {
        await index.upsert([toSearchDocument(found.product, found.shop)]);
      } else {
        await index.remove(envelope.payload.productId);
      }
    },
  };
}
