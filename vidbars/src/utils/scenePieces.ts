// scenePieces.ts — a 3D set's models as pieces in the flat view (Brian
// 2026-11-12: "like a tabletop war map"). Looking straight down, a model
// placed in a set shows where it stands as a picture of its shape
// (three/pieceService), to scale, in its colour, its name under it; lifted,
// it is drawn further up the screen, over a shadow on the spot it is
// above. A piece is the model itself, not a card: a click selects what a
// click on the model selects, a drag moves the model in its set
// (components/Canvas/PieceLayer). Tipping into 3D, the pieces fade as the
// models stand up in their place.
//
// Which models: the ones the 3D view stands off their own card (TiltModels
// collectTargets): placed in a set (area3dScene sceneSpot), or riding a
// path. Read from the stores alone, so a set off screen or zoomed far out
// has its pieces too. A model still on its own card has no piece: its card
// shows it. Where it stands is where it was put, on the set's ground or a
// little off it: nothing holds a piece to the ground's edge. A model that
// rides a path (utils/pathRide; Brian 2026-11-13: the map's pieces "update
// with that") is where the path has it now, turned as the path turns it,
// whether it is of a set, placed there or not, or of none: its piece goes
// along the path with the ride clock. What keeps to the path is its feet,
// or its middle (a rider set to Center): then its feet are half its height
// under the path.
//
// A piece's picture is taken from straight above unless the model was
// given a view of its own ("This view", tiltStore pieceOf). From above,
// the model's turn about the upright is taken out of the picture and
// given to the piece, so one picture serves however it is turned; tipped
// over, its picture is drawn again. A view of its own stays as it was
// taken, upright, standing on its spot as a token does.

import { isShut } from './deckTree'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useBoardsStore } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useModelScaleStore, useTiltStore, standRise, type PieceView } from '../store/tiltStore'
import { useManip } from '../store/manipStore'
import { useNotesStore, type Curve } from '../store/notesStore'
import { usePeek } from './peek'
import { rideSpots, type RideSpot } from './pathRide'
import { cardModel, fileName } from '../components/Canvas/tilt/TiltModels'
import { dataKey, sceneOf, sceneSpot, boxOfKey } from './area3dScene'
import { parentOf } from './curveParent'
import { isHiddenDeckMember } from '../hooks/useCardDecks'
import { CAMERA_URL } from '../three/primitives'
import { usePieceStore, type PiecePic, type Quat, type Vec3 } from '../three/pieceService'

export interface ScenePiece {
  /** The model, as the 3D view knows it ('card:<id>' / 'node:<id>'), and
   *  where its settings are kept (area3dScene dataKey). */
  key: string
  dk: string
  /** The 3D set it is in (its ground's node id). One in no set's scene,
   *  riding a path: the set its path belongs to, '' when none. */
  areaId: string
  url: string
  name: string
  /** Where it stands: its foot's middle, and how high (canvas units). */
  x: number; y: number; h: number
  /** The width its model is fitted to (its card's or tile's, canvas
   *  units), and its size in the set, × that fit. */
  fit: number
  size: number
  pose?: Quat
  stretch?: Vec3
  tint?: string
  view?: PieceView
  /** It rides a path (utils/pathRide): where it stands is where the path
   *  has it now, and `ride` how the path turns it there (as the 3D view
   *  turns its model, before its own turn: about its foot, or about its
   *  middle when that is what keeps to the path, `rideMid`, and a camera
   *  always). */
  riding?: boolean
  ride?: Quat
  rideMid?: boolean
}

// ── Who rides a path ──

let ridersMemo: { curves: unknown; keys: Set<string>; on: Map<string, Curve>; sig: string } | null = null
/** The models riding a path now, as the 3D view knows them, each with its
 *  path (a path of one point carries none: utils/pathRide rideSpots). */
