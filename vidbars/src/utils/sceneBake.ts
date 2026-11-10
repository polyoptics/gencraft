// Baking a scene card's division back out to the canvas (Brian
// 2026-11-10): "start with a scene card, divide it into sections, put
// images and new information in them, then bake that back out to a card,
// where you could then make a deck out of it with all the information
// you'd want to pass, and then put it back in a scene card".
//
// A division bakes to a NEW card: its header, text and picture as they
// show, with its text look. With its cast: a closed deck, that card in
// front, then a LINKED card of each card it gathers (its own cast, and
// what its headings hand down). A section (by its heading) bakes to a
// closed deck: the heading's card in front, then one card per division in
// it. Nothing already on the canvas moves; the scene card is not changed.

import { useBoardsStore, NEW_CARD_FACE } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { DEFAULT_BODY_STYLE, DEFAULT_HEADER_STYLE } from '../store/freeNodeStore'
import { cardVisualRect } from '../hooks/useCardDecks'
import { viewportCenterInCanvas } from './canvasCreate'
import { cardFaceSize, createTextCard } from './cardGrid'
import { makeLinkedCard, masterOf } from './linkedCards'
import { findDiv, gathered, heldCard, isLeaf, leaves, sectionOf, type SceneDiv } from './sceneCard'
import { shownContent } from './sceneContent'

const TOUCH_GAP = 8

type Rect = { left: number; right: number; top: number; bottom: number }

const rectOf = (id: string): Rect | null => {
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(x => x.id === id)
  return (g && cardVisualRect(g, bs.boards, useCanvasStore.getState().zoom)?.rect) || null
}

/** A clear spot for a card right of the scene card: level with its top,
 *  then down past whatever already lies there. Its centre. */
function spotBeside(sceneId: string): { cx: number; cy: number } {
  const face = cardFaceSize()
  const sc = rectOf(sceneId)
  if (!sc) return viewportCenterInCanvas()
  const bs = useBoardsStore.getState()
  const others = bs.groups.filter(g => g.id !== sceneId).map(g => rectOf(g.id)).filter(Boolean) as Rect[]
  const left = sc.right + face.w * 0.6
  let top = sc.top
  for (let n = 0; n < 40; n++) {
    const hit = others.find(o => o.left < left + face.w * 1.2 && o.right > left - TOUCH_GAP && o.top < top + face.h * 1.2 && o.bottom > top - TOUCH_GAP)
    if (!hit) break
    top = hit.bottom + face.h * 0.25
  }
  return { cx: left + face.w / 2, cy: top + face.h / 2 }
}

/** A new card from a division, as it shows: header, text, picture, look. */
function cardOf(d: SceneDiv, at: { cx: number; cy: number }): string {
  const bs0 = useBoardsStore.getState()
  const c = shownContent(d, bs0.groups.find(g => g.id === heldCard(d)))
  const id = createTextCard(at, { title: c.name, body: c.notes })
  const bs = useBoardsStore.getState()
  if (c.image) bs.setGroupCardHeroImage(id, c.image)
  if (d.hstyle) bs.setGroupCardHeaderTextStyle(id, { ...DEFAULT_HEADER_STYLE, ...d.hstyle })
  if (d.bstyle) bs.setGroupCardTextStyle(id, { ...DEFAULT_BODY_STYLE, ...d.bstyle })
  if (d.split != null) bs.setGroupTextSplitRatio(id, d.split)
  if (c.image || d.hero) bs.setGroupCardHeroTransform(id, { ...NEW_CARD_FACE, ...(d.hero ?? {}) })
  if (d.color) useBoardsStore.setState(s => ({ groups: s.groups.map(g => g.id === id ? { ...g, color: d.color! } : g) }))
  return id
}

/** Cards in a row from the first, touching, then closed as one deck. */
function closeAsDeck(ids: string[]): void {
  const fr = rectOf(ids[0])
  if (!fr || ids.length < 2) return
  let x = fr.right + TOUCH_GAP
  const moves: { groupId: string; originX: number; originY: number }[] = []
  for (const id of ids.slice(1)) {
    const g = useBoardsStore.getState().groups.find(o => o.id === id)
    const r = rectOf(id)
    if (!g || !r) continue
    moves.push({ groupId: id, originX: g.originX + (x - r.left), originY: g.originY + (fr.top - r.top) })
    x += (r.right - r.left) + TOUCH_GAP
  }
  if (moves.length) useBoardsStore.getState().setGroupPosBatch(moves)
  useBoardsStore.getState().setDeckState(ids, 'stacked', { asGiven: true })
}

/** Bake division `divId` out: a card, or (withCast) a closed deck of that
 *  card and a linked card of each card it gathers. A section's heading
 *  with `section`: the whole section, one card per division. Returns the
 *  new card (the deck's front). One undo takes it all back. */
export function bakeDivision(sceneId: string, divId: string, how: 'card' | 'deck' | 'section'): string | null {
  const root = useBoardsStore.getState().groups.find(g => g.id === sceneId)?.scene
  const d = root ? findDiv(root, divId) : null
  if (!root || !d || !isLeaf(d)) return null
  useUndoCoordinator.getState().checkpoint()
  const at = spotBeside(sceneId)
  const front = cardOf(d, at)
  const ids = [front]
  if (how === 'deck') {
    const g = gathered(root, divId)
    const groups = useBoardsStore.getState().groups
    const cast = [...g.own, ...g.handed.flatMap(h => h.cards)]
    const seen = new Set<string>()
    for (const c of cast) {
      const m = masterOf(groups, c)
      if (seen.has(m) || !groups.some(x => x.id === m)) continue
      seen.add(m)
      const l = makeLinkedCard(m)
      if (l) ids.push(l)
    }
  } else if (how === 'section') {
    const sec = sectionOf(root, divId)
    for (const l of sec ? leaves(sec).filter(x => x.id !== divId) : []) ids.push(cardOf(l, at))
  }
  closeAsDeck(ids)
  useBoardsStore.getState().setSelectedGroups(ids.length > 1 ? ids : [front])
  return front
}
