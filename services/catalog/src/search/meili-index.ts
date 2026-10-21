import type { Meilisearch, Settings } from 'meilisearch';
import type { SearchIndex } from '../ports.js';
import type { SearchDocument } from './documents.js';
import { FACETS, type SearchQuery, type SearchResult, toHit, toMeiliRequest } from './query.js';

export const INDEX = 'products';
const WAIT = { timeout: 30_000, interval: 50 };

/** Versioned settings: what is searched, in which order of importance, what filters and sorts. */
export const SETTINGS: Settings = {
  searchableAttributes: [
    'title_fr',
    'title_en',
    'title_ar',
    'shopName',
    'description_fr',
    'description_en',
    'description_ar',
  ],
  filterableAttributes: ['category', 'city', 'material', 'price', 'shopId', 'inStock'],
  sortableAttributes: ['price', 'publishedAt'],
  // Words of the trade that buyers write in several ways.
  synonyms: {
    tapis: ['zarbia', 'zerbia'],
    zarbia: ['tapis'],
    babouche: ['belgha', 'babouches'],
    belgha: ['babouche'],
    tajine: ['tagine'],
    tagine: ['tajine'],
    pouf: ['pouffe'],
  },
  faceting: { maxValuesPerFacet: 50 },
  pagination: { maxTotalHits: 2400 },
};

export class MeiliSearchIndex implements SearchIndex {
  constructor(
    private readonly client: Meilisearch,
    private readonly uid = INDEX,
  ) {}

  /** Creates the index if needed and applies the settings; idempotent, run at startup. */
  async configure(): Promise<void> {
    await this.client.createIndex(this.uid, { primaryKey: 'id' }).waitTask(WAIT);
    await this.client.index(this.uid).updateSettings(SETTINGS).waitTask(WAIT);
  }

  async upsert(documents: SearchDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const task = await this.client
      .index<SearchDocument>(this.uid)
      .addDocuments(documents, { primaryKey: 'id' })
      .waitTask(WAIT);
    if (task.status !== 'succeeded')
      throw new Error(`Indexing failed: ${task.error?.message ?? task.status}`);
  }

  async remove(id: string): Promise<void> {
    await this.client.index(this.uid).deleteDocument(id).waitTask(WAIT);
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    const request = toMeiliRequest(query);
    const response = await this.client
      .index<SearchDocument>(this.uid)
      .search(request.q, request.params);
    const distribution = response.facetDistribution ?? {};
    return {
      hits: response.hits.map((hit) => toHit(hit, query.locale)),
      facets: Object.fromEntries(
        FACETS.map((facet) => [facet, distribution[facet] ?? {}]),
      ) as SearchResult['facets'],
      total: response.totalHits,
      page: response.page,
      totalPages: response.totalPages,
      processingTimeMs: response.processingTimeMs,
    };
  }

  /**
   * Rebuilds the index from scratch: documents go to a new index, which then replaces the live
   * one atomically. Searches keep working during the rebuild, and it doubles as the restore
   * procedure of the index (ADR 0007).
   */
  async rebuild(documents: AsyncIterable<SearchDocument[]>): Promise<number> {
    const staging = new MeiliSearchIndex(this.client, `${this.uid}_${Date.now()}`);
    await this.configure();
    await staging.configure();
    let count = 0;
    for await (const batch of documents) {
      await staging.upsert(batch);
      count += batch.length;
    }
    await this.client
      .swapIndexes([{ indexes: [this.uid, staging.uid], rename: false }])
      .waitTask(WAIT);
    await this.client.deleteIndex(staging.uid).waitTask(WAIT);
    return count;
  }
}
