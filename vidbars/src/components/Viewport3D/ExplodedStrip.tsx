// ExplodedStrip — a loop strip's effect cards hung in depth behind its Viewer,
// seen by swinging the canvas sideways (store/tiltStore yaw). The picture is
// the back plate; each effect card is a pane in strip order holding only what
// that card changes. They live on a stage of their own under the tilted world,
// with its transform, so the plane and what is on it hide them as they should.
//
// Experimental (branch exploded-strip). Nothing is stored here: panes are baked
// from the strip's own run, and solo, FX and reorder write to the strip itself.


import React, { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { useCanvasStore } from '../../store/canvasStore'
import { useRailUiStore } from '../../store/railUiStore'
import { useTiltStage, useTiltStore } from '../../store/tiltStore'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { railViewerDocks, viewerRail } from '../../utils/railViewer'
import { useFreeNodeStore, type FreeNodeData } from '../../store/freeNodeStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { isRail, railMembers, type RailSlot } from '../../utils/rail'
import { loadImage, runChain, type ChainItem } from '../../utils/fx/chain'
import { railComboAt, railFaceCombo } from '../../utils/fx/railChain'
import { EFFECTS, knownKind } from '../../utils/fx/effects'
import { LIVE_SIDE } from '../../hooks/useFxStrips'
import { toggleEffectOff, toggleEffectSolo } from '../../utils/fx/effectToggles'
import { FilmMixerLayers } from '../FilmMixer/FilmMixerLayers'

type EffectItem = Extract<ChainItem, { kind: 'effect' }>

/** Long edge the panes are baked at. */
const BAKE_SIDE = 1000

interface Pane { id: string; exact: HTMLCanvasElement; boosted: HTMLCanvasElement }

/** What `after` lays over `before`, as colour and alpha: the least alpha that
 *  can make the change, so laying the pane over `before` gives back `after`
 *  (`exact`). `boosted` lifts faint alpha so it can be seen on its own. */
export function unmix(before: HTMLCanvasElement, after: HTMLCanvasElement): Pane & { id: '' } {
  const { width: w, height: h } = after
  const g = before.getContext('2d')!
  const b = (before.width === w && before.height === h ? g : (() => {
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    const cg = c.getContext('2d')!
    cg.drawImage(before, 0, 0, w, h)
    return cg
  })()).getImageData(0, 0, w, h).data
  const a = after.getContext('2d')!.getImageData(0, 0, w, h).data
  const make = () => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c }
  const exact = make(), boosted = make()
  const ex = new ImageData(w, h), bo = new ImageData(w, h)
  for (let i = 0; i < a.length; i += 4) {
    let al = 0
    for (let k = 0; k < 3; k++) {
      const f = b[i + k], t = a[i + k]
      if (t > f) al = Math.max(al, (t - f) / (255 - f))
      else if (t < f) al = Math.max(al, (f - t) / f)
    }
    if (al <= 0) continue
    for (let k = 0; k < 3; k++) {
      const v = b[i + k] + (a[i + k] - b[i + k]) / al
      ex.data[i + k] = v
      bo.data[i + k] = v
    }
    ex.data[i + 3] = al * 255
    bo.data[i + 3] = Math.pow(al, 0.55) * 255
  }
  exact.getContext('2d')!.putImageData(ex, 0, 0)
  boosted.getContext('2d')!.putImageData(bo, 0, 0)
  return { id: '', exact, boosted }
}

interface Baked { plate: HTMLCanvasElement; panes: Pane[]; result: HTMLCanvasElement }

/** The stack's pictures: the result, the plate, and a pane per effect card. A card
 *  switched off gets the pane it would have, there to switch back on. Solo is
 *  left out, so every pane keeps its layer while one is soloed. */
