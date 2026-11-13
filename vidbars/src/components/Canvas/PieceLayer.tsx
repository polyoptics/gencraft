// PieceLayer — the models of the 3D sets, and the models riding paths, as
// pieces in the flat view (Brian 2026-11-12: a war map; utils/scenePieces).
// Drawn in the screen-space overlay stage, over the cards: each piece a
// picture of its model's shape (three/pieceService) to scale on the spot
// the model stands on, in its colour, its name under it. A lifted one is
// drawn further up, over its shadow on the spot it is above. Tipping into
// 3D the layer lies on the plane with the rest and fades as the models
// stand up in their place.
//
// Live both ways, looking straight down: a click selects what a click on
// the model selects (its card or tile), a drag moves the model in its set
// (every selected piece with it), and let go over its own card it goes
// back onto it, as in 3D. Nothing holds a piece to the set's ground: it
// goes where it is dragged. A model riding a path (utils/pathRide) is
// where its path has it: its piece goes along the path as the ride clock
// runs, and a drag leaves it there. A press goes by the outline of what
// the piece shows, not the box of its picture: its clear corners leave
// what lies under them to be pressed. The smaller piece is drawn over the
// bigger, so a figure on a floor plate shows, and can be pressed,
// whichever of the two was made first.
//
// A piece's picture comes through a CSS class and a custom property
// (index.css .scene-piece-pic), never an <img> or an inline
// background-image: the 3D view takes those, in the overlay, for artwork
// on a card.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useModelScaleStore, useTiltStore, isTilted, offFlat, screenOf, unprojectTilt, TILT_FAR, type ScenePlace } from '../../store/tiltStore'
import { useManip } from '../../store/manipStore'
import { usePeek } from '../../utils/peek'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useNotesStore } from '../../store/notesStore'
import { useRideClock, riderRuns } from '../../utils/pathRide'
import { clientToCanvas } from '../../utils/fx/createEffect'
import { selectModel } from './tilt/TiltModels'
import { usePieceStore, ensurePiece, pieceKey, trimPieces, type PiecePic, type Vec3 } from '../../three/pieceService'
import { liveKeys, piecePress, type PiecePress } from '../../utils/liveTop'
import { scenePieces, pieceShot, layPiece, pieceScale, pieceSelected, piecesShown, pieceRiders, PIECE_LIFT, type ScenePiece } from '../../utils/scenePieces'

/** A model with no colour of its own: plain clay, as a primitive comes. */
const CLAY = '#d8dce4'
/** As the 3D view rings a selected model, and one under the cursor. */
const SEL = '#78b3ff', HOVER = 'rgba(255,255,255,0.7)'

/** The picture a piece last showed, by its model (as the 3D view knows
 *  it): shown while its next one (tipped over, stretched) is being drawn. */
const lastPic = new Map<string, PiecePic>()

const ring = (c: string) => `drop-shadow(1.5px 0 0 ${c}) drop-shadow(-1.5px 0 0 ${c}) drop-shadow(0 1.5px 0 ${c}) drop-shadow(0 -1.5px 0 ${c})`

/** The mouse wheel over a piece zooms the canvas, as over a card (the
 *  overlay's events do not reach the canvas's own handlers). */
function wheel(e: React.WheelEvent) {
  e.stopPropagation()
  const r = document.querySelector('[data-pin-host]')?.getBoundingClientRect()
  useCanvasStore.getState().zoomAtPoint(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0))
}

