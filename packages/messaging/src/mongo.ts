import { type Envelope, type MessageType, uuidv7 } from '@soukconnect/contracts';
import { type ClientSession, type Db, MongoServerError } from 'mongodb';
import type { OutboxStore } from './outbox.js';

interface OutboxDocument {
  _id: string;
  type: MessageType;
  payload: Envelope['payload'];
  correlationId: string;
  causationId: string | null;
  occurredAt: Date;
  publishedAt: Date | null;
  /** A relay holds the message until this date; expired leases are taken over. */
  leaseUntil: Date | null;
  leaseToken?: string;
}

interface InboxDocument {
  _id: string;
  processedAt: Date;
}

const OUTBOX = 'outbox';
const INBOX = 'inbox';
const RETENTION_SECONDS = 7 * 24 * 3600;

/** Indexes of the outbox and the inbox, with a 7-day expiry of what has been handled. */
export async function ensureMessagingIndexes(db: Db): Promise<void> {
  const outbox = db.collection<OutboxDocument>(OUTBOX);
  await outbox.createIndex({ publishedAt: 1, leaseUntil: 1, _id: 1 }, { name: 'pending' });
  // TTL indexes ignore documents whose field is not a date: pending messages (null) stay.
  await outbox.createIndex(
    { publishedAt: 1 },
    { name: 'published_ttl', expireAfterSeconds: RETENTION_SECONDS },
  );
  await db
    .collection<InboxDocument>(INBOX)
    .createIndex(
      { processedAt: 1 },
      { name: 'processed_ttl', expireAfterSeconds: RETENTION_SECONDS },
    );
}

/** Writes messages in the caller's transaction (MongoDB requires a replica set for it). */
export async function enqueue(
  db: Db,
  envelopes: Envelope | readonly Envelope[],
  session: ClientSession,
): Promise<void> {
  const documents = ('id' in envelopes ? [envelopes] : envelopes).map(
    (envelope: Envelope): OutboxDocument => ({
      _id: envelope.id,
      type: envelope.type,
      payload: envelope.payload,
      correlationId: envelope.correlationId,
      causationId: envelope.causationId,
      occurredAt: new Date(envelope.occurredAt),
      publishedAt: null,
      leaseUntil: null,
    }),
  );
  await db.collection<OutboxDocument>(OUTBOX).insertMany(documents, { session });
}

/**
 * MongoDB has no `SKIP LOCKED`: each message is claimed with a lease (atomic findOneAndUpdate),
 * published, then marked. A relay that dies keeps its messages until the lease expires, then
 * another relay publishes them again: delivery is at least once, the inbox removes duplicates.
 */
export function mongoOutbox(db: Db, options: { leaseMs?: number } = {}): OutboxStore {
  const leaseMs = options.leaseMs ?? 30_000;
  const outbox = db.collection<OutboxDocument>(OUTBOX);
  return {
    async drain(limit, send) {
      const token = uuidv7();
      const now = new Date();
      const claimed: OutboxDocument[] = [];
      while (claimed.length < limit) {
        const document = await outbox.findOneAndUpdate(
          { publishedAt: null, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] },
          { $set: { leaseUntil: new Date(now.getTime() + leaseMs), leaseToken: token } },
          { sort: { _id: 1 }, returnDocument: 'after' },
        );
        if (!document) break;
        claimed.push(document);
      }
      if (claimed.length === 0) return 0;
      const ids = claimed.map((document) => document._id);
      try {
        await send(
          claimed.map((document) => ({
            id: document._id,
            type: document.type,
            payload: document.payload,
            correlationId: document.correlationId,
            causationId: document.causationId,
            occurredAt: document.occurredAt.toISOString(),
          })),
        );
      } catch (error) {
        await outbox.updateMany(
          { _id: { $in: ids }, leaseToken: token },
          { $set: { leaseUntil: null }, $unset: { leaseToken: '' } },
        );
        throw error;
      }
      await outbox.updateMany(
        { _id: { $in: ids }, leaseToken: token },
        { $set: { publishedAt: new Date() }, $unset: { leaseToken: '' } },
      );
      return claimed.length;
    },
  };
}

/**
 * Records that `consumer` handled `messageId`, in the caller's transaction; call it first.
 * Returns false for a duplicate. A write error aborts a MongoDB transaction, so after `false` the
 * caller must abort it and acknowledge the message without any further write.
 */
export async function markProcessed(
  db: Db,
  consumer: string,
  messageId: string,
  session: ClientSession,
): Promise<boolean> {
  try {
    await db
      .collection<InboxDocument>(INBOX)
      .insertOne({ _id: `${consumer}:${messageId}`, processedAt: new Date() }, { session });
    return true;
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) return false;
    throw error;
  }
}