async function bake(items: ChainItem[]): Promise<Baked | null> {
  const on = items.map(it => (it.kind === 'effect' ? { ...it, solo: false } : it))
  const r = await runChain(on, LIVE_SIDE, BAKE_SIDE, { live: true })
  const source = on.find(it => it.kind === 'source')
  const out = r.outputs[0]?.canvas
  if (!out || source?.kind !== 'source') return null
  const img = await loadImage(source.url)
  if (!img) return null
  const steps = [...r.stepPreviews.values()]
  const size = steps[0] ?? out
  const plate = document.createElement('canvas')
  plate.width = size.width; plate.height = size.height
  const pg = plate.getContext('2d')!
  pg.fillStyle = '#000'
  pg.fillRect(0, 0, plate.width, plate.height)
  pg.imageSmoothingQuality = 'high'
  pg.drawImage(img, 0, 0, plate.width, plate.height)

  const panes: Pane[] = []
  let prev = plate
  for (const [i, it] of on.entries()) {
    if (it.kind !== 'effect') continue
    if (it.off) {
      const upTo = on.slice(0, i + 1).concat(on[i + 1]?.kind === 'source' ? [on[i + 1]] : [])
      const was = upTo.map(x => (x.id === it.id && x.kind === 'effect' ? { ...x, off: false } : x))
      const tried = await runChain(was, LIVE_SIDE, BAKE_SIDE, { live: true })
      const after = tried.stepPreviews.get(it.id)
      panes.push({ ...unmix(prev, after ?? prev), id: it.id })
      continue
    }
    const after = r.stepPreviews.get(it.id)
    if (!after) continue
    panes.push({ ...unmix(prev, after), id: it.id })
    prev = after
  }
  return { plate, panes, result: out }
}

/** The strip's slots with its effect cards in this order. A card takes the
 *  column after it along (what a blend mixes in); the rest stay put. */
function reorderedSlots(slots: RailSlot[], order: string[], cardOf: (slot: RailSlot) => string | undefined): RailSlot[] {
  const first = slots.findIndex(s => s.kind === 'card')
  if (first < 0) return slots
  const units: { id?: string; slots: RailSlot[] }[] = []
  for (const s of slots.slice(first)) {
    if (s.kind === 'card') units.push({ id: cardOf(s), slots: [s] })
    else units[units.length - 1].slots.push(s)
  }
  const placed = order.flatMap(id => units.filter(u => u.id === id))
  const rest = units.filter(u => !placed.includes(u))
  return [...slots.slice(0, first), ...[...placed, ...rest].flatMap(u => u.slots)]
}

function moveCard(railId: string, order: string[]): void {
  const { nodes, updateFreeNode } = useFreeNodeStore.getState()
  const rail = nodes[railId]
  if (!isRail(rail)) return
  const bySlot = railMembers(nodes).get(railId)
  const slots = reorderedSlots(rail.rail.slots, order, s => bySlot?.get(s.id)?.[0]?.id)
  useUndoCoordinator.getState().checkpoint()
  updateFreeNode(railId, { rail: { ...rail.rail, slots } })
}

/** Space between panes, as a share of the pane's height. */
export const LAYER_GAP = 0.2
/** How far round a swing has fully fanned the panes, degrees. */
const FAN_AT = 35
/** How far tipped back they have fully closed again, degrees. */
const CLOSE_AT = 40

/** How open layers are, 0-1. Open when swung from top-down or tipped up past
 *  flat; tipping the view back closes them, smoothly, since then you are looking
 *  round a model, not at the layers. Tipped up no model stands, so nothing
 *  closes them. */
export function layerFan(s: { tilt: number; yaw: number }): number {
  const smooth = (k: number) => { const c = Math.max(0, Math.min(1, k)); return c * c * (3 - 2 * c) }
  return Math.round(Math.max(smooth(Math.abs(s.yaw) / FAN_AT), smooth(-s.tilt / FAN_AT)) * (1 - smooth(Math.max(0, s.tilt) / CLOSE_AT)) * 200) / 200
}

export const LayerCanvas: React.FC<{ canvas: HTMLCanvasElement; opacity?: number }> = ({ canvas, opacity = 1 }) => {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = host.current
    if (!el) return
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'
    el.replaceChildren(canvas)
  }, [canvas])
  return <div ref={host} style={{ position: 'absolute', inset: 0, opacity, pointerEvents: 'none' }} />
}

