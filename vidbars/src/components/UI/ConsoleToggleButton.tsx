// ConsoleToggleButton — on the top bar: how the tilted 3D view shows a loop
// strip. Off, its cards lie in the tray (the pop-up 3D); on, they stand up
// on their bottom edges like a machine's panels (console mode). Only the
// loop strip takes it for now (Brian 2026-10-30); everything it does flat
// it still does standing.

import React from 'react'
import { useTiltStore } from '../../store/tiltStore'

export const ConsoleToggleButton: React.FC = () => {
  const on = useTiltStore(s => s.console)
  return (
    <button
      onClick={() => useTiltStore.getState().setConsole(!on)}
      title={on
        ? 'Console view: loop strip cards stand up in 3D. Click for the flat tray.'
        : 'Flat tray: loop strip cards lie in the strip in 3D. Click to stand them up as a console.'}
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
      {on ? 'Console' : 'Tray'}
    </button>
  )
}
