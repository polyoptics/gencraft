// A test cup for a State card (Brian 2026-11-08): a handful of states, each
// a master deck of a few real cards, the changes between them, and the
// output deck, so the State card can be tried straight away. One undo.

import { useBoardsStore } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { cardVisualRect } from '../hooks/useCardDecks'
import { createCardOrBoardAt } from './canvasCreate'
import { newDetailId } from './cardTypes'
import { reformOutput, setStates, type CardState, type StateChange } from './stateCard'

const STATES: { key: string; name: string; parent?: string; cards: [string, string][] }[] = [
  { key: 'whole', name: 'Whole', cards: [
    ['Glaze pattern', 'Cobalt rings on cream.'],
    ['Handle', 'Thumb rest worn smooth.'],
    ['Rim close-up', 'Glaze thin at the lip.'],
  ] },
  { key: 'chipped', name: 'Chipped', cards: [
    ['Chip on the rim', 'White clay showing.'],
    ['Glaze pattern', 'One band cut by the chip.'],
  ] },
  { key: 'broken', name: 'Broken', cards: [
    ['Shards on the floor', 'Five pieces, slivers.'],
    ['Shard texture', 'Rough grey-white inside.'],
    ['Broken edge close-up', 'Cobalt band cut through.'],
    ['Spilled tea', 'Dark pool, still steaming.'],
  ] },
  { key: 'glued', name: 'Glued', parent: 'broken', cards: [
    ['Gold seams', 'Gold in every crack.'],
    ['Missing piece', 'Gap by the handle.'],
  ] },
  { key: 'gone', name: 'Swept away', parent: 'broken', cards: [] },
]

const CHANGES: { name: string; from: string; to: string }[] = [
  { name: 'Knocked on the table', from: 'whole', to: 'chipped' },
  { name: 'Hero drops it', from: 'whole', to: 'broken' },
  { name: 'Glued back together', from: 'broken', to: 'glued' },
  { name: 'Swept up', from: 'broken', to: 'gone' },
]

const PALETTE = ['#3d6fb6', '#5a7fa8', '#8a5a3c', '#b08a2e']

export function fillTestCup(stateCardId: string): void {
  const bs0 = useBoardsStore.getState()
  const sc = bs0.groups.find(g => g.id === stateCardId)
  if (!sc?.stateCard) return
  const zoom = useCanvasStore.getState().zoom
  useUndoCoordinator.getState().checkpoint()
  if (!sc.name || sc.name === 'Card' || /^Card \d*$/.test(sc.name)) bs0.renameGroup(stateCardId, 'Cup')
  const rect = () => {
    const b = useBoardsStore.getState()
    const g = b.groups.find(x => x.id === stateCardId)!
    return cardVisualRect(g, b.boards, zoom)?.rect
  }
  // Tall enough for its list of states and changes.
  {
    const r = rect()
    if (r) bs0.setGroupCardSize(stateCardId, Math.max(r.right - r.left, sc.cardWidthOverride ?? 0), Math.max((r.right - r.left) * 1.3, r.bottom - r.top, sc.cardHeightOverride ?? 0))
  }
  const r0 = rect()
  const W = r0 ? r0.right - r0.left : 300
  const H = r0 ? r0.bottom - r0.top : 400
  const states: CardState[] = []
  const ids = new Map<string, string>()
  let col = 0
  STATES.forEach((st, si) => {
    const id = newDetailId()
    ids.set(st.key, id)
    const made: string[] = []
    st.cards.forEach(([name, text]) => {
      const boardId = createCardOrBoardAt(undefined, { noCheckpoint: true })
      const b = useBoardsStore.getState()
      const g = b.groups.find(x => x.boardIds.includes(boardId))
      if (!g) return
      b.renameGroup(g.id, `${st.name} · ${name}`)
      b.setGroupCardHeaderText(g.id, name)
      b.setGroupCardText(g.id, text)
      b.setGroupColor(g.id, PALETTE[si % PALETTE.length])
      made.push(g.id)
    })
    // Each state's deck in a line under the State card, a card's width apart.
    if (made.length && r0) {
      const b = useBoardsStore.getState()
      const moves: { groupId: string; originX: number; originY: number }[] = []
      let x = r0.left + col * W * 1.6
      const top = r0.bottom + H * 0.35
      for (const gid of made) {
        const g = b.groups.find(o => o.id === gid)!
        const r = cardVisualRect(g, b.boards, zoom)?.rect
        if (!r) continue
        moves.push({ groupId: gid, originX: g.originX + (x - r.left), originY: g.originY + (top - r.top) })
        x += r.right - r.left + 8
      }
      b.setGroupPosBatch(moves)
      useBoardsStore.getState().setDeckState(made, 'stacked', { asGiven: true })
      col++
    }
    states.push({ id, name: st.name, deck: made[0], parent: st.parent ? ids.get(st.parent) : undefined })
  })
  const changes: StateChange[] = CHANGES.map(c => ({ id: newDetailId(), name: c.name, from: ids.get(c.from), to: ids.get(c.to) }))

  // The output deck: right of the State card.
  const boardId = createCardOrBoardAt(r0 ? { cx: r0.right + W * 0.9, cy: (r0.top + r0.bottom) / 2 } : undefined, { noCheckpoint: true })
  const out = useBoardsStore.getState().groups.find(x => x.boardIds.includes(boardId))
  if (out) useBoardsStore.setState(s => ({ groups: s.groups.map(x => x.id === out.id ? { ...x, stateOut: stateCardId } : x) }))
  setStates(stateCardId, { states, changes, current: states[0].id, output: out?.id })
  reformOutput(stateCardId)
}
