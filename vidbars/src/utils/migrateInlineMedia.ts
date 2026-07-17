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
//  - useInlineMediaMigration(): a load-time React hook that runs the core
//    on EVERY load (after store rehydration), gated by a cheap synchronous
//    pre-scan so a fully-localized project pays nothing. Continuous rather
//    than once-per-version: any legacy value that slips into state — an
//    old import, a quota-forced server-path fallback in uploadFile, a
//    fetch that failed last session — gets swept on the next load.

import { useEffect, useRef } from 'react'
import { useBoardsStore } from '../store/boardsStore'
import type { BoardData, ProjectGroup } from '../store/boardsStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import type { FreeNodeData } from '../store/freeNodeStore'
import { putMedia } from './mediaStore'
import { isDataUrl, dataUrlToBlob, makeMediaRef } from './mediaRef'
import { rekeyModelPosters } from '../three/posterService'

// Pre-continuous-sweep guard key ('vidbars-inline-media-migrated') — the
// sweep no longer version-gates, so clear the stale entry once.
const LEGACY_MIGRATION_KEY = 'vidbars-inline-media-migrated'

interface Counter { n: number; failed: number }

/** True for a same-origin server media path we should localize. */
function isUploadPath(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.startsWith('/uploads/')
}

/** True for any value the sweep would convert. */
function needsLocalizing(v: string | null | undefined): boolean {
  return isDataUrl(v) || isUploadPath(v)
}

/** Cheap synchronous scan: does any image-bearing field in either store
 *  still hold a `data:` URL or `/uploads/` server path? Mirrors exactly
 *  the fields runInlineMediaMigration rewrites. */
export function hasLegacyInlineMedia(): boolean {
  for (const node of Object.values(useFreeNodeStore.getState().nodes)) {
    if (needsLocalizing(node.imageUrl) || needsLocalizing(node.posterUrl)) return true
  }
  const bs = useBoardsStore.getState()
  for (const board of Object.values(bs.boards)) {
    if (needsLocalizing(board.layers?.card?.heroImage)) return true
    if (needsLocalizing(board.layers?.block?.thumbnail)) return true
    for (const bar of Object.values(board.bars)) {
      if (needsLocalizing(bar.icon)) return true
      const c = bar.content
      if (c?.images?.some(needsLocalizing)) return true
      if (c?.media?.some(m => needsLocalizing(m.url) || needsLocalizing(m.posterUrl))) return true
    }
  }
  for (const g of bs.groups) if (needsLocalizing(g.cardHeroImage)) return true
  return false
}

/** Convert one value to a local blob ref:
 *   - `data:` URL → decode → store.
 *   - `/uploads/…` path → fetch → store.
 *   - anything else → unchanged.
 *  On any failure the original value is kept and counter.failed bumped
 *  (so the load-time sweep retries next time). Successful conversions are
 *  recorded in `rewrites` (old value → new ref) so url-keyed side tables
 *  (the model poster map) can follow the rename. */
async function migrateValue(
  v: string | null | undefined,
  counter: Counter,
  rewrites: Map<string, string>,
): Promise<string | null> {
  if (isDataUrl(v)) {
    const blob = dataUrlToBlob(v)
    if (!blob) return v // undecodable — passthrough still renders it
    try {
      const id = await putMedia(blob)
      counter.n++
      const ref = makeMediaRef(id)
      rewrites.set(v, ref)
      return ref
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
      const ref = makeMediaRef(id)
      rewrites.set(v, ref)
      return ref
    } catch {
      counter.failed++
      return v
    }
  }
  return v ?? null
}

/** Walk every image-bearing field in both stores, convert inline data
 *  URLs / server paths to blob refs, and commit one setState per store —
 *  skipped entirely when nothing converted, so a no-op sweep causes no
 *  identity churn. Safe to run repeatedly. */
