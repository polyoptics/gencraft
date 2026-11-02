// explodedDemo.ts — side copy only: a fresh canvas gets a sample loop strip
// docked to a Viewer, so Layers can be tried without setting anything up.

import { useCanvasStore } from './store/canvasStore'
import { useFreeNodeStore } from './store/freeNodeStore'
import { useViewport3DStore } from './store/viewport3dStore'
import type { EffectKind } from './utils/fx/effects'
import { EFFECTS } from './utils/fx/effects'

const PICTURE = '/uploads/0079fd50-Gemini_Generated_Image_1zibjd1zibjd1zib.png'
const CARDS: [EffectKind, Record<string, number>][] = [
  ['cel', {}], ['ink', {}], ['grade', {}], ['halftone', { amount: 0.3, cell: 9 }], ['glow', {}],
]

export function seedExplodedDemo(): void {
  const store = useFreeNodeStore.getState
  if (Object.values(store().nodes).some(n => n.type === 'rail')) return
  const railId = store().addRail(300, 0, 0.8)
  const picture = store().addFreeNode(300, 700, 'image')
  store().updateFreeNode(picture, { imageUrl: PICTURE, mediaType: 'image', label: 'Nautiloid', width: 300, height: 300 })
  store().dockToRail([picture], { railId, kind: 'column', slotId: store().nodes[railId].rail!.slots[0].id, index: 0 })
  CARDS.forEach(([kind, params], i) => {
    const id = store().addFreeNode(300, 1100, 'effect')
    store().updateFreeNode(id, { effect: { kind, params }, label: EFFECTS[kind].label })
    store().dockToRail([id], { railId, kind: 'row', insertAt: i + 1 })
  })
  // After the sync host has sized the strip to what is docked on it.
  window.setTimeout(() => {
    const rail = store().nodes[railId]
    useViewport3DStore.getState().addWindow(rail.x + rail.width, rail.y)
    const zoom = Math.max(0.32, Math.min(0.75, (window.innerWidth - 140) / (rail.width + 480)))
    useCanvasStore.setState({ zoom, pan: { x: 40 - rail.x * zoom, y: 110 - rail.y * zoom } })
  }, 500)
}
