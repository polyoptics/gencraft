import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { useCanvasStore } from '../../store/canvasStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useTiltStore } from '../../store/tiltStore'
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
/** The page's own layout, the same at every zoom and node size: the node
 *  scales it like a picture, so nothing in it ever rearranges. Under 900 wide
 *  the mixer's page stacks into one long column. */
export const PAGE_W = 1240
export const PAGE_H = 838
/** The node's shape, height ÷ width, title bar included. It only ever scales. */
export const FILM_MIXER_ASPECT = 860 / 1240
/** How much of the canvas it comes down filling, whatever the zoom. */
const START_FILL = 0.9

const LAYERS_KEY = 'vidbars.filmLayers'
const GAP_KEY = 'vidbars.filmLayerGap'
const GAP_START = 0.2, GAP_MIN = 0.02, GAP_MAX = 3
/** The title bar grip: spacing per screen pixel dragged. */
const SPACING_PER_PX = 0.005
/** Whether the mixer's layers show when the canvas swings. On unless switched
 *  off, kept across reloads; only ever a switch, it never touches the camera. */
export const useFilmLayersOn = create<{ on: boolean; toggle: () => void; gap: number; setGap: (gap: number) => void }>((set, get) => ({
  on: (() => { try { return localStorage.getItem(LAYERS_KEY) !== '0' } catch { return true } })(),
  toggle: () => {
    const on = !get().on
    set({ on })
    try { localStorage.setItem(LAYERS_KEY, on ? '1' : '0') } catch { /* private window */ }
  },
  /** Space between layers, as a share of a layer's height: what the back
   *  layer's handles set, kept across reloads. Its ceiling is high enough to
   *  bring the stack out from behind the mixer's own panel. */
  gap: (() => {
    try {
      const g = Number(localStorage.getItem(GAP_KEY))
      return g > 0 ? Math.max(GAP_MIN, Math.min(GAP_MAX, g)) : GAP_START
    } catch { return GAP_START }
  })(),
  setGap: gap => {
    gap = Math.max(GAP_MIN, Math.min(GAP_MAX, gap))
    set({ gap })
    try { localStorage.setItem(GAP_KEY, String(gap)) } catch { /* private window */ }
  },
}))

/** The title bar's switch. A fixed label, lit when on. */
export function FilmLayersToggle({ fontSize }: { fontSize: number }) {
  const on = useFilmLayersOn(s => s.on)
  const toggle = useFilmLayersOn(s => s.toggle)
  return (
    <button
      data-film-layers-toggle=""
      title={on ? 'Layers on: swing the canvas sideways to see them. Click to turn off' : 'Layers off. Click to turn on'}
      // On the press, not the click: tilted, the view takes the pointer over
      // and no click would ever arrive.
      onPointerDown={e => {
        if (e.button !== 0) return
        e.stopPropagation()
        toggle()
      }}
      style={{
        flexShrink: 0, fontSize, lineHeight: 1.2, padding: `0 ${fontSize * 0.6}px`, borderRadius: fontSize * 0.4,
        fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer', color: on ? '#a8c8ff' : 'rgba(255,255,255,0.45)',
        background: on ? 'rgba(120,170,255,0.22)' : 'transparent',
        border: `${fontSize * 0.08}px solid ${on ? 'rgba(120,170,255,0.5)' : 'rgba(255,255,255,0.15)'}`,
      }}
    >Layers</button>
  )
}

/** The title bar's spacing grip. The back layer has corner handles too, but
 *  the mixer's own panel covers them until the layers are far apart, so this
 *  one is always in reach. Drag the way the layers run to spread them. */
