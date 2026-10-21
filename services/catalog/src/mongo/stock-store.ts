import { createEnvelope, type Envelope } from '@soukconnect/contracts';
import { PermanentError } from '@soukconnect/messaging';
import { enqueue, markProcessed } from '@soukconnect/messaging/mongo';
import type { ClientSession, Db, MongoClient } from 'mongodb';
import { quantitiesOf, unavailableOf } from '../domain/rules.js';
import type { StockLedger } from '../ports.js';
import { collections, toProduct, toShop } from './documents.js';

export const STOCK_CONSUMER = 'catalog.commands';

/**
 * Stock reservations of the order saga. Each command is handled in one MongoDB transaction that
 * records it in the inbox, changes the stock and writes the answer in the outbox: a command
 * delivered twice changes nothing the second time, and no answer exists without its effect.
 */
export class MongoStockLedger implements StockLedger {
  private readonly collections;

  constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly onCommit: () => void = () => undefined,
  ) {
    this.collections = collections(db);
  }

  /** Runs `work` once per message; a duplicate aborts the transaction without any effect. */
  private async once(
    command: Envelope,
    work: (session: ClientSession) => Promise<void>,
  ): Promise<void> {
    const session = this.client.startSession();
    try {
      const handled = await session.withTransaction(async () => {
        if (!(await markProcessed(this.db, STOCK_CONSUMER, command.id, session))) {
          await session.abortTransaction();
          return false;
        }
        await work(session);
        return true;
      });
      if (handled) this.onCommit();
    } finally {
      await session.endSession();
    }
  }

  /** Products whose stock went from zero to positive, or the reverse: the search must know. */
  private async announceAvailability(
    productIds: readonly string[],
    session: ClientSession,
    cause: Envelope,
  ): Promise<void> {
    const products = await this.collections.products
      .find({ _id: { $in: [...productIds] } }, { session })
      .toArray();
    for (const product of products) {
      await enqueue(
        this.db,
        createEnvelope(
          'catalog.product-changed',
          {
            productId: product._id,
            shopId: product.shopId,
            slug: product.slug,
            status: product.status,
          },
          { causedBy: cause },
        ),
        session,
      );
    }
  }

  async reserve(command: Envelope<'catalog.reserve-stock'>): Promise<void> {
    const { orderId } = command.payload;
    const quantities = quantitiesOf(command.payload.items);
    const ids = [...quantities.keys()];
    const { products, shops, reservations } = this.collections;

    await this.once(command, async (session) => {
      if (await reservations.findOne({ _id: orderId }, { session })) {
        throw new PermanentError(`Order ${orderId} already has a reservation`);
      }
      const found = new Map(
        (await products.find({ _id: { $in: ids } }, { session }).toArray()).map((document) => [
          document._id,
          toProduct(document),
        ]),
      );
      const shopIds = [...new Set([...found.values()].map((product) => product.shopId))];
      const shopsById = new Map(
        (await shops.find({ _id: { $in: shopIds } }, { session }).toArray()).map((document) => [
          document._id,
          toShop(document),
        ]),
      );

      const unavailable = unavailableOf(quantities, found, shopsById);
      if (unavailable.length > 0) {
        await enqueue(
          this.db,
          createEnvelope('catalog.stock-rejected', { orderId, unavailable }, { causedBy: command }),
          session,
        );
        return;
      }

      const now = new Date();
      const soldOut: string[] = [];
      for (const [productId, quantity] of quantities) {
        // Read and decrement in the same snapshot; a concurrent reservation of the same product
        // makes one transaction fail with a transient write conflict, which the driver retries.
        const result = await products.updateOne(
          { _id: productId, status: 'PUBLISHED', stock: { $gte: quantity } },
          { $inc: { stock: -quantity }, $set: { updatedAt: now } },
          { session },
        );
        if (result.modifiedCount !== 1) throw new Error(`Stock of ${productId} changed meanwhile`);
        if (found.get(productId)?.stock === quantity) soldOut.push(productId);
      }
      await reservations.insertOne(
        {
          _id: orderId,
          status: 'RESERVED',
          items: [...quantities].map(([productId, quantity]) => ({ productId, quantity })),
          createdAt: now,
          updatedAt: now,
        },
        { session },
      );
      // Prices, titles and commission rates are frozen here: the order never trusts the client.
      const lines = command.payload.items.map((item) => {
        const product = found.get(item.productId);
        const shop = product ? shopsById.get(product.shopId) : undefined;
        if (!product || !shop) throw new Error('Unreachable: availability was checked');
        return {
          productId: product.id,
          shopId: shop.id,
          title: product.title,
          unitPrice: product.price,
          quantity: item.quantity,
          commissionBps: shop.commissionBps,
        };
      });
      await enqueue(
        this.db,
        createEnvelope(
          'catalog.stock-reserved',
          { orderId, currency: 'MAD', lines },
          { causedBy: command },
        ),
        session,
      );
      await this.announceAvailability(soldOut, session, command);
    });
  }

  async release(command: Envelope<'catalog.release-stock'>): Promise<void> {
    const { orderId } = command.payload;
    const { products, reservations } = this.collections;

    await this.once(command, async (session) => {
      const reservation = await reservations.findOne({ _id: orderId }, { session });
      // Nothing reserved (the order was rejected) or already released: nothing to give back.
      if (!reservation || reservation.status === 'RELEASED') return;
      if (reservation.status === 'COMMITTED') {
        throw new PermanentError(`Order ${orderId} is committed: its stock cannot be released`);
      }
      const now = new Date();
      const backInStock: string[] = [];
      for (const item of reservation.items) {
        const before = await products.findOneAndUpdate(
          { _id: item.productId },
          { $inc: { stock: item.quantity }, $set: { updatedAt: now } },
          { session, returnDocument: 'before' },
        );
        if (before?.stock === 0) backInStock.push(item.productId);
      }
      await reservations.updateOne(
        { _id: orderId, status: 'RESERVED' },
        { $set: { status: 'RELEASED', updatedAt: now } },
        { session },
      );
      await this.announceAvailability(backInStock, session, command);
    });
  }

  async commit(command: Envelope<'catalog.commit-stock'>): Promise<void> {
    const { orderId } = command.payload;
    const { products, reservations } = this.collections;

    await this.once(command, async (session) => {
      const reservation = await reservations.findOne({ _id: orderId }, { session });
      if (!reservation) throw new PermanentError(`Order ${orderId} has no reservation`);
      if (reservation.status === 'COMMITTED') return;
      if (reservation.status === 'RELEASED') {
        throw new PermanentError(`Order ${orderId} was released: it cannot be committed`);
      }
      const now = new Date();
      for (const item of reservation.items) {
        await products.updateOne(
          { _id: item.productId },
          { $inc: { sold: item.quantity }, $set: { updatedAt: now } },
          { session },
        );
      }
      await reservations.updateOne(
        { _id: orderId, status: 'RESERVED' },
        { $set: { status: 'COMMITTED', updatedAt: now } },
        { session },
      );
    });
  }
}
