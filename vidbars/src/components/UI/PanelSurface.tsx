// PanelSurface.tsx — the one place panel chrome learns how big it is.
//
// A panel node lives inside the world transform, so everything in it is
// multiplied by the canvas zoom. Left alone, an 11 px label is 3 px at zoom
// 0.3 — which is exactly the complaint that produced this file: "extremely
// difficult to read any of the text from the header to the bottom, to the
// icons, to the menu sizes, everything".
//
// The fix is to counter-scale: lay the panel out at gz% of the node and
// scale it by 1/gz, so the box still covers the node exactly while every
// CSS pixel inside equals one SCREEN pixel. Chrome then reads the same at
// any zoom.
//
// That trade has a limit, and the limit is why `usePanelChrome` exists.
// Counter-scaled chrome is a CONSTANT number of screen pixels, so on a
// panel that is itself only 100 screen px tall the chrome eats the whole
// thing. Shrinking the chrome to fit would undo the readability it was
// counter-scaled for, so instead the chrome gives up whole ROWS as room
// runs out, poorest-value first, and the content keeps the space.

import React from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import type { FreeNodeData } from '../../store/freeNodeStore'

/** The multiplier the canvas applies to a node: the live zoom, or the zoom
 *  FROZEN at pin time. A pinned panel and a canvas panel must render
 *  identically, which is the whole reason this is one value and not two. */
export function panelScale(node: FreeNodeData | undefined, zoom: number): number {
  return node?.pin ? node.pin.scale : zoom
}

/** Child CSS px == screen px. Clamped at 0.1 so extreme zoom-out cannot ask
 *  the browser to lay out an absurdly large surface. */
export const CounterScaled: React.FC<{ gz: number; children: React.ReactNode }> = ({ gz, children }) => {
  const z = Math.max(gz, 0.1)
  return (
    <div style={{
      position: 'absolute', left: 0, top: 0,
      width: `${z * 100}%`, height: `${z * 100}%`,
      transform: `scale(${1 / z})`, transformOrigin: 'top left',
    }}>{children}</div>
  )
}

export interface PanelChrome {
  /** Counter-scale factor for CounterScaled. */
  gz: number
  /** The panel's height in SCREEN pixels — what decides how much fits. */
  screenH: number
  /** Same, across. */
  screenW: number
  /** Progressive disclosure. Thresholds were chosen by measuring the
   *  resulting content share, not by feel: they keep the content area above
   *  roughly half the panel at every zoom. */
  showFooter: boolean
  showControls: boolean
  showHeader: boolean
  /** Too narrow for optional inline chips. */
  narrow: boolean
}

export function usePanelChrome(node: FreeNodeData | undefined): PanelChrome {
  const zoom = useCanvasStore(s => s.zoom)
  const gz = panelScale(node, zoom)
  const screenH = (node?.height ?? 0) * gz
  const screenW = (node?.width ?? 0) * gz
  return {
    gz, screenH, screenW,
    showFooter: screenH >= 240,
    showControls: screenH >= 150,
    showHeader: screenH >= 100,
    narrow: screenW < 250,
  }
}
