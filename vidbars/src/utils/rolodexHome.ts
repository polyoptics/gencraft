// rolodexHome.ts — identity for the ONE Rolodex the toolbar's Cards
// button drives.
//
// The home Rolodex is an ordinary `list` free node; `canvasStore
// .homeRolodexId` just points at it. A pointer rather than a flag on the
// node, because a flag is duplicated by paste and by project insert and
// two homes is unrecoverable — whereas a DANGLING pointer self-heals
// here, which is why the wholesale node-map replacements (templates,
// presets, project load) need no knowledge of this at all.

import { useEffect } from 'react'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useCanvasStore } from '../store/canvasStore'
import { LEFTCOL_W, LIST_AREA_H_COMPACT, EMBED_CHROME } from '../components/Rolodex/CardRolodex'

/** Toolbar height — `rolodexPos` is document px (the old panel was
 *  position:fixed) while `pin` is container px. */
const APP_TOOLBAR_H = 38
/** FreeNode's own header strip at scale 1 (20px + its border). */
const FREE_NODE_HEADER_PX = 22

let bootstrapped = false

function hydrated(): boolean {
  return useFreeNodeStore.persist.hasHydrated() && useCanvasStore.persist.hasHydrated()
}

/** The home node id, minting it if the pointer is null or dangling.
 *  Returns null BEFORE hydration: minting against a not-yet-rehydrated
 *  (empty) node map would create a node that zustand's shallow merge then
 *  deletes, leaving a dangling pointer AND an orphaned pinned panel. */
export function ensureRolodexHome(): string | null {
  const cs = useCanvasStore.getState()
  const fns = useFreeNodeStore.getState()
  if (cs.homeRolodexId && fns.nodes[cs.homeRolodexId]) return cs.homeRolodexId
  if (!hydrated()) return null

  // ADOPT before minting. The pointer can be lost while its node survives
  // (an undo that restores an older canvas snapshot, a dev reload), and
  // minting in that state would leave two identical panels stacked on the
  // same pixels with no way to tell them apart.
  const orphan = Object.values(fns.nodes).find(n => n.type === 'list' && n.label === 'Cards' && n.pin)
  if (orphan) { cs.setHomeRolodexId(orphan.id); return orphan.id }

  // Seed from the legacy floating-panel prefs so an upgrading user's
  // panel comes back where and how they left it. Height is the exact
  // inverse of the embedded adapter's expansion derivation.
  const height = FREE_NODE_HEADER_PX + EMBED_CHROME
               + Math.max(0, LIST_AREA_H_COMPACT + cs.rolodexExpansion)
  const id = fns.addFreeNode(0, 0, 'list')   // canvas x/y are placeholders
  fns.updateFreeNode(id, {
    label: 'Cards',
    width: LEFTCOL_W,
    height,
    // MUST be set — the embedded state adapter bails without a listQuery.
    listQuery: {
      query: '', kind: 'all', includeCanvasItems: false,
      sortMode: cs.rolodexSortMode,
      view: cs.rolodexView,
      displayMode: cs.rolodexDisplayMode,
      collapsedDeckIds: [...cs.rolodexCollapsedDeckIds],
    },
    pin: { x: cs.rolodexPos.x, y: Math.max(0, cs.rolodexPos.y - APP_TOOLBAR_H), scale: 1 },
  })
  cs.setHomeRolodexId(id)
  return id
}

/** Mount once in App. Runs on the hydration edge so the panel exists
 *  before PinLayer's first paint — no lazy-mint gap in which an upgrading
 *  user's open panel is simply missing. */
export function useRolodexHomeBootstrap(): void {
  useEffect(() => {
    if (bootstrapped) return
    const run = () => {
      if (!bootstrapped && hydrated()) { bootstrapped = true; ensureRolodexHome() }
    }
    run()
    const a = useFreeNodeStore.persist.onFinishHydration(run)
    const b = useCanvasStore.persist.onFinishHydration(run)
    return () => { a(); b() }
  }, [])
}
