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
//  - While it is out, each card clicked on the canvas (clicked: not what
//    a drag over the canvas picks up) comes to stand on
//    it, in the order they come, at the Height on its back: its model,
//    turning, or else its picture. The same in the flat view and in 3D.
//  - Each has the measuring stick's yellow mark at its height. Drag the
//    mark: that is the card's Height, written on its back as a stick's
//    mark writes it (utils/stickDock setCardHeight: to the inch or the
//    centimetre, and to where a shared height is kept). A card with no
//    height has its mark at the top, a "?", to be dragged to one.
//  - The x on one takes it off the strip. Its height stays on its card.
//  - True size, by the chooser, its own on/off: on, every model in the 3D view
//    stands at its true height, its card's Emphasis ignored (Brian
//    2026-11-19). The strip itself always shows true heights.
//
// A bare chart, not a box (Brian 2026-11-19: "I don't think we need the
// full box. Since it's a bit of a chart, we only need the ruler up the
// side, the bottom line that they stand on, and the background ... We
// just want it to be as big as what we need"): the ruler at the screen's
// left edge, the floor line, and only as wide as the cards on it. What is
// behind it is picked from the round chooser at its top left: nothing
// (the canvas shows through, and is pressed through), or a colour, as
// wide as the chart. Shift-drag the ruler and the whole chart grows or
// shrinks, the models with it.

import React, { useEffect, useRef, useState } from 'react'
import { useBoardsStore, type ProjectGroup, type BoardData } from '../../store/boardsStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useUnits } from '../../store/unitsStore'
import { useWorldScale, LINE_FT_MIN, LINE_FT_MAX, LINE_PX_MIN, LINE_PX_MAX } from '../../utils/worldScale'
import { cardHeight, setCardHeight } from '../../utils/stickDock'
import { heightText, snapHeight, FT_PER_M } from '../../utils/stickGeom'
import { dataKey, faceModelOf, linkedModelCard } from '../../utils/area3dScene'
import { faceBlocks } from '../../utils/cardGrid'
import { getMediaItems } from '../../types/bar'
import { createLineupScene, type LineupModel } from '../../three/lineupScene'

const YELLOW = '#ffd23f'
/** Over the ruler: the chooser and True size (TOP), then room over the
 *  tallest head for its mark's text (HEAD); under the floor, the names. */
const TOP = 26, HEAD = 26, FOOT = 30, RULER_W = 46
/** What can be behind the chart: none first. */
const BACKS: (string | null)[] = [null, '#13141f', '#000000', '#3a3d4d', '#8a8f9c', '#ffffff', '#1f3b57', '#24452f', '#4d2626']
const NONE = 'repeating-conic-gradient(#666 0% 25%, #222 0% 50%) 50% / 8px 8px'
/** Is a colour light enough to want dark writing on it? */
const light = (hex: string | null) => !!hex && (parseInt(hex.slice(1, 3), 16) * 0.299 + parseInt(hex.slice(3, 5), 16) * 0.587 + parseInt(hex.slice(5, 7), 16) * 0.114) > 150

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

