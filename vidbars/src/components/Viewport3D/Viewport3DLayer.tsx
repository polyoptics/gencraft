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
  const windows = useViewport3DStore(s => s.windows)
  const vp = useViewportBounds()

  // PARTITION, not just a cull: a pinned window is rendered by PinLayer,
  // and drawing it here too would double it — with the world copy sliding
  // around under the pinned one. `windows` must be a dep so a placement
  // flip re-runs this; nothing else here changes when only `pin` does.
  const visibleIds = useMemo(() => {
    return windowIds.filter(id => {
      const w = windows[id]
      if (!w || w.pin) return false
      // Small top margin so the floating header doesn't pop at the edge.
      return intersectsViewport(vp, w.x, w.y - 40, w.width, w.height + 40)
    })
  }, [windowIds, windows, vp])

  return (
    <>
      {visibleIds.map(id => <Viewport3DFrame key={id} id={id} />)}
    </>
  )
})
