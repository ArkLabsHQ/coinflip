/**
 * Which skin to show — pure, so the migration path is testable.
 *
 * This lives outside `index.ts` for the same reason `ladder.ts` does: `index.ts`
 * imports the skin `.vue` components, and `vitest.config.ts` registers no Vue
 * plugin, so anything reaching it cannot be unit tested.
 *
 * The behaviour that needed pinning: retiring the 'coin' skin left every player
 * who had it selected holding a stored id that no longer resolves. They must
 * land on the current default rather than on a blank or broken selector.
 */

/**
 * Resolve a stored skin id against the ids that currently exist.
 *
 * Returns `fallbackId` when `saved` is absent or names a skin that no longer
 * exists — a retired skin, or a value written by a newer build.
 */
export function resolveSkinId(
  saved: string | null | undefined,
  validIds: readonly string[],
  fallbackId: string,
): string {
  if (saved && validIds.includes(saved)) return saved
  return fallbackId
}
