import type { Envelope } from '@soukconnect/contracts';
import type { Handler, Handlers, Logger, QueueSpec } from '@soukconnect/messaging';
import { plan } from '../domain/model.js';
import { isMailable, linkFor, render } from '../mail/templates.js';
import type { Mailer, NotificationStore, Push } from '../ports.js';

/** The facts people hear about: order outcomes and shipments. */
export const EVENTS: QueueSpec = {
  queue: 'notifications.events',
  bindings: [
    'orders.order-confirmed',
    'orders.order-rejected',
    'orders.order-cancelled',
    'orders.shipment-updated',
  ],
};

export interface EventDeps {
  store: NotificationStore;
  push: Push;
  mailer: Mailer;
  publicUrl: string;
  logger: Logger;
}

/**
 * For each event: record the notifications once (redeliveries find them), push them live, and send
 * the e-mails still owed. An e-mail failure throws, so the event is retried; the push is not
 * repeated, the e-mail is.
 */
export function eventHandlers(deps: EventDeps): Handlers {
  const handle = async (event: Envelope) => {
    for (const planned of plan(event)) {
      const { notification, created, emailed } = await deps.store.recordNotification(
        event.id,
        planned,
      );
      if (created) deps.push.toUser(planned.userId, 'notification', notification);
      if (!planned.email || emailed || !isMailable(planned.type)) continue;
      const contact = await deps.store.getContact(planned.userId);
      if (!contact) {
        deps.logger.warn({ userId: planned.userId, type: planned.type }, 'no contact to e-mail');
        continue;
      }
      await deps.mailer.send(
        contact.email,
        render(planned.type, contact.locale, {
          name: contact.displayName,
          reference: planned.orderId.slice(0, 8).toUpperCase(),
          link: linkFor(planned.type, deps.publicUrl, contact.locale, planned.orderId),
          total: typeof planned.data.total === 'number' ? planned.data.total : undefined,
          trackingNumber:
            typeof planned.data.trackingNumber === 'string' ? planned.data.trackingNumber : null,
        }),
      );
      await deps.store.markEmailed(notification.id);
    }
  };
  return Object.fromEntries(EVENTS.bindings.map((type) => [type, handle as Handler<typeof type>]));
}
