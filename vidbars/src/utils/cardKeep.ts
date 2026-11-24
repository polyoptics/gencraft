// cardKeep.ts — what belongs to a card but is kept beside it, saved with it.
//
// (Brian 2026-11-24: "looks like the model turn adjustments were not saved
// with cards, we should start to save all things.") How a 3D model is
// squared up, its angle and depth in the side view, its size, lift, colour,
// place in a 3D set, the marks drawn on a picture and the notes on a 3D
// model are not on the card: they are kept by this window, under the card's
// id or the file's url (store/tiltStore useModelScaleStore, store/notesStore).
// A saved project, a package or a card copied out of one therefore lost
// them on another machine, and a copy lost them anywhere, its id being new.
//
// A CardKeep is those settings for a set of cards, written into the saved
// document beside them and put back when the cards are read: under the
// cards' new ids for a copy. What is kept by FILE is written as a list of
// [what, url, value], the url a plain value, so everything that rewrites a
// document's urls (a package's files, a light copy) rewrites these with it.

import { useModelScaleStore } from '../store/tiltStore'
import { useNotesStore, type Stick, type Curve } from '../store/notesStore'
import { useWorldScale } from './worldScale'

/** Kept under a card's or a tile's key ('card:<id>' / 'node:<id>'). */
const OWN = ['sizeOf', 'setSizeOf', 'poseOf', 'tintOf', 'placeOf', 'stretchOf', 'floatOf', 'sideFloatOf', 'lensOf', 'pieceOf'] as const
/** Kept under a file's url. */
const FILE = ['unitsPerMetre', 'quarterOf', 'sideOf'] as const
type Own = typeof OWN[number]
type FileKind = typeof FILE[number] | 'marks' | 'notes'

/** What lies on the canvas itself and is no card's: the measuring sticks,
 *  the curves and paths, and the world scale (Brian 2026-11-24: a save
 *  opened on the laptop had none of them, so every Height stopped sizing
 *  its 3D model; and the last project's stayed lying on the next one's
 *  canvas). In a save of the WHOLE canvas only. */
export interface CanvasKeep {
  sticks: Record<string, Stick>
  curves: Record<string, Curve>
  world: { per: number | null }
}

export interface CardKeep {
  v: 1
  own: [what: Own, kind: 'card' | 'node', id: string, value: unknown][]
  files: [what: FileKind, url: string, value: unknown][]
  canvas?: CanvasKeep
}

/** The settings kept for these cards and tiles, and for the files named in
 *  `text` (the cards' own content, as JSON). */
export function collectKeep(groupIds: Iterable<string>, nodeIds: Iterable<string>, text: string,
  /** The whole canvas is being saved: what lies on it goes too (CanvasKeep). */
  whole = false): CardKeep | undefined {
  const ms = useModelScaleStore.getState()
  const ns = useNotesStore.getState()
  const cards = new Set(groupIds), tiles = new Set(nodeIds)
  const own: CardKeep['own'] = []
  for (const what of OWN) {
    for (const [key, value] of Object.entries(ms[what] as Record<string, unknown>)) {
      const cut = key.indexOf(':'), kind = key.slice(0, cut), id = key.slice(cut + 1)
      if ((kind === 'card' && cards.has(id)) || (kind === 'node' && tiles.has(id))) own.push([what, kind, id, value])
    }
  }
  // A picture written into the document itself is not named twice: it is
  // moved out to a file of its own first (utils/migrateInlineMedia).
  const named = (url: string) => !url.startsWith('data:') && text.includes(JSON.stringify(url).slice(1, -1))
  const files: CardKeep['files'] = []
  for (const what of FILE) {
    for (const [url, value] of Object.entries(ms[what] as Record<string, unknown>)) if (named(url)) files.push([what, url, value])
  }
  for (const [url, marks] of Object.entries(ns.pictures)) if (marks.length && named(url)) files.push(['marks', url, marks])
  for (const [url, m] of Object.entries(ns.models)) {
    // Its Annotation card is a tile of the canvas it was made on.
    if ((m.strokes.length || m.pins.length) && named(url)) files.push(['notes', url, { ...m, cardNodeId: undefined }])
  }
  if (whole) return { v: 1, own, files, canvas: { sticks: ns.sticks ?? {}, curves: ns.curves ?? {}, world: { per: useWorldScale.getState().per } } }
  return own.length || files.length ? { v: 1, own, files } : undefined
}

