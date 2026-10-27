// useFxStrips — find every effect strip on the canvas and keep it running.
//
// A strip is image/video cards and effect cards that TOUCH (the same
// tolerance the Viewer docking uses), read left to right — see
// utils/fx/chain for how it reads. Each picture at its start shows its own
// result in place (FxResultLayer); a strip that touches a Viewer shows its
// output there too. Nothing is stored: strips are derived from where tiles sit,
// recomputed whenever tiles or Viewers change, and re-run (debounced) only
// when what a strip would compute has changed — its cards, their order,
// their sliders. That re-run on every change is the strip's "loop".
//
// Mounted once, by App's FxStripsHost — its own component, so these
// subscriptions (every tile drag frame, every zoom tick) re-render nothing
// else.
//
// Collapsed tile decks (utils/tileDecks): a hidden member is not geometry,
// so only VISIBLE tiles touch. A face stands in for its deck — it brings
// the members that were on ITS strip while the deck lay open, in deck
// order, at the face's place in the read (faceItems). The deck was
// collapsed from tiles lined up in that same order, so collapsing or
// opening a strip changes neither its items nor its key: nothing re-runs,
// and the face (its source picture) keeps showing the result.
//
// Loop strips (utils/rail) are a different machine for the same job, and
// stay out of this one entirely: a docked card is laid out by its rail — its
// column's cards overlap, and the columns sit a gap apart — so to the touch
// test a rail would read as one big ad-hoc strip, running every picture on
// it through every effect card in rail-x order. The rail runs its own cards
// (utils/fx/railRun). The rail tile itself carries no item.

import { useEffect, useRef } from 'react'
import { useFreeNodeStore, type FreeNodeData } from '../store/freeNodeStore'
import { useViewport3DStore } from '../store/viewport3dStore'
import { useCanvasStore } from '../store/canvasStore'
import { useFxStore, type FxStrip } from '../store/fxStore'
import { usePosterMapStore } from '../three/posterService'
import { rectsTouch, viewportVisualRect, DOCK_TOLERANCE } from '../utils/viewportDocking'
import { runChain, type ChainItem, type ChainResult } from '../utils/fx/chain'
import { effectKindOf } from '../utils/fx/effects'
import { tileDeckIndex, tileDeckMembers } from '../utils/tileDecks'
import { isDocked } from '../utils/rail'
import { stripCards, type StripCard } from '../utils/fx/cardStrips'
import { useBoardsStore } from '../store/boardsStore'

/** Working resolution for the live result (a saved result renders full). */
export const LIVE_SIDE = 1400

/** What a tile contributes to a strip, or null if it cannot be on one.
 *  `posters` is the live poster map (what getModelPoster reads). */
function stripItem(n: FreeNodeData, posters: Record<string, string>): ChainItem | null {
  if (n.pin) return null
  // effectKindOf: a pasted or imported card may carry no `effect`, or a
  // kind this build lacks — it runs as the Bloom its face shows.
  if (n.type === 'effect') return { id: n.id, kind: 'effect', effect: effectKindOf(n), params: n.effect?.params }
  if (n.type === 'image' && n.imageUrl) return { id: n.id, kind: 'source', url: n.imageUrl, label: n.label }
  // A video goes through as its poster frame — the frame its tile shows,
  // which is the LIVE map's first: the node's own copy can be a dead
  // reference after a template or project load (see FreeNode's
  // transferablePoster).
  if (n.type === 'video') {
    const poster = (n.imageUrl ? posters[n.imageUrl] : undefined) ?? n.posterUrl
    if (poster) return { id: n.id, kind: 'source', url: poster, label: n.label }
  }
  return null
}

/** What a deck's face brings to a strip: the deck read as it lies OPEN.
 *  A deck collapses every touching tile, notes and models included, but
 *  only tiles with a strip item join strips — so open, a note between two
 *  strips keeps them apart, and a picture that touches the cluster only
 *  through a note is on no strip at all. Collapsed must read the same:
 *  members connect only through members that have an item, at their open
 *  rects, and the face brings just its own group (a face with no item of
 *  its own, the first group). The rest of the deck is off the canvas until
 *  it is opened, and then reads (and runs) as it did. Deck order is the
 *  open reading order, so the items come out in it. */
function faceItems(face: FreeNodeData, nodes: Record<string, FreeNodeData>, posters: Record<string, string>): ChainItem[] {
  const subs = tileDeckMembers(face.id, nodes).flatMap(m => {
    const it = stripItem(m, posters)
    if (!it) return []
    const d = m.id === face.id ? { dx: 0, dy: 0 } : m.tileDeck!
    return [{ id: m.id, it, r: { x: face.x + d.dx, y: face.y + d.dy, width: m.width, height: m.height } }]
  })
  if (!subs.length) return []
  const start = subs.find(s => s.id === face.id) ?? subs[0]
  const seen = new Set([start])
  const queue = [start]
  while (queue.length) {
    const cur = queue.pop()!
    for (const o of subs) {
      if (seen.has(o) || !rectsTouch(cur.r, o.r, DOCK_TOLERANCE)) continue
      seen.add(o)
      queue.push(o)
    }
  }
  return subs.filter(s => seen.has(s)).map(s => s.it)
}

