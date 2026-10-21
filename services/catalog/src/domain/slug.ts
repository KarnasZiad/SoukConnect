/**
 * URL slug from a title: accents removed, lower case, words joined by dashes. Arabic-only titles
 * have no Latin letters: they fall back to `fallback`, and the identifier suffix keeps the slug
 * unique.
 */
export function slugify(text: string, fallback = 'piece', maxLength = 60): string {
  const slug = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug === '' ? fallback : slug;
}

/** The last characters of a UUID v7 are random: a short, collision-resistant suffix. */
export function withSuffix(slug: string, id: string, length = 6): string {
  return `${slug}-${id.replaceAll('-', '').slice(-length)}`;
}