const REPLACED_KEY = 'vidbars.canvasKeep.replaced'
/** A whole canvas opened in place of this one: what lies on the canvas is
 *  the opened save's. A save from before this was kept (no `canvas`) says
 *  nothing, and what lies here stays, as it always did. The sticks and
 *  curves that give way are set aside (the last few lots, this browser's
 *  storage): until now they were in no save, so nothing else has them. */
export function applyCanvasKeep(keep: CardKeep | undefined): void {
  const c = keep?.v === 1 ? keep.canvas : undefined
  if (!c || typeof c !== 'object' || !c.sticks || !c.curves) return
  const ns = useNotesStore.getState()
  const was = { sticks: ns.sticks ?? {}, curves: ns.curves ?? {} }
  const same = JSON.stringify(was.sticks) === JSON.stringify(c.sticks) && JSON.stringify(was.curves) === JSON.stringify(c.curves)
  if (!same && (Object.keys(was.sticks).length || Object.keys(was.curves).length)) {
    try {
      const list = JSON.parse(localStorage.getItem(REPLACED_KEY) ?? '[]') as unknown[]
      localStorage.setItem(REPLACED_KEY, JSON.stringify([{ at: Date.now(), ...was, per: useWorldScale.getState().per }, ...(Array.isArray(list) ? list : [])].slice(0, 5)))
    } catch { /* no room, or a private window */ }
  }
  if (!same) useNotesStore.setState({ sticks: c.sticks, curves: c.curves })
  const per = c.world?.per
  useWorldScale.getState().loadPer(typeof per === 'number' && Number.isFinite(per) && per > 0 ? per : null)
}

/** Put a document's kept settings back: a card's under the id `card` gives
 *  for it (a copy's new id; none: left out), a file's where this window has
 *  none of its own for that file. */
export function applyKeep(
  keep: CardKeep | undefined,
  card: (id: string) => string | undefined = id => id,
  tile: (id: string) => string | undefined = id => id,
): void {
  if (!keep || keep.v !== 1 || !Array.isArray(keep.own) || !Array.isArray(keep.files)) return
  const ms = useModelScaleStore.getState()
  const next: Record<string, Record<string, unknown>> = {}
  const put = (what: string, key: string, value: unknown) => {
    (next[what] ??= { ...(ms as unknown as Record<string, Record<string, unknown>>)[what] })[key] = value
  }
  for (const [what, kind, id, value] of keep.own) {
    if (!(OWN as readonly string[]).includes(what)) continue
    const to = kind === 'card' ? card(id) : kind === 'node' ? tile(id) : undefined
    if (to) put(what, `${kind}:${to}`, value)
  }
  const ns = useNotesStore.getState()
  let pictures = ns.pictures, models = ns.models
  for (const [what, url, value] of keep.files) {
    if (typeof url !== 'string') continue
    if (what === 'marks') { if (!pictures[url]?.length && Array.isArray(value)) pictures = { ...pictures, [url]: value as typeof pictures[string] } }
    else if (what === 'notes') { if (!models[url] && value && typeof value === 'object') models = { ...models, [url]: { ...(value as typeof models[string]), url } } }
    else if ((FILE as readonly string[]).includes(what) && (ms[what] as Record<string, unknown>)[url] === undefined) put(what, url, value)
  }
  if (Object.keys(next).length) useModelScaleStore.setState(next as Partial<ReturnType<typeof useModelScaleStore.getState>>)
  if (pictures !== ns.pictures || models !== ns.models) useNotesStore.setState(s => ({ pictures, models, rev: s.rev + 1 }))
}
