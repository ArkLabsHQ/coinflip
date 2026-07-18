/**
 * Lightweight in-app diagnostics log — a ring buffer of recent errors/events the
 * user can copy and share when something goes wrong (game errors, settle/reclaim
 * failures, connection drops) that would otherwise flash by in a 3-second toast
 * and get cut off on a narrow screen.
 *
 * Zero-dependency + no Vuex, so it's importable from anywhere (utils, global
 * error handlers, main.ts) and unit-testable in isolation — same posture as
 * mnemonic / reclaimBackoff. A mirror is persisted to localStorage so a reload
 * (or re-opening the page just to copy the log) keeps the recent history.
 */

export type DiagLevel = 'error' | 'warn' | 'info'

export interface DiagEntry {
  /** epoch ms when logged */
  t: number
  level: DiagLevel
  /** short source tag, e.g. 'settle', 'flip', 'window' */
  tag: string
  msg: string
}

/** Keep the last N entries — enough to capture a session's failures, small
 *  enough to stay well under the localStorage quota. */
export const DIAG_CAP = 100
const STORE_KEY = 'coinflip_diag'
/** Cap a single message so one huge dump can't blow the quota or the buffer. */
const MSG_MAX = 2000

let entries: DiagEntry[] = load()

function load(): DiagEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]')
    return Array.isArray(raw) ? (raw as DiagEntry[]).slice(-DIAG_CAP) : []
  } catch {
    return []
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(entries))
  } catch {
    /* quota exceeded / private mode — the in-memory buffer still works */
  }
}

/** Append one diagnostics entry (trimmed to the last DIAG_CAP). Never throws. */
export function logDiag(level: DiagLevel, tag: string, msg: string): void {
  entries.push({ t: Date.now(), level, tag, msg: String(msg).slice(0, MSG_MAX) })
  if (entries.length > DIAG_CAP) entries = entries.slice(-DIAG_CAP)
  persist()
}

/** Snapshot of the current entries (oldest first). */
export function getDiagEntries(): DiagEntry[] {
  return entries.slice()
}

/** Clear the log (buffer + persisted mirror). */
export function clearDiag(): void {
  entries = []
  persist()
}

/**
 * A shareable plain-text blob: an optional header (app + environment supplied by
 * the caller, which has store/env access this pure module doesn't) followed by
 * every entry as `[iso-ts] LEVEL tag: msg`. Safe to paste into a chat/issue.
 */
export function formatDiagnostics(header: Record<string, string> = {}): string {
  const lines: string[] = ['=== coinflip diagnostics ===']
  for (const [k, v] of Object.entries(header)) lines.push(`${k}: ${v}`)
  lines.push(`entries: ${entries.length}`, '')
  for (const e of entries) {
    lines.push(`[${new Date(e.t).toISOString()}] ${e.level.toUpperCase()} ${e.tag}: ${e.msg}`)
  }
  return lines.join('\n')
}

/**
 * Hook `error` + `unhandledrejection` so uncaught failures are captured too, not
 * just the ones we explicitly log. Call once at app boot (main.ts). Idempotent —
 * a repeat call is a no-op so hot-reload / double-invoke doesn't double-log.
 */
let installed = false
export function installGlobalDiagnostics(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('error', (ev: ErrorEvent) => {
    logDiag('error', 'window', ev.message || String(ev.error || 'error'))
  })
  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    const r = ev.reason
    logDiag('error', 'promise', r instanceof Error ? r.message : String(r))
  })
}
