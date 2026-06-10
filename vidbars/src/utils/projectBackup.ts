// projectBackup.ts — export/import the whole project to/from a single
// self-contained JSON file. This is the user's portable backup AND the
// manual cross-device transfer: export on one machine, import on another.
//
// The file captures exactly what the three Zustand stores persist (the
// same slices as their `partialize`), so an import is a faithful, full
// restore. Images are still base64-inline in the state today, so the
// file is fully self-contained (no separate asset bundle needed). When
// media later moves to a blob store, exportProject() will re-inline it
// so this file format stays stable.

import { useBoardsStore } from '../store/boardsStore'
import type { BoardData, ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { isMediaRef, mediaRefId, blobToDataUrl } from './mediaRef'
import { getMedia } from './mediaStore'
import { runInlineMediaMigration } from './migrateInlineMedia'

const FORMAT = 'vidbars-project'
// Persist versions, mirrored from each store's `persist({ version })`.
// Recorded so a future importer can run the right migrations.
const BOARDS_VERSION = 12
const CANVAS_VERSION = 2
const FREENODES_VERSION = 0

export interface ProjectBackup {
  format: typeof FORMAT
  exportedAt: string
  app: string
  stores: {
    boards: { boards: Record<string, unknown>; boardOrder: string[]; groups: unknown[]; version: number }
    freenodes: { nodes: Record<string, unknown>; version: number }
    canvas: { prefs: Record<string, unknown>; version: number }
  }
}

/** Snapshot the persisted slices of all three stores. Mirrors each
 *  store's partialize so the round-trip is exact. */
function buildBackup(): ProjectBackup {
  const bs = useBoardsStore.getState()
  const cs = useCanvasStore.getState()
  const fn = useFreeNodeStore.getState()

  // boardsStore.partialize: strip ephemeral per-board UI state.
  const boards = Object.fromEntries(
    Object.entries(bs.boards).map(([id, b]) => [id, { ...b, viewerBarId: null, selectedIds: [] }]),
  )

  // canvasStore.partialize: persisted preferences only.
  const canvasPrefs: Record<string, unknown> = {
    pan: cs.pan,
    zoom: cs.zoom,
    boardPos: cs.boardPos,
    nleRowHeight: cs.nleRowHeight,
    dynamicRowHeights: cs.dynamicRowHeights,
    drawColor: cs.drawColor,
    drawSize: cs.drawSize,
    rolodexOpen: cs.rolodexOpen,
    rolodexSortMode: cs.rolodexSortMode,
    rolodexView: cs.rolodexView,
    rolodexDisplayMode: cs.rolodexDisplayMode,
    rolodexPos: cs.rolodexPos,
    rolodexExpansion: cs.rolodexExpansion,
    rolodexCollapsedDeckIds: cs.rolodexCollapsedDeckIds,
  }

  return {
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    app: 'genCraft',
    stores: {
      boards: { boards, boardOrder: bs.boardOrder, groups: bs.groups, version: BOARDS_VERSION },
      freenodes: { nodes: fn.nodes, version: FREENODES_VERSION },
      canvas: { prefs: canvasPrefs, version: CANVAS_VERSION },
    },
  }
}

/** Resolve a `mediaref:` value back to its base64 data URL (via the blob
 *  store) so the exported file stays self-contained and portable. Plain
 *  values pass through; an orphaned ref becomes null. */
async function reinlineValue(v: string | null | undefined): Promise<string | null> {
  if (!isMediaRef(v)) return v ?? null
  const id = mediaRefId(v)!
  const blob = await getMedia(id)
  if (!blob) { console.warn(`[backup] export: no blob for ${id}, dropping`); return null }
  return blobToDataUrl(blob)
}

/** Walk the backup's media-bearing fields, re-inlining any `mediaref:`
 *  values to base64 so the file imports onto a machine with no blob store. */
async function reinlineBackup(backup: ProjectBackup): Promise<ProjectBackup> {
  const b = backup.stores
  // free nodes
  const nodes: Record<string, unknown> = {}
  for (const [id, node] of Object.entries(b.freenodes.nodes as Record<string, { imageUrl?: string | null }>)) {
    nodes[id] = { ...node, imageUrl: await reinlineValue(node.imageUrl) }
  }
  // boards
  const boards: Record<string, unknown> = {}
  for (const [boardId, board] of Object.entries(b.boards.boards as Record<string, BoardData>)) {
    const newBars: Record<string, unknown> = {}
    for (const [barId, bar] of Object.entries(board.bars)) {
      const c = bar.content
      newBars[barId] = {
        ...bar,
        icon: await reinlineValue(bar.icon),
        content: c ? {
          ...c,
          images: c.images ? await Promise.all(c.images.map(s => reinlineValue(s) as Promise<string>)) : c.images,
          media: c.media ? await Promise.all(c.media.map(async m => ({
            ...m,
            url: (await reinlineValue(m.url)) ?? m.url,
            ...(m.posterUrl !== undefined ? { posterUrl: (await reinlineValue(m.posterUrl)) ?? undefined } : {}),
          }))) : c.media,
        } : c,
      }
    }
    const layers = board.layers
    const newLayers = layers ? {
      ...layers,
      card: layers.card ? { ...layers.card, heroImage: await reinlineValue(layers.card.heroImage) } : layers.card,
      block: layers.block ? { ...layers.block, thumbnail: await reinlineValue(layers.block.thumbnail) } : layers.block,
    } : layers
    boards[boardId] = { ...board, bars: newBars, layers: newLayers }
  }
  const groups = await Promise.all(
    (b.boards.groups as ProjectGroup[]).map(async g => ({ ...g, cardHeroImage: await reinlineValue(g.cardHeroImage) })),
  )
  return {
    ...backup,
    stores: {
      ...b,
      boards: { ...b.boards, boards: boards as Record<string, unknown>, groups: groups as unknown[] },
      freenodes: { ...b.freenodes, nodes: nodes as Record<string, unknown> },
    },
  }
}

/** Serialize the whole project and trigger a file download. Re-inlines
 *  blob-store media so the file is fully self-contained. */
export async function exportProject(): Promise<void> {
  const backup = await reinlineBackup(buildBackup())
  const json = JSON.stringify(backup)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const a = document.createElement('a')
  a.href = url
  a.download = `vidbars-project-${stamp}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Parse + validate a backup file. Rejects with a human-readable message. */
export function readBackupFile(file: File): Promise<ProjectBackup> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result))
        if (!data || data.format !== FORMAT || !data.stores?.boards || !data.stores?.canvas) {
          reject(new Error('That doesn’t look like a genCraft project file.'))
          return
        }
        resolve(data as ProjectBackup)
      } catch {
        reject(new Error('Could not read the file (invalid JSON).'))
      }
    }
    reader.onerror = () => reject(reader.error ?? new Error('File read failed.'))
    reader.readAsText(file)
  })
}

/** Replace the current project with a parsed backup. Writes the slices
 *  into the live stores (persistence saves them on its normal debounce)
 *  and clears transient selection state so nothing dangles against the
 *  freshly-loaded ids. The UI updates live — no reload needed. */
export async function applyBackup(backup: ProjectBackup): Promise<void> {
  const { boards, freenodes, canvas } = backup.stores

  useBoardsStore.setState({
    boards: boards.boards as never,
    boardOrder: boards.boardOrder,
    groups: boards.groups as never,
    selectedGroupIds: [],
  })
  useFreeNodeStore.setState({ nodes: freenodes.nodes as never, selectedIds: [] })
  useCanvasStore.setState({
    ...(canvas.prefs as object),
    // Clear transient selection / view state that may reference old ids.
    selectedBlockBoardIds: [],
    selectedGhostGroupIds: [],
    focusedBoardId: null,
    deckPortalSelections: {},
  } as never)

  // The file is self-contained (base64-inline). Sweep it into the blob
  // store so imported images live as refs like the rest of the app.
  await runInlineMediaMigration()
}
