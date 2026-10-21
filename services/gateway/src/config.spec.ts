import { describe, expect, it } from 'vitest';
import { loadGatewayConfig } from './config.js';

const env = {
  GATEWAY_DATABASE_URL: 'postgresql://gateway:gateway@localhost:5432/gateway',
  REDIS_URL: 'redis://localhost:6379',
  INTERNAL_JWT_PRIVATE_KEY: '{}',
};

describe('gateway configuration', () => {
  it('secures cookies unless told otherwise, and knows where the services are', () => {
    expect(loadGatewayConfig(env)).toMatchObject({
      PORT: 4000,
      COOKIE_SECURE: true,
      SESSION_DAYS: 7,
      TRUST_PROXY_HOPS: 0,
      CATALOG_URL: 'http://localhost:4100',
    });
    expect(loadGatewayConfig({ ...env, COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(false);
  });

  it('refuses an unknown flag value and sessions longer than a month', () => {
    expect(() => loadGatewayConfig({ ...env, COOKIE_SECURE: 'yes' })).toThrow(/COOKIE_SECURE/);
    expect(() => loadGatewayConfig({ ...env, SESSION_DAYS: '90' })).toThrow(/SESSION_DAYS/);
  });
});
