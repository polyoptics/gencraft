import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { useBoardsStore } from './store/boardsStore'
import { useCanvasStore } from './store/canvasStore'
import { useFreeNodeStore } from './store/freeNodeStore'
import { useUserTemplateStore } from './store/userTemplateStore'
import { useViewport3DStore } from './store/viewport3dStore'
import { useMagnetPreviewStore } from './store/magnetPreviewStore'

// Expose stores for debugging. Anything you want to OBSERVE has to be here:
// reaching a store through a dynamic import gets a second copy of the module
// with its own state, which reads as "the feature does nothing" when the
// feature is fine.
;(window as any).__stores = {
  useBoardsStore, useCanvasStore, useFreeNodeStore, useUserTemplateStore,
  useViewport3DStore, useMagnetPreviewStore,
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