export async function runInlineMediaMigration(): Promise<Counter> {
  const counter: Counter = { n: 0, failed: 0 }
  const rewrites = new Map<string, string>()
  const convert = (v: string | null | undefined) => migrateValue(v, counter, rewrites)

  // ── freeNodeStore: nodes[].imageUrl / posterUrl ──
  const fnState = useFreeNodeStore.getState()
  const newNodes: Record<string, FreeNodeData> = {}
  let nodesChanged = false
  for (const [id, node] of Object.entries(fnState.nodes)) {
    if (needsLocalizing(node.imageUrl) || needsLocalizing(node.posterUrl)) {
      newNodes[id] = {
        ...node,
        imageUrl: await convert(node.imageUrl),
        ...(node.posterUrl !== undefined ? { posterUrl: await convert(node.posterUrl) } : {}),
      }
      nodesChanged = true
    } else {
      newNodes[id] = node
    }
  }

  // ── boardsStore: boards (bars + layers) + groups ──
  const nBeforeBoards = counter.n
  const bsState = useBoardsStore.getState()
  const newBoards: Record<string, BoardData> = {}
  for (const [boardId, board] of Object.entries(bsState.boards)) {
    // Bars
    const newBars: typeof board.bars = {}
    for (const [barId, bar] of Object.entries(board.bars)) {
      const content = bar.content
      const newImages = content?.images
        ? await Promise.all(content.images.map(s => convert(s) as Promise<string>))
        : content?.images
      const newMedia = content?.media
        ? await Promise.all(content.media.map(async m => ({
            ...m,
            url: (await convert(m.url)) ?? m.url,
            ...(m.posterUrl !== undefined ? { posterUrl: (await convert(m.posterUrl)) ?? undefined } : {}),
          })))
        : content?.media
      newBars[barId] = {
        ...bar,
        icon: await convert(bar.icon),
        content: content ? { ...content, images: newImages ?? [], media: newMedia ?? [] } : content,
      }
    }
    // Board-level layer images
    const layers = board.layers
    const newLayers = layers ? {
      ...layers,
      card: layers.card ? { ...layers.card, heroImage: await convert(layers.card.heroImage) } : layers.card,
      block: layers.block ? { ...layers.block, thumbnail: await convert(layers.block.thumbnail) } : layers.block,
    } : layers
    newBoards[boardId] = { ...board, bars: newBars, layers: newLayers }
  }
  // Groups: cardHeroImage
  const newGroups: ProjectGroup[] = await Promise.all(
    bsState.groups.map(async g => ({ ...g, cardHeroImage: await convert(g.cardHeroImage) })),
  )
  // Model posters are keyed by the RAW model url — follow the renames
  // BEFORE committing state, so components re-rendering with the new urls
  // find their existing posters instead of regenerating.
  if (rewrites.size > 0) await rekeyModelPosters(rewrites)

  if (nodesChanged) useFreeNodeStore.setState({ nodes: newNodes })
  if (counter.n > nBeforeBoards) useBoardsStore.setState({ boards: newBoards, groups: newGroups })

  if (counter.n > 0 || counter.failed > 0) {
    console.log(`[media-migrate] localized ${counter.n} media items into the blob store` +
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

/** Load-time hook: after both stores have rehydrated from IndexedDB,
 *  pre-scan for legacy inline/server media and sweep it local if any is
 *  found. Runs every load — the pre-scan makes the common (clean) case
 *  free, and a failed conversion simply retries next load. */
export function useInlineMediaMigration(): void {
  const ran = useRef(false)
  useEffect(() => {
    if (ran.current) return
    ran.current = true
    localStorage.removeItem(LEGACY_MIGRATION_KEY)
    Promise.all([
      whenHydrated(useBoardsStore as never),
      whenHydrated(useFreeNodeStore as never),
    ])
      .then(() => { if (hasLegacyInlineMedia()) return runInlineMediaMigration() })
      .catch(err => console.warn('[media-migrate] sweep failed; will retry next load', err))
  }, [])
}
