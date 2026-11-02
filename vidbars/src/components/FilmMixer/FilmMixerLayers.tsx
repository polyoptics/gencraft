// FilmMixerLayers — the current frame's composite, hung in depth behind the Film
// Look node when the canvas swings sideways, on the loop strip's layer stage
// (Viewport3D/ExplodedStrip) under the same open and close rules.
//
// Coarser than the mixer's sliders: the plate, then each group of marks. Each is
// rendered by the mixer itself with the groups above it switched off, so the
// stack adds up to exactly what the mixer shows. Nothing is stored here.

import React, { useEffect, useState } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useTiltStore } from '../../store/tiltStore'
import { LAYER_GAP, LayerCanvas, layerFan, unmix } from '../Viewport3D/ExplodedStrip'
import { PAGE_H, PAGE_W, useFilmLayersOn } from './FilmMixerBody'

/** The look's strengths per layer, bottom up. */
const GROUPS = [
  { id: 'background', label: 'Background marks', color: '#6fb7ff', keys: ['bg', 'bg_stipple', 'bg_halftone'] },
  { id: 'shading', label: 'Figure shading', color: '#ffb35c', keys: ['hatch', 'hatch_stipple', 'hatch_halftone', 'pants_hatch', 'pants_hatch_stipple', 'pants_hatch_halftone'] },
  { id: 'outlines', label: 'Outlines', color: '#ff7c6b', keys: ['subject', 'interior', 'pants_outline', 'light'] },
] as const
const GRAPHICS = { id: 'graphics', label: 'Graphics', color: '#5fe39b' }

/** While the mixer plays, how often the layers catch up. Every bake is frames
 *  the GPU is not spending on the playback. */
const PLAYING_MS = 1000
const POLL_MS = 250

interface Pane { id: string; label: string; color: string; canvas: HTMLCanvasElement }
interface Baked {
  clip: string
  plate: HTMLCanvasElement
  panes: Pane[]
  /** The finished frame, and where it sits in the mixer's page. */
  picture: HTMLCanvasElement
  from: View['picture']
}

type View = NonNullable<Awaited<ReturnType<NonNullable<NonNullable<typeof window.vidbarsDesktop>['mixerView']>>>>

async function frameCanvas(view: View, look: Record<string, number> | null, card: boolean): Promise<HTMLCanvasElement | 'loading' | null> {
  const r = await window.vidbarsDesktop?.mixerFrame?.({ seg: view.seg, i: view.i, look, card })
  if (r?.loading) return 'loading'
  if (!r?.url) return null
  const img = new Image()
  img.src = r.url
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.naturalWidth; c.height = img.naturalHeight
  c.getContext('2d')!.drawImage(img, 0, 0)
  return c
}

/** The plate and a pane per layer; null or 'loading' when the mixer can't yet. */
async function bake(view: View): Promise<Baked | 'loading' | null> {
  const look = view.look
  // Graphics-only shot: the edit's own frame, no layers to pull apart.
  if (!look) {
    const plate = await frameCanvas(view, null, false)
    return plate instanceof HTMLCanvasElement ? { clip: view.clip, plate, panes: [], picture: plate, from: view.picture } : plate
  }
  const without = (from: number) => {
    const l = { ...look }
    for (const g of GROUPS.slice(from)) for (const k of g.keys) l[k] = 0
    return l
  }
  const plate = await frameCanvas(view, without(0), false)
  if (!(plate instanceof HTMLCanvasElement)) return plate
  const panes: Pane[] = []
  let prev = plate
  for (const [n, g] of GROUPS.entries()) {
    const after = await frameCanvas(view, without(n + 1), false)
    if (!(after instanceof HTMLCanvasElement)) return after
    panes.push({ id: g.id, label: g.label, color: g.color, canvas: unmix(prev, after).boosted })
    prev = after
  }
  if (view.overlay && view.cardOn) {
    const after = await frameCanvas(view, look, true)
    if (!(after instanceof HTMLCanvasElement)) return after
    panes.push({ ...GRAPHICS, canvas: unmix(prev, after).boosted })
    prev = after
  }
  return { clip: view.clip, plate, panes, picture: prev, from: view.picture }
}

/** Follows the mixer while the layers are open. Holds the last bake until the
 *  next is ready, so the panes never blink. */
