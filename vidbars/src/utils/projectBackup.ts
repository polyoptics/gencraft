// projectBackup.ts — export/import the whole project as a portable .zip.
//
// This is the user's backup AND manual cross-device transfer: export on
// one machine, import on another.
//
// Why a zip (not one JSON file): images live in the local blob store and
// total hundreds of MB. Re-inlining them all to base64 into a single JSON
// string overflows V8's max string length (~512 MB) → "Invalid string
// length". A zip sidesteps that entirely: a small `project.json` manifest
// (state with `mediaref:<id>` pointers kept as-is) plus each image as its
// own binary `media/<id>.<ext>` entry. Nothing ever becomes one giant
// string, so it scales to any project size — and the archive is a plain
// zip the user can open by hand to recover individual images.
//
// Backward compatible on import: legacy Phase-1 `.json` backups (base64
// inline) are detected and swept into the blob store on the way in.

import { zip, unzip, type AsyncZippable, type Unzipped } from 'fflate'
import { useBoardsStore } from '../store/boardsStore'
import type { BoardData, ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import { isMediaRef, mediaRefId } from './mediaRef'
import { getMedia, putMediaWithId } from './mediaStore'
import { runInlineMediaMigration } from './migrateInlineMedia'

const FORMAT = 'vidbars-project'
// Persist versions, mirrored from each store's `persist({ version })`.
// Recorded so a future importer can run the right migrations.
const BOARDS_VERSION = 12
const CANVAS_VERSION = 2
const FREENODES_VERSION = 0

const MANIFEST_NAME = 'project.json'
const MEDIA_DIR = 'media/'

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
 *  store's partialize so the round-trip is exact. Media values stay as
 *  `mediaref:<id>` pointers — their bytes ship as separate zip entries. */
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

/** Gather every `mediaref:` id referenced anywhere in the manifest, so we
 *  know which blobs to bundle. */
function collectRefIds(backup: ProjectBackup): Set<string> {
  const ids = new Set<string>()
  const add = (v: unknown) => {
    if (isMediaRef(v as string | null | undefined)) { const id = mediaRefId(v as string); if (id) ids.add(id) }
  }
  const s = backup.stores
  for (const node of Object.values(s.freenodes?.nodes ?? {})) add((node as { imageUrl?: unknown }).imageUrl)
  for (const board of Object.values(s.boards.boards as Record<string, BoardData>)) {
    add(board.layers?.card?.heroImage)
    add(board.layers?.block?.thumbnail)
    for (const bar of Object.values(board.bars)) {
      add(bar.icon)
      const c = bar.content
      if (c?.images) for (const im of c.images) add(im)
      if (c?.media) for (const m of c.media) { add(m.url); add(m.posterUrl) }
    }
  }
  for (const g of s.boards.groups as ProjectGroup[]) add(g.cardHeroImage)
  return ids
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
  'model/gltf-binary': 'glb', 'model/gltf+json': 'gltf',
}
function extFor(type: string): string { return MIME_EXT[type] || 'bin' }

// Reverse lookup so import can restore each blob's MIME type from its zip
// entry name ('jpg' folds into 'image/jpeg'; unknown 'bin' stays '').
const EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXT).map(([mime, ext]) => [ext, mime]),
)
function mimeFor(name: string): string {
  const ext = name.match(/\.([^/.]+)$/)?.[1]?.toLowerCase()
  return (ext && EXT_MIME[ext]) || ''
}

/** Recover the blob id from a `media/<id>.<ext>` entry name. Ids are
 *  UUIDs (no dots), so trimming the final extension is safe. */
function idFromMediaName(name: string): string {
  return name.slice(MEDIA_DIR.length).replace(/\.[^/.]+$/, '')
}

/** Serialize the whole project to a portable .zip and trigger download.
 *  Manifest holds `mediaref:` pointers; each referenced blob is bundled
 *  as its own (uncompressed — images are already compressed) entry. */
