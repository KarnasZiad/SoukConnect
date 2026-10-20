import { z } from 'zod';

export const LOCALES = ['fr', 'en', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'fr';

/** Order in which a missing translation falls back: the sellers write in French first. */
const FALLBACK: readonly Locale[] = ['fr', 'en', 'ar'];

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale === value);
}

export function directionOf(locale: Locale): 'ltr' | 'rtl' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

export type LocalizedText = Partial<Record<Locale, string>>;

/** Text written by a seller in one or more languages; at least one is required. */
export function localizedText(maxLength: number) {
  const entry = z.string().trim().min(1).max(maxLength).optional();
  return z
    .object({ fr: entry, en: entry, ar: entry })
    .refine((text) => LOCALES.some((locale) => text[locale] !== undefined), {
      message: 'At least one language is required',
    });
}

/**
 * The text in the requested language, or the first available one. `translated` tells the
 * interface to show a "not translated" notice (US-01).
 */
export function pickText(
  text: LocalizedText,
  locale: Locale,
): { value: string; locale: Locale; translated: boolean } {
  const requested = text[locale];
  if (requested !== undefined) return { value: requested, locale, translated: true };
  for (const fallback of FALLBACK) {
    const value = text[fallback];
    if (value !== undefined) return { value, locale: fallback, translated: false };
  }
  return { value: '', locale, translated: false };
}
