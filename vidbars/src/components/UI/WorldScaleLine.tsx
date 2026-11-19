// WorldScaleLine — the world scale's lineup: a strip that comes out of the
// world scale's icon, over the bottom-left controls (utils/worldScale;
// Brian 2026-11-19: "If I click the world scale, it should pop up on the
// bottom of the screen, like growing right out from its icon. Then, if I
// was to click cards on the canvas, maybe whatever they have to say, the
// height would show up there. The models could line up. I could shift,
// grow, and change that scale and set them there, and then close the
// cards off and have the heights be remembered back to the cards").
//
//  - A ruler up its left side, feet (metres, the app in metric). Drag the
//    ruler up or down: it shows fewer or more feet, the place grabbed
//    staying under the cursor.
//  - While it is out, each card clicked on the canvas comes to stand on
//    it, in the order they come, at the Height on its back: its model,
//    turning, or else its picture. The same in the flat view and in 3D.
//  - Each has the measuring stick's yellow mark at its height. Drag the
//    mark: that is the card's Height, written on its back as a stick's
//    mark writes it (utils/stickDock setCardHeight: to the inch or the
//    centimetre, and to where a shared height is kept). A card with no
//    height has its mark at the top, a "?", to be dragged to one.
//  - The x on one takes it off the strip. Its height stays on its card.
//  - True size, top right, its own on/off: on, every model in the 3D view
//    stands at its true height, its card's Emphasis ignored (Brian
//    2026-11-19). The strip itself always shows true heights.
//
// A fixed size, the same in both views; more cards than fit scroll along.

import React, { useEffect, useRef, useState } from 'react'
import { useBoardsStore, type ProjectGroup, type BoardData } from '../../store/boardsStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useUnits } from '../../store/unitsStore'
import { useWorldScale, LINE_FT_MIN, LINE_FT_MAX } from '../../utils/worldScale'
import { cardHeight, setCardHeight } from '../../utils/stickDock'
import { heightText, snapHeight, FT_PER_M } from '../../utils/stickGeom'
import { dataKey, faceModelOf, linkedModelCard } from '../../utils/area3dScene'
import { faceBlocks } from '../../utils/cardGrid'
import { getMediaItems } from '../../types/bar'
import { createLineupScene, type LineupModel } from '../../three/lineupScene'

const YELLOW = '#ffd23f'
/** The strip, and inside it: room over the tallest head for its mark's
 *  text, and under the floor for the names. */
export const LINE_H = 250
const HEAD = 28, FOOT = 30, RULER_W = 46, COL_W = 124
const FIG_H = LINE_H - HEAD - FOOT

/** The picture on a card's face, when that is not a model. */
function facePicture(card: ProjectGroup, boards: Record<string, BoardData>): string | null {
  const blocks = faceBlocks(card, boards)
  const bid = card.faceBoardId && blocks.includes(card.faceBoardId) ? card.faceBoardId : blocks[0]
  const board = bid ? boards[bid] : undefined
  for (const rid of board?.rootIds ?? []) {
    const m = getMediaItems(board!.bars[rid]?.content).find(it => it.type === 'image' || it.type === 'video' || it.type === 'model')
    if (m) return m.type === 'image' ? m.url : m.posterUrl ?? null
  }
  return null
}

/** The ruler's steps for `ft` feet shown over `px`: [fine, numbered], in
 *  the unit shown (feet, or metres). */
function steps(span: number, px: number): [number, number] {
  const want = span / px * 26
  for (const base of [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000]) {
    if (base >= want) return [base / (String(base).startsWith('2') && base !== 0.25 ? 4 : 5), base]
  }
  return [1000, 5000]
}

