/**
 * Browser-persisted bet preferences: the stake amount and the odds-slider
 * position, so a returning player lands on the bet they last played instead of
 * the app's cold defaults. (The selected skin is persisted separately, by
 * `getSavedSkinId` / `saveSkinId` in `@/skins`.)
 *
 * These are RAW stored values — this module deliberately does no clamping. The
 * playable envelope (dust floor, house capacity, wallet balance) is only known
 * after `/api/tiers` lands and moves on every bet, and PlayView's watchers
 * already re-clamp both controls whenever it does. Restoring a value that no
 * longer fits is therefore safe: it gets pulled into range on the next tick.
 *
 * Every reader returns `null` rather than throwing or inventing a default, so
 * the caller keeps ownership of what "no preference yet" means. localStorage
 * can be absent, full, or hold garbage from an older build — none of that
 * should be able to break the play screen.
 */

const AMOUNT_KEY = 'coinflip.bet_amount'
const STEPS_KEY = 'coinflip.odds_steps'

/** A positive, finite, whole number of sats — anything else is treated as absent. */
function asSats(v: unknown): number | null {
  const n = Number(v)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** The last stake the player used, or null if none is stored / it's unusable. */
export function getSavedBetAmount(): number | null {
  try {
    return asSats(localStorage.getItem(AMOUNT_KEY))
  } catch {
    return null
  }
}

export function saveBetAmount(sats: number): void {
  try {
    if (asSats(sats) !== null) localStorage.setItem(AMOUNT_KEY, String(sats))
  } catch { /* private mode / quota — preferences are best-effort */ }
}

/** Read the whole `{ [skinId]: stepIndex }` map, tolerating any stored shape. */
function readSteps(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(STEPS_KEY) || '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

/**
 * The last odds-slider index for THIS skin, or null.
 *
 * Keyed per skin because an index is only meaningful against one skin's
 * ladder — step 3 of the coin ladder and step 3 of the roulette ladder are
 * entirely different bets, so a single shared integer would silently change
 * meaning every time the player switched games.
 */
export function getSavedStep(skinId: string): number | null {
  const v = Number(readSteps()[skinId])
  return Number.isSafeInteger(v) && v >= 0 ? v : null
}

export function saveStep(skinId: string, step: number): void {
  if (!skinId || !Number.isSafeInteger(step) || step < 0) return
  try {
    localStorage.setItem(STEPS_KEY, JSON.stringify({ ...readSteps(), [skinId]: step }))
  } catch { /* best-effort */ }
}
