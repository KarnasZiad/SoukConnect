import { z } from 'zod';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Settings every service reads. */
export const baseConfig = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  HOST: z.string().default('0.0.0.0'),
};

/**
 * Validates the environment at startup: a service with a missing or malformed setting refuses to
 * start, with the list of the faulty variables. Values are never echoed (they may be secrets).
 */
export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  throw new ConfigError(`Invalid configuration:\n  ${problems.join('\n  ')}`);
}
