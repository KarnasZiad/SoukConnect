import {
  amount,
  CATEGORIES,
  categorized,
  CITIES,
  type Categorized,
  type City,
  localizedText,
  type LocalizedText,
  type ProductStatus,
  type ShopStatus,
} from '@soukconnect/contracts';
import { z } from 'zod';

export const MAX_IMAGES = 8;

export interface Image {
  url: string;
  alt?: LocalizedText;
}

export type Product = Categorized & {
  id: string;
  shopId: string;
  slug: string;
  title: LocalizedText;
  description: LocalizedText;
  /** Centimes of dirham. */
  price: number;
  currency: 'MAD';
  stock: number;
  /** Units sold, for the statistics of the seller. */
  sold: number;
  images: Image[];
  status: ProductStatus;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
};

export interface Shop {
  /** Identifier of the seller's account: one shop per seller. */
  id: string;
  slug: string;
  name: string;
  city: City;
  description: LocalizedText;
  status: ShopStatus;
  commissionBps: number;
  createdAt: Date;
  updatedAt: Date;
}

/** HTTPS images on the hosts of the CDN only: the front never loads a picture from elsewhere. */
export function imageSchema(allowedHosts: readonly string[]) {
  return z.object({
    url: z
      .url({ protocol: /^https$/, hostname: z.regexes.domain })
      .max(500)
      .refine((url) => allowedHosts.includes(new URL(url).hostname), {
        message: 'Images must be served by the CDN of the platform',
      }),
    alt: localizedText(200).optional(),
  });
}

const productFields = (allowedHosts: readonly string[]) => ({
  title: localizedText(200),
  description: localizedText(5000),
  price: amount.min(100),
  stock: z.int().min(0).max(10_000),
  images: z.array(imageSchema(allowedHosts)).max(MAX_IMAGES),
});

/** What a seller writes: the price is in centimes, at least one dirham. */
export function productInputSchema(allowedHosts: readonly string[]) {
  return z.object(productFields(allowedHosts)).and(categorized);
}
export type ProductInput = z.infer<ReturnType<typeof productInputSchema>>;

/** A partial update; the result is validated again as a whole (category and attributes together). */
export function productPatchSchema(allowedHosts: readonly string[]) {
  return z
    .object({
      ...productFields(allowedHosts),
      category: z.enum(CATEGORIES),
      attributes: z.record(z.string(), z.unknown()),
    })
    .partial()
    .strict();
}

export const shopInputSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    city: z.enum(CITIES),
    description: localizedText(2000),
  })
  .strict();
export type ShopInput = z.infer<typeof shopInputSchema>;
