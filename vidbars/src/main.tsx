import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { useBoardsStore } from './store/boardsStore'
import { useCanvasStore } from './store/canvasStore'
import { useFreeNodeStore } from './store/freeNodeStore'
import { useUserTemplateStore } from './store/userTemplateStore'

// Expose stores for debugging
;(window as any).__stores = { useBoardsStore, useCanvasStore, useFreeNodeStore, useUserTemplateStore }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
