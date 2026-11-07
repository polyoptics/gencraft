// A test blockout for a scene card (Brian 2026-11-07: "three acts, three
// scenes per act, and some assortment of shots, just to populate a whole
// thing so that we can try the different look modes"). Fills the scene's
// face (one undo) and deals a small cast of cards below it, some of them
// held in shots, so Focus, Bump-outs and Trace have something to show.

import { useBoardsStore } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { cardVisualRect } from '../hooks/useCardDecks'
import { createCardOrBoardAt } from './canvasCreate'
import type { CardType } from './cardTypes'
import { newDetailId } from './cardTypes'
import { leaf, type SceneDiv } from './sceneCard'
import { copyFrom } from './sceneContent'

const ACTS: { name: string; color: string; scenes: { name: string; shots: string[] }[] }[] = [
  { name: 'ACT 1', color: '#5b8dd9', scenes: [
    { name: 'Dust Wake', shots: ['Wide: the dunes', 'Crawler pass', 'Close: the scout'] },
    { name: 'The Long Signal', shots: ['Radio tower', 'Static'] },
    { name: 'Ironmarket', shots: ['Crowd', 'Haggle', 'The rifle', 'Pickpocket'] },
  ] },
  { name: 'ACT 2', color: '#1f9ea6', scenes: [
    { name: 'Night Convoy', shots: ['Headlights', 'Ambush', 'Rollover'] },
    { name: 'Breakwater', shots: ['Flooded gate', 'Drone up'] },
    { name: 'Reunion', shots: ['Two shot', 'Flash cut'] },
  ] },
  { name: 'ACT 3', color: '#f2994a', scenes: [
    { name: 'Gutterlight', shots: ['Alley chase', 'Rooftops', 'Fall'] },
    { name: 'The Climb', shots: ['Ladder', 'Summit'] },
    { name: 'Last Broadcast', shots: ['Mic', 'The city listens', 'Black'] },
  ] },
]

const BUDGET = ['low', 'mid', 'high']
const SHOT_KIND = ['Wide', 'Medium', 'Close-up', 'Insert', 'Tracking']

const CAST: { name: string; type: CardType; text: string; details: [string, string][] }[] = [
  { name: 'Rook Vasska', type: 'character', text: 'Scout who hears the signal first.', details: [['Role', 'Lead'], ['Budget', 'high']] },
  { name: 'Tilly Gearjaw', type: 'character', text: 'Mechanic, owes everybody.', details: [['Role', 'Support'], ['Budget', 'mid']] },
  { name: 'Scrap Rifle', type: 'prop', text: 'Bolt-action, wired with copper.', details: [['Kind', 'Weapon'], ['Ammo', '6'], ['Budget', 'low']] },
  { name: 'Signal Drone', type: 'prop', text: 'Old survey drone, one rotor bent.', details: [['Kind', 'Vehicle'], ['Budget', 'high']] },
  { name: 'Ironmarket Bazaar', type: 'location', text: 'A market in a dry dock.', details: [['Use', 'Commercial'], ['Floors', '3'], ['Budget', 'mid']] },
]

/** Which shots hold which cast card (act, scene, shot -> cast index). */
const HOLDS: [number, number, number, number][] = [
  [0, 0, 2, 0], [0, 2, 2, 2], [0, 2, 0, 4], [1, 1, 1, 3], [1, 2, 0, 1], [2, 0, 0, 0], [2, 2, 1, 3],
]

