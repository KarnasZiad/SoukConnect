import { createEnvelope, type Envelope, type Share, uuidv7 } from '@soukconnect/contracts';
import { enqueue, markProcessed } from '@soukconnect/messaging/postgres';
import type { Sql } from 'postgres';
import { decide } from '../domain/events.js';
import { type Balance, balanceOf, type EntryKind } from '../domain/ledger.js';
import type {
  Payment,
  PaymentStatus,
  PaymentStore,
  WebhookEvent,
  WebhookOutcome,
} from '../ports.js';

export const COMMANDS_CONSUMER = 'payments.commands';

interface PaymentRow {
  id: string;
  order_id: string;
  buyer_id: string;
  stripe_payment_intent_id: string;
  amount: number;
  status: PaymentStatus;
  shares: Share[];
  last_error: string | null;
}

const toPayment = (row: PaymentRow): Payment => ({
  id: row.id,
  orderId: row.order_id,
  buyerId: row.buyer_id,
  intentId: row.stripe_payment_intent_id,
  amount: row.amount,
  currency: 'MAD',
  status: row.status,
  shares: row.shares,
  lastError: row.last_error,
});

export class PostgresPaymentStore implements PaymentStore {
  constructor(
    private readonly sql: Sql,
    /** Wakes the outbox relay after a commit. */
    private readonly onCommit: () => void = () => undefined,
  ) {}

  async requestPayment(command: Envelope<'payments.request-payment'>, intentId: string) {
    const { orderId, buyerId, amount, shares } = command.payload;
    await this.sql.begin(async (tx) => {
      if (!(await markProcessed(tx, COMMANDS_CONSUMER, command.id))) return;
      await tx`
        insert into payments (id, order_id, buyer_id, stripe_payment_intent_id, amount, status, shares)
        values (${uuidv7()}, ${orderId}, ${buyerId}, ${intentId}, ${amount}, 'REQUIRES_PAYMENT',
                ${tx.json(shares)})
        on conflict (order_id) do nothing`;
    });
  }

  async markHandled(command: Envelope): Promise<boolean> {
    return this.sql.begin((tx) => markProcessed(tx, COMMANDS_CONSUMER, command.id));
  }

  async findByOrder(orderId: string): Promise<Payment | null> {
    const [row] = await this.sql<PaymentRow[]>`select * from payments where order_id = ${orderId}`;
    return row ? toPayment(row) : null;
  }

  async findByIntent(intentId: string): Promise<Payment | null> {
    const [row] = await this.sql<PaymentRow[]>`
      select * from payments where stripe_payment_intent_id = ${intentId}`;
    return row ? toPayment(row) : null;
  }

  async applyEvent(
    event: WebhookEvent,
    checked: { amountReceived: number; currency: string } | null,
  ): Promise<WebhookOutcome> {
    if (event.intentId === null) return 'ignored';
    const intentId = event.intentId;
    const outcome = await this.sql.begin(async (tx): Promise<WebhookOutcome> => {
      const recorded = await tx`
        insert into stripe_events (id, type) values (${event.id}, ${event.type})
        on conflict do nothing returning id`;
      if (recorded.length === 0) return 'duplicate';
      const [row] = await tx<PaymentRow[]>`
        select * from payments where stripe_payment_intent_id = ${intentId} for update`;
      // An event about an intent this service did not create (another integration): ignored.
      if (!row) return 'ignored';
      const payment = toPayment(row);
      const decision = decide(payment, event, checked);
      if (decision.kind === 'ignore') return 'ignored';
      if (decision.kind === 'error') {
        await tx`
          update payments set last_error = ${decision.message}, updated_at = now()
          where id = ${payment.id}`;
        return 'ignored';
      }
      await tx`
        update payments set status = ${decision.status}, last_error = null, updated_at = now()
        where id = ${payment.id}`;
      for (const entry of decision.entries) {
        await tx`
          insert into ledger_entries (id, payment_id, order_id, shop_id, kind, amount)
          values (${uuidv7()}, ${payment.id}, ${payment.orderId}, ${entry.shopId}, ${entry.kind},
                  ${entry.amount})`;
      }
      await enqueue(
        tx,
        createEnvelope(decision.message.type, decision.message.payload as never, {
          correlationId: payment.orderId,
        }),
      );
      return 'applied';
    });
    if (outcome === 'applied') this.onCommit();
    return outcome;
  }

  async balanceOf(shopId: string, since: Date): Promise<Balance> {
    const entries = await this.sql<{ kind: EntryKind; amount: number }[]>`
      select kind, sum(amount)::bigint as amount from ledger_entries
      where shop_id = ${shopId} and created_at >= ${since}
      group by kind`;
    return balanceOf(entries);
  }
}
