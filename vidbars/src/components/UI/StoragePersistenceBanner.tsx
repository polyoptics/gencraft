/**
 * StoragePersistenceBanner — surfaces localStorage write failures so they
 * stop being silent.
 *
 * Background: every Zustand store in this app persists via
 * `createDebouncedJSONStorage`, which used to swallow `setItem` errors
 * silently. localStorage in browser/Electron has a hard quota (5–10 MB
 * total across all keys; in this app we've measured ~50 MB before
 * QuotaExceededError fires). Once the quota is hit, every save fails on
 * the floor and the app appears to "lose" recent edits because every
 * reload rehydrates the last successful write — which can be days old.
 *
 * This banner does two things:
 *   1. Listens for the `storage-write-failed` window event dispatched by
 *      `debouncedJSONStorage` and displays a sticky red bar describing
 *      the most recent failure. Stays until reload (intentionally
 *      non-dismissible — losing edits is not something to dismiss).
 *   2. Runs a lightweight quota probe at mount (a small write +
 *      remove) so we surface the problem BEFORE the user makes edits
 *      that would silently fail.
 *
 * The actual fix (moving persistence to IndexedDB, slimming the
 * payload) is separate — this is the diagnostic layer that makes the
 * problem visible.
 */
import React, { useEffect, useState } from 'react'
import type { StorageWriteFailedDetail } from '../../utils/debouncedJSONStorage'

type Status =
  | { kind: 'ok' }
  | { kind: 'quota-warning'; usedBytes: number; ceilingBytes: number }
  | { kind: 'write-failed'; detail: StorageWriteFailedDetail }

function totalLocalStorageBytes(): number {
  if (typeof localStorage === 'undefined') return 0
  let total = 0
  try {
    for (const k of Object.keys(localStorage)) {
      total += k.length + (localStorage.getItem(k)?.length ?? 0)
    }
  } catch { /* ignore */ }
  return total
}

/** Probe how much headroom localStorage has. Writes incrementally larger
 *  test payloads and finds the first size that throws. Returns the
 *  estimated ceiling in bytes. */
function probeQuotaCeiling(): { used: number; ceiling: number } {
  const used = totalLocalStorageBytes()
  // Test sizes (in MB) to probe headroom. Stop at first failure.
  const probes = [0.5, 1, 2, 5, 10]
  let lastSuccess = used
  const probeKey = '__quota_probe_banner'
  try { localStorage.removeItem(probeKey) } catch { /* ignore */ }
  for (const mb of probes) {
    const payload = 'x'.repeat(Math.floor(mb * 1024 * 1024))
    try {
      localStorage.setItem(probeKey, payload)
      lastSuccess = used + payload.length
      try { localStorage.removeItem(probeKey) } catch { /* ignore */ }
    } catch {
      try { localStorage.removeItem(probeKey) } catch { /* ignore */ }
      // Ceiling is between `lastSuccess` and `used + payload.length`.
      // Use `lastSuccess` as the conservative lower bound for the ceiling.
      return { used, ceiling: lastSuccess }
    }
  }
  // We could write all probes successfully → plenty of headroom.
  return { used, ceiling: used + probes[probes.length - 1] * 1024 * 1024 }
}

const fmtMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(1) + ' MB'

export const StoragePersistenceBanner: React.FC = () => {
  const [status, setStatus] = useState<Status>({ kind: 'ok' })

  // Initial probe — runs once on mount.
  useEffect(() => {
    const { used, ceiling } = probeQuotaCeiling()
    // If the available headroom is under 5 MB, warn proactively. This
    // catches the "you're going to start losing edits soon" case before
    // any actual write fails. 5 MB is the threshold because a single
    // store rewrite (which Zustand triggers on every set) carries the
    // full ~30 MB current state — but Chromium does in-place rewrites
    // so what matters is the GROWTH headroom, and even small edits
    // (one bar add, one image transform) can push the JSON up by
    // 100 KB+ at a time. Below 5 MB headroom is "you're going to start
    // losing saves any minute now."
    const headroom = ceiling - used
    if (headroom < 5 * 1024 * 1024) {
      setStatus({ kind: 'quota-warning', usedBytes: used, ceilingBytes: ceiling })
    }
  }, [])

  // Listen for actual write failures. These take priority over the
  // proactive warning since they represent a real lost-write event.
  useEffect(() => {
    const onFail = (e: Event) => {
      const detail = (e as CustomEvent<StorageWriteFailedDetail>).detail
      setStatus({ kind: 'write-failed', detail })
    }
    window.addEventListener('storage-write-failed', onFail as EventListener)
    return () => window.removeEventListener('storage-write-failed', onFail as EventListener)
  }, [])

  if (status.kind === 'ok') return null

  const isFailure = status.kind === 'write-failed'
  const bg = isFailure ? 'rgba(180, 30, 35, 0.96)' : 'rgba(170, 110, 30, 0.96)'
  const headline = isFailure
    ? 'Save FAILED — your recent edits did not persist'
    : 'Storage almost full — saves will start failing soon'

  let body: React.ReactNode
  if (status.kind === 'write-failed') {
    const d = status.detail
    body = (
      <>
        <div style={{ fontSize: 11, opacity: 0.92 }}>
          Tried to write <code>{d.key}</code> ({fmtMB(d.payloadBytes)}).{' '}
          {d.isQuotaExceeded
            ? `Browser quota exceeded — current localStorage usage ~${fmtMB(d.totalLocalStorageBytes)}.`
            : `${d.errorName}: ${d.errorMessage}`}
        </div>
        <div style={{ fontSize: 11, opacity: 0.92, marginTop: 2 }}>
          Reload the app and your work will revert to the last successful save (which may be old).
          To preserve current state: save a snapshot via Templates → Save now.
        </div>
      </>
    )
  } else {
    body = (
      <div style={{ fontSize: 11, opacity: 0.92 }}>
        Used <strong>{fmtMB(status.usedBytes)}</strong> of an estimated{' '}
        <strong>{fmtMB(status.ceilingBytes)}</strong> ceiling. Save a snapshot
        soon (Templates → Save) so you don't lose work when writes start
        failing.
      </div>
    )
  }

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        // In normal flex flow at the top of the App column — pushes the
        // toolbar (and everything below) down rather than overlapping
        // them. Sticky+top-0 so it stays visible if the host column
        // ever scrolls (currently the App fills the viewport so this
        // mostly behaves like a static block).
        position: 'sticky',
        top: 0,
        zIndex: 99999,
        background: bg,
        color: '#fff',
        padding: '8px 14px',
        fontFamily: 'inherit',
        fontSize: 12,
        boxShadow: '0 2px 12px rgba(0,0,0,0.6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        userSelect: 'text',
        flexShrink: 0,
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: '0.4px' }}>
        ⚠ {headline}
      </div>
      {body}
    </div>
  )
}