export function fillBlockout(sceneId: string): void {
  const bs0 = useBoardsStore.getState()
  const scene = bs0.groups.find(g => g.id === sceneId)
  if (!scene) return
  const zoom = useCanvasStore.getState().zoom
  const rect0 = cardVisualRect(scene, bs0.boards, zoom)?.rect
  useUndoCoordinator.getState().checkpoint()
  // Wide, like a sheet: about two and a half times its width.
  if (rect0) {
    const w = rect0.right - rect0.left, h = rect0.bottom - rect0.top
    bs0.setGroupCardSize(sceneId, Math.max(w * 2.6, scene.cardWidthOverride ?? 0), Math.max(h * 1.15, scene.cardHeightOverride ?? 0))
  }
  const bs = useBoardsStore.getState()
  const rect = cardVisualRect(bs.groups.find(g => g.id === sceneId)!, bs.boards, zoom)?.rect

  // The cast, in a line under the scene, side by side.
  const cast: string[] = []
  let x = rect?.left ?? 0
  CAST.forEach(c => {
    const boardId = createCardOrBoardAt(rect ? { cx: x, cy: rect.bottom } : undefined, { noCheckpoint: true })
    const b = useBoardsStore.getState()
    const g = b.groups.find(gr => gr.boardIds.includes(boardId))
    if (!g) return
    b.renameGroup(g.id, c.name)
    b.setCardsType([g.id], c.type)
    b.setGroupCardHeaderText(g.id, c.name)
    b.setGroupCardText(g.id, c.text)
    const det = (useBoardsStore.getState().groups.find(gr => gr.id === g.id)?.details ?? []).map(d => ({ ...d }))
    for (const [name, value] of c.details) {
      const have = det.find(d => d.name.toLowerCase() === name.toLowerCase())
      if (have) have.value = value
      else det.push({ id: newDetailId(), name, value })
    }
    useBoardsStore.getState().setGroupDetails(g.id, det)
    // Lined up: tops a little under the scene, a small gap between.
    const now = useBoardsStore.getState()
    const made = now.groups.find(gr => gr.id === g.id)!
    const r = cardVisualRect(made, now.boards, zoom)?.rect
    if (rect && r) {
      const gap = (r.right - r.left) * 0.12
      now.setGroupPos(made.id, made.originY + (rect.bottom + gap * 2 - r.top), made.originX + (x - r.left))
      x += (r.right - r.left) + gap
    }
    cast.push(g.id)
  })

  let n = 0
  const acts: SceneDiv[] = ACTS.map((act, ai) => {
    const scenes: SceneDiv[] = act.scenes.map((sc, si) => {
      const shots = sc.shots.map((shot, hi) => {
        const hold = HOLDS.find(h => h[0] === ai && h[1] === si && h[2] === hi)
        const k = n++
        const card = hold ? cast[hold[3]] : undefined
        return leaf(shot, shade(act.color, 0.12 + (hi % 2) * 0.1), {
          ...(card ? copyFrom(useBoardsStore.getState().groups.find(g => g.id === card)!) : { notes: `${SHOT_KIND[k % SHOT_KIND.length]}\nBudget: ${BUDGET[(k * 7 + ai) % 3]}` }),
          ...(k % 5 === 3 ? { bump: true } : {}),
        })
      })
      // The last scene of an act is squeezed: its shots drop to one row.
      return { id: newDetailId(), dir: 'col' as const, sizes: si === 2 ? [0.32, 0.68] : [0.24, 0.76], kids: [
        leaf(sc.name, shade(act.color, -0.08)),
        { id: newDetailId(), dir: 'row' as const, sizes: shots.map(() => 1 / shots.length), kids: shots },
      ] }
    })
    return { id: newDetailId(), dir: 'col' as const, sizes: [0.09, 0.4, 0.39, 0.12], kids: [leaf(act.name, act.color, { bump: true }), ...scenes] }
  })
  const root: SceneDiv = { id: newDetailId(), dir: 'col', sizes: [0.07, 0.93], kids: [
    leaf('Story', '#87a7e0'),
    { id: newDetailId(), dir: 'row', sizes: [0.4, 0.33, 0.27], kids: acts },
  ] }
  useBoardsStore.getState().setGroupScene(sceneId, root)
  useBoardsStore.getState().setGroupSceneView(sceneId, { bumps: true })
}

/** A colour lighter (amt > 0) or darker (amt < 0). */
function shade(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const v = parseInt(m[1], 16)
  const ch = (c: number) => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt))
  const r = ch((v >> 16) & 255), g = ch((v >> 8) & 255), b = ch(v & 255)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}
