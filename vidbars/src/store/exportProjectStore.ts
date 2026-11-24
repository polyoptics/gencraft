// exportProjectStore — what the "Export to new project" dialog is open for.
// Transient (not persisted): a menu opens it, the dialog closes it, as the
// context sheet's does (store/contextSheetStore).

import { create } from 'zustand'
import type { ExportPick } from '../utils/exportSelection'

interface ExportProjectState {
  /** What was picked to export; null when closed. */
  pick: ExportPick | null
  openExport: (pick: ExportPick) => void
  closeExport: () => void
}

export const useExportProjectStore = create<ExportProjectState>(set => ({
  pick: null,
  openExport: pick => set({ pick }),
  closeExport: () => set({ pick: null }),
}))
