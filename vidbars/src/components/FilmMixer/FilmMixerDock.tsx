import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'

/** The Film Look panel: the look mixer, docked to the right of the canvas.
 *
 *  It shows the mixer's own page, from the mixer's own server, so every shot,
 *  look, setup and bake is the mixer's and goes on working the same as it does
 *  from mixer.cmd. The page has its own origin, so it never reaches the desktop
 *  bridge, and its keys stay with it while it has the focus.
 *
 *  The dock sits beside the canvas host. The camera is anchored at the canvas's
 *  top left, so opening it covers the right side and moves nothing. */

const WIDTH_KEY = 'vidbars.filmMixerWidth'
// Under 900 px the mixer's page stacks into one long column.
const MIN_WIDTH = 920
const DEFAULT_WIDTH = 1040
const DEFAULT_URL = 'http://localhost:8766'

function readNumber(key: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(key))
    return Number.isFinite(n) && n > 0 ? n : fallback
  } catch { return fallback }
}
function remember(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* only a convenience */ }
}

// Closed at every launch: opening it starts the mixer, which takes GPU memory.
const useFilmMixerStore = create<{ open: boolean; toggle: () => void }>((set, get) => ({
  open: false,
  toggle: () => set({ open: !get().open }),
}))

export function FilmMixerToggleButton() {
  const open = useFilmMixerStore(s => s.open)
  const toggle = useFilmMixerStore(s => s.toggle)
  return (
    <button
      onClick={toggle}
      title={open ? 'Hide the Film Look mixer' : 'Film Look: every shot of the film and its look'}
      style={{
        height: 24,
        padding: '0 8px',
        display: 'flex', alignItems: 'center', gap: 5,
        background: open ? 'rgba(120,170,255,0.22)' : 'rgba(255,255,255,0.05)',
        border: open ? '1px solid rgba(120,170,255,0.5)' : '1px solid rgba(255,255,255,0.1)',
        borderRadius: 6,
        color: open ? '#a8c8ff' : 'rgba(255,255,255,0.6)',
        fontSize: 11, fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <span style={{ fontSize: 13 }}>🎞</span>
      Film Look
    </button>
  )
}

type Phase =
  | { kind: 'checking' }
  | { kind: 'starting' }
  | { kind: 'ready'; url: string }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: string; log?: string }
  | { kind: 'needsRestart' }

/** Is the server answering? In a window from before the mixer's bridge, or a
 *  plain browser, the page can only knock: an opaque answer still means up. */
async function probe(): Promise<{ running: boolean; url: string; canStart: boolean }> {
  const d = window.vidbarsDesktop
  if (d?.mixerStatus) {
    const s = await d.mixerStatus()
    return { running: s.running, url: s.url, canStart: true }
  }
  try {
    await fetch(`${DEFAULT_URL}/api/info`, { mode: 'no-cors', cache: 'no-store' })
    return { running: true, url: DEFAULT_URL, canStart: false }
  } catch {
    return { running: false, url: DEFAULT_URL, canStart: false }
  }
}

export function FilmMixerDock() {
  const open = useFilmMixerStore(s => s.open)
  return open ? <DockPanel /> : null
}

function DockPanel() {
  const toggle = useFilmMixerStore(s => s.toggle)
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' })
  const [width, setWidth] = useState(() => readNumber(WIDTH_KEY, DEFAULT_WIDTH))
  const [resizing, setResizing] = useState(false)
  const drag = useRef<{ x: number; width: number } | null>(null)

  const start = async () => {
    const d = window.vidbarsDesktop
    if (!d?.mixerStart) { setPhase({ kind: 'needsRestart' }); return }
    setPhase({ kind: 'starting' })
    const r = await d.mixerStart()
    setPhase(r.url ? { kind: 'ready', url: r.url } : { kind: 'failed', error: r.error ?? 'The mixer did not start', log: r.log })
  }

  // Opening the panel starts the mixer, or uses the one already running.
  useEffect(() => {
    let alive = true
    void probe().then(p => {
      if (!alive) return
      if (p.running) setPhase({ kind: 'ready', url: p.url })
      else if (p.canStart) void start()
      else setPhase({ kind: 'needsRestart' })
    })
    return () => { alive = false }
  }, [])

  // The mixer's own Quit button ends the server under the page. Say so, and
  // leave starting it again to a click: Quit means free the GPU.
  const ready = phase.kind === 'ready'
  useEffect(() => {
    if (!ready) return
    const t = setInterval(() => {
      void probe().then(p => { if (!p.running) setPhase({ kind: 'stopped' }) })
    }, 3000)
    return () => clearInterval(t)
  }, [ready])

  const clampWidth = (w: number) => Math.round(Math.max(MIN_WIDTH, Math.min(window.innerWidth - 120, w)))

  return (
    <div
      data-film-mixer-dock
      style={{
        // The window may be narrower than the width last used; the canvas
        // always keeps a strip to click on.
        width: clampWidth(width), flexShrink: 0, position: 'relative', zIndex: 950,
        display: 'flex', flexDirection: 'column',
        background: '#14151c', borderLeft: '1px solid rgba(255,255,255,0.12)',
      }}
    >
      {/* The grip captures the pointer, and the page ignores it while dragging,
          so a fast drag cannot be lost into the page. */}
      <div
        title="Drag to resize"
        onPointerDown={e => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, width: clampWidth(width) }
          setResizing(true)
        }}
        onPointerMove={e => {
          if (drag.current) setWidth(clampWidth(drag.current.width + drag.current.x - e.clientX))
        }}
        onPointerUp={e => {
          if (!drag.current) return
          remember(WIDTH_KEY, String(clampWidth(drag.current.width + drag.current.x - e.clientX)))
          drag.current = null
          setResizing(false)
        }}
        style={{ position: 'absolute', left: -4, top: 0, bottom: 0, width: 8, cursor: 'ew-resize', zIndex: 2 }}
      />
      <div style={{
        height: 26, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 6px 0 12px',
        background: '#080910', borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}>
        <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: 600 }}>Film Look</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={toggle}
          title="Hide the panel. The mixer keeps running; its Quit button frees the GPU."
          style={{
            background: 'none', border: 'none', color: 'rgba(255,255,255,0.55)',
            fontSize: 14, lineHeight: 1, padding: '2px 6px', cursor: 'pointer', fontFamily: 'inherit',
          }}
        >×</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {phase.kind === 'ready'
          ? <iframe
              src={phase.url}
              title="Film Look mixer"
              style={{ width: '100%', height: '100%', border: 'none', display: 'block', pointerEvents: resizing ? 'none' : 'auto' }}
            />
          : <PhaseMessage phase={phase} onStart={() => void start()} />}
      </div>
    </div>
  )
}

