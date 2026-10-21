import { describe, expect, it } from 'vitest';
import { ATTRIBUTES, categorized, CATEGORIES, MATERIALS } from './catalog.js';

describe('catalog attributes', () => {
  it('validates the attributes of a rug', () => {
    expect(
      categorized.parse({
        category: 'rug',
        attributes: { widthCm: 200, lengthCm: 300, material: 'wool', style: 'beni-ouarain' },
      }),
    ).toEqual({
      category: 'rug',
      attributes: { widthCm: 200, lengthCm: 300, material: 'wool', style: 'beni-ouarain' },
    });
  });

  it('refuses the attributes of another category, unknown values and impossible sizes', () => {
    expect(
      categorized.safeParse({
        category: 'pottery',
        attributes: { widthCm: 200, lengthCm: 300, material: 'wool', style: 'kilim' },
      }).success,
    ).toBe(false);
    expect(
      categorized.safeParse({
        category: 'leather',
        attributes: { item: 'bag', material: 'plastic', color: 'brown' },
      }).success,
    ).toBe(false);
    expect(
      ATTRIBUTES.rug.safeParse({ widthCm: 0, lengthCm: 300, material: 'wool', style: 'kilim' })
        .success,
    ).toBe(false);
    expect(categorized.safeParse({ category: 'furniture', attributes: {} }).success).toBe(false);
  });

  it('gives every category a main material, and lists them for the search facet', () => {
    for (const category of CATEGORIES) {
      expect(ATTRIBUTES[category].shape.material.options.length).toBeGreaterThan(0);
    }
    expect(MATERIALS).toContain('wool');
    expect(MATERIALS).toContain('thuya');
    expect(new Set(MATERIALS).size).toBe(MATERIALS.length);
  });
});
