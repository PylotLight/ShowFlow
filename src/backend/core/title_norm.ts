/**
 * Normalizes a show/release title for word matching: lowercase, apostrophes
 * dropped ("Grey's" -> "greys"), every other non-letter/digit run becomes a
 * single space. Release names never carry ":" "!" "?" "," "&" etc., so a
 * show title like "Dexter: Resurrection" must compare as
 * "dexter resurrection" or its words never match "Dexter.Resurrection...".
 */
export function normalizeTitleForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
