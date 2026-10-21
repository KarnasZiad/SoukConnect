import { hash, verify } from '@node-rs/argon2';

/**
 * OWASP Password Storage Cheat Sheet: Argon2id (the library default), 19 MiB, 2 passes, 1 lane.
 * NFKC first: the same passphrase typed on two keyboards gives the same hash.
 */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password.normalize('NFKC'), OPTIONS);
}

// Verified when the account does not exist, so that both answers take the same time.
let dummy: Promise<string> | undefined;

export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  const candidate = password.normalize('NFKC');
  if (stored === null) {
    dummy ??= hashPassword('an unused password, only to spend the same time');
    await verify(await dummy, candidate).catch(() => false);
    return false;
  }
  return verify(stored, candidate).catch(() => false);
}
