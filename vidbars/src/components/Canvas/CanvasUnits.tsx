import React from 'react'
import { WorldZoom, useWorldZoom } from './worldZoom'

/** A tile's contents, laid out the same in 2D and 3D.
 *
 *  Tilted, the canvas is laid out at the zoom (CSS zoom, InfiniteCanvas
 *  worldStyle): that keeps what stands up in 3D cheap to draw, but text
 *  laid out at a few px breaks its lines elsewhere and a 1px border rounds
 *  up to a whole screen pixel, so a panel's grid, buttons and paragraphs
 *  shifted the moment the view tipped (hunt 2026-11-01). In here they are
 *  laid out in canvas units, as flat, and drawn down to size with a plain
 *  scale, as flat. Fills its place in the tile's column like the body it
 *  wraps (which goes inside with `flex: 1`). Nothing in here stands up in
 *  3D (TiltLayer leaves raised parts inside it flat): a raised part would
 *  make this a 3D layer drawn at canvas size, the cost the zoom avoids. */
export const CanvasUnits: React.FC<{
  /** The body's size flat, in canvas units: laid out at the zoom, the tile's
   *  own border rounds to whole screen pixels and its box comes out a few
   *  units off, so it is not taken from there. */
  w: number
  h: number
  /** The tile's corner radius inside its border: this box clips its own
   *  contents to the tile's bottom corners, since in 3D the tile itself
   *  stops clipping (its header stands up out of it). */
  r: number
  children: React.ReactNode
}> = ({ w, h, r, children }) => {
  const z = useWorldZoom()
  const zoomed = z !== null && z !== 1
  return (
    <div style={{
      flex: 1, minWidth: 0, minHeight: 0, position: 'relative',
      overflow: 'hidden', borderBottomLeftRadius: r, borderBottomRightRadius: r,
    }}>
      <div data-canvas-units="" style={zoomed ? {
        position: 'absolute', left: 0, top: 0,
        width: Math.max(0, w), height: Math.max(0, h),
        zoom: 1 / z, transform: `scale(${z})`, transformOrigin: '0 0',
        display: 'flex', flexDirection: 'column',
      } : {
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
      }}>
        <WorldZoom.Provider value={null}>{children}</WorldZoom.Provider>
      </div>
    </div>
  )
}
