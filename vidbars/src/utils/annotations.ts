// annotations.ts — pins on models and the cards behind them (Brian
// 2026-11-07). Annotating a model the first time makes its Annotation card
// (a free node, components/Notes/AnnotationCardBody): the model, every pin
// and the card each links to, with a status. Every pin is backed by a card
// by default, a Note card (card type 'note'), made in a column beside the
// Annotation card; a pin can be linked to any other card instead.

import { useNotesStore, newNoteId, modelFileName, type ModelPin } from '../store/notesStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useBoardsStore } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useViewport3DStore } from '../store/viewport3dStore'
import { createCardOrBoardAt, createScaleFor, cardFootprint } from './canvasCreate'
import { withTypeDetails } from './cardTypes'

/** Canvas rect of what a model stands on (its 3D view key), if it can be
 *  found: a model tile, a card, or a Viewer. */
export function sourceRect(key: string): { x: number; y: number; w: number; h: number } | null {
  const i = key.indexOf(':')
  const kind = key.slice(0, i), id = key.slice(i + 1)
  if (kind === 'node') {
    const n = useFreeNodeStore.getState().nodes[id]
    return n ? { x: n.x, y: n.y, w: n.width, h: n.height } : null
  }
  if (kind === 'viewer') {
    const w = useViewport3DStore.getState().windows[id]
    return w ? { x: w.x, y: w.y, w: w.width, h: w.height } : null
  }
  if (kind === 'card') {
    const { pan, zoom } = useCanvasStore.getState()
    const el = document.querySelector<HTMLElement>(`[data-tilt-stage="overlay"] [data-group-card][data-id="${id}"]`)
    if (el) {
      const x = (parseFloat(el.style.left) || el.offsetLeft), y = (parseFloat(el.style.top) || el.offsetTop)
      return { x: (x - pan.x) / zoom, y: (y - pan.y) / zoom, w: el.offsetWidth / zoom, h: el.offsetHeight / zoom }
    }
    const g = useBoardsStore.getState().groups.find(x => x.id === id)
    return g ? { x: g.originX, y: g.originY, w: 300, h: 400 } : null
  }
  return null
}

/** A name for the model standing at `key`. */
export function modelName(key: string, url: string): string {
  const i = key.indexOf(':')
  const kind = key.slice(0, i), id = key.slice(i + 1)
  if (kind === 'node') {
    const n = useFreeNodeStore.getState().nodes[id]
    const f = modelFileName(url)
    return f !== 'Model' ? f : n?.label || 'Model'
  }
  if (kind === 'card') {
    const f = modelFileName(url)
    return f !== 'Model' ? f : useBoardsStore.getState().groups.find(g => g.id === id)?.name || 'Model'
  }
  return modelFileName(url)
}

/** The model's notes, and its Annotation card, made the first time. */
export function ensureAnnotated(url: string, key: string): string {
  const ns = useNotesStore.getState()
  const m = ns.ensureModel(url, modelName(key, url))
  const fs = useFreeNodeStore.getState()
  if (m.cardNodeId && fs.nodes[m.cardNodeId]) return m.cardNodeId
  // Beside what the model stands on, to its right, top edges level.
  const r = sourceRect(key)
  const k = createScaleFor(useCanvasStore.getState().zoom)
  const w = 760 * k, h = 520 * k
  const x = r ? r.x + r.w + 40 * k : 0, y = r ? r.y : 0
  const id = fs.addFreeNode(x, y, 'annotations')
  fs.updateFreeNode(id, { x, y, width: w, height: h, annotUrl: url, label: `Annotations · ${m.name}`, color: '#141a28' })
  ns.patchModel(url, { cardNodeId: id })
  return id
}

/** Make the Note card a pin is backed by, in a row under the model's
 *  Annotation card. Returns its card (group) id. */