const LAYERS_KEY = 'vidbars.stripLayers'
const GAP_KEY = 'vidbars.stripLayerGap'
const GAP_MIN = 0.02, GAP_MAX = 1.5
/** The Viewer's Layers switch: whether swinging sideways explodes a strip.
 *  On unless switched off; kept across reloads. */
export const useStripLayers = create<{ on: boolean; toggle: () => void; gap: number; setGap: (gap: number) => void }>((set, get) => ({
  /** Space between layers, as a share of a layer's height: what the handles
   *  on the back layer set. Kept across reloads. */
  gap: (() => {
    try {
      const g = Number(localStorage.getItem(GAP_KEY))
      return g > 0 ? Math.max(GAP_MIN, Math.min(GAP_MAX, g)) : LAYER_GAP
    } catch { return LAYER_GAP }
  })(),
  setGap: gap => {
    gap = Math.max(GAP_MIN, Math.min(GAP_MAX, gap))
    set({ gap })
    try { localStorage.setItem(GAP_KEY, String(gap)) } catch { /* private window */ }
  },
  on: (() => { try { return localStorage.getItem(LAYERS_KEY) !== '0' } catch { return true } })(),
  toggle: () => {
    const on = !get().on
    set({ on })
    try { localStorage.setItem(LAYERS_KEY, on ? '1' : '0') } catch { /* private window */ }
  },
}))

/** Where each Viewer's picture sits, canvas units from the window's corner,
 *  read off the flat view: the stack hangs exactly behind it. */
export const pictureAreas = new Map<string, { x: number; y: number; width: number; height: number }>()

/** Strips whose result has left their Viewer's face for the stack behind it. */
export const useLayersOut = create<Record<string, boolean>>(() => ({}))

