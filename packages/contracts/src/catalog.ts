import { z } from 'zod';

/** Crafts sold on the platform; each one has its own attributes (ADR 0003). */
export const CATEGORIES = ['rug', 'pottery', 'leather', 'woodwork', 'metalwork'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Cities of the workshops, as slugs: facets and filters never take free text. */
export const CITIES = [
  'marrakech',
  'fes',
  'safi',
  'essaouira',
  'ouarzazate',
  'zagora',
  'taroudant',
  'meknes',
  'rabat',
  'sale',
  'casablanca',
  'tetouan',
  'chefchaouen',
  'tangier',
  'agadir',
] as const;
export type City = (typeof CITIES)[number];

const centimetres = (max: number) => z.int().min(1).max(max);

/** Attributes of each category, validated when a seller writes a product. */
export const ATTRIBUTES = {
  rug: z.object({
    widthCm: centimetres(1000),
    lengthCm: centimetres(2000),
    material: z.enum(['wool', 'cotton', 'silk', 'cactus-silk']),
    style: z.enum(['beni-ouarain', 'azilal', 'boucherouite', 'kilim', 'other']),
    knotsPerDm2: z.int().min(1).max(10_000).optional(),
  }),
  pottery: z.object({
    heightCm: centimetres(300),
    diameterCm: centimetres(300),
    material: z.enum(['terracotta', 'ceramic', 'zellige']),
    foodSafe: z.boolean(),
  }),
  leather: z.object({
    item: z.enum(['bag', 'babouche', 'pouf', 'belt', 'other']),
    material: z.enum(['goat', 'cow', 'camel', 'sheep']),
    color: z.string().trim().min(1).max(40),
    size: z.string().trim().min(1).max(20).optional(),
  }),
  woodwork: z.object({
    material: z.enum(['thuya', 'cedar', 'walnut', 'olive', 'other']),
    widthCm: centimetres(500),
    heightCm: centimetres(500).optional(),
    depthCm: centimetres(500).optional(),
  }),
  metalwork: z.object({
    material: z.enum(['copper', 'brass', 'iron', 'silver', 'other']),
    heightCm: centimetres(500),
    electrified: z.boolean(),
  }),
} as const satisfies Record<Category, z.ZodObject>;

export type Attributes<C extends Category = Category> = z.infer<(typeof ATTRIBUTES)[C]>;

/** Every material value, for the facet of the search: the main material of each category. */
export const MATERIALS = [
  ...new Set(CATEGORIES.flatMap((category) => ATTRIBUTES[category].shape.material.options)),
] as readonly string[];

/** A category and its attributes, validated together. */
export const categorized = z.discriminatedUnion('category', [
  z.object({ category: z.literal('rug'), attributes: ATTRIBUTES.rug }),
  z.object({ category: z.literal('pottery'), attributes: ATTRIBUTES.pottery }),
  z.object({ category: z.literal('leather'), attributes: ATTRIBUTES.leather }),
  z.object({ category: z.literal('woodwork'), attributes: ATTRIBUTES.woodwork }),
  z.object({ category: z.literal('metalwork'), attributes: ATTRIBUTES.metalwork }),
]);
export type Categorized = z.infer<typeof categorized>;