export function makeNoteCard(url: string, title: string, desc: string): string | null {
  const ns = useNotesStore.getState()
  const m = ns.models[url]
  const ann = m?.cardNodeId ? useFreeNodeStore.getState().nodes[m.cardNodeId] : undefined
  const zoom = useCanvasStore.getState().zoom
  const fp = cardFootprint(zoom)
  const gap = fp.w * 0.12
  const count = m?.pins.filter(p => p.cardId).length ?? 0
  // Side by side: a card shown as a board further in is much taller than
  // its card, so a column of them would overlap there.
  const at = ann
    ? { cx: ann.x + fp.w / 2 + count * (fp.w + gap), cy: ann.y + ann.height + gap * 2 + fp.h / 2 }
    : undefined
  const boardId = createCardOrBoardAt(at)
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(x => x.boardIds.includes(boardId))
  if (!g) return null
  bs.renameGroup(g.id, title)
  bs.setGroupCardType(g.id, 'note')
  const now = useBoardsStore.getState().groups.find(x => x.id === g.id)
  const details = withTypeDetails(now?.details, 'note').map(d => {
    const n = d.name.toLowerCase()
    if (n === 'note') return { ...d, value: desc }
    if (n === 'status') return { ...d, value: 'Open' }
    if (n === 'model') return { ...d, value: m?.name ?? '' }
    return d
  })
  bs.setGroupDetails(g.id, details)
  return g.id
}

/** A new pin on model `url` (standing at `key`), at p with normal n (model
 *  space), with its Note card. */
export function addPin(url: string, key: string, p: [number, number, number], n: [number, number, number]): ModelPin {
  ensureAnnotated(url, key)
  const m = useNotesStore.getState().models[url]
  const n0 = (m?.pins.reduce((a, x) => Math.max(a, x.n0), 0) ?? 0) + 1
  const title = `Note ${n0}`
  const pin: ModelPin = { id: newNoteId('pin'), p, n, title, desc: '', status: 'open', n0 }
  pin.cardId = makeNoteCard(url, title, '') ?? undefined
  useNotesStore.getState().addPin(url, pin)
  return pin
}

/** A pin's title: its card's name while it has one. */
export function pinTitle(pin: ModelPin): string {
  if (pin.cardId) {
    const g = useBoardsStore.getState().groups.find(x => x.id === pin.cardId)
    if (g) return g.name
  }
  return pin.title
}

/** Set a pin's status, and the Status on its Note card. */
export function setPinStatus(url: string, pin: ModelPin, status: ModelPin['status']) {
  useNotesStore.getState().updatePin(url, pin.id, { status })
  const bs = useBoardsStore.getState()
  const g = pin.cardId ? bs.groups.find(x => x.id === pin.cardId) : undefined
  const d = g?.details?.find(x => x.name.toLowerCase() === 'status' && !x.link)
  if (g && d) bs.setGroupDetails(g.id, g.details!.map(x => x === d ? { ...x, value: status === 'resolved' ? 'Resolved' : 'Open' } : x))
}

/** Rename a pin (its card too). */
export function renamePin(url: string, pin: ModelPin, title: string) {
  useNotesStore.getState().updatePin(url, pin.id, { title })
  if (pin.cardId && useBoardsStore.getState().groups.some(g => g.id === pin.cardId)) useBoardsStore.getState().renameGroup(pin.cardId, title)
}

/** Set a pin's second line (and its Note card's Note). */
export function setPinDesc(url: string, pin: ModelPin, desc: string) {
  useNotesStore.getState().updatePin(url, pin.id, { desc })
  const bs = useBoardsStore.getState()
  const g = pin.cardId ? bs.groups.find(x => x.id === pin.cardId) : undefined
  const d = g?.details?.find(x => x.name.toLowerCase() === 'note' && !x.link)
  if (g && d && g.cardType === 'note') bs.setGroupDetails(g.id, g.details!.map(x => x === d ? { ...x, value: desc } : x))
}
