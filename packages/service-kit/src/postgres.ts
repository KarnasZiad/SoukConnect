import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';

/**
 * A pool with `bigint` columns read as numbers: amounts are centimes below 10^10, far from the
 * 2^53 limit of exact integers, and the code never handles strings for money.
 */
export function connectPostgres(url: string, options: { max?: number } = {}): Sql {
  return postgres(url, {
    max: options.max ?? 10,
    onnotice: () => undefined,
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (value: number) => value.toString(),
        parse: (value: string) => {
          const number = Number(value);
          if (!Number.isSafeInteger(number)) throw new RangeError(`bigint out of range: ${value}`);
          return number;
        },
      },
    },
  });
}

// Arbitrary but fixed: every replica of a service contends for the same lock.
const LOCK = 7_402_117_385;

export interface Migration {
  id: string;
  checksum: string;
  sql: string;
}

/** `NNNN_name.sql` files of a directory, in order. */
export async function loadMigrations(directory: string): Promise<Migration[]> {
  const files = (await readdir(directory))
    .filter((file) => /^\d{4}_[\w-]+\.sql$/.test(file))
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(join(directory, file), 'utf8');
      return {
        id: file.replace(/\.sql$/, ''),
        checksum: createHash('sha256').update(sql).digest('hex'),
        sql,
      };
    }),
  );
}

/**
 * Applies pending migrations in order, in one transaction (all or nothing), under an advisory lock:
 * replicas starting together never migrate twice. A migration edited after being applied is
 * refused: history is rewritten by a new migration only.
 *
 * `shared` migrations come from packages (the outbox and inbox of `@soukconnect/messaging`) and
 * run before the service's own files.
 */
export async function migrate(
  sql: Sql,
  directory: string,
  shared: readonly { id: string; sql: string }[] = [],
): Promise<string[]> {
  const migrations = [
    ...shared.map((migration) => ({
      ...migration,
      checksum: createHash('sha256').update(migration.sql).digest('hex'),
    })),
    ...(await loadMigrations(directory)),
  ];
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK})`;
    await tx`
      create table if not exists schema_migrations (
        id text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`;
    const applied = new Map(
      (
        await tx<{ id: string; checksum: string }[]>`select id, checksum from schema_migrations`
      ).map((row) => [row.id, row.checksum]),
    );
    const done: string[] = [];
    for (const migration of migrations) {
      const checksum = applied.get(migration.id);
      if (checksum !== undefined) {
        if (checksum !== migration.checksum) {
          throw new Error(`Migration ${migration.id} was modified after being applied`);
        }
        continue;
      }
      await tx.unsafe(migration.sql);
      await tx`insert into schema_migrations (id, checksum) values (${migration.id}, ${migration.checksum})`;
      done.push(migration.id);
    }
    return done;
  });
}
