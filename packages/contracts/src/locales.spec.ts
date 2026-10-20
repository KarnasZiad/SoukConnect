import { describe, expect, it } from 'vitest';
import { directionOf, isLocale, localizedText, pickText } from './locales.js';

describe('locales', () => {
  it('writes Arabic from right to left', () => {
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('fr')).toBe('ltr');
    expect(directionOf('en')).toBe('ltr');
  });

  it('recognizes the supported languages only', () => {
    expect(isLocale('ar')).toBe(true);
    expect(isLocale('es')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe('localizedText', () => {
  const title = localizedText(20);

  it('needs at least one language, trims and bounds each one', () => {
    expect(title.parse({ ar: '  زربية  ' })).toEqual({ ar: 'زربية' });
    expect(title.safeParse({}).success).toBe(false);
    expect(title.safeParse({ fr: '   ' }).success).toBe(false);
    expect(title.safeParse({ fr: 'x'.repeat(21) }).success).toBe(false);
  });
});

describe('pickText', () => {
  it('returns the requested language when it exists', () => {
    expect(pickText({ fr: 'Tapis', ar: 'زربية' }, 'ar')).toEqual({
      value: 'زربية',
      locale: 'ar',
      translated: true,
    });
  });

  it('falls back to French, then English, and says so', () => {
    expect(pickText({ en: 'Rug', fr: 'Tapis' }, 'ar')).toEqual({
      value: 'Tapis',
      locale: 'fr',
      translated: false,
    });
    expect(pickText({ en: 'Rug' }, 'fr')).toEqual({
      value: 'Rug',
      locale: 'en',
      translated: false,
    });
    expect(pickText({}, 'en')).toEqual({ value: '', locale: 'en', translated: false });
  });
});
