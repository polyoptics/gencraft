// "Join" on the seam between two scene cards lying against one another
// (Brian 2026-11-16: "magnet the scene cards together and then click on one
// of those seams and say Join cards"; then, of a small knob that showed
// only on the card: "I still can't find that knob ... If it's a mysterious
// mystery for me to find it, how is anyone going to find it?").
//
// So it is a button that SAYS Join, on the seam itself, there for as long as
// the two cards lie against one another (it comes up as one is dragged
// against the other). The left or top card keeps its name (utils/sceneSplit).

import React from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { cardVisualRect } from '../../hooks/useCardDecks'
import { joinNeighbour, joinSceneCards } from '../../utils/sceneSplit'

export const SceneJoinSeams: React.FC = () => {
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const zoom = useCanvasStore(s => s.zoom) || 1
  const pan = useCanvasStore(s => s.pan)
  const seams: React.ReactNode[] = []
  for (const g of groups) {
    if (!g.scene || g.cardType !== 'scene' || g.pin || g.flipped || g.linkOf) continue
    if (g.deckState === 'stacked' && g.deckAnchorId && g.deckAnchorId !== g.id) continue
    const a = cardVisualRect(g, boards, zoom)?.rect
    if (!a) continue
    for (const side of ['right', 'bottom'] as const) {
      const other = joinNeighbour(g.id, side)
      const og = other ? groups.find(x => x.id === other) : undefined
      const b = og && !og.pin ? cardVisualRect(og, boards, zoom)?.rect : undefined
      if (!other || !b) continue
      const row = side === 'right'
      // On the seam: in the middle of a side seam; right of the middle of a
      // top-and-bottom one, clear of the upper card's "..." and the lower
      // card's name.
      const cx = row ? (a.right + b.left) / 2 : Math.max(a.left, b.left) + (Math.min(a.right, b.right) - Math.max(a.left, b.left)) * 0.72
      const cy = row ? (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2 : (a.bottom + b.top) / 2
      seams.push(
        <button
          key={`${g.id}:${side}`}
          type="button"
          data-scene-join={`${g.id}:${other}`}
          title={row ? 'Join cards: these two scene cards become one. The left one keeps its name' : 'Join cards: these two scene cards become one. The top one keeps its name'}
          onPointerDown={e => e.stopPropagation()}
          onDoubleClick={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); joinSceneCards(g.id, other, row ? 'row' : 'col') }}
          style={{
            position: 'absolute', left: cx * zoom + pan.x, top: cy * zoom + pan.y, transform: 'translate(-50%, -50%)', zIndex: 58,
            height: 20, padding: '0 9px 0 7px', display: 'flex', alignItems: 'center', gap: 5, boxSizing: 'border-box', borderRadius: 10,
            background: '#ffd666', color: '#111', border: '1.5px solid #fff', boxShadow: '0 2px 7px rgba(0,0,0,0.55)',
            fontSize: 11, fontWeight: 800, lineHeight: 1, fontFamily: 'system-ui, -apple-system, sans-serif', whiteSpace: 'nowrap',
            cursor: 'pointer', pointerEvents: 'auto',
          }}
        >
          <svg width="11" height="11" viewBox="0 0 10 10">
            <path d={row ? 'M1 2h8v6H1zM3.2 5h3.6M4.4 3.8L3.2 5l1.2 1.2M5.6 3.8L6.8 5 5.6 6.2' : 'M2 1h6v8H2zM5 3.2v3.6M3.8 4.4L5 3.2l1.2 1.2M3.8 5.6L5 6.8l1.2-1.2'} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Join
        </button>,
      )
    }
  }
  return <>{seams}</>
}
