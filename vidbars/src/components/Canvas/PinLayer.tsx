// PinLayer.tsx — the screen-space host for pinned free nodes.
//
// A node with `pin` renders HERE instead of inside the world transform,
// so it holds still while the canvas pans and zooms underneath it. It is
// the same <FreeNode> component either way: the only difference is which
// ancestor supplies the transform, which is what makes pin/unpin
// visually seamless (see freeNodeStore's `pin` docs).
//
// Mounted ONCE for the app's life, as a direct child of the
// InfiniteCanvas container:
//  - same origin as `pan`, so the pin math needs no offset term;
//  - outside LayerRouter, so crossing the 0.18 / 0.30 zoom thresholds
//    never remounts a pinned panel and loses its measured size, its
//    scroll position or an open popup;
//  - inside the container's overflow:hidden, so pinned things are
//    clipped to the canvas area rather than floating over the toolbar.
//
// No viewport culling: a pinned node is on screen by definition, and
// running FreeCanvas's canvas-space test against its stale x/y would
// make it disappear on the first pan.

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { FreeNode } from './FreeNode'
import { Viewport3DFrame } from '../Viewport3D/Viewport3DFrame'
import { GLPinnedCanvasHost } from '../Viewport3D/GLPinnedCanvasHost'
import { MagnetDockPreview } from './MagnetDockPreview'
import { useBoardsStore } from '../../store/boardsStore'
import type { ProjectGroup } from '../../store/boardsStore'
import { PinnedCardView } from '../Layers/cardView'
import { CardLayer, cardScreenRect } from '../Layers/CardLayer'
import { headerExtend } from '../NLE/NLETimelineHeader'
import { BlockLayer } from '../Layers/BlockLayer'
import { BoardLayer } from '../Layers/BoardLayer'
import { expandWithNestedMembers } from '../../hooks/useCardDecks'
import { PinnedCardBar } from './PinnedCardBar'
import { PinTravelLines } from './PinTravelLines'

export const PinLayer: React.FC = () => {
  const nodes = useFreeNodeStore(s => s.nodes)
  const clamp = useFreeNodeStore(s => s.clampPinnedIntoView)
  // The home instance is the only pinned node with a hide toggle — that
  // is what the Cards button means. Every other pinned node is visible
  // because it is pinned.
  const homeId = useCanvasStore(s => s.homeRolodexId)
  const homeVisible = useCanvasStore(s => s.rolodexOpen)
  const viewerWindows = useViewport3DStore(s => s.windows)
  const ref = useRef<HTMLDivElement>(null)

  const pinnedViewerIds = useMemo(
    () => Object.keys(viewerWindows).filter(wid => !!viewerWindows[wid].pin),
    [viewerWindows],
  )

  const groups = useBoardsStore(s => s.groups)
  // EVERY pinned card renders here. The deck-member gate that used to be on
  // this filter is wrong now that decks cannot be pinned: `deckState` and
  // `deckAnchorId` persist from before the card was pinned, so a card that
  // had been tucked into a deck was judged "represented by its anchor",
  // filtered out, and rendered NOWHERE — pinned, and invisible. Its level
  // bar then had nothing to attach to, which is the bar that would not show
  // up. A pinned card left the canvas; no anchor out there stands for it.
  const pinnedGroups = useMemo(() => groups.filter(g => g.pin), [groups])

  const ids = useMemo(() => Object.keys(nodes).filter(id => !!nodes[id].pin), [nodes])
  // Key on the id LIST, not its length: an import that replaces the map
  // with the same COUNT of pinned nodes must still re-clamp, or a project
  // exported from a wide monitor lands unreachable on a laptop.
  const idKey = ids.join('|')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const run = () => clamp(el.clientWidth, el.clientHeight)
    run()
    const ro = new ResizeObserver(run)
    ro.observe(el)
    return () => ro.disconnect()
  }, [clamp, idKey])

  // pointerEvents:'none' is load-bearing — a full-bleed host that ate
  // pointer events would kill canvas panning everywhere it covers. Each
  // pinned FreeNode wrapper re-enables it on itself.
  return (
    <div ref={ref} data-pin-host style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 900 }}>
      {/* GL for pinned Viewers, mounted here so their models paint ABOVE
          canvas content. Only mounted while something is pinned — no
          second WebGL context is created otherwise. */}
      {pinnedViewerIds.length > 0 && <GLPinnedCanvasHost />}
      {pinnedViewerIds.map(wid => <Viewport3DFrame key={wid} id={wid} />)}
      {/* The screen-space half of the magnet affordance. Pinned rects are
          pixels, so drawing them in the canvas layer would put the ghost
          somewhere else entirely. */}
      <MagnetDockPreview space="screen" />
      {/* Where cards go when they unpin. Mounted in the pin host because
          that is the surface a card departs FROM; the line has to outlive
          the pinned render it came from, which it does — the store owns it,
          not the card. */}
      <PinTravelLines />
      {ids.map(id => (
        (id === homeId && !homeVisible) ? null : <FreeNode key={id} id={id} />
      ))}
      {/* Pinned CARDS. Same GroupCard the canvas layer renders — only the
          camera differs, which is the whole of what pinning a card means
          (see cardView.tsx). pointerEvents is re-enabled per card because
          this host is pass-through. */}
      {pinnedGroups.map(g => (
        <PinnedCardBar key={`bar-${g.id}`} group={g} />
      ))}
      {pinnedGroups.map(g => {
        const members = expandWithNestedMembers([g.id], groups)
        const level = g.pinnedLayer ?? 'card'
        return (
          <div key={g.id} data-pinned-group={g.id} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            <PinnedLevel group={g} members={members} level={level} />
          </div>
        )
      })}
    </div>
  )
}

