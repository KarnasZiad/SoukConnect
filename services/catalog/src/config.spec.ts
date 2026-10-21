import { describe, expect, it } from 'vitest';
import { loadCatalogConfig } from './config.js';

const env = {
  CATALOG_MONGODB_URL: 'mongodb://localhost:27017/catalog?directConnection=true',
  MEILISEARCH_URL: 'http://localhost:7700',
  MEILI_MASTER_KEY: 'local-development-master-key',
  RABBITMQ_URL: 'amqp://souk:souk@localhost:5672',
  INTERNAL_JWT_PUBLIC_KEYS: '[]',
};

describe('catalog configuration', () => {
  it('reads the image hosts as a list', () => {
    expect(loadCatalogConfig(env)).toMatchObject({
      PORT: 4100,
      ALLOWED_IMAGE_HOSTS: ['images.soukconnect.ma'],
    });
    expect(
      loadCatalogConfig({ ...env, ALLOWED_IMAGE_HOSTS: 'cdn.example.ma, images.example.ma' })
        .ALLOWED_IMAGE_HOSTS,
    ).toEqual(['cdn.example.ma', 'images.example.ma']);
  });

  it('refuses a short master key or a malformed host', () => {
    expect(() => loadCatalogConfig({ ...env, MEILI_MASTER_KEY: 'short' })).toThrow(
      /MEILI_MASTER_KEY/,
    );
    expect(() => loadCatalogConfig({ ...env, ALLOWED_IMAGE_HOSTS: 'https://cdn/' })).toThrow(
      /ALLOWED_IMAGE_HOSTS/,
    );
  });
});
