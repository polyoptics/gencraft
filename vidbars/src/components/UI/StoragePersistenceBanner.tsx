/**
 * StoragePersistenceBanner — tells the artist when saving has genuinely
 * stopped working, and stays out of the way otherwise.
 *
 * Every persisted store saves through `createDebouncedIDBStorage`, which
 * retries a failed write once before reporting it, and reports every
 * successful write too. The banner keeps a per-store list of what is
 * currently failing:
 *   - `storage-write-failed` (after the retry) adds that store;
 *   - `storage-write-ok` removes it again.
 * So a passing hiccup never shows, and the banner clears by itself as soon
 * as the store saves again. It used to latch on the first failure and stay
 * red until reload, even when the very next save went through.
 *
 * It also asks the browser how full its storage is (navigator.storage
 * .estimate, which covers IndexedDB) and warns only past 90%. The old probe
 * measured localStorage, which nothing saves to any more, and wrote up to
 * 10 MB on every launch to do it.
 */
import React, { useEffect, useState } from 'react'
import {
  STORAGE_WRITE_FAILED,
  STORAGE_WRITE_OK,
  type StorageWriteFailedDetail,
  type StorageWriteOkDetail,
} from '../../utils/debouncedJSONStorage'

/** Plain names for the persisted stores, in the artist's terms. */
const STORE_LABELS: Record<string, string> = {
  'vidbars-boards': 'boards',
  'vidbars-canvas': 'canvas layout',
  'vidbars-freenodes': 'canvas items',
  'vidbars-history': 'history',
  'vidbars-text-versions': 'text versions',
  'vidbars-viewports3d': '3D viewports',
  'vidbars-model-posters': 'model previews',
  'vidbars-media': 'images and media',
}
const labelFor = (key: string) => STORE_LABELS[key] ?? key

const NEARLY_FULL_RATIO = 0.9

const fmtMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(1) + ' MB'
const fmtSize = (bytes: number) =>
  bytes >= 1024 ** 3 ? (bytes / 1024 ** 3).toFixed(1) + ' GB' : fmtMB(bytes)

function listLabels(keys: string[]): string {
  const labels = keys.map(labelFor)
  if (labels.length <= 1) return labels[0] ?? ''
  return labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1]
}

/** Identity of what is showing, so dismissing it does not hide a NEW,
 *  different problem. Keyed by store + error, not by timestamp: the same
 *  store failing the same way on every edit is one problem, not many. */
function failureSignature(failures: Record<string, StorageWriteFailedDetail>): string {
  return Object.values(failures)
    .map(d => `${d.key}:${d.errorName}`)
    .sort()
    .join('|')
}

export const StoragePersistenceBanner: React.FC = () => {
  const [failures, setFailures] = useState<Record<string, StorageWriteFailedDetail>>({})
  const [nearlyFull, setNearlyFull] = useState<{ usage: number; quota: number } | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [showDetails, setShowDetails] = useState(false)

  useEffect(() => {
    let cancelled = false
    navigator.storage?.estimate?.()
      .then(({ usage, quota }) => {
        if (cancelled || !usage || !quota) return
        if (usage / quota >= NEARLY_FULL_RATIO) setNearlyFull({ usage, quota })
      })
      .catch(() => { /* no estimate available: nothing to warn about */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const onFail = (e: Event) => {
      const detail = (e as CustomEvent<StorageWriteFailedDetail>).detail
      setFailures(f => ({ ...f, [detail.key]: detail }))
    }
    const onOk = (e: Event) => {
      const { key } = (e as CustomEvent<StorageWriteOkDetail>).detail
      setFailures(f => {
        if (!(key in f)) return f
        const next = { ...f }
        delete next[key]
        return next
      })
    }
    window.addEventListener(STORAGE_WRITE_FAILED, onFail)
    window.addEventListener(STORAGE_WRITE_OK, onOk)
    return () => {
      window.removeEventListener(STORAGE_WRITE_FAILED, onFail)
      window.removeEventListener(STORAGE_WRITE_OK, onOk)
    }
  }, [])

  const failing = Object.keys(failures)
  const isFailure = failing.length > 0
  if (!isFailure && !nearlyFull) return null
  const signature = isFailure ? failureSignature(failures) : 'nearly-full'
  if (dismissed === signature) return null

  const headline = isFailure
    ? "Some changes aren't saving right now"
    : 'Storage is nearly full'

  const body = isFailure ? (
    <div style={{ fontSize: 11, opacity: 0.9 }}>
      Your work is still here, and VidBars keeps trying to save your {listLabels(failing)}.
      Until this clears, reloading could bring back an older version. To be safe,
      use Backup → Export project to file.
    </div>
  ) : (
    <div style={{ fontSize: 11, opacity: 0.9 }}>
      VidBars is using {fmtSize(nearlyFull!.usage)} of the {fmtSize(nearlyFull!.quota)} this
      device allows. Saving still works. Exporting a backup (Backup → Export project to file)
      keeps your work safe if space runs out.
    </div>
  )

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        // In normal flex flow at the top of the App column — pushes the
        // toolbar (and everything below) down rather than overlapping it.
        position: 'sticky',
        top: 0,
        zIndex: 99999,
        background: isFailure ? 'rgba(120, 72, 28, 0.97)' : 'rgba(64, 60, 40, 0.97)',
        borderBottom: '1px solid rgba(255, 200, 120, 0.35)',
        color: '#fff',
        padding: '7px 14px',
        fontFamily: 'inherit',
        fontSize: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        userSelect: 'text',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 12.5 }}>{headline}</div>
          {body}
          {isFailure && (
            <button
              onClick={() => setShowDetails(s => !s)}
              style={{
                marginTop: 3, padding: 0, background: 'none', border: 'none',
                color: 'rgba(255,255,255,0.7)', fontSize: 10.5, cursor: 'pointer',
                textDecoration: 'underline', fontFamily: 'inherit',
              }}
            >
              {showDetails ? 'Hide details' : 'Details'}
            </button>
          )}
          {isFailure && showDetails && (
            <div style={{ fontSize: 10.5, opacity: 0.8, marginTop: 2, fontFamily: 'monospace' }}>
              {Object.values(failures).map(d => (
                <div key={d.key}>
                  {d.key}: {d.errorName}: {d.errorMessage}
                  {d.payloadBytes > 0 ? ` (${fmtMB(d.payloadBytes)})` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
        {/* Dismissing hides THIS report; a different store or error
            raises it again, and it clears itself once saving recovers. */}
        <button
          onClick={() => setDismissed(signature)}
          title="Hide — it comes back if something new goes wrong"
          style={{
            flexShrink: 0, background: 'rgba(0,0,0,0.18)',
            border: '1px solid rgba(255,255,255,0.25)', borderRadius: 4,
            color: '#fff', fontSize: 13, lineHeight: 1,
            padding: '3px 8px', cursor: 'pointer', fontFamily: 'inherit',
          }}
        >×</button>
      </div>
    </div>
  )
}