export function computeStrips(
  nodes: Record<string, FreeNodeData>,
  windows: Record<string, import('../store/viewport3dStore').ViewportWindow3D>,
  zoom: number,
  posters: Record<string, string> = usePosterMapStore.getState().map,
  /** Cards that can head a strip (utils/fx/cardStrips): each joins as a
   *  stand-in tile with its face picture as the source. A function, so
   *  it is only worked out once there is an effect card at all. */
  cards: () => StripCard[] = () => stripCards(),
): Record<string, FxStrip> {
  // No effect card, no strip: skip the pairwise touch test entirely. This
  // runs on every tile drag frame and zoom tick. (A card docked on a loop
  // strip belongs to its rail, so it does not count.)
  if (!Object.values(nodes).some(n => n.type === 'effect' && !n.pin && !isDocked(n, nodes))) return {}
  // Each VISIBLE tile with what it brings to a strip: its own item, or —
  // for a deck's face — those of the members on its open strip, in deck
  // order (faceItems).
  const { faces, hidden } = tileDeckIndex(nodes)
  const tiles: { n: { id: string; x: number; y: number; width: number; height: number }; items: ChainItem[] }[] = []
  for (const n of Object.values(nodes)) {
    // A pinned face has taken its deck off the canvas with it. A card on a
    // loop strip — lifted mid-drag included, until its release decides —
    // is the rail's, not a strip's (see the header).
    if (hidden.has(n.id) || n.pin || isDocked(n, nodes)) continue
    const items = faces.has(n.id)
      ? faceItems(n, nodes, posters)
      : [stripItem(n, posters)].filter((i): i is ChainItem => i !== null)
    if (items.length) tiles.push({ n, items })
  }
  // A card stands in as its footprint, reading as its face picture.
  for (const c of cards()) tiles.push({ n: c.rect, items: [c.item] })
  const parent = tiles.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      if (rectsTouch(tiles[i].n, tiles[j].n, DOCK_TOLERANCE)) parent[find(j)] = find(i)
    }
  }
  const groups = new Map<number, typeof tiles>()
  tiles.forEach((t, i) => {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r)!.push(t)
  })
  const winRects = Object.values(windows).filter(w => !w.pin).map(w => viewportVisualRect(w, zoom))

  const strips: Record<string, FxStrip> = {}
  for (const members of groups.values()) {
    // Left to right; a tie (cards stacked in a column) reads top to bottom.
    members.sort((a, b) => (a.n.x - b.n.x) || (a.n.y - b.n.y))
    const items = members.flatMap(m => m.items)
    const effects = items.filter(i => i.kind === 'effect')
    if (effects.length === 0) continue
    // Keyed by the first ITEM, not the first tile: a face that brings no
    // item of its own (a note) would otherwise re-key the strip — and drop
    // its result — every time the deck is collapsed or opened.
    const key = items[0].id
    const win = winRects.find(w => members.some(m => rectsTouch(m.n, w, DOCK_TOLERANCE)))
    strips[key] = {
      key,
      items,
      memberIds: [...new Set(members.flatMap(m => [m.n.id, ...m.items.map(i => i.id)]))],
      windowId: win?.id ?? null,
      lastEffectId: effects[effects.length - 1].id,
      result: null,
      running: false,
    }
  }
  return strips
}

export function useFxStrips(): void {
  const nodes = useFreeNodeStore(s => s.nodes)
  const windows = useViewport3DStore(s => s.windows)
  const zoom = useCanvasStore(s => s.zoom)
  // A video's poster can land (or be regrown) after its tile is lined up.
  const posters = usePosterMapStore(s => s.map)
  // Cards head strips too (utils/fx/cardStrips): moving one, or changing
  // the picture its face shows, changes its strip.
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const lastShape = useRef('')
  const ranWith = useRef(new Map<string, string>())
  const timers = useRef(new Map<string, number>())
  const tokens = useRef(new Map<string, number>())

  useEffect(() => {
    const next = computeStrips(nodes, windows, zoom, posters, () => stripCards(groups, boards))
    // Tiles move on every drag frame; only publish when a strip's makeup
    // or its Viewer actually changed, so cards do not re-render per frame.
    // memberIds too: collapsing a deck behind a face that brings no item
    // changes who is on the strip without changing what it reads.
    const shape = JSON.stringify(Object.values(next).map(s => [s.key, s.items, s.windowId, s.memberIds]))
    if (shape !== lastShape.current) {
      lastShape.current = shape
      const prev = useFxStore.getState().strips
      for (const s of Object.values(next)) {
        const p = prev[s.key]
        if (p) { s.result = p.result; s.running = p.running }
      }
      useFxStore.getState().setStrips(next)
    }

    for (const s of Object.values(next)) {
      const sig = JSON.stringify(s.items)
      if (ranWith.current.get(s.key) === sig) continue
      ranWith.current.set(s.key, sig)
      window.clearTimeout(timers.current.get(s.key))
      timers.current.set(s.key, window.setTimeout(() => {
        const token = (tokens.current.get(s.key) ?? 0) + 1
        tokens.current.set(s.key, token)
        useFxStore.getState().patchStrip(s.key, { running: true })
        // No step previews: the cards no longer show the picture at each
        // step (each would be a GPU readback per slider tick) — the result
        // shows on the source picture itself (FxResultLayer).
        void runChain(s.items, LIVE_SIDE, false)
          // A run that throws is a result too (its error shown on the
          // cards and the picture) — otherwise `running` never clears.
          .catch((err): ChainResult => ({
            outputs: [], stepPreviews: new Map(), ignored: [], unreadable: [],
            error: String((err as Error)?.message ?? err),
          }))
          .then(result => {
            // A newer run for this strip started meanwhile: drop this one.
            if (tokens.current.get(s.key) !== token) return
            useFxStore.getState().patchStrip(s.key, { result, running: false })
          })
      }, 90))
    }
    for (const k of [...ranWith.current.keys()]) {
      if (next[k]) continue
      ranWith.current.delete(k)
      window.clearTimeout(timers.current.get(k))
      timers.current.delete(k)
    }
  }, [nodes, windows, zoom, posters, groups, boards])
}
