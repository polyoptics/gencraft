// promptCards.ts — making Prompt cards (card type Prompt: each row on its
// back a group of words, comma separated), for the Card Prompts pad
// (components/CardBacks/CardPromptPad). Made from the top bar's Prompt
// card button, like effect cards (Brian 2026-11-06): a blank one, one of
// the ready-made ones, or all the ready-made ones as a deck.

import { useBoardsStore } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { createCardOrBoardAt } from './canvasCreate'
import { cardVisualRect } from '../hooks/useCardDecks'
import { newDetailId } from './cardTypes'
import { visibleCanvasCenter } from './fx/createEffect'
import { useUndoCoordinator } from '../store/undoCoordinator'

export interface PromptPreset { name: string; rows: [string, string][] }

/** Ready-made Prompt cards (Brian 2026-11-06, his words). "Old Prompt Pad
 *  words" carries over the first Prompt Pad's starting words. */
export const PROMPT_PRESETS: PromptPreset[] = [
  { name: 'Audio', rows: [
    ['Era', '70s'], ['Genre', 'sci-fi'], ['Sound', 'synthesizer, chords, arpeggiated'],
    ['Mood', 'melancholy'], ['Texture', 'VHS'],
  ] },
  { name: '3D generation', rows: [
    ['Pose', 'pose the character, T-pose, arms to the side, arms straight out, legs spread, feet flat, looking forward, relaxed, neutral pose'],
    ['For 3D', 'even lighting, texture atlas, seamless'],
  ] },
  { name: 'My style', rows: [
    ['Finish', 'rough hand-inked retro-futurist illustration finish, bold dark contours, scratchy linework, crosshatched shadows, painterly/cel-shaded color blocks, textured print-like surface'],
    ['Palette', 'muted pale blues, ivories and charcoals, restrained rust accents'],
    ['Avoid', 'no photoreal skin pores, no added products, no gear, no spacecraft, no weapons, no typography, no extra subjects'],
  ] },
  { name: 'Old Prompt Pad words', rows: [
    ['Framing', 'isometric view, orthographic view, front, back, left, right, arms out to the side, 3/4 view'],
    ['Grids', '2x2 grid, 3x3 grid, where each cell contains, sprite sheet'],
    ['Isolation', 'clean black background, clean white background, transparent background, no shadow'],
    ['Style matching', 'in the same style as the reference images, flat vector, painterly, photoreal, blueprint'],
  ] },
]

/** A Prompt card (blank, or `preset`), its card's top-left at (left, top),
 *  or its middle at the middle of what you can see. Turned over to its
 *  back, where its words are. Returns its id. */
export function makePromptCard(preset?: PromptPreset, at?: { left: number; top: number }, select = true): string | null {
  const zoom = useCanvasStore.getState().zoom
  const boardId = createCardOrBoardAt(at ? { cx: at.left, cy: at.top } : visibleCanvasCenter())
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(x => x.boardIds.includes(boardId))
  if (!g) return null
  bs.renameGroup(g.id, preset?.name ?? 'Prompt')
  bs.setGroupCardType(g.id, 'prompt')
  if (preset) bs.setGroupDetails(g.id, preset.rows.map(([name, value]) => ({ id: newDetailId(), name, value })))
  bs.setGroupFlipped(g.id, true)
  if (at) {
    const now = useBoardsStore.getState()
    const v = cardVisualRect(now.groups.find(x => x.id === g.id)!, now.boards, zoom)
    if (v) now.setGroupPos(g.id, g.originY + (at.top - v.rect.top), g.originX + (at.left - v.rect.left))
  }
  if (select) useBoardsStore.getState().setSelectedGroup(g.id)
  return g.id
}

/** A card's visual rect, now. */
export function cardRect(id: string) {
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(x => x.id === id)
  return g ? cardVisualRect(g, bs.boards, useCanvasStore.getState().zoom)?.rect ?? null : null
}

/** Every ready-made Prompt card, side by side and touching: one deck,
 *  in the middle of what you can see. */
export function makePromptDeck(): void {
  // One undo for the whole deck: each card's own checkpoint is held back.
  const uc = useUndoCoordinator.getState()
  uc.checkpoint()
  const own = uc.checkpoint
  useUndoCoordinator.setState({ checkpoint: () => {} })
  try { dealDeck() } finally { useUndoCoordinator.setState({ checkpoint: own }) }
}

function dealDeck(): void {
  const mid = visibleCanvasCenter()
  const first = makePromptCard(PROMPT_PRESETS[0], undefined, false)
  const r0 = first ? cardRect(first) : null
  if (!first || !r0) return
  const w = r0.right - r0.left, h = r0.bottom - r0.top
  const n = PROMPT_PRESETS.length
  const gap = 4   // world units: well inside the touch distance, so they form one deck
  let left = mid.cx - (n * w + (n - 1) * gap) / 2
  const top = mid.cy - h / 2
  const ids: string[] = []
  PROMPT_PRESETS.forEach((p, i) => {
    const id = i === 0 ? first : makePromptCard(p, undefined, false)
    if (!id) return
    const r = cardRect(id)
    const bs = useBoardsStore.getState()
    const g = bs.groups.find(x => x.id === id)
    if (r && g) bs.setGroupPos(id, g.originY + (top - r.top), g.originX + (left - r.left))
    left += (r ? r.right - r.left : w) + gap
    ids.push(id)
  })
  useBoardsStore.getState().setSelectedGroups(ids)
}
