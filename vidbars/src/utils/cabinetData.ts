// cabinetData.ts — what a project cabinet holds. Types and the empty cabinet
// only, with no store imports, so freeNodeStore can use it without a cycle.
//
// A drawer's contents live ON the cabinet node. That is what makes undo, save,
// load and backup all work without knowing cabinets exist: they already carry
// every node whole.

import type { BoardData, ProjectGroup } from '../store/boardsStore'
import type { FreeNodeData } from '../store/freeNodeStore'

interface ItemBase {
  id: string
  name: string
  color: string
  /** The picture on its tile in the tray. */
  thumb: string | null
  /** Its top-left and size on the canvas when it was put away (canvas units). */
  x: number
  y: number
  w: number
  h: number
}

/** A card, or a whole collapsed deck, as it left the canvas: original ids and
 *  deck state, so it comes back as itself and links to it reconnect. */
export interface CabinetCardItem extends ItemBase {
  kind: 'card'
  groups: ProjectGroup[]
  boards: BoardData[]
  /** The boards that were in boardOrder ('primary' is not). */
  orderedBoardIds: string[]
}

/** A canvas tile, or a collapsed tile deck with its hidden members. */
export interface CabinetTileItem extends ItemBase {
  kind: 'tile'
  nodes: FreeNodeData[]
}

export type CabinetItem = CabinetCardItem | CabinetTileItem

/** One card or tile on a project's map, in the project's canvas units. */
export interface ProjectMapPart { x: number; y: number; w: number; h: number; color: string; pic: string | null }
/** A project's footprint and what lies on it. */
export interface ProjectMap { x: number; y: number; w: number; h: number; parts: ProjectMapPart[] }

/** A whole project in a drawer: a pointer to its file and a map to see it by
 *  (utils/cabinetProjects). */
export interface CabinetProject {
  file: string
  /** Its files on disk, oldest first, the current one last. */
  versions?: string[]
  name: string
  savedAt: number
  map: ProjectMap
  /** Out on the canvas: what was already there, which is not part of it. */
  out?: { leftGroups: string[]; leftNodes: string[] }
}

export interface CabinetDrawer {
  id: string
  /** Empty until named: it then shows a grey "Drawer n" (utils/cabinet drawerName). */
  label: string
  items: CabinetItem[]
  /** How far it has been pulled open, canvas units. Absent: as far as its contents need. */
  trayH?: number
  /** A drawer holds loose items or one project, never both. */
  project?: CabinetProject
}

export interface CabinetData {
  drawers: CabinetDrawer[]
  /** The open drawer, one at a time. */
  open: string | null
}

export function newCabinetDrawer(label: string): CabinetDrawer {
  return { id: crypto.randomUUID(), label, items: [] }
}

export function newCabinet(): CabinetData {
  return { drawers: [1, 2, 3, 4].map(() => newCabinetDrawer('')), open: null }
}
