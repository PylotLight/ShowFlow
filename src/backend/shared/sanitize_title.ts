/**
 * Sanitize a title (show or movie) for use as a filesystem folder or file
 * name component. This is the single source of truth shared by the blackhole
 * client, library scanner, shows route and Oracle so the folder a show is
 * written to always matches the folder a grab is filed under.
 *
 * Colons are replaced with a space, NOT stripped. A literal ':' is illegal on
 * macOS/APFS and in SMB, so Samba exposes the folder via an 8.3 mangled name
 * (e.g. "REJ1JG~5") to Mac Finder; a space keeps the folder legal and
 * readable while matching the naming engine's default 'smart' colon
 * replacement, so the folder name and the episode filenames agree.
 */
export function sanitizeTitle(title: string): string {
  return (title || '')
    .replace(/[<>":/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
