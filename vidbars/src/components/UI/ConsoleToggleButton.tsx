// ConsoleToggleButton — on the top bar: how the tilted 3D view shows a loop
// strip. Off, its cards lie in the tray (the pop-up 3D); on, the strip is a
// machine (console mode, Brian 2026-10-30): its effect cards lean back on a
// sloped back with their tabs, a docked Viewer stands like a screen, Run is
// a raised button, and the pictures stay down in their columns. Everything
// it does flat it still does standing.

import React from 'react'
import { useTiltStore } from '../../store/tiltStore'

export const ConsoleToggleButton: React.FC = () => {
  const on = useTiltStore(s => s.console)
  return (
    <button
      onClick={() => useTiltStore.getState().setConsole(!on)}
      title="Console: in 3D the loop strip stands up as a machine. Effect cards lean back, a docked Viewer stands like a screen, pictures stay in their columns. Lit is on; unlit, the cards lie flat in the strip."
      aria-pressed={on}
      style={{
        height: 24,
        padding: '0 8px',
        display: 'flex', alignItems: 'center', gap: 5,
        background: on ? 'rgba(98,160,217,0.22)' : 'rgba(255,255,255,0.05)',
        border: on ? '1px solid rgba(98,160,217,0.5)' : '1px solid rgba(255,255,255,0.1)',
        borderRadius: 6,
        color: on ? '#9ecbff' : 'rgba(255,255,255,0.6)',
        fontSize: 11, fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <span style={{ fontSize: 13 }}>🎛️</span>
      Console
    </button>
  )
}