export function FilmLayersSpacing({ fontSize }: { fontSize: number }) {
  return (
    <span
      data-film-layers-spacing=""
      title="Drag to set how far the layers spread"
      onPointerDown={e => {
        if (e.button !== 0) return
        e.stopPropagation()
        e.preventDefault()
        const way = useTiltStore.getState().yaw > 0 ? -1 : 1
        const sx = e.clientX, gap0 = useFilmLayersOn.getState().gap
        const move = (m: PointerEvent) => useFilmLayersOn.getState().setGap(gap0 + (m.clientX - sx) * way * SPACING_PER_PX)
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
      style={{
        flexShrink: 0, fontSize, lineHeight: 1.2, padding: `0 ${fontSize * 0.5}px`, cursor: 'ew-resize', userSelect: 'none',
        color: 'rgba(255,255,255,0.6)', touchAction: 'none',
      }}
    >⇔</span>
  )
}

/** One mixer: its page lets only one copy of itself be live. The button adds
 *  it, or brings the camera to the one on the canvas. */
export function openFilmMixer() {
  const fns = useFreeNodeStore.getState()
  const have = Object.values(fns.nodes).find(n => n.type === 'filmMixer')
  const cs = useCanvasStore.getState()
  const host = document.querySelector('[data-zoom-bar-host]')?.getBoundingClientRect()
  const w = host?.width ?? window.innerWidth, h = host?.height ?? window.innerHeight
  if (!have) {
    // Sized from the screen rather than createScaleFor, whose clamps let it
    // come down huge zoomed in and small zoomed far out.
    const id = addFreeNodeCentered('filmMixer')
    const n = useFreeNodeStore.getState().nodes[id]
    const width = Math.min(w, h / FILM_MIXER_ASPECT) * START_FILL / cs.zoom
    const height = width * FILM_MIXER_ASPECT
    useFreeNodeStore.getState().updateFreeNode(id, {
      width, height,
      x: n.x + n.width / 2 - width / 2,
      y: n.y + n.height / 2 - height / 2,
    })
    return
  }
  fns.setFreeSelection([have.id])
  if (have.pin) return
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

// Pinning hands the node from FreeCanvas to PinLayer, a whole new React subtree,
// and an iframe that leaves the document reloads. So what must outlive that
// lives outside React: the phase in a store, and the page in one element that
// is carried to whichever body is showing (moveBefore keeps a frame running as
// it moves; appendChild, where that is missing, reloads it). Between bodies it
// waits in a parking lot off screen, still in the document.
const useMixerPhase = create<{ phase: Phase }>(() => ({ phase: { kind: 'checking' } }))
const setPhase = (phase: Phase) => useMixerPhase.setState({ phase })

let frame: HTMLIFrameElement | null = null
let parking: HTMLDivElement | null = null

function moveTo(to: HTMLElement, el: HTMLElement) {
  const mover = to as HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void }
  try {
    if (mover.moveBefore && el.isConnected) { mover.moveBefore(el, null); return }
  } catch { /* falls through: a reload beats a lost page */ }
  to.appendChild(el)
}

function frameFor(url: string): HTMLIFrameElement {
  if (frame) return frame
  frame = document.createElement('iframe')
  frame.src = url
  frame.title = 'Film Look mixer'
  frame.style.cssText = `display:block;border:none;width:${PAGE_W}px;height:${PAGE_H}px`
  return frame
}

function park() {
  if (!frame) return
  if (!parking) {
    parking = document.createElement('div')
    parking.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden'
    document.body.appendChild(parking)
  }
  moveTo(parking, frame)
  // The next body takes it in the same commit. None coming means the node is
  // gone: the page goes with it, and a new node looks for the mixer afresh.
  setTimeout(() => {
    if (frame?.parentElement !== parking) return
    if (Object.values(useFreeNodeStore.getState().nodes).some(n => n.type === 'filmMixer')) return
    dropFrame()
    setPhase({ kind: 'checking' })
  }, 0)
}

function dropFrame() {
  frame?.remove()
  frame = null
}

async function startMixer() {
  const d = window.vidbarsDesktop
  if (!d?.mixerStart) { setPhase({ kind: 'needsRestart' }); return }
  setPhase({ kind: 'starting' })
  const r = await d.mixerStart()
  setPhase(r.url ? { kind: 'ready', url: r.url } : { kind: 'failed', error: r.error ?? 'The mixer did not start', log: r.log })
}

export function FilmMixerBody({ pinned, bodyW, bodyH }: { pinned: boolean; bodyW: number; bodyH: number }) {
  const phase = useMixerPhase(s => s.phase)
  const [active, setActive] = useState(false)
  const [hover, setHover] = useState(false)
  const slot = useRef<HTMLDivElement>(null)

  // Showing the node starts the mixer, or uses the one already running.
  useEffect(() => {
    if (useMixerPhase.getState().phase.kind !== 'checking') return
    void probe().then(p => {
      if (useMixerPhase.getState().phase.kind !== 'checking') return
      if (p.running) setPhase({ kind: 'ready', url: p.url })
      else if (p.canStart) void startMixer()
      else setPhase({ kind: 'needsRestart' })
    })
  }, [])

  const url = phase.kind === 'ready' ? phase.url : null
  useLayoutEffect(() => {
    if (!url || !slot.current) return
    moveTo(slot.current, frameFor(url))
    return park
  }, [url])

  // The mixer's own Quit button ends the server under the page. Say so, and
  // leave starting it again to a click: Quit means free the GPU.
  const ready = phase.kind === 'ready'
  useEffect(() => {
    if (!ready) return
    const t = setInterval(() => {
      void probe().then(p => {
        if (p.running) return
        dropFrame()
        setPhase({ kind: 'stopped' })
      })
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
  const fit = Math.max(0.001, Math.min(bodyW / PAGE_W, bodyH / PAGE_H))

  return (
    <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', background: '#14151c' }}>
      {phase.kind === 'ready'
        // Fitted, not stretched: the title bar holds its screen size, so the
        // body's shape changes with the zoom, and the page must not reflow
        // as the wheel turns. The spare room is a margin.
        ? <div
            ref={slot}
            style={{
              position: 'absolute', top: 0,
              left: (bodyW - PAGE_W * fit) / 2,
              width: PAGE_W, height: PAGE_H,
              transform: `scale(${fit})`, transformOrigin: '0 0',
            }}
          />
        : <PhaseMessage phase={phase} onStart={() => void startMixer()} />}
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
