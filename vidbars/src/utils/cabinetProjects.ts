// cabinetProjects.ts — a whole project in a cabinet drawer.
//
// The drawer holds only a pointer to a file on disk (saves run to 180 MB) and a
// small map of what is in it, so it can be seen without opening the file. The
// project is either in the drawer or out on the canvas. While out, it is
// everything on the canvas that was not there when it came out, so what you add
// while working on it goes back with it.
//
// Every put-away writes a NEW file before anything leaves the canvas: a failed
// write loses nothing, and the last few versions stay on disk.

import { useBoardsStore, freshCanvasBoards } from '../store/boardsStore'
import type { BoardData, ProjectGroup } from '../store/boardsStore'
import { useCanvasStore } from '../store/canvasStore'
import { useFreeNodeStore } from '../store/freeNodeStore'
import type { FreeNodeData } from '../store/freeNodeStore'
import { useUndoCoordinator } from '../store/undoCoordinator'
import { getFirstImageUrl } from '../types/bar'
import { isPanelType } from './componentLinks'
import { getGroupHeight } from './nleRows'
import { insertProjectSnapshot, type ProjectSnapshot } from './projectInsert'
import { useCabinetUi, type DrawerRef } from './cabinet'
import type { CabinetData, CabinetDrawer, CabinetProject, ProjectMap, ProjectMapPart } from './cabinetData'

const API = '/api/snapshots/cabinet'
/** Versions of a project kept on disk, the current one included. */
const KEEP_VERSIONS = 3
const MAX_PARTS = 80
const THUMB_PX = 96

function cabinetOf(nodeId: string): CabinetData | undefined {
  return useFreeNodeStore.getState().nodes[nodeId]?.cabinet
}
function drawerOf(ref: DrawerRef): CabinetDrawer | undefined {
  return cabinetOf(ref.nodeId)?.drawers.find(d => d.id === ref.drawerId)
}
function writeProject(ref: DrawerRef, project: CabinetProject | undefined) {
  const c = cabinetOf(ref.nodeId)
  if (!c) return
  useFreeNodeStore.getState().updateFreeNode(ref.nodeId, {
    cabinet: { ...c, drawers: c.drawers.map(d => d.id === ref.drawerId ? { ...d, project } : d) },
  })
}

/** What a project can hold: not the tools around it (panels, cabinets), nor
 *  what is pinned to the screen. */
const isProjectNode = (n: FreeNodeData) => !isPanelType(n.type) && n.type !== 'cabinet' && !n.pin

/** Every other project out on the canvas, in any cabinet: never part of this one. */
function otherProjectsIds(ref: DrawerRef) {
  const nodes = useFreeNodeStore.getState().nodes
  const groups = new Set<string>(), tiles = new Set<string>()
  for (const n of Object.values(nodes)) {
    for (const d of n.cabinet?.drawers ?? []) {
      if (!d.project?.out || (n.id === ref.nodeId && d.id === ref.drawerId)) continue
      for (const g of currentlyOwned(d.project).groupIds) groups.add(g)
      for (const t of currentlyOwned(d.project).nodeIds) tiles.add(t)
    }
  }
  return { groups, tiles }
}

function currentlyOwned(p: CabinetProject) {
  const left = { groups: new Set(p.out?.leftGroups ?? []), nodes: new Set(p.out?.leftNodes ?? []) }
  return {
    groupIds: useBoardsStore.getState().groups.filter(g => !g.pin && !left.groups.has(g.id)).map(g => g.id),
    nodeIds: Object.values(useFreeNodeStore.getState().nodes).filter(n => isProjectNode(n) && !left.nodes.has(n.id)).map(n => n.id),
  }
}

/** What belongs to this drawer's project on the canvas right now. */
function ownedNow(ref: DrawerRef, p: CabinetProject) {
  const other = otherProjectsIds(ref)
  const o = currentlyOwned(p)
  return {
    groupIds: o.groupIds.filter(id => !other.groups.has(id)),
    nodeIds: o.nodeIds.filter(id => !other.tiles.has(id)),
  }
}

function buildSnapshot(name: string, groupIds: string[], nodeIds: string[]) {
  const bs = useBoardsStore.getState()
  const fn = useFreeNodeStore.getState()
  const groups = bs.groups.filter(g => groupIds.includes(g.id))
  const boardIds = groups.flatMap(g => g.boardIds)
  const clean = (b: BoardData) => ({ ...b, selectedIds: [], viewerBarId: null })
  const primary = boardIds.includes('primary') ? bs.boards.primary : undefined
  const extraBoards = boardIds.filter(id => id !== 'primary' && bs.boards[id]).map(id => clean(bs.boards[id]))
  return {
    name, id: crypto.randomUUID(), savedAt: Date.now(),
    projectName: primary?.projectName ?? name,
    bars: primary?.bars ?? {},
    rootIds: primary?.rootIds ?? [],
    extraBoards,
    boardOrder: extraBoards.map(b => b.id),
    groups,
    freeNodes: Object.fromEntries(nodeIds.flatMap(id => fn.nodes[id] ? [[id, fn.nodes[id]]] : [])),
  }
}