function useBaked(open: boolean): Baked | null {
  const [baked, setBaked] = useState<Baked | null>(null)
  useEffect(() => {
    if (!open || !window.vidbarsDesktop?.mixerView) return
    let dead = false, busy = false, done = '', last = 0
    const tick = async () => {
      if (busy) return
      busy = true
      try {
        const view = await window.vidbarsDesktop!.mixerView!()
        if (dead || !view) return
        const sig = JSON.stringify([view.seg, view.i, view.look, view.overlay && view.cardOn])
        if (sig === done || (view.playing && performance.now() - last < PLAYING_MS)) return
        const b = await bake(view)
        if (dead || b === 'loading' || !b) return
        done = sig
        last = performance.now()
        setBaked(b)
      } finally { busy = false }
    }
    void tick()
    const t = window.setInterval(() => void tick(), POLL_MS)
    return () => { dead = true; window.clearInterval(t) }
  }, [open])
  return baked
}

/** On the canvas only: a pinned mixer has left the plane the layers hang from. */
export const FilmMixerLayers: React.FC = () => {
  const node = useFreeNodeStore(s => Object.values(s.nodes).find(n => n.type === 'filmMixer' && !n.pin))
  const on = useFilmLayersOn(s => s.on)
  const swing = useTiltStore(layerFan)
  const fan = on ? swing : 0
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const baked = useBaked(!!node && fan > 0)

  // The picture has left the page for the stack; collapsed, it is back.
  const away = !!node && !!baked && fan > 0
  useEffect(() => {
    if (!away) return
    void window.vidbarsDesktop?.mixerShowPicture?.(false)
    return () => { void window.vidbarsDesktop?.mixerShowPicture?.(true) }
  }, [away])

  if (!node || !baked || fan === 0) return null

  const rect = { x: pan.x + node.x * zoom, y: pan.y + node.y * zoom, width: node.width * zoom, height: node.height * zoom }
  const aspect = baked.plate.width / baked.plate.height
  const boxH = Math.min(rect.height, rect.width / aspect), boxW = boxH * aspect
  const gap = Math.max(40, boxH * LAYER_GAP) * fan
  const left = rect.x + (rect.width - boxW) / 2, top = rect.y + (rect.height - boxH) / 2
  const pos = (z: number): React.CSSProperties => ({
    position: 'absolute', left, top, width: boxW, height: boxH, transform: `translateZ(${z}px)`, pointerEvents: 'none',
  })
  const header = (background: string): React.CSSProperties => ({
    position: 'absolute', left: 0, right: 0, bottom: '100%', whiteSpace: 'nowrap', fontSize: 13, color: '#fff',
    padding: '5px 8px', borderRadius: '7px 7px 0 0', boxSizing: 'border-box', background,
  })
  // Plate furthest back; the last layer right behind the node's own face.
  const count = baked.panes.length

  // The picture starts where the page draws it and travels back past every
  // layer to the far end, growing to the layers' size on the way. Same open
  // amount both ways, so collapsing runs it home.
  const headerH = Math.min(22 / zoom, node.height * 0.28)
  const fit = Math.min(node.width / PAGE_W, (node.height - headerH) / PAGE_H)
  const onPage = {
    x: pan.x + (node.x + (node.width - PAGE_W * fit) / 2 + baked.from.x * fit) * zoom,
    y: pan.y + (node.y + headerH + baked.from.y * fit) * zoom,
    w: baked.from.width * fit * zoom,
    h: baked.from.height * fit * zoom,
  }
  const mix = (a: number, b: number) => a + (b - a) * fan

  return (
    <>
      <div
        data-film-layer="picture"
        style={{
          position: 'absolute', pointerEvents: 'none', outline: '1.5px solid rgba(255,255,255,.4)',
          left: mix(onPage.x, left), top: mix(onPage.y, top), width: mix(onPage.w, boxW), height: mix(onPage.h, boxH),
          transform: `translateZ(${-(count + 2) * gap}px)`,
        }}
      >
        <LayerCanvas canvas={baked.picture} />
        <div style={header('#23252f')}>Picture · {baked.clip}</div>
      </div>
      {count > 0 && (
        <div data-film-layer="plate" style={{ ...pos(-(count + 1) * gap), outline: '1.5px solid rgba(255,255,255,.25)' }}>
          <LayerCanvas canvas={baked.plate} />
          <div style={header('#23252f')}>Plate</div>
        </div>
      )}
      {baked.panes.map((p, n) => (
        // A pale wash: most of these marks are dark ink, lost on the dark canvas.
        <div key={p.id} data-film-layer={p.id} style={{ ...pos(-(count - n) * gap), outline: `1.5px solid ${p.color}`, outlineOffset: -1, background: 'rgba(235,232,222,.32)' }}>
          <LayerCanvas canvas={p.canvas} />
          <div style={header(`color-mix(in srgb, ${p.color} 28%, #16171f)`)}>{p.label}</div>
        </div>
      ))}
    </>
  )
}
