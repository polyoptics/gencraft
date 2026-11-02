import { useEffect, useState } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { addFreeNodeCentered } from '../../utils/canvasCreate'

/** The Film Look node: the look mixer, laid out on the canvas like any panel.
 *
 *  It shows the mixer's own page, from the mixer's own server, so every shot,
 *  look, setup and bake is the mixer's and goes on working the same as it does
 *  from mixer.cmd. The page has its own origin, so it never reaches the desktop
 *  bridge, and its keys stay with it while it has the focus.
 *
 *  On the canvas a clear shield lies over the page until it is clicked, so the
 *  wheel and pan still work the canvas across it; a press anywhere else puts
 *  the shield back. Pinned, it is a tool on the screen and needs no shield. */

const DEFAULT_URL = 'http://localhost:8766'
/** Under 900 the mixer's page stacks into one long column. */
const PAGE_W = 1240

/** One mixer: its page lets only one copy of itself be live. The button adds
 *  it, or brings the camera to the one on the canvas. */
export function openFilmMixer() {
  const fns = useFreeNodeStore.getState()
  const have = Object.values(fns.nodes).find(n => n.type === 'filmMixer')
  if (!have) { addFreeNodeCentered('filmMixer'); return }
  fns.setFreeSelection([have.id])
  if (have.pin) return
  const cs = useCanvasStore.getState()
  const host = document.querySelector('[data-zoom-bar-host]')?.getBoundingClientRect()
  const w = host?.width ?? window.innerWidth, h = host?.height ?? window.innerHeight
  useCanvasStore.setState({ pan: {
    x: w / 2 - (have.x + have.width / 2) * cs.zoom,
    y: h / 2 - (have.y + have.height / 2) * cs.zoom,
  } })
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

export function FilmMixerBody({ pinned, bodyW, bodyH }: { pinned: boolean; bodyW: number; bodyH: number }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' })
  const [active, setActive] = useState(false)
  const [hover, setHover] = useState(false)

  const start = async () => {
    const d = window.vidbarsDesktop
    if (!d?.mixerStart) { setPhase({ kind: 'needsRestart' }); return }
    setPhase({ kind: 'starting' })
    const r = await d.mixerStart()
    setPhase(r.url ? { kind: 'ready', url: r.url } : { kind: 'failed', error: r.error ?? 'The mixer did not start', log: r.log })
  }

  // Showing the node starts the mixer, or uses the one already running.
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

  // A press inside the page never reaches this document, so any press seen
  // here is outside it, shield included.
  useEffect(() => {
    if (!active) return
    const onDown = () => setActive(false)
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [active])

  const shielded = ready && !pinned && !active

  return (
    <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', background: '#14151c' }}>
      {phase.kind === 'ready'
        // Always laid out PAGE_W wide and drawn to the node's size, like a
        // picture: a node added zoomed out is thousands of units wide, and
        // the page laid out at that would be all gaps and specks of text.
        ? <iframe
            src={phase.url}
            title="Film Look mixer"
            style={{
              position: 'absolute', left: 0, top: 0, border: 'none', display: 'block',
              width: PAGE_W, height: Math.max(1, bodyH * PAGE_W / Math.max(1, bodyW)),
              transform: `scale(${bodyW / PAGE_W})`, transformOrigin: '0 0',
            }}
          />
        : <PhaseMessage phase={phase} onStart={() => void start()} />}
      {shielded && (
        <div
          data-film-mixer-shield
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
          onPointerDown={e => {
            // Left only: a middle-drag goes on to pan the canvas.
            if (e.button !== 0) return
            e.stopPropagation()
            setActive(true)
          }}
          style={{ position: 'absolute', inset: 0, cursor: 'pointer' }}
        >
          {hover && (
            <div style={{
              position: 'absolute', left: 12, bottom: 12, padding: '4px 10px', borderRadius: 6,
              background: 'rgba(8,9,16,0.85)', color: 'rgba(255,255,255,0.8)', fontSize: 12,
            }}>Click to work in the mixer</div>
          )}
        </div>
      )}
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
          onPointerDown={e => e.stopPropagation()}
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
