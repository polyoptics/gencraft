// "Join" on the seam between two scene cards lying against one another
// (Brian 2026-11-16: "magnet the scene cards together and then click on one
// of those seams and say Join cards"; of a small knob that showed only on
// the card: "If it's a mysterious mystery for me to find it, how is anyone
// going to find it?"; then, of a button always on the seam: "once they're
// magnetized then, if I hold my mouse over the line between them, the
// magnetized line then I can do the joining").
//
// Then (Brian 2026-11-16): the lines in plain white, never a colour ("it
// could clash with the colors of the cards"), and not left hanging between
// every scene on the canvas: they show while scene cards are being moved
// and for a few seconds after, then fade ("once you drop a scene card...
// after 5 seconds they fade away", a wiggle brings them back). Only where
// the two really are magneted, never where they are merely near.
//
// So: the seam of two magneted scene cards is DRAWN, a thin line between
// them, while awake. The mouse held over that line lights it and brings up a
// button that SAYS Join, on the line just beside the pointer (never under
// it, so a press there still reaches the card's own edge). It stays while
// the pointer is on the line or on it. The left or top card keeps its name
// (utils/sceneSplit).

import React, { useEffect, useRef, useState } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { cardVisualRect } from '../../hooks/useCardDecks'
import { joinNeighbour, joinSceneCards } from '../../utils/sceneSplit'
import { drawnTopFix } from '../../utils/cardEdgeSnap'

interface Seam { key: string; a: string; b: string; row: boolean; x1: number; y1: number; x2: number; y2: number; reach: number }

const BTN_W = 62      // about the button's width, px
const BESIDE = 44     // how far along the line from the pointer it comes up
const AWAKE_MS = 5000 // how long the lines stay after scene cards last moved
const MAGNETED = 3    // px over the magnet's own gap that still counts as magneted

