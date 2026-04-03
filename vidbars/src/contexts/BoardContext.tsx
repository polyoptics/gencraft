import { createContext, useContext } from 'react'
import type { Bar, BarContent } from '../types/bar'

export interface BoardCtx {
  boardId: string                 // 'primary' for the primary board
  bars: Record<string, Bar>
  rootIds: string[]
  projectName: string
  viewerBarId: string | null
  selectedIds: string[]

  addChildToBar: (id: string) => void
  addSiblingBar: (id: string, pos: 'before' | 'after') => void
  addParentAbove: (id: string) => void
  moveBar: (id: string, dx: number) => void
  moveMultiple: (ids: string[], dx: number) => void
  resizeBarEdge: (id: string, edge: 'left' | 'right', delta: number) => void
  setBarHeight: (id: string, h: number) => void
  renameBar: (id: string, name: string) => void
  setSubtitle: (id: string, subtitle: string) => void
  setIcon: (id: string, icon: string | null) => void
  setColor: (id: string, color: string) => void
  deleteBar: (id: string) => void
  deleteSubtree: (id: string) => void
  toggleCollapsed: (id: string) => void
  reorderSiblings: (id: string) => void
  changeBarRow: (id: string, newRow: number, detach?: boolean) => void
  reparentBar: (id: string, newParentId: string) => void
  setContent: (id: string, content: Partial<BarContent>) => void
  openViewer: (id: string) => void
  closeViewer: () => void
  setSelection: (ids: string[]) => void
  toggleSelection: (id: string) => void
  clearSelection: () => void
  collapseAllToggle: () => void

  // Sync reads for stale-closure-safe callbacks
  getSelectedIds: () => string[]
  getBars: () => Record<string, Bar>
}

const BoardContext = createContext<BoardCtx | null>(null)
export const BoardProvider = BoardContext.Provider

export const useBoardCtx = (): BoardCtx => {
  const ctx = useContext(BoardContext)
  if (!ctx) throw new Error('useBoardCtx used outside BoardProvider')
  return ctx
}
