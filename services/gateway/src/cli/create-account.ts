import { parseArgs } from 'node:util';
import { connectPostgres } from '@soukconnect/service-kit/postgres';
import { z } from 'zod';
import { PostgresAccountStore } from '../auth/accounts.js';
import { hashPassword } from '../auth/passwords.js';
import { loadGatewayConfig } from '../config.js';

/**
 * Creates an account from the command line, notably moderators, which sign-up never creates (E1).
 * The password comes from ACCOUNT_PASSWORD, so that it stays out of the shell history.
 */
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', default: 'moderator' },
    locale: { type: 'string', default: 'fr' },
  },
});
const input = z
  .object({
    email: z.email(),
    name: z.string().min(2).max(60),
    role: z.enum(['buyer', 'seller', 'moderator']),
    locale: z.enum(['fr', 'en', 'ar']),
    password: z.string().min(12).max(128),
  })
  .parse({ ...values, password: process.env.ACCOUNT_PASSWORD });

const sql = connectPostgres(loadGatewayConfig().GATEWAY_DATABASE_URL);
try {
  const account = await new PostgresAccountStore(sql).create({
    email: input.email,
    displayName: input.name,
    role: input.role,
    locale: input.locale,
    passwordHash: await hashPassword(input.password),
  });
  if (account === 'email-taken') {
    process.stderr.write('An account already uses this e-mail\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(`Created ${account.role} ${account.email} (${account.id})\n`);
  }
} finally {
  await sql.end();
}