export const WorldScaleLine: React.FC<{ bottom: number }> = ({ bottom }) => {
  const line = useWorldScale(s => s.line)
  const lineFt = useWorldScale(s => s.lineFt)
  const figH = useWorldScale(s => s.linePx)
  const bg = useWorldScale(s => s.lineBg)
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const metric = useUnits(s => s.metric)
  const trueSize = useWorldScale(s => s.trueSize)
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const scene = useRef<ReturnType<typeof createLineupScene> | null>(null)
  const [picking, setPicking] = useState(false)

  // The cards CLICKED on the canvas while it is out come onto it: a press
  // let go where it was made. Not what a drag picks up on its way (a band
  // drawn over the canvas, a card moved): Brian 2026-11-19, "If I just
  // drag a random spot on the canvas it looks like ... the world distance
  // is trying to pick up some kind of weird selection with question marks".
  useEffect(() => {
    const ids = (sel: string[]) => sel.map(id => dataKey(`card:${id}`).slice(5))
    let press: { x: number; y: number; was: string[] } | null = null
    const down = (e: PointerEvent) => { press = e.button === 0 ? { x: e.clientX, y: e.clientY, was: useBoardsStore.getState().selectedGroupIds } : null }
    const up = (e: PointerEvent) => {
      const p = press
      press = null
      if (!p || e.type !== 'pointerup' || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4) return
      // (Its click has picked the card by the time this runs.)
      // (A click on a card that was picked already brings that one.)
      const on = (e.target as Element | null)?.closest?.<HTMLElement>('[data-group-card][data-id]')?.dataset.id
      setTimeout(() => {
        const now = useBoardsStore.getState().selectedGroupIds
        const fresh = now.filter(id => !p.was.includes(id) || id === on)
        if (fresh.length) useWorldScale.getState().join(ids(fresh))
      }, 0)
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true) }
  }, [])
  useEffect(() => {
    if (!canvas.current) return
    // (No 3D to be had: the chart is still its marks and pictures.)
    let sc: ReturnType<typeof createLineupScene> | null = null
    try { sc = scene.current = createLineupScene(canvas.current) } catch { return }
    return () => { scene.current = null; sc?.dispose() }
  }, [])

  const perFt = figH / lineFt
  // Each card's place along it: wide enough for someone as tall as the ruler.
  const colW = Math.max(96, Math.round(figH * 0.62))
  const stood = line.map(id => groups.find(g => g.id === id)).filter((g): g is ProjectGroup => !!g).map((g, i) => {
    const ft = cardHeight(g, groups)
    const from = faceModelOf(g, boards) ? g : linkedModelCard(g, groups, boards)
    const model = from ? faceModelOf(from, boards) : null
    // (No height yet: it stands as tall as the ruler, its mark at the top.)
    const shown = Math.min(ft ?? lineFt, lineFt)
    return { g, i, ft, shown, model, picture: model ? null : facePicture(g, boards), px: shown * perFt, over: ft !== null && ft > lineFt + 1e-6 }
  })
  const H = TOP + HEAD + figH + FOOT
  const colsW = stood.length ? stood.length * colW : 250
  const W = RULER_W + colsW

  useEffect(() => {
    const models: LineupModel[] = []
    for (const s of stood) if (s.model) models.push({ id: s.g.id, url: s.model.url, x: s.i * colW + colW / 2, y: FOOT, h: Math.max(1, (s.ft ?? lineFt) * perFt) })
    scene.current?.set(models, Math.max(1, colsW), H)
  })

  const floorY = () => (root.current?.getBoundingClientRect().bottom ?? 0) - FOOT
  const follow = (move: (ev: PointerEvent) => void) => {
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
  // The ruler, dragged: the height grabbed stays under the cursor. Plain,
  // it shows fewer or more feet in the same room; with Shift, the same
  // feet in more or less room: the whole chart grows.
  const rulerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    const floor = floorY(), ws = useWorldScale.getState()
    const d0 = Math.max(8, floor - e.clientY), ft0 = ws.lineFt, px0 = ws.linePx
    const held = d0 / (px0 / ft0)
    // (No taller than leaves it on the screen.)
    const room = Math.max(LINE_PX_MIN, floor - TOP - HEAD - 70)
    follow(e.shiftKey
      ? ev => useWorldScale.getState().setLinePx(Math.max(LINE_PX_MIN, Math.min(LINE_PX_MAX, room, px0 * Math.max(8, floor - ev.clientY) / d0)))
      : ev => useWorldScale.getState().setLineFt(Math.max(LINE_FT_MIN, Math.min(LINE_FT_MAX, held * px0 / Math.max(8, floor - ev.clientY)))))
  }
  // A mark, dragged: its card's height.
  const markDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    const floor = floorY(), y0 = e.clientY
    let began = false
    follow(ev => {
      if (!began) {
        if (Math.abs(ev.clientY - y0) < 3) return
        began = true
        useUndoCoordinator.getState().checkpoint()
      }
      const ws = useWorldScale.getState(), m = useUnits.getState().metric
      const ft = snapHeight((floor - ev.clientY) / (ws.linePx / ws.lineFt), m)
      const now = useBoardsStore.getState().groups.find(g => g.id === id)
      if (now) setCardHeight(now, Math.max(1 / 12, Math.min(ws.lineFt, ft)))
    })
  }

  // The ruler's ticks, in the unit shown.
  const unit = metric ? FT_PER_M : 1
  const [fine, numbered] = steps(lineFt / unit, figH)
  const ticks: { ft: number; label?: string }[] = []
  for (let k = 0; k * fine <= lineFt / unit + 1e-6; k++) {
    const v = k * fine, big = Math.abs(v / numbered - Math.round(v / numbered)) < 1e-6
    ticks.push({ ft: v * unit, label: big ? String(Math.round(v * 100) / 100) : undefined })
  }
  // Written dark on a light colour, light otherwise; with nothing behind
  // it, light with a dark edge to read over the canvas.
  const dark = light(bg)
  const ink = (a: number) => dark ? `rgba(20,22,32,${a})` : `rgba(255,255,255,${a})`
  const edge = bg ? undefined : '0 0 3px #000, 0 0 2px #000'
  const eat = { onPointerDown: (e: React.SyntheticEvent) => e.stopPropagation(), onDoubleClick: (e: React.SyntheticEvent) => e.stopPropagation(), onContextMenu: (e: React.SyntheticEvent) => e.stopPropagation() }

  return (
    <div ref={root} data-world-scale-line {...(bg ? { ...eat, onWheel: (e: React.SyntheticEvent) => e.stopPropagation() } : {})}
      style={{
        position: 'absolute', left: 0, bottom, width: W, height: H, zIndex: 949, userSelect: 'none',
        background: bg ?? 'transparent', pointerEvents: bg ? 'auto' : 'none',
        transformOrigin: '32px 100%', animation: 'worldScaleLineOut 180ms ease-out',
      }}>
      <style>{'@keyframes worldScaleLineOut { from { transform: scale(0.05); opacity: 0 } to { transform: scale(1); opacity: 1 } }'}</style>
      {/* What is behind it, and True size. */}
      <div {...eat} style={{ position: 'absolute', left: 6, top: 4, display: 'flex', alignItems: 'center', gap: 6, pointerEvents: 'auto', zIndex: 3 }}>
        <button data-world-scale-back aria-pressed={picking} onClick={() => setPicking(v => !v)}
          title="What is behind the lineup: nothing (the canvas shows through), or a colour as wide as the lineup"
          style={{ width: 18, height: 18, padding: 0, borderRadius: '50%', cursor: 'pointer', background: bg ?? NONE, boxSizing: 'border-box',
            border: picking ? '2px solid #9ecbff' : '2px solid rgba(255,255,255,0.6)', boxShadow: '0 0 3px rgba(0,0,0,0.8)' }} />
        <button data-world-scale-true aria-pressed={trueSize} onClick={() => useWorldScale.getState().setTrueSize(!trueSize)}
          title="True size: on or off. On, every model in the 3D view stands at its true height, and the Emphasis on its card's back is ignored. Off, a card's Emphasis (+50% is half as big again) shows. The lineup always shows true heights"
          style={{
            fontSize: 10, padding: '2px 6px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
            background: trueSize ? '#2f446b' : '#13141f', border: '1px solid rgba(255,255,255,0.2)',
            color: trueSize ? '#dfe8ff' : 'rgba(255,255,255,0.6)',
          }}>True size</button>
        {picking && (
          <div data-world-scale-backs style={{ position: 'absolute', left: 0, top: 24, display: 'flex', gap: 5, padding: 6, borderRadius: 8,
            background: '#1e1f30', border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 8px 24px rgba(0,0,0,0.6)' }}>
            {BACKS.map(c => (
              <button key={c ?? 'none'} title={c ?? 'Nothing behind it'} onClick={() => { useWorldScale.getState().setLineBg(c); setPicking(false) }}
                style={{ width: 18, height: 18, padding: 0, borderRadius: '50%', cursor: 'pointer', background: c ?? NONE, boxSizing: 'border-box',
                  border: bg === c ? '2px solid #fff' : '2px solid rgba(255,255,255,0.25)' }} />
            ))}
            <input type="color" title="Any colour" value={bg ?? '#13141f'} onChange={e => useWorldScale.getState().setLineBg(e.target.value)}
              style={{ width: 22, height: 18, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} />
          </div>
        )}
      </div>
      {/* The ruler. */}
      <div data-world-scale-ruler onPointerDown={rulerDown} onDoubleClick={eat.onDoubleClick} onContextMenu={eat.onContextMenu}
        title={`The world scale's ruler, in ${metric ? 'metres' : 'feet'}. Drag it up or down to show fewer or more ${metric ? 'metres' : 'feet'}. Shift-drag it to make the whole lineup bigger or smaller`}
        style={{ position: 'absolute', left: 0, top: TOP, bottom: 0, width: RULER_W, cursor: 'ns-resize', pointerEvents: 'auto' }}>
        <div style={{ position: 'absolute', right: 0, bottom: FOOT, width: 1, height: figH, background: ink(0.6), boxShadow: edge }} />
        {ticks.map((t, i) => (
          <React.Fragment key={i}>
            <div style={{ position: 'absolute', right: 0, bottom: FOOT + t.ft * perFt, width: t.label ? 12 : 6, height: 1, background: t.label ? ink(0.85) : ink(0.45), boxShadow: edge }} />
            {t.label && <div style={{ position: 'absolute', right: 15, bottom: FOOT + t.ft * perFt - 6, fontSize: 10, lineHeight: '12px', color: ink(0.85), textShadow: edge, fontFamily: 'ui-monospace, monospace' }}>{t.label}</div>}
          </React.Fragment>
        ))}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 8, textAlign: 'center', fontSize: 9, letterSpacing: 0.6, color: ink(0.6), textShadow: edge }}>{metric ? 'METRES' : 'FEET'}</div>
      </div>
      {/* The floor, and the cards standing on it. */}
      <div style={{ position: 'absolute', left: RULER_W, width: colsW, top: 0, bottom: 0, pointerEvents: 'none' }}>
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: FOOT, height: 1, background: ink(0.6), boxShadow: edge }} />
        <canvas ref={canvas} style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
        {stood.map(s => (
          <div key={s.g.id} data-world-scale-card={s.g.id} style={{ position: 'absolute', left: s.i * colW, width: colW, top: 0, bottom: 0, pointerEvents: 'none' }}>
            {s.picture && <img src={s.picture} alt="" draggable={false}
              style={{ position: 'absolute', left: '50%', bottom: FOOT, height: Math.max(1, s.px), transform: 'translateX(-50%)', opacity: s.ft === null ? 0.5 : 1, pointerEvents: 'none' }} />}
            {!s.picture && !s.model && <div style={{ position: 'absolute', left: '50%', bottom: FOOT, width: 34, marginLeft: -17, height: Math.max(1, s.px), boxSizing: 'border-box',
              border: `1px dashed ${ink(0.5)}`, borderBottom: 'none', background: ink(0.06) }} />}
            {/* Its mark. */}
            <div data-world-scale-mark onPointerDown={e => markDown(e, s.g.id)} onDoubleClick={eat.onDoubleClick} onContextMenu={eat.onContextMenu}
              title={s.ft === null ? 'No height yet: drag this mark down to give the card one' : 'Drag up or down to set this card\'s height. It is written on the card\'s back'}
              style={{ position: 'absolute', left: 4, right: 4, bottom: FOOT + s.px - 8, height: 16, cursor: 'ns-resize', pointerEvents: 'auto' }}>
              <div style={{ position: 'absolute', left: 0, right: 0, top: 7, height: 2, borderRadius: 1, background: YELLOW, boxShadow: '0 0 3px rgba(0,0,0,0.8)' }} />
              <div style={{ position: 'absolute', right: 0, bottom: 10, padding: '0 4px', borderRadius: 3, fontSize: 10, lineHeight: '14px', fontWeight: 700,
                fontFamily: 'ui-monospace, monospace', color: '#1b1b10', background: YELLOW, whiteSpace: 'nowrap' }}>
                {s.ft === null ? '?' : `${s.over ? '▲ ' : ''}${heightText({ ft: s.ft, metric })}`}
              </div>
            </div>
            <div {...eat} style={{ position: 'absolute', left: 4, right: 4, bottom: 6, height: 16, display: 'flex', alignItems: 'center', gap: 4, pointerEvents: 'auto' }}>
              <div title={s.g.name} style={{ flex: 1, minWidth: 0, fontSize: 10, lineHeight: '14px', color: ink(0.85), textShadow: edge,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.g.name || 'Card'}</div>
              <button data-world-scale-off onClick={() => useWorldScale.getState().leave(s.g.id)} title="Take this card off the lineup. Its height stays on the card"
                style={{ width: 16, height: 16, padding: 0, borderRadius: 4, fontSize: 11, lineHeight: '14px', cursor: 'pointer', flexShrink: 0,
                  background: bg ? 'transparent' : 'rgba(19,20,31,0.8)', border: `1px solid ${ink(0.3)}`, color: ink(0.75) }}>×</button>
            </div>
          </div>
        ))}
        {stood.length === 0 && (
          <div style={{ position: 'absolute', left: 10, right: 0, bottom: FOOT + 10, pointerEvents: 'none', fontSize: 11, lineHeight: '15px', color: ink(0.6), textShadow: edge }}>
            Click cards on the canvas to stand them here at their height
          </div>
        )}
      </div>
    </div>
  )
}