function riders() {
  const curves = useNotesStore.getState().curves
  if (ridersMemo && ridersMemo.curves === curves) return ridersMemo
  const keys = new Set<string>()
  const on = new Map<string, Curve>()
  for (const c of Object.values(curves)) if (c.pts.length > 1) for (const r of c.riders ?? []) { keys.add(r.key); on.set(r.key, c) }
  ridersMemo = { curves, keys, on, sig: [...keys].sort().join(' ') }
  return ridersMemo
}
/** Which models ride a path, as one string: the same while they do. */
export const pieceRiders = (): string => riders().sig
/** Does model `key` (its settings under `dk`) ride a path? */
export const pieceRides = (key: string, dk: string): boolean => { const r = riders().keys; return r.has(key) || r.has(dk) }

let memo: { sig: unknown[]; list: ScenePiece[] } | null = null
let rode: { base: ScenePiece[]; spots: Map<string, RideSpot>; sizes: unknown; list: ScenePiece[] } | null = null

/** The pieces of every 3D set out on the canvas. The same list (by
 *  identity) while nothing it is worked out from has changed. */
export function scenePieces(): ScenePiece[] {
  const base = standing()
  if (!base.some(p => p.riding)) return base
  // The riders: where their paths have them now (the same spots, by
  // identity, while the ride clock and the paths stand still).
  const spots = rideSpots()
  const sizes = usePieceStore.getState().sizes
  if (rode && rode.base === base && rode.spots === spots && rode.sizes === sizes) return rode.list
  const paths = riders().on
  const list = base.map(p => {
    const r = p.riding ? spots.get(p.key) ?? spots.get(p.dk) : undefined
    if (!r) return p
    // In no set's scene: with the set its path belongs to (it folds into
    // that set's card with its path).
    const path = p.areaId ? undefined : paths.get(p.key) ?? paths.get(p.dk)
    const areaId = p.areaId || (path && parentOf(path)) || ''
    // Its middle on the path, not its feet: they are half its height under
    // it (as the 3D view stands it: three/tiltScene), no lower than the
    // ground it is drawn on. (Once its model is measured.)
    const size = r.mid ? sizes[p.url] : undefined
    const h = size ? Math.max(0, r.z - size[1] / 2 * (p.stretch?.[1] ?? 1) * pieceScale(p, size)) : r.z
    return { ...p, areaId, x: r.x, y: r.y, h, ...(r.q ? { ride: r.q } : {}), ...(r.mid ? { rideMid: true } : {}) }
  })
  rode = { base, spots, sizes, list }
  return list
}

