// ExplodedStrip — a loop strip's effect cards hung in depth behind its Viewer,
// seen by swinging the canvas sideways (store/tiltStore yaw). The picture is
// the back plate; each effect card is a pane in strip order holding only what
// that card changes. They live on a stage of their own under the tilted world,
// with its transform, so the plane and what is on it hide them as they should.
//
// Experimental (branch exploded-strip). Nothing is stored here: panes are baked
// from the strip's own run, and solo, FX and reorder write to the strip itself.


import React, { useEffect, useMemo, useRef, useState } from 'react'
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

type EffectItem = Extract<ChainItem, { kind: 'effect' }>

/** Long edge the panes are baked at. */
const BAKE_SIDE = 1000

interface Pane { id: string; exact: HTMLCanvasElement; boosted: HTMLCanvasElement }

/** What `after` lays over `before`, as colour and alpha: the least alpha that
 *  can make the change, so laying the pane over `before` gives back `after`
 *  (`exact`). `boosted` lifts faint alpha so it can be seen on its own. */
function unmix(before: HTMLCanvasElement, after: HTMLCanvasElement): Pane & { id: '' } {
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

/** The stack's pictures: the plate, and a pane per effect card. A card
 *  switched off gets the pane it would have, there to switch back on. Solo is
 *  left out, so every pane keeps its layer while one is soloed. */
async function bake(items: ChainItem[]): Promise<{ plate: HTMLCanvasElement; panes: Pane[] } | null> {
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
  return { plate, panes }
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
const GAP = 0.5
/** How far round a swing has fully fanned the panes, degrees. */
const FAN_AT = 35
/** How far tipped back they have fully closed again, degrees. */
const CLOSE_AT = 40

const Canvas: React.FC<{ canvas: HTMLCanvasElement; opacity?: number }> = ({ canvas, opacity = 1 }) => {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = host.current
    if (!el) return
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'
    el.replaceChildren(canvas)
  }, [canvas])
  return <div ref={host} style={{ position: 'absolute', inset: 0, opacity, pointerEvents: 'none' }} />
}

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
  const fan = useTiltStore(s => {
    // Open when swung from top-down; tipping the view back closes them, smoothly,
    // since then you are looking round a model, not at the layers. Tipped the
    // other way no model stands up, so they stay open.
    const smooth = (k: number) => { const c = Math.max(0, Math.min(1, k)); return c * c * (3 - 2 * c) }
    return Math.round(smooth(Math.abs(s.yaw) / FAN_AT) * (1 - smooth(Math.max(0, s.tilt) / CLOSE_AT)) * 200) / 200
  })

  // Re-baked when what the layers are made of changes; not for a solo.
  const sig = JSON.stringify((items ?? []).map(it => (it.kind === 'effect' ? { ...it, solo: false } : it)))
  const [baked, setBaked] = useState<{ plate: HTMLCanvasElement; panes: Pane[] } | null>(null)
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
  const spread = Math.max(40, boxH * GAP)
  const gap = spread * fan
  // Plate furthest back; the last card right behind the Viewer's own face.
  const zOf = (i: number) => -(order.length - i) * gap
  const stepTo = (id: string, dz: number) => Math.max(0, Math.min(order.length - 1, order.indexOf(id) + Math.round(dz / spread)))
  const shown = (() => {
    if (!drag) return order
    const next = order.filter(id => id !== drag.id)
    next.splice(stepTo(drag.id, drag.dz), 0, drag.id)
    return next
  })()

  // A press on a pane: dragged, it moves in depth; let go in place, a solo.
  const startPane = (e: React.PointerEvent, id: string) => {
    e.stopPropagation()
    const { tilt, yaw } = useTiltStore.getState()
    const b = yaw * Math.PI / 180, t = tilt * Math.PI / 180
    // Which way depth runs on the screen: the plane's normal, Ry·Rx·z.
    const vx = Math.cos(t) * Math.sin(b), vy = -Math.sin(t)
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

  if (!baked || fan === 0) return null
  const left = rect.x + (rect.width - boxW) / 2, top = rect.y + (rect.height - boxH) / 2
  const edge = (c: string) => `1.5px solid ${c}`
  const header: React.CSSProperties = { position: 'absolute', left: 0, right: 0, bottom: '100%', display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', fontSize: 13, color: '#fff', padding: '5px 8px', borderRadius: '7px 7px 0 0', boxSizing: 'border-box' }
  const pos = (z: number): React.CSSProperties => ({ position: 'absolute', left, top, width: boxW, height: boxH, transform: `translateZ(${z}px)` })
  return (
    <>
      <div style={{ ...pos(zOf(-1)), outline: edge('rgba(255,255,255,.25)'), pointerEvents: 'none' }}>
        <Canvas canvas={baked.plate} />
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
            {pane && <Canvas canvas={pane.boosted} opacity={dim ? 0.1 : 1} />}
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
  const swung = useTiltStore(s => Math.abs(s.yaw) > 0.5)
  const zoom = useCanvasStore(s => s.zoom)
  const pan = useCanvasStore(s => s.pan)
  const nodes = useFreeNodeStore(s => s.nodes)
  const windows = useViewport3DStore(s => s.windows)
  const active = useRailUiStore(s => s.active)
  const docks = swung ? railViewerDocks(nodes, windows, zoom) : null
  return (
    <div ref={stage} data-tilt-layers="" style={{ position: 'absolute', inset: 0, transformOrigin: '50% 50%', transformStyle: 'preserve-3d', pointerEvents: 'none' }}>
      {docks && [...docks].map(([winId, docked]) => {
        const railId = viewerRail(docked, active)
        const w = windows[winId]
        if (!railId || !w) return null
        return <StripLayers key={winId} railId={railId} rect={{ x: pan.x + w.x * zoom, y: pan.y + w.y * zoom, width: w.width * zoom, height: w.height * zoom }} />
      })}
    </div>
  )
}

/** The view the Layers button left, to come back to. */
let flatView: { pan: { x: number; y: number }; zoom: number } | null = null

function easeCanvas(to: { pan: { x: number; y: number }; zoom: number }, each: (k: number) => void): void {
  const from = useCanvasStore.getState(), pan0 = from.pan, zoom0 = from.zoom, start = performance.now()
  const step = () => {
    const t = Math.min(1, (performance.now() - start) / 600)
    const k = 1 - Math.pow(1 - t, 3)
    useCanvasStore.setState({
      pan: { x: pan0.x + (to.pan.x - pan0.x) * k, y: pan0.y + (to.pan.y - pan0.y) * k },
      zoom: zoom0 + (to.zoom - zoom0) * k,
    })
    each(k)
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

/** Ease the camera to a sideways look at a Viewer, its layers running off to
 *  the right, clear of the strip on its left; or back where it was. */
export function swingToLayers(rect: DOMRect): void {
  const tilt = useTiltStore.getState()
  if (Math.abs(tilt.yaw) > 1) {
    tilt.flatten()
    if (flatView) easeCanvas(flatView, () => {})
    flatView = null
    return
  }
  const host = document.querySelector('[data-tilt-layers]')?.parentElement?.getBoundingClientRect()
  if (!host) return
  const { pan, zoom } = useCanvasStore.getState()
  flatView = { pan, zoom }
  const z1 = zoom * Math.min(2, host.height * 0.5 / rect.height)
  const cx = (rect.x + rect.width / 2 - host.x - pan.x) / zoom, cy = (rect.y + rect.height / 2 - host.y - pan.y) / zoom
  // The Viewer a little left of the middle, for its layers to the right of it.
  const to = { x: host.width * 0.38 - cx * z1, y: host.height * 0.5 - cy * z1 }
  easeCanvas({ pan: to, zoom: z1 }, k => {
    const s = useTiltStore.getState()
    s.setView(s.tilt, s.spin, -48 * k)
  })
}
