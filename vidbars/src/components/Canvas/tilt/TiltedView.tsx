import React, { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTiltStore, useModelScaleStore, offFlat, unprojectTilt, TILT_FAR } from '../../../store/tiltStore'
import { useCanvasStore, MIN_ZOOM, MAX_ZOOM } from '../../../store/canvasStore'
import { useFreeNodeStore } from '../../../store/freeNodeStore'
import { useBoardsStore } from '../../../store/boardsStore'
import { clientToCanvas } from '../../../utils/fx/createEffect'
import { hostOf, viewCentre } from './altCamera'
import {
  grip, models, modelKey, restKeyOf, veiled, chained, filled, widened, consoleEase, decoPlanes, type Hinge, stood, hingeOf, lifted, liftOf, marqueeSelect, selectModel,
} from './TiltModels'
import { LightPanel } from './LightPanel'
import { seeWallDrop, storyWallOf } from '../StorylineLayer'
import { useLinkDragStore } from '../../../store/linkDragStore'

export const TiltedView: React.FC = () => {
  const rootRef = useRef<HTMLDivElement>(null)
  const [band, setBand] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const texture = useTiltStore(s => s.texture)
  const shade = useTiltStore(s => s.shade)
  const wire = useTiltStore(s => s.wire)
  const [lightOpen, setLightOpen] = useState(false)
  const turn = useTiltStore(s => s.turn)
  const walls = useTiltStore(s => s.walls)
  const figure = useTiltStore(s => s.figure)
  const tilt = useTiltStore(offFlat)
  const lock3d = useTiltStore(s => s.lock3d)

  // ── Working on the tilted plane ──
  // The browser hit-tests the tilted DOM correctly, so a press lands on the
  // card under the cursor. Everything that card does with the press,
  // though, is flat-view math on clientX/Y. So the press and every move
  // and release that follow are re-sent to it at the FLAT point under the
  // cursor (the real ones are swallowed): dragging, resizing and
  // repositioning work on the ground exactly as they do flat.
  // Middle drag moves the camera in its own view plane (Maya's pan). The
  // wheel zooms straight in toward the middle of the view, but over a panel
  // that keeps it flat (a list scrolling), the panel has it. Right-click is
  // left alone, so menus open where the cursor is.
  useEffect(() => {
    const root = rootRef.current!
    const host = hostOf(root)!
    const flatClient = (cx: number, cy: number, height = 0, hinge?: Hinge) => {
      const r = host.getBoundingClientRect()
      const { tilt: t, spin: s, shiftX, shiftY } = useTiltStore.getState()
      const sx = cx - r.left - r.width / 2, sy = cy - r.top - r.height / 2
      let p = unprojectTilt(sx, sy, t, s, shiftX, shiftY, height, TILT_FAR)
      if (hinge) {
        // A standing card: find the height at which the ray meets its face
        // (a point d behind the hinge line on the plane stands d·tan a up),
        // then lay that point back down flat on the card.
        const tan = Math.tan(hinge.a)
        const off = (h: number) => {
          const q = unprojectTilt(sx, sy, t, s, shiftX, shiftY, h)
          return q ? h - hinge.z - Math.max(0, hinge.v - q.y) * tan : 1
        }
        let lo = hinge.z, hi = hinge.z + Math.max(r.width, r.height) * 2
        for (let i = 0; i < 32; i++) { const mid = (lo + hi) / 2; if (off(mid) > 0) hi = mid; else lo = mid }
        const q = unprojectTilt(sx, sy, t, s, shiftX, shiftY, lo, TILT_FAR)
        // How far up the face that point is: its run across the plane and
        // its rise, as one length. Straight up (a storyline's wall) the run
        // is nothing, and read off it alone (run / cos a) it ran away to
        // ten billion px: the card flew off and the app froze drawing it.
        p = q && { x: q.x, y: hinge.v - Math.hypot(Math.max(0, hinge.v - q.y), lo - hinge.z) }
      }
      return p && { x: p.x + r.width / 2 + r.left, y: p.y + r.height / 2 + r.top }
    }
    /** Pressed on the tilted canvas (not a pinned panel, the HUD, the zoom bar). */
    // Seen low or side-on, much of the screen shows no plane at all, only
    // the canvas behind it: that counts as the canvas too (bare ground), so
    // the camera can be grabbed anywhere.
    const canvasBox = () => document.querySelector('[data-tilt-stage="world"]')?.parentElement ?? null
    const onPlane = (t: EventTarget | null) => {
      const el = t as Element | null
      if (!el?.closest || hostOf(el) !== host) return false
      return !!el.closest('[data-tilt-stage]') || !!canvasBox()?.contains(el)
    }
    /** Over the tilted plane itself, or the bare canvas round it: not a
     *  menu, pinned panel or zoom bar drawn over the view (the canvas box's
     *  other children, and its host's), nor the HUD. */
    const overView = (t: EventTarget | null) => {
      const el = t as Element | null
      if (!el?.closest || hostOf(el) !== host) return false
      return !!el.closest('[data-tilt-stage]') || el === canvasBox()
    }
    const isBareGround = (t: EventTarget | null) => {
      const el = t as Element
      return el.matches('[data-tilt-stage="world"]') || !el.closest('[data-tilt-stage]')
    }

    // The last flat point a re-sent event went to. Where the cursor shows no
    // plane under it (past the horizon, or so near it the point is lost),
    // a release still has to arrive, or the drag it ends never ends and the
    // card sticks to the cursor (Brian 2026-10-30): it goes here.
    let lastFlat: { x: number; y: number } | null = null
    /** A press that drags something standing (a console Viewer by its
     *  header) or furniture (a strip by its sloped back): its moves are
     *  read on the level plane through the point grabbed, `h` px up, and
     *  sent relative to the press (`p0`, sent; `q0`, that plane's point
     *  then). Read on the standing face itself, the face moving with the
     *  drag moved the point read, and the Viewer ran off. */
    let rel: { h: number; q0: { x: number; y: number }; p0: { x: number; y: number } } | null = null
    /** A press on furniture: its native click (and double-click) would go to
     *  whatever is hidden behind it (a strip's header): kept from it. */
    let eatClick = false
    /** A button a press was re-sent to, for its click (see onClick). */
    let clickTo: HTMLElement | null = null
    /** A row's zone a press was re-sent to (see flatTarget), for its
     *  double-click: the browser's own goes to the card it sees standing. */
    let dblTo: HTMLElement | null = null
    /** `on`: read on this surface (see surfaceAt), not on `to`'s own. */
    const resend = (e: MouseEvent, type: string, to: EventTarget, height = 0, at?: { x: number; y: number }, on?: Surface) => {
      // A lifted tile is pressed at its own height, not the floor's.
      let p = at ?? null
      if (!p && rel) {
        const q = flatClient(e.clientX, e.clientY, rel.h)
        p = q && { x: rel.p0.x + q.x - rel.q0.x, y: rel.p0.y + q.y - rel.q0.y }
      } else if (!p && on) p = on.at ?? flatClient(e.clientX, e.clientY, on.height, on.hinge)
      else if (!p) p = flatClient(e.clientX, e.clientY, height, hingeOf(to as Element))
      if (p) lastFlat = p
      else if (lastFlat && /up$|cancel$/.test(type)) p = lastFlat
      if (!p) return
      // While the re-sent event runs, a handler asking what is under a point
      // (a card let go: what it drops into) gets the flat view's answer: see
      // flatHit.
      hitAt = true
      try { return send(e, type, to, p) } finally { hitAt = false; standBack() }
    }
    /** What a press hits, as the flat view has it. The browser's own hit
     *  test on a tilted or leaning card can pick a layer under the one in
     *  front at steep angles (the card's face under a slider row: the
     *  slider never saw the press). The flat view at the same point, kept
     *  to the tile, card or Viewer pressed, is what 2D would hit. */
    const flatTarget = (e: MouseEvent, target: Element, height: number): Element => {
      const unit = target.closest('[data-freenode][data-id], [data-group-card], [data-viewport3d]')
      if (!unit) return target
      // A row's zone over its primary card (CardLayer DeckAffordance) lies
      // over that card flat, so flat it takes the press: the row's drag,
      // its grip and Flip, its double-click to close. It is part of it here.
      const row = unit.matches('[data-group-card][data-id]') ? (unit as HTMLElement).dataset.id : undefined
      const hinge = hingeOf(target)
      const p = flatClient(e.clientX, e.clientY, height, hinge)
      if (!p) return target
      // The raised part pressed on a standing face (a button proud of a
      // leaning card, a standing Viewer's header), if any.
      let part: Element | null = null
      if (hinge) for (let t: Element | null = target; t && t !== unit; t = t.parentElement) if ((lifted.get(t as HTMLElement) ?? 0) > 0) { part = t; break }
      hitAt = true
      try {
        layFlat(target, unit)
        for (const el of document.elementsFromPoint(p.x, p.y)) {
          if (!unit.contains(el) && !(row && el.closest<HTMLElement>('[data-row-of]')?.dataset.rowOf === row)) continue
          // A raised part is seen a little off its flat place, so near its
          // edge the flat point can miss it, for what holds it or the face
          // beside it (the on/off button's bottom edge, over the card's
          // art): pressed where it shows, it is the one.
          if (el !== target && el.contains(target)) {
            for (let t: Element | null = target; t && t !== el; t = t.parentElement) if ((lifted.get(t as HTMLElement) ?? 0) > 0) return target
          }
          if (part && !part.contains(el)) return target
          return el
        }
      } finally { hitAt = false; standBack() }
      return target
    }
    /** What lies under the cursor, to read a move on: a drag begun on
     *  something standing (a column by its tab, a Viewer's corner) goes
     *  where the cursor goes, as flat — onto another card's face, a look
     *  row, another strip, a picture card — not along its own face. Over a
     *  sloped back, its row's cards' plane (what is there flat); over the
     *  lip in front, the level of their bottom edges. `at`: the flat point
     *  itself, when it is not read off the cursor (a card carried over a
     *  strip lying down for it, see readOn). */
    type Surface = { height: number; hinge?: Hinge; at?: { x: number; y: number } }
    /** The surface the last move was read on. */
    let lastSurface: Surface | null = null
    const surfaceAt = (e: MouseEvent, real: Element): Surface => (lastSurface = surfaceUnder(e, real))
    const surfaceUnder = (e: MouseEvent, real: Element): Surface => {
      const key = overView(real) ? models.pick?.(e.clientX, e.clientY) : null
      // A solid part three.js draws with nothing of the page there (a tab's
      // or a card's side wall, the seam between them): still on what was
      // under the cursor a moment ago, not on the floor seen past it.
      if (key === '' && lastSurface && isBareGround(real)) return lastSurface
      if (key?.startsWith('deco|rail:')) {
        const owner = key.slice('deco|'.length)
        const r = host.getBoundingClientRect()
        const local = (p: { x: number; y: number }) => ({ x: p.x - r.left - r.width / 2, y: p.y - r.top - r.height / 2 })
        const within = (pl: typeof decoPlanes[number], q: { x: number; y: number }) => q.x >= pl.x0 && q.x <= pl.x1 && q.y >= pl.v0 - 1 && q.y <= pl.v1 + 1
        // Its level tops (the deck, a shelf, the lip) at the height hit; else
        // the slope, on its cards' plane.
        const z = models.pickZ?.() ?? 0
        for (const pl of decoPlanes) {
          if (pl.owner !== owner || pl.hinge || Math.abs(pl.z - z) > 1.5) continue
          const q = flatClient(e.clientX, e.clientY, pl.z)
          if (q && within(pl, local(q))) return { height: pl.z }
        }
        // A strip's rows each have their slope: the one hit, the one whose
        // plane the ray meets nearest the height hit (the look row's in front
        // of the strip's own row can lie inside both spans). Met on its level
        // part in front of its hinge (laid on the hinge line), it is off by
        // how far in front too: the foot of a look row, its lip and the
        // bottom of its gaps, is not the strip's own row far behind.
        let slope: { pl: typeof decoPlanes[number]; off: number } | undefined
        for (const pl of decoPlanes) {
          const h = pl.hinge
          if (pl.owner !== owner || !h) continue
          const q = flatClient(e.clientX, e.clientY, 0, h)
          const f = q && local(q)
          if (!f || !within(pl, f)) continue
          const lv = flatClient(e.clientX, e.clientY, h.z)
          const off = Math.abs(h.z + Math.max(0, h.v - f.y) * Math.sin(h.a) - z) + (lv ? Math.max(0, local(lv).y - h.v) : 0)
          if (!slope || off < slope.off) slope = { pl, off }
        }
        if (slope) return { height: slope.pl.hinge!.z, hinge: slope.pl.hinge }
        // A wall of it (the deck's front, the bar tier's): the level through
        // the point hit, straight under it, not the floor seen past it.
        return { height: z }
      }
      return { height: liftOf(real), hinge: hingeOf(real) }
    }
    /** Let go of a re-sent press whose own release never came: as a
     *  release, left button, so every drag handler takes it as one. At the
     *  flat point given, else where its last event went. */
    const release = (e: MouseEvent, r: { target: Element; height: number }, at?: { x: number; y: number } | null) => {
      const up = { button: 0, buttons: 0, detail: e.detail, clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
        altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey,
        pointerId: (e as PointerEvent).pointerId ?? 1, pointerType: (e as PointerEvent).pointerType ?? 'mouse', isPrimary: true,
        pressure: 0, width: 1, height: 1 } as unknown as PointerEvent
      const p = at ?? lastFlat ?? undefined
      resend(up, 'pointerup', r.target, r.height, p)
      resend(up, 'mouseup', r.target, r.height, p)
    }
    // The card pressed can be re-rendered away mid-drag (a deck leaving a
    // Viewer's side swaps how it is drawn). Events sent to the old,
    // detached element reach nobody, not even the window listeners that
    // run the drag: the card stopped following, the release never ended
    // the drag, and it then stuck to the cursor (Brian 2026-10-30). Sent to
    // the page instead, they still reach those listeners.
    const reachable = (to: EventTarget) => (to instanceof Node && !to.isConnected ? document.body : to)
    const send = (e: MouseEvent, type: string, to: EventTarget, p: { x: number; y: number }) => {
      to = reachable(to)
      const init: PointerEventInit = {
        bubbles: true, cancelable: true, composed: true, view: window, detail: e.detail,
        clientX: p.x, clientY: p.y,
        screenX: e.screenX + (p.x - e.clientX), screenY: e.screenY + (p.y - e.clientY),
        button: e.button, buttons: e.buttons,
        altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey,
      }
      if (type.startsWith('pointer')) {
        const pe = e as PointerEvent
        return to.dispatchEvent(new PointerEvent(type, {
          ...init, pointerId: pe.pointerId, pointerType: pe.pointerType, isPrimary: pe.isPrimary,
          pressure: pe.pressure, width: pe.width, height: pe.height,
        }))
      }
      if (type === 'wheel') {
        const we = e as WheelEvent
        return to.dispatchEvent(new WheelEvent(type, { ...init, deltaX: we.deltaX, deltaY: we.deltaY, deltaZ: we.deltaZ, deltaMode: we.deltaMode }))
      }
      return to.dispatchEvent(new MouseEvent(type, init))
    }

    // Hit tests during a re-sent event. Its handlers work in flat points, so
    // they are answered from the flat view: the stages are laid flat (and
    // anything stood up or unclipped for 3D put back) for the moment of the
    // ask; no frame is drawn in between. Answered from the tilted view, the
    // cursor's ray reached on past the card in hand into whatever stands up
    // in front of it (a deck's tall stack, a card on a Viewer), and a card
    // let go there was merged into that one: only ever in 3D (Brian
    // 2026-10-30, cards found "inside another random card").
    // Boxes measured then (a slider's track under a re-sent flat point, a
    // drop slot) are the flat view's too: measured tilted, a slider on a
    // tilted card jumped to the wrong value. Laid flat at the first ask and
    // stood back up once the event is done, so many asks cost one.
    let hitAt = false
    let flatUndo: (() => void)[] | null = null
    const layFlat = (along?: Element, unit?: Element) => {
      if (flatUndo) return
      const undo: (() => void)[] = flatUndo = []
      const put = (el: HTMLElement, prop: 'transform' | 'rotate' | 'translate' | 'overflow' | 'width' | 'borderRadius' | 'visibility' | 'transformStyle', v: string) => {
        const was = el.style[prop]
        if (was === v) return
        el.style[prop] = v
        // Put back only if nothing has written it since (the camera moving
        // the stage within the event).
        undo.push(() => { if (el.style[prop] === v) el.style[prop] = was })
      }
      for (const st of document.querySelectorAll<HTMLElement>('[data-tilt-stage]')) put(st, 'transform', 'none')
      for (const [el, was] of stood) {
        put(el, 'rotate', was.rotate)
        if (was.wrote) put(el, 'transform', was.transform)
        if (el.hasAttribute('data-cabinet-tray')) put(el, 'translate', '')
      }
      for (const [el, was] of chained) put(el, 'overflow', was.ov)
      for (const [el, was] of veiled) put(el, 'visibility', was)
      // And what 3D reshapes that takes the pointer: a deck's click-to-fan
      // strip stretched over its stepped pages, Run's pill corners.
      for (const [el, was] of widened) put(el, 'width', was)
      for (const [el, f] of filled) if (f.was.borderRadius !== undefined) put(el, 'borderRadius', f.was.borderRadius)
      // And what a press is on (`along`, up to its tile, card or Viewer:
      // `unit`) neither raised nor kept in 3D. Each raised box, and each one
      // kept in 3D round a raised part, is a stacking layer of its own, so
      // what flat lifts over its neighbours by z-index sank under them: the
      // Viewer's x went under its NE resize corner, and a press on it
      // resized (or did nothing). Raised parts elsewhere stay as they are.
      for (let t: Element | null = along ?? null; unit && t && t !== unit.parentElement; t = t.parentElement) {
        const el = t as HTMLElement
        if (lifted.has(el)) put(el, 'translate', '')
        const was = chained.get(el)
        if (was) put(el, 'transformStyle', was.ts)
      }
    }
    const standBack = () => {
      const undo = flatUndo
      flatUndo = null
      if (undo) for (let i = undo.length - 1; i >= 0; i--) undo[i]()
    }
    const flatHit = <T,>(ask: () => T): T => {
      if (hitAt) layFlat()
      return ask()
    }
    const fromPoint = document.elementFromPoint, fromPoints = document.elementsFromPoint
    const rectOf = Element.prototype.getBoundingClientRect, rectsOf = Element.prototype.getClientRects
    document.elementFromPoint = function (x: number, y: number) { return flatHit(() => fromPoint.call(this, x, y)) }
    document.elementsFromPoint = function (x: number, y: number) { return flatHit(() => fromPoints.call(this, x, y)) }
    Element.prototype.getBoundingClientRect = function () { return flatHit(() => rectOf.call(this)) }
    Element.prototype.getClientRects = function () { return flatHit(() => rectsOf.call(this)) }

    type Gesture =
      | { kind: 'pan'; last: { x: number; y: number } }
      | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; add: boolean }
      | { kind: 'person'; url: string; unit0: number; y0: number }
      | { kind: 'model'; key: string; k0: number; y0: number; moved: boolean }
      | { kind: 'remap'; target: Element; pointerId: number; height: number; stood?: boolean; x0?: number; y0?: number; free?: boolean; tab?: { at: { x: number; y: number }; went?: boolean }; lay?: Map<string, string>; last?: { x: number; y: number }; wall?: Hinge }
    let g: Gesture | null = null
    /** A right press on furniture: its menu is its owner's (see onMenu). */
    let menuTo: Element | null = null
    const swallow = (e: Event) => { e.stopImmediatePropagation() }

    /** A drag from something standing is read on what is under the cursor
     *  (surfaceAt) once it has really left the press: before that, on the
     *  pressed part's own face, so a click's jitter across a seam (a tab's
     *  edge, where the floor far behind shows) cannot turn it into a drag
     *  that lands on another strip. */
    const loose = (r: Extract<Gesture, { kind: 'remap' }>, e: MouseEvent) =>
      (!!r.stood && (r.free ||= Math.hypot(e.clientX - (r.x0 ?? e.clientX), e.clientY - (r.y0 ?? e.clientY)) >= 6)) || inHand(r)
    /** Loose cards carried by the press `r` (where each card lay at the
     *  press: `lay`): the card pressed, the selection and the effect cards
     *  lined up after it, once they have moved. Read on the plane the press
     *  was on, the drag ran along the floor under whatever stands up: over
     *  a leaning card's face it went behind the strip, found no column
     *  there and was let go on the floor (hunt 2026-11-01). A carried
     *  card's drag goes where the cursor goes, as any drag from something
     *  standing: onto the face, a tab, the deck. */
    const carriedBy = (r: Extract<Gesture, { kind: 'remap' }>): ((id: string | undefined) => boolean) | null => {
      const lay = r.lay
      if (!lay) return null
      const docked = new Set(Object.values(useFreeNodeStore.getState().nodes).filter(n => n.cardRef && n.railDock && !n.railDock.lifted).map(n => n.cardRef!))
      const moved = new Set(useBoardsStore.getState().groups.filter(x => !docked.has(x.id) && lay.has(x.id) && lay.get(x.id) !== `${x.originX},${x.originY}`).map(x => x.id))
      return moved.size ? id => !!id && moved.has(id) : null
    }
    const inHand = (r: Extract<Gesture, { kind: 'remap' }>) => !!carriedBy(r)
    /** What is under the cursor past the cards in hand (they are drawn
     *  right under it: their faces, headers, link chips and blocks). */
    const pastHand = (e: MouseEvent, real: Element, mine: (id: string | undefined) => boolean): Element => {
      const card = (el: Element) => {
        const key = restKeyOf(el)
        if (key?.startsWith('card:')) return key.slice(5)
        const c = el.closest<HTMLElement>('[data-primary-rail], [data-layer-card]')
        return c?.dataset.primaryRail ?? c?.dataset.layerCard
      }
      if (!mine(card(real))) return real
      for (const el of document.elementsFromPoint(e.clientX, e.clientY)) if (!mine(card(el))) return el
      return real
    }
    /** The surface a move or release of `r` is read on (see loose), if not
     *  its own: a card carried is read past itself and lies on what that
     *  is (heldAt). */
    const readOn = (r: Extract<Gesture, { kind: 'remap' }>, e: MouseEvent, real: Element): Surface | undefined => {
      if (!loose(r, e)) return undefined
      const hand = carriedBy(r)
      if (!hand) return surfaceAt(e, real)
      const over = (n: { x: number; y: number; width: number; height: number }, c: { cx: number; cy: number }) =>
        c.cx >= n.x && c.cx <= n.x + n.width && c.cy >= n.y && c.cy <= n.y + n.height
      // Over a console strip that lies down for it, the card goes from where
      // it is as the cursor goes, on the level it lies at: the strip lay
      // down under the card. Read on what lying down shows the cursor (on
      // further back, or past the strip's edge), it jumped there, lost its
      // slot and the strip stood back up.
      const at0 = grip.handAt, last = r.last, from = lastFlat, h = grip.heldAt ?? 0
      const lying = useTiltStore.getState().console && at0 && last && from
        ? Object.values(useFreeNodeStore.getState().nodes).find(n => n.rail && !n.pin && (consoleEase.get(n.id) ?? 1) < 1 && over(n, { cx: at0.x, cy: at0.y }))
        : undefined
      if (lying) {
        const a = flatClient(last!.x, last!.y, h), b = flatClient(e.clientX, e.clientY, h)
        const at = a && b && { x: from!.x + b.x - a.x, y: from!.y + b.y - a.y }
        const c = at && clientToCanvas(at.x, at.y)
        if (c && over(lying, c)) {
          grip.handAt = { x: c.cx, y: c.cy }
          return { height: h, at: at! }
        }
      }
      const on = surfaceAt(e, pastHand(e, real, hand))
      grip.heldAt = on.height
      const p = flatClient(e.clientX, e.clientY, on.height, on.hinge)
      const c = p && clientToCanvas(p.x, p.y)
      grip.handAt = c ? { x: c.cx, y: c.cy } : null
      return on
    }
    /** On a standing storyline's wall: the card pressed is (`id`), or one
     *  the press carries is (`moved`), or a closed deck it is in. */
    const onWall = (id: string | undefined) => {
      if (!id) return false
      if (storyWallOf(id) !== null) return true
      const a = useBoardsStore.getState().groups.find(x => x.id === id)?.deckAnchorId
      return !!a && storyWallOf(a) !== null
    }
    /** The surface a move or release of `r` is read on, if not its own.
     *  A card's link "+" goes where the cursor goes, onto a face standing
     *  or lying: read on the floor under a standing face (from a card on
     *  the floor), it was let go on the card behind, or on the card where
     *  the face's detail was. A card, deck or row pressed on a storyline's
     *  wall stays on that wall's plane while it stays on the wall, as flat
     *  it follows the cursor: read on what is under the cursor (the floor
     *  behind the wall), it jumped off the cursor and drifted (2026-11-05).
     *  Carried off the wall (pulled out of its deck), it goes where the
     *  cursor goes from then on. */
    const readFor = (r: Extract<Gesture, { kind: 'remap' }>, e: MouseEvent, real: Element, held: boolean): Surface | undefined => {
      if (useLinkDragStore.getState().active) {
        // A standing storyline's dot under it (its own listener never
        // sees the move, kept from it here): the drop goes there.
        seeWallDrop(e.clientX, e.clientY)
        return surfaceAt(e, held ? fromPoint.call(document, e.clientX, e.clientY) ?? real : real)
      }
      if (r.wall) {
        const mine = carriedBy(r)
        const still = !mine || useBoardsStore.getState().groups.some(x => mine(x.id) && onWall(x.id))
        if (still) return { height: r.height, hinge: r.wall }
        r.wall = undefined
        r.free = true
      }
      return held ? undefined : readOn(r, e, real)
    }
    /** Space held down on the page (not typing), as InfiniteCanvas reads it. */
    let spaceHeld = false
    const onSpace = (e: Event) => {
      if (e.type === 'blur') spaceHeld = false
      else if ((e as KeyboardEvent).code === 'Space') spaceHeld = e.type === 'keydown' ? spaceHeld || e.target === document.body : false
    }
    const onDown = (e: PointerEvent) => {
      if (!e.isTrusted) return
      grip.heldRest = null
      grip.heldAt = null
      grip.handAt = null
      // A press still open from before (its release lost on the way) is let
      // go where it was, before this one starts: replaced unended, its card
      // kept following the bare mouse (Brian's deck stuck to the cursor).
      if (g?.kind === 'remap') release(e, g)
      g = null
      lastFlat = null
      lastSurface = null
      rel = null
      eatClick = false
      clickTo = null
      dblTo = null
      grip.carried = null
      menuTo = null
      models.at = null
      // A model is clicked straight in 3D: it selects its card or tile
      // (Shift adds to the selection). Not through a menu, pinned panel or
      // the zoom bar drawn over the view: they take their own presses.
      const key = (e.button === 0 || e.button === 2) && !e.altKey && overView(e.target) ? models.pick?.(e.clientX, e.clientY) : null
      if (key?.startsWith('deco|')) {
        // Console furniture. A strip's sloped back or lip is pressed as
        // its band (as in 2D: the strip moves, its Viewer with it); a
        // Viewer's strut or base as its header.
        const [kind, id] = key.slice('deco|'.length).split(':')
        const to = kind === 'rail'
          ? document.querySelector<HTMLElement>(`[data-freenode][data-id="${id}"] [data-rail-band]`)
          : document.querySelector<HTMLElement>(`[data-viewport3d="${id}"] [data-viewer-chrome]`)
        if (to && e.button === 2) {
          menuTo = to
          swallow(e)
          return
        }
        const h = models.pickZ?.() ?? 0
        const q0 = to && flatClient(e.clientX, e.clientY, h)
        if (to && q0) {
          e.preventDefault(); swallow(e)
          hitAt = true
          let r: DOMRect
          try { r = to.getBoundingClientRect() } finally { hitAt = false; standBack() }
          // On the band under the cursor; on the header at its middle.
          const p0 = { x: kind === 'rail' ? q0.x : r.left + r.width / 2, y: r.top + r.height / 2 }
          rel = { h, q0, p0 }
          eatClick = true
          // Dragged by its strut, a Viewer stays up till let go, as by its header.
          if (kind === 'viewer') grip.carried = id
          g = { kind: 'remap', target: to, pointerId: e.pointerId, height: 0 }
          resend(e, 'pointerdown', to, 0, p0)
          resend(e, 'mousedown', to, 0, p0)
          return
        }
      }
      if (e.button === 0 && key) {
        if (key.startsWith('person|')) {
          // Size the person: drag up to grow them, down to shrink. How big
          // they are against the model IS the model's real-world scale, so
          // it is kept for that model file (and its wall's height follows).
          e.preventDefault(); swallow(e)
          const info = models.info?.(key.slice('person|'.length))
          if (info) g = { kind: 'person', url: info.url, unit0: info.unit, y0: e.clientY }
          return
        }
        if (!key.startsWith('deco|')) {
          // A click selects; a drag up or down sizes the model on its card,
          // the same way the person is sized.
          e.preventDefault(); swallow(e)
          selectModel(key, e.shiftKey)
          g = { kind: 'model', key, k0: useModelScaleStore.getState().sizeOf[key] ?? 1, y0: e.clientY, moved: false }
          return
        }
      }
      if (!onPlane(e.target)) return
      // A pinned panel (the card browser, a pinned Viewer) lies in the canvas
      // box but not on the plane: its presses are its own, as flat. Taken for
      // bare ground, a drag on it drew a selection box instead, so it could
      // not be moved or resized in 3D (Brian 2026-11-02).
      if ((e.target as Element).closest('[data-pin-host]')) return
      // Alt+left / Alt+right belong to the orbit and dolly gestures.
      if (e.altKey && e.button !== 1) return
      // A strip's layers, behind the plane, take their own presses.
      if (e.button === 0 && (e.target as Element).closest('[data-layer-pane]')) return
      // Bare ground: left-drag draws a selection box, a plain click clears
      // the selection — as flat. Panning is the camera's job (middle drag,
      // or Alt+middle).
      // A press on bare ground takes the focus off a field or button, as
      // flat (the browser's own, held back here): Space then pans.
      if (e.button === 0 && isBareGround(e.target)) (document.activeElement as HTMLElement | null)?.blur?.()
      // Space held: left-drag pans, as flat (InfiniteCanvas). The press
      // still reaches the window's other listeners (a playing card video's
      // Space, which a pan must not toggle).
      if (e.button === 0 && spaceHeld && isBareGround(e.target)) {
        e.preventDefault(); e.stopPropagation()
        g = { kind: 'pan', last: { x: e.clientX, y: e.clientY } }
        return
      }
      if (e.button === 0 && isBareGround(e.target)) {
        e.preventDefault(); swallow(e)
        g = { kind: 'marquee', x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, add: e.shiftKey }
        return
      }
      if (e.button === 1) {
        e.preventDefault(); swallow(e)
        g = { kind: 'pan', last: { x: e.clientX, y: e.clientY } }
        return
      }
      if (e.button !== 0) return
      // preventDefault also stops the browser's own mousedown/move/up for
      // this press — they are re-sent below at the flat point instead.
      e.preventDefault(); swallow(e)
      const height = liftOf(e.target as Element)
      const target = flatTarget(e, e.target as Element, height)
      // A row's zone over its primary card (flatTarget) lies flat by the
      // card, not stood up with it: pressed on the card standing, it is
      // pressed on that card's face (on its floor, the row's drag started
      // off the cursor and drifted).
      const own = hingeOf(target)
      const hinge = own ?? (target.closest('[data-row-of]') ? hingeOf(e.target as Element) : undefined)
      const face: Surface | undefined = !own && hinge ? { height, hinge } : undefined
      grip.heldRest = restKeyOf(target)
      // Something standing, or a column's head up on the console's deck: a
      // drag from it goes where the cursor goes (see surfaceAt). So does a
      // loose card's, once carried (inHand).
      g = { kind: 'remap', target, pointerId: e.pointerId, height, stood: !!hinge || (height > 0 && !!target.closest('[data-rail-card-head], [data-rail-head]')), x0: e.clientX, y0: e.clientY,
        lay: new Map(useBoardsStore.getState().groups.map(x => [x.id, `${x.originX},${x.originY}`])) }
      // A card, deck or row on a storyline's wall: its drag is read on the
      // wall (readFor).
      const card = target.closest<HTMLElement>('[data-group-card][data-id]')?.dataset.id
        ?? target.closest<HTMLElement>('[data-card-header]')?.dataset.cardHeader
        ?? target.closest<HTMLElement>('[data-row-of]')?.dataset.rowOf
      if (hinge && onWall(card)) g.wall = hinge
      // A standing Viewer dragged by its header slides on the level plane
      // through the point grabbed (see rel); by its bottom edge (on the
      // hinge line), on the level plane there, so the edge follows the
      // cursor as flat (read on its face, the edge crept).
      const dir = target.closest<HTMLElement>('[data-resize]')?.dataset.resize
      if (hinge && dir?.includes('s')) {
        const p0 = flatClient(e.clientX, e.clientY, height, hinge)
        const q0 = flatClient(e.clientX, e.clientY, hinge.z)
        if (p0 && q0) rel = { h: hinge.z, q0, p0 }
      } else if (hinge && target.closest('[data-viewer-chrome]')) {
        const p0 = flatClient(e.clientX, e.clientY, height, hinge)
        const r = host.getBoundingClientRect()
        const h = p0 && hinge.z + Math.max(0, hinge.v - (p0.y - r.top - r.height / 2)) * Math.sin(hinge.a)
        const q0 = p0 && flatClient(e.clientX, e.clientY, h!)
        if (p0 && q0) rel = { h: h!, q0, p0 }
        grip.carried = target.closest<HTMLElement>('[data-viewport3d]')?.dataset.viewport3d ?? null
      }
      resend(e, 'pointerdown', target, height, undefined, face)
      const pressed = resend(e, 'mousedown', target, height, undefined, face)
      // The browser's own press was held back (preventDefault, above) and a
      // re-sent one has no default action, so a text field, note or picker
      // pressed in 3D never took the focus: nothing could be typed (hunt
      // 2026-11-01). As flat, unless the press was refused: the field takes
      // the focus with the caret where it was pressed, and a picker opens.
      const field = pressed !== false ? (target as Element).closest?.<HTMLElement>('input, textarea, select, [contenteditable="true"]') : null
      if (field && !(field as HTMLInputElement).disabled) {
        if (document.activeElement !== field) field.focus({ preventScroll: true })
        const at = lastFlat as { x: number; y: number } | null
        if (at && (field instanceof HTMLTextAreaElement || (field instanceof HTMLInputElement && /^(text|search|url|tel|password|email|)$/.test(field.type)))) {
          hitAt = true; layFlat()
          try {
            const cp = (document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint?.(at.x, at.y)
            if (cp && cp.offsetNode === field) field.setSelectionRange(cp.offset, cp.offset)
          } catch { /* a field without a caret */ } finally { hitAt = false; standBack() }
        } else if (field instanceof HTMLSelectElement) {
          try { field.showPicker() } catch { /* opened by the keyboard instead */ }
        }
      }
      // A column's tab on the deck is seen at a slant: a 3px jitter of the
      // hand there reads as 6px on the strip, past flat's 4px drag start,
      // and a click became a drag. Till the hand has moved 4px, its moves
      // stay where it was pressed.
      if (lastFlat && target.closest('[data-rail-card-head], [data-rail-head], [data-rail-tray-head]')) g.tab = { at: lastFlat }
    }
    const onMove = (e: PointerEvent) => {
      if (!e.isTrusted) return
      if (e.buttons === 0) grip.heldRest = null
      // A press whose release never reached us (let go outside the window,
      // or swallowed on the way) is over once no button is down: left
      // standing, it kept every later move to itself, and models stopped
      // lighting up under the cursor or taking clicks until a reload.
      if (g && e.buttons === 0) {
        if (g.kind === 'remap') {
          // Brought to here first (moves can have stopped coming, after a
          // cancel), then let go here.
          const on = readFor(g, e, e.target as Element, false)
          resend(e, 'pointermove', g.target, g.height, undefined, on)
          resend(e, 'mousemove', g.target, g.height, undefined, on)
          release(e, g)
          grip.handAt = null
        }
        if (g.kind === 'marquee') setBand(null)
        g = null
        grip.carried = null
      }
      if (!g) {
        // Asked again every frame (TiltModels), not only as the mouse
        // moves: a model that was hidden for a frame (its card re-rendering)
        // as the cursor came to rest would otherwise stay unlit under it.
        models.at = e.buttons === 0 && !e.altKey && overView(e.target) ? { x: e.clientX, y: e.clientY } : null
        models.hovered = models.at && modelKey(models.pick?.(models.at.x, models.at.y))
        return
      }
      swallow(e)
      if (g.kind === 'person') {
        // Units per metre grows as the person does (a bigger person, in
        // the model's units, means a smaller model in metres).
        const u = g.unit0 * Math.exp(-(e.clientY - g.y0) / 160)
        useModelScaleStore.getState().setUnitsPerMetre(g.url, u)
        return
      }
      if (g.kind === 'model') {
        const dy = e.clientY - g.y0
        if (!g.moved && Math.abs(dy) < 4) return
        g.moved = true
        const k = Math.min(8, Math.max(0.1, g.k0 * Math.exp(-dy / 160)))
        useModelScaleStore.getState().setSize(g.key, k)
        return
      }
      if (g.kind === 'marquee') {
        g.x1 = e.clientX; g.y1 = e.clientY
        const r = host.getBoundingClientRect()
        setBand({ x: Math.min(g.x0, g.x1) - r.left, y: Math.min(g.y0, g.y1) - r.top, w: Math.abs(g.x1 - g.x0), h: Math.abs(g.y1 - g.y0) })
        return
      }
      if (g.kind === 'pan') {
        // Maya's pan: the camera slides in its own view plane, so the whole
        // view follows the mouse evenly, near and far alike.
        const ts = useTiltStore.getState()
        ts.setShift(ts.shiftX + e.clientX - g.last.x, ts.shiftY + e.clientY - g.last.y)
        g.last = { x: e.clientX, y: e.clientY }
        return
      }
      // A card that captured the pointer gets it, as it would flat.
      const real = e.target as Element
      const held = real.hasPointerCapture?.(g.pointerId)
      const to = held ? real : g.target
      if (g.tab && !(g.tab.went ||= Math.hypot(e.clientX - (g.x0 ?? e.clientX), e.clientY - (g.y0 ?? e.clientY)) >= 4)) {
        resend(e, 'pointermove', to, g.height, g.tab.at)
        resend(e, 'mousemove', to, g.height, g.tab.at)
        return
      }
      const on = readFor(g, e, real, !!held)
      g.last = { x: e.clientX, y: e.clientY }
      resend(e, 'pointermove', to, g.height, undefined, on)
      resend(e, 'mousemove', to, g.height, undefined, on)
    }
    const onUp = (e: PointerEvent) => {
      if (!e.isTrusted) return
      // Let go: what rests on a strip settles where it now lies.
      if (e.type !== 'pointercancel') grip.heldRest = null
      if (!g) return
      swallow(e)
      if (g.kind === 'remap') {
        const real = e.target as Element
        const held = real.hasPointerCapture?.(g.pointerId)
        const to = held ? real : g.target
        const on = readFor(g, e, real, !!held)
        // A cancelled press is not a release: re-sent as an up, it let go of
        // a dragged card mid-drag, and it merged into whatever was under it
        // (Brian 2026-10-30: a card "jumps into a deck before I let go").
        // Nor is it the end of the drag: a card's drag ignores it and goes
        // on till the button comes up, as flat. So the press stays open, its
        // moves still re-sent at the flat point (dropped, they were sent
        // as they came, tilted, and the card drifted off the cursor), until
        // its release or the next move with no button down.
        if (e.type === 'pointercancel') { resend(e, 'pointercancel', to, g.height, undefined, on); return }
        // Let go where the last move was, it goes where that move went (the
        // slot it showed): a strip lying down under the still cursor shows it
        // something else there, which flat never happens.
        const at = on && g.last?.x === e.clientX && g.last.y === e.clientY ? lastFlat ?? undefined : undefined
        resend(e, 'pointerup', to, g.height, at, on); resend(e, 'mouseup', to, g.height, at, on)
        grip.handAt = null
        // Let go where it was pressed, on a button the browser's own hit
        // test missed: the click is that button's, as flat.
        const btn = g.target.closest('button')
        if (btn && g.x0 !== undefined && Math.hypot(e.clientX - g.x0, e.clientY - g.y0!) < 4 && !btn.contains(real)) clickTo = btn
        const zone = g.target.closest<HTMLElement>('[data-row-of]')
        dblTo = zone && g.x0 !== undefined && Math.hypot(e.clientX - g.x0, e.clientY - g.y0!) < 4 && !zone.contains(real) ? zone : null
      }
      if (g.kind === 'marquee') { marqueeSelect(g, g.add || e.shiftKey); setBand(null) }
      g = null
      grip.carried = null
    }
    // Wheel zoom glides (tiltStore TiltGlide): the clicks ease a scale on
    // the painted plane, and the canvas zoom takes it once the wheel rests.
    let wz: { target: number; k: number; x: number; y: number; last: number; at: number; raf: number } | null = null
    const settleZoom = () => {
      const w = wz
      if (!w) return
      cancelAnimationFrame(w.raf)
      w.k = w.target
      wz = null
      // The new zoom drawn now (flushSync), then the glide dropped, so the
      // same frame shows both and nothing jumps.
      flushSync(() => useCanvasStore.getState().zoomAtPoint(w.k, w.x + host.clientWidth / 2, w.y + host.clientHeight / 2))
      useTiltStore.getState().setGlide(null)
    }
    const glideFrame = (now: number) => {
      const w = wz
      if (!w) return
      // The frame's time can be before the wheel event's (handled in the
      // same frame): a negative step zoomed the wrong way first.
      const dt = Math.max(0, Math.min(64, now - w.at))
      w.at = now
      const a = 1 - Math.exp(-dt / 55)
      w.k = Math.exp(Math.log(w.k) + (Math.log(w.target) - Math.log(w.k)) * a)
      const there = Math.abs(Math.log(w.target / w.k)) < 0.003
      if (there) w.k = w.target
      if (there && now - w.last > 140) { settleZoom(); return }
      useTiltStore.getState().setGlide({ k: w.k, x: w.x, y: w.y })
      w.raf = requestAnimationFrame(glideFrame)
    }
    const onWheel = (e: WheelEvent) => {
      if (!e.isTrusted || !onPlane(e.target)) return
      // A panel that keeps the wheel flat (data-wheel-own: Prompt Pad's,
      // History's and the Pool's lists scroll, the List rolls, a Viewer
      // zooms its picture or turns its model) keeps it here too: zoomed
      // instead, its list could not be scrolled at all in 3D. Pinned, it is
      // not on the plane: its wheel is left as it comes. On the plane, the
      // panel is asked as a press is, at the flat point on what the flat
      // view has there (the browser's own hit can be the box holding the
      // Viewer's picture, not the picture). The browser's own wheel is not
      // prevented, so the list under the cursor still scrolls natively;
      // only the copy reaches the page. Not through furniture or a model
      // drawn in front of it.
      const real = e.target as Element
      if (real.closest('[data-wheel-own]') && !real.closest('[data-tilt-stage]')) return
      if (real.closest('[data-freenode][data-id], [data-viewport3d]')?.querySelector('[data-wheel-own]') &&
          !(overView(real) && models.pick?.(e.clientX, e.clientY))) {
        const height = liftOf(real)
        const to = flatTarget(e, real, height)
        const p = to.closest('[data-wheel-own]') && flatClient(e.clientX, e.clientY, height, hingeOf(to))
        if (p) {
          swallow(e)
          resend(e, 'wheel', to, height, p)
          return
        }
      }
      e.preventDefault(); swallow(e)
      const c = viewCentre(host)
      if (!c) return
      const now = performance.now()
      if (!wz) {
        wz = { target: 1, k: 1, x: c.x - host.clientWidth / 2, y: c.y - host.clientHeight / 2, last: now, at: now, raf: 0 }
        wz.raf = requestAnimationFrame(glideFrame)
      }
      const z = useCanvasStore.getState().zoom
      const step = e.deltaY < 0 ? 1.12 : 1 / 1.12
      wz.target = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z * wz.target * step)) / z
      wz.last = now
    }
    // A press lands on the zoom it sees, so a glide still easing settles
    // first.
    const onPressSettle = () => settleZoom()
    // The browser's own drag (of a picture under the cursor) cancels the
    // pointer mid-gesture; while a press is being re-sent there is none.
    const onDragStart = (e: DragEvent) => { if (g?.kind === 'remap') e.preventDefault() }
    // Only the pointer's own clicks: a key's (Space on a focused button,
    // detail 0) is not the furniture's.
    const onClick = (e: MouseEvent) => {
      if (!e.isTrusted || e.detail <= 0) return
      const b = clickTo
      clickTo = null
      if (eatClick) { e.preventDefault(); swallow(e); return }
      if (e.type === 'dblclick') {
        const to = dblTo
        dblTo = null
        if (to?.isConnected && !(e.target instanceof Node && to.contains(e.target))) {
          e.preventDefault(); swallow(e)
          to.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, view: window, detail: e.detail,
            clientX: lastFlat?.x ?? e.clientX, clientY: lastFlat?.y ?? e.clientY,
            altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey }))
        }
        return
      }
      // A button pressed where it shows, but not by the browser's own hit
      // (Run's pill corners, which the rounding left out): its click.
      if (b?.isConnected && !(e.target instanceof Node && b.contains(e.target))) {
        e.preventDefault(); swallow(e)
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window, detail: e.detail,
          clientX: lastFlat?.x ?? e.clientX, clientY: lastFlat?.y ?? e.clientY,
          altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey }))
      }
    }
    /** Right-click on furniture opens its owner's menu, at the cursor (as
     *  every menu in 3D), not that of whatever is hidden behind it. */
    const onMenu = (e: MouseEvent) => {
      const to = menuTo
      if (!e.isTrusted || !to) return
      menuTo = null
      e.preventDefault(); swallow(e)
      to.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, composed: true, view: window, button: 2, buttons: e.buttons,
        clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
        altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey,
      }))
    }
    window.addEventListener('dragstart', onDragStart, true)
    window.addEventListener('click', onClick, true)
    window.addEventListener('dblclick', onClick, true)
    window.addEventListener('contextmenu', onMenu, true)
    window.addEventListener('pointerdown', onPressSettle, true)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onSpace)
    window.addEventListener('keyup', onSpace)
    window.addEventListener('blur', onSpace)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => {
      window.removeEventListener('pointerdown', onPressSettle, true)
      // Leaving mid-glide (inside React's commit, so no flushSync): the
      // zoom it was heading to.
      if (wz) {
        cancelAnimationFrame(wz.raf)
        useCanvasStore.getState().zoomAtPoint(wz.target, wz.x + host.clientWidth / 2, wz.y + host.clientHeight / 2)
        wz = null
        useTiltStore.getState().setGlide(null)
      }
      window.removeEventListener('dragstart', onDragStart, true)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('dblclick', onClick, true)
      window.removeEventListener('contextmenu', onMenu, true)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onSpace)
      window.removeEventListener('keyup', onSpace)
      window.removeEventListener('blur', onSpace)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      window.removeEventListener('wheel', onWheel, true)
      models.at = null; models.hovered = null
      grip.carried = null
      document.elementFromPoint = fromPoint
      document.elementsFromPoint = fromPoints
      Element.prototype.getBoundingClientRect = rectOf
      Element.prototype.getClientRects = rectsOf
    }
  }, [])

  const btn = (active: boolean): React.CSSProperties => ({
    background: active ? 'rgba(120,170,255,0.25)' : 'transparent',
    border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6,
    color: active ? '#dfe8ff' : 'rgba(255,255,255,0.6)',
    fontSize: 11, padding: '3px 8px', cursor: 'pointer',
  })
  const set = useTiltStore.getState()

  return (
    <div
      ref={rootRef}
      style={{ position: 'absolute', inset: 0, zIndex: 850, pointerEvents: 'none' }}
    >
      {band && (
        <div style={{
          position: 'absolute', left: band.x, top: band.y, width: band.w, height: band.h,
          border: '1.5px solid rgba(120,170,255,0.8)', background: 'rgba(100,150,255,0.08)',
          borderRadius: 3, pointerEvents: 'none',
        }} />
      )}
      {lightOpen && <LightPanel onClose={() => setLightOpen(false)} />}
      <div
        data-tilt-hud
        style={{
          position: 'absolute', left: '50%', bottom: 14, transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
          background: 'rgba(19,20,31,0.88)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10,
          color: 'rgba(255,255,255,0.5)', fontSize: 11, cursor: 'default', userSelect: 'none',
          whiteSpace: 'nowrap', pointerEvents: 'auto',
        }}
      >
        <span>Tilted {Math.round(tilt)}° · click to select · drag a box to select many · Alt+drag orbits · Alt+middle pans · F frames</span>
        <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.12)' }} />
        <button style={btn(texture)} onClick={() => set.setTexture(!texture)} title="The model's own textures; off is plain grey">Texture</button>
        <button style={btn(shade === 'flat')} onClick={() => set.setShade(shade === 'flat' ? null : 'flat')} title="Flat shading: every face shows">Flat</button>
        <button style={btn(shade === 'smooth')} onClick={() => set.setShade(shade === 'smooth' ? null : 'smooth')} title="Smooth shading. With Flat and Smooth both off the model is unshaded: its bare texture, or hollow with Texture off">Smooth</button>
        <button style={btn(wire)} onClick={() => set.setWire(!wire)} title="The wireframe, over whatever else shows">Wireframe</button>
        <button style={btn(lightOpen)} onClick={() => setLightOpen(o => !o)} title="Move the light, brightness and reflections">Light</button>
        <button style={btn(turn)} onClick={() => set.setTurn(!turn)}>Turn</button>
        <button style={btn(walls)} onClick={() => set.setWalls(!walls)} title="File name and size on a wall behind each model">Labels</button>
        <button style={btn(figure)} onClick={() => set.setFigure(!figure)} title="A 1.75 m person beside each model. Drag them up or down to set how big the model really is.">Person</button>
        <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.12)' }} />
        {/* Lock into 3D (Brian 2026-11-07): its own on/off. Lit, the camera
            is free (straight down, any turn, fly up) and never drops back
            to the flat view; Exit 3D still takes you home. */}
        <button
          style={{ ...btn(lock3d), padding: '2px 6px', display: 'flex', alignItems: 'center' }}
          onClick={() => set.setLock3d(!lock3d)}
          aria-pressed={lock3d}
          title="Lock into 3D: a free camera. Look straight down, turn any way, fly up, and never drop back to the flat canvas. Click again to unlock."
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" stroke={lock3d ? '#cfe0ff' : 'rgba(255,255,255,0.6)'}>
            <path d="M12 2.8l7.5 4.2v8.4L12 19.6 4.5 15.4V7z" />
            <path d="M4.5 7L12 11.2 19.5 7M12 11.2v8.4" opacity="0.7" />
            <rect x="14.5" y="14" width="7" height="6" rx="1.2" fill={lock3d ? '#5fe39b' : 'rgba(19,20,31,1)'} stroke={lock3d ? '#5fe39b' : 'rgba(255,255,255,0.6)'} />
            <path d="M16 14v-1.6a2 2 0 0 1 4 0V14" stroke={lock3d ? '#5fe39b' : 'rgba(255,255,255,0.6)'} />
          </svg>
        </button>
        <button style={btn(true)} onClick={() => { if (lock3d) set.setLock3d(false); set.flatten() }}>Exit 3D (Esc)</button>
      </div>
    </div>
  )
}