type PinLevel = 'card' | 'block' | 'board'

/** One pinned card's contents, at the level it is currently showing.
 *
 *  A pin is a FRAME — a fixed box at a fixed spot on screen. The 1/2/3 buttons
 *  choose what is drawn inside it and must never move or resize it, so content
 *  larger than the frame is scaled DOWN into it. That is what makes a pinned
 *  card at board level read as looking further into the card you already had,
 *  rather than as a new window opening somewhere else.
 *
 *  The content's size is MEASURED, not derived. This codebase has three
 *  extent helpers and all three disagree with what actually gets drawn — the
 *  block footprint omits the 57-unit header band and the size overrides, and
 *  jumpToGroup never walks child bars — so a fourth one written from the same
 *  assumptions would just be wrong in a fourth way. Measuring the rendered
 *  content and dividing out the camera it was drawn with gives canvas units
 *  that cannot disagree with the render, because they ARE the render.
 *  Dividing out the camera is also what keeps this from oscillating: the
 *  measurement is scale-invariant, so changing the fit does not change it. */
const PinnedLevel: React.FC<{
  group: ProjectGroup; members: string[]; level: PinLevel
}> = ({ group, members, level }) => {
  const boards = useBoardsStore(s => s.boards)
  const pin = group.pin!
  const contentRef = useRef<HTMLDivElement>(null)
  /** Content bounds in CANVAS units — null until first measured. */
  const [content, setContent] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  // The frame in canvas units: the card's own face, plus the header band it
  // extends up into. cardScreenRect with an identity camera IS the canvas-unit
  // answer, and it is the same function GroupCard sizes itself with, so the
  // frame cannot drift from the card. The band is a screen-px quantity, so in
  // canvas units it depends on the scale it is drawn at — freeze it at the
  // pin's scale.
  const frame = useMemo(() => {
    const r = cardScreenRect(group, boards, { x: 0, y: 0 }, 1)
    if (!r) return null
    const bandAtOne = headerExtend(1)
    const band = headerExtend(pin.scale) / pin.scale
    return {
      x: r.screenLeft,
      y: r.screenTop + bandAtOne - band,
      w: r.screenWidth,
      h: r.screenHeight - bandAtOne + band,
    }
  }, [group, boards, pin.scale])

  const fitted = level !== 'card' && !!frame && !!content && content.w > 0 && content.h > 0
  // Shrink only. Content smaller than the frame is left alone rather than
  // blown up to fill it — a two-bar board should not become huge just because
  // its card is.
  const fit = fitted ? Math.min(1, frame!.w / content!.w, frame!.h / content!.h) : 1
  const zoom = pin.scale * fit

  const pan = fitted
    ? (() => {
        const fx = pin.x + (frame!.x - group.originX) * pin.scale
        const fy = pin.y + (frame!.y - group.originY) * pin.scale
        return {
          x: fx + (frame!.w * pin.scale - content!.w * zoom) / 2 - content!.x * zoom,
          y: fy + (frame!.h * pin.scale - content!.h * zoom) / 2 - content!.y * zoom,
        }
      })()
    : { x: pin.x - group.originX * zoom, y: pin.y - group.originY * zoom }

  // PinnedCardView solves pan from (anchor, origin, scale), so hand it the
  // anchor that yields the pan computed above.
  const anchor = { x: pan.x + group.originX * zoom, y: pan.y + group.originY * zoom }

  // The camera actually applied this render, in a ref. The measurement below
  // needs it to convert screen px back to canvas units, but it must NOT be an
  // effect dependency: pan and zoom are DERIVED from the measurement, so
  // depending on them tore down and restarted the loop on every frame it
  // produced a new value. That is what made pinned cards drift around instead
  // of settling — the fit never got to converge before being restarted.
  const camRef = useRef({ pan, zoom })
  camRef.current = { pan, zoom }

  useLayoutEffect(() => {
    if (level === 'card') { setContent(null); return }
    let raf = 0
    const tick = () => {
      const el = contentRef.current
      const { pan, zoom } = camRef.current
      if (el) {
        let l = Infinity, t = Infinity, r2 = -Infinity, b2 = -Infinity
        for (const c of el.querySelectorAll<HTMLElement>('[data-layer-block],[data-block][data-id]')) {
          const r = c.getBoundingClientRect()
          if (r.width <= 0 || r.height <= 0) continue
          l = Math.min(l, r.left); t = Math.min(t, r.top)
          r2 = Math.max(r2, r.right); b2 = Math.max(b2, r.bottom)
        }
        if (Number.isFinite(l)) {
          // Viewport px → canvas units: undo the host offset, then the camera
          // these were actually drawn with.
          const host = document.querySelector('[data-pin-host]') as HTMLElement | null
          const off = host?.getBoundingClientRect()
          const ox = off?.left ?? 0, oy = off?.top ?? 0
          const next = {
            x: ((l - ox) - pan.x) / zoom,
            y: ((t - oy) - pan.y) / zoom,
            w: (r2 - l) / zoom,
            h: (b2 - t) / zoom,
          }
          // Epsilon guard: sub-pixel jitter must not feed a re-render loop.
          setContent(prev => (prev
            && Math.abs(prev.x - next.x) < 0.5 && Math.abs(prev.y - next.y) < 0.5
            && Math.abs(prev.w - next.w) < 0.5 && Math.abs(prev.h - next.h) < 0.5)
            ? prev : next)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [level])

  return (
    <PinnedCardView
      originX={group.originX}
      originY={group.originY}
      anchor={anchor}
      scale={zoom}
    >
      {level === 'card' && <CardLayer.Overlay only={members} />}
      {level !== 'card' && (
        <>
          <div style={{
            position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none',
          }}>
            <div
              ref={contentRef}
              style={{
                position: 'absolute', left: 0, top: 0,
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: '0 0',
                pointerEvents: 'auto',
              }}
            >
              {level === 'block'
                ? <BlockLayer.Canvas only={members} />
                : <BoardLayer.Canvas only={members} />}
            </div>
          </div>
          {level === 'block'
            ? <BlockLayer.Overlay only={members} />
            : <BoardLayer.Overlay only={members} />}
        </>
      )}
    </PinnedCardView>
  )
}
