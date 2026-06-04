/**
 * Pure transform behind the esplora-URL migration (consumed by
 * `migrateCachedEsploraUrl` in the ark store).
 *
 * The denigiri arkade-regtest stack serves the Esplora REST API under the
 * mempool service's `/api` prefix on :3000 — the bare `http://<host>:3000`
 * root is the mempool web UI (HTML). A browser that cached the pre-denigiri
 * bare URL would point the SDK's esplora calls at HTML and fail to parse.
 *
 * Returns the corrected URL when `cached` matches the known-bad shape
 * (a bare `http(s)://<host>:3000` with no path, optional trailing slash);
 * otherwise returns the input UNCHANGED. Deliberately narrow: it must not
 * touch a manually-customised esplora, a mutinynet URL, or an already-`/api`
 * value.
 */
export function upgradeEsploraUrl(cached: string | null): string | null {
  if (!cached) return cached
  if (/^https?:\/\/[^/]+:3000\/?$/.test(cached)) {
    return cached.replace(/\/?$/, '') + '/api'
  }
  return cached
}
