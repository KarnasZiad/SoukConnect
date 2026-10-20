import type { Envelope, MessageType } from '@soukconnect/contracts';
import type { Sql, TransactionSql } from 'postgres';
import type { OutboxStore } from './outbox.js';

/** Tables of the outbox and the inbox: services include this in their first migration. */
export const MESSAGING_SCHEMA = `
create table if not exists outbox (
  id uuid primary key,
  type text not null,
  payload jsonb not null,
  correlation_id text not null,
  causation_id uuid,
  occurred_at timestamptz not null,
  published_at timestamptz
);
-- The relay only scans what is still pending; UUID v7 identifiers sort by creation time.
create index if not exists outbox_pending on outbox (id) where published_at is null;

create table if not exists inbox (
  consumer text not null,
  message_id uuid not null,
  processed_at timestamptz not null default now(),
  primary key (consumer, message_id)
);
`;

type Executor = Sql | TransactionSql;

interface OutboxRow {
  id: string;
  type: MessageType;
  payload: Envelope['payload'];
  correlation_id: string;
  causation_id: string | null;
  occurred_at: Date;
}

/** Writes messages in the caller's transaction: they exist if and only if the state change does. */
export async function enqueue(
  tx: Executor,
  envelopes: Envelope | readonly Envelope[],
): Promise<void> {
  for (const envelope of 'id' in envelopes ? [envelopes] : envelopes) {
    await tx`
      insert into outbox (id, type, payload, correlation_id, causation_id, occurred_at)
      values (${envelope.id}, ${envelope.type}, ${tx.json(envelope.payload)},
              ${envelope.correlationId}, ${envelope.causationId}, ${envelope.occurredAt})
    `;
  }
}

/**
 * Locks a batch of pending rows (`FOR UPDATE SKIP LOCKED`: concurrent relays take different rows),
 * publishes them, and marks them published in the same transaction. If publishing fails, the
 * transaction rolls back and the rows are pending again.
 */
export function postgresOutbox(sql: Sql): OutboxStore {
  return {
    drain: (limit, send) =>
      sql.begin(async (tx) => {
        const rows = await tx<OutboxRow[]>`
          select id, type, payload, correlation_id, causation_id, occurred_at
          from outbox
          where published_at is null
          order by id
          limit ${limit}
          for update skip locked
        `;
        if (rows.length === 0) return 0;
        await send(
          rows.map((row) => ({
            id: row.id,
            type: row.type,
            payload: row.payload,
            correlationId: row.correlation_id,
            causationId: row.causation_id,
            occurredAt: row.occurred_at.toISOString(),
          })),
        );
        await tx`
          update outbox set published_at = now()
          where id in ${tx(rows.map((row) => row.id))}
        `;
        return rows.length;
      }),
  };
}

/**
 * Records that `consumer` handled `messageId`, in the caller's transaction. Returns false when it
 * already did: the caller then skips the effect, and the duplicate is acknowledged harmlessly.
 */
export async function markProcessed(
  tx: Executor,
  consumer: string,
  messageId: string,
): Promise<boolean> {
  const rows = await tx`
    insert into inbox (consumer, message_id) values (${consumer}, ${messageId})
    on conflict do nothing
    returning message_id
  `;
  return rows.length === 1;
}

/** Removes published messages and inbox entries older than `days` (both only grow otherwise). */
export async function purgeMessaging(
  sql: Sql,
  days = 7,
): Promise<{ outbox: number; inbox: number }> {
  const outbox = await sql`
    delete from outbox where published_at < now() - make_interval(days => ${days})
  `;
  const inbox = await sql`
    delete from inbox where processed_at < now() - make_interval(days => ${days})
  `;
  return { outbox: outbox.count, inbox: inbox.count };
}
