import type { Show } from './types';

/**
 * Normalizes a title for deduplication purposes only (case/punctuation
 * insensitive). Keep this aligned with Oracle's and DatabaseManager's own
 * normalizeTitle()/normalizeShowTitle() - all three exist because this file,
 * Oracle, and the DB layer are intentionally decoupled, but the algorithm
 * itself must stay identical or exact-match lookups will silently miss.
 */
function normalizeForDedupe(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[._]+/g, ' ')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function uniqueTitles(titles: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();

  return titles.filter((title): title is string => {
    if (!title?.trim()) return false;

    const normalized = normalizeForDedupe(title);

    if (!normalized || seen.has(normalized)) return false;

    seen.add(normalized);
    return true;
  });
}

/**
 * Metadata varies by provider. This reads likely title arrays/fields without
 * depending on any provider-specific response type. Mirrors Oracle's own
 * extractTitlesFromObject() - see the note on normalizeForDedupe() above for
 * why this isn't just imported from Oracle directly.
 */
function extractTitlesFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string[] {
  if (!metadata) return [];

  const values: string[] = [];

  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) {
      values.push(value);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          collect(item);
        } else if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          collect(record.name);
          collect(record.title);
          collect(record.value);
        }
      }
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const nestedValue of Object.values(value)) {
        if (typeof nestedValue === 'string') {
          collect(nestedValue);
        }
      }
    }
  };

  collect(metadata.aliases);
  collect(metadata.alias);
  collect(metadata.alternateTitles);
  collect(metadata.alternate_titles);
  collect(metadata.translations);
  collect(metadata.titles);
  collect(metadata.nameTranslations);
  collect(metadata.name_translations);

  return uniqueTitles(values);
}

/**
 * Every title variant a provider knows about for a show: canonical title,
 * original/native title, romanized title, aliases, alternate titles,
 * translations, and anything recoverable from raw provider metadata.
 *
 * Used both by Oracle (to match filenames against a provider's search
 * results) and by the DB layer (to index all of a show's known names into
 * `show_titles` so a *future* file for the same show hits the fast exact
 * SQL lookup instead of falling through to the slower fuzzy-match pass over
 * the whole local library every single time).
 */
export function extractShowTitleCandidates(
  show: Partial<Show> & Record<string, unknown>,
): string[] {
  const translations = Object.values(
    (show.translations as Record<string, string> | undefined) ?? {},
  );

  return uniqueTitles([
    show.title,
    show.originalTitle,
    show.romanizedTitle,
    ...((show.aliases as string[] | undefined) ?? []),
    ...((show.alternateTitles as string[] | undefined) ?? []),
    ...translations,
    ...extractTitlesFromMetadata(
      show.metadata as Record<string, unknown> | undefined,
    ),
  ]);
}
