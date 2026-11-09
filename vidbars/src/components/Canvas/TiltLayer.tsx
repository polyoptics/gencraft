// TiltLayer.tsx — the tilted view of the canvas (store/tiltStore).
//
// Alt+left-drag (Alt is the camera modifier) tips the flat canvas back
// into a ground plane: drag up/down to tilt, left/right to turn it. The
// DOM layers themselves are tilted with CSS (InfiniteCanvas world layers
// and the LayerOverlay wrapper in App share tiltCss), so every card, block
// and 3D viewer window stays exactly where it was on the plane.
//
// What this layer adds on top, only while tilted:
//  - input remapping: a press on a card or tile is re-sent to it at the
//    flat point under the cursor, so moving and resizing work on the
//    ground as they do flat. On bare ground drag pans and the wheel zooms.
//    Alt+drag tilts; Alt+middle-drag pans and Alt+right-drag or Alt+wheel
//    zooms, so Alt never has to be let go. Tilting back down to top-down
//    (or Esc, or Flat) returns to the flat view.
//  - one three.js canvas that stands each model card's model up above its
//    card, with the same camera the CSS perspective uses.

import React from 'react'
import { useTiltStore, isTilted } from '../../store/tiltStore'
import { useAltTiltGesture, useFrameKey, useShiftToPan } from './tilt/altCamera'
import { TiltModels } from './tilt/TiltModels'
import { TiltedView } from './tilt/TiltedView'
import { LookThrough } from './tilt/LookThrough'

export const TiltLayer: React.FC = () => {
  useAltTiltGesture()
  useFrameKey()
  useShiftToPan()
  const tilted = useTiltStore(s => isTilted(s))
  return (
    <>
      <TiltModels />
      {tilted && <TiltedView />}
      <LookThrough />
    </>
  )
}
