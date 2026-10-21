import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { baseConfig, ConfigError, loadConfig } from './config.js';

const schema = z.object({
  ...baseConfig,
  PORT: z.coerce.number().int().min(1).max(65_535),
  STRIPE_SECRET_KEY: z.string().startsWith('sk_test_'),
});

describe('loadConfig', () => {
  it('applies defaults and coerces values', () => {
    expect(loadConfig(schema, { PORT: '4300', STRIPE_SECRET_KEY: 'sk_test_123' })).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      HOST: '0.0.0.0',
      PORT: 4300,
      STRIPE_SECRET_KEY: 'sk_test_123',
    });
  });

  it('lists every faulty variable without echoing its value', () => {
    let error: unknown;
    try {
      loadConfig(schema, { PORT: 'abc', STRIPE_SECRET_KEY: 'sk_live_super_secret' });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain('PORT');
    expect(message).toContain('STRIPE_SECRET_KEY');
    expect(message).not.toContain('sk_live_super_secret');
  });
});