/** And a middle-button drag pans it. */
function pan(e: React.PointerEvent) {
  e.preventDefault()
  e.stopPropagation()
  let x = e.clientX, y = e.clientY
  const move = (ev: PointerEvent) => {
    useCanvasStore.getState().shiftPan(ev.clientX - x, ev.clientY - y)
    x = ev.clientX; y = ev.clientY
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

/** Its own card or tile, as drawn, under a client point? */
function overOwn(p: ScenePiece, x: number, y: number): boolean {
  const id = p.key.slice(p.key.indexOf(':') + 1)
  const el = document.querySelector(p.key.startsWith('node:') ? `[data-freenode][data-id="${id}"]` : `[data-group-card][data-id="${id}"]`)
  const r = el?.getBoundingClientRect()
  return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

/** A press on a piece: selects its model, and dragged, moves it in its
 *  set (with every other selected piece), as one undo step. */
function press(e: PiecePress, p: ScenePiece) {
  if (e.button !== 0 || e.altKey) return
  e.preventDefault()
  e.stopPropagation()
  // One of several selected, pressed plain: they stay selected, to be
  // dragged together; let go without a drag, it alone is (as cards are).
  const keep = !e.shiftKey && pieceSelected(p.key, useFreeNodeStore.getState().selectedIds, useBoardsStore.getState().selectedGroupIds)
  if (!keep) selectModel(p.key, e.shiftKey)
  const x0 = e.clientX, y0 = e.clientY
  const c0 = clientToCanvas(x0, y0)
  // Taken off its own card it can be put back on it; nudged while it
  // stands over its card, it stays in the set.
  const fromOwn = overOwn(p, x0, y0)
  let held: { dk: string; p0: ScenePlace }[] | null = null
  const move = (ev: PointerEvent) => {
    if (!held) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return
      const fs = useFreeNodeStore.getState(), bs = useBoardsStore.getState(), placed = useModelScaleStore.getState().placeOf
      // (One riding a path stays on its path: with nothing to move, there
      // is nothing to undo.)
      held = scenePieces()
        .filter(q => q.key === p.key || pieceSelected(q.key, fs.selectedIds, bs.selectedGroupIds))
        .filter(q => !!placed[q.dk] && !q.riding)
        .map(q => ({ dk: q.dk, p0: placed[q.dk] }))
      if (held.length) useUndoCoordinator.getState().checkpoint()
    }
    // (In canvas units under the pointer: a wheel zoom mid-drag keeps it
    // in hand.)
    const c = clientToCanvas(ev.clientX, ev.clientY)
    const ms = useModelScaleStore.getState()
    for (const h of held) ms.setPlace(h.dk, { dx: h.p0.dx + c.cx - c0.cx, dy: h.p0.dy + c.cy - c0.cy, h: h.p0.h })
  }
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    if (!held) { if (keep && ev.type === 'pointerup') selectModel(p.key, false); return }
    // Let go over its own card (Brian 2026-11-10, as the 3D view's move
    // handle): out of the set, back on its card.
    if (ev.type === 'pointerup' && !p.riding && !fromOwn && overOwn(p, ev.clientX, ev.clientY)) useModelScaleStore.getState().setPlace(p.dk, null)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

// (A model of a set shown live in the flat view is pressed as its piece
// is: utils/liveTop.)
piecePress.fn = press

interface PieceProps {
  p: ScenePiece
  pic: PiecePic | null
  size: Vec3 | undefined
  zoom: number
  selected: boolean
  /** Presses reach it (looking straight down). */
  live: boolean
  /** Tipping into 3D, a lifted one goes to where its model is seen: the
   *  spot on the plane under its model's foot on the screen, and how much
   *  bigger the model is seen there for being nearer the eye. */
  at: { x: number; y: number; k: number } | null
  /** It is going along a path now (the ride clock runs). */
  moving: boolean
}

const Piece: React.FC<PieceProps> = React.memo(({ p, pic, size, zoom, selected, live, at, moving }) => {
  const [hover, setHover] = useState(false)
  const shot = pieceShot(p)
  // No picture yet, or a model not measured yet: a plain disc its
  // footprint's size (a model fitted by its footprint stands 0.6 of the
  // fit wide).
  const lay = pic && size
    ? layPiece(p, pic, size, shot)
    : (() => { const d = (size ? Math.max(size[0], size[2]) * pieceScale(p, size) : p.fit * 0.6 * p.size) || 1; return { left: p.x - d / 2, top: p.y - d / 2, w: d, h: d, ax: d / 2, ay: d / 2, turn: 0 } })()
  // Lifted: drawn up the canvas from the spot it is above.
  const spot = at ?? { x: p.x, y: p.y - p.h * PIECE_LIFT, k: 1 }
  // (Its shadow stays the size it stands at; the piece may be seen bigger.)
  const sw = lay.w * zoom, sh = lay.h * zoom, sax = lay.ax * zoom, say = lay.ay * zoom
  const w = sw * spot.k, h = sh * spot.k, ax = sax * spot.k, ay = say * spot.k
  const left = spot.x * zoom - ax, top = spot.y * zoom - ay
  const down = { x: (p.x - spot.x) * zoom, y: (p.y - spot.y) * zoom }
  const lifted = Math.hypot(down.x, down.y) > 0.5
  // Its box as turned: the name goes under it.
  const cs = Math.cos(lay.turn), sn = Math.sin(lay.turn)
  let x0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [cx, cy] of [[0, 0], [w, 0], [0, h], [w, h]]) {
    const rx = ax + (cx - ax) * cs - (cy - ay) * sn, ry = ay + (cx - ax) * sn + (cy - ay) * cs
    x0 = Math.min(x0, rx); x1 = Math.max(x1, rx); y1 = Math.max(y1, ry)
  }
  // The name fades out as the piece gets too small to carry one.
  const big = Math.max(w, h)
  const nameShown = Math.max(0, Math.min(1, (big - 16) / 12))
  const turn = lay.turn ? `rotate(${lay.turn}rad)` : undefined
  const turned: React.CSSProperties = { position: 'absolute', left: 0, top: 0, width: w, height: h, transformOrigin: `${ax}px ${ay}px`, transform: turn }
  const src = pic ? { ['--piece-pic' as string]: `url("${pic.src}")` } : null
  const edge = selected ? ring(SEL) : hover ? ring(HOVER) : 'drop-shadow(0 1px 1.5px rgba(0,0,0,0.55))'
  return (
    <div data-scene-piece={p.key} data-piece-set={p.areaId} style={{ position: 'absolute', left: moving ? Math.floor(left) : left, top: moving ? Math.floor(top) : top, width: w, height: h, pointerEvents: 'none' }}>
      {/* Going along a path: the part of a pixel it is on is given it by
          a transform, on a layer of its own. Laid out by its left and top
          alone it is drawn on whole pixels, and one going slowly steps
          along a pixel at a time, across then down, not along its line
          (Brian 2026-11-13: "really jittery and weird"). (Its box keeps
          its left and top: a set folding into its card rides its pieces
          by them, utils/area3dCard.) */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', ...(moving ? { transform: `translate(${left - Math.floor(left)}px, ${top - Math.floor(top)}px)`, willChange: 'transform' } : null) }}>
      {lifted && src && (
        <div data-piece-shadow="" style={{ position: 'absolute', left: ax + down.x - sax, top: ay + down.y - say, width: sw, height: sh, opacity: 0.5, filter: `blur(${Math.min(6, 1.5 + Math.hypot(down.x, down.y) * 0.03).toFixed(1)}px)`, pointerEvents: 'none' }}>
          <div className="scene-piece-shadow" style={{ position: 'absolute', left: 0, top: 0, width: sw, height: sh, transformOrigin: `${sax}px ${say}px`, transform: turn, ...src }} />
        </div>
      )}
      <div style={{ position: 'absolute', inset: 0, filter: edge, pointerEvents: 'none' }}>
        <div
          data-piece-pic=""
          className={src ? 'scene-piece-pic' : undefined}
          style={{
            ...turned, ...(src ?? { borderRadius: '50%', border: '1.5px dashed rgba(255,255,255,0.55)', boxSizing: 'border-box', opacity: 0.6 }),
            backgroundColor: p.tint ?? CLAY, pointerEvents: 'none',
          }}
        >
          {/* What takes its presses: the outline of what it shows, over
              it and clear itself. (The mask cuts the picture for the eye
              only; the picture cut by the outline would lose its soft
              edge where it is drawn small.) */}
          <div
            data-piece-hit=""
            onPointerDown={e => { if (e.button === 1) pan(e); else press(e, p) }}
            onPointerEnter={() => setHover(true)}
            onPointerLeave={() => setHover(false)}
            onWheel={wheel}
            title={p.name}
            style={{ position: 'absolute', inset: 0, ...(pic?.edge ? { clipPath: pic.edge } : { borderRadius: '50%' }), pointerEvents: live ? 'auto' : 'none', cursor: 'pointer' }}
          />
        </div>
      </div>
      {nameShown > 0 && (
        <div data-piece-name="" style={{
          position: 'absolute', left: (x0 + x1) / 2, top: y1 + 3, transform: 'translateX(-50%)', opacity: nameShown,
          font: '11px system-ui, sans-serif', lineHeight: '13px', color: selected ? '#eaf2ff' : 'rgba(235,240,255,0.88)',
          textShadow: '0 1px 2px rgba(0,0,0,0.9), 0 0 3px rgba(0,0,0,0.7)', whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none',
        }}>{p.name}</div>
      )}
      </div>
    </div>
  )
})

export const PieceLayer: React.FC = () => {
  // What the pieces are worked out from (scenePieces reads the stores
  // itself; these bring this layer round when they change).
  useFreeNodeStore(s => s.nodes)
  useBoardsStore(s => s.groups)
  useBoardsStore(s => s.boards)
  useModelScaleStore()
  useCanvasStore(s => s.deckPortalSelections)
  const panAt = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  const selNodes = useFreeNodeStore(s => s.selectedIds)
  const selCards = useBoardsStore(s => s.selectedGroupIds)
  const pics = usePieceStore(s => s.pics)
  const sizes = usePieceStore(s => s.sizes)
  // How much of them shows: in steps, so a turn of the camera does not
  // draw this again at every fraction of a degree.
  useManip(s => !!s.through)
  usePeek(s => !!s.target)
  const shown = useTiltStore(() => Math.round(piecesShown() * 40) / 40)
  const flat = useTiltStore(s => !isTilted(s))
  // The models riding paths: who rides, their paths as they are edited,
  // and the ride clock set by hand.
  const riders = useNotesStore(() => pieceRiders())
  useNotesStore(s => riders ? s.curves : null)
  useRideClock(s => riders ? `${s.base} ${s.stamp}` : '')
  const playing = useRideClock(s => s.playing)
  // (A set shown live in the flat view, utils/liveTop: its models are
  // drawn by the 3D view, and have no piece.)
  const every = scenePieces(), live = liveKeys()
  const list = useMemo(() => live.size ? every.filter(p => !live.has(p.key)) : every, [every, live])
  const anyLifted = list.some(p => p.h > 0)
  // The clock running: the riders' pieces go along their paths, a step
  // each frame.
  const riding = playing && shown > 0 && list.some(p => p.riding)
  const [, setBeat] = useState(0)
  useEffect(() => {
    if (!riding) return
    // (Drawn within the frame that asks for it: left to be drawn when
    // there is time, a step comes a frame late now and then, and the next
    // is twice as long.)
    let raf = requestAnimationFrame(function beat() { flushSync(() => setBeat(n => (n + 1) % 1e6)); raf = requestAnimationFrame(beat) })
    return () => cancelAnimationFrame(raf)
  }, [riding])
  // Tipping into 3D with a lifted piece showing: where each is drawn
  // follows the camera (below), so this layer goes round with it.
  useTiltStore(s => anyLifted && shown > 0 && !flat ? `${s.tilt.toFixed(1)} ${s.yaw.toFixed(1)} ${s.spin.toFixed(1)} ${Math.round(s.shiftX)} ${Math.round(s.shiftY)}` : '')
  const root = useRef<HTMLDivElement>(null)

  // Their pictures: drawn once the pictures wanted have stood still a
  // moment (a model being tipped over by hand would ask for one at every
  // step), and asked for again a while later if one could not be drawn.
  // While the ride clock runs a rider keeps the picture it has (going up
  // a slope it would want another at every step): its next is drawn when
  // it comes to rest.
  const keys = list.map(p => pieceKey(p.url, pieceShot(p).q, p.stretch))
  const still = (p: ScenePiece) => !(playing && p.riding && riderRuns(p.key, p.dk))
  const want = keys.filter((_, i) => still(list[i])).join('\n')
  const now = useRef({ list, still })
  now.current = { list, still }
  const [again, setAgain] = useState(0)
  const tries = useRef(0)
  useEffect(() => { tries.current = 0 }, [want])
  useEffect(() => {
    if (!want) return
    let retry: ReturnType<typeof setTimeout> | undefined
    let off = false
    const t = setTimeout(() => {
      const inUse = new Set<string>()
      const asked: Promise<PiecePic | null>[] = []
      for (const p of now.current.list) {
        const shot = pieceShot(p)
        inUse.add(pieceKey(p.url, shot.q, p.stretch))
        if (now.current.still(p)) asked.push(ensurePiece(p.url, shot.q, p.stretch))
      }
      trimPieces(inUse)
      void Promise.all(asked).then(got => {
        if (off || got.every(Boolean) || tries.current >= 4) return
        tries.current++
        retry = setTimeout(() => setAgain(n => n + 1), 31000)
      })
    }, 300)
    return () => { off = true; clearTimeout(t); if (retry) clearTimeout(retry) }
  }, [want, again])
  // One with no picture to show at all while its picture keeps changing
  // (a model put on a climbing path as the clock runs): drawn at once, as
  // it is now, and shown till it comes to rest.
  const bare = list.filter((p, i) => !pics[keys[i]] && !lastPic.has(p.key)).map(p => p.key).join(' ')
  useEffect(() => {
    if (!bare) return
    let off = false
    const ids = new Set(bare.split(' '))
    for (const p of now.current.list) {
      if (!ids.has(p.key)) continue
      void ensurePiece(p.url, pieceShot(p).q, p.stretch).then(pic => {
        if (off || !pic || lastPic.has(p.key)) return
        lastPic.set(p.key, pic)
        setAgain(n => n + 1)
      })
    }
    return () => { off = true }
  }, [bare])

  if (!list.length || shown <= 0) return null
  const ts = useTiltStore.getState()
  // How far a lifted piece has gone over to where its model is seen: all
  // the way before the model starts to show (4°, three/tiltScene), so the
  // one fades into the other in place.
  const x = flat ? 0 : Math.min(1, offFlat(ts) / 4)
  const over = x * x * (3 - 2 * x)
  const host = root.current?.parentElement ?? document.querySelector<HTMLElement>('[data-tilt-stage="overlay"]')
  const W = host?.clientWidth ?? 0, H = host?.clientHeight ?? 0
  // Which is drawn over which: the smaller over the bigger (by its
  // picture's box), so none is lost under another; of two the same size,
  // the one that stands higher.
  const covers = list.map((p, i) => {
    const pic = pics[keys[i]] ?? lastPic.get(p.key), size = sizes[p.url]
    if (!pic || !size) return ((size ? Math.max(size[0], size[2]) * pieceScale(p, size) : p.fit * 0.6 * p.size) || 1) ** 2
    const k = pieceScale(p, size)
    return pic.w * k * pic.h * k
  })
  const order = list.map((_, i) => i).sort((a, b) => covers[b] - covers[a] || list[a].h - list[b].h || a - b)
  return (
    // (Over every card and what a card wears over its face: a header, a
    // fanned deck's strips, at 55 at most. A model stands over them all:
    // at 55 too, and drawn after them (App: this layer follows the cards'),
    // so it is over them, and under what is pulled out over the canvas, a
    // card's tray (components/Linking/CardTray, 56).)
    <div ref={root} data-piece-layer="" style={{ position: 'absolute', left: panAt.x, top: panAt.y, width: 0, height: 0, zIndex: 55, pointerEvents: 'none', opacity: shown }}>
      {order.map(i => {
        const p = list[i]
        // (One going along a path keeps the picture it has till it comes
        // to rest: tipped by a climb or a lean it passes the sides it was
        // once pictured from, and would change to each for a moment, each
        // cut to its own size.)
        const moving = playing && !!p.riding && riderRuns(p.key, p.dk)
        const pic = moving && lastPic.has(p.key) ? undefined : pics[keys[i]]
        if (pic) lastPic.set(p.key, pic)
        // A lifted piece, as the camera tips: from where its lift puts it
        // looking down, to the spot on the plane its model's foot is seen
        // over, as big as the model is seen there.
        let at: { x: number; y: number; k: number } | null = null
        if (p.h > 0 && over > 0 && W && H) {
          const foot = { x: panAt.x + p.x * zoom - W / 2, y: panAt.y + p.y * zoom - H / 2, z: p.h * zoom }
          const sc = screenOf(foot, ts)
          const g = sc && unprojectTilt(sc.x, sc.y, ts.tilt, ts.spin, ts.shiftX, ts.shiftY, 0, TILT_FAR, ts.yaw)
          // A step across the plane, seen at the foot and on the ground
          // under it on the screen: the nearer one is seen the bigger.
          const D = 16
          const sf = sc && screenOf({ ...foot, x: foot.x + D }, ts)
          const sg = g && screenOf({ x: g.x, y: g.y }, ts), sgd = g && screenOf({ x: g.x + D, y: g.y }, ts)
          if (sc && g && sf && sg && sgd) {
            const far = Math.hypot(sgd.x - sg.x, sgd.y - sg.y)
            const k = far > 1e-6 ? Math.hypot(sf.x - sc.x, sf.y - sc.y) / far : 1
            const ex = (g.x + W / 2 - panAt.x) / zoom, ey = (g.y + H / 2 - panAt.y) / zoom
            const fy = p.y - p.h * PIECE_LIFT
            at = { x: p.x + (ex - p.x) * over, y: fy + (ey - fy) * over, k: 1 + (Math.min(3, k) - 1) * over }
          }
        }
        return <Piece key={p.key} p={p} pic={pic ?? lastPic.get(p.key) ?? null} size={sizes[p.url]} zoom={zoom}
          selected={pieceSelected(p.key, selNodes, selCards)} live={flat} at={at} moving={moving} />
      })}
    </div>
  )
}
