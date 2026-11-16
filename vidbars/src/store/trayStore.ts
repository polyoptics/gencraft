// A card's tray (Brian 2026-11-13): a small Card Browser pulled down from
// the card's bottom edge, listing the cards it holds and the cards linked
// with it (components/Linking/CardTray). Here: how far each is pulled and
// how wide, and its browser's search and view settings.
//
// A view matter, like the link showings (linkingStore): not saved.

import { create } from 'zustand'
import type { ListQuery } from '../utils/contentKinds'

export interface Tray {
  /** How far it is pulled down, canvas units; 0 = shut. */
  h: number
  /** Its width, canvas units; none = as wide as its card. */
  w?: number
  /** A scene card's tray is tucked away behind its "..." until this is on
   *  (Brian 2026-11-16); its size is kept meanwhile. Other cards: unused. */
  out?: boolean
  /** How many cards its browser lists just now (it says so while out). */
  rows?: number
  query: ListQuery
}

export const TRAY_QUERY: ListQuery = { query: '', kind: 'all', includeCanvasItems: false, sortMode: 'creation', view: 'flat', displayMode: 'auto' }

interface TrayStore {
  trays: Record<string, Tray>
  setSize: (cardId: string, size: { h?: number; w?: number }) => void
  setRows: (cardId: string, rows: number) => void
  setOut: (cardId: string, out: boolean, h?: number) => void
  patchQuery: (cardId: string, patch: Partial<ListQuery>) => void
}

export const useTrayStore = create<TrayStore>(set => ({
  trays: {},
  setSize: (cardId, size) => set(s => {
    const t = s.trays[cardId] ?? { h: 0, query: TRAY_QUERY }
    return { trays: { ...s.trays, [cardId]: { ...t, ...size } } }
  }),
  setOut: (cardId, out, h) => set(s => {
    const t = s.trays[cardId] ?? { h: 0, query: TRAY_QUERY }
    return { trays: { ...s.trays, [cardId]: { ...t, out, ...(h !== undefined ? { h } : {}) } } }
  }),
  setRows: (cardId, rows) => set(s => {
    const t = s.trays[cardId]
    return !t || t.rows === rows ? s : { trays: { ...s.trays, [cardId]: { ...t, rows } } }
  }),
  patchQuery: (cardId, patch) => set(s => {
    const t = s.trays[cardId] ?? { h: 0, query: TRAY_QUERY }
    return { trays: { ...s.trays, [cardId]: { ...t, query: { ...t.query, ...patch } } } }
  }),
}))
