// migrateInlineMedia.ts — move base64 data-URL images OUT of the
// persisted Zustand state and INTO the IndexedDB blob store (mediaStore),
// replacing each inline value with a small `mediaref:<id>` pointer.
//
// Two entry points:
//  - runInlineMediaMigration(): the guard-free core. Idempotent (only
//    touches `data:` values; existing refs / urls are skipped). Used by
//    the project import path, which always needs a fresh sweep.
//  - useInlineMediaMigration(): a load-time React hook that runs the
//    core once per app version (localStorage guard), mirroring the old
//    useBase64Migration pattern.

import { useEffect, useRef } from 'react'
import { useBoardsStore } from '../store/boardsStore'
import type { BoardData, ProjectGroup } from '../store/boardsStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import type { FreeNodeData } from '../store/freeNodeStore'
import { putMedia } from './mediaStore'
import { isDataUrl, dataUrlToBlob, makeMediaRef } from './mediaRef'

const MIGRATION_KEY = 'vidbars-inline-media-migrated'
const MIGRATION_VERSION = 1

/** Convert one value: a `data:` URL → stored blob + `mediaref:`; anything
 *  else passes through unchanged. Counts conversions via the counter. */
async function migrateValue(v: string | null | undefined, counter: { n: number }): Promise<string | null> {
  if (!isDataUrl(v)) return v ?? null
  const blob = dataUrlToBlob(v)
  if (!blob) return v // undecodable — leave as-is (resolver passthrough still renders it)
  try {
    const id = await putMedia(blob)
    counter.n++
    return makeMediaRef(id)
  } catch {
    return v // put failed (e.g. quota) — keep the data URL; next sweep retries
  }
}

/** Walk every image-bearing field in both stores, convert inline data
 *  URLs to blob refs, and commit one setState per store. Safe to run
 *  repeatedly. */
export async function runInlineMediaMigration(): Promise<number> {
  const counter = { n: 0 }

  // ── freeNodeStore: nodes[].imageUrl ──
  const fnState = useFreeNodeStore.getState()
  const newNodes: Record<string, FreeNodeData> = {}
  let nodesChanged = false
  for (const [id, node] of Object.entries(fnState.nodes)) {
    if (isDataUrl(node.imageUrl)) {
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

  if (counter.n > 0) console.log(`[media-migrate] moved ${counter.n} inline images into the blob store`)
  return counter.n
}

/** Load-time hook: run the sweep once per app version. */
export function useInlineMediaMigration(): void {
  const ran = useRef(false)
  useEffect(() => {
    if (ran.current) return
    ran.current = true
    const stored = Number(localStorage.getItem(MIGRATION_KEY) ?? '0')
    if (stored >= MIGRATION_VERSION) return
    runInlineMediaMigration()
      .then(() => { localStorage.setItem(MIGRATION_KEY, String(MIGRATION_VERSION)) })
      .catch(err => console.warn('[media-migrate] failed; will retry next load', err))
  }, [])
}
