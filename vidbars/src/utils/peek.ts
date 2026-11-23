// peek.ts — Alt-twist peeking (Brian 2026-11-03): with Alt held, a sideways
// drag only swings the view when it starts over something that can be
// peeked into, and that thing is the pivot: it stays where it is on screen
// while the view swings round it.
//  - a Viewer with a loop strip and its Layers switch on: the strip's layers
//    pull back behind its picture (Viewport3D/ExplodedStrip);
//  - the Film Look Mixer with its layers on, the same;
//  - a stacked deck: its cards fan back and to the side (Viewport3D/DeckPeek);
//  - a card or tile with a 3D model (Brian 2026-11-23): the side view, in
//    which the 3D models near the middle of the view lift off their cards,
//    facing out of them (`side`; found in tilt/altCamera peekOf, shown by
//    tilt/TiltModels and three/tiltScene).
// Nothing is stored: flat again, nothing is peeked.

import { create } from 'zustand'
import { useCanvasStore } from '../store/canvasStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useRailUiStore } from '../store/railUiStore'
import { isTilted, useTiltStore } from '../store/tiltStore'
import { useViewport3DStore } from '../store/viewport3dStore'
import { railViewerDocks, viewerRail } from './railViewer'
import { pictureAreas, useStripLayers } from '../components/Viewport3D/ExplodedStrip'
import { useFilmLayersOn } from '../components/FilmMixer/FilmMixerBody'

export type PeekTarget =
  | { kind: 'viewer'; id: string }
  | { kind: 'mixer'; id: string }
  | { kind: 'deck'; id: string }
  /** A card or tile with a 3D model, by its key (`card:<id>`, `node:<id>`). */
  | { kind: 'models'; id: string }

/** What the view is peeking into, or null. `side`: the peek is the 3D
 *  models' side view (it began over a card showing a 3D model). */
/** `sideBox`: what of the canvas was in view when the side view began
 *  (canvas units): the 3D models there all lift, and it fades off beyond. */
export const usePeek = create<{ target: PeekTarget | null; side: boolean; sideBox: { x: number; y: number; w: number; h: number } | null }>(() => ({ target: null, side: false, sideBox: null }))

/** Where each stacked deck is, canvas units, and its cards in order (the
 *  front card first): written by CardLayer's StackedDeckCard as it draws. */
export const deckAreas = new Map<string, { x: number; y: number; width: number; height: number; memberIds: string[] }>()

/** What under this element can be peeked into, and its middle as a flat
 *  point (px from the host's centre): the pivot. */
export function peekAt(el: Element | null, host: HTMLElement): { target: PeekTarget; g: { x: number; y: number } } | null {
  if (!el) return null
  const W = host.clientWidth, H = host.clientHeight
  const { pan, zoom } = useCanvasStore.getState()
  const at = (x: number, y: number, w: number, h: number) => ({ x: pan.x + (x + w / 2) * zoom - W / 2, y: pan.y + (y + h / 2) * zoom - H / 2 })

  const viewer = el.closest('[data-viewport3d]') as HTMLElement | null
  if (viewer && !viewer.hasAttribute('data-pinned')) {
    const id = viewer.dataset.viewport3d!
    if (!useStripLayers.getState().on) return null
    const { nodes } = useFreeNodeStore.getState()
    const { windows } = useViewport3DStore.getState()
    const docked = railViewerDocks(nodes, windows, zoom).get(id)
    const w = windows[id]
    if (!w || !docked || !viewerRail(docked, useRailUiStore.getState().active)) return null
    const a = pictureAreas.get(id) ?? { x: 0, y: 0, width: w.width, height: w.height }
    return { target: { kind: 'viewer', id }, g: at(w.x + a.x, w.y + a.y, a.width, a.height) }
  }

  const tile = el.closest('[data-freenode][data-id]') as HTMLElement | null
  if (tile) {
    const n = useFreeNodeStore.getState().nodes[tile.dataset.id!]
    if (!n || n.type !== 'filmMixer' || n.pin || !useFilmLayersOn.getState().on) return null
    return { target: { kind: 'mixer', id: n.id }, g: at(n.x, n.y, n.width, n.height) }
  }

  const card = el.closest('[data-group-card][data-id]') as HTMLElement | null
  if (card && !card.closest('[data-pinned]')) {
    const d = deckAreas.get(card.dataset.id!)
    if (!d || d.memberIds.length < 2) return null
    return { target: { kind: 'deck', id: card.dataset.id! }, g: at(d.x, d.y, d.width, d.height) }
  }
  return null
}

// Back to flat, the peek is over.
useTiltStore.subscribe((s, was) => {
  if (isTilted(was) && !isTilted(s) && usePeek.getState().target) usePeek.setState({ target: null, side: false, sideBox: null })
})
