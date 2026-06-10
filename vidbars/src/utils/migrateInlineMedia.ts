// migrateInlineMedia.ts — move images OUT of state (and off the server)
// INTO the local IndexedDB blob store (mediaStore), replacing each value
// with a small `mediaref:<id>` pointer so the whole project is local +
// self-contained (portable in the backup file).
//
// Converts two kinds of value:
//   - `data:` base64 URLs (decoded locally), and
//   - `/uploads/…` server paths (fetched from the dev server) — so the
//     project no longer depends on a server to show its images.
// Anything else (mediaref, external http(s), blob:) passes through.
//
// Two entry points:
//  - runInlineMediaMigration(): the guard-free core. Idempotent. Used by
//    the project import path, which always needs a fresh sweep.
//  - useInlineMediaMigration(): a load-time React hook that runs the
//    core once per app version (localStorage guard). Advances the guard
//    ONLY on a fully clean pass, so a server hiccup mid-sweep retries
//    next load rather than permanently skipping unfetched images.

import { useEffect, useRef } from 'react'
import { useBoardsStore } from '../store/boardsStore'
import type { BoardData, ProjectGroup } from '../store/boardsStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import type { FreeNodeData } from '../store/freeNodeStore'
import { putMedia } from './mediaStore'
import { isDataUrl, dataUrlToBlob, makeMediaRef } from './mediaRef'

const MIGRATION_KEY = 'vidbars-inline-media-migrated'
// v1: base64 data URLs → blobs. v2: also pull /uploads server paths local.
const MIGRATION_VERSION = 2

interface Counter { n: number; failed: number }

/** True for a same-origin server media path we should localize. */
function isUploadPath(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.startsWith('/uploads/')
}

/** Convert one value to a local blob ref:
 *   - `data:` URL → decode → store.
 *   - `/uploads/…` path → fetch → store.
 *   - anything else → unchanged.
 *  On any failure the original value is kept and counter.failed bumped
 *  (so the load guard retries next time). */
async function migrateValue(v: string | null | undefined, counter: Counter): Promise<string | null> {
  if (isDataUrl(v)) {
    const blob = dataUrlToBlob(v)
    if (!blob) return v // undecodable — passthrough still renders it
    try {
      const id = await putMedia(blob)
      counter.n++
      return makeMediaRef(id)
    } catch {
      counter.failed++
      return v
    }
  }
  if (isUploadPath(v)) {
    try {
      const res = await fetch(v)
      if (!res.ok) { counter.failed++; return v }
      const blob = await res.blob()
      const id = await putMedia(blob)
      counter.n++
      return makeMediaRef(id)
    } catch {
      counter.failed++
      return v
    }
  }
  return v ?? null
}

/** Walk every image-bearing field in both stores, convert inline data
 *  URLs to blob refs, and commit one setState per store. Safe to run
 *  repeatedly. */
export async function runInlineMediaMigration(): Promise<Counter> {
  const counter: Counter = { n: 0, failed: 0 }

  // ── freeNodeStore: nodes[].imageUrl ──
  const fnState = useFreeNodeStore.getState()
  const newNodes: Record<string, FreeNodeData> = {}
  let nodesChanged = false
  for (const [id, node] of Object.entries(fnState.nodes)) {
    if (isDataUrl(node.imageUrl) || isUploadPath(node.imageUrl)) {
      newNodes[id] = { ...node, imageUrl: await migrateValue(node.imageUrl, counter) }
      nodesChanged = true
    } else {
      newNodes[id] = node
    }
  }
  if (nodesChanged) useFreeNodeStore.setState({ nodes: newNodes })

  // ── boardsStore: boards (bars + layers) + groups ──
  const bsState = useBoardsStore.getState()
  const newBoards: Record<string, BoardData> = {}
  for (const [boardId, board] of Object.entries(bsState.boards)) {
    // Bars
    const newBars: typeof board.bars = {}
    for (const [barId, bar] of Object.entries(board.bars)) {
      const content = bar.content
      const newImages = content?.images
        ? await Promise.all(content.images.map(s => migrateValue(s, counter) as Promise<string>))
        : content?.images
      const newMedia = content?.media
        ? await Promise.all(content.media.map(async m => ({
            ...m,
            url: (await migrateValue(m.url, counter)) ?? m.url,
            ...(m.posterUrl !== undefined ? { posterUrl: (await migrateValue(m.posterUrl, counter)) ?? undefined } : {}),
          })))
        : content?.media
      newBars[barId] = {
        ...bar,
        icon: await migrateValue(bar.icon, counter),
        content: content ? { ...content, images: newImages ?? [], media: newMedia ?? [] } : content,
      }
    }
    // Board-level layer images
    const layers = board.layers
    const newLayers = layers ? {
      ...layers,
      card: layers.card ? { ...layers.card, heroImage: await migrateValue(layers.card.heroImage, counter) } : layers.card,
      block: layers.block ? { ...layers.block, thumbnail: await migrateValue(layers.block.thumbnail, counter) } : layers.block,
    } : layers
    newBoards[boardId] = { ...board, bars: newBars, layers: newLayers }
  }
  // Groups: cardHeroImage
  const newGroups: ProjectGroup[] = await Promise.all(
    bsState.groups.map(async g => ({ ...g, cardHeroImage: await migrateValue(g.cardHeroImage, counter) })),
  )
  useBoardsStore.setState({ boards: newBoards, groups: newGroups })

  if (counter.n > 0 || counter.failed > 0) {
    console.log(`[media-migrate] localized ${counter.n} images into the blob store` +
      (counter.failed > 0 ? ` (${counter.failed} failed — will retry next load)` : ''))
  }
  return counter
}

/** Resolve once a persisted store has finished its (async IndexedDB)
 *  rehydration — otherwise the migration would scan empty initial state. */
function whenHydrated(store: {
  persist?: { hasHydrated: () => boolean; onFinishHydration: (cb: () => void) => () => void }
}): Promise<void> {
  const p = store.persist
  if (!p || p.hasHydrated()) return Promise.resolve()
  return new Promise(resolve => {
    const unsub = p.onFinishHydration(() => { unsub(); resolve() })
  })
}

/** Load-time hook: run the sweep once per app version, AFTER both stores
 *  have rehydrated from IndexedDB. */
export function useInlineMediaMigration(): void {
  const ran = useRef(false)
  useEffect(() => {
    if (ran.current) return
    ran.current = true
    const stored = Number(localStorage.getItem(MIGRATION_KEY) ?? '0')
    if (stored >= MIGRATION_VERSION) return
    Promise.all([
      whenHydrated(useBoardsStore as never),
      whenHydrated(useFreeNodeStore as never),
    ])
      .then(() => runInlineMediaMigration())
      .then(({ failed }) => {
        // Only advance the guard on a fully clean pass; otherwise retry
        // next load (e.g. server was briefly unreachable mid-sweep).
        if (failed === 0) localStorage.setItem(MIGRATION_KEY, String(MIGRATION_VERSION))
      })
      .catch(err => console.warn('[media-migrate] failed; will retry next load', err))
  }, [])
}
