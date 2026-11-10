import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// The 3D area's model handles: before the app's own listeners.
import './utils/area3dHandles'
// The lift handle on a model card's model (float height): ahead of them too.
import './utils/floatHandle'
// Looking through a camera: ahead of the canvas's own listeners too.
import { installLookThrough } from './components/Canvas/tilt/LookThrough'
import App from './App.tsx'
import { useBoardsStore } from './store/boardsStore'
import { startLinkedCardSync } from './utils/linkedCards'
import { startStateOutputs } from './utils/stateCard'
import { startChartFollow } from './utils/chartCard'
import { startArea3dFollow, showArea3d, foldArea3d, toggleArea3d, area3dOutOf } from './utils/area3dCard'
import { createMediaCard } from './utils/cardGrid'

installLookThrough()
import { cardOrigins } from './components/Canvas/StorylineLayer'
import { startDecksOpenRight } from './utils/deckRight'
import { startAgentDoor } from './utils/agentDoor'
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
import { useTiltStore, useModelScaleStore } from './store/tiltStore'
import { useCabinetUi } from './utils/cabinet'
import { usePickMode } from './utils/cabinetPick'
import { useNotesStore, useNotesUi } from './store/notesStore'
import { models } from './components/Canvas/tilt/TiltModels'
import { useManip } from './store/manipStore'

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
  // 3D area cards (utils/area3dCard), and the model sizes and turns they keep.
  area3d: { showArea3d, foldArea3d, toggleArea3d, area3dOutOf, createMediaCard }, useModelScaleStore,
  // The manipulator's settings, and the camera looked through.
  useManip,
}

// One card shown in several places: an edit on one is on all (utils/linkedCards).
startLinkedCardSync()
startStateOutputs()
startChartFollow(cardOrigins)
startArea3dFollow()
// Decks off every storyline open to the right (utils/deckRight).
startDecksOpenRight()
// The doorway an agent reads cards and deals new ones through (utils/agentDoor).
startAgentDoor()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