export const WorldScaleLine: React.FC<{ left: number; right: number; bottom: number }> = ({ left, right, bottom }) => {
  const line = useWorldScale(s => s.line)
  const lineFt = useWorldScale(s => s.lineFt)
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const metric = useUnits(s => s.metric)
  const trueSize = useWorldScale(s => s.trueSize)
  const cols = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const scene = useRef<ReturnType<typeof createLineupScene> | null>(null)
  const [scroll, setScroll] = useState(0)
  const [view, setView] = useState({ w: 0, h: LINE_H })

  // The cards clicked on the canvas while it is out come onto it.
  useEffect(() => {
    const ids = (sel: string[]) => sel.map(id => dataKey(`card:${id}`).slice(5))
    useWorldScale.getState().join(ids(useBoardsStore.getState().selectedGroupIds))
    return useBoardsStore.subscribe((s, prev) => {
      if (s.selectedGroupIds === prev.selectedGroupIds) return
      const fresh = s.selectedGroupIds.filter(id => !prev.selectedGroupIds.includes(id))
      if (fresh.length) useWorldScale.getState().join(ids(fresh))
    })
  }, [])

  useEffect(() => {
    const el = cols.current
    if (!el) return
    const size = () => setView({ w: el.clientWidth, h: LINE_H })
    size()
    const ro = new ResizeObserver(size)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (!canvas.current) return
    // (No 3D to be had: the strip is still its marks and pictures.)
    let sc: ReturnType<typeof createLineupScene> | null = null
    try { sc = scene.current = createLineupScene(canvas.current) } catch { return }
    return () => { scene.current = null; sc?.dispose() }
  }, [])

  const perFt = FIG_H / lineFt
  const stood = line.map(id => groups.find(g => g.id === id)).filter((g): g is ProjectGroup => !!g).map((g, i) => {
    const ft = cardHeight(g, groups)
    const from = faceModelOf(g, boards) ? g : linkedModelCard(g, groups, boards)
    const model = from ? faceModelOf(from, boards) : null
    // (No height yet: it stands as tall as the strip shows, its mark at the top.)
    const shown = Math.min(ft ?? lineFt, lineFt)
    return { g, i, ft, shown, model, picture: model ? null : facePicture(g, boards), px: shown * perFt, over: ft !== null && ft > lineFt + 1e-6 }
  })

  useEffect(() => {
    const models: LineupModel[] = []
    for (const s of stood) if (s.model) models.push({ id: s.g.id, url: s.model.url, x: s.i * COL_W + COL_W / 2 - scroll, y: FOOT, h: Math.max(1, (s.ft ?? lineFt) * perFt) })
    scene.current?.set(models, Math.max(1, view.w), view.h)
  })

  // The ruler, dragged: the height grabbed stays under the cursor.
  const rulerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    const box = e.currentTarget.getBoundingClientRect()
    const floor = box.bottom - FOOT
    const d0 = Math.max(8, floor - e.clientY), ft0 = useWorldScale.getState().lineFt
    const held = d0 / (FIG_H / ft0)
    const move = (ev: PointerEvent) => useWorldScale.getState().setLineFt(Math.max(LINE_FT_MIN, Math.min(LINE_FT_MAX, held * FIG_H / Math.max(8, floor - ev.clientY))))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
  // A mark, dragged: its card's height.
  const markDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || !cols.current) return
    e.preventDefault(); e.stopPropagation()
    const floor = cols.current.getBoundingClientRect().bottom - FOOT
    const y0 = e.clientY
    let began = false
    const move = (ev: PointerEvent) => {
      if (!began) {
        if (Math.abs(ev.clientY - y0) < 3) return
        began = true
        useUndoCoordinator.getState().checkpoint()
      }
      const ws = useWorldScale.getState(), m = useUnits.getState().metric
      const ft = snapHeight((floor - ev.clientY) / (FIG_H / ws.lineFt), m)
      const now = useBoardsStore.getState().groups.find(g => g.id === id)
      if (now) setCardHeight(now, Math.max(1 / 12, Math.min(ws.lineFt, ft)))
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // The ruler's ticks, in the unit shown.
  const unit = metric ? FT_PER_M : 1
  const [fine, numbered] = steps(lineFt / unit, FIG_H)
  const ticks: { ft: number; label?: string }[] = []
  for (let k = 0; k * fine <= lineFt / unit + 1e-6; k++) {
    const v = k * fine, big = Math.abs(v / numbered - Math.round(v / numbered)) < 1e-6
    ticks.push({ ft: v * unit, label: big ? String(Math.round(v * 100) / 100) : undefined })
  }

  return (
    <div data-world-scale-line
      onPointerDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()}
      style={{
        position: 'absolute', left, right, bottom, height: LINE_H, zIndex: 950, userSelect: 'none', boxSizing: 'border-box',
        background: '#13141f', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
        overflow: 'hidden', transformOrigin: '20px 100%', animation: 'worldScaleLineOut 180ms ease-out',
      }}>
      <style>{'@keyframes worldScaleLineOut { from { transform: scale(0.05); opacity: 0 } to { transform: scale(1); opacity: 1 } }'}</style>
      {/* The ruler. */}
      <div data-world-scale-ruler onPointerDown={rulerDown}
        title={`The world scale's ruler, in ${metric ? 'metres' : 'feet'}. Drag it up or down to show fewer or more ${metric ? 'metres' : 'feet'}`}
        style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: RULER_W, cursor: 'ns-resize', borderRight: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)' }}>
        {ticks.map((t, i) => (
          <React.Fragment key={i}>
            <div style={{ position: 'absolute', right: 0, bottom: FOOT + t.ft * perFt, width: t.label ? 12 : 6, height: 1, background: t.label ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.3)' }} />
            {t.label && <div style={{ position: 'absolute', right: 15, bottom: FOOT + t.ft * perFt - 6, fontSize: 10, lineHeight: '12px', color: 'rgba(255,255,255,0.7)', fontFamily: 'ui-monospace, monospace' }}>{t.label}</div>}
          </React.Fragment>
        ))}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 8, textAlign: 'center', fontSize: 9, letterSpacing: 0.6, color: 'rgba(255,255,255,0.45)' }}>{metric ? 'METRES' : 'FEET'}</div>
      </div>
      {/* The floor, and the cards standing on it. */}
      <div style={{ position: 'absolute', left: RULER_W, right: 0, top: 0, bottom: 0 }}>
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: FOOT, height: 1, background: 'rgba(255,255,255,0.35)' }} />
        <canvas ref={canvas} style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
        <div ref={cols} onScroll={e => setScroll(e.currentTarget.scrollLeft)}
          style={{ position: 'absolute', inset: 0, overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.25) transparent' }}>
          <div style={{ position: 'relative', width: Math.max(1, stood.length) * COL_W, height: '100%' }}>
            {stood.map(s => (
              <div key={s.g.id} data-world-scale-card={s.g.id} style={{ position: 'absolute', left: s.i * COL_W, width: COL_W, top: 0, bottom: 0, overflow: 'hidden' }}>
                {s.picture && <img src={s.picture} alt="" draggable={false}
                  style={{ position: 'absolute', left: '50%', bottom: FOOT, height: Math.max(1, s.px), transform: 'translateX(-50%)', opacity: s.ft === null ? 0.5 : 1, pointerEvents: 'none' }} />}
                {!s.picture && !s.model && <div style={{ position: 'absolute', left: '50%', bottom: FOOT, width: 34, marginLeft: -17, height: Math.max(1, s.px), boxSizing: 'border-box',
                  border: '1px dashed rgba(255,255,255,0.35)', borderBottom: 'none', background: 'rgba(255,255,255,0.05)' }} />}
                {/* Its mark. */}
                <div data-world-scale-mark onPointerDown={e => markDown(e, s.g.id)}
                  title={s.ft === null ? 'No height yet: drag this mark down to give the card one' : 'Drag up or down to set this card\'s height. It is written on the card\'s back'}
                  style={{ position: 'absolute', left: 4, right: 4, bottom: FOOT + s.px - 8, height: 16, cursor: 'ns-resize' }}>
                  <div style={{ position: 'absolute', left: 0, right: 0, top: 7, height: 2, borderRadius: 1, background: YELLOW, boxShadow: '0 0 3px rgba(0,0,0,0.8)' }} />
                  <div style={{ position: 'absolute', right: 0, bottom: 10, padding: '0 4px', borderRadius: 3, fontSize: 10, lineHeight: '14px', fontWeight: 700,
                    fontFamily: 'ui-monospace, monospace', color: '#1b1b10', background: YELLOW, whiteSpace: 'nowrap' }}>
                    {s.ft === null ? '?' : `${s.over ? '▲ ' : ''}${heightText({ ft: s.ft, metric })}`}
                  </div>
                </div>
                <div title={s.g.name} style={{ position: 'absolute', left: 6, right: 22, bottom: 7, fontSize: 10, lineHeight: '14px', color: 'rgba(255,255,255,0.75)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.g.name || 'Card'}</div>
                <button data-world-scale-off onClick={() => useWorldScale.getState().leave(s.g.id)} title="Take this card off the lineup. Its height stays on the card"
                  style={{ position: 'absolute', right: 4, bottom: 6, width: 16, height: 16, padding: 0, borderRadius: 4, fontSize: 11, lineHeight: '14px', cursor: 'pointer',
                    background: 'transparent', border: '1px solid rgba(255,255,255,0.14)', color: 'rgba(255,255,255,0.6)' }}>×</button>
              </div>
            ))}
          </div>
        </div>
        <button data-world-scale-true aria-pressed={trueSize} onClick={() => useWorldScale.getState().setTrueSize(!trueSize)}
          title="True size: on or off. On, every model in the 3D view stands at its true height, and the Emphasis on its card's back is ignored. Off, a card's Emphasis (+50% is half as big again) shows. This strip always shows true heights"
          style={{
            position: 'absolute', right: 8, top: 6, zIndex: 2, fontSize: 11, padding: '3px 7px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
            background: trueSize ? 'rgba(120,170,255,0.25)' : '#13141f', border: '1px solid rgba(255,255,255,0.14)',
            color: trueSize ? '#dfe8ff' : 'rgba(255,255,255,0.6)',
          }}>True size</button>
        {stood.length === 0 && (
          <div style={{ position: 'absolute', left: 0, right: 0, top: LINE_H / 2 - 16, textAlign: 'center', pointerEvents: 'none', fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
            Click cards on the canvas to stand them here at their height
          </div>
        )}
      </div>
    </div>
  )
}