/** The pieces, each where it was put: a rider's place is given it after. */
function standing(): ScenePiece[] {
  const fs = useFreeNodeStore.getState(), bs = useBoardsStore.getState(), ms = useModelScaleStore.getState(), cs = useCanvasStore.getState()
  const riding = riders()
  // (zoom: a card's box, so what it docks to and its model's fit, can
  // change with it.)
  const sig = [fs.nodes, bs.groups, bs.boards, ms.placeOf, ms.sizeOf, ms.setSizeOf, ms.poseOf, ms.stretchOf, ms.tintOf, ms.pieceOf, cs.zoom, cs.deckPortalSelections, riding.sig]
  if (memo && memo.sig.every((v, i) => v === sig[i])) return memo.list
  const list: ScenePiece[] = []
  const placed = ms.placeOf
  if (riding.keys.size || (Object.keys(placed).length && Object.values(fs.nodes).some(n => n.type === 'area' && !n.pin))) {
    // A closed deck's front card and the member on its face are one model
    // on one spot (the member's own stands there too): one piece. Unless
    // only one of the two rides a path, or each its own: then they are
    // apart, as in the 3D view, a piece each. `by`: the rider it goes by
    // (its card's own ride first, as TiltModels collectTargets).
    const seen = new Set<string>()
    const rider = (key: string, dk: string) => riding.keys.has(key) ? key : riding.keys.has(dk) ? dk : ''
    const add = (key: string, dk: string, url: string, name: string) => {
      const by = rider(key, dk)
      if (seen.has(`${dk}|${by}`)) return
      // Placed in a set's scene, or riding a path: in a set's scene
      // (placed there or not) or in none, as the 3D view stands it.
      const sc = sceneOf(key), sp = sc && sceneSpot(key)
      const box = sc?.box ?? (by ? boxOfKey(key) : null)
      if (!box || (!sp && !by)) return
      seen.add(`${dk}|${by}`)
      list.push({
        key, dk, areaId: sc?.area.id ?? '', url, name, x: sp ? sp.x : box.x + box.width / 2, y: sp ? sp.y : box.y + box.height / 2, h: sp ? sp.h : 0,
        fit: Math.min(box.width, box.height * 1.4), size: ms.setSizeOf[dk] ?? ms.sizeOf[dk] ?? 1,
        pose: ms.poseOf[dk], stretch: ms.stretchOf[dk], tint: ms.tintOf[dk], view: ms.pieceOf[dk],
        ...(by ? { riding: true } : {}),
      })
    }
    for (const n of Object.values(fs.nodes)) {
      if (n.type !== 'model' || n.pin || !n.imageUrl || !(placed[`node:${n.id}`] || riding.keys.has(`node:${n.id}`))) continue
      add(`node:${n.id}`, `node:${n.id}`, n.imageUrl, n.label || fileName(n.imageUrl) || 'Model')
    }
    // Cards on show first: a closed deck's front card stands for the
    // member on its face, before that member is come to by itself.
    const cards = bs.groups.filter(g => !g.pin)
    for (const g of [...cards.filter(g => !isHiddenDeckMember(g)), ...cards.filter(isHiddenDeckMember)]) {
      const key = `card:${g.id}`
      // (Only a closed or fanned deck's front keeps its model's settings
      // with another card.)
      const dk = isShut(g) ? dataKey(key) : key
      const by = rider(key, dk)
      if (!(placed[dk] || by) || seen.has(`${dk}|${by}`)) continue
      const face = dk === key ? g : bs.groups.find(x => x.id === dk.slice(5)) ?? g
      // "Show model in 3D" off: its model stays flat on its card.
      if (g.hideModel3d || face.hideModel3d) continue
      // "Show model in 2D" off: no piece; in 3D it stands as ever.
      if (g.hidePiece || face.hidePiece) continue
      const model = cardModel(g.id)
      if (!model) continue
      add(key, dk, model.url, pieceName(face.name, model.name))
    }
  }
  memo = { sig, list }
  return list
}

/** A model card's name for its piece (and its row in the Outliner): the
 *  card's own, or its model's while the card has none of its own. */
export const pieceName = (cardName: string | undefined, modelName: string) =>
  cardName && cardName.trim() && cardName !== 'Card' ? cardName : modelName

/** Is this model (as the 3D view knows it) selected? */
export function pieceSelected(key: string, selNodes: string[], selCards: string[]): boolean {
  return key.startsWith('node:') ? selNodes.includes(key.slice(5)) : selCards.includes(key.slice(5))
}

// ── The picture's side, and the piece's lay ──

const STAND_Q: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]
const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
]
/** `v` as `q` turns it. */
const qrot = (q: Quat, v: Vec3): Vec3 => {
  const tx = 2 * (q[1] * v[2] - q[2] * v[1]), ty = 2 * (q[2] * v[0] - q[0] * v[2]), tz = 2 * (q[0] * v[1] - q[1] * v[0])
  return [v[0] + q[3] * tx + q[1] * tz - q[2] * ty, v[1] + q[3] * ty + q[2] * tx - q[0] * tz, v[2] + q[3] * tz + q[0] * ty - q[1] * tx]
}

/** The side a piece's picture is taken from (`q`, three/pieceService),
 *  how far the picture is then turned on the canvas (`turn`: radians,
 *  clockwise as CSS turns), and where the model's foot lies from its
 *  middle in the picture, for each half of its height. */
export interface PieceShot { q: Quat; turn: number; foot: [number, number] }

/** `held`: the side the picture it is showing was taken from, when that is
 *  not the side it would be taken from now (one going along a path keeps
 *  its picture, components/Canvas/PieceLayer): the turn is then the one
 *  that brings that picture nearest to how the model lies now. */
