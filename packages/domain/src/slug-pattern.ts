/**
 * Converts a slug glob pattern (e.g. "bitcoin-above-*") to an anchored RegExp.
 *
 * Supported glob syntax:
 *  - `*`  → matches any sequence of characters (including empty)
 *  - `?`  → matches exactly one character
 *  - All other characters are regex-escaped (literal match)
 *
 * The resulting regex is anchored (^...$) and case-insensitive.
 */
export function slugPatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withWildcards = escaped
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${withWildcards}$`, "i");
}
