// useDockedModels.ts — DERIVE the models docked to a viewport window.
//
// Dock membership is pure geometry (nothing stored): model tiles and
// model-bearing cards/decks whose rects touch the window within
// DOCK_TOLERANCE. Each source docks to at most one window (nearest edge
// wins — computeAllDocks partitions), so a model never appears in two
// switcher strips. Order: docked tiles in geometric order (edge rank,
// then along-edge position — users reorder by sliding tiles), then deck
// models in deck-traversal order; deduped by url (first wins).

import { useMemo } from 'react'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useBoardsStore } from '../store/boardsStore'
import { useViewport3DStore } from '../store/viewport3dStore'
import { computeAllDocks, type DockableItem, type WindowRect } from '../utils/viewportDocking'
import { collectDeckModels, groupHasModels } from '../utils/modelTraversal'
import { groupSlot } from '../utils/nlePush'
import { computeGroupLayout } from '../utils/nleRows'
import { isHiddenDeckMember } from './useCardDecks'
import { getModelPoster } from '../three/posterService'

export interface DockedModel {
  url: string
  posterUrl?: string | null
  name: string
  source: { kind: 'tile'; nodeId: string } | { kind: 'deck'; groupId: string }
}

const TILE_PREFIX = 'tile:'
const GROUP_PREFIX = 'group:'

export function useDockedModels(windowId: string): DockedModel[] {
  const windows = useViewport3DStore(s => s.windows)
  const nodes = useFreeNodeStore(s => s.nodes)
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)

  return useMemo(() => {
    const winRects: WindowRect[] = Object.values(windows).map(w =>
      ({ id: w.id, x: w.x, y: w.y, width: w.width, height: w.height }))
    if (!winRects.some(w => w.id === windowId)) return []

    const items: DockableItem[] = []
    // Model tiles
    for (const n of Object.values(nodes)) {
      if (n.type === 'model' && n.imageUrl) {
        items.push({ id: TILE_PREFIX + n.id, x: n.x, y: n.y, width: n.width, height: n.height })
      }
    }
    // Visible cards/decks with ≥1 model in their recursive content.
    // Anchors represent whole stacked decks (hidden members sit behind them).
    for (const g of groups) {
      if (isHiddenDeckMember(g)) continue
      if (!groupHasModels(g.id, groups, boards)) continue
      const slot = groupSlot(g.id, g.boardIds, boards, g.originX, g.originY, computeGroupLayout(g.boardIds, boards))
      if (!slot) continue
      items.push({ id: GROUP_PREFIX + g.id, x: slot.left, y: slot.top, width: slot.right - slot.left, height: slot.bottom - slot.top })
    }

    const docked = computeAllDocks(winRects, items).get(windowId) ?? []

    const out: DockedModel[] = []
    const seen = new Set<string>()
    for (const d of docked) {
      if (d.id.startsWith(TILE_PREFIX)) {
        const n = nodes[d.id.slice(TILE_PREFIX.length)]
        if (!n?.imageUrl || seen.has(n.imageUrl)) continue
        seen.add(n.imageUrl)
        out.push({
          url: n.imageUrl,
          posterUrl: n.posterUrl ?? getModelPoster(n.imageUrl),
          name: n.label || 'Model',
          source: { kind: 'tile', nodeId: n.id },
        })
      } else {
        const gid = d.id.slice(GROUP_PREFIX.length)
        for (const m of collectDeckModels(gid, groups, boards)) {
          if (seen.has(m.url)) continue
          seen.add(m.url)
          out.push({
            url: m.url,
            posterUrl: m.posterUrl ?? getModelPoster(m.url),
            name: m.name,
            source: { kind: 'deck', groupId: gid },
          })
        }
      }
    }
    return out
  }, [windowId, windows, nodes, groups, boards])
}