export function pieceShot(p: ScenePiece, held?: Quat): PieceShot {
  // A view of its own: as it was taken, upright.
  if (p.view) return { q: p.view.q, turn: 0, foot: p.view.foot }
  // From straight above: the model stood up on the plane (tiltScene: its
  // +y the plane's normal, its front down the screen), as it is turned:
  // by the path it rides, then its own turn.
  const own = p.ride ? (p.pose ? qmul(p.ride, p.pose) : p.ride) : p.pose
  const q = own ? qmul(STAND_Q, own) : STAND_Q
  // Its turn about the eye's own axis comes out of the picture: q = that
  // turn, after the rest. Upright, the rest is the same for every turn.
  // (A picture kept from before: its turn from where that picture was
  // taken. Taken out of the whole turn it swings about as the model tips,
  // by a climb or a lean, the more the further its own turn has it from
  // upright, while the picture stays as it was: Brian 2026-11-15, "they
  // twist and rotate in a really strange way".)
  const from = held ? qmul(q, [-held[0], -held[1], -held[2], held[3]]) : q
  const n = Math.hypot(from[2], from[3])
  const tz = n < 1e-6 ? 0 : from[2] / n, tw = n < 1e-6 ? 1 : from[3] / n
  const back: Quat = [0, 0, -tz, tw]
  // A path turns its rider about its foot, and its middle is half its
  // height up from there (tiltScene: turn, over orient): tipped by a climb
  // or a lean, its foot is not under its middle. Its own turn is about
  // its middle, and leaves its foot where it is. So does the path's turn
  // of a rider whose middle keeps to the path, and of a camera (turned
  // about its middle, as in the hand): its middle stays over its spot.
  const f = p.ride && !p.rideMid && p.url !== CAMERA_URL ? qrot(qmul(back, qmul(STAND_Q, p.ride)), [0, -1, 0]) : null
  const foot: [number, number] = f ? [f[0], f[1]] : [0, 0]
  if (n < 1e-6) return { q: held ?? q, turn: 0, foot }
  // (The picture's y is up, the canvas's down: it turns the other way.)
  return { q: held ?? qmul(back, q), turn: -2 * Math.atan2(tz, tw), foot }
}

/** How many canvas units one of the model's own units is drawn at: its fit
 *  to its card (as three/tiltScene frame() fits it standing), × its size. */
export function pieceScale(p: ScenePiece, size: Vec3): number {
  const foot = Math.max(size[0], size[2], 1e-6)
  let k = p.fit * 0.6 / foot
  if (size[1] * k > p.fit * 1.1) k = p.fit * 1.1 / Math.max(size[1], 1e-6)
  return k * p.size
}

/** A piece laid on the canvas (canvas units): its picture's box before it
 *  is turned, and the point in it (from its left and top) that stands on
 *  the model's spot, which it turns about. */
export interface PieceLay { left: number; top: number; w: number; h: number; ax: number; ay: number; turn: number }

export function layPiece(p: ScenePiece, pic: PiecePic, size: Vec3, shot: PieceShot): PieceLay {
  const k = pieceScale(p, size)
  const w = pic.w * k, h = pic.h * k
  // From its middle to its foot: half its height, as it is stretched.
  const half = size[1] / 2 * (p.stretch?.[1] ?? 1) * k
  const ax = pic.ox * w + shot.foot[0] * half, ay = pic.oy * h - shot.foot[1] * half
  return { left: p.x - ax, top: p.y - ay, w, h, ax, ay, turn: shot.turn }
}

/** How far up the canvas a lifted piece is drawn from the spot it is
 *  above, for each unit of its height: where it is seen at the tilt the
 *  models have stood up by (tan 15°), so it fades into its model there. */
export const PIECE_LIFT = Math.tan(15 * Math.PI / 180)

/** How much of the pieces shows, 0–1: all of them looking straight down,
 *  none once the models stand (they rise over the same degrees, tiltStore
 *  standRise), nor while the 3D look is locked on or a camera is looked
 *  through. Peeking, no model stands: the pieces stay. */
export function piecesShown(): number {
  const ts = useTiltStore.getState()
  if (ts.lock3d || useManip.getState().through) return 0
  if (usePeek.getState().target) return 1
  return 1 - standRise(ts)
}
