import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { timestampOf, uuidv7 } from './ids.js';

describe('uuidv7', () => {
  it('produces RFC 9562 version 7 identifiers', () => {
    const id = uuidv7();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(z.uuid().safeParse(id).success).toBe(true);
  });

  it('encodes its creation time, so identifiers sort by time', () => {
    const earlier = uuidv7(Date.UTC(2026, 9, 21, 8, 0, 0));
    const later = uuidv7(Date.UTC(2026, 9, 21, 8, 0, 1));

    expect(timestampOf(earlier)).toBe(Date.UTC(2026, 9, 21, 8, 0, 0));
    expect(earlier < later).toBe(true);
  });

  it('keeps the creation order within the same millisecond', () => {
    const now = Date.now();
    const ids = Array.from({ length: 1000 }, () => uuidv7(now));

    expect(new Set(ids).size).toBe(1000);
    expect([...ids].sort()).toEqual(ids);
    expect(ids.every((id) => timestampOf(id) === now)).toBe(true);
  });

  it('stays unique past 4096 identifiers in one millisecond', () => {
    const now = Date.now() + 1000;
    const ids = Array.from({ length: 5000 }, () => uuidv7(now));
    expect(new Set(ids).size).toBe(5000);
  });
});
