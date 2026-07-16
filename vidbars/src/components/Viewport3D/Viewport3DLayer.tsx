// Viewport3DLayer.tsx — the culled list of 3D viewport window frames.
// Mounted in ALL THREE zoom layers' Canvas members (like FreeCanvas), so
// windows exist at every zoom. GL state survives these remounts — the
// renderer registry is store-driven, not mount-driven.

import React, { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { Viewport3DFrame } from './Viewport3DFrame'
import { useViewportBounds, intersectsViewport } from '../../hooks/useViewportBounds'

export const Viewport3DLayer: React.FC = React.memo(() => {
  const windowIds = useViewport3DStore(useShallow(s => Object.keys(s.windows)))
  const vp = useViewportBounds()

  const visibleIds = useMemo(() => {
    const windows = useViewport3DStore.getState().windows
    return windowIds.filter(id => {
      const w = windows[id]
      if (!w) return false
      // Small top margin so the floating header doesn't pop at the edge.
      return intersectsViewport(vp, w.x, w.y - 40, w.width, w.height + 40)
    })
  }, [windowIds, vp])

  return (
    <>
      {visibleIds.map(id => <Viewport3DFrame key={id} id={id} />)}
    </>
  )
})
