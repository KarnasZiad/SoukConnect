import { formatMoney, type Locale } from '@soukconnect/contracts';
import type { NotificationType } from '../domain/model.js';

export interface Email {
  subject: string;
  text: string;
}

type Mailable = Extract<NotificationType, 'order-confirmed' | 'order-to-prepare' | 'order-shipped'>;

export function isMailable(type: NotificationType): type is Mailable {
  return type === 'order-confirmed' || type === 'order-to-prepare' || type === 'order-shipped';
}

interface Context {
  name: string;
  /** The first characters of the order identifier: what people read on a parcel or a call. */
  reference: string;
  link: string;
  total?: number;
  trackingNumber?: string | null;
}

const TEMPLATES: Record<Locale, Record<Mailable, (context: Context) => Email>> = {
  fr: {
    'order-confirmed': (c) => ({
      subject: `Commande ${c.reference} confirmée`,
      text: `Bonjour ${c.name},\n\nVotre paiement de ${formatMoney(c.total ?? 0, 'fr')} est confirmé. Les artisans préparent vos pièces.\n\nSuivre la commande : ${c.link}\n\nSoukConnect`,
    }),
    'order-to-prepare': (c) => ({
      subject: `Nouvelle commande à préparer (${c.reference})`,
      text: `Bonjour ${c.name},\n\nUne commande payée vous attend. Préparez les pièces, puis indiquez le numéro de suivi.\n\n${c.link}\n\nSoukConnect`,
    }),
    'order-shipped': (c) => ({
      subject: `Commande ${c.reference} expédiée`,
      text: `Bonjour ${c.name},\n\nUne partie de votre commande est en route${c.trackingNumber ? ` (suivi : ${c.trackingNumber})` : ''}.\n\n${c.link}\n\nSoukConnect`,
    }),
  },
  en: {
    'order-confirmed': (c) => ({
      subject: `Order ${c.reference} confirmed`,
      text: `Hello ${c.name},\n\nYour payment of ${formatMoney(c.total ?? 0, 'en')} is confirmed. The craftspeople are preparing your pieces.\n\nTrack your order: ${c.link}\n\nSoukConnect`,
    }),
    'order-to-prepare': (c) => ({
      subject: `New order to prepare (${c.reference})`,
      text: `Hello ${c.name},\n\nA paid order is waiting. Prepare the pieces, then enter the tracking number.\n\n${c.link}\n\nSoukConnect`,
    }),
    'order-shipped': (c) => ({
      subject: `Order ${c.reference} shipped`,
      text: `Hello ${c.name},\n\nPart of your order is on its way${c.trackingNumber ? ` (tracking: ${c.trackingNumber})` : ''}.\n\n${c.link}\n\nSoukConnect`,
    }),
  },
  ar: {
    'order-confirmed': (c) => ({
      subject: `تم تأكيد الطلب ${c.reference}`,
      text: `مرحبا ${c.name}،\n\nتم تأكيد دفعتك بمبلغ ${formatMoney(c.total ?? 0, 'ar')}. الحرفيون يجهزون قطعك.\n\nتتبع الطلب: ${c.link}\n\nسوق كونكت`,
    }),
    'order-to-prepare': (c) => ({
      subject: `طلب جديد للتجهيز (${c.reference})`,
      text: `مرحبا ${c.name}،\n\nطلب مدفوع في انتظارك. جهز القطع ثم أدخل رقم التتبع.\n\n${c.link}\n\nسوق كونكت`,
    }),
    'order-shipped': (c) => ({
      subject: `تم شحن الطلب ${c.reference}`,
      text: `مرحبا ${c.name}،\n\nجزء من طلبك في الطريق${c.trackingNumber ? ` (رقم التتبع: ${c.trackingNumber})` : ''}.\n\n${c.link}\n\nسوق كونكت`,
    }),
  },
};

export function render(type: Mailable, locale: Locale, context: Context): Email {
  return TEMPLATES[locale][type](context);
}

/** Where the e-mail leads: the order page for the buyer, the seller space for the shop. */
export function linkFor(
  type: Mailable,
  publicUrl: string,
  locale: Locale,
  orderId: string,
): string {
  const path = type === 'order-to-prepare' ? 'seller/orders' : `orders/${orderId}`;
  return `${publicUrl}/${locale}/${path}`;
}
