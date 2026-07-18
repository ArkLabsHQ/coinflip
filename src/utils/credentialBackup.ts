/**
 * Browser Credential Management API backup for the wallet secret.
 *
 * Progressive enhancement: `PasswordCredential` is Chromium-only and
 * secure-context-only (verified against MDN — experimental / "limited
 * availability"), so every entry point feature-detects and the UI hides its
 * buttons when unsupported. Saving the secret here lets the browser's password
 * manager (e.g. Google Password Manager) back it up + sync it across the user's
 * devices and offer one-tap import — IN ADDITION to the written recovery phrase,
 * never instead of it.
 *
 * The stored secret is exactly what restoreWallet() already accepts (the BIP39
 * phrase for new/imported-phrase wallets, else the legacy nsec/hex), so import is
 * a straight round-trip back through the existing recovery path — this module
 * knows nothing about key derivation.
 *
 * Zero-dependency-on-vuex (like mnemonic / reclaimBackoff) so it stays unit-
 * testable in isolation. Structural typing (not lib.dom's `PasswordCredential`
 * globals) keeps it compiling across TS `lib` configs where those types may be
 * absent or gated.
 */

/** Friendly label shown in the browser's credential picker (the `name` field). */
const CREDENTIAL_NAME = 'Coinflip Wallet'

interface PasswordCredentialInitLike {
  id: string
  password: string
  name?: string
}

interface PasswordCredentialLike {
  password?: string | null
}

type PasswordCredentialCtor = new (data: PasswordCredentialInitLike) => PasswordCredentialLike

interface CredentialsContainerLike {
  store(credential: PasswordCredentialLike): Promise<unknown>
  get(options: { password?: boolean; mediation?: string }): Promise<PasswordCredentialLike | null>
}

/**
 * True iff the browser exposes the password half of the Credential Management API
 * in a secure context — Chromium desktop/Android over HTTPS (or localhost). Every
 * UI entry point gates its button on this so unsupported browsers see nothing.
 *
 * Probes `typeof PasswordCredential === 'function'` (must be constructable) rather
 * than `'PasswordCredential' in window`, and confirms store/get are callable — so
 * a browser that half-defines the surface fails closed instead of throwing later.
 */
export function isCredentialBackupSupported(): boolean {
  if (typeof window === 'undefined' || window.isSecureContext !== true) return false
  const ctor = (window as unknown as { PasswordCredential?: unknown }).PasswordCredential
  const creds = (navigator as unknown as { credentials?: CredentialsContainerLike }).credentials
  return (
    typeof ctor === 'function' &&
    !!creds &&
    typeof creds.store === 'function' &&
    typeof creds.get === 'function'
  )
}

/**
 * Save the wallet secret to the browser's password manager, keyed by the wallet's
 * public key (so multiple wallets stay distinguishable in the picker). Resolves
 * true if the store call was accepted — the browser then shows its OWN save prompt,
 * so acceptance is not the same as the user having agreed to persist it. Resolves
 * false when unsupported. Rejects only on an unexpected store failure.
 */
export async function saveWalletToBrowser(secret: string, id: string): Promise<boolean> {
  if (!isCredentialBackupSupported()) return false
  const Ctor = (window as unknown as { PasswordCredential: PasswordCredentialCtor }).PasswordCredential
  const credential = new Ctor({ id, password: secret, name: CREDENTIAL_NAME })
  await (navigator.credentials as unknown as CredentialsContainerLike).store(credential)
  return true
}

/**
 * Retrieve a previously-saved wallet secret via the browser's credential picker.
 * Returns the stored secret (mnemonic / nsec / hex — feed straight to
 * restoreWallet), or null when unsupported, nothing is stored, or the user
 * dismissed the picker (get() resolves null in all three cases per MDN).
 */
export async function importWalletFromBrowser(): Promise<string | null> {
  if (!isCredentialBackupSupported()) return null
  const credential = await (navigator.credentials as unknown as CredentialsContainerLike).get({
    password: true,
    mediation: 'optional',
  })
  return credential?.password ?? null
}
