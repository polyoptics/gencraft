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

import React, { useEffect, useMemo, useRef } from 'react'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { FreeNode } from './FreeNode'
import { Viewport3DFrame } from '../Viewport3D/Viewport3DFrame'
import { GLPinnedCanvasHost } from '../Viewport3D/GLPinnedCanvasHost'
import { MagnetDockPreview } from './MagnetDockPreview'
import { useBoardsStore } from '../../store/boardsStore'
import { PinnedCardView } from '../Layers/cardView'
import { CardLayer } from '../Layers/CardLayer'
import { BlockLayer } from '../Layers/BlockLayer'
import { BoardLayer } from '../Layers/BoardLayer'
import { expandWithNestedMembers } from '../../hooks/useCardDecks'
import { PinnedCardBar } from './PinnedCardBar'

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
        // Card level is screen-space already, so a frozen camera is the whole
        // story. Block and board draw in WORLD space inside the canvas's
        // transform, so a pinned one needs that transform reproduced with the
        // frozen values — same maths the canvas container applies, just held
        // still.
        const view = {
          pan: { x: g.pin!.x - g.originX * g.pin!.scale, y: g.pin!.y - g.originY * g.pin!.scale },
          zoom: g.pin!.scale,
        }
        return (
          <div key={g.id} data-pinned-group={g.id} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <PinnedCardView
            originX={g.originX}
            originY={g.originY}
            anchor={{ x: g.pin!.x, y: g.pin!.y }}
            scale={g.pin!.scale}
          >
            {level === 'card' && <CardLayer.Overlay only={members} />}
            {level !== 'card' && (
              <>
                <div style={{
                  position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none',
                }}>
                  <div style={{
                    position: 'absolute', left: 0, top: 0,
                    transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})`,
                    transformOrigin: '0 0',
                    pointerEvents: 'auto',
                  }}>
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
          </div>
        )
      })}
    </div>
  )
}