/** One Viewer's strip, hanging behind it. */
const StripLayers: React.FC<{ railId: string; rect: { x: number; y: number; width: number; height: number } }> = ({ railId, rect }) => {
  const nodes = useFreeNodeStore(s => s.nodes)
  const rail = nodes[railId] as FreeNodeData | undefined
  const combo = useMemo(() => {
    if (!rail) return null
    const members = railMembers(nodes).get(railId)
    return railComboAt(rail, members, railFaceCombo(rail, members))
  }, [nodes, rail, railId])
  const items = combo?.items
  const effects = (items ?? []).filter((it): it is EffectItem => it.kind === 'effect')
  const soloed = effects.find(e => e.solo)?.id ?? null
  const fan = useTiltStore(layerFan)

  // Re-baked when what the layers are made of changes; not for a solo.
  const sig = JSON.stringify((items ?? []).map(it => (it.kind === 'effect' ? { ...it, solo: false } : it)))
  const [baked, setBaked] = useState<Baked | null>(null)
  const latest = useRef(items)
  latest.current = items
  useEffect(() => {
    let dead = false
    const t = window.setTimeout(() => {
      if (latest.current) void bake(latest.current).then(b => { if (!dead && b) setBaked(b) })
    }, 120)
    return () => { dead = true; window.clearTimeout(t) }
  }, [sig])

  const [drag, setDrag] = useState<{ id: string; dz: number } | null>(null)
  const order = effects.map(e => e.id)
  const aspect = baked ? baked.plate.width / baked.plate.height : 1
  const boxH = Math.min(rect.height, rect.width / aspect), boxW = boxH * aspect
  const layerGap = useStripLayers(s => s.gap)
  const spread = boxH * layerGap
  // The result leaves the Viewer's face and travels back through the stack,
  // to end behind the plate. The panes ride with it, just behind it, and each
  // is left behind at its own place: the last card first, the plate last.
  const travel = -(order.length + 2) * spread * fan
  const zOf = (i: number) => {
    const place = -(order.length - i) * spread
    return place > travel ? place : travel - 1 - (order.length - i) * 0.1
  }
  const stepTo = (id: string, dz: number) => Math.max(0, Math.min(order.length - 1, order.indexOf(id) + Math.round(dz / spread)))
  const shown = (() => {
    if (!drag) return order
    const next = order.filter(id => id !== drag.id)
    next.splice(stepTo(drag.id, drag.dz), 0, drag.id)
    return next
  })()

  // A corner of the back layer, dragged: the back layer follows the cursor in
  // depth, and every gap opens or closes with it.
  const startHandle = (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const { tilt, yaw } = useTiltStore.getState()
    const b = yaw * Math.PI / 180, t = tilt * Math.PI / 180
    const vx = Math.sin(b), vy = -Math.sin(t) * Math.cos(b)
    const len2 = vx * vx + vy * vy
    if (len2 < 0.02 || fan <= 0) return
    const sx = e.clientX, sy = e.clientY, gap0 = layerGap, depth = boxH * (order.length + 2) * fan
    const move = (m: PointerEvent) => {
      const dz = ((m.clientX - sx) * vx + (m.clientY - sy) * vy) / len2
      useStripLayers.getState().setGap(gap0 - dz / depth)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // A press on a pane: dragged, it moves in depth; let go in place, a solo.
  const startPane = (e: React.PointerEvent, id: string) => {
    e.stopPropagation()
    const { tilt, yaw } = useTiltStore.getState()
    const b = yaw * Math.PI / 180, t = tilt * Math.PI / 180
    // Which way depth runs on the screen: the plane's normal, Rx·Ry·z.
    const vx = Math.sin(b), vy = -Math.sin(t) * Math.cos(b)
    const len2 = vx * vx + vy * vy
    const sx = e.clientX, sy = e.clientY
    let moved = false, dz = 0
    const move = (m: PointerEvent) => {
      const dx = m.clientX - sx, dy = m.clientY - sy
      if (!moved && Math.hypot(dx, dy) < 6) return
      if (len2 < 0.02) return
      moved = true
      dz = (dx * vx + dy * vy) / len2
      setDrag({ id, dz })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      if (!moved) { toggleEffectSolo(id); return }
      const to = stepTo(id, dz)
      if (to === order.indexOf(id)) return
      const next = order.filter(x => x !== id)
      next.splice(to, 0, id)
      moveCard(railId, next)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // No effect cards, no layers: the Viewer keeps its picture.
  const out = !!baked && fan > 0 && effects.length > 0
  useEffect(() => {
    useLayersOut.setState({ [railId]: out })
    return () => useLayersOut.setState({ [railId]: false })
  }, [railId, out])

  if (!out) return null
  const left = rect.x + (rect.width - boxW) / 2, top = rect.y + (rect.height - boxH) / 2
  const edge = (c: string) => `1.5px solid ${c}`
  const header: React.CSSProperties = { position: 'absolute', left: 0, right: 0, bottom: '100%', display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', fontSize: 13, color: '#fff', padding: '5px 8px', borderRadius: '7px 7px 0 0', boxSizing: 'border-box' }
  const pos = (z: number): React.CSSProperties => ({ position: 'absolute', left, top, width: boxW, height: boxH, transform: `translateZ(${z}px)` })
  return (
    <>
      <div style={{ ...pos(travel), outline: edge('rgba(255,255,255,.25)'), pointerEvents: 'none' }}>
        <LayerCanvas canvas={baked.result} />
        <div data-layer-pane="" style={{ ...header, background: '#23252f', pointerEvents: 'auto' }}>
          <span>Result</span>
          <span style={{ flex: 1 }} />
          <button
            title="Layers: lit, swinging sideways shows the strip's layers behind the Viewer"
            onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); useStripLayers.getState().toggle() }}
            style={{ padding: '1px 6px', fontSize: 11, border: '1px solid rgba(255,255,255,.25)', borderRadius: 5, color: '#fff', cursor: 'pointer', background: 'rgba(120,170,255,.35)' }}
          >Layers</button>
        </div>
        {[{ left: -7, top: -7 }, { right: -7, top: -7 }, { left: -7, bottom: -7 }, { right: -7, bottom: -7 }].map((at, i) => (
          <div
            key={i}
            data-layer-pane=""
            data-layer-handle=""
            title="Drag to set how far the layers spread"
            onPointerDown={startHandle}
            style={{ position: 'absolute', ...at, width: 14, height: 14, borderRadius: 4, background: '#cfe2ff', border: '2px solid #16171f', boxSizing: 'border-box', cursor: 'grab', pointerEvents: 'auto' }}
          />
        ))}
      </div>
      <div style={{ ...pos(zOf(-1)), outline: edge('rgba(255,255,255,.25)'), pointerEvents: 'none' }}>
        <LayerCanvas canvas={baked.plate} />
        <div style={{ ...header, background: '#23252f' }}>Picture</div>
      </div>
      {shown.map((id, at) => {
        const it = effects.find(e => e.id === id)!
        const pane = baked.panes.find(p => p.id === id)
        const def = EFFECTS[knownKind(it.effect)]
        const dragged = drag?.id === id
        const z = dragged ? zOf(order.indexOf(id)) + drag!.dz : zOf(at)
        const dim = !!it.off || (!!soloed && soloed !== id)
        const line = soloed === id ? '#fff' : dim ? 'rgba(255,255,255,.18)' : def.color
        return (
          <div
            key={id}
            data-layer-pane={id}
            onPointerDown={e => startPane(e, id)}
            style={{ ...pos(z), cursor: 'pointer', outline: edge(line), outlineOffset: -1, pointerEvents: 'auto' }}
          >
            {pane && <LayerCanvas canvas={pane.boosted} opacity={dim ? 0.1 : 1} />}
            <div style={{ ...header, background: `color-mix(in srgb, ${def.color} 28%, #16171f)`, outline: edge(line), outlineOffset: -1 }}>
              <span style={{ color: def.color }}>{def.glyph}</span>
              <span>{def.label}</span>
              <span style={{ flex: 1 }} />
              <button
                data-pane-fx={it.off ? 'off' : 'on'}
                title="Switch this card on or off"
                onPointerDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); toggleEffectOff(id) }}
                style={{ padding: '1px 6px', fontSize: 11, border: '1px solid rgba(255,255,255,.25)', borderRadius: 5, color: '#fff', cursor: 'pointer', background: it.off ? 'transparent' : 'rgba(255,255,255,.2)', opacity: it.off ? 0.6 : 1 }}
              >FX</button>
            </div>
          </div>
        )
      })}
    </>
  )
}

