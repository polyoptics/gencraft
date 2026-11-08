import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { useBoardsStore } from './store/boardsStore'
import { startLinkedCardSync } from './utils/linkedCards'
import { startStateOutputs } from './utils/stateCard'
import { startChartFollow } from './utils/chartCard'
import { cardOrigins } from './components/Canvas/StorylineLayer'
import { startDecksOpenRight } from './utils/deckRight'
import { useCanvasStore } from './store/canvasStore'
import { useFreeNodeStore } from './store/freeNodeStore'
import { useUserTemplateStore } from './store/userTemplateStore'
import { useViewport3DStore } from './store/viewport3dStore'
import { useMagnetPreviewStore } from './store/magnetPreviewStore'
import { usePosterMapStore } from './three/posterService'
import { useLinkDragStore } from './store/linkDragStore'
import { useLinkingStore } from './store/linkingStore'
import { usePinTravelStore } from './store/pinTravelStore'
import { useContextSheetStore } from './store/contextSheetStore'
import { useFxStore } from './store/fxStore'
import { useRailRunStore } from './store/railRunStore'
import { useRailUiStore } from './store/railUiStore'
import { useTiltStore } from './store/tiltStore'
import { useCabinetUi } from './utils/cabinet'
import { usePickMode } from './utils/cabinetPick'
import { useNotesStore, useNotesUi } from './store/notesStore'
import { models } from './components/Canvas/tilt/TiltModels'

// Expose stores for debugging. Anything you want to OBSERVE has to be here:
// reaching a store through a dynamic import gets a second copy of the module
// with its own state, which reads as "the feature does nothing" when the
// feature is fine.
;(window as any).__stores = {
  useBoardsStore, useCanvasStore, useFreeNodeStore, useUserTemplateStore,
  useViewport3DStore, useMagnetPreviewStore, usePosterMapStore,
  useLinkDragStore, useLinkingStore, usePinTravelStore, useContextSheetStore, useFxStore,
  // Loop strips: run progress + live preview, and the drag's drop preview.
  useRailRunStore, useRailUiStore,
  // Project cabinets, and the tilted view they rise in.
  useCabinetUi, useTiltStore, usePickMode,
  // The 3D notes tools, and the 3D view's hit test they draw through.
  useNotesStore, useNotesUi, tiltModels: models,
}

// One card shown in several places: an edit on one is on all (utils/linkedCards).
startLinkedCardSync()
startStateOutputs()
startChartFollow(cardOrigins)
// Decks off every storyline open to the right (utils/deckRight).
startDecksOpenRight()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