export async function exportProject(): Promise<void> {
  const manifest = buildBackup()
  const ids = collectRefIds(manifest)

  const files: AsyncZippable = {
    [MANIFEST_NAME]: new TextEncoder().encode(JSON.stringify(manifest)),
  }
  let missing = 0
  for (const id of ids) {
    const blob = await getMedia(id)
    if (!blob) { missing++; console.warn(`[backup] export: no blob for ${id}, skipping`); continue }
    const bytes = new Uint8Array(await blob.arrayBuffer())
    files[`${MEDIA_DIR}${id}.${extFor(blob.type)}`] = [bytes, { level: 0 }]
  }
  if (missing) console.warn(`[backup] export: ${missing} referenced blob(s) were missing and skipped`)

  const zipped = await new Promise<Uint8Array>((resolve, reject) =>
    zip(files, (err, data) => (err ? reject(err) : resolve(data))),
  )

  const blob = new Blob([zipped as unknown as BlobPart], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const a = document.createElement('a')
  a.href = url
  a.download = `gencraft-project-${stamp}.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** ZIP local-file-header / empty-archive / spanned signatures: 'PK' + … */
function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
}

function validateBackup(data: unknown): asserts data is ProjectBackup {
  const d = data as Partial<ProjectBackup> | null
  if (!d || d.format !== FORMAT || !d.stores?.boards || !d.stores?.canvas) {
    throw new Error('That doesn’t look like a genCraft project file.')
  }
}

/** Write a parsed manifest into the live stores (persistence saves on its
 *  normal debounce) and clear transient selection/view state so nothing
 *  dangles against the freshly-loaded ids. UI updates live — no reload. */
function setBackupState(backup: ProjectBackup): void {
  const { boards, freenodes, canvas } = backup.stores
  useBoardsStore.setState({
    boards: boards.boards as never,
    boardOrder: boards.boardOrder,
    groups: boards.groups as never,
    selectedGroupIds: [],
  })
  useFreeNodeStore.setState({ nodes: (freenodes?.nodes ?? {}) as never, selectedIds: [] })
  useCanvasStore.setState({
    ...(canvas.prefs as object),
    selectedBlockBoardIds: [],
    selectedGhostGroupIds: [],
    focusedBoardId: null,
    deckPortalSelections: {},
  } as never)
}

/** Import a project file, replacing the current project. Accepts both the
 *  current .zip bundle and legacy Phase-1 self-contained .json backups;
 *  rejects with a human-readable message on a bad file. */
export async function importProjectFile(file: File): Promise<void> {
  const buf = new Uint8Array(await file.arrayBuffer())

  if (looksLikeZip(buf)) {
    const entries = await new Promise<Unzipped>((resolve, reject) =>
      unzip(buf, (err, data) => (err ? reject(err) : resolve(data))),
    )
    const manifestBytes = entries[MANIFEST_NAME]
    if (!manifestBytes) throw new Error('That zip isn’t a genCraft project (no project.json inside).')
    let manifest: unknown
    try { manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) }
    catch { throw new Error('The project.json inside the zip is corrupt.') }
    validateBackup(manifest)

    // Restore each media blob under its ORIGINAL id so the manifest's
    // `mediaref:<id>` pointers resolve. Do this BEFORE setState so the
    // first render after import can already fetch the bytes.
    for (const [name, bytes] of Object.entries(entries)) {
      if (!name.startsWith(MEDIA_DIR)) continue
      const id = idFromMediaName(name)
      if (id) await putMediaWithId(id, new Blob([bytes as BlobPart], { type: mimeFor(name) }))
    }
    setBackupState(manifest)
    // No re-sweep: the manifest already references blobs we just stored.
    return
  }

  // Legacy self-contained JSON (Phase-1 backups: base64 inline / upload paths).
  let manifest: unknown
  try { manifest = JSON.parse(new TextDecoder().decode(buf)) }
  catch { throw new Error('Could not read the file (not a genCraft project .zip or .json).') }
  validateBackup(manifest)
  setBackupState(manifest)
  // Sweep the inlined base64 / server paths into the blob store as refs.
  await runInlineMediaMigration()
}
