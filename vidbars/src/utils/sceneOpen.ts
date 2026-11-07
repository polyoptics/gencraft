// A scene card's division opened into a scene card of its own (Brian's
// scene tree, 2026-11-06): the first open makes a new Scene card right of
// the scene, named after the division, its section in the division's
// colour holding the division's card. The division remembers it
// (SceneDiv.opens); opening again goes to that card.

import { useBoardsStore } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { cardVisualRect } from '../hooks/useCardDecks'
import { createCardOrBoardAt } from './canvasCreate'
import { findDiv, heldCard, newSceneLayout, patchDiv } from './sceneCard'

/** The scene card a division opens into, if it is still there. */
export function divisionScene(divOpens: string | undefined): string | null {
  if (!divOpens) return null
  return useBoardsStore.getState().groups.some(g => g.id === divOpens) ? divOpens : null
}

export function openDivision(sceneId: string, divId: string): string | null {
  const bs0 = useBoardsStore.getState()
  const scene = bs0.groups.find(g => g.id === sceneId)
  const div = scene?.scene ? findDiv(scene.scene, divId) : null
  if (!scene?.scene || !div) return null
  const there = divisionScene(div.opens)
  if (there) {
    useCanvasStore.getState().jumpToGroup(there)
    useBoardsStore.getState().setSelectedGroup(there)
    return there
  }
  const zoom = useCanvasStore.getState().zoom
  const parent = cardVisualRect(scene, bs0.boards, zoom)?.rect
  // Made at the scene's right (createCardOrBoardAt takes the checkpoint).
  const boardId = createCardOrBoardAt(parent ? { cx: parent.right + (parent.right - parent.left), cy: (parent.top + parent.bottom) / 2 } : undefined)
  let bs = useBoardsStore.getState()
  const child = bs.groups.find(g => g.boardIds.includes(boardId))
  if (!child) return null
  const name = div.name?.trim() || 'Scene'
  bs.renameGroup(child.id, name)
  bs.setCardsType([child.id], 'scene')
  bs.setGroupScene(child.id, newSceneLayout(name, { color: div.color, card: heldCard(div) }))
  if (scene.cardWidthOverride || scene.cardHeightOverride) bs.setGroupCardSize(child.id, scene.cardWidthOverride, scene.cardHeightOverride)
  // Lined up with the scene: tops level, a gap of a fifth of its width.
  bs = useBoardsStore.getState()
  const made = bs.groups.find(g => g.id === child.id)!
  const r = cardVisualRect(made, bs.boards, zoom)?.rect
  if (parent && r) {
    const gap = (parent.right - parent.left) * 0.2
    bs.setGroupPos(made.id, made.originY + (parent.top - r.top), made.originX + (parent.right + gap - r.left))
  }
  const root = useBoardsStore.getState().groups.find(g => g.id === sceneId)?.scene
  if (root) useBoardsStore.getState().setGroupScene(sceneId, patchDiv(root, divId, { opens: made.id }))
  useBoardsStore.getState().setSelectedGroup(made.id)
  return made.id
}