function PhaseMessage({ phase, onStart }: { phase: Phase; onStart: () => void }) {
  const text =
    phase.kind === 'checking' ? 'Looking for the mixer…'
    : phase.kind === 'starting' ? 'Starting the mixer. The first time takes a little while.'
    : phase.kind === 'stopped' ? 'The mixer has quit, and the GPU is free.'
    : phase.kind === 'needsRestart' ? 'Close VidBars and open it again once, so it can start the mixer here.'
    : phase.kind === 'failed' ? phase.error
    : ''
  return (
    <div style={{ padding: 24, color: 'rgba(255,255,255,0.7)', fontSize: 13, lineHeight: 1.5 }}>
      <div>{text}</div>
      {(phase.kind === 'stopped' || phase.kind === 'failed') && (
        <button
          onClick={onStart}
          style={{
            marginTop: 12, height: 26, padding: '0 12px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
            background: 'rgba(120,170,255,0.22)', border: '1px solid rgba(120,170,255,0.5)',
            color: '#a8c8ff', fontSize: 12, fontWeight: 600,
          }}
        >Start the mixer</button>
      )}
      {phase.kind === 'failed' && phase.log && (
        <pre style={{ marginTop: 12, fontSize: 11, color: 'rgba(255,255,255,0.45)', whiteSpace: 'pre-wrap' }}>{phase.log}</pre>
      )}
    </div>
  )
}
