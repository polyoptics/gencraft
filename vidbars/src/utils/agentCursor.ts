// agentCursor.ts — the agent's pointer (Brian 2026-11-18): while Claude
// works in VidBars through the connector (utils/agentDoor), a pointer of
// its own shows where it is working, with a little bubble saying a few
// words about what it is doing. It is drawn by VidBars
// (components/UI/AgentCursor): it is not the mouse, takes no presses and
// moves nothing.
//
// Where it points is kept in canvas units, so it stays on what it points at
// as the view moves. Not persisted.

import { isPutAway } from './deckTree'
import { create } from 'zustand'
import { useBoardsStore } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { cardVisualRect } from '../hooks/useCardDecks'

interface AgentCursorState {
  /** On screen at all. */
  shown: boolean
  /** Where it points, canvas units. Null: the middle of the view. */
  at: { x: number; y: number } | null
  /** The few words in its bubble. */
  text: string
  /** On its way to a new spot: it glides. Otherwise it sits on its spot,
   *  riding along as the view moves. */
  gliding: boolean
}

export const useAgentCursor = create<AgentCursorState>(() => ({ shown: false, at: null, text: '', gliding: false }))

/** How long the glide to a new spot takes (the component's transition). */
export const AGENT_GLIDE_MS = 420
/** How long it stays after the agent's last request. */
const LINGER_MS = 7000

let hide: ReturnType<typeof setTimeout> | undefined
let land: ReturnType<typeof setTimeout> | undefined

/** Point at a canvas spot (or keep the spot, with `at` left out) and say
 *  `text`. It leaves by itself a few seconds after the last call. */
export function agentPoint(text: string, at?: { x: number; y: number } | null): void {
  useAgentCursor.setState(s => ({ shown: true, text, at: at === undefined ? s.at : at, gliding: at !== undefined || s.gliding }))
  if (at !== undefined) {
    clearTimeout(land)
    land = setTimeout(() => useAgentCursor.setState({ gliding: false }), AGENT_GLIDE_MS + 60)
  }
  clearTimeout(hide)
  hide = setTimeout(() => useAgentCursor.setState({ shown: false }), LINGER_MS)
}

/** The spot on a card the pointer rests on: a little in from its top-left. */
export function agentSpotOfCard(id: string): { x: number; y: number } | null {
  const { groups, boards } = useBoardsStore.getState()
  // A card inside a closed deck is pointed at on the deck's front card.
  let g = groups.find(x => x.id === id)
  for (let n = 0; g && n < 20 && isPutAway(g); n++) {
    const up = groups.find(x => x.id === g!.deckAnchorId)
    if (!up) break
    g = up
  }
  const r = g && cardVisualRect(g, boards, useCanvasStore.getState().zoom)?.rect
  if (!r) return null
  return { x: r.left + (r.right - r.left) * 0.35, y: r.top + (r.bottom - r.top) * 0.4 }
}

/** Glide to `at` saying `text`, and wait for the glide when the pointer has
 *  somewhere to come from: what the agent makes appears where it arrived. */
export async function agentGlide(text: string, at: { x: number; y: number } | null): Promise<void> {
  const was = useAgentCursor.getState()
  agentPoint(text, at)
  // Nothing to watch in a window nobody is looking at.
  if (document.hidden) return
  await new Promise(r => setTimeout(r, was.shown ? AGENT_GLIDE_MS : AGENT_GLIDE_MS + 120))
}
