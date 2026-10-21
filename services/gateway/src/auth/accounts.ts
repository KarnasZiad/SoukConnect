import { type Locale, type Role, uuidv7 } from '@soukconnect/contracts';
import type { Sql } from 'postgres';

export interface Account {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  locale: Locale;
  createdAt: Date;
}

export interface AccountWithSecret extends Account {
  passwordHash: string | null;
}

export interface AccountStore {
  create(
    input: Omit<Account, 'id' | 'createdAt'> & { passwordHash: string },
  ): Promise<Account | 'email-taken'>;
  findByEmail(email: string): Promise<AccountWithSecret | null>;
  findById(id: string): Promise<Account | null>;
  /** Erases what identifies the person; the identifier stays for the orders already placed. */
  delete(id: string): Promise<void>;
}

/** Trimmed and lower case: one person, one account, whatever the capitalization. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

interface AccountRow {
  id: string;
  email: string;
  password_hash: string | null;
  display_name: string;
  role: Role;
  locale: Locale;
  created_at: Date;
}

const toAccount = (row: AccountRow): Account => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  role: row.role,
  locale: row.locale,
  createdAt: row.created_at,
});

export class PostgresAccountStore implements AccountStore {
  constructor(private readonly sql: Sql) {}

  async create(input: Omit<Account, 'id' | 'createdAt'> & { passwordHash: string }) {
    const rows = await this.sql<AccountRow[]>`
      insert into accounts (id, email, password_hash, display_name, role, locale)
      values (${uuidv7()}, ${normalizeEmail(input.email)}, ${input.passwordHash},
              ${input.displayName}, ${input.role}, ${input.locale})
      on conflict (email) do nothing
      returning *`;
    const [row] = rows;
    return row ? toAccount(row) : ('email-taken' as const);
  }

  async findByEmail(email: string): Promise<AccountWithSecret | null> {
    const [row] = await this.sql<AccountRow[]>`
      select * from accounts where email = ${normalizeEmail(email)} and deleted_at is null`;
    return row ? { ...toAccount(row), passwordHash: row.password_hash } : null;
  }

  async findById(id: string): Promise<Account | null> {
    const [row] = await this.sql<AccountRow[]>`
      select * from accounts where id = ${id} and deleted_at is null`;
    return row ? toAccount(row) : null;
  }

  async delete(id: string): Promise<void> {
    await this.sql`
      update accounts
      set email = ${`deleted+${id}@invalid`}, display_name = 'Compte supprimé',
          password_hash = null, deleted_at = now()
      where id = ${id}`;
  }
}
