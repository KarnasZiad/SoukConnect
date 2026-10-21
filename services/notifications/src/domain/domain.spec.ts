import { createEnvelope } from '@soukconnect/contracts';
import { describe, expect, it } from 'vitest';
import {
  buyer,
  buyerId,
  orderId,
  otherBuyer,
  otherSeller,
  seller,
  sellerId,
} from '../../test/fakes.js';
import { linkFor, render } from '../mail/templates.js';
import { plan, recipientOf, sideOf } from './model.js';

const conversation = {
  id: '0199f0a4-7a5b-7c1e-9f00-0000000000f1',
  buyerId,
  shopId: sellerId,
  productId: null,
  createdAt: new Date(),
  lastMessageAt: null,
  unread: { buyer: 0, shop: 0 },
};

describe('conversation participants (I1)', () => {
  it('knows the side of each participant and refuses everyone else', () => {
    expect(sideOf(conversation, buyer)).toBe('buyer');
    expect(sideOf(conversation, seller)).toBe('shop');
    expect(sideOf(conversation, otherBuyer)).toBeNull();
    expect(sideOf(conversation, otherSeller)).toBeNull();
    expect(sideOf(conversation, { userId: null, role: 'visitor', shopId: null })).toBeNull();
    expect(recipientOf(conversation, 'buyer')).toBe(sellerId);
    expect(recipientOf(conversation, 'shop')).toBe(buyerId);
  });
});

describe('who hears about what (US-07)', () => {
  const event = <T extends Parameters<typeof createEnvelope>[0]>(
    type: T,
    payload: Parameters<typeof createEnvelope<T>>[1],
  ) => createEnvelope(type, payload, { correlationId: orderId });

  it('tells the buyer and every shop of a confirmed order, by e-mail too', () => {
    const shopB = '0199f0a4-7a5b-7c1e-9f00-0000000000c3';
    expect(
      plan(
        event('orders.order-confirmed', {
          orderId,
          buyerId,
          total: 500_000,
          currency: 'MAD',
          shopIds: [sellerId, shopB],
        }),
      ),
    ).toEqual([
      { userId: buyerId, type: 'order-confirmed', orderId, data: { total: 500_000 }, email: true },
      { userId: sellerId, type: 'order-to-prepare', orderId, data: {}, email: true },
      { userId: shopB, type: 'order-to-prepare', orderId, data: {}, email: true },
    ]);
  });

  it('tells the buyer of a shipment by e-mail, of a delivery in the app, and nothing while preparing', () => {
    const shipment = (status: 'PREPARING' | 'SHIPPED' | 'DELIVERED') =>
      plan(
        event('orders.shipment-updated', {
          orderId,
          buyerId,
          shopId: sellerId,
          status,
          trackingNumber: status === 'PREPARING' ? null : 'MA123',
        }),
      );

    expect(shipment('SHIPPED')).toEqual([
      {
        userId: buyerId,
        type: 'order-shipped',
        orderId,
        data: { shopId: sellerId, trackingNumber: 'MA123' },
        email: true,
      },
    ]);
    expect(shipment('DELIVERED')).toMatchObject([{ type: 'order-delivered', email: false }]);
    expect(shipment('PREPARING')).toEqual([]);
  });

  it('tells the buyer of a rejection or a cancellation in the app only', () => {
    expect(
      plan(event('orders.order-rejected', { orderId, buyerId, unavailable: [sellerId] })),
    ).toMatchObject([{ type: 'order-rejected', email: false, data: { unavailable: [sellerId] } }]);
    expect(
      plan(event('orders.order-cancelled', { orderId, buyerId, reason: 'PAYMENT_EXPIRED' })),
    ).toMatchObject([
      { type: 'order-cancelled', email: false, data: { reason: 'PAYMENT_EXPIRED' } },
    ]);
    expect(plan(event('catalog.commit-stock', { orderId }))).toEqual([]);
  });
});

describe('e-mails in three languages', () => {
  const context = {
    name: 'Amina',
    reference: '0199F0A4',
    link: 'https://soukconnect.ma/ar/orders/x',
    total: 125_000,
  };

  it('writes the confirmation in the language of the person', () => {
    expect(render('order-confirmed', 'fr', context).subject).toBe('Commande 0199F0A4 confirmée');
    expect(render('order-confirmed', 'fr', context).text.replace(/\s/g, ' ')).toContain(
      '1.250,00 MAD',
    );
    expect(render('order-confirmed', 'en', context).subject).toBe('Order 0199F0A4 confirmed');
    expect(render('order-confirmed', 'ar', context).subject).toContain('0199F0A4');
    expect(render('order-confirmed', 'ar', context).text).toContain('مرحبا Amina');
  });

  it('mentions the tracking number when there is one', () => {
    expect(render('order-shipped', 'en', { ...context, trackingNumber: 'MA123' }).text).toContain(
      'tracking: MA123',
    );
    expect(render('order-shipped', 'fr', { ...context, trackingNumber: null }).text).not.toContain(
      'suivi :',
    );
    expect(render('order-to-prepare', 'ar', context).subject).toContain('0199F0A4');
  });

  it('leads the buyer to the order and the seller to its space', () => {
    expect(linkFor('order-confirmed', 'https://soukconnect.ma', 'fr', orderId)).toBe(
      `https://soukconnect.ma/fr/orders/${orderId}`,
    );
    expect(linkFor('order-to-prepare', 'https://soukconnect.ma', 'ar', orderId)).toBe(
      'https://soukconnect.ma/ar/seller/orders',
    );
  });
});

describe('every e-mail in every language', () => {
  it.each(['fr', 'en', 'ar'] as const)(
    'renders the three e-mails in %s, with and without tracking',
    (locale) => {
      for (const type of ['order-confirmed', 'order-to-prepare', 'order-shipped'] as const) {
        for (const trackingNumber of ['MA123', null]) {
          const email = render(type, locale, {
            name: 'Amina',
            reference: 'REF12345',
            link: 'https://x',
            trackingNumber,
          });
          expect(email.subject).toContain('REF12345');
          expect(email.text).toContain('https://x');
          expect(email.text.includes('MA123')).toBe(
            type === 'order-shipped' && trackingNumber !== null,
          );
        }
      }
    },
  );
});