/** A small picture for the map: a data url is embedded media, far too big to
 *  keep on the node, so it is drawn down. Other urls are already small pointers. */
function shrink(url: string): Promise<string | null> {
  if (!url.startsWith('data:')) return Promise.resolve(url)
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => {
      const k = Math.min(1, THUMB_PX / Math.max(img.width, img.height))
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(img.width * k))
      c.height = Math.max(1, Math.round(img.height * k))
      const ctx = c.getContext('2d')
      if (!ctx) return resolve(null)
      ctx.drawImage(img, 0, 0, c.width, c.height)
      resolve(c.toDataURL('image/jpeg', 0.7))
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

function boardPicture(boards: Record<string, BoardData | undefined>, ids: string[]): string | null {
  for (const id of ids) {
    for (const bar of Object.values(boards[id]?.bars ?? {})) {
      const url = getFirstImageUrl(bar.content)
      if (url) return url
    }
  }
  return null
}

/** The map of a project: where its cards and tiles lie, with their pictures.
 *  Works from the file's own data, so it needs nothing on the canvas. */
async function mapOf(s: ProjectSnapshot): Promise<ProjectMap> {
  const boards: Record<string, BoardData> = Object.fromEntries((s.extraBoards ?? []).map(b => [b.id, b]))
  if (s.bars && Object.keys(s.bars).length > 0) boards.primary = { bars: s.bars, rootIds: s.rootIds ?? [] } as unknown as BoardData
  const groupRect = (g: ProjectGroup) => {
    const bars = g.boardIds.flatMap(id => Object.values(boards[id]?.bars ?? {}))
    const w = bars.length ? Math.max(...bars.map(b => b.x + b.width)) : 480
    return {
      x: g.originX ?? 0, y: g.originY ?? 0,
      w: Math.max(120, w, g.cardWidthOverride ?? 0),
      h: Math.max(120, getGroupHeight(g.boardIds, boards), g.cardHeightOverride ?? 0),
    }
  }
  const raw: (ProjectMapPart & { src: string | null })[] = []
  for (const g of s.groups ?? []) {
    // The cards hidden in a collapsed deck lie under its face.
    if (g.deckState && g.deckState !== 'open' && g.deckAnchorId && g.deckAnchorId !== g.id) continue
    raw.push({ ...groupRect(g), color: g.color || '#5b8dd9', pic: null, src: g.cardHeroImage ?? boardPicture(boards, g.boardIds) })
  }
  for (const n of Object.values(s.freeNodes ?? {})) {
    if (!isProjectNode(n) || n.railDock || n.cardRef) continue
    if (n.tileDeck && n.tileDeck.anchor !== n.id) continue
    const moving = n.type === 'video' || n.type === 'model' || n.type === 'audio'
    raw.push({ x: n.x, y: n.y, w: n.width, h: n.height, color: n.color, pic: null, src: (moving ? n.posterUrl : n.imageUrl) ?? null })
  }
  if (raw.length === 0) return { x: 0, y: 0, w: 480, h: 320, parts: [] }
  const x = Math.min(...raw.map(p => p.x)), y = Math.min(...raw.map(p => p.y))
  const w = Math.max(...raw.map(p => p.x + p.w)) - x, h = Math.max(...raw.map(p => p.y + p.h)) - y
  // The biggest when there are too many to keep: they carry the picture.
  const kept = [...raw].sort((a, b) => b.w * b.h - a.w * a.h).slice(0, MAX_PARTS)
  const parts = await Promise.all(kept.map(async ({ src, ...p }) => ({ ...p, pic: src ? await shrink(src) : null })))
  return { x, y, w, h, parts }
}

async function writeFile(ref: DrawerRef, snapshot: unknown): Promise<string> {
  const file = `${ref.drawerId}_${Date.now()}.json`
  const res = await fetch(`${API}/save/${file}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot) })
  if (!res.ok) throw new Error(`save failed (${res.status})`)
  return file
}

/** The new current version; the oldest beyond KEEP_VERSIONS go from disk. */
function withVersion(old: CabinetProject | undefined, file: string) {
  const versions = [...(old?.versions ?? (old ? [old.file] : [])), file]
  for (const gone of versions.slice(0, -KEEP_VERSIONS)) fetch(`${API}/delete/${gone}`, { method: 'DELETE' }).catch(() => {})
  return { file, versions: versions.slice(-KEEP_VERSIONS) }
}

/** Run a slow step with its word on the drawer; a failure stays there to read. */
async function step(ref: DrawerRef, word: string, work: () => Promise<void>) {
  const ui = useCabinetUi.getState()
  ui.setBusy(ref.drawerId, word)
  try {
    await work()
    useCabinetUi.getState().setBusy(ref.drawerId, null)
  } catch (err) {
    useCabinetUi.getState().setBusy(ref.drawerId, `Could not do that: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
}

function projectName(ref: DrawerRef): string {
  const c = cabinetOf(ref.nodeId)
  const i = c?.drawers.findIndex(d => d.id === ref.drawerId) ?? 0
  return c?.drawers[i]?.label || `Drawer ${i + 1}`
}

/** Save everything on the canvas to an empty drawer. It stays on the canvas,
 *  and is this drawer's project, out. */
export function saveCanvasToDrawer(ref: DrawerRef) {
  return step(ref, 'Saving…', async () => {
    const groupIds = useBoardsStore.getState().groups.filter(g => !g.pin).map(g => g.id)
    const nodeIds = Object.values(useFreeNodeStore.getState().nodes).filter(isProjectNode).map(n => n.id)
    const other = otherProjectsIds(ref)
    const snapshot = buildSnapshot(projectName(ref), groupIds.filter(id => !other.groups.has(id)), nodeIds.filter(id => !other.tiles.has(id)))
    const file = await writeFile(ref, snapshot)
    const map = await mapOf(snapshot)
    useUndoCoordinator.getState().checkpoint()
    writeProject(ref, { ...withVersion(undefined, file), name: snapshot.name, savedAt: snapshot.savedAt, map, out: { leftGroups: [...other.groups], leftNodes: [...other.tiles] } })
  })
}

/** Put a project saved through Templates in an empty drawer: a copy of its
 *  file, so the Templates one is never touched. */
export function adoptSavedProject(ref: DrawerRef, snapshotFile: string, name: string) {
  return step(ref, 'Opening…', async () => {
    const res = await fetch(`${API}/adopt/${ref.drawerId}_${Date.now()}.json?from=${encodeURIComponent(snapshotFile)}`, { method: 'POST' })
    if (!res.ok) throw new Error(`copy failed (${res.status})`)
    const { file } = await res.json() as { file: string }
    const snapshot = await (await fetch(`${API}/load/${file}`)).json() as ProjectSnapshot
    const map = await mapOf(snapshot)
    useUndoCoordinator.getState().checkpoint()
    writeProject(ref, { ...withVersion(undefined, file), name, savedAt: Date.now(), map })
  })
}

/** A fresh canvas's lone empty card: nobody's work, and in the way of a project
 *  coming out. */
function removeBlankCard() {
  const bs = useBoardsStore.getState()
  if (bs.groups.length !== 1) return
  const g = bs.groups[0]
  if (g.cardHeroImage || g.pin) return
  const bars = g.boardIds.flatMap(id => Object.values(bs.boards[id]?.bars ?? {}))
  const blank = bars.length <= 1 && bars.every(b => !b.content?.text && !getFirstImageUrl(b.content) && !b.content?.media?.length)
  if (!blank || !g.boardIds.every(id => bs.boards[id]?.pristine)) return
  useBoardsStore.setState(s => ({
    boards: Object.fromEntries(Object.entries(s.boards).filter(([id]) => !g.boardIds.includes(id))),
    boardOrder: s.boardOrder.filter(id => !g.boardIds.includes(id)),
    groups: [],
    selectedGroupIds: [],
  }))
}

/** Spread a project on the canvas with its top-left at (x, y). `copy` stamps a
 *  copy, as for a template: the drawer keeps its project and owns nothing. */
export function takeProjectOut(ref: DrawerRef, x: number, y: number, copy = false) {
  const project = drawerOf(ref)?.project
  if (!project || (project.out && !copy)) return Promise.resolve()
  return step(ref, 'Opening…', async () => {
    const res = await fetch(`${API}/load/${project.file}`)
    if (!res.ok) throw new Error(`the file could not be read (${res.status})`)
    const snapshot = await res.json() as ProjectSnapshot
    useUndoCoordinator.getState().checkpoint()
    removeBlankCard()
    const leftGroups = useBoardsStore.getState().groups.map(g => g.id)
    const leftNodes = Object.keys(useFreeNodeStore.getState().nodes)
    const groups = snapshot.groups ?? []
    const minY = groups.length ? Math.min(...groups.map(g => g.originY ?? 0)) : 0
    const made = insertProjectSnapshot(snapshot, y + (minY - project.map.y), { keepDecks: true })
    const dx = x - project.map.x
    const bs = useBoardsStore.getState()
    bs.setGroupPosBatch(bs.groups.filter(g => made.includes(g.id)).map(g => ({ groupId: g.id, originX: g.originX + dx, originY: g.originY })))
    const fn = useFreeNodeStore.getState()
    fn.moveManyFreeNodes(Object.keys(fn.nodes).filter(id => !leftNodes.includes(id)), dx, 0)
    if (!copy) writeProject(ref, { ...project, out: { leftGroups, leftNodes } })
  })
}

/** Below everything on the canvas, for a double-click or a stamped copy. */
export function takeProjectOutBelow(ref: DrawerRef, copy = false) {
  const bs = useBoardsStore.getState()
  const bottoms = bs.groups.map(g => g.originY + getGroupHeight(g.boardIds, bs.boards))
  const lefts = bs.groups.map(g => g.originX)
  const x = lefts.length ? Math.min(...lefts) : 0
  const y = (bottoms.length ? Math.max(...bottoms) : 0) + 60
  return takeProjectOut(ref, x, y, copy).then(() => {
    const cs = useCanvasStore.getState()
    const map = drawerOf(ref)?.project?.map
    if (!map) return
    const host = document.querySelector('[data-tilt-stage="world"]')?.parentElement?.getBoundingClientRect()
    if (!host) return
    // All of it in view: a whole project is usually far bigger than the screen.
    const zoom = Math.min(cs.zoom, 0.9 * Math.min(host.width / map.w, host.height / map.h))
    if (zoom !== cs.zoom) cs.setZoom(zoom)
    cs.setPan({ x: host.width / 2 - (x + map.w / 2) * zoom, y: host.height / 2 - (y + map.h / 2) * zoom })
  })
}

/** Save what is out over the drawer's project, as a new version. */
async function saveOut(ref: DrawerRef, project: CabinetProject) {
  const { groupIds, nodeIds } = ownedNow(ref, project)
  const snapshot = buildSnapshot(project.name, groupIds, nodeIds)
  const file = await writeFile(ref, snapshot)
  return { ids: { groupIds, nodeIds }, next: { ...project, ...withVersion(project, file), savedAt: snapshot.savedAt, map: await mapOf(snapshot) } }
}

/** Save the project that is out, and leave it out. */
export function saveProject(ref: DrawerRef) {
  const project = drawerOf(ref)?.project
  if (!project?.out) return Promise.resolve()
  return step(ref, 'Saving…', async () => {
    const { next } = await saveOut(ref, project)
    useUndoCoordinator.getState().checkpoint()
    writeProject(ref, next)
  })
}

/** Save the project that is out, and only then clear it off the canvas. */
export function putProjectAway(ref: DrawerRef) {
  const project = drawerOf(ref)?.project
  if (!project?.out) return Promise.resolve()
  return step(ref, 'Putting away…', async () => {
    const { ids, next } = await saveOut(ref, project)
    useUndoCoordinator.getState().checkpoint()
    const groups = new Set(ids.groupIds)
    useBoardsStore.setState(s => {
      const goingBoards = new Set(s.groups.filter(g => groups.has(g.id)).flatMap(g => g.boardIds))
      const left = s.groups.filter(g => !groups.has(g.id))
      return {
        boards: Object.fromEntries(Object.entries(s.boards).filter(([id]) => !goingBoards.has(id))),
        boardOrder: s.boardOrder.filter(id => !goingBoards.has(id)),
        groups: left,
        selectedGroupIds: s.selectedGroupIds.filter(id => !groups.has(id)),
      }
    })
    useFreeNodeStore.setState(s => ({
      nodes: Object.fromEntries(Object.entries(s.nodes).filter(([id]) => !ids.nodeIds.includes(id))),
      selectedIds: s.selectedIds.filter(id => !ids.nodeIds.includes(id)),
    }))
    const { out: _out, ...inDrawer } = next
    writeProject(ref, inDrawer)
    // The canvas always has a card, as Templates' fresh start. A frame later:
    // the fresh one reuses the old card's ids, and swapped in one render the
    // card's view would carry over from what just left.
    if (useBoardsStore.getState().groups.length === 0) {
      await new Promise(r => requestAnimationFrame(r))
      if (useBoardsStore.getState().groups.length === 0) useBoardsStore.setState(freshCanvasBoards())
    }
  })
}

/** Empty the drawer. Its files stay on disk, and what is out stays on the canvas. */
export function forgetProject(ref: DrawerRef) {
  useUndoCoordinator.getState().checkpoint()
  writeProject(ref, undefined)
  useCabinetUi.getState().setBusy(ref.drawerId, null)
}
