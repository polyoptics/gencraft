// ExplodedStrip — a loop strip's effect cards fanned out in depth behind the
// Viewer. The picture is the back plate; each effect card is a pane in strip
// order holding only what that card changes. Seen straight on the stack is
// exactly the strip's result; swung round, it says which layer does what.
//
// Experimental (branch exploded-strip). Nothing is stored here: panes are baked
// from the strip's own run, and solo, FX and reorder write to the strip itself.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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

const POSES = {
  front: { yaw: 0, pitch: 0 },
  side: { yaw: 58, pitch: 12 },
  behind: { yaw: 142, pitch: 10 },
}

const Canvas: React.FC<{ canvas: HTMLCanvasElement; opacity?: number }> = ({ canvas, opacity = 1 }) => {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = host.current
    if (!el) return
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'
    el.replaceChildren(canvas)
  }, [canvas])
  return <div ref={host} style={{ position: 'absolute', inset: 0, opacity, transition: 'opacity .5s', pointerEvents: 'none' }} />
}

export const ExplodedStrip: React.FC<{ railId: string; onClose: () => void }> = ({ railId, onClose }) => {
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

  // The stack starts exactly over the Viewer's picture, then swings round.
  const from = useRef(document.querySelector(`[data-rail-viewer="${railId}"]`)?.getBoundingClientRect() ?? null)
  const [open, setOpen] = useState(false)
  const [yaw, setYaw] = useState(POSES.side.yaw)
  const [pitch, setPitch] = useState(POSES.side.pitch)
  const [spread, setSpread] = useState(190)
  const [held, setHeld] = useState(false)
  const [drag, setDrag] = useState<{ id: string; dz: number } | null>(null)
  useEffect(() => {
    if (!baked || open) return
    const t = window.setTimeout(() => setOpen(true), 60)
    return () => window.clearTimeout(t)
  }, [baked, open])
  const close = useRef(() => {})
  close.current = () => {
    setOpen(false)
    window.setTimeout(onClose, 650)
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close.current() } }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])

  const W = window.innerWidth, H = window.innerHeight
  const aspect = baked ? baked.plate.width / baked.plate.height : 1
  const boxH = Math.min(H * 0.56, (W * 0.42) / aspect), boxW = boxH * aspect
  const homeK = from.current ? Math.min(from.current.width / boxW, from.current.height / boxH) : 1
  const homeX = from.current ? from.current.x + from.current.width / 2 - W / 2 : 0
  const homeY = from.current ? from.current.y + from.current.height / 2 - H / 2 : 0
  const y = open ? yaw : 0, p = open ? pitch : 0
  // Straight on the panes close up and show exactly the strip's result.
  const flat = !open || (Math.abs(Math.sin(yaw * Math.PI / 180)) < 0.03 && Math.cos(yaw * Math.PI / 180) > 0 && Math.abs(pitch) < 2)
  const gap = flat ? 0 : spread

  // Plate at the back, each layer nearer: the strip's order, read in depth.
  const order = effects.map(e => e.id)
  const shown = useMemo(() => {
    if (!drag) return order
    const from = order.indexOf(drag.id)
    const to = Math.max(0, Math.min(order.length - 1, from + Math.round(drag.dz / Math.max(1, spread))))
    const next = order.filter(id => id !== drag.id)
    next.splice(to, 0, drag.id)
    return next
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, order.join(), spread])
  const mid = (order.length + 1) / 2
  const zOf = (i: number) => (i + 1 - mid) * gap

  const startOrbit = (e: React.PointerEvent) => {
    e.stopPropagation()
    const sx = e.clientX, sy = e.clientY, y0 = yaw, p0 = pitch
    setHeld(true)
    const move = (m: PointerEvent) => {
      setYaw(y0 + (m.clientX - sx) * 0.3)
      setPitch(Math.max(-60, Math.min(60, p0 - (m.clientY - sy) * 0.2)))
    }
    const up = () => { setHeld(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // A press on a pane: dragged, it moves in depth; let go in place, a solo.
  const startPane = (e: React.PointerEvent, id: string) => {
    // Alt is the camera modifier: with it held, a pane is just more view.
    if (e.altKey) { startOrbit(e); return }
    e.stopPropagation()
    const sx = e.clientX, sy = e.clientY
    const ry = yaw * Math.PI / 180, rp = pitch * Math.PI / 180
    const vx = Math.sin(ry), vy = -Math.cos(ry) * Math.sin(rp)
    const len2 = vx * vx + vy * vy
    let moved = false, dz = 0
    const move = (m: PointerEvent) => {
      const dx = m.clientX - sx, dy = m.clientY - sy
      if (!moved && Math.hypot(dx, dy) < 6) return
      if (len2 < 0.02) return   // Straight on, depth has no direction on screen.
      moved = true
      dz = (dx * vx + dy * vy) / len2
      setDrag({ id, dz })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      if (!moved) { toggleEffectSolo(id); return }
      const at = order.indexOf(id)
      const to = Math.max(0, Math.min(order.length - 1, at + Math.round(dz / Math.max(1, spread))))
      if (to === at) return
      const next = order.filter(x => x !== id)
      next.splice(to, 0, id)
      moveCard(railId, next)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const eased = held || drag ? 'none' : 'transform .65s cubic-bezier(.3,.7,.2,1)'
  const chip: React.CSSProperties = { padding: '5px 12px', fontSize: 12, border: '1px solid rgba(255,255,255,.2)', borderRadius: 6, background: 'rgba(255,255,255,.07)', color: 'rgba(255,255,255,.85)', cursor: 'pointer' }
  const label: React.CSSProperties = { position: 'absolute', left: 0, bottom: '100%', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', fontSize: 13, color: '#fff', textShadow: '0 1px 3px #000' }

  return createPortal(
    <div
      data-exploded-strip={railId}
      onPointerDown={startOrbit}
      onWheel={e => { e.stopPropagation(); setSpread(s => Math.max(30, Math.min(400, s - e.deltaY * 0.25))) }}
      onClick={e => e.stopPropagation()}
      onContextMenu={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      style={{
        position: 'fixed', inset: 0, zIndex: 100000, overflow: 'hidden', cursor: held ? 'grabbing' : 'grab', userSelect: 'none',
        perspective: 1800, background: open ? 'rgba(8,9,14,.88)' : 'rgba(8,9,14,0)', transition: 'background .5s',
      }}
    >
      {baked && (
        <div style={{
          position: 'absolute', left: '50%', top: '50%', width: boxW, height: boxH, marginLeft: -boxW / 2, marginTop: -boxH / 2,
          transformStyle: 'preserve-3d', transition: eased,
          transform: `translate(${open ? 0 : homeX}px, ${open ? 0 : homeY}px) scale(${open ? 1 : homeK}) rotateX(${p}deg) rotateY(${y}deg)`,
        }}>
          <div style={{ position: 'absolute', inset: 0, transform: `translateZ(${zOf(-1)}px)`, transition: eased, outline: flat ? 'none' : '1px solid rgba(255,255,255,.25)' }}>
            <Canvas canvas={baked.plate} />
            {!flat && <div style={label}>Picture</div>}
          </div>
          {shown.map((id, at) => {
            const it = effects.find(e => e.id === id)!
            const pane = baked.panes.find(b => b.id === id)
            const def = EFFECTS[knownKind(it.effect)]
            const dragged = drag?.id === id
            const z = dragged ? zOf(order.indexOf(id)) + drag!.dz : zOf(at)
            const dim = !!it.off || (!!soloed && soloed !== id)
            return (
              <div
                key={id}
                data-pane={id}
                onPointerDown={e => startPane(e, id)}
                style={{
                  position: 'absolute', inset: 0, cursor: 'pointer', transition: dragged ? 'none' : `transform .3s, opacity .25s`,
                  transform: `translateZ(${z}px)`,
                  outline: flat ? 'none' : `1.5px solid ${soloed === id ? '#fff' : dim ? 'rgba(255,255,255,.18)' : def.color}`, outlineOffset: -1,
                  background: open ? 'rgba(255,255,255,.015)' : 'transparent',
                }}
              >
                {pane && <>
                  <Canvas canvas={pane.exact} opacity={!it.off && !dim && flat ? 1 : 0} />
                  <Canvas canvas={pane.boosted} opacity={flat ? 0 : dim ? 0.1 : 1} />
                </>}
                {!flat && (
                  <div style={{ ...label, right: 0, marginBottom: 0, padding: '5px 8px', borderRadius: '7px 7px 0 0', background: `color-mix(in srgb, ${def.color} 28%, #16171f)`, outline: `1.5px solid ${soloed === id ? '#fff' : dim ? 'rgba(255,255,255,.18)' : def.color}`, outlineOffset: -1 }}>
                    <span style={{ color: def.color }}>{def.glyph}</span>
                    <span>{def.label}</span>
                    <span style={{ flex: 1 }} />
                    <button
                      data-pane-fx={it.off ? 'off' : 'on'}
                      title="Switch this card on or off"
                      onPointerDown={e => e.stopPropagation()}
                      onClick={e => { e.stopPropagation(); toggleEffectOff(id) }}
                      style={{ ...chip, padding: '1px 6px', fontSize: 11, background: it.off ? 'transparent' : 'rgba(255,255,255,.2)', opacity: it.off ? 0.6 : 1 }}
                    >FX</button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      <div
        onPointerDown={e => e.stopPropagation()}
        style={{ position: 'absolute', left: '50%', bottom: 22, transform: 'translateX(-50%)', display: 'flex', gap: 8, alignItems: 'center', opacity: open ? 1 : 0, transition: 'opacity .4s' }}
      >
        {(Object.keys(POSES) as (keyof typeof POSES)[]).map(k => (
          <button key={k} style={{ ...chip, textTransform: 'capitalize' }} onClick={() => { setYaw(POSES[k].yaw); setPitch(POSES[k].pitch) }}>{k}</button>
        ))}
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,.5)', margin: '0 8px' }}>drag to swing · scroll to spread · click a pane to solo · drag a pane to reorder</span>
        <button style={chip} onClick={() => close.current()}>Close</button>
      </div>
    </div>,
    document.body,
  )
}