/** Under the tilted world: every docked strip's layers, drawn with the same
 *  camera. Flat it shows nothing and costs nothing. */
export const StripLayersStage: React.FC = () => {
  const stage = useTiltStage()
  const swung = useTiltStore(s => Math.abs(s.yaw) > 0.5 || s.tilt < -0.5)
  const zoom = useCanvasStore(s => s.zoom)
  const pan = useCanvasStore(s => s.pan)
  const nodes = useFreeNodeStore(s => s.nodes)
  const windows = useViewport3DStore(s => s.windows)
  const active = useRailUiStore(s => s.active)
  const layersOn = useStripLayers(s => s.on)
  const docks = swung && layersOn ? railViewerDocks(nodes, windows, zoom) : null
  return (
    <div ref={stage} data-tilt-layers="" style={{ position: 'absolute', inset: 0, transformOrigin: '50% 50%', transformStyle: 'preserve-3d', pointerEvents: 'none' }}>
      {docks && [...docks].map(([winId, docked]) => {
        const railId = viewerRail(docked, active)
        const w = windows[winId]
        if (!railId || !w) return null
        const a = pictureAreas.get(winId) ?? { x: 0, y: 0, width: w.width, height: w.height }
        return <StripLayers key={winId} railId={railId} rect={{ x: pan.x + (w.x + a.x) * zoom, y: pan.y + (w.y + a.y) * zoom, width: a.width * zoom, height: a.height * zoom }} />
      })}
      {swung && <FilmMixerLayers />}
    </div>
  )
}