export const SceneJoinSeams: React.FC = () => {
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const zoom = useCanvasStore(s => s.zoom) || 1
  const pan = useCanvasStore(s => s.pan)
  // The seam the pointer is held over, and where along it (0..1) its button is.
  const [hot, setHot] = useState<{ key: string; t: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const seams: Seam[] = []
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
      const sx = (v: number) => v * zoom + pan.x, sy = (v: number) => v * zoom + pan.y
      // The line: midway between the two, along the stretch they share.
      // Over and under: to the lower card's header band as it is drawn. The
      // band may lie a little over the upper card (magneted at a closer
      // zoom): the line is then along the band's top.
      const bTop = b.top + drawnTopFix(zoom)
      const gapPx = (row ? b.left - a.right : bTop - a.bottom) * zoom
      if (gapPx > 12 * zoom + MAGNETED) continue
      const midY = gapPx > 0 ? (a.bottom + bTop) / 2 : bTop
      const s: Seam = row
        ? { key: `${g.id}:right`, a: g.id, b: other, row, x1: sx((a.right + b.left) / 2), x2: sx((a.right + b.left) / 2), y1: sy(Math.max(a.top, b.top)), y2: sy(Math.min(a.bottom, b.bottom)), reach: 0 }
        : { key: `${g.id}:bottom`, a: g.id, b: other, row, y1: sy(midY), y2: sy(midY), x1: sx(Math.max(a.left, b.left)), x2: sx(Math.min(a.right, b.right)), reach: 0 }
      // Held over it: on the gap, and a few px either side of it.
      s.reach = Math.max(6, Math.max(0, gapPx) / 2 + 4)
      seams.push(s)
    }
  }
  // Awake: scene cards were moved (or made, split, joined, sized) just now.
  const sig = groups.filter(g => g.scene && g.cardType === 'scene').map(g => `${g.id}:${g.originX}:${g.originY}:${g.cardWidthOverride}:${g.cardHeightOverride}`).join('|')
  const [awake, setAwake] = useState(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    setAwake(true)
    const t = setTimeout(() => setAwake(false), AWAKE_MS)
    return () => clearTimeout(t)
  }, [sig])
  const seamsRef = useRef(seams)
  seamsRef.current = seams
  const hotRef = useRef(hot)
  hotRef.current = hot

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const cur = hotRef.current
      // Something is being dragged: nothing comes up under it.
      if (e.buttons) { if (cur) setHot(null); return }
      // On its button: it stays.
      if (cur && (e.target as Element | null)?.closest?.('[data-scene-join]')) return
      const o = rootRef.current?.getBoundingClientRect()
      const px = e.clientX - (o?.left ?? 0), py = e.clientY - (o?.top ?? 0)
      const over = seamsRef.current.find(s => s.row
        ? Math.abs(px - s.x1) <= s.reach && py >= s.y1 && py <= s.y2
        : Math.abs(py - s.y1) <= s.reach && px >= s.x1 && px <= s.x2)
      if (!over) { if (cur) setHot(null); return }
      if (cur?.key === over.key) return
      // Beside the pointer, along the line (the other way near its end).
      const len = Math.max(1, over.row ? over.y2 - over.y1 : over.x2 - over.x1)
      const at = over.row ? py - over.y1 : px - over.x1
      const want = at + BESIDE + BTN_W / 2 <= len ? at + BESIDE : at - BESIDE
      setHot({ key: over.key, t: Math.max(0, Math.min(1, want / len)) })
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [])

  return (
    <div ref={rootRef} data-scene-seams style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, pointerEvents: 'none' }}>
      {seams.map(s => {
        const lit = hot?.key === s.key
        const thick = lit ? 3 : 1.5
        return (
          <React.Fragment key={s.key}>
            <div data-scene-seam-line={lit ? 'lit' : awake ? 'shown' : 'faded'} style={{
              position: 'absolute', zIndex: 58, pointerEvents: 'none', borderRadius: thick,
              background: lit ? '#fff' : 'rgba(255,255,255,0.6)',
              opacity: lit || awake ? 1 : 0, transition: lit || awake ? 'opacity 0.12s' : 'opacity 0.9s',
              ...(s.row
                ? { left: s.x1 - thick / 2, top: s.y1 + 6, width: thick, height: Math.max(0, s.y2 - s.y1 - 12) }
                : { left: s.x1 + 6, top: s.y1 - thick / 2, height: thick, width: Math.max(0, s.x2 - s.x1 - 12) }),
            }} />
            {lit && (
              <button
                type="button"
                data-scene-join={`${s.a}:${s.b}`}
                title={s.row ? 'Join cards: these two scene cards become one. The left one keeps its name' : 'Join cards: these two scene cards become one. The top one keeps its name'}
                onPointerDown={e => e.stopPropagation()}
                onDoubleClick={e => e.stopPropagation()}
                onPointerLeave={() => setHot(null)}
                onClick={e => { e.stopPropagation(); setHot(null); joinSceneCards(s.a, s.b, s.row ? 'row' : 'col') }}
                style={{
                  position: 'absolute', zIndex: 59, transform: 'translate(-50%, -50%)',
                  left: s.row ? s.x1 : s.x1 + (s.x2 - s.x1) * hot!.t, top: s.row ? s.y1 + (s.y2 - s.y1) * hot!.t : s.y1,
                  height: 20, padding: '0 9px 0 7px', display: 'flex', alignItems: 'center', gap: 5, boxSizing: 'border-box', borderRadius: 10,
                  background: '#ffd666', color: '#111', border: '1.5px solid #fff', boxShadow: '0 2px 7px rgba(0,0,0,0.55)',
                  fontSize: 11, fontWeight: 800, lineHeight: 1, fontFamily: 'system-ui, -apple-system, sans-serif', whiteSpace: 'nowrap',
                  cursor: 'pointer', pointerEvents: 'auto',
                }}
              >
                <svg width="11" height="11" viewBox="0 0 10 10">
                  <path d={s.row ? 'M1 2h8v6H1zM3.2 5h3.6M4.4 3.8L3.2 5l1.2 1.2M5.6 3.8L6.8 5 5.6 6.2' : 'M2 1h6v8H2zM5 3.2v3.6M3.8 4.4L5 3.2l1.2 1.2M3.8 5.6L5 6.8l1.2-1.2'} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Join
              </button>
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}
